/**
 * Canonical locale and IANA zone for US equity session / pipeline scheduling.
 * Use these for every `Intl.DateTimeFormat` that must align with ET civil time.
 */
export const CUE_LOCALE = "en-US" as const;
export const CUE_TIME_ZONE = "America/New_York" as const;

/**
 * US equity session calendar date (`YYYY-MM-DD`) for `now` in ET civil time.
 * Uses `CUE_LOCALE` and `CUE_TIME_ZONE` — do not use `Date.prototype.toISOString()` for date-bound columns.
 */
export function getExchangeDateString(now: Date = new Date()): string {
  const dtf = new Intl.DateTimeFormat(CUE_LOCALE, {
    timeZone: CUE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.formatToParts(now);
  let year = "";
  let month = "";
  let day = "";
  for (const p of parts) {
    if (p.type === "year") {
      year = p.value;
    }
    if (p.type === "month") {
      month = p.value;
    }
    if (p.type === "day") {
      day = p.value;
    }
  }
  return `${year}-${month}-${day}`;
}

/**
 * Return `{ year, month, day }` for `now` in ET civil time.
 * Used by pipeline scheduling and ingest to align with US equity session dates.
 */
export function getEtCalendarParts(now: Date): {
  year: number;
  month: number;
  day: number;
} {
  const dtf = new Intl.DateTimeFormat(CUE_LOCALE, {
    timeZone: CUE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = dtf.formatToParts(now);
  let year = 0;
  let month = 0;
  let day = 0;
  for (const p of parts) {
    if (p.type === "year") {
      year = Number(p.value);
    }
    if (p.type === "month") {
      month = Number(p.value);
    }
    if (p.type === "day") {
      day = Number(p.value);
    }
  }
  return { year, month, day };
}

/**
 * Format `now` as `YYYY-MM-DD` in ET civil time.
 * Canonical date string for daily_prices rows, pipeline_state keys, and logging.
 */
export function formatEtYmd(now: Date): string {
  const { year, month, day } = getEtCalendarParts(now);
  const y = String(year).padStart(4, "0");
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Gregorian weekday for an America/New_York calendar date (0 Sunday … 6 Saturday).
 * Uses UTC-noon anchor to avoid DST / timezone offset edge cases.
 */
export function weekdayUtcForNyCalendarDate(
  year: number,
  month: number,
  day: number,
): number {
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).getUTCDay();
}
