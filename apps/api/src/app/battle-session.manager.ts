import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
  pendingPlayers: ('p1' | 'p2')[];
  phase: 'awaiting-moves' | 'resolving' | 'ended';
  lastAction: {
    player: 'p1' | 'p2';
    moveIndex: number;
    moveName: string | null;
    acceptedAt: number;
  } | null;
}

class BattleSession {
  id: string;
  battle: Battle;
  p1MoveChoice: string | null = null;
  p2MoveChoice: string | null = null;
  turnLog: string[] = [];
  currentTurn = 0;
  lastLogIndex = 0; // Track which logs we've already processed
  lastAction: BattleState['lastAction'] = null;

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
      throw new NotFoundException('Battle not found');
    }

    if (session.battle.ended) {
      throw new BadRequestException('Battle already ended');
    }

    const normalizedMoveIndex = this.normalizeMoveIndex(session, player, moveIndex);
    const moveChoice = `move ${normalizedMoveIndex}`;
    const moveName = this.getMoveName(session, player, normalizedMoveIndex);

    if (player === 'p1') {
      session.p1MoveChoice = moveChoice;
    } else {
      session.p2MoveChoice = moveChoice;
    }

    session.lastAction = {
      player,
      moveIndex: normalizedMoveIndex,
      moveName,
      acceptedAt: Date.now(),
    };

    // If both players have chosen, process the turn
    if (session.bothPlayersChosen()) {
      return await this.processTurn(battleId);
    }

    return this.getBattleState(battleId);
  }

  private async processTurn(battleId: string): Promise<BattleState> {
    const session = this.sessions.get(battleId);
    if (!session) {
      throw new NotFoundException('Battle not found');
    }

    const { battle } = session;

    const p1RequestState = battle.sides[0]?.requestState;
    const p2RequestState = battle.sides[1]?.requestState;
    if (p1RequestState !== 'move' || p2RequestState !== 'move') {
      // Clear stale queued choices so the next click does not accidentally
      // resolve a previous turn.
      session.clearChoices();
      return this.getBattleState(battleId);
    }

    // Submit both choices to the battle engine in one pass
    try {
      const p1Choice = session.p1MoveChoice;
      const p2Choice = session.p2MoveChoice;
      if (!p1Choice || !p2Choice) {
        throw new BadRequestException('Missing choices for one or both players');
      }

      battle.makeChoices(p1Choice, p2Choice);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('Not all choices done')) {
        session.clearChoices();
        return this.getBattleState(battleId);
      }

      // Clear choices on other errors to prevent stuck state
      session.clearChoices();
      throw error;
    }

    // Capture NEW logs since last turn
    const newLogs = battle.log.slice(session.lastLogIndex);
    const formattedNewLogs = this.formatRecentLog(newLogs);

    // Append new logs to the session's turn log
    session.turnLog.push(...formattedNewLogs);

    // Update the last log index
    session.lastLogIndex = battle.log.length;

    session.currentTurn = (battle as unknown as { turn?: number }).turn ?? session.currentTurn + 1;

    // Clear choices after successful submission
    session.clearChoices();

    return this.getBattleState(battleId);
  }

  getBattleState(battleId: string): BattleState {
    const session = this.sessions.get(battleId);
    if (!session) {
      throw new NotFoundException('Battle not found');
    }

    const { battle } = session;
    const p1Side = battle.sides[0];
    const p2Side = battle.sides[1];

    const p1Active = p1Side?.active?.[0];
    const p2Active = p2Side?.active?.[0];
    const p1RequestState = p1Side?.requestState;
    const p2RequestState = p2Side?.requestState;

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
    const pendingPlayers: ('p1' | 'p2')[] = [];
    if (p1RequestState === 'move' && !session.hasP1Chosen()) pendingPlayers.push('p1');
    if (p2RequestState === 'move' && !session.hasP2Chosen()) pendingPlayers.push('p2');

    const phase: BattleState['phase'] = battle.ended
      ? 'ended'
      : session.bothPlayersChosen()
        ? 'resolving'
        : 'awaiting-moves';

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
      waitingForMove: p1RequestState === 'move' && !session.hasP1Chosen(),
      pendingPlayers,
      phase,
      lastAction: session.lastAction,
    };
  }

  private normalizeMoveIndex(
    session: BattleSession,
    player: 'p1' | 'p2',
    moveIndex: number
  ): number {
    if (!Number.isInteger(moveIndex)) {
      throw new BadRequestException('moveIndex must be an integer');
    }

    const sideIndex = player === 'p1' ? 0 : 1;
    const requestState = session.battle.sides[sideIndex]?.requestState;
    if (requestState !== 'move') {
      throw new BadRequestException(
        `${player} is not currently allowed to choose a move`
      );
    }

    const active = session.battle.sides[sideIndex]?.active?.[0] as
      | { moveSlots?: Array<{ move: string; disabled?: boolean }> }
      | undefined;
    const moveSlots = active?.moveSlots ?? [];
    if (moveSlots.length === 0) {
      throw new BadRequestException('No moves available for active Pokemon');
    }

    const normalized = moveIndex >= 1 ? moveIndex : moveIndex + 1;
    if (normalized < 1 || normalized > moveSlots.length) {
      throw new BadRequestException(
        `moveIndex out of range. Expected 0-${moveSlots.length - 1} or 1-${moveSlots.length}`
      );
    }

    const selected = moveSlots[normalized - 1];
    if (selected?.disabled) {
      throw new BadRequestException(`${selected.move} is currently disabled`);
    }

    return normalized;
  }

  private getMoveName(
    session: BattleSession,
    player: 'p1' | 'p2',
    moveIndex: number
  ): string | null {
    const sideIndex = player === 'p1' ? 0 : 1;
    const active = session.battle.sides[sideIndex]?.active?.[0] as
      | { moveSlots?: Array<{ move: string }> }
      | undefined;

    return active?.moveSlots?.[moveIndex - 1]?.move ?? null;
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
