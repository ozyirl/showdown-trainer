import { BadRequestException, Injectable } from '@nestjs/common';

export interface BattleLog {
  rawLog: string[];
  formattedLog: string;
  winner: string | null;
  turns: number;
}

export interface PokemonListItem {
  id: string;
  name: string;
  num: number;
  types: string[];
  tier?: string;
  baseSpecies: string;
  forme: string;
}

export interface PokemonMoveItem {
  id: string;
  name: string;
  type: string;
  category: string;
  basePower: number;
  accuracy: number | true;
  pp: number;
  priority: number;
  target: string;
}

export interface StartBattleRequest {
  p1Pokemon?: string;
  p2Pokemon?: string;
  p1Moves?: string[];
  p2Moves?: string[];
  level?: number;
  formatid?: string;
}

interface BuiltPokemonSet {
  set: PokemonSetLike;
  speciesName: string;
  moves: string[];
}

interface PokemonSetLike {
  name: string;
  species: string;
  ability: string;
  item: string;
  moves: string[];
  nature: string;
  level: number;
  gender: 'M' | 'F' | 'N';
  ivs: Record<string, number>;
  evs: Record<string, number>;
}

interface DexSpeciesLike {
  id: string;
  name: string;
  num: number;
  exists: boolean;
  types: string[];
  tier?: string;
  baseSpecies: string;
  forme?: string;
  battleOnly?: string | string[];
  isNonstandard?: string | null;
  baseStats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
  abilities: unknown;
  weightkg?: number;
  gender?: 'M' | 'F' | 'N';
}

interface DexMoveLike {
  id: string;
  name: string;
  exists: boolean;
  type: string;
  category: string;
  basePower: number;
  accuracy: number | true;
  pp: number;
  priority?: number;
  target: string;
}

interface BattleMoveSlotLike {
  disabled?: boolean | string;
  pp: number;
}

interface BattleActiveLike {
  moveSlots?: BattleMoveSlotLike[];
}

interface BattleSideLike {
  active?: BattleActiveLike[];
}

interface BattleLike {
  sides?: BattleSideLike[];
}

@Injectable()
export class BattleService {
  /**
   * Simulates a 1v1 battle between two selectable Pokemon (defaults to Gengar vs Charizard)
   */
  async simulateBattle(config?: StartBattleRequest): Promise<BattleLog> {
    const { Battle, Teams } = await import('pokemon-showdown');

    const p1Built = await this.buildPokemonSet({
      speciesName: config?.p1Pokemon ?? 'Gengar',
      selectedMoves: config?.p1Moves,
      level: config?.level,
    });
    const p2Built = await this.buildPokemonSet({
      speciesName: config?.p2Pokemon ?? 'Charizard',
      selectedMoves: config?.p2Moves,
      level: config?.level,
    });

    const p1Team = Teams.pack([p1Built.set]);
    const p2Team = Teams.pack([p2Built.set]);

    const battle = new Battle({
      formatid: config?.formatid ?? 'gen9customgame',
    });

    battle.setPlayer('p1', {
      name: `${p1Built.speciesName} Trainer`,
      team: p1Team,
    });

    battle.setPlayer('p2', {
      name: `${p2Built.speciesName} Trainer`,
      team: p2Team,
    });

    battle.choose('p1', 'team 1');
    battle.choose('p2', 'team 1');

    let turn = 0;
    const maxTurns = 40;

    while (!battle.ended && turn < maxTurns) {
      const p1Moves = this.getAvailableMoves(battle, 'p1');
      const p2Moves = this.getAvailableMoves(battle, 'p2');

      if (p1Moves.length > 0 && p2Moves.length > 0) {
        const p1Move = p1Moves[Math.floor(Math.random() * p1Moves.length)];
        const p2Move = p2Moves[Math.floor(Math.random() * p2Moves.length)];
        battle.choose('p1', `move ${p1Move}`);
        battle.choose('p2', `move ${p2Move}`);
      } else {
        battle.choose('p1', 'default');
        battle.choose('p2', 'default');
      }

      turn++;
    }

    const rawLog = battle.log;
    const formattedLog = this.formatBattleLog(rawLog);
    const winner = battle.winner || 'Draw';

    return {
      rawLog,
      formattedLog,
      winner,
      turns: turn,
    };
  }

  async listPokemon(query?: string, limit = 50): Promise<PokemonListItem[]> {
    const { Dex } = await import('pokemon-showdown');
    const q = (query || '').trim().toLowerCase();
    const max = this.normalizeLimit(limit, 1, 200);

    return Dex.species
      .all()
      .filter((species: DexSpeciesLike) => {
        if (!species?.exists) return false;
        if (!species.name || species.num <= 0) return false;
        if (species.isNonstandard && species.isNonstandard !== null) return false;
        if (species.battleOnly) return false;
        if (q && !species.name.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a: DexSpeciesLike, b: DexSpeciesLike) => a.name.localeCompare(b.name))
      .slice(0, max)
      .map((species: DexSpeciesLike) => ({
        id: species.id,
        name: species.name,
        num: species.num,
        types: species.types,
        tier: species.tier,
        baseSpecies: species.baseSpecies,
        forme: species.forme || '',
      }));
  }

  async getPokemonMoves(
    pokemonName: string,
    limit = 200
  ): Promise<{ pokemon: string; moves: PokemonMoveItem[]; recommendedMoves: string[] }> {
    const { Dex } = await import('pokemon-showdown');
    const species = Dex.species.get(pokemonName);

    if (!species.exists) {
      throw new BadRequestException(`Pokemon "${pokemonName}" not found`);
    }

    const learnsetData = Dex.species.getLearnsetData(species.id);
    const learnset = learnsetData.learnset || {};
    const max = this.normalizeLimit(limit, 1, 400);

    const moves = Object.keys(learnset)
      .map((moveId) => Dex.moves.get(moveId))
      .filter((move: DexMoveLike) => move?.exists)
      .map((move: DexMoveLike) => ({
        id: move.id,
        name: move.name,
        type: move.type,
        category: move.category,
        basePower: move.basePower || 0,
        accuracy: move.accuracy,
        pp: move.pp,
        priority: move.priority || 0,
        target: move.target,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, max);

    const recommendedMoves = this.pickRecommendedMoves(moves, {
      types: species.types,
      baseStats: species.baseStats,
    }).map((move) => move.name);

    return {
      pokemon: species.name,
      moves,
      recommendedMoves,
    };
  }

  async getPokemonInfo(pokemonName: string): Promise<{
    error?: string;
    name?: string;
    num?: number;
    types?: string[];
    baseStats?: {
      hp: number;
      atk: number;
      def: number;
      spa: number;
      spd: number;
      spe: number;
    };
    abilities?: Record<string, string>;
    weightkg?: number;
    tier?: string;
  }> {
    const { Dex } = await import('pokemon-showdown');
    const species = Dex.species.get(pokemonName);

    if (!species.exists) {
      return {
        error: `Pokémon "${pokemonName}" not found`,
      };
    }

    return {
      name: species.name,
      num: species.num,
      types: species.types,
      baseStats: species.baseStats,
      abilities: species.abilities as unknown as Record<string, string>,
      weightkg: species.weightkg,
      tier: species.tier,
    };
  }

  async buildPokemonSet(input: {
    speciesName: string;
    selectedMoves?: string[];
    level?: number;
  }): Promise<BuiltPokemonSet> {
    const { Dex } = await import('pokemon-showdown');
    const species = Dex.species.get(input.speciesName);

    if (!species.exists) {
      throw new BadRequestException(`Pokemon "${input.speciesName}" not found`);
    }

    const legalMoves = await this.getPokemonMoves(species.name, 1000);
    const legalById = new Map(legalMoves.moves.map((move) => [move.id, move.name]));

    const requestedMoves = (input.selectedMoves || [])
      .map((move) => Dex.moves.get(move))
      .filter((move: DexMoveLike) => move?.exists);

    const dedupRequested = Array.from(
      new Map(requestedMoves.map((move: DexMoveLike) => [move.id, move])).values()
    );

    for (const move of dedupRequested) {
      if (!legalById.has(move.id)) {
        throw new BadRequestException(
          `${species.name} cannot learn ${move.name} in the current Showdown dex`
        );
      }
    }

    const fallbackMoves = this.pickRecommendedMoves(legalMoves.moves, {
      types: species.types,
      baseStats: species.baseStats,
    });
    const finalMoveNames = [
      ...dedupRequested.map((move: DexMoveLike) => move.name),
      ...fallbackMoves
        .filter((move) => !dedupRequested.some((m: DexMoveLike) => m.id === move.id))
        .map((move) => move.name),
    ].slice(0, 4);

    if (finalMoveNames.length === 0) {
      throw new BadRequestException(`${species.name} has no available moves`);
    }

    const abilities = species.abilities as unknown as Record<string, string>;
    const ability = abilities['0'] || Object.values(abilities)[0] || 'None';
    const level = input.level && Number.isFinite(input.level)
      ? Math.max(1, Math.min(100, Math.floor(input.level)))
      : 50;

    const set = {
      name: species.name,
      species: species.name,
      ability,
      item: '',
      moves: finalMoveNames,
      nature: 'Hardy',
      level,
      gender: (species.gender || 'N') as 'M' | 'F' | 'N',
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      evs: { hp: 84, atk: 84, def: 84, spa: 84, spd: 84, spe: 84 },
    };

    return {
      set,
      speciesName: species.name,
      moves: finalMoveNames,
    };
  }

  private pickRecommendedMoves(
    moves: PokemonMoveItem[],
    context: {
      types: string[];
      baseStats?: { atk: number; spa: number };
    }
  ): PokemonMoveItem[] {
    const unique = Array.from(new Map(moves.map((move) => [move.id, move])).values());
    const typeSet = new Set(context.types || []);
    const atk = context.baseStats?.atk ?? 80;
    const spa = context.baseStats?.spa ?? 80;
    const preferredCategory = atk >= spa ? 'Physical' : 'Special';

    const scored = unique
      .map((move) => ({
        move,
        score: this.scoreMove(move, { typeSet, preferredCategory }),
      }))
      .sort((a, b) => b.score - a.score || a.move.name.localeCompare(b.move.name));

    const chosen: PokemonMoveItem[] = [];
    const usedIds = new Set<string>();

    const pick = (predicate: (move: PokemonMoveItem) => boolean) => {
      const found = scored.find(({ move }) => !usedIds.has(move.id) && predicate(move));
      if (!found) return;
      usedIds.add(found.move.id);
      chosen.push(found.move);
    };

    // Prefer one strong STAB move in the preferred attacking category
    pick((move) =>
      move.basePower > 0 &&
      move.category === preferredCategory &&
      typeSet.has(move.type)
    );

    // Add coverage move of a different type
    pick((move) =>
      move.basePower > 0 &&
      (!chosen[0] || move.type !== chosen[0].type)
    );

    // Add best setup/status/support move if available
    pick((move) => move.basePower === 0 && this.isUsefulStatusMove(move));

    // Fill remaining slots with best overall moves, avoiding too much duplicate type spam
    while (chosen.length < 4) {
      const currentTypes = new Set(chosen.map((m) => m.type));
      const found =
        scored.find(({ move }) =>
          !usedIds.has(move.id) &&
          (move.basePower === 0 || !currentTypes.has(move.type))
        ) ||
        scored.find(({ move }) => !usedIds.has(move.id));

      if (!found) break;
      usedIds.add(found.move.id);
      chosen.push(found.move);
    }

    return chosen.slice(0, 4);
  }

  private scoreMove(
    move: PokemonMoveItem,
    context: { typeSet: Set<string>; preferredCategory: string }
  ): number {
    const isDamaging = move.basePower > 0;
    const accuracy =
      move.accuracy === true ? 100 : typeof move.accuracy === 'number' ? move.accuracy : 100;
    const stabBonus = context.typeSet.has(move.type) ? 20 : 0;
    const categoryBonus = move.category === context.preferredCategory ? 10 : 0;
    const priorityBonus = Math.max(0, move.priority) * 8;
    const accuracyFactor = Math.max(0.55, accuracy / 100);

    if (isDamaging) {
      return (
        move.basePower * accuracyFactor +
        stabBonus +
        categoryBonus +
        priorityBonus +
        Math.min(move.pp, 16) * 0.2
      );
    }

    return this.isUsefulStatusMove(move) ? 35 + stabBonus + priorityBonus : 5;
  }

  private isUsefulStatusMove(move: PokemonMoveItem): boolean {
    const id = move.id;
    return [
      'protect',
      'substitute',
      'recover',
      'roost',
      'slackoff',
      'softboiled',
      'swordsdance',
      'nastyplot',
      'calmmind',
      'dragondance',
      'bulkup',
      'agility',
      'thunderwave',
      'toxic',
      'willowisp',
      'stealthrock',
      'spikes',
      'rapidspin',
      'defog',
      'taunt',
      'encore',
      'leechseed',
    ].includes(id);
  }

  private normalizeLimit(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return max;
    return Math.max(min, Math.min(max, Math.floor(value)));
  }

  /**
   * Format battle log into human-readable text
   */
  private formatBattleLog(rawLog: string[]): string {
    const lines: string[] = [];
    let currentTurn = 0;

    for (const line of rawLog) {
      if (
        !line ||
        line.startsWith('|request|') ||
        line.startsWith('|inactive|')
      ) {
        continue;
      }

      const parts = line.split('|').filter(Boolean);
      if (parts.length === 0) continue;

      const cmd = parts[0];

      switch (cmd) {
        case 'player':
          lines.push(`${parts[2]} joined as ${parts[1]}!`);
          break;
        case 'tier':
          lines.push(`Format: ${parts[1]}`);
          lines.push('---');
          break;
        case 'start':
          lines.push('Battle started!');
          lines.push('');
          break;
        case 'switch':
        case 'drag': {
          const [, pokemon] = parts;
          const name = pokemon.split(':')[1].trim();
          lines.push(`Go! ${name}!`);
          break;
        }
        case 'turn': {
          currentTurn = parseInt(parts[1]);
          lines.push('');
          lines.push(`=== Turn ${currentTurn} ===`);
          break;
        }
        case 'move':
          lines.push(`${parts[1].split(':')[1].trim()} used ${parts[2]}!`);
          break;
        case '-damage': {
          const damagedPokemon = parts[1].split(':')[1].trim();
          const hp = parts[2];
          if (hp.includes('faint')) {
            lines.push(`${damagedPokemon} fainted!`);
          } else {
            const hpMatch = hp.match(/(\d+)\/(\d+)/);
            if (hpMatch) {
              const currentHp = parseInt(hpMatch[1]);
              const maxHp = parseInt(hpMatch[2]);
              const percentage = ((currentHp / maxHp) * 100).toFixed(1);
              lines.push(`(${damagedPokemon} has ${percentage}% HP remaining)`);
            }
          }
          break;
        }
        case '-heal':
          lines.push(`${parts[1].split(':')[1].trim()} restored HP!`);
          break;
        case '-status':
          lines.push(`${parts[1].split(':')[1].trim()} was ${parts[2]}!`);
          break;
        case '-boost':
        case '-unboost': {
          const statPokemon = parts[1].split(':')[1].trim();
          const stat = parts[2];
          const change = cmd === '-boost' ? 'rose' : 'fell';
          lines.push(`${statPokemon}'s ${stat} ${change}!`);
          break;
        }
        case '-supereffective':
          lines.push("It's super effective!");
          break;
        case '-resisted':
          lines.push("It's not very effective...");
          break;
        case '-crit':
          lines.push('A critical hit!');
          break;
        case '-miss':
          lines.push(`${parts[1].split(':')[1].trim()}'s attack missed!`);
          break;
        case '-fail':
          lines.push('But it failed!');
          break;
        case '-immune':
          lines.push(`It doesn't affect ${parts[1].split(':')[1].trim()}...`);
          break;
        case 'faint':
          lines.push(`${parts[1].split(':')[1].trim()} fainted!`);
          break;
        case 'win':
          lines.push('');
          lines.push('---');
          lines.push(`${parts[1]} won the battle!`);
          break;
        case 'tie':
          lines.push('');
          lines.push('---');
          lines.push('The battle ended in a tie!');
          break;
        case '-weather':
          if (parts[1] !== 'none') {
            lines.push(`The weather changed to ${parts[1]}!`);
          }
          break;
        case '-ability':
          lines.push(`[${parts[1].split(':')[1].trim()}'s ${parts[2]}]`);
          break;
        case '-item':
          lines.push(`${parts[1].split(':')[1].trim()} has ${parts[2]}!`);
          break;
        default:
          break;
      }
    }

    return lines.join('\n');
  }

  /**
   * Get available move slots for a player from active request state.
   */
  private getAvailableMoves(battle: BattleLike, playerId: string): number[] {
    try {
      const sideIndex = playerId === 'p1' ? 0 : 1;
      const active = battle?.sides?.[sideIndex]?.active?.[0];
      const moveSlots = active?.moveSlots || [];

      return moveSlots
        .map((move: BattleMoveSlotLike, index: number) => ({ move, index: index + 1 }))
        .filter(({ move }) => !move.disabled && move.pp > 0)
        .map(({ index }) => index);
    } catch {
      return [1, 2, 3, 4];
    }
  }
}
