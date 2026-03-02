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
  };
  p2Pokemon: {
    name: string;
    hp: number;
    maxHp: number;
    hpPercent: number;
    status: string | null;
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
  phase: 'team-preview' | 'awaiting-actions' | 'resolving' | 'ended';
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
  p1Choice: string | null = null;
  p2Choice: string | null = null;
  turnLog: string[] = [];
  currentTurn = 0;
  lastLogIndex = 0;
  lastAction: BattleState['lastAction'] = null;
  lastTurnEvents: BattleTurnEvent[] = [];
  lastCpuDecision: BattleState['lastCpuDecision'] = null;
  isResolving = false;

  constructor(id: string, battle: Battle) {
    this.id = id;
    this.battle = battle;
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
        return await this.processTurn(battleId, requests);
      }

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

  private async processTurn(
    battleId: string,
    requests: { p1: ShowdownRequest; p2: ShowdownRequest }
  ): Promise<BattleState> {
    const session = this.sessions.get(battleId);
    if (!session) {
      throw new NotFoundException('Battle not found');
    }

    const p1Choice =
      session.p1Choice ?? this.pickDefaultChoice(this.battleService.getLegalOptionsForRequest(requests.p1));
    const p2Choice =
      session.p2Choice ?? this.pickDefaultChoice(this.battleService.getLegalOptionsForRequest(requests.p2));

    try {
      const stepResult = this.battleService.step(battleId, p1Choice, p2Choice);
      const newLogs = stepResult.rawLogDelta;
      const formattedNewLogs = this.formatRecentLog(newLogs);

      session.lastTurnEvents = this.buildTurnEvents(newLogs);
      session.turnLog.push(...formattedNewLogs);
      session.lastLogIndex = session.battle.log.length;
      session.currentTurn =
        (session.battle as unknown as { turn?: number }).turn ??
        session.currentTurn + 1;
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

    const phase: BattleState['phase'] = battle.ended
      ? 'ended'
      : p1Legal.teamPreview || p2Legal.teamPreview
        ? 'team-preview'
        : session.isResolving
          ? 'resolving'
          : 'awaiting-actions';

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
      },
      p2Pokemon: {
        name: p2Side.active?.name || 'Unknown',
        hp: p2Side.active?.hp || 0,
        maxHp: p2Side.active?.maxHp || 100,
        hpPercent: p2Side.active?.hpPercent || 0,
        status: p2Side.active?.status || null,
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
      phase,
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
      };
    });
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
      }
    }
    return formatted;
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
          events.push({
            kind: 'damage',
            text: parsed.fainted
              ? `${target} fainted!`
              : `${target} HP ${parsed.hpPercent}%`,
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
            text:
              parsed.hpPercent !== null
                ? `${target} healed to ${parsed.hpPercent}%`
                : `${target} healed!`,
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
