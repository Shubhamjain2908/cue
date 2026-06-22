/**
 * Shared date utilities extracted from duplicated definitions across the codebase.
 *
 * All functions operate on ISO `YYYY-MM-DD` date strings with UTC noon anchors
 * for timezone-agnostic calendar arithmetic.
 */

/** UTC milliseconds for an ISO date string (YYYY-MM-DD). */
export function parseIsoUtcMs(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

/** Add `days` calendar days to an ISO date string, returns new YYYY-MM-DD. */
export function addCalendarDays(iso: string, days: number): string {
  const ms = parseIsoUtcMs(iso) + days * 86_400_000;
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Lexicographic ISO date comparator. Returns -1 / 0 / 1. */
export function compareIsoDate(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * ISO weekday for a date string (1 = Monday … 5 = Friday).
 * Returns 0 for Saturday or Sunday (non-trading days).
 */
export function isoWeekdayMon1ToFri5(iso: string): number {
  const dow = new Date(parseIsoUtcMs(iso)).getUTCDay();
  if (dow === 0 || dow === 6) return 0;
  return dow;
}

/** Calendar years between two ISO dates (UTC noon anchor, 365.25 day years). */
export function calendarYearFraction(fromIso: string, toIso: string): number {
  const raw = (parseIsoUtcMs(toIso) - parseIsoUtcMs(fromIso)) / 86_400_000 / 365.25;
  return Math.max(raw, 1e-9);
}
