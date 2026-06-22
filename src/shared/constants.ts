/** Milliseconds in one calendar day (UTC-anchored). */
export const MS_PER_DAY = 86_400_000;

/** Milliseconds in one hour. */
export const MS_PER_HOUR = 3_600_000;

/** Milliseconds in one minute. */
export const MS_PER_MINUTE = 60_000;

/**
 * Telegram message character limit.
 * Shared by telegram-dispatcher.ts and template.ts for consistent truncation.
 */
export const TG_MAX = 4096;

/** Characters reserved for the truncation suffix ── "\\n…(truncated)". */
export const TG_TRUNCATE_RESERVE = 20;
