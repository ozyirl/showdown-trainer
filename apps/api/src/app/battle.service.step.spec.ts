import { BattleService, type ShowdownRequest } from './battle.service';

describe('BattleService.step', () => {
  function makeMoveRequest(): ShowdownRequest {
    return {
      active: [
        {
          moves: [
            { move: 'Shadow Ball', pp: 24, disabled: false },
            { move: 'Focus Blast', pp: 0, disabled: false },
            { move: 'Protect', pp: 16, disabled: 'disabled' },
            { move: 'Thunderbolt', pp: 24, disabled: false },
          ],
        },
      ],
    };
  }

  it('submits choose for both sides before reading appended logs', () => {
    const service = new BattleService();
    const callOrder: string[] = [];
    const rawLog = ['|start|'];

    const battle = {
      ended: false,
      winner: undefined as string | undefined,
      sides: [
        { activeRequest: makeMoveRequest() },
        { activeRequest: makeMoveRequest() },
      ],
      choose: (side: 'p1' | 'p2', choice: string) => {
        callOrder.push(`choose:${side}:${choice}`);
        if (callOrder.filter((entry) => entry.startsWith('choose:')).length === 2) {
          rawLog.push('|turn|1', '|move|p1a: Gengar|Shadow Ball|p2a: Charizard');
        }
      },
      get log() {
        callOrder.push('read-log');
        return rawLog;
      },
    };

    service.registerBattleSession('battle-test', battle as never, 1);

    const result = service.step('battle-test', 'default', 'default');

    expect(result.rawLogDelta).toEqual([
      '|turn|1',
      '|move|p1a: Gengar|Shadow Ball|p2a: Charizard',
    ]);
    expect(callOrder).toEqual([
      'choose:p1:move 1',
      'choose:p2:move 1',
      'read-log',
      'read-log',
    ]);
  });

  it('uses a legal forced switch when default is provided', () => {
    const service = new BattleService();
    const chosen: string[] = [];
    const emptyLog: string[] = [];

    const forceSwitchRequest: ShowdownRequest = {
      forceSwitch: [true],
      side: {
        pokemon: [
          { ident: 'p1: Lead', active: true, condition: '100/100' },
          { ident: 'p1: Bench1', active: false, condition: '100/100' },
          { ident: 'p1: Bench2', active: false, condition: '0 fnt' },
        ],
      },
    };

    const battle = {
      ended: false,
      winner: undefined as string | undefined,
      sides: [
        { activeRequest: forceSwitchRequest },
        { activeRequest: makeMoveRequest() },
      ],
      choose: (side: 'p1' | 'p2', choice: string) => {
        chosen.push(`${side}:${choice}`);
      },
      log: emptyLog,
    };

    service.registerBattleSession('battle-force-switch', battle as never, 0);
    service.step('battle-force-switch', 'default', 'default');

    expect(chosen[0]).toBe('p1:switch 2');
    expect(chosen[1]).toBe('p2:move 1');
  });
});

