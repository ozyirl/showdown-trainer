import axios from 'axios';

/** How often, and for how long, to retry a CPU model call before falling back. */
export interface RetryPolicy {
  /** Total attempts, including the first one. */
  maxAttempts: number;
  /** Wait before attempt 2, 3, ... The last entry repeats if there are more attempts. */
  delaysMs: readonly number[];
  /** Wall-clock budget for all attempts and waits together, so a turn never hangs. */
  budgetMs: number;
  /** Upper bound for a single attempt; the remaining budget can shorten it. */
  attemptTimeoutMs: number;
  /** Don't start another attempt with less time than this left in the budget. */
  minAttemptMs: number;
}

export const FLY_CNS_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  delaysMs: [250, 750],
  budgetMs: 8000,
  attemptTimeoutMs: 5000,
  minAttemptMs: 500,
};

/** Live retry status for the CPU stream; the frontend shows it while a turn waits. */
export type CpuRetryStreamEvent =
  | {
      type: 'retry';
      side: 'p1' | 'p2';
      turn: number;
      modelId: string;
      /** The attempt about to start (2 means "Retrying (2/3)"). */
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      error: string;
    }
  | {
      type: 'retry-settled';
      side: 'p1' | 'p2';
      turn: number;
      modelId: string;
      attempts: number;
      maxAttempts: number;
      source: 'model' | 'fallback';
      error?: string;
    };

export type RetryStopReason = 'non-retryable' | 'exhausted' | 'budget';

export class RetryFailedError extends Error {
  constructor(
    readonly lastError: unknown,
    readonly attempts: number,
    readonly reason: RetryStopReason
  ) {
    super(describeError(lastError));
    this.name = 'RetryFailedError';
  }
}

export interface RetryHooks {
  isRetryable: (error: unknown) => boolean;
  /** Called before waiting for the next attempt. */
  onRetry?: (info: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    error: unknown;
  }) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `attemptFn` until it succeeds, a non-retryable error occurs, the attempts
 * run out, or the time budget can't fit another attempt.
 * Throws RetryFailedError carrying the last error and the attempt count.
 */
export async function retryWithBackoff<T>(
  attemptFn: (context: { attempt: number; timeoutMs: number }) => Promise<T>,
  policy: RetryPolicy,
  hooks: RetryHooks
): Promise<{ value: T; attempts: number }> {
  const sleep = hooks.sleep ?? defaultSleep;
  const now = hooks.now ?? Date.now;
  const deadline = now() + policy.budgetMs;
  const maxAttempts = Math.max(1, policy.maxAttempts);

  for (let attempt = 1; ; attempt++) {
    const timeoutMs = Math.max(
      1,
      Math.min(policy.attemptTimeoutMs, deadline - now())
    );
    try {
      const value = await attemptFn({ attempt, timeoutMs });
      return { value, attempts: attempt };
    } catch (error) {
      if (!hooks.isRetryable(error)) {
        throw new RetryFailedError(error, attempt, 'non-retryable');
      }
      if (attempt >= maxAttempts) {
        throw new RetryFailedError(error, attempt, 'exhausted');
      }
      const delayMs =
        policy.delaysMs[
          Math.min(attempt - 1, Math.max(0, policy.delaysMs.length - 1))
        ] ?? 0;
      if (deadline - now() - delayMs < policy.minAttemptMs) {
        throw new RetryFailedError(error, attempt, 'budget');
      }
      hooks.onRetry?.({ attempt: attempt + 1, maxAttempts, delayMs, error });
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }
}

/** Network errors, timeouts and HTTP 5xx are worth another try; anything else isn't. */
export function isTransientHttpError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (error.code === 'ERR_CANCELED') return false;
  const status = error.response?.status;
  if (status === undefined) return true;
  return status >= 500;
}

/** An error message that includes the server's `detail`, e.g. FastAPI's 422 reason. */
export function describeError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const detail = (error.response?.data as { detail?: unknown } | undefined)
      ?.detail;
    if (typeof detail === 'string' && detail.length > 0) {
      return `${error.message}: ${detail}`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : 'Unknown error';
}
