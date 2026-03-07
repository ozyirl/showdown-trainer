import { Injectable, Logger } from '@nestjs/common';
import type OpenAI from 'openai';
import { ReplaySubject } from 'rxjs';
import {
  CPU_MOVE_SYSTEM_INSTRUCTIONS,
  CPU_ACTION_SYSTEM_INSTRUCTIONS,
} from './system-prompts';
import {
  resolveModelId,
  getTokenBudget,
  parseJsonFromModelOutput,
} from './model-utils';
import { getOpenAiClient } from './openai-client';

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

export type CpuStreamEvent =
  | { type: 'start'; turn: number; modelId: string }
  | { type: 'chunk'; turn: number; content: string }
  | {
      type: 'done';
      turn: number;
      choice: string;
      actionType: 'move' | 'switch' | 'default';
      source: 'model' | 'fallback';
      modelId: string;
      latencyMs: number;
      rawResponse?: string;
      reasoning?: string;
      error?: string;
    }
  | {
      type: 'model-error';
      turn: number;
      modelId: string;
      error: string;
      latencyMs: number;
    };

@Injectable()
export class CpuMoveAiService {
  private readonly logger = new Logger(CpuMoveAiService.name);
  private readonly battleStreams = new Map<string, ReplaySubject<CpuStreamEvent>>();

  getDefaultModelId(): string {
    return resolveModelId('OPENAI_CPU_MODEL');
  }

  getBattleStream(battleId: string): ReplaySubject<CpuStreamEvent> {
    return this.ensureBattleStream(battleId);
  }

  clearBattleStream(battleId: string): void {
    this.battleStreams.delete(battleId);
  }

  async chooseCpuMove(
    input: CpuMoveDecisionInput
  ): Promise<CpuMoveDecisionResult> {
    if (!input.availableMoves.length) {
      throw new Error('No available CPU moves to choose from');
    }

    const modelId = this.getDefaultModelId();
    const startedAt = Date.now();

    try {
      const rawText = await this.streamCompletion({
        battleId: input.battleId,
        turn: input.turn,
        modelId,
        systemInstruction: CPU_MOVE_SYSTEM_INSTRUCTIONS[0],
        prompt: this.buildMovePrompt(input),
        maxCompletionTokens: getTokenBudget(modelId, 'move'),
      });

      const parsed = this.parseMoveDecision(rawText, input);
      const originalMoveIndex = parsed.moveIndex;
      const immunityOverride = this.overrideImmuneChoiceIfNeeded(
        parsed.moveIndex,
        input
      );
      const moveIndex = immunityOverride ?? parsed.moveIndex;
      const selectedMove = input.availableMoves.find(
        (move) => move.index === moveIndex
      );
      const originalMove = input.availableMoves.find(
        (move) => move.index === originalMoveIndex
      );
      const latencyMs = Date.now() - startedAt;

      this.logger.debug(
        `CPU move final (${latencyMs}ms): source=${parsed.source} selected=${
          selectedMove?.name ?? moveIndex
        }${
          immunityOverride !== null
            ? ` | override=${originalMove?.name ?? originalMoveIndex}->${
                selectedMove?.name ?? moveIndex
              } (immune)`
            : ''
        }`
      );

      this.emitDoneEvent(input.battleId, {
        turn: input.turn,
        choice: `move ${moveIndex}`,
        actionType: 'move',
        source: parsed.source,
        modelId,
        latencyMs,
        rawResponse: rawText,
        reasoning: parsed.reasoning,
      });

      return {
        moveIndex,
        source: parsed.source,
        modelId,
        latencyMs,
        rawResponse: rawText,
        reasoning: parsed.reasoning,
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.emitErrorEvent(input.battleId, input.turn, modelId, message, latencyMs);
      if (this.isStrictAiMode()) {
        throw new Error(`CPU AI strict mode: ${message}`);
      }
      this.logger.warn(`CPU move fallback (${latencyMs}ms): ${message}`);
      this.emitDoneEvent(input.battleId, {
        turn: input.turn,
        choice: `move ${input.availableMoves[0].index}`,
        actionType: 'move',
        source: 'fallback',
        modelId,
        latencyMs,
        error: message,
      });
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
      const rawText = await this.streamCompletion({
        battleId: input.battleId,
        turn: input.turn,
        modelId,
        systemInstruction: CPU_ACTION_SYSTEM_INSTRUCTIONS[0],
        prompt: this.buildActionPrompt(input, legalSwitches),
        maxCompletionTokens: getTokenBudget(modelId, 'action'),
      });

      const parsed = this.parseActionDecision(
        rawText,
        input.availableMoves,
        legalSwitches,
        forceSwitch
      );
      const latencyMs = Date.now() - startedAt;

      this.emitDoneEvent(input.battleId, {
        turn: input.turn,
        choice: parsed.choice,
        actionType: parsed.actionType,
        source: parsed.source,
        modelId,
        latencyMs,
        rawResponse: rawText,
        reasoning: parsed.reasoning,
      });

      return {
        ...parsed,
        modelId,
        latencyMs,
        rawResponse: rawText,
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.emitErrorEvent(input.battleId, input.turn, modelId, message, latencyMs);
      if (this.isStrictAiMode()) {
        throw new Error(`CPU AI strict mode: ${message}`);
      }
      this.emitDoneEvent(input.battleId, {
        turn: input.turn,
        choice: fallbackChoice.choice,
        actionType: fallbackChoice.actionType,
        source: 'fallback',
        modelId,
        latencyMs,
        error: message,
      });
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

  private async streamCompletion(params: {
    battleId: string;
    turn: number;
    modelId: string;
    systemInstruction: string;
    prompt: string;
    maxCompletionTokens: number;
  }): Promise<string> {
    const stream = this.ensureBattleStream(params.battleId);
    stream.next({
      type: 'start',
      turn: params.turn,
      modelId: params.modelId,
    });

    const client = getOpenAiClient();
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: params.systemInstruction },
      { role: 'user', content: params.prompt },
    ];

    const completion = await client.chat.completions.create({
      model: params.modelId,
      messages,
      stream: true,
      max_completion_tokens: params.maxCompletionTokens,
      reasoning_effort: 'minimal',
    });

    let fullText = '';
    for await (const chunk of completion) {
      const content = chunk.choices[0]?.delta?.content;
      if (typeof content !== 'string' || content.length === 0) {
        continue;
      }
      fullText += content;
      stream.next({
        type: 'chunk',
        turn: params.turn,
        content,
      });
    }

    this.logger.debug(
      `CPU stream raw (${params.modelId}, turn ${params.turn}): ${fullText.length} chars`
    );

    return fullText;
  }

  private emitDoneEvent(
    battleId: string,
    event: Extract<CpuStreamEvent, { type: 'done' }>
  ): void {
    this.ensureBattleStream(battleId).next({ type: 'done', ...event });
  }

  private emitErrorEvent(
    battleId: string,
    turn: number,
    modelId: string,
    error: string,
    latencyMs: number
  ): void {
    this.ensureBattleStream(battleId).next({
      type: 'model-error',
      turn,
      modelId,
      error,
      latencyMs,
    });
  }

  private ensureBattleStream(battleId: string): ReplaySubject<CpuStreamEvent> {
    let stream = this.battleStreams.get(battleId);
    if (!stream) {
      stream = new ReplaySubject<CpuStreamEvent>(1024);
      this.battleStreams.set(battleId, stream);
    }
    return stream;
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
      recentLog ? `Recent battle log (brief):\n${recentLog}` : '',
      CPU_MOVE_SYSTEM_INSTRUCTIONS[1],
      CPU_MOVE_SYSTEM_INSTRUCTIONS[2],
      CPU_MOVE_SYSTEM_INSTRUCTIONS[3],
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
          `switch ${switchOption.slot} - ${switchOption.name} (${
            switchOption.hpPercent
          }% HP${switchOption.status ? `, ${switchOption.status}` : ''})`
      )
      .join('\n');

    const recentLog = (input.recentLog ?? []).slice(-4).join('\n');
    return [
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
      CPU_ACTION_SYSTEM_INSTRUCTIONS[1],
      CPU_ACTION_SYSTEM_INSTRUCTIONS[2],
      CPU_ACTION_SYSTEM_INSTRUCTIONS[3],
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private parseMoveDecision(
    text: string,
    input: CpuMoveDecisionInput
  ): CpuMoveDecisionResult {
    const validIndices = new Set(input.availableMoves.map((move) => move.index));

    const parsedJson = parseJsonFromModelOutput(text);
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

    const explicitIndexMatch = text.match(/(?:moveIndex|index)\s*["':= ]+\s*(\d+)/i);
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

    const parsedJson = parseJsonFromModelOutput(text);
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

  private isStrictAiMode(): boolean {
    return process.env.OPENAI_CPU_STRICT === 'true';
  }

  private overrideImmuneChoiceIfNeeded(
    moveIndex: number,
    input: CpuMoveDecisionInput
  ): number | null {
    const selected = input.availableMoves.find((move) => move.index === moveIndex);
    if (!selected?.isImmune) return null;

    const alternatives = input.availableMoves.filter((move) => !move.isImmune);
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
          `CPU AI returned conflicting moveIndex/moveName: index=${moveIndexFromJson} (${
            jsonMove?.name ?? 'unknown'
          }), moveName=${nameMove?.name ?? 'unknown'}; preferring moveName`
        );
      }
      return moveIndexFromName;
    }

    return moveIndexFromName ?? moveIndexFromJson;
  }
}
