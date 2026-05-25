/**
 * Generic retry utility with exponential backoff and jitter.
 * Designed for external API calls (Massive, Yahoo, Telegram, LLM providers).
 */

/**
 * Configuration for retry behaviour.
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (default 3). */
  maxRetries: number;
  /** Base delay in milliseconds (default 1000). First retry waits base * 2^0. */
  baseDelayMs: number;
  /** Maximum delay in milliseconds (default 30_000). Caps exponential growth. */
  maxDelayMs: number;
  /** HTTP status codes that trigger a retry (default [429, 500, 502, 503, 504]). */
  retryableStatuses: number[];
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  retryableStatuses: [429, 500, 502, 503, 504],
};

/**
 * Returns true when the error looks like a transient failure that should be retried.
 * Checks for axios-style HTTP errors and network/connection errors.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    // Network / connection errors (no response received)
    if (
      error.message.includes("ETIMEDOUT") ||
      error.message.includes("ECONNRESET") ||
      error.message.includes("ECONNREFUSED") ||
      error.message.includes("ENOTFOUND") ||
      error.message.includes("socket hang up") ||
      error.message.includes("network timeout")
    ) {
      return true;
    }
  }

  // axios-style HTTP errors with a response status
  if (typeof error === "object" && error !== null) {
    const err = error as Record<string, unknown>;
    const status = err.status ?? (err.response as Record<string, unknown> | undefined)?.status;
    if (typeof status === "number" && DEFAULT_RETRY_CONFIG.retryableStatuses.includes(status)) {
      return true;
    }
  }

  return false;
}

/**
 * Computes delay in milliseconds for a given retry attempt using exponential backoff.
 * Adds jitter (±25%) to avoid thundering-herd problems.
 */
export function retryDelayMs(attempt: number, config: RetryConfig = DEFAULT_RETRY_CONFIG): number {
  const exponential = Math.min(
    config.baseDelayMs * Math.pow(2, attempt),
    config.maxDelayMs,
  );
  const jitter = exponential * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

/**
 * Wraps an async function with retry logic.
 * Only retries when `isRetryableError` returns true for the caught error.
 * Logs each retry attempt via console.warn.
 *
 * @example
 * ```ts
 * const data = await withRetry(() => axios.get(url), { maxRetries: 5 });
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt < config.maxRetries && isRetryableError(error)) {
        const delay = retryDelayMs(attempt, config);
        console.warn(
          `[retry] attempt=${attempt + 1}/${config.maxRetries} retrying_in=${delay}ms error=${error instanceof Error ? error.message : String(error)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }

  // Should never reach here, but TypeScript needs a return
  throw lastError;
}
