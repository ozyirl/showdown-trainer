import { BadRequestException } from '@nestjs/common';
import { BattleService, type ShowdownRequest } from './battle.service';
import { BattleSessionManager } from './battle-session.manager';
import { CpuMoveAiService } from './cpu-move-ai.service';

describe('BattleSessionManager 6v6 flow', () => {
  let battleService: BattleService;
  let cpuMoveAiService: CpuMoveAiService;
  let manager: BattleSessionManager;

  beforeEach(() => {
    process.env.ENABLE_CPU_AI = 'false';
    battleService = new BattleService();
    cpuMoveAiService = new CpuMoveAiService();
    manager = new BattleSessionManager(battleService, cpuMoveAiService);
  });

  async function ackUntilSettled(
    battleManager: BattleSessionManager,
    battleId: string,
    state: { awaitingAckEventSeq: number | null }
  ) {
    let current = state;
    let guard = 0;
    while (current.awaitingAckEventSeq !== null && guard < 100) {
      guard++;
      current = (await battleManager.ackEvent(
        battleId,
        current.awaitingAckEventSeq
      )) as unknown as typeof current;
    }
    return current;
  }

  it('initializes 6 pokemon on each side by default', async () => {
    const state = await manager.createBattle();

    expect(state.sides.p1.team).toHaveLength(6);
    expect(state.sides.p2.team).toHaveLength(6);
    expect(state.sides.p1.active).toBeTruthy();
    expect(state.sides.p2.active).toBeTruthy();
  });

  it('generates seeded random teams instead of dex-first static teams', async () => {
    const config = {
      randomTeams: true,
      randomTeamFormatid: 'gen9randombattle',
      randomSeed: [1, 2, 3, 4],
    };
    const stateA = await manager.createBattle(config);
    const stateB = await manager.createBattle(config);
    const stateC = await manager.createBattle({
      ...config,
      randomSeed: [9, 10, 11, 12],
    });

    const p1A = stateA.sides.p1.team.map((pokemon) => pokemon.name);
    const p1B = stateB.sides.p1.team.map((pokemon) => pokemon.name);
    const p1C = stateC.sides.p1.team.map((pokemon) => pokemon.name);

    expect(p1A).toEqual(p1B);
    expect(p1A).not.toEqual(p1C);
    expect(p1A).not.toEqual([
      'Bulbasaur',
      'Ivysaur',
      'Venusaur',
      'Charmander',
      'Charmeleon',
      'Charizard',
    ]);
  });

  it('exposes legal switches when bench pokemon are available', async () => {
    const state = await manager.createBattle();

    expect(state.availableSwitches.length).toBeGreaterThan(0);
    for (const option of state.availableSwitches) {
      expect(option.choice.startsWith('switch ')).toBe(true);
      expect(option.isActive).toBe(false);
      expect(option.fainted).toBe(false);
    }
  });

  it('rejects illegal actions with legal options included', async () => {
    const state = await manager.createBattle();

    await expect(
      manager.submitAction(state.battleId, 'p1', 'move 99')
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        legalOptions: expect.any(Array),
      }),
    });
  });

  it('resolves simultaneous turn choices and appends turn events/logs', async () => {
    const state = await manager.createBattle();
    const firstMoveChoice = state.availableMoves[0]?.choice ?? 'move 1';

    const unresolved = await manager.submitAction(state.battleId, 'p1', firstMoveChoice);
    const next = await ackUntilSettled(manager, state.battleId, unresolved);

    expect(next.currentTurn).toBeGreaterThanOrEqual(1);
    expect(next.lastTurnEvents.length).toBeGreaterThan(0);
    expect(next.turnLog.length).toBeGreaterThan(0);
  });

  it('requires a switch action for forced switch requests', () => {
    const forceSwitchRequest: ShowdownRequest = {
      forceSwitch: [true],
      side: {
        pokemon: [
          { ident: 'p1: A', active: true, condition: '0 fnt' },
          { ident: 'p1: B', active: false, condition: '100/100' },
        ],
      },
    };

    expect(() =>
      battleService.normalizeAndValidateChoice(forceSwitchRequest, 'move 1')
    ).toThrow(BadRequestException);

    expect(
      battleService.normalizeAndValidateChoice(forceSwitchRequest, 'switch 2')
    ).toBe('switch 2');
  });

  it('does not deadlock when one side is waiting and the other acts', async () => {
    const battleServiceMock = {
      getRequests: jest
        .fn()
        .mockReturnValue({
          p1: {
            active: [
              { moves: [{ move: 'Tackle', pp: 32, disabled: false }] },
            ],
            side: { pokemon: [{ active: true, condition: '100/100' }] },
          },
          p2: { wait: true },
        }),
      getLegalOptionsForRequest: jest
        .fn()
        .mockImplementation((request: ShowdownRequest) => {
          if (request.wait) {
            return {
              needsChoice: false,
              wait: true,
              teamPreview: false,
              forceSwitch: false,
              moveChoices: [],
              switchChoices: [],
              allChoices: ['default'],
            };
          }
          return {
            needsChoice: true,
            wait: false,
            teamPreview: false,
            forceSwitch: false,
            moveChoices: ['move 1'],
            switchChoices: [],
            allChoices: ['move 1'],
          };
        }),
      step: jest.fn().mockReturnValue({
        rawLogDelta: ['|turn|1'],
        requests: {
          p1: {
            active: [{ moves: [{ move: 'Tackle', pp: 31, disabled: false }] }],
            side: { pokemon: [{ active: true, condition: '100/100' }] },
          },
          p2: { wait: true },
        },
        ended: false,
      }),
      unregisterBattleSession: jest.fn(),
    } as unknown as BattleService;

    const cpuMock = {
      getDefaultModelId: () => 'test-model',
      chooseCpuMove: jest.fn(),
    } as unknown as CpuMoveAiService;

    const localManager = new BattleSessionManager(battleServiceMock, cpuMock);
    const fakeSession = {
      id: 'fake-battle',
      battle: {
        ended: false,
        winner: null,
        log: ['|start|', '|turn|1'],
        sides: [
          { pokemon: [], active: [{ moveSlots: [{ maxpp: 32 }] }] },
          { pokemon: [], active: [{ moveSlots: [] }] },
        ],
      },
      p1Choice: null as string | null,
      p2Choice: null as string | null,
      turnLog: [] as string[],
      currentTurn: 0,
      lastLogIndex: 0,
      lastAction: null,
      lastTurnEvents: [],
      lastCpuDecision: null,
      isResolving: false,
      phase: 'awaiting-actions',
      eventLog: [],
      pendingPlaybackEvents: [],
      nextEventSeq: 1,
      awaitingAckEventSeq: null as number | null,
      hasChoice(player: 'p1' | 'p2') {
        return player === 'p1' ? this.p1Choice !== null : this.p2Choice !== null;
      },
      setChoice(player: 'p1' | 'p2', choice: string) {
        if (player === 'p1') this.p1Choice = choice;
        else this.p2Choice = choice;
      },
      clearChoices() {
        this.p1Choice = null;
        this.p2Choice = null;
      },
    };

    (localManager as unknown as { sessions: Map<string, unknown> }).sessions.set(
      'fake-battle',
      fakeSession
    );

    const unresolved = await localManager.submitAction('fake-battle', 'p1', 'move 1');
    const result = await ackUntilSettled(localManager, 'fake-battle', unresolved);

    expect(result.phase).toBe('awaiting-actions');
    expect(fakeSession.isResolving).toBe(false);
    expect(battleServiceMock.step).toHaveBeenCalled();
  });

  it('pauses on cpu forced switch after faint and continues in a separate step', async () => {
    const realBattleService = new BattleService();
    const reqMoveVsMove: ShowdownRequest = {
      active: [{ moves: [{ move: 'Tackle', pp: 32, disabled: false }] }],
      side: {
        pokemon: [
          { ident: 'p1: A', active: true, condition: '100/100' },
          { ident: 'p1: B', active: false, condition: '100/100' },
        ],
      },
    };
    const reqCpuForceSwitch: ShowdownRequest = {
      wait: true,
      side: {
        pokemon: [{ ident: 'p1: A', active: true, condition: '100/100' }],
      },
    };
    const reqCpuForceSwitchP2: ShowdownRequest = {
      forceSwitch: [true],
      side: {
        pokemon: [
          { ident: 'p2: KO', active: true, condition: '0 fnt' },
          { ident: 'p2: Bench', active: false, condition: '100/100' },
        ],
      },
    };
    const reqPostSwitch: ShowdownRequest = {
      active: [{ moves: [{ move: 'Tackle', pp: 30, disabled: false }] }],
      side: {
        pokemon: [{ ident: 'p1: A', active: true, condition: '100/100' }],
      },
    };
    const reqPostSwitchP2: ShowdownRequest = {
      wait: true,
      side: {
        pokemon: [
          { ident: 'p2: Bench', active: true, condition: '100/100' },
          { ident: 'p2: KO', active: false, condition: '0 fnt' },
        ],
      },
    };

    let phase = 0;
    const stepCalls: Array<{ p1: string; p2: string }> = [];
    const battleServiceMock = {
      getRequests: jest.fn().mockImplementation(() => {
        if (phase === 0) return { p1: reqMoveVsMove, p2: reqMoveVsMove };
        if (phase === 1) return { p1: reqCpuForceSwitch, p2: reqCpuForceSwitchP2 };
        return { p1: reqPostSwitch, p2: reqPostSwitchP2 };
      }),
      getLegalOptionsForRequest: realBattleService.getLegalOptionsForRequest.bind(
        realBattleService
      ),
      step: jest.fn().mockImplementation((_battleId: string, p1: string, p2: string) => {
        stepCalls.push({ p1, p2 });
        if (phase === 0) {
          phase = 1;
          return {
            rawLogDelta: ['|faint|p2a: KO'],
            requests: { p1: reqCpuForceSwitch, p2: reqCpuForceSwitchP2 },
            ended: false,
          };
        }
        phase = 2;
        return {
          rawLogDelta: ['|switch|p2a: Bench|Bench, L50|100/100'],
          requests: { p1: reqPostSwitch, p2: reqPostSwitchP2 },
          ended: false,
        };
      }),
      unregisterBattleSession: jest.fn(),
    } as unknown as BattleService;

    const cpuMock = {
      getDefaultModelId: () => 'test-model',
      chooseCpuAction: jest.fn(),
      chooseCpuMove: jest.fn(),
    } as unknown as CpuMoveAiService;

    const localManager = new BattleSessionManager(battleServiceMock, cpuMock);
    const fakeSession = {
      id: 'fake-battle-switch',
      battle: {
        ended: false,
        winner: null,
        log: [],
        sides: [
          {
            pokemon: [{ name: 'A', position: 0, hp: 100, maxhp: 100, isActive: true }],
            active: [{ moveSlots: [{ maxpp: 32 }] }],
          },
          {
            pokemon: [
              { name: 'KO', position: 0, hp: 0, maxhp: 100, fainted: true, isActive: false },
              { name: 'Bench', position: 1, hp: 100, maxhp: 100, isActive: true },
            ],
            active: [{ moveSlots: [] }],
          },
        ],
      },
      p1Choice: null as string | null,
      p2Choice: null as string | null,
      turnLog: [] as string[],
      currentTurn: 0,
      lastLogIndex: 0,
      lastAction: null,
      lastTurnEvents: [],
      lastCpuDecision: null,
      isResolving: false,
      phase: 'awaiting-actions',
      eventLog: [],
      pendingPlaybackEvents: [],
      nextEventSeq: 1,
      awaitingAckEventSeq: null as number | null,
      hasChoice(player: 'p1' | 'p2') {
        return player === 'p1' ? this.p1Choice !== null : this.p2Choice !== null;
      },
      setChoice(player: 'p1' | 'p2', choice: string) {
        if (player === 'p1') this.p1Choice = choice;
        else this.p2Choice = choice;
      },
      clearChoices() {
        this.p1Choice = null;
        this.p2Choice = null;
      },
    };

    (localManager as unknown as { sessions: Map<string, unknown> }).sessions.set(
      'fake-battle-switch',
      fakeSession
    );

    const unresolvedPaused = await localManager.submitAction(
      'fake-battle-switch',
      'p1',
      'move 1'
    );
    const paused = await ackUntilSettled(
      localManager,
      'fake-battle-switch',
      unresolvedPaused
    );
    expect(paused.phase).toBe('awaiting-forced-switch-p2');
    expect(paused.pendingPlayers).toContain('p2');

    const unresolvedResumed = await localManager.continueBattle('fake-battle-switch');
    const resumed = await ackUntilSettled(
      localManager,
      'fake-battle-switch',
      unresolvedResumed
    );

    expect(stepCalls[0]).toEqual({ p1: 'move 1', p2: 'move 1' });
    expect(stepCalls[1]).toEqual({ p1: 'default', p2: 'switch 2' });
    expect(resumed.phase).toBe('awaiting-actions');
  });

  it('records ordered playback events and supports incremental fetch', async () => {
    const state = await manager.createBattle();
    const firstMoveChoice = state.availableMoves[0]?.choice ?? 'move 1';
    const unresolved = await manager.submitAction(state.battleId, 'p1', firstMoveChoice);
    const nextState = await ackUntilSettled(manager, state.battleId, unresolved);

    expect(nextState.eventCursor).toBeGreaterThan(0);

    const allEvents = manager.getBattleEvents(state.battleId, 0, 200);
    expect(allEvents.length).toBeGreaterThan(0);
    for (let i = 1; i < allEvents.length; i++) {
      expect(allEvents[i].seq).toBe(allEvents[i - 1].seq + 1);
    }

    const tailEvents = manager.getBattleEvents(
      state.battleId,
      allEvents[0].seq,
      200
    );
    if (allEvents.length > 1) {
      expect(tailEvents[0].seq).toBe(allEvents[1].seq);
    }
  });

  it('cpu chooses legal action for move and switch phases', async () => {
    const state = await manager.createBattle();
    const session = (manager as unknown as { sessions: Map<string, unknown> }).sessions.get(
      state.battleId
    ) as {
      p2Choice: string | null;
      currentTurn: number;
      lastCpuDecision: { choice: string } | null;
      setChoice: (player: 'p1' | 'p2', choice: string) => void;
    };

    const moveRequest = battleService.getRequests(state.battleId);
    await (manager as unknown as {
      tryChooseCpuAction: (
        sessionArg: unknown,
        requests: { p1: ShowdownRequest; p2: ShowdownRequest }
      ) => Promise<void>;
    }).tryChooseCpuAction(session, moveRequest);

    expect(session.p2Choice).toMatch(/^move\s+\d+$/);

    session.setChoice('p2', 'default');
    const switchRequest: ShowdownRequest = {
      forceSwitch: [true],
      side: {
        pokemon: [
          { ident: 'p2: A', active: true, condition: '0 fnt' },
          { ident: 'p2: B', active: false, condition: '100/100' },
          { ident: 'p2: C', active: false, condition: '50/100 brn' },
        ],
      },
    };

    await (manager as unknown as {
      tryChooseCpuAction: (
        sessionArg: unknown,
        requests: { p1: ShowdownRequest; p2: ShowdownRequest }
      ) => Promise<void>;
    }).tryChooseCpuAction(session, { p1: moveRequest.p1, p2: switchRequest });

    expect(session.lastCpuDecision?.choice).toMatch(/^switch\s+\d+$/);
    expect(session.lastCpuDecision?.choice).toBe('switch 2');
  });
});
