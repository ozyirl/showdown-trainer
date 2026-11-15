import { generateText } from 'ai';
import { CopilotService } from './copilot.service';
import type { BattleSessionManager } from './battle-session.manager';
import type { BattleService, ShowdownRequest } from './battle.service';
import { resolveCopilotModelId } from './model-utils';

jest.mock('ai', () => ({
  ...jest.requireActual('ai'),
  generateText: jest.fn(),
}));

jest.mock('./model-utils', () => ({
  ...jest.requireActual('./model-utils'),
  createModel: jest.fn(() => 'mock-model'),
}));

function createBattleSessionManager(session: {
  copilotEnabled: boolean;
  copilotMode: 'off' | 'coach' | 'deep';
}) {
  const request: ShowdownRequest = {
    active: [{ moves: [{ move: 'Thunderbolt', id: 'thunderbolt', pp: 24 }] }],
    side: {
      pokemon: [
        { ident: 'p1: Pikachu', active: true, condition: '100/100' },
        { ident: 'p1: Bulbasaur', active: false, condition: '100/100' },
      ],
    },
  };

  const battleService = {
    getRequests: jest.fn().mockReturnValue({ p1: request, p2: request }),
    getLegalOptionsForRequest: jest.fn().mockReturnValue({
      moveChoices: ['move 1'],
      switchChoices: ['switch 2'],
    }),
  } as unknown as BattleService;

  const battleSessionManager = {
    getSessionForCopilot: jest.fn().mockReturnValue({
      battle: {
        sides: [
          {
            active: [{ name: 'Pikachu', types: ['Electric'], boosts: {} }],
            pokemon: [
              {
                name: 'Pikachu',
                isActive: true,
                hp: 100,
                maxhp: 100,
                level: 50,
                status: '',
                fainted: false,
                set: { item: '', ability: 'Static' },
                item: '',
                ability: 'Static',
                baseAbility: 'Static',
                position: 0,
              },
              {
                name: 'Bulbasaur',
                isActive: false,
                hp: 100,
                maxhp: 100,
                level: 50,
                status: '',
                fainted: false,
                set: { item: '', ability: 'Overgrow' },
                item: '',
                ability: 'Overgrow',
                baseAbility: 'Overgrow',
                position: 1,
              },
            ],
            sideConditions: {},
          },
          {
            active: [{ name: 'Squirtle', types: ['Water'], boosts: {} }],
            pokemon: [
              {
                name: 'Squirtle',
                isActive: true,
                hp: 100,
                maxhp: 100,
                level: 50,
                status: '',
                fainted: false,
                set: { item: '', ability: 'Torrent' },
                item: '',
                ability: 'Torrent',
                baseAbility: 'Torrent',
                position: 0,
              },
            ],
            sideConditions: {},
          },
        ],
        field: {
          pseudoWeather: {},
        },
        dex: {
          moves: {
            get: jest.fn().mockReturnValue({
              type: 'Electric',
              basePower: 90,
              category: 'Special',
            }),
          },
        },
      },
      session: {
        currentTurn: 3,
        turnLog: ['Turn 3'],
        lastTurnEvents: [],
        phase: 'awaiting-actions',
        ...session,
      },
      battleService,
    }),
  } as unknown as BattleSessionManager;

  return battleSessionManager;
}

describe('CopilotService', () => {
  afterEach(() => {
    jest.mocked(generateText).mockReset();
  });

  it('returns a disabled sentinel without calling the llm path', async () => {
    const battleSessionManager = createBattleSessionManager({
      copilotEnabled: false,
      copilotMode: 'off',
    });

    const service = new CopilotService(battleSessionManager);
    const guidance = await service.getCopilotGuidance('battle-disabled');

    expect(guidance).toEqual({
      disabled: true,
      recommendedAction: '',
      recommendedLabel: '',
      confidence: 'low',
      reasoning: '',
      safeAlternative: null,
      aggressiveAlternative: null,
      mainRisk: '',
      winConditionNote: '',
    });
    expect(battleSessionManager.getSessionForCopilot).toHaveBeenCalledWith(
      'battle-disabled'
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  it('reports the coach model, mode and latency with the guidance', async () => {
    jest.mocked(generateText).mockResolvedValue({
      text: JSON.stringify({
        recommendedAction: 'move 1',
        recommendedLabel: 'Thunderbolt',
        confidence: 'high',
        reasoning: 'Thunderbolt is super effective on Squirtle.',
        safeAlternative: null,
        aggressiveAlternative: null,
        mainRisk: 'Squirtle survives and retaliates.',
        winConditionNote: 'Pikachu outspeeds the opposing team.',
      }),
    } as Awaited<ReturnType<typeof generateText>>);

    const service = new CopilotService(
      createBattleSessionManager({ copilotEnabled: true, copilotMode: 'deep' })
    );
    const guidance = await service.getCopilotGuidance('battle-coach');

    expect(guidance).toMatchObject({
      recommendedAction: 'move 1',
      modelId: resolveCopilotModelId('deep'),
      copilotMode: 'deep',
      source: 'model',
    });
    expect(guidance.latencyMs).toEqual(expect.any(Number));
  });

  it('marks fallback guidance when the coach call fails', async () => {
    jest.mocked(generateText).mockRejectedValue(new Error('provider down'));

    const service = new CopilotService(
      createBattleSessionManager({ copilotEnabled: true, copilotMode: 'coach' })
    );
    const guidance = await service.getCopilotGuidance('battle-fallback');

    expect(guidance).toMatchObject({
      confidence: 'low',
      modelId: resolveCopilotModelId('coach'),
      copilotMode: 'coach',
      source: 'fallback',
    });
  });
});
