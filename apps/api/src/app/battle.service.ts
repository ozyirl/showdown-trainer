import { Injectable } from '@nestjs/common';

export interface BattleLog {
  rawLog: string[];
  formattedLog: string;
  winner: string | null;
  turns: number;
}

@Injectable()
export class BattleService {
  /**
   * Simulates a 1v1 battle between Gengar and Charizard
   * Based on: https://github.com/smogon/pokemon-showdown/blob/master/sim/README.md
   */
  async simulateBattle(): Promise<BattleLog> {
    // Dynamic import to avoid issues
    const { Battle, Teams } = await import('pokemon-showdown');

    // Create teams using the Teams API
    const gengarSet = {
      name: 'Gengar',
      species: 'Gengar',
      item: 'Life Orb',
      ability: 'Cursed Body',
      moves: ['Shadow Ball', 'Sludge Bomb', 'Focus Blast', 'Thunderbolt'],
      nature: 'Timid',
      evs: { hp: 4, spa: 252, spe: 252 },
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      level: 50,
      gender: 'M',
    };

    const charizardSet = {
      name: 'Charizard',
      species: 'Charizard',
      item: 'Choice Specs',
      ability: 'Blaze',
      moves: ['Fire Blast', 'Air Slash', 'Dragon Pulse', 'Heat Wave'],
      nature: 'Timid',
      evs: { hp: 4, spa: 252, spe: 252 },
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      level: 50,
      gender: 'F',
    };

    // Pack teams into showdown format
    const p1Team = Teams.pack([gengarSet]);
    const p2Team = Teams.pack([charizardSet]);

    // Create battle
    const battle = new Battle({
      formatid: 'gen9ou',
    });

    // Set up players (battle starts automatically after both players are set)
    battle.setPlayer('p1', {
      name: 'Gengar Trainer',
      team: p1Team,
    });

    battle.setPlayer('p2', {
      name: 'Charizard Trainer',
      team: p2Team,
    });

    // Handle team preview (both players select team 1 - we only have 1 pokemon each)
    battle.choose('p1', 'team 1');
    battle.choose('p2', 'team 1');

    // Simulate turns with random moves
    let turn = 0;
    const maxTurns = 20;

    while (!battle.ended && turn < maxTurns) {
      // Get available moves for each player
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

    // Get the battle log (this contains all the protocol messages)
    const rawLog = battle.log;

    // Format the log for human readability
    const formattedLog = this.formatBattleLog(rawLog);

    // Get winner
    const winner = battle.winner || 'Draw';

    return {
      rawLog,
      formattedLog,
      winner,
      turns: turn,
    };
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
        continue; // Skip internal messages
      }

      const parts = line.split('|').filter(Boolean);
      if (parts.length === 0) continue;

      const cmd = parts[0];

      switch (cmd) {
        case 'player':
          lines.push(`${parts[2]} joined as ${parts[1]}!`);
          break;

        case 'teamsize':
          break; // Skip

        case 'gametype':
          break; // Skip

        case 'gen':
          break; // Skip

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

        case 'move': {
          const attacker = parts[1].split(':')[1].trim();
          const move = parts[2];
          const target = parts[3]?.split(':')[1]?.trim();
          if (target) {
            lines.push(`${attacker} used ${move}!`);
          } else {
            lines.push(`${attacker} used ${move}!`);
          }
          break;
        }

        case '-damage': {
          const damagedPokemon = parts[1].split(':')[1].trim();
          const hp = parts[2];
          if (hp.includes('faint')) {
            lines.push(`${damagedPokemon} fainted!`);
          } else {
            // Parse HP to show percentage if available
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

        case '-heal': {
          const healedPokemon = parts[1].split(':')[1].trim();
          lines.push(`${healedPokemon} restored HP!`);
          break;
        }

        case '-status': {
          const statusPokemon = parts[1].split(':')[1].trim();
          const status = parts[2];
          lines.push(`${statusPokemon} was ${status}!`);
          break;
        }

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

        case '-miss': {
          const misser = parts[1].split(':')[1].trim();
          lines.push(`${misser}'s attack missed!`);
          break;
        }

        case '-fail':
          lines.push('But it failed!');
          break;

        case '-immune': {
          const immunePokemon = parts[1].split(':')[1].trim();
          lines.push(`It doesn't affect ${immunePokemon}...`);
          break;
        }

        case 'faint': {
          const faintedPokemon = parts[1].split(':')[1].trim();
          lines.push(`${faintedPokemon} fainted!`);
          break;
        }

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

        case '-weather': {
          const weather = parts[1];
          if (weather !== 'none') {
            lines.push(`The weather changed to ${weather}!`);
          }
          break;
        }

        case '-ability': {
          const abilityPokemon = parts[1].split(':')[1].trim();
          const ability = parts[2];
          lines.push(`[${abilityPokemon}'s ${ability}]`);
          break;
        }

        case '-item': {
          const itemPokemon = parts[1].split(':')[1].trim();
          const item = parts[2];
          lines.push(`${itemPokemon} has ${item}!`);
          break;
        }

        default:
          // Skip unknown commands
          break;
      }
    }

    return lines.join('\n');
  }

  /**
   * Get available moves for a player
   * Returns move indices 1-4 (simplified for random selection)
   */
  private getAvailableMoves(battle: any, playerId: string): number[] {
    try {
      // For now, return all 4 move slots
      // The battle engine will handle invalid moves
      return [1, 2, 3, 4];
    } catch (error) {
      console.error('Error getting moves:', error);
      return [1, 2, 3, 4];
    }
  }

  /**
   * Get information about Pokémon (using the Dex)
   */
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
}
