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
