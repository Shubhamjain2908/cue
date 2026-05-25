/**
 * Reusable error-boundary utilities for CLI commands.
 * Provides consistent error handling and exit-code management
 * across all subcommands.
 */

import { cueLogger } from "./cue-logger.js";

/** Shape returned by `trySync` / `tryAsync`. */
export interface TryResult<T> {
  success: boolean;
  data: T | null;
  error: Error | null;
}

/**
 * Wraps a synchronous operation in a try/catch and returns a structured result.
 * Logs the error via cueLogger when the operation fails.
 */
export function trySync<T>(label: string, fn: () => T): TryResult<T> {
  try {
    const data = fn();
    return { success: true, data, error: null };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    cueLogger.error(`operation_failed label=${label} error=${error.message}`);
    return { success: false, data: null, error };
  }
}

/**
 * Wraps an async operation in a try/catch and returns a structured result.
 * Logs the error via cueLogger when the operation fails.
 */
export async function tryAsync<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<TryResult<T>> {
  try {
    const data = await fn();
    return { success: true, data, error: null };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    cueLogger.error(`operation_failed label=${label} error=${error.message}`);
    return { success: false, data: null, error };
  }
}

/**
 * Wraps a synchronous operation and exits the process with code 1 on failure.
 * Useful for critical CLI steps where continuing is not possible.
 */
export function tryOrExit<T>(label: string, fn: () => T): T {
  const result = trySync(label, fn);
  if (!result.success) {
    cueLogger.error(`aborting label=${label}`);
    process.exit(1);
  }
  return result.data as T;
}

/**
 * Wraps an async operation and exits the process with code 1 on failure.
 * Useful for critical CLI steps where continuing is not possible.
 */
export async function tryOrExitAsync<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const result = await tryAsync(label, fn);
  if (!result.success) {
    cueLogger.error(`aborting label=${label}`);
    process.exit(1);
  }
  return result.data as T;
}
