const YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates `YYYY-MM-DD` and that the calendar day exists (e.g. not 2026-02-31).
 */
export function parseYmd(raw: string): string {
  const trimmed = raw.trim();
  if (!YMD_REGEX.test(trimmed)) {
    throw new Error(
      `Invalid date "${raw}": expected YYYY-MM-DD (example: 2026-05-19)`,
    );
  }
  const [ys, ms, ds] = trimmed.split("-");
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  const civil = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  if (
    civil.getUTCFullYear() !== y ||
    civil.getUTCMonth() + 1 !== m ||
    civil.getUTCDate() !== d
  ) {
    throw new Error(`Invalid date "${raw}": not a valid calendar day`);
  }
  return trimmed;
}

/**
 * Reads `--date YYYY-MM-DD` from argv when present; throws if the flag is set but the value is invalid.
 */
export function parseOptionalYmdFromArgv(
  argv: readonly string[],
  flag: string = "--date",
): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) {
    return undefined;
  }
  const next = argv[i + 1];
  if (next === undefined || String(next).length === 0) {
    throw new Error(`Missing value after ${flag} (expected YYYY-MM-DD)`);
  }
  return parseYmd(String(next));
}
