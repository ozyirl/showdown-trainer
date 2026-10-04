import { Injectable, Logger } from '@nestjs/common';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { resolveModelId } from '../model-utils';
import { getOpenAiClient } from '../openai-client';
import { getKimiRequestOptions } from '../ai-provider';
import type { TeamPokemonSlot, StatSpread } from './teams.types';
import type {
  TeambuilderChatRequest,
  TeambuilderChatResponse,
} from './teambuilder-ai.types';

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;

const MAX_TOOL_ROUNDS = 10;

const SYSTEM_PROMPT = `You are a competitive Pokemon teambuilder co-pilot. Help the user build a strong team by suggesting Pokemon, movesets, items, abilities, natures, and EV spreads.

Rules:
- ALWAYS use the lookup tools (lookupPokemon, lookupMoves, lookupItem, lookupAbility) to verify names, stats, and learnsets before making recommendations. Never guess or hallucinate move names, abilities, or items.
- Consider the target format (OU, UU, Ubers, etc.) when specified. Suggest Pokemon that are legal and viable in that tier.
- When suggesting a Pokemon, explain WHY it fits the team (role compression, type synergy, speed tier, etc.).
- When the user approves a Pokemon or asks you to add one, call setTeamSlot with the full set (species, moves, item, ability, nature, EVs). Pick the next available slot (1-6) unless the user specifies otherwise.
- Keep responses concise. Use bullet points for movesets.
- If the user's current team is provided, analyze it for weaknesses and suggest Pokemon that cover gaps.`;

const STAT_SPREAD_SCHEMA = {
  type: 'object' as const,
  properties: {
    hp: { type: 'integer' as const },
    atk: { type: 'integer' as const },
    def: { type: 'integer' as const },
    spa: { type: 'integer' as const },
    spd: { type: 'integer' as const },
    spe: { type: 'integer' as const },
  },
  additionalProperties: false,
};

const TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'lookupPokemon',
      description:
        'Look up a Pokemon by name to get its types, base stats, abilities, tier, and weight.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Pokemon name, e.g. "Garchomp"',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookupMoves',
      description:
        "Get a Pokemon's learnable moves with type, power, category, accuracy, and PP.",
      parameters: {
        type: 'object',
        properties: {
          pokemon: {
            type: 'string',
            description: 'Pokemon name, e.g. "Garchomp"',
          },
        },
        required: ['pokemon'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookupItem',
      description: 'Look up a held item by name to get its effect.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Item name, e.g. "Choice Scarf"',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookupAbility',
      description: 'Look up an ability by name to get its effect.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Ability name, e.g. "Rough Skin"',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'setTeamSlot',
      description:
        'Add or update a Pokemon in a team slot. Call this when the user confirms a Pokemon.',
      parameters: {
        type: 'object',
        properties: {
          slot: { type: 'integer', description: 'Team slot number (1-6)' },
          species: { type: 'string', description: 'Pokemon species name' },
          moves: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of 1-4 move names',
          },
          item: { type: 'string', description: 'Held item name' },
          ability: { type: 'string', description: 'Ability name' },
          nature: { type: 'string', description: 'Nature name, e.g. "Jolly"' },
          teraType: { type: 'string', description: 'Tera type, e.g. "Fire"' },
          evs: {
            ...STAT_SPREAD_SCHEMA,
            description: 'EV spread (0-252 per stat)',
          },
          ivs: {
            ...STAT_SPREAD_SCHEMA,
            description: 'IV spread (0-31 per stat, defaults to 31)',
          },
        },
        required: ['slot', 'species', 'moves'],
        additionalProperties: false,
      },
    },
  },
];

function buildContextMessage(
  currentSlots: TeamPokemonSlot[] | undefined,
  format: string | undefined
): string {
  const parts: string[] = [];
  if (format) {
    parts.push(`Target format: ${format}`);
  }
  if (currentSlots?.length) {
    const filledSlots = currentSlots.filter((s) => s.species?.trim());
    if (filledSlots.length > 0) {
      const teamSummary = currentSlots
        .map((s, idx) => {
          const slotNum = s.slot ?? idx + 1;
          if (!s.species?.trim()) return `Slot ${slotNum}: (empty)`;
          const movesStr =
            (s.moves ?? []).filter(Boolean).join(', ') || 'no moves';
          return `Slot ${slotNum}: ${s.species} (${movesStr})${
            s.item ? ` @ ${s.item}` : ''
          }${s.ability ? ` [${s.ability}]` : ''}`;
        })
        .join('\n');
      parts.push(
        `Current team (${filledSlots.length}/6 filled):\n${teamSummary}`
      );
      const nextSlot = currentSlots.length < 6 ? currentSlots.length + 1 : null;
      if (nextSlot) parts.push(`Next available slot: ${nextSlot}`);
    } else {
      parts.push(
        'Current team: empty (0/6 slots filled). Start adding Pokemon to slot 1.'
      );
    }
  } else {
    parts.push(
      'Current team: empty (0/6 slots filled). Start adding Pokemon to slot 1.'
    );
  }
  return parts.join('\n\n');
}

@Injectable()
export class TeambuilderAiService {
  private readonly logger = new Logger(TeambuilderAiService.name);

  async chat(
    request: TeambuilderChatRequest
  ): Promise<TeambuilderChatResponse> {
    const client = getOpenAiClient();
    const modelId = resolveModelId(
      'OPENAI_TEAMBUILDER_MODEL',
      'gpt-4.1-nano-2025-04-14'
    );
    const slotUpdates: TeamPokemonSlot[] = [];

    const contextMessage = buildContextMessage(
      request.currentSlots,
      request.format
    );

    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `[Team context]\n${contextMessage}` },
      ...request.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    const startMs = Date.now();

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const completion = await client.chat.completions.create({
        model: modelId,
        messages,
        tools: TOOLS,
        ...getKimiRequestOptions(modelId),
      });

      const choice = completion.choices[0];
      if (!choice) break;

      messages.push(choice.message);

      if (
        choice.finish_reason !== 'tool_calls' ||
        !choice.message.tool_calls?.length
      ) {
        const latencyMs = Date.now() - startMs;
        this.logger.debug(
          `Teambuilder chat (${modelId}, ${latencyMs}ms, ${
            round + 1
          } rounds): ${slotUpdates.length} slot updates`
        );
        return {
          message:
            choice.message.content ||
            'I could not generate a response. Please try again.',
          slotUpdates,
        };
      }

      for (const toolCall of choice.message.tool_calls) {
        if (toolCall.type !== 'function') continue;
        const fn = toolCall.function;
        const args = JSON.parse(fn.arguments) as Record<string, unknown>;
        let result: unknown;

        try {
          result = await this.executeTool(fn.name, args, slotUpdates);
        } catch (err) {
          result = {
            error: err instanceof Error ? err.message : 'Tool execution failed',
          };
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
    }

    const latencyMs = Date.now() - startMs;
    this.logger.warn(
      `Teambuilder chat hit max rounds (${MAX_TOOL_ROUNDS}, ${latencyMs}ms)`
    );
    return {
      message:
        'I ran out of steps. Please try a simpler request or continue the conversation.',
      slotUpdates,
    };
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    slotUpdates: TeamPokemonSlot[]
  ): Promise<unknown> {
    switch (name) {
      case 'lookupPokemon':
        return this.lookupPokemon(args.name as string);
      case 'lookupMoves':
        return this.lookupMoves(args.pokemon as string);
      case 'lookupItem':
        return this.lookupItem(args.name as string);
      case 'lookupAbility':
        return this.lookupAbility(args.name as string);
      case 'setTeamSlot': {
        const validated = await this.validateAndBuildSlot(
          args as SetTeamSlotArgs
        );
        const existingIdx = slotUpdates.findIndex(
          (s) => s.slot === validated.slot
        );
        if (existingIdx >= 0) {
          slotUpdates[existingIdx] = validated;
        } else {
          slotUpdates.push(validated);
        }
        return validated;
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  private async lookupPokemon(name: string) {
    const { Dex } = await import('pokemon-showdown');
    const species = Dex.species.get(name);
    if (!species.exists) {
      return { error: `Pokemon "${name}" not found` };
    }
    return {
      name: species.name,
      types: species.types,
      baseStats: species.baseStats,
      abilities: species.abilities as unknown as Record<string, string>,
      tier: species.tier,
      weightkg: species.weightkg,
    };
  }

  private async lookupMoves(pokemon: string) {
    const { Dex } = await import('pokemon-showdown');
    const species = Dex.species.get(pokemon);
    if (!species.exists) {
      return { error: `Pokemon "${pokemon}" not found` };
    }

    const learnsetData = Dex.species.getLearnsetData(species.id);
    const learnset = learnsetData.learnset || {};

    const moves = Object.keys(learnset)
      .map((moveId) => Dex.moves.get(moveId))
      .filter((move) => move?.exists)
      .map((move) => ({
        name: move.name,
        type: move.type,
        category: move.category,
        basePower: move.basePower || 0,
        accuracy: move.accuracy,
        pp: move.pp,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 80);

    return { pokemon: species.name, moves };
  }

  private async lookupItem(name: string) {
    const { Dex } = await import('pokemon-showdown');
    const item = Dex.items.get(name);
    if (!item.exists) {
      return { error: `Item "${name}" not found` };
    }
    return {
      name: item.name,
      desc: item.desc || item.shortDesc || 'No description available.',
    };
  }

  private async lookupAbility(name: string) {
    const { Dex } = await import('pokemon-showdown');
    const ability = Dex.abilities.get(name);
    if (!ability.exists) {
      return { error: `Ability "${name}" not found` };
    }
    return {
      name: ability.name,
      desc: ability.desc || ability.shortDesc || 'No description available.',
    };
  }

  private async validateAndBuildSlot(
    params: SetTeamSlotArgs
  ): Promise<TeamPokemonSlot> {
    const { Dex } = await import('pokemon-showdown');

    const species = Dex.species.get(params.species);
    if (!species.exists) {
      throw new Error(`Pokemon "${params.species}" not found`);
    }

    const validatedMoves = (params.moves as string[]).slice(0, 4).map((m) => {
      const move = Dex.moves.get(m);
      return move.exists ? move.name : m;
    });

    const slot: TeamPokemonSlot = {
      slot: Number(params.slot),
      species: species.name,
      moves: validatedMoves,
    };

    if (params.item) {
      const item = Dex.items.get(params.item as string);
      slot.item = item.exists ? item.name : (params.item as string);
    }

    if (params.ability) {
      const ability = Dex.abilities.get(params.ability as string);
      slot.ability = ability.exists ? ability.name : (params.ability as string);
    }

    if (params.nature) {
      const nature = Dex.natures.get(params.nature as string);
      slot.nature = nature.exists ? nature.name : (params.nature as string);
    }

    if (params.teraType) {
      slot.teraType = params.teraType as string;
    }

    if (params.evs && typeof params.evs === 'object') {
      const evs: StatSpread = {};
      const raw = params.evs as Record<string, number>;
      for (const key of STAT_KEYS) {
        if (raw[key] != null) {
          evs[key] = Math.min(252, Math.max(0, Math.floor(raw[key])));
        }
      }
      slot.evs = evs;
    }

    if (params.ivs && typeof params.ivs === 'object') {
      const ivs: StatSpread = {};
      const raw = params.ivs as Record<string, number>;
      for (const key of STAT_KEYS) {
        if (raw[key] != null) {
          ivs[key] = Math.min(31, Math.max(0, Math.floor(raw[key])));
        }
      }
      slot.ivs = ivs;
    }

    return slot;
  }
}

type SetTeamSlotArgs = Record<string, unknown> & {
  slot: number;
  species: string;
  moves: string[];
};
