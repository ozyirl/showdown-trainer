import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Battle } from 'pokemon-showdown';
import { BattleService, StartBattleRequest } from './battle.service';
import {
  CpuMoveAiService,
  type CpuMoveDecisionResult,
} from './cpu-move-ai.service';
import type { ShowdownRequest } from './battle.service';

export interface BattleState {
  battleId: string;
  p1Pokemon: {
    name: string;
    hp: number;
    maxHp: number;
    hpPercent: number;
    status: string | null;
  };
  p2Pokemon: {
    name: string;
    hp: number;
    maxHp: number;
    hpPercent: number;
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
  lastTurnEvents: BattleTurnEvent[];
  lastCpuDecision: {
    moveIndex: number;
    moveName: string | null;
    source: 'model' | 'fallback';
    modelId: string;
    latencyMs: number;
    rawResponse?: string;
    error?: string;
    turn: number;
  } | null;
}

export interface BattleTurnEvent {
  kind:
    | 'turn'
    | 'move'
    | 'damage'
    | 'heal'
    | 'status'
    | 'effectiveness'
    | 'crit'
    | 'miss'
    | 'fail'
    | 'cant'
    | 'prepare'
    | 'activate'
    | 'faint'
    | 'win';
  text: string;
  actor?: string;
  target?: string;
  moveName?: string;
  hpPercent?: number;
  status?: string | null;
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
  lastTurnEvents: BattleTurnEvent[] = [];
  lastCpuDecision: BattleState['lastCpuDecision'] = null;
  isResolving = false;

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

  constructor(
    private readonly battleService: BattleService,
    private readonly cpuMoveAiService: CpuMoveAiService
  ) {}

  async createBattle(config?: StartBattleRequest): Promise<BattleState> {
    const { Battle, Teams } = await import('pokemon-showdown');

    const p1Built = await this.battleService.buildPokemonSet({
      speciesName: config?.p1Pokemon ?? 'Gengar',
      selectedMoves: config?.p1Moves,
      level: config?.level,
    });
    const p2Built = await this.battleService.buildPokemonSet({
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
      name: `Player 1 (${p1Built.speciesName})`,
      team: p1Team,
    });

    battle.setPlayer('p2', {
      name: `CPU (${p2Built.speciesName})`,
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
    this.battleService.registerBattleSession(battleId, battle as never, session.lastLogIndex);

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

    if (session.isResolving) {
      throw new ConflictException(
        'Turn is already resolving. Wait for CPU move / turn result.'
      );
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

    try {
      if (player === 'p1' && this.isCpuAiEnabled() && !session.hasP2Chosen()) {
        session.isResolving = true;
        await this.tryChooseCpuMove(session);
      }

      // If both players have chosen, process the turn
      if (session.bothPlayersChosen()) {
        session.isResolving = true;
        return await this.processTurn(battleId);
      }

      return this.getBattleState(battleId);
    } finally {
      // Keep locked only if both choices remain queued and caller should not re-submit.
      // In normal completion paths processTurn clears choices, so unlock.
      if (!session.bothPlayersChosen()) {
        session.isResolving = false;
      }
    }
  }

  private async processTurn(battleId: string): Promise<BattleState> {
    const session = this.sessions.get(battleId);
    if (!session) {
      throw new NotFoundException('Battle not found');
    }

    const { battle } = session;

    // Submit both choices for the same turn; Showdown resolves order and
    // handles request types (move/switch/default) internally.
    try {
      const p1Choice = session.p1MoveChoice;
      const p2Choice = session.p2MoveChoice;
      if (!p1Choice || !p2Choice) {
        throw new BadRequestException('Missing choices for one or both players');
      }

      this.battleService.step(battleId, p1Choice, p2Choice);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('Invalid move choice')) {
        // Recharge / lock / forced-choice edge cases can make a previously
        // prepared CPU move invalid by the time we submit. Let Showdown auto-resolve.
        try {
          const p1Choice = session.p1MoveChoice;
          if (p1Choice) {
            this.battleService.step(battleId, p1Choice, 'default');
          }
        } catch {
          // Fall through to standard error handling below.
        }
      }
      if (message.includes('Not all choices done')) {
        session.clearChoices();
        session.isResolving = false;
        return this.getBattleState(battleId);
      }

      // Clear choices on other errors to prevent stuck state
      session.clearChoices();
      session.isResolving = false;
      throw error;
    }

    // Capture NEW logs since last turn
    const newLogs = battle.log.slice(session.lastLogIndex);
    const formattedNewLogs = this.formatRecentLog(newLogs);
    session.lastTurnEvents = this.buildTurnEvents(newLogs);

    // Append new logs to the session's turn log
    session.turnLog.push(...formattedNewLogs);

    // Update the last log index
    session.lastLogIndex = battle.log.length;

    session.currentTurn = (battle as unknown as { turn?: number }).turn ?? session.currentTurn + 1;

    // Clear choices after successful submission
    session.clearChoices();
    session.isResolving = false;

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
      p1Active?.moveSlots?.map((move: { id?: string; move: string; pp: number; maxpp: number }) => {
        const battleWithDex = battle as unknown as {
          dex?: { moves?: { get?: (idOrName: string) => { type?: string; basePower?: number } | undefined } };
        };
        const dexMove = battleWithDex.dex?.moves?.get?.(move.id || move.move);
        return {
          name: move.move,
          type: dexMove?.type || 'Normal',
          power: typeof dexMove?.basePower === 'number' && dexMove.basePower > 0
            ? dexMove.basePower
            : null,
          pp: move.pp,
          maxPp: move.maxpp,
        };
      }) || [];

    // Return accumulated turn logs from the session
    const pendingPlayers: ('p1' | 'p2')[] = [];
    if (p1RequestState === 'move' && !session.hasP1Chosen()) pendingPlayers.push('p1');
    if (p2RequestState === 'move' && !session.hasP2Chosen()) pendingPlayers.push('p2');

    const phase: BattleState['phase'] = battle.ended
      ? 'ended'
      : session.bothPlayersChosen()
        ? 'resolving'
        : session.isResolving
          ? 'resolving'
        : 'awaiting-moves';

    return {
      battleId,
      p1Pokemon: {
        name: p1Active?.name || 'Unknown',
        hp: p1Active?.hp || 0,
        maxHp: p1Active?.maxhp || 100,
        hpPercent: this.toHpPercent(p1Active?.hp, p1Active?.maxhp),
        status: p1Active?.status || null,
      },
      p2Pokemon: {
        name: p2Active?.name || 'Unknown',
        hp: p2Active?.hp || 0,
        maxHp: p2Active?.maxhp || 100,
        hpPercent: this.toHpPercent(p2Active?.hp, p2Active?.maxhp),
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
      lastTurnEvents: session.lastTurnEvents,
      lastCpuDecision: session.lastCpuDecision,
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

    // Align validation with BattleService.step(), which uses the latest
    // Showdown request JSON (this can differ from moveSlots during recharge/locks).
    try {
      const requests = this.battleService.getRequests(session.id);
      const request = player === 'p1' ? requests.p1 : requests.p2;
      const legalMoveChoices = this.getLegalMoveChoicesFromRequest(request);
      if (legalMoveChoices.length > 0) {
        const requestedChoice = `move ${normalized}`;
        if (!legalMoveChoices.includes(requestedChoice)) {
          // If Showdown only allows one move (common for recharge/locks), auto-coerce.
          if (legalMoveChoices.length === 1) {
            const onlyLegal = legalMoveChoices[0];
            const match = onlyLegal.match(/^move\s+(\d+)$/i);
            if (match) {
              return Number(match[1]);
            }
          }

          throw new BadRequestException(
            `Invalid move choice "${requestedChoice}". Legal choices: ${legalMoveChoices.join(', ')}`
          );
        }
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      // Ignore request lookup issues and fall back to moveSlots validation.
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
        case '-fail':
          formatted.push('But it failed!');
          break;
        case 'cant': {
          const pokemon = parts[1]?.split(':')[1]?.trim();
          const reason = parts[2] || 'could not move';
          formatted.push(`${pokemon} couldn't move (${reason}).`);
          break;
        }
        case '-prepare': {
          const pokemon = parts[1]?.split(':')[1]?.trim();
          const moveName = parts[2];
          formatted.push(`${pokemon} is preparing ${moveName}!`);
          break;
        }
        case '-activate': {
          const pokemon = parts[1]?.split(':')[1]?.trim();
          const effect = parts[2];
          if (effect) {
            formatted.push(`${pokemon}: ${effect}`);
          }
          break;
        }
      }
    }
    return formatted;
  }

  deleteBattle(battleId: string) {
    this.sessions.delete(battleId);
    this.battleService.unregisterBattleSession(battleId);
  }

  private toHpPercent(hp?: number, maxHp?: number): number {
    if (!maxHp || maxHp <= 0 || typeof hp !== 'number') return 0;
    return Math.max(0, Math.min(100, Math.round((hp / maxHp) * 100)));
  }

  private buildTurnEvents(logs: string[]): BattleTurnEvent[] {
    const events: BattleTurnEvent[] = [];

    for (const line of logs) {
      if (!line || line.startsWith('|request|')) continue;
      const parts = line.split('|').filter(Boolean);
      if (parts.length === 0) continue;

      const cmd = parts[0];
      switch (cmd) {
        case 'turn':
          events.push({
            kind: 'turn',
            text: `Turn ${parts[1]}`,
          });
          break;
        case 'move': {
          const actor = parts[1]?.split(':')[1]?.trim();
          const moveName = parts[2];
          events.push({
            kind: 'move',
            text: `${actor} used ${moveName}!`,
            actor,
            moveName,
            target: parts[3]?.split(':')[1]?.trim(),
          });
          break;
        }
        case '-damage': {
          const target = parts[1]?.split(':')[1]?.trim();
          const hpState = parts[2] || '';
          const parsed = this.parseHpProtocolPercent(hpState);
          events.push({
            kind: 'damage',
            text: parsed.fainted ? `${target} fainted!` : `${target} HP ${parsed.hpPercent}%`,
            target,
            hpPercent: parsed.hpPercent ?? undefined,
            status: parsed.status,
          });
          break;
        }
        case '-heal': {
          const target = parts[1]?.split(':')[1]?.trim();
          const parsed = this.parseHpProtocolPercent(parts[2] || '');
          events.push({
            kind: 'heal',
            text: parsed.hpPercent !== null ? `${target} healed to ${parsed.hpPercent}%` : `${target} healed!`,
            target,
            hpPercent: parsed.hpPercent ?? undefined,
            status: parsed.status,
          });
          break;
        }
        case '-status': {
          const target = parts[1]?.split(':')[1]?.trim();
          const status = parts[2] || null;
          events.push({
            kind: 'status',
            text: `${target} was ${status}!`,
            target,
            status,
          });
          break;
        }
        case '-supereffective':
          events.push({ kind: 'effectiveness', text: "It's super effective!" });
          break;
        case '-resisted':
          events.push({ kind: 'effectiveness', text: "It's not very effective..." });
          break;
        case '-crit':
          events.push({ kind: 'crit', text: 'Critical hit!' });
          break;
        case '-miss':
          events.push({
            kind: 'miss',
            text: `${parts[1]?.split(':')[1]?.trim()}'s attack missed!`,
            actor: parts[1]?.split(':')[1]?.trim(),
          });
          break;
        case '-fail': {
          const target = parts[1]?.split(':')[1]?.trim();
          events.push({
            kind: 'fail',
            text: target ? `${target}'s move failed!` : 'But it failed!',
            target,
          });
          break;
        }
        case 'cant': {
          const actor = parts[1]?.split(':')[1]?.trim();
          const reason = parts[2] || 'cant';
          events.push({
            kind: 'cant',
            text: `${actor} couldn't move (${reason}).`,
            actor,
          });
          break;
        }
        case '-prepare': {
          const actor = parts[1]?.split(':')[1]?.trim();
          const moveName = parts[2];
          events.push({
            kind: 'prepare',
            text: `${actor} is preparing ${moveName}!`,
            actor,
            moveName,
          });
          break;
        }
        case '-activate': {
          const actor = parts[1]?.split(':')[1]?.trim();
          const effect = parts[2];
          events.push({
            kind: 'activate',
            text: actor && effect ? `${actor}: ${effect}` : 'An effect activated.',
            actor,
          });
          break;
        }
        case 'faint': {
          const target = parts[1]?.split(':')[1]?.trim();
          events.push({ kind: 'faint', text: `${target} fainted!`, target, hpPercent: 0 });
          break;
        }
        case 'win':
          events.push({ kind: 'win', text: `${parts[1]} won the battle!`, actor: parts[1] });
          break;
      }
    }

    return this.compactTurnEvents(events);
  }

  private compactTurnEvents(events: BattleTurnEvent[]): BattleTurnEvent[] {
    const compacted: BattleTurnEvent[] = [];
    for (const event of events) {
      const prev = compacted[compacted.length - 1];
      if (
        prev &&
        prev.kind === 'damage' &&
        event.kind === 'damage' &&
        prev.target === event.target &&
        prev.hpPercent === event.hpPercent &&
        prev.status === event.status
      ) {
        continue;
      }
      compacted.push(event);
    }
    return compacted;
  }

  private parseHpProtocolPercent(hpState: string): {
    hpPercent: number | null;
    status: string | null;
    fainted: boolean;
  } {
    if (!hpState) return { hpPercent: null, status: null, fainted: false };
    if (hpState.includes('fnt')) {
      return { hpPercent: 0, status: null, fainted: true };
    }

    const fractionMatch = hpState.match(/(\d+)\/(\d+)/);
    const statusMatch = hpState.match(/\b(brn|psn|tox|par|slp|frz)\b/);
    if (!fractionMatch) {
      return { hpPercent: null, status: statusMatch?.[1] ?? null, fainted: false };
    }

    const current = Number(fractionMatch[1]);
    const max = Number(fractionMatch[2]);
    return {
      hpPercent: max > 0 ? Math.max(0, Math.min(100, Math.round((current / max) * 100))) : null,
      status: statusMatch?.[1] ?? null,
      fainted: false,
    };
  }

  private isCpuAiEnabled(): boolean {
    return process.env.ENABLE_CPU_AI === 'true';
  }

  private async tryChooseCpuMove(session: BattleSession): Promise<void> {
    const battle = session.battle as unknown as {
      sides?: Array<{
        requestState?: string;
        active?: Array<{
          name?: string;
          types?: string[];
          getTypes?: () => string[];
          moveSlots?: Array<{ id?: string; move: string; pp: number; disabled?: boolean }>;
        }>;
      }>;
      dex?: {
        moves?: { get?: (idOrName: string) => { type?: string; basePower?: number } | undefined };
        getImmunity?: (source: string, target: unknown) => boolean;
        getEffectiveness?: (source: string, target: unknown) => number;
      };
    };

    const p2Side = battle.sides?.[1];
    const p1Side = battle.sides?.[0];
    if (p2Side?.requestState !== 'move') return;

    const p2MoveChoices =
      p2Side.active?.[0]?.moveSlots
        ?.map((slot, index) => {
          const dexMove = battle.dex?.moves?.get?.(slot.id || slot.move);
          const targetPokemon = p1Side?.active?.[0];
          const moveType = dexMove?.type;
          const isImmune =
            !!moveType &&
            !!targetPokemon &&
            battle.dex?.getImmunity
              ? !battle.dex.getImmunity(moveType, targetPokemon)
              : false;
          const typeMod =
            !!moveType && !!targetPokemon && battle.dex?.getEffectiveness
              ? battle.dex.getEffectiveness(moveType, targetPokemon)
              : 0;
          const effectivenessMultiplier = isImmune
            ? 0
            : typeof typeMod === 'number'
              ? Math.pow(2, typeMod)
              : 1;
          return {
            index: index + 1,
            name: slot.move,
            type: dexMove?.type,
            power:
              typeof dexMove?.basePower === 'number' && dexMove.basePower > 0
                ? dexMove.basePower
                : null,
            pp: slot.pp,
            effectivenessMultiplier,
            isImmune,
            disabled: !!slot.disabled,
          };
        })
        .filter((move) => !move.disabled && move.pp > 0)
        .map(({ disabled, ...move }) => {
          void disabled;
          return move;
        }) ?? [];

    if (p2MoveChoices.length === 0) return;

    const decision = await this.safeChooseCpuMove(session, p2MoveChoices, {
      cpuPokemonName: p2Side.active?.[0]?.name || 'Unknown',
      playerPokemonName: p1Side?.active?.[0]?.name || 'Unknown',
    });

    const selected = p2MoveChoices.find((move) => move.index === decision.moveIndex);
    const finalMove = selected ?? p2MoveChoices[0];

    session.p2MoveChoice = `move ${finalMove.index}`;
    session.lastCpuDecision = {
      moveIndex: finalMove.index,
      moveName: finalMove.name,
      source: decision.source,
      modelId: decision.modelId,
      latencyMs: decision.latencyMs,
      rawResponse: decision.rawResponse,
      error: decision.error,
      turn: session.currentTurn + 1,
    };
  }

  private async safeChooseCpuMove(
    session: BattleSession,
    p2MoveChoices: Array<{
      index: number;
      name: string;
      type?: string;
      power?: number | null;
      pp?: number;
    }>,
    names: { cpuPokemonName: string; playerPokemonName: string }
  ): Promise<CpuMoveDecisionResult> {
    try {
      return await this.cpuMoveAiService.chooseCpuMove({
        battleId: session.id,
        turn: session.currentTurn + 1,
        cpuPokemonName: names.cpuPokemonName,
        playerPokemonName: names.playerPokemonName,
        availableMoves: p2MoveChoices,
        recentLog: session.turnLog.slice(-4),
        cpuPokemonTypes: this.getPokemonTypes(session.battle.sides[1]?.active?.[0]),
        playerPokemonTypes: this.getPokemonTypes(session.battle.sides[0]?.active?.[0]),
      });
    } catch (error) {
      if (process.env.OPENAI_CPU_STRICT === 'true') {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        moveIndex: p2MoveChoices[0].index,
        source: 'fallback',
        modelId: process.env.OPENAI_CPU_MODEL || 'gpt-4.1-mini',
        latencyMs: 0,
        error: message,
      };
    }
  }

  private getPokemonTypes(
    pokemon: unknown
  ): string[] | undefined {
    const p = pokemon as { types?: string[]; getTypes?: () => string[] } | undefined;
    if (!p) return undefined;
    if (Array.isArray(p.types) && p.types.length > 0) return p.types;
    try {
      const types = p.getTypes?.();
      return Array.isArray(types) ? types : undefined;
    } catch {
      return undefined;
    }
  }

  private getLegalMoveChoicesFromRequest(request: ShowdownRequest): string[] {
    const moves = request.active?.[0]?.moves ?? [];
    return moves
      .map((move, index) => ({ move, index: index + 1 }))
      .filter(({ move }) => !move.disabled && (move.pp ?? 1) > 0)
      .map(({ index }) => `move ${index}`);
  }
}
