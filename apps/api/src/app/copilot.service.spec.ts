import { CopilotService } from './copilot.service';
import type { BattleSessionManager } from './battle-session.manager';
import type { BattleService, ShowdownRequest } from './battle.service';

describe('CopilotService', () => {
  it('returns a disabled sentinel without calling the llm path', async () => {
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
          copilotEnabled: false,
          copilotMode: 'off',
        },
        battleService,
      }),
    } as unknown as BattleSessionManager;

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
  });
});
