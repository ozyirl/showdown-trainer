import { Injectable } from '@nestjs/common';
import type { Battle } from 'pokemon-showdown';

export interface BattleState {
  battleId: string;
  p1Pokemon: {
    name: string;
    hp: number;
    maxHp: number;
    status: string | null;
  };
  p2Pokemon: {
    name: string;
    hp: number;
    maxHp: number;
    status: string | null;
  };
  availableMoves: {
    name: string;
    type: string;
    power: number | null;
    pp: number;
    maxPp: number;
  }[];
  turnLog: string[];
  isEnded: boolean;
  winner: string | null;
  currentTurn: number;
  waitingForMove: boolean;
}

class BattleSession {
  id: string;
  battle: Battle;
  p1MoveChoice: string | null = null;
  p2MoveChoice: string | null = null;
  turnLog: string[] = [];
  currentTurn = 0;
  lastLogIndex = 0; // Track which logs we've already processed

  constructor(id: string, battle: Battle) {
    this.id = id;
    this.battle = battle;
  }

  hasP1Chosen(): boolean {
    return this.p1MoveChoice !== null;
  }

  hasP2Chosen(): boolean {
    return this.p2MoveChoice !== null;
  }

  bothPlayersChosen(): boolean {
    return this.hasP1Chosen() && this.hasP2Chosen();
  }

  clearChoices() {
    this.p1MoveChoice = null;
    this.p2MoveChoice = null;
  }
}

@Injectable()
export class BattleSessionManager {
  private sessions = new Map<string, BattleSession>();

  async createBattle(): Promise<BattleState> {
    const { Battle, Teams } = await import('pokemon-showdown');

    // Create teams
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

    const p1Team = Teams.pack([gengarSet]);
    const p2Team = Teams.pack([charizardSet]);

    const battle = new Battle({
      formatid: 'gen9customgame',
    });

    battle.setPlayer('p1', {
      name: 'Player 1',
      team: p1Team,
    });

    battle.setPlayer('p2', {
      name: 'Player 2',
      team: p2Team,
    });

    // Handle team preview
    battle.choose('p1', 'team 1');
    battle.choose('p2', 'team 1');

    const battleId = `battle_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;
    const session = new BattleSession(battleId, battle);

    // Set initial log index after team preview to skip setup logs
    session.lastLogIndex = battle.log.length;

    this.sessions.set(battleId, session);

    return this.getBattleState(battleId);
  }

  async submitMove(
    battleId: string,
    player: 'p1' | 'p2',
    moveIndex: number
  ): Promise<BattleState> {
    const session = this.sessions.get(battleId);
    if (!session) {
      throw new Error('Battle not found');
    }

    console.log(`\n=== submitMove called ===`);
    console.log(`Battle ID: ${battleId}`);
    console.log(`Player: ${player}, Move Index: ${moveIndex}`);
    console.log(`Current Turn: ${session.currentTurn}`);
    console.log(`Battle Ended: ${session.battle.ended}`);
    console.log(
      `P1 Choice: ${session.p1MoveChoice}, P2 Choice: ${session.p2MoveChoice}`
    );

    if (session.battle.ended) {
      console.log('Battle already ended, throwing error');
      throw new Error('Battle already ended');
    }

    const moveChoice = `move ${moveIndex}`;

    if (player === 'p1') {
      session.p1MoveChoice = moveChoice;
      console.log(`Set P1 move choice: ${moveChoice}`);
    } else {
      session.p2MoveChoice = moveChoice;
      console.log(`Set P2 move choice: ${moveChoice}`);
    }

    console.log(`Both players chosen? ${session.bothPlayersChosen()}`);

    // If both players have chosen, process the turn
    if (session.bothPlayersChosen()) {
      console.log('Both players have chosen, processing turn...');
      return await this.processTurn(battleId);
    }

    console.log('Waiting for other player, returning current state');
    return this.getBattleState(battleId);
  }

  private async processTurn(battleId: string): Promise<BattleState> {
    const session = this.sessions.get(battleId);
    if (!session) {
      throw new Error('Battle not found');
    }

    const { battle } = session;

    // Log the turn number for debugging
    console.log(`\n=== Processing turn ${session.currentTurn + 1} ===`);
    console.log(
      `P1 Move: ${session.p1MoveChoice}, P2 Move: ${session.p2MoveChoice}`
    );
    console.log(`Battle log length before: ${battle.log.length}`);
    console.log(`Last processed log index: ${session.lastLogIndex}`);
    console.log(`Battle ended before turn: ${battle.ended}`);

    // Check if battle is ready for moves BEFORE we submit
    console.log(
      `P1 has active request BEFORE: ${!!battle.sides[0]?.activeRequest}`
    );
    console.log(
      `P2 has active request BEFORE: ${!!battle.sides[1]?.activeRequest}`
    );

    const p1RequestState = battle.sides[0]?.requestState;
    const p2RequestState = battle.sides[1]?.requestState;
    if (p1RequestState !== 'move' || p2RequestState !== 'move') {
      console.log(
        `Battle not ready for moves (p1: ${p1RequestState}, p2: ${p2RequestState})`
      );
      return this.getBattleState(battleId);
    }

    // Submit both choices to the battle engine in one pass
    try {
      const p1Choice = session.p1MoveChoice;
      const p2Choice = session.p2MoveChoice;
      if (!p1Choice || !p2Choice) {
        throw new Error('Missing choices for one or both players');
      }

      battle.makeChoices(p1Choice, p2Choice);

      // Log battle state after choices
      console.log(
        `P1 has active request AFTER: ${!!battle.sides[0]?.activeRequest}`
      );
      console.log(
        `P2 has active request AFTER: ${!!battle.sides[1]?.activeRequest}`
      );
    } catch (error) {
      console.error('Error submitting moves:', error);
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('Not all choices done')) {
        return this.getBattleState(battleId);
      }

      // Clear choices on other errors to prevent stuck state
      session.clearChoices();
      throw error;
    }

    console.log(`Battle log length after: ${battle.log.length}`);
    console.log(`Battle ended after turn: ${battle.ended}`);

    // Check if the turn actually processed
    const logLengthDiff = battle.log.length - session.lastLogIndex;
    console.log(`New log entries added: ${logLengthDiff}`);

    if (logLengthDiff === 0 && !battle.ended) {
      console.error(
        '⚠️  WARNING: No new logs generated - turn did NOT process!'
      );
      console.error(
        'Pokemon Showdown queued the moves but did not execute them'
      );
      console.error('They will likely process on the next choose() call');

      // Moves can be queued without immediately processing. Keep choices
      // so the next call can retry the same decisions.
      return this.getBattleState(battleId);
    }

    // Capture NEW logs since last turn
    const newLogs = battle.log.slice(session.lastLogIndex);
    const formattedNewLogs = this.formatRecentLog(newLogs);

    // Append new logs to the session's turn log
    session.turnLog.push(...formattedNewLogs);

    // Update the last log index
    session.lastLogIndex = battle.log.length;

    console.log(
      `New logs captured: ${formattedNewLogs.length} formatted entries`
    );
    console.log(`Total turn log entries: ${session.turnLog.length}`);

    session.currentTurn++;

    // Clear choices after successful submission
    session.clearChoices();

    console.log(`Turn processed. Battle ended: ${battle.ended}`);

    return this.getBattleState(battleId);
  }

  getBattleState(battleId: string): BattleState {
    const session = this.sessions.get(battleId);
    if (!session) {
      throw new Error('Battle not found');
    }

    const { battle } = session;
    const p1Side = battle.sides[0];
    const p2Side = battle.sides[1];

    const p1Active = p1Side?.active?.[0];
    const p2Active = p2Side?.active?.[0];

    // Get available moves for p1
    const availableMoves =
      p1Active?.moveSlots?.map((move: any) => ({
        name: move.move,
        type: move.type || 'Normal',
        power: move.basePower || null,
        pp: move.pp,
        maxPp: move.maxpp,
      })) || [];

    // Return accumulated turn logs from the session
    return {
      battleId,
      p1Pokemon: {
        name: p1Active?.name || 'Unknown',
        hp: p1Active?.hp || 0,
        maxHp: p1Active?.maxhp || 100,
        status: p1Active?.status || null,
      },
      p2Pokemon: {
        name: p2Active?.name || 'Unknown',
        hp: p2Active?.hp || 0,
        maxHp: p2Active?.maxhp || 100,
        status: p2Active?.status || null,
      },
      availableMoves,
      turnLog: session.turnLog, // Return accumulated logs instead of re-formatting
      isEnded: battle.ended,
      winner: battle.winner || null,
      currentTurn: session.currentTurn,
      waitingForMove: !session.bothPlayersChosen(),
    };
  }

  private formatRecentLog(logs: string[]): string[] {
    const formatted: string[] = [];
    for (const line of logs) {
      if (!line || line.startsWith('|request|')) continue;

      const parts = line.split('|').filter(Boolean);
      if (parts.length === 0) continue;

      const cmd = parts[0];

      switch (cmd) {
        case 'move':
          formatted.push(
            `${parts[1]?.split(':')[1]?.trim()} used ${parts[2]}!`
          );
          break;
        case '-damage': {
          const pokemon = parts[1]?.split(':')[1]?.trim();
          if (parts[2]?.includes('faint')) {
            formatted.push(`${pokemon} fainted!`);
          } else {
            // Log HP changes
            const hpInfo = parts[2]?.split('/');
            if (hpInfo) {
              formatted.push(`${pokemon} HP: ${parts[2]}`);
            }
          }
          break;
        }
        case '-supereffective':
          formatted.push("It's super effective!");
          break;
        case '-resisted':
          formatted.push("It's not very effective...");
          break;
        case '-crit':
          formatted.push('Critical hit!');
          break;
        case '-miss':
          formatted.push(`${parts[1]?.split(':')[1]?.trim()}'s attack missed!`);
          break;
      }
    }
    return formatted;
  }

  deleteBattle(battleId: string) {
    this.sessions.delete(battleId);
  }
}
