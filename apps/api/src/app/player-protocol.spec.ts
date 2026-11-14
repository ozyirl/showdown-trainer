import { Battle, Teams } from 'pokemon-showdown';
import { PlayerProtocolRecorder, playerView } from './player-protocol';

describe('PlayerProtocolRecorder', () => {
  function startBattle(): { battle: Battle; recorder: PlayerProtocolRecorder } {
    const recorder = new PlayerProtocolRecorder((): string[] => battle.log);
    const battle = new Battle({
      formatid: 'gen9randombattle',
      send: recorder.send,
    });
    const team = () => Teams.pack(Teams.generate('gen9randombattle'));
    battle.setPlayer('p1', { name: 'Player 1', team: team() });
    battle.setPlayer('p2', { name: 'CPU', team: team() });
    return { battle, recorder };
  }

  it('puts the log written so far before each request, as a server does', () => {
    const { battle, recorder } = startBattle();
    battle.choose('p1', 'move 1');
    battle.choose('p2', 'move 1');

    const lines = recorder.linesFor('p2');
    const requests = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.startsWith('|request|'));

    expect(lines).toContain('|player|p2|CPU||');
    expect(requests).toHaveLength(2);
    expect(lines.indexOf('|turn|1')).toBeLessThan(requests[0].index);
    expect(lines.indexOf('|turn|2')).toBeLessThan(requests[1].index);
    expect(lines.at(-1)).toBe(requests[1].line);
    expect(JSON.parse(requests[1].line.slice('|request|'.length)).side.id).toBe(
      'p2'
    );
  });

  it("keeps each player's own requests and hidden information to themselves", () => {
    const { recorder } = startBattle();

    const p1 = recorder.linesFor('p1');
    const p2 = recorder.linesFor('p2');
    const ownSwitch = (lines: string[], side: string) =>
      lines.find((line) => line.startsWith(`|switch|${side}a:`)) ?? '';

    expect(p1.filter((line) => line.startsWith('|request|'))).toHaveLength(1);
    expect(p2.filter((line) => line.startsWith('|request|'))).toHaveLength(1);
    expect(p1.some((line) => line.startsWith('|split|'))).toBe(false);
    // Each player sees exact HP for its own Pokemon and a percentage for the opponent's.
    expect(ownSwitch(p2, 'p2')).not.toMatch(/\|100\/100$/);
    expect(ownSwitch(p1, 'p2')).toMatch(/\|100\/100$/);
  });

  it('resolves split blocks for the named side only', () => {
    const log = [
      '|split|p2',
      '|-heal|p2a: A|150/300',
      '|-heal|p2a: A|50/100',
      '|turn|3',
    ];

    expect(playerView(log, 'p2')).toEqual(['|-heal|p2a: A|150/300', '|turn|3']);
    expect(playerView(log, 'p1')).toEqual(['|-heal|p2a: A|50/100', '|turn|3']);
  });
});
