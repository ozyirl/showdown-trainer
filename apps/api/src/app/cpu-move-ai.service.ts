import { Injectable, Logger } from '@nestjs/common';

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
  }>;
  recentLog?: string[];
}

export interface CpuMoveDecisionResult {
  moveIndex: number;
  reasoning?: string;
}

@Injectable()
export class CpuMoveAiService {
  private readonly logger = new Logger(CpuMoveAiService.name);
  private aiSdkLoaded = false;
  private generateTextFn:
    | ((args: { model: unknown; prompt: string }) => Promise<{ text: string }>)
    | null = null;
  private openAiModelFactory: ((modelId: string) => unknown) | null = null;

  /**
   * Lazy AI SDK initialization.
   * Uses `require` so scaffolding compiles even before packages are installed.
   *
   * Required packages (later):
   * - `ai`
   * - `@ai-sdk/openai`
   */
  private ensureClient() {
    if (this.aiSdkLoaded) return;

    try {
      const aiSdk = require('ai') as {
        generateText: (args: {
          model: unknown;
          prompt: string;
        }) => Promise<{ text: string }>;
      };
      const openAiSdk = require('@ai-sdk/openai') as {
        createOpenAI: (config: { apiKey: string }) => (modelId: string) => unknown;
      };

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY is not set');
      }

      const createOpenAI = openAiSdk.createOpenAI({ apiKey });
      this.openAiModelFactory = createOpenAI;
      this.generateTextFn = aiSdk.generateText;
      this.aiSdkLoaded = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(
        `CPU AI service is not initialized. Install 'ai' and '@ai-sdk/openai' and set OPENAI_API_KEY. (${message})`
      );
    }
  }

  getDefaultModel() {
    this.ensureClient();
    const modelId = process.env.OPENAI_CPU_MODEL || 'gpt-4.1-mini';
    if (!this.openAiModelFactory) {
      throw new Error('OpenAI model factory is not initialized');
    }
    return this.openAiModelFactory(modelId);
  }

  /**
   * Scaffold-only stub for future CPU move selection.
   * For now this only demonstrates client/model initialization and prompt wiring.
   */
  async chooseCpuMove(
    input: CpuMoveDecisionInput
  ): Promise<CpuMoveDecisionResult> {
    this.ensureClient();

    if (!input.availableMoves.length) {
      throw new Error('No available CPU moves to choose from');
    }

    const prompt = this.buildMovePrompt(input);

    // TODO: parse structured JSON safely and map to one of the available moves.
    // This is intentionally scaffold-only and not wired into battle flow yet.
    if (!this.generateTextFn) {
      throw new Error('AI SDK generateText is not initialized');
    }

    const result = await this.generateTextFn({
      model: this.getDefaultModel(),
      prompt,
    });

    this.logger.debug(`CPU move model response: ${result.text}`);
    return this.parseMoveDecision(result.text, input);
  }

  private buildMovePrompt(input: CpuMoveDecisionInput): string {
    const moves = input.availableMoves
      .map(
        (move) =>
          `${move.index}. ${move.name} (${move.type ?? 'Unknown'}${
            typeof move.power === 'number' ? `, Power ${move.power}` : ''
          }${typeof move.pp === 'number' ? `, PP ${move.pp}` : ''})`
      )
      .join('\n');

    const recentLog = (input.recentLog ?? []).slice(-8).join('\n');

    return [
      'You are choosing a Pokemon battle move for the CPU in a Pokemon Showdown-style battle.',
      `Turn: ${input.turn}`,
      `CPU Pokemon: ${input.cpuPokemonName}`,
      `Opponent Pokemon: ${input.playerPokemonName}`,
      'Available moves:',
      moves,
      recentLog ? 'Recent battle log:\n' + recentLog : '',
      'Return JSON only in this exact shape: {"moveIndex": <number>, "reasoning": "<short reason>"}',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private parseMoveDecision(
    text: string,
    input: CpuMoveDecisionInput
  ): CpuMoveDecisionResult {
    const validIndices = new Set(input.availableMoves.map((move) => move.index));

    const parsedJson = this.tryParseJsonObject(text);
    if (parsedJson) {
      const moveIndex = this.coerceMoveIndex(parsedJson.moveIndex);
      if (moveIndex !== null && validIndices.has(moveIndex)) {
        return {
          moveIndex,
          reasoning:
            typeof parsedJson.reasoning === 'string'
              ? parsedJson.reasoning
              : undefined,
        };
      }
    }

    const explicitIndexMatch = text.match(/(?:moveIndex|index)\s*["':= ]+\s*(\d+)/i);
    if (explicitIndexMatch) {
      const moveIndex = Number(explicitIndexMatch[1]);
      if (validIndices.has(moveIndex)) {
        return { moveIndex, reasoning: text.trim().slice(0, 200) };
      }
    }

    for (const move of input.availableMoves) {
      const escaped = move.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) {
        return { moveIndex: move.index, reasoning: text.trim().slice(0, 200) };
      }
    }

    return {
      moveIndex: input.availableMoves[0].index,
      reasoning: 'Fallback: could not parse model response.',
    };
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
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
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
}
