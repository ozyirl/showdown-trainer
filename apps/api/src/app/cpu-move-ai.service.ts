import { Injectable, Logger } from '@nestjs/common';
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';

export interface CpuMoveDecisionInput {
  battleId: string;
  turn: number;
  cpuPokemonName: string;
  playerPokemonName: string;
  availableMoves: Array<{
    index: number;
    name: string;
    type?: string;
    power?: number | null;
    pp?: number;
    effectivenessMultiplier?: number;
    isImmune?: boolean;
  }>;
  recentLog?: string[];
  cpuPokemonTypes?: string[];
  playerPokemonTypes?: string[];
}

export interface CpuSwitchDecisionOption {
  slot: number;
  name: string;
  hpPercent: number;
  status?: string | null;
}

export interface CpuActionDecisionInput {
  battleId: string;
  turn: number;
  cpuPokemonName: string;
  playerPokemonName: string;
  forceSwitch?: boolean;
  availableMoves: CpuMoveDecisionInput['availableMoves'];
  availableSwitches?: CpuSwitchDecisionOption[];
  recentLog?: string[];
  cpuPokemonTypes?: string[];
  playerPokemonTypes?: string[];
}

export interface CpuActionDecisionResult {
  choice: string;
  actionType: 'move' | 'switch' | 'default';
  source: 'model' | 'fallback';
  modelId: string;
  latencyMs: number;
  rawResponse?: string;
  reasoning?: string;
  error?: string;
}

export interface CpuMoveDecisionResult {
  moveIndex: number;
  source: 'model' | 'fallback';
  modelId: string;
  latencyMs: number;
  rawResponse?: string;
  reasoning?: string;
  error?: string;
}

@Injectable()
export class CpuMoveAiService {
  private readonly logger = new Logger(CpuMoveAiService.name);

  getDefaultModel() {
    const modelId = process.env.OPENAI_CPU_MODEL || 'gpt-4.1-mini';
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set');
    }
    return openai(modelId);
  }

  getDefaultModelId(): string {
    return process.env.OPENAI_CPU_MODEL || 'gpt-4.1-mini';
  }

  /**
   * Scaffold-only stub for future CPU move selection.
   * For now this only demonstrates client/model initialization and prompt wiring.
   */
  async chooseCpuMove(
    input: CpuMoveDecisionInput
  ): Promise<CpuMoveDecisionResult> {
    if (!input.availableMoves.length) {
      throw new Error('No available CPU moves to choose from');
    }

    const prompt = this.buildMovePrompt(input);

    const modelId = this.getDefaultModelId();
    const startedAt = Date.now();

    try {
      const result = await generateText({
        model: this.getDefaultModel(),
        prompt,
        maxOutputTokens: 80,
      });

      const latencyMs = Date.now() - startedAt;
      const parsed = this.parseMoveDecision(result.text, input);
      const originalMoveIndex = parsed.moveIndex;
      let selectedMove = input.availableMoves.find(
        (move) => move.index === parsed.moveIndex
      );
      const immunityOverride = this.overrideImmuneChoiceIfNeeded(
        parsed.moveIndex,
        input
      );
      if (immunityOverride !== null) {
        parsed.moveIndex = immunityOverride;
        selectedMove = input.availableMoves.find(
          (move) => move.index === parsed.moveIndex
        );
      }
      const originalMove = input.availableMoves.find(
        (move) => move.index === originalMoveIndex
      );
      this.logger.debug(
        `CPU move model response (${latencyMs}ms): ${result.text} | selected=${selectedMove?.name ?? parsed.moveIndex}${
          immunityOverride !== null
            ? ` | override=${originalMove?.name ?? originalMoveIndex}->${selectedMove?.name ?? immunityOverride} (immune)`
            : ''
        }`
      );

      return {
        ...parsed,
        source: 'model',
        modelId,
        latencyMs,
        rawResponse: result.text,
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (this.isStrictAiMode()) {
        throw new Error(`CPU AI strict mode: ${message}`);
      }
      this.logger.warn(`CPU move fallback (${latencyMs}ms): ${message}`);
      return {
        moveIndex: input.availableMoves[0].index,
        source: 'fallback',
        modelId,
        latencyMs,
        error: message,
      };
    }
  }

  async chooseCpuAction(
    input: CpuActionDecisionInput
  ): Promise<CpuActionDecisionResult> {
    const legalSwitches = (input.availableSwitches ?? []).filter(
      (option) => option.hpPercent > 0
    );
    const forceSwitch = !!input.forceSwitch;
    const canMove = !forceSwitch && input.availableMoves.length > 0;
    const canSwitch = legalSwitches.length > 0;

    if (!canMove && !canSwitch) {
      return {
        choice: 'default',
        actionType: 'default',
        source: 'fallback',
        modelId: this.getDefaultModelId(),
        latencyMs: 0,
      };
    }

    const modelId = this.getDefaultModelId();
    const startedAt = Date.now();
    const fallbackChoice = this.fallbackActionChoice(
      input.availableMoves,
      legalSwitches,
      forceSwitch
    );

    try {
      const result = await generateText({
        model: this.getDefaultModel(),
        prompt: this.buildActionPrompt(input, legalSwitches),
        maxOutputTokens: 120,
      });

      const latencyMs = Date.now() - startedAt;
      const parsed = this.parseActionDecision(
        result.text,
        input.availableMoves,
        legalSwitches,
        forceSwitch
      );

      return {
        ...parsed,
        source: 'model',
        modelId,
        latencyMs,
        rawResponse: result.text,
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (this.isStrictAiMode()) {
        throw new Error(`CPU AI strict mode: ${message}`);
      }
      return {
        choice: fallbackChoice.choice,
        actionType: fallbackChoice.actionType,
        source: 'fallback',
        modelId,
        latencyMs,
        error: message,
      };
    }
  }

  private buildMovePrompt(input: CpuMoveDecisionInput): string {
    const moves = input.availableMoves
      .map(
        (move) =>
          `${move.index}. ${move.name} (${move.type ?? 'Unknown'}${
            typeof move.power === 'number' ? `, Power ${move.power}` : ''
          }${typeof move.pp === 'number' ? `, PP ${move.pp}` : ''}${
            move.isImmune
              ? ', Effectiveness 0x (immune)'
              : typeof move.effectivenessMultiplier === 'number'
                ? `, Effectiveness ${move.effectivenessMultiplier}x`
                : ''
          })`
      )
      .join('\n');

    const recentLog = (input.recentLog ?? []).slice(-4).join('\n');

    return [
      'You are choosing a Pokemon battle move for the CPU in a Pokemon Showdown-style battle.',
      `Turn: ${input.turn}`,
      `CPU Pokemon: ${input.cpuPokemonName}`,
      input.cpuPokemonTypes?.length
        ? `CPU types: ${input.cpuPokemonTypes.join('/')}`
        : '',
      `Opponent Pokemon: ${input.playerPokemonName}`,
      input.playerPokemonTypes?.length
        ? `Opponent types: ${input.playerPokemonTypes.join('/')}`
        : '',
      'Available moves:',
      moves,
      recentLog ? 'Recent battle log (brief):\n' + recentLog : '',
      'Do not choose moves that have 0x effectiveness / immunity unless no other legal move is available.',
      'Return JSON only: {"moveIndex": <number>, "moveName": "<name>", "reasoning": "<short reason>"}',
      'Keep reasoning very short (max 12 words).',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private buildActionPrompt(
    input: CpuActionDecisionInput,
    legalSwitches: CpuSwitchDecisionOption[]
  ): string {
    const moveLines = input.availableMoves
      .map(
        (move) =>
          `move ${move.index} - ${move.name} (${move.type ?? 'Unknown'}${
            typeof move.power === 'number' ? `, Power ${move.power}` : ''
          }${
            move.isImmune
              ? ', Effectiveness 0x (immune)'
              : typeof move.effectivenessMultiplier === 'number'
                ? `, Effectiveness ${move.effectivenessMultiplier}x`
                : ''
          })`
      )
      .join('\n');

    const switchLines = legalSwitches
      .map(
        (switchOption) =>
          `switch ${switchOption.slot} - ${switchOption.name} (${switchOption.hpPercent}% HP${
            switchOption.status ? `, ${switchOption.status}` : ''
          })`
      )
      .join('\n');

    const recentLog = (input.recentLog ?? []).slice(-4).join('\n');
    return [
      'You are choosing the CPU action in a Pokemon Showdown battle.',
      `Turn: ${input.turn}`,
      `CPU active: ${input.cpuPokemonName}`,
      `Opponent active: ${input.playerPokemonName}`,
      input.cpuPokemonTypes?.length
        ? `CPU types: ${input.cpuPokemonTypes.join('/')}`
        : '',
      input.playerPokemonTypes?.length
        ? `Opponent types: ${input.playerPokemonTypes.join('/')}`
        : '',
      input.forceSwitch
        ? 'Forced switch is required. You must return a switch action.'
        : 'Choose the best legal action.',
      moveLines ? `Legal moves:\n${moveLines}` : 'No legal moves this turn.',
      switchLines
        ? `Legal switches:\n${switchLines}`
        : 'No legal switches this turn.',
      recentLog ? `Recent log:\n${recentLog}` : '',
      'Never choose immune moves when non-immune options exist.',
      'Return JSON only: {"choice":"move 1"|"switch 3"|"default","reasoning":"short reason"}',
      'Keep reasoning very short (max 12 words).',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private parseMoveDecision(
    text: string,
    input: CpuMoveDecisionInput
  ): CpuMoveDecisionResult {
    const validIndices = new Set(
      input.availableMoves.map((move) => move.index)
    );

    const parsedJson = this.tryParseJsonObject(text);
    if (parsedJson) {
      const moveIndexFromJson = this.normalizeAiMoveIndex(
        this.coerceMoveIndex(parsedJson.moveIndex),
        input
      );
      const moveIndexFromName = this.findMoveIndexByName(
        typeof parsedJson.moveName === 'string' ? parsedJson.moveName : undefined,
        input
      );
      const moveIndex = this.resolveConflictingModelMoveSelection(
        moveIndexFromJson,
        moveIndexFromName,
        input
      );

      if (moveIndex !== null && validIndices.has(moveIndex)) {
        return {
          moveIndex,
          source: 'model',
          modelId: this.getDefaultModelId(),
          latencyMs: 0,
          reasoning:
            typeof parsedJson.reasoning === 'string'
              ? parsedJson.reasoning
              : undefined,
        };
      }
    }

    const explicitIndexMatch = text.match(
      /(?:moveIndex|index)\s*["':= ]+\s*(\d+)/i
    );
    if (explicitIndexMatch) {
      const moveIndex = this.normalizeAiMoveIndex(
        Number(explicitIndexMatch[1]),
        input
      );
      if (moveIndex !== null && validIndices.has(moveIndex)) {
        return {
          moveIndex,
          source: 'model',
          modelId: this.getDefaultModelId(),
          latencyMs: 0,
          reasoning: text.trim().slice(0, 200),
        };
      }
    }

    for (const move of input.availableMoves) {
      const escaped = move.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) {
        return {
          moveIndex: move.index,
          source: 'model',
          modelId: this.getDefaultModelId(),
          latencyMs: 0,
          reasoning: text.trim().slice(0, 200),
        };
      }
    }

    return {
      moveIndex: input.availableMoves[0].index,
      source: 'fallback',
      modelId: this.getDefaultModelId(),
      latencyMs: 0,
      reasoning: 'Fallback: could not parse model response.',
    };
  }

  private isStrictAiMode(): boolean {
    return process.env.OPENAI_CPU_STRICT === 'true';
  }

  private overrideImmuneChoiceIfNeeded(
    moveIndex: number,
    input: CpuMoveDecisionInput
  ): number | null {
    const selected = input.availableMoves.find((move) => move.index === moveIndex);
    if (!selected?.isImmune) return null;

    const alternatives = input.availableMoves.filter(
      (move) => !move.isImmune
    );
    if (alternatives.length === 0) return null;

    alternatives.sort((a, b) => {
      const multA = a.effectivenessMultiplier ?? 1;
      const multB = b.effectivenessMultiplier ?? 1;
      if (multB !== multA) return multB - multA;
      const powerA = a.power ?? 0;
      const powerB = b.power ?? 0;
      if (powerB !== powerA) return powerB - powerA;
      return a.index - b.index;
    });

    return alternatives[0].index;
  }

  private parseActionDecision(
    text: string,
    availableMoves: CpuMoveDecisionInput['availableMoves'],
    availableSwitches: CpuSwitchDecisionOption[],
    forceSwitch: boolean
  ): CpuActionDecisionResult {
    const fallback = this.fallbackActionChoice(
      availableMoves,
      availableSwitches,
      forceSwitch
    );
    const legalChoices = new Set<string>([
      ...(!forceSwitch ? availableMoves.map((move) => `move ${move.index}`) : []),
      ...availableSwitches.map((switchOption) => `switch ${switchOption.slot}`),
      'default',
    ]);

    const parsedJson = this.tryParseJsonObject(text);
    const jsonChoice =
      typeof parsedJson?.choice === 'string' ? parsedJson.choice.trim() : '';
    if (jsonChoice) {
      const normalized = this.normalizeChoice(
        jsonChoice,
        availableMoves,
        availableSwitches,
        forceSwitch
      );
      if (normalized && legalChoices.has(normalized)) {
        return {
          choice: normalized,
          actionType: normalized.startsWith('switch')
            ? 'switch'
            : normalized.startsWith('move')
              ? 'move'
              : 'default',
          source: 'model',
          modelId: this.getDefaultModelId(),
          latencyMs: 0,
          reasoning:
            typeof parsedJson?.reasoning === 'string'
              ? parsedJson.reasoning
              : undefined,
        };
      }
    }

    const choiceMatch = text.match(/\b(move\s+\d+|switch\s+\d+|default)\b/i);
    if (choiceMatch) {
      const normalized = this.normalizeChoice(
        choiceMatch[1].toLowerCase(),
        availableMoves,
        availableSwitches,
        forceSwitch
      );
      if (normalized && legalChoices.has(normalized)) {
        return {
          choice: normalized,
          actionType: normalized.startsWith('switch')
            ? 'switch'
            : normalized.startsWith('move')
              ? 'move'
              : 'default',
          source: 'model',
          modelId: this.getDefaultModelId(),
          latencyMs: 0,
          reasoning: text.trim().slice(0, 200),
        };
      }
    }

    return {
      choice: fallback.choice,
      actionType: fallback.actionType,
      source: 'fallback',
      modelId: this.getDefaultModelId(),
      latencyMs: 0,
      reasoning: 'Fallback: could not parse model action.',
    };
  }

  private normalizeChoice(
    choice: string,
    availableMoves: CpuMoveDecisionInput['availableMoves'],
    availableSwitches: CpuSwitchDecisionOption[],
    forceSwitch: boolean
  ): string | null {
    const normalized = choice.trim().toLowerCase();
    if (normalized === 'default') return 'default';

    const moveMatch = normalized.match(/^move\s+(\d+)$/);
    if (moveMatch) {
      if (forceSwitch) return null;
      const moveIndex = this.normalizeAiMoveIndex(Number(moveMatch[1]), {
        availableMoves,
        battleId: 'action-normalize',
        turn: 0,
        cpuPokemonName: '',
        playerPokemonName: '',
      });
      if (moveIndex === null) return null;
      const selected = availableMoves.find((move) => move.index === moveIndex);
      if (!selected) return null;
      if (selected.isImmune) {
        const override = this.overrideImmuneChoiceIfNeeded(moveIndex, {
          availableMoves,
          battleId: 'action-normalize',
          turn: 0,
          cpuPokemonName: '',
          playerPokemonName: '',
        });
        if (override !== null) {
          return `move ${override}`;
        }
      }
      return `move ${moveIndex}`;
    }

    const switchMatch = normalized.match(/^switch\s+(\d+)$/);
    if (switchMatch) {
      const slot = Number(switchMatch[1]);
      const exists = availableSwitches.some((option) => option.slot === slot);
      return exists ? `switch ${slot}` : null;
    }

    return null;
  }

  private fallbackActionChoice(
    availableMoves: CpuMoveDecisionInput['availableMoves'],
    availableSwitches: CpuSwitchDecisionOption[],
    forceSwitch: boolean
  ): { choice: string; actionType: 'move' | 'switch' | 'default' } {
    if (forceSwitch || availableMoves.length === 0) {
      if (availableSwitches.length === 0) {
        return { choice: 'default', actionType: 'default' };
      }
      const bestSwitch = [...availableSwitches].sort((a, b) => {
        if (b.hpPercent !== a.hpPercent) return b.hpPercent - a.hpPercent;
        if (a.status && !b.status) return 1;
        if (!a.status && b.status) return -1;
        return a.slot - b.slot;
      })[0];
      return { choice: `switch ${bestSwitch.slot}`, actionType: 'switch' };
    }

    const nonImmuneMoves = availableMoves.filter((move) => !move.isImmune);
    const pool = nonImmuneMoves.length > 0 ? nonImmuneMoves : availableMoves;
    const bestMove = [...pool].sort((a, b) => {
      const effA = a.effectivenessMultiplier ?? 1;
      const effB = b.effectivenessMultiplier ?? 1;
      if (effB !== effA) return effB - effA;
      const powerA = a.power ?? 0;
      const powerB = b.power ?? 0;
      if (powerB !== powerA) return powerB - powerA;
      const ppA = a.pp ?? 0;
      const ppB = b.pp ?? 0;
      if (ppB !== ppA) return ppB - ppA;
      return a.index - b.index;
    })[0];
    return { choice: `move ${bestMove.index}`, actionType: 'move' };
  }

  private tryParseJsonObject(text: string): Record<string, unknown> | null {
    const trimmed = text.trim();
    const direct = this.safeJsonParse(trimmed);
    if (direct) return direct;

    const objectMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!objectMatch) return null;
    return this.safeJsonParse(objectMatch[0]);
  }

  private safeJsonParse(text: string): Record<string, unknown> | null {
    try {
      const value = JSON.parse(text) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
      return value as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private coerceMoveIndex(value: unknown): number | null {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return null;
  }

  private normalizeAiMoveIndex(
    rawIndex: number | null,
    input: CpuMoveDecisionInput
  ): number | null {
    if (rawIndex === null) return null;

    const oneBasedValid = input.availableMoves.some((move) => move.index === rawIndex);
    if (oneBasedValid) return rawIndex;

    // Accept 0-based indices from the model and convert to the backend's 1-based move slots.
    const oneBasedFromZero = rawIndex + 1;
    const zeroBasedValid = input.availableMoves.some(
      (move) => move.index === oneBasedFromZero
    );
    if (zeroBasedValid) return oneBasedFromZero;

    return rawIndex;
  }

  private findMoveIndexByName(
    moveName: string | undefined,
    input: CpuMoveDecisionInput
  ): number | null {
    if (!moveName) return null;
    const normalized = moveName.trim().toLowerCase();
    if (!normalized) return null;

    const exact = input.availableMoves.find(
      (move) => move.name.trim().toLowerCase() === normalized
    );
    return exact?.index ?? null;
  }

  private resolveConflictingModelMoveSelection(
    moveIndexFromJson: number | null,
    moveIndexFromName: number | null,
    input: CpuMoveDecisionInput
  ): number | null {
    if (moveIndexFromJson !== null && moveIndexFromName !== null) {
      if (moveIndexFromJson !== moveIndexFromName) {
        const jsonMove = input.availableMoves.find(
          (move) => move.index === moveIndexFromJson
        );
        const nameMove = input.availableMoves.find(
          (move) => move.index === moveIndexFromName
        );
        this.logger.warn(
          `CPU AI returned conflicting moveIndex/moveName: index=${moveIndexFromJson} (${jsonMove?.name ?? 'unknown'}), moveName=${nameMove?.name ?? 'unknown'}; preferring moveName`
        );
      }
      return moveIndexFromName;
    }

    return moveIndexFromName ?? moveIndexFromJson;
  }
}
