import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Battle } from 'pokemon-showdown';
import {
  BattleService,
  StartBattleRequest,
  type ShowdownLegalOptions,
  type ShowdownRequest,
} from './battle.service';
import {
  CpuMoveAiService,
} from './cpu-move-ai.service';

export interface BattlePokemonState {
  slot: number;
  ident: string;
  name: string;
  hp: number;
  maxHp: number;
  hpPercent: number;
  status: string | null;
  fainted: boolean;
  isActive: boolean;
  boosts?: Record<string, number> | null;
  item?: string | null;
  ability?: string | null;
}

export interface BattleSideState {
  active: BattlePokemonState | null;
  bench: BattlePokemonState[];
  team: BattlePokemonState[];
  faintedCount: number;
}

export interface BattleState {
  battleId: string;
  sides: {
    p1: BattleSideState;
    p2: BattleSideState;
  };
  // Backward-compatible active snapshots.
  p1Pokemon: {
    name: string;
    hp: number;
    maxHp: number;
    hpPercent: number;
    status: string | null;
    boosts: Record<string, number> | null;
    item: string | null;
    ability: string | null;
  };
  p2Pokemon: {
    name: string;
    hp: number;
    maxHp: number;
    hpPercent: number;
    status: string | null;
    boosts: Record<string, number> | null;
    item: string | null;
    ability: string | null;
  };
  availableMoves: {
    choice: string;
    index: number;
    name: string;
    type: string;
    power: number | null;
    pp: number;
    maxPp: number;
  }[];
  availableSwitches: {
    choice: string;
    slot: number;
    name: string;
    hpPercent: number;
    status: string | null;
    fainted: boolean;
    isActive: boolean;
  }[];
  canSwitch: boolean;
  turnLog: string[];
  isEnded: boolean;
  winner: string | null;
  currentTurn: number;
  waitingForMove: boolean;
  pendingPlayers: ('p1' | 'p2')[];
  phase:
    | 'team-preview'
    | 'awaiting-actions'
    | 'awaiting-forced-switch-p1'
    | 'awaiting-forced-switch-p2'
    | 'awaiting-event-ack'
    | 'resolving'
    | 'ended';
  eventCursor: number;
  recentPlaybackEvents: BattlePlaybackEvent[];
  awaitingAckEventSeq: number | null;
  lastAction: {
    player: 'p1' | 'p2';
    choice: string;
    acceptedAt: number;
  } | null;
  lastTurnEvents: BattleTurnEvent[];
  lastCpuDecision: {
    choice: string;
    actionType: 'move' | 'switch' | 'team' | 'default';
    source: 'model' | 'fallback';
    modelId: string;
    latencyMs: number;
    reasoning?: string;
    rawResponse?: string;
    error?: string;
    turn: number;
  } | null;
}

export interface BattleTurnEvent {
  kind:
    | 'turn'
    | 'move'
    | 'switch'
    | 'drag'
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
    | 'win'
    | 'boost'
    | 'unboost'
    | 'item'
    | 'enditem'
    | 'ability'
    | 'weather'
    | 'immune'
    | 'curestatus'
    | 'sidestart'
    | 'sideend'
    | 'start'
    | 'end'
    | 'fieldstart'
    | 'fieldend'
    | 'hitcount'
    | 'block'
    | 'ohko';
  text: string;
  actor?: string;
  target?: string;
  moveName?: string;
  hpPercent?: number;
  status?: string | null;
  deltaPercent?: number;
  sourceType?: 'item' | 'ability' | 'status' | 'weather' | 'move' | 'other';
  sourceName?: string | null;
  description?: string;
  stat?: string;
  amount?: number;
  itemName?: string;
  abilityName?: string;
  effectName?: string;
}

export interface BattlePlaybackEvent {
  seq: number;
  turn: number;
  type:
    | 'TURN_START'
    | 'TURN'
    | 'MOVE'
    | 'SWITCH_IN'
    | 'DRAG'
    | 'DAMAGE'
    | 'HEAL'
    | 'ITEM_HEAL'
    | 'ABILITY_HEAL'
    | 'STATUS_TICK'
    | 'WEATHER_TICK'
    | 'STATUS'
    | 'EFFECTIVENESS'
    | 'CRIT'
    | 'MISS'
    | 'FAIL'
    | 'CANT'
    | 'PREPARE'
    | 'ACTIVATE'
    | 'FAINT'
    | 'FORCED_SWITCH_REQUIRED'
    | 'REQUEST_SWITCH'
    | 'REQUEST_MOVE'
    | 'PAUSE'
    | 'TURN_END'
    | 'WIN'
    | 'BOOST'
    | 'UNBOOST'
    | 'ITEM'
    | 'ENDITEM'
    | 'ABILITY'
    | 'WEATHER'
    | 'IMMUNE'
    | 'CURE_STATUS'
    | 'SIDE_START'
    | 'SIDE_END'
    | 'VOLATILE_START'
    | 'VOLATILE_END'
    | 'FIELD_START'
    | 'FIELD_END'
    | 'HIT_COUNT'
    | 'BLOCK'
    | 'OHKO';
  timestamp: number;
  payload: Record<string, unknown>;
}

class BattleSession {
  id: string;
  battle: Battle;
  p1Choice: string | null = null;
  p2Choice: string | null = null;
  turnLog: string[] = [];
  currentTurn = 0;
  lastLogIndex = 0;
  lastAction: BattleState['lastAction'] = null;
  lastTurnEvents: BattleTurnEvent[] = [];
  lastCpuDecision: BattleState['lastCpuDecision'] = null;
  isResolving = false;
  phase: BattleState['phase'] = 'awaiting-actions';
  eventLog: BattlePlaybackEvent[] = [];
  pendingPlaybackEvents: BattlePlaybackEvent[] = [];
  nextEventSeq = 1;
  awaitingAckEventSeq: number | null = null;
  emittedBoundaryKeys = new Set<string>();
  lastPlaybackEventKey: string | null = null;
  lastResolutionKey: string | null = null;
  deferredTurnEvents: BattleTurnEvent[] = [];
  appliedEffectKeys = new Set<string>();

  constructor(id: string, battle: Battle) {
    this.id = id;
    this.battle = battle;
    this.deferredTurnEvents = [];
    this.appliedEffectKeys = new Set<string>();
  }

  hasChoice(player: 'p1' | 'p2'): boolean {
    return player === 'p1' ? this.p1Choice !== null : this.p2Choice !== null;
  }

  setChoice(player: 'p1' | 'p2', choice: string): void {
    if (player === 'p1') {
      this.p1Choice = choice;
      return;
    }
    this.p2Choice = choice;
  }

  clearChoices() {
    this.p1Choice = null;
    this.p2Choice = null;
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
    const { Battle } = await import('pokemon-showdown');

    const p1Built = await this.battleService.buildTeam({
      team: config?.p1Team,
      fallbackSpecies: config?.p1Pokemon,
      fallbackMoves: config?.p1Moves,
      fallbackLevel: config?.level,
      size: 6,
      randomTeams: config?.randomTeams,
      randomTeamFormatid: config?.randomTeamFormatid,
      randomSeed: this.seedForSide(config?.randomSeed, 0),
    });
    const p2Built = await this.battleService.buildTeam({
      team: config?.p2Team,
      fallbackSpecies: config?.p2Pokemon,
      fallbackMoves: config?.p2Moves,
      fallbackLevel: config?.level,
      size: 6,
      randomTeams: config?.randomTeams,
      randomTeamFormatid: config?.randomTeamFormatid,
      randomSeed: this.seedForSide(config?.randomSeed, 1),
    });

    const battle = new Battle({
      formatid: config?.formatid ?? 'gen9customgame',
    });

    battle.setPlayer('p1', {
      name: `Player 1 (${p1Built.members[0]?.speciesName ?? 'Team'})`,
      team: p1Built.packed,
    });

    battle.setPlayer('p2', {
      name: `CPU (${p2Built.members[0]?.speciesName ?? 'Team'})`,
      team: p2Built.packed,
    });

    battle.choose(
      'p1',
      this.normalizeTeamPreviewChoice(config?.p1TeamPreviewChoice, p1Built.members.length)
    );
    battle.choose(
      'p2',
      this.normalizeTeamPreviewChoice(config?.p2TeamPreviewChoice, p2Built.members.length)
    );

    const battleId = `battle_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 11)}`;
    const session = new BattleSession(battleId, battle);

    session.lastLogIndex = battle.log.length;
    session.currentTurn = (battle as unknown as { turn?: number }).turn ?? 0;

    this.sessions.set(battleId, session);
    this.battleService.registerBattleSession(
      battleId,
      battle as never,
      session.lastLogIndex
    );

    const initialRequests = this.battleService.getRequests(battleId);
    session.phase = this.derivePhaseFromRequests(initialRequests);

    if (session.currentTurn > 0) {
      this.enqueueBoundaryEvent(session, {
        dedupeKey: `turn-start:${session.currentTurn}`,
        event: {
          seq: session.nextEventSeq++,
          turn: session.currentTurn,
          type: 'TURN_START',
          timestamp: Date.now(),
          payload: { turn: session.currentTurn, text: `Turn ${session.currentTurn}` },
        },
      });
      this.enqueueRequestBoundaryEvents(session, initialRequests);
      this.emitNextPlaybackEvent(session);
      if (session.awaitingAckEventSeq !== null) {
        session.phase = 'awaiting-event-ack';
      }
    }

    return this.getBattleState(battleId);
  }

  async submitMove(
    battleId: string,
    player: 'p1' | 'p2',
    moveIndex: number
  ): Promise<BattleState> {
    if (!Number.isInteger(moveIndex)) {
      throw new BadRequestException('moveIndex must be an integer');
    }
    const normalizedMoveIndex = moveIndex >= 1 ? moveIndex : moveIndex + 1;
    return this.submitAction(battleId, player, `move ${normalizedMoveIndex}`);
  }

  async submitAction(
    battleId: string,
    player: 'p1' | 'p2',
    choice: string
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
    if (session.awaitingAckEventSeq !== null) {
      throw new ConflictException(
        `Event ${session.awaitingAckEventSeq} must be acknowledged before continuing`
      );
    }

    if (session.phase === 'resolving') {
      throw new ConflictException('Battle is currently resolving events');
    }

    const requests = this.battleService.getRequests(battleId);
    const normalizedChoice = this.normalizePlayerChoice(
      player,
      player === 'p1' ? requests.p1 : requests.p2,
      choice
    );

    session.setChoice(player, normalizedChoice);
    session.lastAction = {
      player,
      choice: normalizedChoice,
      acceptedAt: Date.now(),
    };

    try {
      if (player === 'p1' && !session.hasChoice('p2')) {
        session.isResolving = true;
        await this.tryChooseCpuAction(session, requests);
      }

      this.autofillNonActionableChoices(session, requests);

      if (this.isReadyToResolve(session, requests)) {
        session.isResolving = true;
        return await this.resolveOneStep(battleId, requests);
      }

      session.phase = this.derivePhaseFromRequests(requests);
      return this.getBattleState(battleId);
    } finally {
      if (session.isResolving) {
        const latestRequests = this.battleService.getRequests(battleId);
        if (!this.isReadyToResolve(session, latestRequests)) {
          session.isResolving = false;
        }
      }
    }
  }

  async continueBattle(battleId: string): Promise<BattleState> {
    const session = this.sessions.get(battleId);
    if (!session) {
      throw new NotFoundException('Battle not found');
    }
    if (session.battle.ended) {
      return this.getBattleState(battleId);
    }
    if (session.isResolving) {
      throw new ConflictException('Battle is already resolving');
    }
    if (session.awaitingAckEventSeq !== null) {
      throw new ConflictException(
        `Event ${session.awaitingAckEventSeq} must be acknowledged before continuing`
      );
    }

    const requests = this.battleService.getRequests(battleId);
    const p1Legal = this.battleService.getLegalOptionsForRequest(requests.p1);
    const p2Legal = this.battleService.getLegalOptionsForRequest(requests.p2);
    const p1NeedsChoice = this.playerNeedsChoice('p1', p1Legal);
    const p2NeedsChoice = this.playerNeedsChoice('p2', p2Legal);

    if (p1NeedsChoice) {
      throw new BadRequestException('Player action required before continuing');
    }
    if (!p2NeedsChoice) {
      return this.getBattleState(battleId);
    }

    session.isResolving = true;
    try {
      await this.tryChooseCpuAction(session, requests);
      this.autofillNonActionableChoices(session, requests);
      if (!this.isReadyToResolve(session, requests)) {
        session.isResolving = false;
        return this.getBattleState(battleId);
      }
      return await this.resolveOneStep(battleId, requests);
    } finally {
      if (session.isResolving) {
        session.isResolving = false;
      }
    }
  }

  ackEvent(battleId: string, eventSeq: number): BattleState {
    const session = this.sessions.get(battleId);
    if (!session) {
      throw new NotFoundException('Battle not found');
    }
    if (!Number.isInteger(eventSeq) || eventSeq <= 0) {
      throw new BadRequestException('eventSeq must be a positive integer');
    }
    if (session.awaitingAckEventSeq === null) {
      throw new BadRequestException('No pending event acknowledgement');
    }
    if (session.awaitingAckEventSeq !== eventSeq) {
      throw new BadRequestException(
        `Expected ACK for event ${session.awaitingAckEventSeq}, received ${eventSeq}`
      );
    }

    session.awaitingAckEventSeq = null;
    this.emitNextPlaybackEvent(session);

    if (session.awaitingAckEventSeq !== null) {
      session.phase = 'awaiting-event-ack';
    } else if (!session.battle.ended) {
      session.phase = this.derivePhaseFromRequests(this.battleService.getRequests(battleId));
    } else {
      session.phase = 'ended';
    }

    return this.getBattleState(battleId);
  }

  getBattleEvents(battleId: string, afterSeq = 0, limit = 200): BattlePlaybackEvent[] {
    const session = this.sessions.get(battleId);
    if (!session) {
      throw new NotFoundException('Battle not found');
    }
    const cappedLimit = Math.max(1, Math.min(1000, Math.floor(limit) || 200));
    return session.eventLog
      .filter((event) => event.seq > afterSeq)
      .slice(0, cappedLimit);
  }

  private async resolveOneStep(
    battleId: string,
    requests: { p1: ShowdownRequest; p2: ShowdownRequest }
  ): Promise<BattleState> {
    const session = this.sessions.get(battleId);
    if (!session) {
      throw new NotFoundException('Battle not found');
    }

    try {
      const p1Legal = this.battleService.getLegalOptionsForRequest(requests.p1);
      const p2Legal = this.battleService.getLegalOptionsForRequest(requests.p2);
      const p1Choice = session.p1Choice ?? this.pickDefaultChoice(p1Legal);
      const p2Choice = session.p2Choice ?? this.pickDefaultChoice(p2Legal);
      const resolutionKey = `${session.currentTurn}|${session.lastLogIndex}|${p1Choice}|${p2Choice}`;
      if (session.lastResolutionKey === resolutionKey) {
        throw new ConflictException('Duplicate resolution attempt blocked by idempotency guard');
      }
      session.lastResolutionKey = resolutionKey;

      session.phase = 'resolving';
      const stepResult = this.battleService.step(battleId, p1Choice, p2Choice);
      const newLogs = stepResult.rawLogDelta;
      const formattedNewLogs = this.formatRecentLog(newLogs);
      const turnEvents = this.buildTurnEvents(newLogs);

      session.turnLog.push(...formattedNewLogs);
      session.lastTurnEvents = this.compactTurnEvents(turnEvents);

      // Flush any deferred events from a previous faint-triggered resolution
      // before enqueueing new events. This ensures end-of-turn effects that
      // happened after a faint appear before the replacement switch-in.
      if (session.deferredTurnEvents.length > 0) {
        this.enqueueEventsFromList(session, session.deferredTurnEvents, session.currentTurn);
        session.deferredTurnEvents = [];
      }

      // Determine if a forced switch is needed so we can defer post-faint
      // end-of-turn effects until the switch is resolved.
      const postP1Legal = this.battleService.getLegalOptionsForRequest(stepResult.requests.p1);
      const postP2Legal = this.battleService.getLegalOptionsForRequest(stepResult.requests.p2);
      const forceSwitchNeeded = postP1Legal.forceSwitch || postP2Legal.forceSwitch;

      this.enqueuePlaybackEvents(session, session.lastTurnEvents, forceSwitchNeeded);

      session.lastLogIndex = session.battle.log.length;
      session.currentTurn =
        (session.battle as unknown as { turn?: number }).turn ??
        session.currentTurn + 1;

      session.clearChoices();

      if (stepResult.ended) {
        session.phase = 'ended';
      } else {
        session.phase = this.derivePhaseFromRequests(stepResult.requests);
        this.enqueueRequestBoundaryEvents(session, stepResult.requests);
      }

      this.emitNextPlaybackEvent(session);
      if (session.awaitingAckEventSeq !== null) {
        session.phase = 'awaiting-event-ack';
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('Not all choices done')) {
        session.clearChoices();
        session.isResolving = false;
        return this.getBattleState(battleId);
      }

      session.clearChoices();
      session.isResolving = false;
      throw error;
    }

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
    const requests = this.battleService.getRequests(battleId);
    const p1Legal = this.battleService.getLegalOptionsForRequest(requests.p1);
    const p2Legal = this.battleService.getLegalOptionsForRequest(requests.p2);

    const p1Side = this.buildSideState(
      battle.sides?.[0] as unknown as BattleSideLike,
      requests.p1
    );
    const p2Side = this.buildSideState(
      battle.sides?.[1] as unknown as BattleSideLike,
      requests.p2
    );

    const availableMoves = this.buildAvailableMoves(
      requests.p1,
      p1Legal,
      battle as unknown as BattleWithDex
    );
    const availableSwitches = this.buildAvailableSwitches(p1Side, p1Legal);

    const pendingPlayers: ('p1' | 'p2')[] = [];
    if (this.playerNeedsChoice('p1', p1Legal) && !session.hasChoice('p1')) {
      pendingPlayers.push('p1');
    }
    if (this.playerNeedsChoice('p2', p2Legal) && !session.hasChoice('p2')) {
      pendingPlayers.push('p2');
    }
    if (session.awaitingAckEventSeq !== null) {
      pendingPlayers.length = 0;
    }

    if (session.awaitingAckEventSeq !== null) {
      session.phase = 'awaiting-event-ack';
    } else if (battle.ended) {
      session.phase = 'ended';
    } else if (session.isResolving) {
      session.phase = 'resolving';
    } else if (session.phase === 'resolving') {
      session.phase = this.derivePhaseFromRequests(requests);
    }

    return {
      battleId,
      sides: {
        p1: p1Side,
        p2: p2Side,
      },
      p1Pokemon: {
        name: p1Side.active?.name || 'Unknown',
        hp: p1Side.active?.hp || 0,
        maxHp: p1Side.active?.maxHp || 100,
        hpPercent: p1Side.active?.hpPercent || 0,
        status: p1Side.active?.status || null,
        boosts: p1Side.active?.boosts || null,
        item: p1Side.active?.item || null,
        ability: p1Side.active?.ability || null,
      },
      p2Pokemon: {
        name: p2Side.active?.name || 'Unknown',
        hp: p2Side.active?.hp || 0,
        maxHp: p2Side.active?.maxHp || 100,
        hpPercent: p2Side.active?.hpPercent || 0,
        status: p2Side.active?.status || null,
        boosts: p2Side.active?.boosts || null,
        item: p2Side.active?.item || null,
        ability: p2Side.active?.ability || null,
      },
      availableMoves,
      availableSwitches,
      canSwitch: availableSwitches.length > 0,
      turnLog: session.turnLog,
      isEnded: battle.ended,
      winner: battle.winner || null,
      currentTurn: session.currentTurn,
      waitingForMove:
        p1Legal.moveChoices.length > 0 &&
        !p1Legal.forceSwitch &&
        pendingPlayers.includes('p1'),
      pendingPlayers,
      phase: session.phase,
      eventCursor: session.nextEventSeq - 1,
      recentPlaybackEvents: session.eventLog.slice(-20),
      awaitingAckEventSeq: session.awaitingAckEventSeq,
      lastAction: session.lastAction,
      lastTurnEvents: session.lastTurnEvents,
      lastCpuDecision: session.lastCpuDecision,
    };
  }

  deleteBattle(battleId: string) {
    this.sessions.delete(battleId);
    this.battleService.unregisterBattleSession(battleId);
  }

  private normalizeTeamPreviewChoice(choice: string | undefined, teamSize: number): string {
    const fallback = `team ${Array.from(
      { length: Math.max(1, Math.min(6, teamSize || 6)) },
      (_, index) => index + 1
    ).join('')}`;

    if (!choice?.trim()) return fallback;
    const normalized = choice.trim();
    if (!/^team\s+\d+$/i.test(normalized)) return fallback;
    return normalized;
  }

  private seedForSide(seed: number[] | undefined, sideOffset: number): number[] | undefined {
    if (!Array.isArray(seed) || seed.length !== 4) return undefined;
    return seed.map((value, index) =>
      Math.max(0, Math.floor(Number(value) || 0) + sideOffset + index)
    );
  }

  private normalizePlayerChoice(
    player: 'p1' | 'p2',
    request: ShowdownRequest,
    choice: string
  ): string {
    const legal = this.battleService.getLegalOptionsForRequest(request);
    if (!legal.needsChoice) {
      return 'default';
    }

    const normalized = (choice || '').trim();
    if (!normalized || normalized === 'default') {
      return this.pickDefaultChoice(legal);
    }

    if (legal.teamPreview) {
      if (/^team\s+\d+$/i.test(normalized)) {
        return normalized;
      }
      throw new BadRequestException({
        message: `Illegal action "${normalized}" for ${player}`,
        legalOptions: legal.allChoices,
      });
    }

    if (legal.allChoices.includes(normalized)) {
      return normalized;
    }

    throw new BadRequestException({
      message: `Illegal action "${normalized}" for ${player}`,
      legalOptions: legal.allChoices,
      forceSwitch: legal.forceSwitch,
      moveChoices: legal.moveChoices,
      switchChoices: legal.switchChoices,
    });
  }

  private pickDefaultChoice(legal: ShowdownLegalOptions): string {
    if (!legal.needsChoice || legal.wait) return 'default';
    if (legal.teamPreview) {
      return legal.allChoices[0] ?? 'team 123456';
    }
    if (legal.forceSwitch) {
      return legal.switchChoices[0] ?? 'default';
    }
    if (legal.moveChoices.length > 0) {
      return legal.moveChoices[0];
    }
    if (legal.switchChoices.length > 0) {
      return legal.switchChoices[0];
    }
    return 'default';
  }

  private derivePhaseFromRequests(requests: {
    p1: ShowdownRequest;
    p2: ShowdownRequest;
  }): BattleState['phase'] {
    const p1Legal = this.battleService.getLegalOptionsForRequest(requests.p1);
    const p2Legal = this.battleService.getLegalOptionsForRequest(requests.p2);
    if (p1Legal.teamPreview || p2Legal.teamPreview) {
      return 'team-preview';
    }
    if (p1Legal.forceSwitch) {
      return 'awaiting-forced-switch-p1';
    }
    if (p2Legal.forceSwitch) {
      return 'awaiting-forced-switch-p2';
    }
    return 'awaiting-actions';
  }

  private enqueuePlaybackEvents(
    session: BattleSession,
    turnEvents: BattleTurnEvent[],
    forceSwitchNeeded: boolean
  ): void {
    const currentTurn = session.currentTurn;
    const lastFaintIdx = forceSwitchNeeded ? this.findLastFaintIndex(turnEvents) : -1;
    const stepSeenKeys = new Set<string>();

    for (let i = 0; i < turnEvents.length; i++) {
      const event = turnEvents[i];

      // TURN marker → emit TURN_END for ending turn then TURN_START for new turn.
      // This replaces the raw TURN event so boundary ordering is always correct.
      if (event.kind === 'turn') {
        const nextTurn = Number((event.text.match(/\d+/) || [])[0] || currentTurn + 1);
        const endedTurn = Math.max(1, nextTurn - 1);

        this.enqueueBoundaryEvent(session, {
          dedupeKey: `turn-end:${endedTurn}`,
          event: {
            seq: session.nextEventSeq++,
            turn: endedTurn,
            type: 'TURN_END',
            timestamp: Date.now(),
            payload: { endedTurn },
          },
        });

        this.enqueueBoundaryEvent(session, {
          dedupeKey: `turn-start:${nextTurn}`,
          event: {
            seq: session.nextEventSeq++,
            turn: nextTurn,
            type: 'TURN_START',
            timestamp: Date.now(),
            payload: { turn: nextTurn, text: `Turn ${nextTurn}` },
          },
        });
        continue;
      }

      // Defer end-of-turn effects that appear AFTER the last faint when a
      // forced switch is pending. They will be flushed before the next step's
      // events so the UI sees: FAINT → REQUEST_SWITCH → (switch resolved) →
      // deferred effects → SWITCH_IN → TURN_END → TURN_START → REQUEST_MOVE.
      if (lastFaintIdx >= 0 && i > lastFaintIdx && this.isEndOfTurnEffect(event)) {
        session.deferredTurnEvents.push(event);
        continue;
      }

      const dedupeKey = this.createEventDedupeKey(currentTurn, event);
      if (stepSeenKeys.has(dedupeKey)) continue;
      stepSeenKeys.add(dedupeKey);
      if (session.lastPlaybackEventKey === dedupeKey) continue;

      const effectKey = this.createEffectIdempotencyKey(currentTurn, event);
      if (effectKey && session.appliedEffectKeys.has(effectKey)) continue;
      if (effectKey) session.appliedEffectKeys.add(effectKey);

      const playbackEvent: BattlePlaybackEvent = {
        seq: session.nextEventSeq++,
        turn: currentTurn,
        type: this.mapTurnEventType(event),
        timestamp: Date.now(),
        payload: {
          text: event.text,
          actor: event.actor,
          target: event.target,
          moveName: event.moveName,
          hpPercent: event.hpPercent,
          status: event.status,
          deltaPercent: event.deltaPercent,
          sourceType: event.sourceType,
          sourceName: event.sourceName,
          description: event.description,
          stat: event.stat,
          amount: event.amount,
          itemName: event.itemName,
          abilityName: event.abilityName,
          effectName: event.effectName,
        },
      };
      session.pendingPlaybackEvents.push(playbackEvent);
      session.lastPlaybackEventKey = dedupeKey;
    }
  }

  private enqueueRequestBoundaryEvents(
    session: BattleSession,
    requests: { p1: ShowdownRequest; p2: ShowdownRequest }
  ): void {
    const turnValue = session.currentTurn;

    // Faint pause for animation breathing room
    if (session.lastTurnEvents.some((event) => event.kind === 'faint')) {
      this.enqueueBoundaryEvent(session, {
        dedupeKey: `pause:faint:${turnValue}:${session.lastLogIndex}`,
        event: {
          seq: session.nextEventSeq++,
          turn: turnValue,
          type: 'PAUSE',
          timestamp: Date.now(),
          payload: { reason: 'faint' },
        },
      });
    }

    const p1Legal = this.battleService.getLegalOptionsForRequest(requests.p1);
    const p2Legal = this.battleService.getLegalOptionsForRequest(requests.p2);

    // REQUEST_SWITCH — emitted when a side must choose a replacement.
    const switchRequests: Array<{ player: 'p1' | 'p2'; legalChoices: string[] }> = [];
    if (p1Legal.forceSwitch) {
      switchRequests.push({ player: 'p1', legalChoices: p1Legal.switchChoices });
    }
    if (p2Legal.forceSwitch) {
      switchRequests.push({ player: 'p2', legalChoices: p2Legal.switchChoices });
    }
    if (switchRequests.length > 0) {
      this.enqueueBoundaryEvent(session, {
        dedupeKey: `request-switch:${turnValue}:${switchRequests.map((r) => r.player).join(',')}`,
        event: {
          seq: session.nextEventSeq++,
          turn: turnValue,
          type: 'REQUEST_SWITCH',
          timestamp: Date.now(),
          payload: { requests: switchRequests },
        },
      });
      // When a forced switch is pending, do NOT emit REQUEST_MOVE.
      // The next REQUEST_MOVE will come after the switch is resolved
      // and the next turn begins.
      return;
    }

    // REQUEST_MOVE — only when no forced switch is pending.
    // Stable dedup key: just turn number (legal choices may shift between
    // re-evaluations, but the conceptual "please choose a move" is the same).
    const moveRequests: Array<{ player: 'p1' | 'p2'; legalChoices: string[] }> = [];
    if (p1Legal.moveChoices.length > 0) {
      moveRequests.push({ player: 'p1', legalChoices: p1Legal.moveChoices });
    }
    if (p2Legal.moveChoices.length > 0) {
      moveRequests.push({ player: 'p2', legalChoices: p2Legal.moveChoices });
    }
    if (moveRequests.length > 0) {
      this.enqueueBoundaryEvent(session, {
        dedupeKey: `request-move:${turnValue}`,
        event: {
          seq: session.nextEventSeq++,
          turn: turnValue,
          type: 'REQUEST_MOVE',
          timestamp: Date.now(),
          payload: { requests: moveRequests },
        },
      });
    }

    // NOTE: TURN_END is now emitted inside enqueuePlaybackEvents when the
    // TURN marker is encountered in the raw log. This guarantees TURN_END
    // always precedes TURN_START and REQUEST_MOVE in the sequence.
  }

  private enqueueBoundaryEvent(
    session: BattleSession,
    input: { dedupeKey: string; event: BattlePlaybackEvent }
  ): void {
    if (session.emittedBoundaryKeys.has(input.dedupeKey)) {
      return;
    }
    session.emittedBoundaryKeys.add(input.dedupeKey);
    session.pendingPlaybackEvents.push(input.event);
  }

  private emitNextPlaybackEvent(session: BattleSession): void {
    if (session.awaitingAckEventSeq !== null) return;
    const next = session.pendingPlaybackEvents.shift();
    if (!next) return;
    session.eventLog.push(next);
    session.awaitingAckEventSeq = next.seq;
  }

  private findLastFaintIndex(events: BattleTurnEvent[]): number {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].kind === 'faint') return i;
    }
    return -1;
  }

  private isEndOfTurnEffect(event: BattleTurnEvent): boolean {
    if (event.kind !== 'heal' && event.kind !== 'damage') return false;
    return (
      event.sourceType === 'item' ||
      event.sourceType === 'ability' ||
      event.sourceType === 'status' ||
      event.sourceType === 'weather'
    );
  }

  private createEffectIdempotencyKey(turn: number, event: BattleTurnEvent): string | null {
    if (!event.sourceType || !event.target) return null;
    if (event.kind !== 'heal' && event.kind !== 'damage') return null;
    return `effect:${turn}:${event.kind}:${event.target}:${event.sourceType}:${event.sourceName || ''}`;
  }

  private enqueueEventsFromList(
    session: BattleSession,
    events: BattleTurnEvent[],
    turn: number
  ): void {
    const stepSeenKeys = new Set<string>();
    for (const event of events) {
      const dedupeKey = this.createEventDedupeKey(turn, event);
      if (stepSeenKeys.has(dedupeKey)) continue;
      stepSeenKeys.add(dedupeKey);

      const effectKey = this.createEffectIdempotencyKey(turn, event);
      if (effectKey && session.appliedEffectKeys.has(effectKey)) continue;
      if (effectKey) session.appliedEffectKeys.add(effectKey);

      const playbackEvent: BattlePlaybackEvent = {
        seq: session.nextEventSeq++,
        turn,
        type: this.mapTurnEventType(event),
        timestamp: Date.now(),
        payload: {
          text: event.text,
          actor: event.actor,
          target: event.target,
          moveName: event.moveName,
          hpPercent: event.hpPercent,
          status: event.status,
          deltaPercent: event.deltaPercent,
          sourceType: event.sourceType,
          sourceName: event.sourceName,
          description: event.description,
          stat: event.stat,
          amount: event.amount,
          itemName: event.itemName,
          abilityName: event.abilityName,
          effectName: event.effectName,
        },
      };
      session.pendingPlaybackEvents.push(playbackEvent);
    }
  }

  private mapTurnEventType(event: BattleTurnEvent): BattlePlaybackEvent['type'] {
    if (event.kind === 'heal') {
      if (event.sourceType === 'item') return 'ITEM_HEAL';
      if (event.sourceType === 'ability') return 'ABILITY_HEAL';
      if (event.sourceType === 'status') return 'STATUS_TICK';
      if (event.sourceType === 'weather') return 'WEATHER_TICK';
      return 'HEAL';
    }
    if (event.kind === 'damage') {
      if (event.sourceType === 'status') return 'STATUS_TICK';
      if (event.sourceType === 'weather') return 'WEATHER_TICK';
      return 'DAMAGE';
    }

    switch (event.kind) {
      case 'turn':
        return 'TURN_START';
      case 'move':
        return 'MOVE';
      case 'switch':
        return 'SWITCH_IN';
      case 'drag':
        return 'DRAG';
      case 'status':
        return 'STATUS';
      case 'effectiveness':
        return 'EFFECTIVENESS';
      case 'crit':
        return 'CRIT';
      case 'miss':
        return 'MISS';
      case 'fail':
        return 'FAIL';
      case 'cant':
        return 'CANT';
      case 'prepare':
        return 'PREPARE';
      case 'activate':
        return 'ACTIVATE';
      case 'faint':
        return 'FAINT';
      case 'win':
        return 'WIN';
      case 'boost':
        return 'BOOST';
      case 'unboost':
        return 'UNBOOST';
      case 'item':
        return 'ITEM';
      case 'enditem':
        return 'ENDITEM';
      case 'ability':
        return 'ABILITY';
      case 'weather':
        return 'WEATHER';
      case 'immune':
        return 'IMMUNE';
      case 'curestatus':
        return 'CURE_STATUS';
      case 'sidestart':
        return 'SIDE_START';
      case 'sideend':
        return 'SIDE_END';
      case 'start':
        return 'VOLATILE_START';
      case 'end':
        return 'VOLATILE_END';
      case 'fieldstart':
        return 'FIELD_START';
      case 'fieldend':
        return 'FIELD_END';
      case 'hitcount':
        return 'HIT_COUNT';
      case 'block':
        return 'BLOCK';
      case 'ohko':
        return 'OHKO';
      default:
        return 'PAUSE';
    }
  }

  private createEventDedupeKey(turn: number, event: BattleTurnEvent): string {
    return [
      turn,
      event.kind,
      event.actor || '',
      event.target || '',
      event.moveName || '',
      event.hpPercent ?? '',
      event.status || '',
      event.deltaPercent ?? '',
      event.sourceType || '',
      event.sourceName || '',
      event.text,
    ].join('|');
  }

  private playerNeedsChoice(player: 'p1' | 'p2', legal: ShowdownLegalOptions): boolean {
    if (!legal.needsChoice || legal.wait) return false;
    if (player === 'p2' && !legal.allChoices.length) return false;
    return true;
  }

  private autofillNonActionableChoices(
    session: BattleSession,
    requests: { p1: ShowdownRequest; p2: ShowdownRequest }
  ): void {
    const p1Legal = this.battleService.getLegalOptionsForRequest(requests.p1);
    if (!this.playerNeedsChoice('p1', p1Legal) && !session.hasChoice('p1')) {
      session.setChoice('p1', 'default');
    }

    const p2Legal = this.battleService.getLegalOptionsForRequest(requests.p2);
    if (!this.playerNeedsChoice('p2', p2Legal) && !session.hasChoice('p2')) {
      session.setChoice('p2', 'default');
    }
  }

  private isReadyToResolve(
    session: BattleSession,
    requests: { p1: ShowdownRequest; p2: ShowdownRequest }
  ): boolean {
    const p1Legal = this.battleService.getLegalOptionsForRequest(requests.p1);
    const p2Legal = this.battleService.getLegalOptionsForRequest(requests.p2);

    const p1Ready = !this.playerNeedsChoice('p1', p1Legal) || session.hasChoice('p1');
    const p2Ready = !this.playerNeedsChoice('p2', p2Legal) || session.hasChoice('p2');
    return p1Ready && p2Ready;
  }

  private async tryChooseCpuAction(
    session: BattleSession,
    requests: { p1: ShowdownRequest; p2: ShowdownRequest }
  ): Promise<void> {
    const p2Legal = this.battleService.getLegalOptionsForRequest(requests.p2);
    if (!p2Legal.needsChoice || p2Legal.wait) {
      session.setChoice('p2', 'default');
      return;
    }

    if (p2Legal.teamPreview) {
      const teamChoice = this.pickDefaultChoice(p2Legal);
      session.setChoice('p2', teamChoice);
      session.lastCpuDecision = {
        choice: teamChoice,
        actionType: 'team',
        source: 'fallback',
        modelId: this.cpuMoveAiService.getDefaultModelId(),
        latencyMs: 0,
        reasoning: 'Deterministic team preview order',
        turn: session.currentTurn,
      };
      return;
    }

    const battle = session.battle as unknown as BattleWithDex;
    const p1Active = battle.sides?.[0]?.active?.[0];
    const p2Active = battle.sides?.[1]?.active?.[0];
    const p2MoveChoices = this.getLegalCpuMoveChoices(battle, requests, p2Legal);
    const p2SwitchChoices = this.getLegalCpuSwitchChoices(requests.p2, p2Legal);

    if (!this.isCpuAiEnabled()) {
      const fallback = this.getFallbackCpuChoice(
        p2MoveChoices,
        p2SwitchChoices,
        !!p2Legal.forceSwitch
      );
      session.setChoice('p2', fallback.choice);
      session.lastCpuDecision = {
        choice: fallback.choice,
        actionType: fallback.actionType,
        source: 'fallback',
        modelId: this.cpuMoveAiService.getDefaultModelId(),
        latencyMs: 0,
        reasoning: 'Deterministic fallback action',
        turn: session.currentTurn + 1,
      };
      return;
    }

    try {
      const decision = await this.cpuMoveAiService.chooseCpuAction({
        battleId: session.id,
        turn: session.currentTurn + 1,
        cpuPokemonName: p2Active?.name || 'Unknown',
        playerPokemonName: p1Active?.name || 'Unknown',
        forceSwitch: !!p2Legal.forceSwitch,
        availableMoves: p2MoveChoices,
        availableSwitches: p2SwitchChoices,
        recentLog: session.turnLog.slice(-4),
        cpuPokemonTypes: this.getPokemonTypes(session.battle.sides[1]?.active?.[0]),
        playerPokemonTypes: this.getPokemonTypes(session.battle.sides[0]?.active?.[0]),
      });
      session.setChoice('p2', decision.choice);
      session.lastCpuDecision = {
        choice: decision.choice,
        actionType: decision.actionType,
        source: decision.source,
        modelId: decision.modelId,
        latencyMs: decision.latencyMs,
        reasoning: decision.reasoning,
        rawResponse: decision.rawResponse,
        error: decision.error,
        turn: session.currentTurn + 1,
      };
    } catch (error) {
      if (process.env.OPENAI_CPU_STRICT === 'true') {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      const fallback = this.getFallbackCpuChoice(
        p2MoveChoices,
        p2SwitchChoices,
        !!p2Legal.forceSwitch
      );
      session.setChoice('p2', fallback.choice);
      session.lastCpuDecision = {
        choice: fallback.choice,
        actionType: fallback.actionType,
        source: 'fallback',
        modelId: process.env.OPENAI_CPU_MODEL || 'gpt-4.1-mini',
        latencyMs: 0,
        reasoning: 'Fallback action after agent error',
        error: message,
        turn: session.currentTurn + 1,
      };
    }
  }

  private getLegalCpuMoveChoices(
    battle: BattleWithDex,
    requests: { p1: ShowdownRequest; p2: ShowdownRequest },
    p2Legal: ShowdownLegalOptions
  ): Array<{
    index: number;
    name: string;
    type?: string;
    power?: number | null;
    pp?: number;
    effectivenessMultiplier?: number;
    isImmune?: boolean;
  }> {
    const p1Active = battle.sides?.[0]?.active?.[0];
    const moveRequests = requests.p2.active?.[0]?.moves ?? [];
    const legalMoveIndices = new Set(
      p2Legal.moveChoices
        .map((choice) => {
          const match = choice.match(/^move\s+(\d+)$/i);
          return match ? Number(match[1]) : null;
        })
        .filter((index): index is number => typeof index === 'number')
    );

    return moveRequests
      .map((move, index) => ({ move, index: index + 1 }))
      .filter(
        ({ index, move }) => legalMoveIndices.has(index) && (move.pp ?? 1) > 0 && !move.disabled
      )
      .map(({ move, index }) => {
        const dexMove = battle.dex?.moves?.get?.(move.id || move.move);
        const moveType = dexMove?.type;
        const isImmune =
          !!moveType &&
          !!p1Active &&
          !!battle.dex?.getImmunity &&
          !battle.dex.getImmunity(moveType, p1Active);
        const typeMod =
          !!moveType && !!p1Active && !!battle.dex?.getEffectiveness
            ? battle.dex.getEffectiveness(moveType, p1Active)
            : 0;

        return {
          index,
          name: move.move,
          type: dexMove?.type,
          power:
            typeof dexMove?.basePower === 'number' && dexMove.basePower > 0
              ? dexMove.basePower
              : null,
          pp: move.pp,
          effectivenessMultiplier:
            isImmune || typeof typeMod !== 'number' ? 0 : Math.pow(2, typeMod),
          isImmune,
        };
      });
  }

  private getLegalCpuSwitchChoices(
    request: ShowdownRequest,
    p2Legal: ShowdownLegalOptions
  ): Array<{ slot: number; name: string; hpPercent: number; status?: string | null }> {
    const legalSwitchSlots = new Set(
      p2Legal.switchChoices
        .map((choice) => {
          const match = choice.match(/^switch\s+(\d+)$/i);
          return match ? Number(match[1]) : null;
        })
        .filter((slot): slot is number => typeof slot === 'number')
    );

    return (request.side?.pokemon ?? [])
      .map((pokemon, index) => ({ pokemon, slot: index + 1 }))
      .filter(({ slot }) => legalSwitchSlots.has(slot))
      .map(({ pokemon, slot }) => {
        const parsed = this.parseCondition(pokemon.condition);
        return {
          slot,
          name: this.extractNameFromIdent(pokemon.ident, pokemon.details),
          hpPercent: parsed.hpPercent,
          status: parsed.status,
        };
      });
  }

  private getFallbackCpuChoice(
    moveChoices: Array<{
      index: number;
      power?: number | null;
      pp?: number;
      effectivenessMultiplier?: number;
      isImmune?: boolean;
    }>,
    switchChoices: Array<{ slot: number; hpPercent: number; status?: string | null }>,
    forceSwitch: boolean
  ): { choice: string; actionType: 'move' | 'switch' | 'default' } {
    if (forceSwitch || moveChoices.length === 0) {
      if (switchChoices.length === 0) {
        return { choice: 'default', actionType: 'default' };
      }
      const bestSwitch = [...switchChoices].sort((a, b) => {
        if (b.hpPercent !== a.hpPercent) return b.hpPercent - a.hpPercent;
        if (a.status && !b.status) return 1;
        if (!a.status && b.status) return -1;
        return a.slot - b.slot;
      })[0];
      return { choice: `switch ${bestSwitch.slot}`, actionType: 'switch' };
    }

    const pool =
      moveChoices.filter((choice) => !choice.isImmune).length > 0
        ? moveChoices.filter((choice) => !choice.isImmune)
        : moveChoices;
    const bestMove = [...pool].sort((a, b) => {
      const effA = a.effectivenessMultiplier ?? 1;
      const effB = b.effectivenessMultiplier ?? 1;
      if (effB !== effA) return effB - effA;
      const powA = a.power ?? 0;
      const powB = b.power ?? 0;
      if (powB !== powA) return powB - powA;
      const ppA = a.pp ?? 0;
      const ppB = b.pp ?? 0;
      if (ppB !== ppA) return ppB - ppA;
      return a.index - b.index;
    })[0];
    return { choice: `move ${bestMove.index}`, actionType: 'move' };
  }

  private isCpuAiEnabled(): boolean {
    return process.env.ENABLE_CPU_AI === 'true';
  }

  private getPokemonTypes(pokemon: unknown): string[] | undefined {
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

  private buildSideState(side: BattleSideLike | undefined, request: ShowdownRequest): BattleSideState {
    const activeBoosts = this.extractActiveBoosts(side);

    const source = side?.pokemon?.length
      ? side.pokemon.map((pokemon) => ({
          ident: pokemon.fullname || pokemon.name || `slot-${(pokemon.position ?? 0) + 1}`,
          name: pokemon.name || pokemon.species?.name || 'Unknown',
          slot: (pokemon.position ?? 0) + 1,
          hp: typeof pokemon.hp === 'number' ? pokemon.hp : 0,
          maxHp: typeof pokemon.maxhp === 'number' ? pokemon.maxhp : 0,
          status: pokemon.status || null,
          fainted: !!pokemon.fainted,
          isActive: !!pokemon.isActive,
          item: pokemon.item || pokemon.set?.item || null,
          ability: pokemon.ability || pokemon.baseAbility || null,
          boosts: pokemon.isActive ? activeBoosts : null,
        }))
      : this.buildTeamFromRequest(request);

    const team = source
      .map((pokemon) => ({
        ...pokemon,
        hpPercent: this.toHpPercent(pokemon.hp, pokemon.maxHp),
      }))
      .sort((a, b) => a.slot - b.slot);

    const active = team.find((pokemon) => pokemon.isActive) ?? null;
    const bench = team.filter((pokemon) => !pokemon.isActive);

    return {
      active,
      bench,
      team,
      faintedCount: team.filter((pokemon) => pokemon.fainted).length,
    };
  }

  private buildTeamFromRequest(request: ShowdownRequest): Array<
    Omit<BattlePokemonState, 'hpPercent'>
  > {
    return (request.side?.pokemon ?? []).map((pokemon, index) => {
      const parsed = this.parseCondition(pokemon.condition);
      return {
        slot: index + 1,
        ident: pokemon.ident || `slot-${index + 1}`,
        name: this.extractNameFromIdent(pokemon.ident, pokemon.details),
        hp: parsed.hp,
        maxHp: parsed.maxHp,
        status: parsed.status,
        fainted: parsed.fainted,
        isActive: !!pokemon.active,
        item: null,
        ability: null,
        boosts: null,
      };
    });
  }

  private extractActiveBoosts(side: BattleSideLike | undefined): Record<string, number> | null {
    const activePokemon = side?.active?.[0];
    if (!activePokemon?.boosts) return null;
    const nonZero: Record<string, number> = {};
    for (const [stat, value] of Object.entries(activePokemon.boosts)) {
      if (typeof value === 'number' && value !== 0) {
        nonZero[stat] = value;
      }
    }
    return Object.keys(nonZero).length > 0 ? nonZero : null;
  }

  private buildAvailableMoves(
    request: ShowdownRequest,
    legal: ShowdownLegalOptions,
    battle: BattleWithDex
  ): BattleState['availableMoves'] {
    const legalIndices = new Set(
      legal.moveChoices
        .map((choice) => {
          const match = choice.match(/^move\s+(\d+)$/i);
          return match ? Number(match[1]) : null;
        })
        .filter((index): index is number => typeof index === 'number')
    );

    const moves = request.active?.[0]?.moves ?? [];
    return moves
      .map((move, index) => ({ move, index: index + 1 }))
      .filter(({ index }) => legalIndices.has(index))
      .map(({ move, index }) => {
        const dexMove = battle.dex?.moves?.get?.(move.id || move.move);
        return {
          choice: `move ${index}`,
          index,
          name: move.move,
          type: dexMove?.type || 'Normal',
          power:
            typeof dexMove?.basePower === 'number' && dexMove.basePower > 0
              ? dexMove.basePower
              : null,
          pp: move.pp ?? 0,
          maxPp: battle.sides?.[0]?.active?.[0]?.moveSlots?.[index - 1]?.maxpp ??
            move.pp ??
            0,
        };
      });
  }

  private buildAvailableSwitches(
    side: BattleSideState,
    legal: ShowdownLegalOptions
  ): BattleState['availableSwitches'] {
    const legalSlots = new Set(
      legal.switchChoices
        .map((choice) => {
          const match = choice.match(/^switch\s+(\d+)$/i);
          return match ? Number(match[1]) : null;
        })
        .filter((slot): slot is number => typeof slot === 'number')
    );

    return side.team
      .filter((pokemon) => legalSlots.has(pokemon.slot))
      .map((pokemon) => ({
        choice: `switch ${pokemon.slot}`,
        slot: pokemon.slot,
        name: pokemon.name,
        hpPercent: pokemon.hpPercent,
        status: pokemon.status,
        fainted: pokemon.fainted,
        isActive: pokemon.isActive,
      }));
  }

  private parseCondition(condition?: string): {
    hp: number;
    maxHp: number;
    hpPercent: number;
    status: string | null;
    fainted: boolean;
  } {
    if (!condition) {
      return { hp: 0, maxHp: 0, hpPercent: 0, status: null, fainted: false };
    }

    if (condition.includes('fnt')) {
      return { hp: 0, maxHp: 0, hpPercent: 0, status: null, fainted: true };
    }

    const fractionMatch = condition.match(/(\d+)\/(\d+)/);
    const statusMatch = condition.match(/\b(brn|psn|tox|par|slp|frz)\b/);
    if (!fractionMatch) {
      return { hp: 0, maxHp: 0, hpPercent: 0, status: statusMatch?.[1] ?? null, fainted: false };
    }

    const hp = Number(fractionMatch[1]);
    const maxHp = Number(fractionMatch[2]);
    return {
      hp,
      maxHp,
      hpPercent: this.toHpPercent(hp, maxHp),
      status: statusMatch?.[1] ?? null,
      fainted: false,
    };
  }

  private extractNameFromIdent(ident?: string, details?: string): string {
    if (ident && ident.includes(':')) {
      return ident.split(':')[1].trim();
    }
    if (details) {
      return details.split(',')[0].trim();
    }
    return 'Unknown';
  }

  private toHpPercent(hp?: number, maxHp?: number): number {
    if (!maxHp || maxHp <= 0 || typeof hp !== 'number') return 0;
    return Math.max(0, Math.min(100, Math.round((hp / maxHp) * 100)));
  }

  private formatRecentLog(logs: string[]): string[] {
    const formatted: string[] = [];
    for (const line of logs) {
      if (!line || line.startsWith('|request|')) continue;

      const parts = line.split('|').filter(Boolean);
      if (parts.length === 0) continue;

      const cmd = parts[0];

      switch (cmd) {
        case 'switch':
        case 'drag': {
          const pokemon = parts[1]?.split(':')[1]?.trim();
          if (pokemon) {
            const verb = cmd === 'switch' ? 'switched in' : 'was dragged in';
            formatted.push(`${pokemon} ${verb}.`);
          }
          break;
        }
        case 'move':
          formatted.push(`${parts[1]?.split(':')[1]?.trim()} used ${parts[2]}!`);
          break;
        case '-damage': {
          const pokemon = parts[1]?.split(':')[1]?.trim();
          if (parts[2]?.includes('faint')) {
            formatted.push(`${pokemon} fainted!`);
          } else {
            formatted.push(`${pokemon} HP: ${parts[2]}`);
          }
          break;
        }
        case '-heal': {
          const pokemon = parts[1]?.split(':')[1]?.trim();
          formatted.push(`${pokemon} recovered HP (${parts[2]}).`);
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
        case 'faint': {
          const target = parts[1]?.split(':')[1]?.trim();
          formatted.push(`${target} fainted!`);
          break;
        }
        case '-boost': {
          const pokemon = parts[1]?.split(':')[1]?.trim();
          const stat = parts[2] || '';
          const amount = Number(parts[3]) || 1;
          const statName = this.formatStatName(stat);
          const desc = amount >= 3 ? 'rose drastically' : amount === 2 ? 'rose sharply' : 'rose';
          formatted.push(`${pokemon}'s ${statName} ${desc}!`);
          break;
        }
        case '-unboost': {
          const pokemon = parts[1]?.split(':')[1]?.trim();
          const stat = parts[2] || '';
          const amount = Number(parts[3]) || 1;
          const statName = this.formatStatName(stat);
          const desc = amount >= 3 ? 'fell severely' : amount === 2 ? 'fell harshly' : 'fell';
          formatted.push(`${pokemon}'s ${statName} ${desc}!`);
          break;
        }
        case '-item': {
          const pokemon = parts[1]?.split(':')[1]?.trim();
          const itemName = parts[2] || '';
          formatted.push(`${pokemon} has ${itemName}!`);
          break;
        }
        case '-enditem': {
          const pokemon = parts[1]?.split(':')[1]?.trim();
          const itemName = parts[2] || '';
          const eaten = parts.some(p => p === '[eat]');
          formatted.push(eaten ? `${pokemon} ate its ${itemName}!` : `${pokemon} lost its ${itemName}!`);
          break;
        }
        case '-ability': {
          const pokemon = parts[1]?.split(':')[1]?.trim();
          const abilityName = parts[2] || '';
          formatted.push(`[${pokemon}'s ${abilityName}]`);
          break;
        }
        case '-weather': {
          const weatherName = parts[1] || 'none';
          const upkeep = parts.some(p => p === '[upkeep]');
          if (weatherName === 'none') formatted.push('The weather cleared.');
          else if (!upkeep) formatted.push(`The weather became ${this.formatWeatherName(weatherName)}!`);
          break;
        }
        case '-immune': {
          const target = parts[1]?.split(':')[1]?.trim();
          formatted.push(`It doesn't affect ${target}...`);
          break;
        }
        case '-curestatus': {
          const pokemon = parts[1]?.split(':')[1]?.trim();
          const curedStatus = parts[2] || '';
          formatted.push(`${pokemon} was cured of its ${this.formatStatusName(curedStatus)}!`);
          break;
        }
        case '-sidestart': {
          const sideRaw = parts[1] || '';
          const effectRaw = parts[2] || '';
          const effectName = effectRaw.replace(/^move:\s*/i, '').trim();
          const side = sideRaw.includes('p1') ? 'your' : "the opposing";
          formatted.push(`${effectName} was set on ${side} side!`);
          break;
        }
        case '-sideend': {
          const sideRaw = parts[1] || '';
          const effectRaw = parts[2] || '';
          const effectName = effectRaw.replace(/^move:\s*/i, '').trim();
          const side = sideRaw.includes('p1') ? 'your' : "the opposing";
          formatted.push(`${effectName} was removed from ${side} side!`);
          break;
        }
        case '-start': {
          const pokemon = parts[1]?.split(':')[1]?.trim();
          const effectRaw = parts[2] || '';
          const effectName = effectRaw.replace(/^move:\s*/i, '').replace(/^ability:\s*/i, '').trim();
          formatted.push(`${pokemon} is affected by ${effectName}!`);
          break;
        }
        case '-end': {
          const pokemon = parts[1]?.split(':')[1]?.trim();
          const effectRaw = parts[2] || '';
          const effectName = effectRaw.replace(/^move:\s*/i, '').replace(/^ability:\s*/i, '').trim();
          formatted.push(`${pokemon}'s ${effectName} ended.`);
          break;
        }
        case '-fieldstart': {
          const effectRaw = parts[1] || '';
          const effectName = effectRaw.replace(/^move:\s*/i, '').trim();
          formatted.push(`${effectName} started!`);
          break;
        }
        case '-fieldend': {
          const effectRaw = parts[1] || '';
          const effectName = effectRaw.replace(/^move:\s*/i, '').trim();
          formatted.push(`${effectName} ended.`);
          break;
        }
        case '-hitcount': {
          const target = parts[1]?.split(':')[1]?.trim();
          const count = Number(parts[2]) || 0;
          formatted.push(`Hit ${target} ${count} time${count !== 1 ? 's' : ''}!`);
          break;
        }
        case '-ohko':
          formatted.push("It's a one-hit KO!");
          break;
        case '-transform': {
          const pokemon = parts[1]?.split(':')[1]?.trim();
          const transformTarget = parts[2]?.split(':')[1]?.trim();
          formatted.push(`${pokemon} transformed into ${transformTarget}!`);
          break;
        }
        case '-terastallize': {
          const pokemon = parts[1]?.split(':')[1]?.trim();
          const teraType = parts[2] || '';
          formatted.push(`${pokemon} terastallized into ${teraType} type!`);
          break;
        }
      }
    }
    return formatted;
  }

  private buildTurnEvents(logs: string[]): BattleTurnEvent[] {
    const events: BattleTurnEvent[] = [];
    const hpByTarget = new Map<string, number>();

    for (const line of logs) {
      if (!line || line.startsWith('|request|')) continue;
      const parts = line.split('|').filter(Boolean);
      if (parts.length === 0) continue;

      const cmd = parts[0];
      switch (cmd) {
        case 'turn':
          events.push({ kind: 'turn', text: `Turn ${parts[1]}` });
          break;
        case 'switch': {
          const actor = parts[1]?.split(':')[1]?.trim();
          events.push({ kind: 'switch', text: `${actor} switched in.`, actor });
          break;
        }
        case 'drag': {
          const target = parts[1]?.split(':')[1]?.trim();
          events.push({ kind: 'drag', text: `${target} was dragged out.`, target });
          break;
        }
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
          const annotations = this.parseProtocolAnnotations(parts.slice(3));
          const previous = target ? hpByTarget.get(target) : undefined;
          const deltaPercent =
            typeof previous === 'number' && parsed.hpPercent !== null
              ? parsed.hpPercent - previous
              : undefined;
          if (target && parsed.hpPercent !== null) {
            hpByTarget.set(target, parsed.hpPercent);
          }
          if (parsed.fainted) {
            break;
          }
          events.push({
            kind: 'damage',
            text:
              annotations.description ||
              `${target} took damage${typeof deltaPercent === 'number' ? ` (${deltaPercent})` : ''}.`,
            target,
            hpPercent: parsed.hpPercent ?? undefined,
            status: parsed.status,
            deltaPercent,
            sourceType: annotations.sourceType,
            sourceName: annotations.sourceName,
            description: annotations.description,
          });
          break;
        }
        case '-heal': {
          const target = parts[1]?.split(':')[1]?.trim();
          const parsed = this.parseHpProtocolPercent(parts[2] || '');
          const annotations = this.parseProtocolAnnotations(parts.slice(3));
          const previous = target ? hpByTarget.get(target) : undefined;
          const deltaPercent =
            typeof previous === 'number' && parsed.hpPercent !== null
              ? parsed.hpPercent - previous
              : undefined;
          if (target && parsed.hpPercent !== null) {
            hpByTarget.set(target, parsed.hpPercent);
          }
          events.push({
            kind: 'heal',
            text:
              annotations.description ||
              (parsed.hpPercent !== null
                ? `${target} healed to ${parsed.hpPercent}%`
                : `${target} healed!`),
            target,
            hpPercent: parsed.hpPercent ?? undefined,
            status: parsed.status,
            deltaPercent,
            sourceType: annotations.sourceType,
            sourceName: annotations.sourceName,
            description: annotations.description,
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
          if (target) {
            hpByTarget.set(target, 0);
          }
          events.push({
            kind: 'faint',
            text: `${target} fainted!`,
            target,
            hpPercent: 0,
          });
          break;
        }
        case 'win':
          events.push({
            kind: 'win',
            text: `${parts[1]} won the battle!`,
            actor: parts[1],
          });
          break;
        case '-boost': {
          const target = parts[1]?.split(':')[1]?.trim();
          const stat = parts[2] || '';
          const amount = Number(parts[3]) || 1;
          const statName = this.formatStatName(stat);
          const desc = amount >= 3 ? 'rose drastically' : amount === 2 ? 'rose sharply' : 'rose';
          events.push({
            kind: 'boost',
            text: `${target}'s ${statName} ${desc}!`,
            target,
            stat,
            amount,
          });
          break;
        }
        case '-unboost': {
          const target = parts[1]?.split(':')[1]?.trim();
          const stat = parts[2] || '';
          const amount = Number(parts[3]) || 1;
          const statName = this.formatStatName(stat);
          const desc = amount >= 3 ? 'fell severely' : amount === 2 ? 'fell harshly' : 'fell';
          events.push({
            kind: 'unboost',
            text: `${target}'s ${statName} ${desc}!`,
            target,
            stat,
            amount,
          });
          break;
        }
        case '-item': {
          const target = parts[1]?.split(':')[1]?.trim();
          const itemName = parts[2] || '';
          const annotations = this.parseProtocolAnnotations(parts.slice(3));
          events.push({
            kind: 'item',
            text: annotations.sourceName
              ? `${target}'s ${itemName} was revealed by ${annotations.sourceName}!`
              : `${target} has ${itemName}!`,
            target,
            itemName,
            sourceType: annotations.sourceType,
            sourceName: annotations.sourceName,
            description: annotations.description,
          });
          break;
        }
        case '-enditem': {
          const target = parts[1]?.split(':')[1]?.trim();
          const itemName = parts[2] || '';
          const annotations = this.parseProtocolAnnotations(parts.slice(3));
          const eaten = parts.some(p => p === '[eat]');
          events.push({
            kind: 'enditem',
            text: eaten
              ? `${target} ate its ${itemName}!`
              : `${target} lost its ${itemName}!`,
            target,
            itemName,
            sourceType: annotations.sourceType,
            sourceName: annotations.sourceName,
            description: annotations.description,
          });
          break;
        }
        case '-ability': {
          const actor = parts[1]?.split(':')[1]?.trim();
          const abilityName = parts[2] || '';
          const annotations = this.parseProtocolAnnotations(parts.slice(3));
          events.push({
            kind: 'ability',
            text: annotations.sourceName
              ? `[${actor}'s ${abilityName}] (from ${annotations.sourceName})`
              : `[${actor}'s ${abilityName}]`,
            actor,
            abilityName,
            sourceType: annotations.sourceType,
            sourceName: annotations.sourceName,
          });
          break;
        }
        case '-weather': {
          const weatherName = parts[1] || 'none';
          const upkeep = parts.some(p => p === '[upkeep]');
          if (weatherName === 'none') {
            events.push({ kind: 'weather', text: 'The weather cleared.', effectName: 'none' });
          } else if (upkeep) {
            events.push({ kind: 'weather', text: `The ${this.formatWeatherName(weatherName)} continues.`, effectName: weatherName });
          } else {
            events.push({ kind: 'weather', text: `The weather became ${this.formatWeatherName(weatherName)}!`, effectName: weatherName });
          }
          break;
        }
        case '-immune': {
          const target = parts[1]?.split(':')[1]?.trim();
          events.push({
            kind: 'immune',
            text: `It doesn't affect ${target}...`,
            target,
          });
          break;
        }
        case '-curestatus': {
          const target = parts[1]?.split(':')[1]?.trim();
          const curedStatus = parts[2] || '';
          events.push({
            kind: 'curestatus',
            text: `${target} was cured of its ${this.formatStatusName(curedStatus)}!`,
            target,
            status: curedStatus,
          });
          break;
        }
        case '-cureteam': {
          const actor = parts[1]?.split(':')[1]?.trim();
          events.push({
            kind: 'curestatus',
            text: `${actor}'s team was cured of status conditions!`,
            actor,
          });
          break;
        }
        case '-sidestart': {
          const sideRaw = parts[1] || '';
          const side = sideRaw.includes('p1') ? 'p1' : 'p2';
          const effectRaw = parts[2] || '';
          const effectName = effectRaw.replace(/^move:\s*/i, '').trim();
          events.push({
            kind: 'sidestart',
            text: `${effectName} was set on ${side === 'p1' ? 'your' : "the opposing"} side!`,
            effectName,
            actor: sideRaw.split(':')[1]?.trim(),
          });
          break;
        }
        case '-sideend': {
          const sideRaw = parts[1] || '';
          const side = sideRaw.includes('p1') ? 'p1' : 'p2';
          const effectRaw = parts[2] || '';
          const effectName = effectRaw.replace(/^move:\s*/i, '').trim();
          events.push({
            kind: 'sideend',
            text: `${effectName} was removed from ${side === 'p1' ? 'your' : "the opposing"} side!`,
            effectName,
            actor: sideRaw.split(':')[1]?.trim(),
          });
          break;
        }
        case '-start': {
          const target = parts[1]?.split(':')[1]?.trim();
          const effectRaw = parts[2] || '';
          const effectName = effectRaw.replace(/^move:\s*/i, '').replace(/^ability:\s*/i, '').trim();
          events.push({
            kind: 'start',
            text: `${target} is affected by ${effectName}!`,
            target,
            effectName,
          });
          break;
        }
        case '-end': {
          const target = parts[1]?.split(':')[1]?.trim();
          const effectRaw = parts[2] || '';
          const effectName = effectRaw.replace(/^move:\s*/i, '').replace(/^ability:\s*/i, '').trim();
          events.push({
            kind: 'end',
            text: `${target}'s ${effectName} ended.`,
            target,
            effectName,
          });
          break;
        }
        case '-fieldstart': {
          const effectRaw = parts[1] || '';
          const effectName = effectRaw.replace(/^move:\s*/i, '').trim();
          events.push({
            kind: 'fieldstart',
            text: `${effectName} started!`,
            effectName,
          });
          break;
        }
        case '-fieldend': {
          const effectRaw = parts[1] || '';
          const effectName = effectRaw.replace(/^move:\s*/i, '').trim();
          events.push({
            kind: 'fieldend',
            text: `${effectName} ended.`,
            effectName,
          });
          break;
        }
        case '-hitcount': {
          const target = parts[1]?.split(':')[1]?.trim();
          const count = Number(parts[2]) || 0;
          events.push({
            kind: 'hitcount',
            text: `Hit ${target} ${count} time${count !== 1 ? 's' : ''}!`,
            target,
            amount: count,
          });
          break;
        }
        case '-block': {
          const target = parts[1]?.split(':')[1]?.trim();
          const effect = parts[2] || '';
          events.push({
            kind: 'block',
            text: `${target} blocked the attack with ${effect}!`,
            target,
            effectName: effect,
          });
          break;
        }
        case '-ohko':
          events.push({ kind: 'ohko', text: "It's a one-hit KO!" });
          break;
        case '-mustrecharge': {
          const target = parts[1]?.split(':')[1]?.trim();
          events.push({
            kind: 'cant',
            text: `${target} must recharge!`,
            target,
          });
          break;
        }
        case '-notarget':
          events.push({ kind: 'fail', text: 'But there was no target...' });
          break;
        case '-nothing':
          events.push({ kind: 'fail', text: 'But nothing happened!' });
          break;
        case '-setboost': {
          const target = parts[1]?.split(':')[1]?.trim();
          const stat = parts[2] || '';
          const amount = Number(parts[3]) || 0;
          events.push({
            kind: 'boost',
            text: `${target}'s ${this.formatStatName(stat)} was set to ${amount > 0 ? '+' : ''}${amount}!`,
            target,
            stat,
            amount,
          });
          break;
        }
        case '-swapboost': {
          const actor = parts[1]?.split(':')[1]?.trim();
          const target = parts[2]?.split(':')[1]?.trim();
          events.push({
            kind: 'boost',
            text: `${actor} swapped stat changes with ${target}!`,
            actor,
            target,
          });
          break;
        }
        case '-copyboost': {
          const actor = parts[1]?.split(':')[1]?.trim();
          const target = parts[2]?.split(':')[1]?.trim();
          events.push({
            kind: 'boost',
            text: `${actor} copied ${target}'s stat changes!`,
            actor,
            target,
          });
          break;
        }
        case '-clearboost': {
          const target = parts[1]?.split(':')[1]?.trim();
          events.push({
            kind: 'unboost',
            text: `${target}'s stat changes were cleared!`,
            target,
          });
          break;
        }
        case '-clearallboost':
          events.push({
            kind: 'unboost',
            text: 'All stat changes were reset!',
          });
          break;
        case '-transform': {
          const actor = parts[1]?.split(':')[1]?.trim();
          const target = parts[2]?.split(':')[1]?.trim();
          events.push({
            kind: 'activate',
            text: `${actor} transformed into ${target}!`,
            actor,
            target,
          });
          break;
        }
        case '-mega': {
          const actor = parts[1]?.split(':')[1]?.trim();
          const stone = parts[3] || '';
          events.push({
            kind: 'activate',
            text: stone ? `${actor} Mega Evolved using ${stone}!` : `${actor} Mega Evolved!`,
            actor,
          });
          break;
        }
        case '-terastallize': {
          const actor = parts[1]?.split(':')[1]?.trim();
          const teraType = parts[2] || '';
          events.push({
            kind: 'activate',
            text: `${actor} terastallized into ${teraType} type!`,
            actor,
          });
          break;
        }
        case '-singleturn': {
          const actor = parts[1]?.split(':')[1]?.trim();
          const moveName = (parts[2] || '').replace(/^move:\s*/i, '').trim();
          events.push({
            kind: 'activate',
            text: `${actor} protected itself with ${moveName}!`,
            actor,
            moveName,
          });
          break;
        }
        case '-singlemove': {
          const actor = parts[1]?.split(':')[1]?.trim();
          const moveName = (parts[2] || '').replace(/^move:\s*/i, '').trim();
          events.push({
            kind: 'activate',
            text: `${actor} is using ${moveName}!`,
            actor,
            moveName,
          });
          break;
        }
      }
    }

    return this.compactTurnEvents(events);
  }

  private compactTurnEvents(events: BattleTurnEvent[]): BattleTurnEvent[] {
    const compacted: BattleTurnEvent[] = [];
    const seen = new Set<string>();
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
      const key = [
        event.kind,
        event.actor || '',
        event.target || '',
        event.moveName || '',
        event.hpPercent ?? '',
        event.status || '',
        event.deltaPercent ?? '',
        event.sourceType || '',
        event.sourceName || '',
        event.text,
      ].join('|');
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      compacted.push(event);
    }
    return compacted;
  }

  private formatStatName(stat: string): string {
    const map: Record<string, string> = {
      atk: 'Attack',
      def: 'Defense',
      spa: 'Sp. Atk',
      spd: 'Sp. Def',
      spe: 'Speed',
      accuracy: 'accuracy',
      evasion: 'evasion',
    };
    return map[stat] || stat;
  }

  private formatWeatherName(weather: string): string {
    const map: Record<string, string> = {
      RainDance: 'rain',
      Sandstorm: 'a sandstorm',
      SunnyDay: 'harsh sunlight',
      Hail: 'hail',
      Snow: 'snow',
      PrimordialSea: 'heavy rain',
      DesolateLand: 'extremely harsh sunlight',
      DeltaStream: 'strong winds',
    };
    return map[weather] || weather.toLowerCase();
  }

  private formatStatusName(status: string): string {
    const map: Record<string, string> = {
      brn: 'burn',
      par: 'paralysis',
      psn: 'poison',
      tox: 'bad poison',
      slp: 'sleep',
      frz: 'freeze',
    };
    return map[status] || status;
  }

  private parseProtocolAnnotations(extraParts: string[]): {
    sourceType?: 'item' | 'ability' | 'status' | 'weather' | 'move' | 'other';
    sourceName?: string | null;
    description?: string;
  } {
    let fromRaw = '';
    for (const part of extraParts) {
      if (part.startsWith('[from] ')) {
        fromRaw = part.slice('[from] '.length).trim();
      }
    }
    if (!fromRaw) return {};

    if (fromRaw.startsWith('item:')) {
      const sourceName = fromRaw.replace(/^item:\s*/i, '').trim();
      return {
        sourceType: 'item',
        sourceName,
        description: sourceName ? `Recovered from item ${sourceName}.` : undefined,
      };
    }
    if (fromRaw.startsWith('ability:')) {
      const sourceName = fromRaw.replace(/^ability:\s*/i, '').trim();
      return {
        sourceType: 'ability',
        sourceName,
        description: sourceName ? `Recovered from ability ${sourceName}.` : undefined,
      };
    }
    if (fromRaw.startsWith('move:')) {
      const sourceName = fromRaw.replace(/^move:\s*/i, '').trim();
      return {
        sourceType: 'move',
        sourceName,
        description: sourceName ? `Effect from move ${sourceName}.` : undefined,
      };
    }
    if (/(sandstorm|hail|snow|raindance|sunnyday|desolateland|primordialsea)/i.test(fromRaw)) {
      return {
        sourceType: 'weather',
        sourceName: fromRaw,
        description: `Weather effect: ${fromRaw}.`,
      };
    }
    if (/(psn|tox|brn|slp|frz|par|poison|burn)/i.test(fromRaw)) {
      return {
        sourceType: 'status',
        sourceName: fromRaw,
        description: `Status effect: ${fromRaw}.`,
      };
    }
    return {
      sourceType: 'other',
      sourceName: fromRaw,
      description: `Effect: ${fromRaw}.`,
    };
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
      hpPercent:
        max > 0
          ? Math.max(0, Math.min(100, Math.round((current / max) * 100)))
          : null,
      status: statusMatch?.[1] ?? null,
      fainted: false,
    };
  }
}

interface BattleSideLike {
  active?: Array<{
    moveSlots?: Array<{ maxpp?: number }>;
    name?: string;
    boosts?: Record<string, number>;
    item?: string;
    ability?: string;
  }>;
  pokemon?: Array<{
    fullname?: string;
    name?: string;
    species?: { name?: string };
    position?: number;
    hp?: number;
    maxhp?: number;
    status?: string;
    fainted?: boolean;
    isActive?: boolean;
    item?: string;
    ability?: string;
    baseAbility?: string;
    set?: { item?: string };
  }>;
}

interface BattleWithDex {
  sides?: BattleSideLike[];
  dex?: {
    moves?: { get?: (idOrName: string) => { type?: string; basePower?: number } | undefined };
    getImmunity?: (source: string, target: unknown) => boolean;
    getEffectiveness?: (source: string, target: unknown) => number;
  };
}
