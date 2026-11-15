import { AxiosError, type AxiosResponse } from 'axios';
import { ReplaySubject } from 'rxjs';
import {
  FLY_CNS_RETRY_POLICY,
  RetryFailedError,
  isTransientHttpError,
  retryWithBackoff,
  type CpuRetryStreamEvent,
} from './ai-retry';
import type { BattleService, ShowdownLegalOptions } from './battle.service';
import { BattleSessionManager, type BattleState } from './battle-session.manager';
import type { CpuMoveAiService } from './cpu-move-ai.service';
import type { FlyCnsChoice, FlyCnsService } from './fly-cns.service';

function httpError(status: number, detail?: string): AxiosError {
  return new AxiosError(
    `Request failed with status code ${status}`,
    status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
    undefined,
    undefined,
    { status, data: detail ? { detail } : {} } as AxiosResponse
  );
}

function networkError(code = 'ECONNREFUSED'): AxiosError {
  return new AxiosError(`connect ${code} 127.0.0.1:8000`, code);
}

const modelChoice: FlyCnsChoice = {
  choice: 'move 2',
  action_index: 1,
  turn: 5,
  state_value: 0.25,
};

const legal = {
  allChoices: ['move 1', 'move 2', 'switch 2'],
} as unknown as ShowdownLegalOptions;

const fallbackAction = () => ({ choice: 'move 1', actionType: 'move' as const });

function setup(choose: jest.Mock) {
  const cpuMock = {
    getBattleStream: () => new ReplaySubject(),
    getDefaultModelId: () => 'test-model',
  } as unknown as CpuMoveAiService;
  const manager = new BattleSessionManager(
    {} as BattleService,
    cpuMock,
    { choose } as unknown as FlyCnsService
  );
  const internals = manager as unknown as {
    sessions: Map<string, unknown>;
    flyRetryPolicy: typeof FLY_CNS_RETRY_POLICY;
    chooseFlyCnsAction: (
      session: unknown,
      side: 'p1' | 'p2',
      legal: ShowdownLegalOptions,
      fallback: typeof fallbackAction
    ) => Promise<void>;
  };
  // Keep the real attempt count and budget, but don't wait 250 ms + 750 ms per test.
  internals.flyRetryPolicy = { ...FLY_CNS_RETRY_POLICY, delaysMs: [1, 1] };

  const session = {
    id: 'fly-retry-battle',
    formatid: 'gen9randombattle',
    currentTurn: 4,
    protocol: { linesFor: () => ['|init|battle'] },
    p2Choice: null as string | null,
    lastCpuDecision: null as BattleState['lastCpuDecision'],
    setChoice(_side: 'p1' | 'p2', choice: string) {
      this.p2Choice = choice;
    },
  };
  internals.sessions.set(session.id, session);

  const events: CpuRetryStreamEvent[] = [];
  manager
    .getCpuStream(session.id)
    .subscribe((event) => events.push(event as CpuRetryStreamEvent));

  const run = () =>
    internals.chooseFlyCnsAction(session, 'p2', legal, fallbackAction);
  return { session, events, run };
}

describe('Fly CNS retries', () => {
  it('uses the model choice when a transient failure is followed by success', async () => {
    const choose = jest
      .fn()
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce(modelChoice);
    const { session, events, run } = setup(choose);

    await run();

    expect(choose).toHaveBeenCalledTimes(2);
    expect(session.p2Choice).toBe('move 2');
    expect(session.lastCpuDecision).toMatchObject({
      choice: 'move 2',
      source: 'model',
      attempts: 2,
      turn: 5,
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'retry',
        side: 'p2',
        attempt: 2,
        maxAttempts: 3,
        turn: 5,
      }),
      expect.objectContaining({
        type: 'retry-settled',
        attempts: 2,
        source: 'model',
      }),
    ]);
  });

  it('falls back immediately on a 422 without retrying', async () => {
    const choose = jest
      .fn()
      .mockRejectedValue(httpError(422, 'Cannot choose: no request'));
    const { session, events, run } = setup(choose);

    await run();

    expect(choose).toHaveBeenCalledTimes(1);
    expect(session.p2Choice).toBe('move 1');
    expect(session.lastCpuDecision).toMatchObject({
      choice: 'move 1',
      source: 'fallback',
      attempts: 1,
      reasoning: 'Fallback action after Fly CNS error',
    });
    expect(session.lastCpuDecision?.error).toContain('Cannot choose: no request');
    expect(events).toEqual([]);
  });

  it('falls back after every attempt fails', async () => {
    const choose = jest.fn().mockRejectedValue(networkError());
    const { session, events, run } = setup(choose);

    await run();

    expect(choose).toHaveBeenCalledTimes(FLY_CNS_RETRY_POLICY.maxAttempts);
    expect(session.p2Choice).toBe('move 1');
    expect(session.lastCpuDecision).toMatchObject({
      choice: 'move 1',
      source: 'fallback',
      attempts: 3,
      reasoning: 'Fallback after 3 failed attempts',
    });
    expect(events.map((event) => event.type)).toEqual([
      'retry',
      'retry',
      'retry-settled',
    ]);
    expect(events[1]).toMatchObject({ type: 'retry', attempt: 3 });
    expect(events[2]).toMatchObject({ source: 'fallback', attempts: 3 });
  });

  it('does not retry an illegal model choice', async () => {
    const choose = jest
      .fn()
      .mockResolvedValue({ ...modelChoice, choice: 'move 4' });
    const { session, run } = setup(choose);

    await run();

    expect(choose).toHaveBeenCalledTimes(1);
    expect(session.lastCpuDecision).toMatchObject({
      choice: 'move 1',
      source: 'fallback',
      attempts: 1,
    });
    expect(session.lastCpuDecision?.error).toContain('not legal');
  });
});

describe('retryWithBackoff', () => {
  it('waits 250 ms then 750 ms between attempts', async () => {
    const waits: number[] = [];
    const attemptFn = jest.fn().mockRejectedValue(networkError('ETIMEDOUT'));

    const outcome = retryWithBackoff(attemptFn, FLY_CNS_RETRY_POLICY, {
      isRetryable: isTransientHttpError,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    await expect(outcome).rejects.toMatchObject({
      attempts: 3,
      reason: 'exhausted',
    });
    expect(waits).toEqual([250, 750]);
  });

  it('stops early and shortens attempts to fit the time budget', async () => {
    let clock = 0;
    const timeouts: number[] = [];
    const attemptFn = jest.fn(async ({ timeoutMs }: { timeoutMs: number }) => {
      timeouts.push(timeoutMs);
      clock += timeoutMs;
      throw networkError('ECONNABORTED');
    });

    const outcome = retryWithBackoff(attemptFn, FLY_CNS_RETRY_POLICY, {
      isRetryable: isTransientHttpError,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });

    await expect(outcome).rejects.toBeInstanceOf(RetryFailedError);
    await expect(outcome).rejects.toMatchObject({
      attempts: 2,
      reason: 'budget',
    });
    // 5000 ms timeout, 250 ms wait, then only 2750 ms of the 8000 ms budget is left.
    expect(timeouts).toEqual([5000, 2750]);
  });

  it('classifies network errors, timeouts and 5xx as transient', () => {
    expect(isTransientHttpError(networkError())).toBe(true);
    expect(isTransientHttpError(networkError('ECONNABORTED'))).toBe(true);
    expect(isTransientHttpError(httpError(500))).toBe(true);
    expect(isTransientHttpError(httpError(422))).toBe(false);
    expect(isTransientHttpError(httpError(404))).toBe(false);
    expect(isTransientHttpError(new Error('not legal'))).toBe(false);
  });
});
