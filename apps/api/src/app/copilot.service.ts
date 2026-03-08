import { Injectable, Logger } from '@nestjs/common';
import { generateText, generateObject } from 'ai';
import { z } from 'zod';
import {
  resolveCopilotModelId,
  resolveModelId,
  createModel,
  getTokenBudget,
  isReasoningModel,
  parseJsonFromModelOutput,
} from './model-utils';
import {
  BattleSessionManager,
  type BattleWithDex,
  type BattleSideLike,
} from './battle-session.manager';
import type { BattleService, ShowdownRequest } from './battle.service';
import { COPILOT_SYSTEM_PROMPT } from './system-prompts';

// ---------------------------------------------------------------------------
// Zod schema for copilot structured output
// ---------------------------------------------------------------------------

const ActionAlternativeSchema = z.object({
  action: z
    .string()
    .describe(
      'Exact choice string from legalActions, e.g. "move 1" or "switch 3"'
    ),
  label: z.string().describe('Human-readable label, e.g. "Flamethrower"'),
  reason: z.string().describe('One sentence reason'),
});

export const CopilotGuidanceSchema = z.object({
  recommendedAction: z
    .string()
    .describe('The exact "choice" string from legalActions'),
  recommendedLabel: z
    .string()
    .describe('Human-readable label for the recommended action'),
  confidence: z.enum(['high', 'medium', 'low']),
  reasoning: z
    .string()
    .describe('Concise turn-specific rationale, 2-3 sentences max'),
  safeAlternative: ActionAlternativeSchema.nullable().describe(
    'The safest alternative action, or null'
  ),
  aggressiveAlternative: ActionAlternativeSchema.nullable().describe(
    'The most aggressive alternative, or null'
  ),
  mainRisk: z.string().describe('Biggest risk this turn in one sentence'),
  winConditionNote: z
    .string()
    .describe('One sentence about the current win condition path'),
  disabled: z.literal(true).optional(),
});

const CopilotGuidanceExtractorSchema = CopilotGuidanceSchema.omit({
  disabled: true,
});

export type CopilotGuidance = z.infer<typeof CopilotGuidanceSchema>;

// ---------------------------------------------------------------------------
// Snapshot types (AI-friendly structured input)
// ---------------------------------------------------------------------------

interface SnapshotPokemon {
  name: string;
  level: number;
  types: string[];
  hp: number;
  maxHp: number;
  status: string | null;
  boosts: Record<string, number> | null;
  item: string | null;
  ability: string | null;
}

interface SnapshotBenchPokemon {
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  status: string | null;
  item: string | null;
  ability: string | null;
}

interface SnapshotLegalAction {
  choice: string;
  label: string;
  type: 'move' | 'switch';
  moveType?: string;
  movePower?: number | null;
  moveCategory?: string | null;
}

interface CopilotBattleSnapshot {
  turn: number;
  myActive: SnapshotPokemon;
  opponentActive: SnapshotPokemon;
  myBench: SnapshotBenchPokemon[];
  opponentBench: SnapshotBenchPokemon[];
  field: {
    weather: string | null;
    terrain: string | null;
    pseudoWeather: string[];
  };
  mySideConditions: string[];
  opponentSideConditions: string[];
  myActiveVolatiles: string[];
  opponentActiveVolatiles: string[];
  legalActions: SnapshotLegalAction[];
  speedComparison: 'faster' | 'slower' | 'unknown' | 'tie';
  recentEvents: string[];
  faintedCountMine: number;
  faintedCountOpponent: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class CopilotService {
  private readonly logger = new Logger(CopilotService.name);

  /**
   * Per-battle guidance cache keyed by "battleId::turn::phase".
   * Prevents redundant LLM calls on page reload or re-render.
   */
  private readonly guidanceCache = new Map<string, CopilotGuidance>();

  constructor(private readonly battleSessionManager: BattleSessionManager) {}

  private prepareCopilotCall(battleId: string) {
    const { battle, session, battleService } =
      this.battleSessionManager.getSessionForCopilot(battleId);
    const requests = battleService.getRequests(battleId);
    const p1Legal = battleService.getLegalOptionsForRequest(requests.p1);

    const snapshot = this.buildCopilotSnapshot(
      battle,
      requests,
      p1Legal,
      session,
      battleService
    );
    const modelId = resolveCopilotModelId(session.copilotMode);

    const prompt = this.buildUserPrompt(snapshot);
    const cacheKey = `${battleId}::${snapshot.turn}::${session.phase}`;
    return { snapshot, modelId, prompt, cacheKey, copilotEnabled: session.copilotEnabled };
  }

  async getCopilotGuidance(battleId: string): Promise<CopilotGuidance> {
    const { snapshot, modelId, prompt, cacheKey, copilotEnabled } =
      this.prepareCopilotCall(battleId);

    if (!copilotEnabled) {
      return {
        disabled: true,
        recommendedAction: '',
        recommendedLabel: '',
        confidence: 'low',
        reasoning: '',
        safeAlternative: null,
        aggressiveAlternative: null,
        mainRisk: '',
        winConditionNote: '',
      };
    }

    const cached = this.guidanceCache.get(cacheKey);
    if (cached) {
      this.logger.debug(`Copilot cache hit: ${cacheKey}`);
      return cached;
    }

    const extractorModelId = resolveModelId(
      'OPENAI_COPILOT_EXTRACTOR_MODEL',
      'gpt-4.1-nano',
    );

    const startedAt = Date.now();
    try {
      const { text: rawText } = await generateText({
        model: createModel(modelId),
        system: COPILOT_SYSTEM_PROMPT,
        prompt,
        maxOutputTokens: getTokenBudget(modelId, 'copilot'),
      });

      const step1Ms = Date.now() - startedAt;
      this.logger.debug(
        `Copilot step1 (${step1Ms}ms, ${modelId}): raw length=${rawText.length}`
      );

      const directParsed = this.parseGuidanceFromText(rawText);
      if (directParsed) {
        this.logger.debug(
          `Copilot direct parse OK (${Date.now() - startedAt}ms): ${directParsed.recommendedAction} [${directParsed.confidence}]`
        );
        this.guidanceCache.set(cacheKey, directParsed);
        return directParsed;
      }

      if (isReasoningModel(modelId)) {
        const extractorResult = await this.extractWithLightweightModel(
          rawText,
          extractorModelId,
          snapshot,
        );
        const totalMs = Date.now() - startedAt;
        this.logger.debug(
          `Copilot step2 (${totalMs}ms, ${extractorModelId}): ${extractorResult.recommendedAction} [${extractorResult.confidence}]`
        );
        this.guidanceCache.set(cacheKey, extractorResult);
        return extractorResult;
      }

      this.logger.warn(
        `Copilot parse failed (${Date.now() - startedAt}ms), using fallback`
      );
      const fallback = this.buildFallbackGuidance(snapshot);
      this.guidanceCache.set(cacheKey, fallback);
      return fallback;
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Copilot error (${latencyMs}ms): ${message}`);
      return this.buildFallbackGuidance(snapshot);
    }
  }

  clearCache(battleId: string) {
    for (const key of this.guidanceCache.keys()) {
      if (key.startsWith(`${battleId}::`)) {
        this.guidanceCache.delete(key);
      }
    }
  }

  private async extractWithLightweightModel(
    rawText: string,
    extractorModelId: string,
    snapshot: CopilotBattleSnapshot,
  ): Promise<CopilotGuidance> {
    try {
      const { object } = await generateObject({
        model: createModel(extractorModelId),
        schema: CopilotGuidanceExtractorSchema,
        prompt: [
          'Extract structured battle guidance from the following AI analysis.',
          'The legal actions available are:',
          ...snapshot.legalActions.map((a) => `  ${a.choice} — ${a.label}`),
          '',
          'Raw analysis:',
          rawText,
        ].join('\n'),
        maxOutputTokens: 400,
      });
      return object;
    } catch (extractError) {
      const msg =
        extractError instanceof Error ? extractError.message : 'Unknown';
      this.logger.warn(`Extractor failed (${msg}), trying manual parse`);

      // Last-chance manual parse on the raw text
      const manual = this.parseGuidanceFromText(rawText);
      return manual ?? this.buildFallbackGuidance(snapshot);
    }
  }

  private parseGuidanceFromText(text: string): CopilotGuidance | null {
    const raw = parseJsonFromModelOutput(text);
    if (!raw) return null;

    const result = CopilotGuidanceSchema.safeParse(raw);
    if (result.success) return result.data;

    if (
      typeof raw.recommendedAction === 'string' &&
      typeof raw.reasoning === 'string'
    ) {
      return {
        recommendedAction: raw.recommendedAction,
        recommendedLabel:
          typeof raw.recommendedLabel === 'string'
            ? raw.recommendedLabel
            : raw.recommendedAction,
        confidence:
          raw.confidence === 'high' ||
          raw.confidence === 'medium' ||
          raw.confidence === 'low'
            ? raw.confidence
            : 'medium',
        reasoning: raw.reasoning,
        safeAlternative: this.parseAlternative(raw.safeAlternative) ?? null,
        aggressiveAlternative:
          this.parseAlternative(raw.aggressiveAlternative) ?? null,
        mainRisk:
          typeof raw.mainRisk === 'string' ? raw.mainRisk : 'Unknown risk.',
        winConditionNote:
          typeof raw.winConditionNote === 'string'
            ? raw.winConditionNote
            : 'Unable to assess.',
      };
    }

    return null;
  }

  private parseAlternative(
    val: unknown,
  ): { action: string; label: string; reason: string } | null {
    if (!val || typeof val !== 'object') return null;
    const obj = val as Record<string, unknown>;
    if (
      typeof obj.action === 'string' &&
      typeof obj.label === 'string' &&
      typeof obj.reason === 'string'
    ) {
      return { action: obj.action, label: obj.label, reason: obj.reason };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Snapshot builder
  // ---------------------------------------------------------------------------

  private buildCopilotSnapshot(
    battle: BattleWithDex,
    requests: { p1: ShowdownRequest; p2: ShowdownRequest },
    p1Legal: { moveChoices: string[]; switchChoices: string[] },
    session: {
      currentTurn: number;
      turnLog: string[];
      lastTurnEvents: unknown[];
    },
    battleService: BattleService
  ): CopilotBattleSnapshot {
    const p1Side = battle.sides?.[0];
    const p2Side = battle.sides?.[1];

    const myActive = this.extractActivePokemon(p1Side);
    const opponentActive = this.extractActivePokemon(p2Side);

    const myBench = this.extractBench(p1Side);
    const opponentBench = this.extractBench(p2Side);

    const field = this.extractField(battle);
    const mySideConditions = this.extractSideConditions(p1Side);
    const opponentSideConditions = this.extractSideConditions(p2Side);

    const myActiveVolatiles = this.extractVolatiles(p1Side);
    const opponentActiveVolatiles = this.extractVolatiles(p2Side);

    const legalActions = this.buildLegalActions(requests.p1, p1Legal, battle);
    const speedComparison = this.estimateSpeedComparison(p1Side, p2Side);
    const recentEvents = session.turnLog.slice(-6);

    const faintedCountMine =
      p1Side?.pokemon?.filter((p) => p.fainted)?.length ?? 0;
    const faintedCountOpponent =
      p2Side?.pokemon?.filter((p) => p.fainted)?.length ?? 0;

    return {
      turn: session.currentTurn,
      myActive,
      opponentActive,
      myBench,
      opponentBench,
      field,
      mySideConditions,
      opponentSideConditions,
      myActiveVolatiles,
      opponentActiveVolatiles,
      legalActions,
      speedComparison,
      recentEvents,
      faintedCountMine,
      faintedCountOpponent,
    };
  }

  private extractActivePokemon(
    side: BattleSideLike | undefined
  ): SnapshotPokemon {
    const active = side?.active?.[0];
    const pokemon = side?.pokemon?.find((p) => p.isActive);

    return {
      name: active?.name || pokemon?.name || 'Unknown',
      level: pokemon?.level ?? 100,
      types: active?.types ?? active?.getTypes?.() ?? [],
      hp: typeof pokemon?.hp === 'number' ? pokemon.hp : 0,
      maxHp: typeof pokemon?.maxhp === 'number' ? pokemon.maxhp : 0,
      status: pokemon?.status || null,
      boosts: this.extractNonZeroBoosts(active?.boosts),
      item: pokemon?.item ? pokemon.set?.item || pokemon.item : null,
      ability:
        pokemon?.set?.ability ||
        pokemon?.ability ||
        pokemon?.baseAbility ||
        null,
    };
  }

  private extractBench(
    side: BattleSideLike | undefined
  ): SnapshotBenchPokemon[] {
    if (!side?.pokemon?.length) return [];
    return side.pokemon
      .filter((p) => !p.isActive && !p.fainted)
      .map((p) => ({
        name: p.name || 'Unknown',
        level: p.level ?? 100,
        hp: typeof p.hp === 'number' ? p.hp : 0,
        maxHp: typeof p.maxhp === 'number' ? p.maxhp : 0,
        status: p.status || null,
        item: p.item ? p.set?.item || p.item : null,
        ability: p.set?.ability || p.ability || p.baseAbility || null,
      }));
  }

  private extractField(battle: BattleWithDex): CopilotBattleSnapshot['field'] {
    const field = battle.field;
    const weather = field?.weather || field?.weatherState?.id || null;
    const terrain = field?.terrain || field?.terrainState?.id || null;

    const pseudoWeather: string[] = [];
    if (field?.pseudoWeather) {
      for (const key of Object.keys(field.pseudoWeather)) {
        if (key) pseudoWeather.push(key);
      }
    }

    return {
      weather: weather || null,
      terrain: terrain || null,
      pseudoWeather,
    };
  }

  private extractSideConditions(side: BattleSideLike | undefined): string[] {
    if (!side?.sideConditions) return [];
    return Object.entries(side.sideConditions).map(([key, val]) => {
      const layers = val?.layers;
      return layers && layers > 1 ? `${key} x${layers}` : key;
    });
  }

  private extractVolatiles(side: BattleSideLike | undefined): string[] {
    const active = side?.active?.[0];
    if (!active?.volatiles) return [];
    return Object.keys(active.volatiles);
  }

  private extractNonZeroBoosts(
    boosts?: Record<string, number>
  ): Record<string, number> | null {
    if (!boosts) return null;
    const nonZero: Record<string, number> = {};
    for (const [stat, value] of Object.entries(boosts)) {
      if (typeof value === 'number' && value !== 0) {
        nonZero[stat] = value;
      }
    }
    return Object.keys(nonZero).length > 0 ? nonZero : null;
  }

  private buildLegalActions(
    request: ShowdownRequest,
    legal: { moveChoices: string[]; switchChoices: string[] },
    battle: BattleWithDex
  ): SnapshotLegalAction[] {
    const actions: SnapshotLegalAction[] = [];

    const moveRequests = request.active?.[0]?.moves ?? [];
    const legalMoveIndices = new Set(
      legal.moveChoices
        .map((c) => {
          const m = c.match(/^move\s+(\d+)$/i);
          return m ? Number(m[1]) : null;
        })
        .filter((i): i is number => typeof i === 'number')
    );

    for (const [i, move] of moveRequests.entries()) {
      const index = i + 1;
      if (!legalMoveIndices.has(index)) continue;
      const dexMove = battle.dex?.moves?.get?.(move.id || move.move);
      actions.push({
        choice: `move ${index}`,
        label: move.move,
        type: 'move',
        moveType: dexMove?.type || undefined,
        movePower:
          typeof dexMove?.basePower === 'number' && dexMove.basePower > 0
            ? dexMove.basePower
            : null,
        moveCategory: dexMove?.category || null,
      });
    }

    const legalSwitchSlots = new Set(
      legal.switchChoices
        .map((c) => {
          const m = c.match(/^switch\s+(\d+)$/i);
          return m ? Number(m[1]) : null;
        })
        .filter((s): s is number => typeof s === 'number')
    );

    const team = battle.sides?.[0]?.pokemon ?? [];
    for (const pokemon of team) {
      const slot = (pokemon.position ?? 0) + 1;
      if (!legalSwitchSlots.has(slot)) continue;
      actions.push({
        choice: `switch ${slot}`,
        label: `Switch to ${pokemon.name || 'Unknown'}`,
        type: 'switch',
      });
    }

    return actions;
  }

  private estimateSpeedComparison(
    p1Side: BattleSideLike | undefined,
    p2Side: BattleSideLike | undefined
  ): 'faster' | 'slower' | 'unknown' | 'tie' {
    const p1Active = p1Side?.active?.[0];
    const p2Active = p2Side?.active?.[0];
    const p1Pokemon = p1Side?.pokemon?.find((p) => p.isActive);
    const p2Pokemon = p2Side?.pokemon?.find((p) => p.isActive);

    const p1BaseSpe =
      p1Active?.species?.baseStats?.spe ?? p1Pokemon?.species?.baseStats?.spe;
    const p2BaseSpe =
      p2Active?.species?.baseStats?.spe ?? p2Pokemon?.species?.baseStats?.spe;

    if (typeof p1BaseSpe !== 'number' || typeof p2BaseSpe !== 'number')
      return 'unknown';

    const boostMultiplier = (stage: number) => {
      if (stage >= 0) return (2 + stage) / 2;
      return 2 / (2 - stage);
    };

    const p1SpeBoost = p1Active?.boosts?.spe ?? 0;
    const p2SpeBoost = p2Active?.boosts?.spe ?? 0;

    const p1EffSpe = p1BaseSpe * boostMultiplier(p1SpeBoost);
    const p2EffSpe = p2BaseSpe * boostMultiplier(p2SpeBoost);

    if (Math.abs(p1EffSpe - p2EffSpe) < 1) return 'tie';
    return p1EffSpe > p2EffSpe ? 'faster' : 'slower';
  }

  // ---------------------------------------------------------------------------
  // Prompt builder
  // ---------------------------------------------------------------------------

  private buildUserPrompt(snapshot: CopilotBattleSnapshot): string {
    const lines: string[] = [
      `## Battle State — Turn ${snapshot.turn}`,
      '',
      `### My Active: ${snapshot.myActive.name} (Lv.${snapshot.myActive.level})`,
      `  Types: ${snapshot.myActive.types.join('/') || 'unknown'}`,
      `  HP: ${snapshot.myActive.hp}/${snapshot.myActive.maxHp}`,
      snapshot.myActive.status ? `  Status: ${snapshot.myActive.status}` : '',
      snapshot.myActive.boosts
        ? `  Boosts: ${JSON.stringify(snapshot.myActive.boosts)}`
        : '',
      snapshot.myActive.item ? `  Item: ${snapshot.myActive.item}` : '',
      snapshot.myActive.ability
        ? `  Ability: ${snapshot.myActive.ability}`
        : '',
      '',
      `### Opponent Active: ${snapshot.opponentActive.name} (Lv.${snapshot.opponentActive.level})`,
      `  Types: ${snapshot.opponentActive.types.join('/') || 'unknown'}`,
      `  HP: ${snapshot.opponentActive.hp}/${snapshot.opponentActive.maxHp}`,
      snapshot.opponentActive.status
        ? `  Status: ${snapshot.opponentActive.status}`
        : '',
      snapshot.opponentActive.boosts
        ? `  Boosts: ${JSON.stringify(snapshot.opponentActive.boosts)}`
        : '',
      snapshot.opponentActive.item
        ? `  Item: ${snapshot.opponentActive.item}`
        : '',
      snapshot.opponentActive.ability
        ? `  Ability: ${snapshot.opponentActive.ability}`
        : '',
      '',
    ];

    if (snapshot.myBench.length > 0) {
      lines.push('### My Bench:');
      for (const p of snapshot.myBench) {
        lines.push(
          `  - ${p.name} (Lv.${p.level}) | HP ${p.hp}/${p.maxHp}${
            p.status ? ` [${p.status}]` : ''
          }${p.ability ? ` | ${p.ability}` : ''}${p.item ? ` | ${p.item}` : ''}`
        );
      }
      lines.push('');
    }

    if (snapshot.opponentBench.length > 0) {
      lines.push('### Opponent Bench:');
      for (const p of snapshot.opponentBench) {
        lines.push(
          `  - ${p.name} (Lv.${p.level}) | HP ${p.hp}/${p.maxHp}${
            p.status ? ` [${p.status}]` : ''
          }`
        );
      }
      lines.push('');
    }

    const hasField =
      snapshot.field.weather ||
      snapshot.field.terrain ||
      snapshot.field.pseudoWeather.length > 0;
    if (hasField) {
      lines.push('### Field Conditions:');
      if (snapshot.field.weather)
        lines.push(`  Weather: ${snapshot.field.weather}`);
      if (snapshot.field.terrain)
        lines.push(`  Terrain: ${snapshot.field.terrain}`);
      if (snapshot.field.pseudoWeather.length)
        lines.push(`  Effects: ${snapshot.field.pseudoWeather.join(', ')}`);
      lines.push('');
    }

    if (
      snapshot.mySideConditions.length ||
      snapshot.opponentSideConditions.length
    ) {
      lines.push('### Hazards / Screens:');
      if (snapshot.mySideConditions.length)
        lines.push(`  My side: ${snapshot.mySideConditions.join(', ')}`);
      if (snapshot.opponentSideConditions.length)
        lines.push(
          `  Opponent side: ${snapshot.opponentSideConditions.join(', ')}`
        );
      lines.push('');
    }

    if (
      snapshot.myActiveVolatiles.length ||
      snapshot.opponentActiveVolatiles.length
    ) {
      lines.push('### Volatile Effects:');
      if (snapshot.myActiveVolatiles.length)
        lines.push(`  My active: ${snapshot.myActiveVolatiles.join(', ')}`);
      if (snapshot.opponentActiveVolatiles.length)
        lines.push(
          `  Opponent active: ${snapshot.opponentActiveVolatiles.join(', ')}`
        );
      lines.push('');
    }

    lines.push(`### Speed: ${snapshot.speedComparison}`);
    lines.push(
      `### Fainted: mine=${snapshot.faintedCountMine}, opponent=${snapshot.faintedCountOpponent}`
    );
    lines.push('');

    lines.push('### Legal Actions:');
    for (const action of snapshot.legalActions) {
      let desc = `  ${action.choice} — ${action.label}`;
      if (action.moveType) desc += ` [${action.moveType}]`;
      if (action.movePower) desc += ` (${action.movePower} BP)`;
      if (action.moveCategory) desc += ` {${action.moveCategory}}`;
      lines.push(desc);
    }
    lines.push('');

    if (snapshot.recentEvents.length > 0) {
      lines.push('### Recent Events:');
      for (const event of snapshot.recentEvents) {
        lines.push(`  ${event}`);
      }
    }

    return lines.filter((l) => l !== undefined).join('\n');
  }

  // ---------------------------------------------------------------------------
  // Fallback (when model call fails)
  // ---------------------------------------------------------------------------

  private buildFallbackGuidance(
    snapshot: CopilotBattleSnapshot
  ): CopilotGuidance {
    const firstAction = snapshot.legalActions[0];
    return {
      recommendedAction: firstAction?.choice ?? 'default',
      recommendedLabel: firstAction?.label ?? 'Default action',
      confidence: 'low',
      reasoning:
        'Unable to generate AI guidance. Recommending the first available legal action as a fallback.',
      safeAlternative: null,
      aggressiveAlternative: null,
      mainRisk: 'No AI analysis available — proceed with caution.',
      winConditionNote: 'Unable to assess win conditions at this time.',
    };
  }
}
