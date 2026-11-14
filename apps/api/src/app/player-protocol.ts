type Side = 'p1' | 'p2';

/**
 * Records each player's view of a battle in the order a Showdown server delivers it.
 *
 * `Battle` emits requests through its `send` hook but only appends its log to
 * `battle.log`. A server sends the log first and the request after it, so the log
 * written so far is added to both views before each request.
 */
export class PlayerProtocolRecorder {
  private readonly lines: Record<Side, string[]> = { p1: [], p2: [] };
  private logIndex = 0;

  constructor(private readonly getLog: () => readonly string[]) {}

  /** Pass as the `send` option of a `Battle`. */
  readonly send = (type: string, data: string | string[]): void => {
    if (type !== 'sideupdate') return;
    const [side, ...messages] = (
      Array.isArray(data) ? data.join('\n') : data
    ).split('\n');
    if (side !== 'p1' && side !== 'p2') return;
    this.flushLog();
    this.lines[side].push(...messages);
  };

  /** The protocol lines `side` has received so far. */
  linesFor(side: Side): string[] {
    this.flushLog();
    return [...this.lines[side]];
  }

  private flushLog(): void {
    const log = this.getLog();
    const added = log.slice(this.logIndex);
    this.logIndex = log.length;
    this.lines.p1.push(...playerView(added, 'p1'));
    this.lines.p2.push(...playerView(added, 'p2'));
  }
}

/** Resolve `|split|<side>` blocks: that side sees the secret line, everyone else the public one. */
export function playerView(log: readonly string[], side: Side): string[] {
  const view: string[] = [];
  for (let index = 0; index < log.length; index++) {
    const line = log[index];
    if (line.startsWith('|split|')) {
      view.push(
        line.slice('|split|'.length) === side ? log[index + 1] : log[index + 2]
      );
      index += 2;
    } else {
      view.push(line);
    }
  }
  return view;
}
