/** One mark on the simulated equity curve (date + NAV). */
export interface NavPoint {
  date: string;
  nav: number;
}

/** Per-session halt mask entry produced by `computeDrawdownHaltMask`. */
export interface DrawdownHaltMaskEntry {
  date: string;
  /** When true, new BUY entries should be suppressed on this session. */
  halted: boolean;
  /** Peak-to-trough drawdown from running high-water mark, in percentage points. */
  drawdownPct: number;
}

/** Mutable state for incremental halt updates inside `runBacktest`. */
export interface DrawdownHaltState {
  peakNav: number;
  halted: boolean;
}

/**
 * Advance drawdown-halt state from a new NAV mark.
 * Halt when drawdown ≥ haltThreshold; resume when drawdown < resumeThreshold (hysteresis).
 */
export function stepDrawdownHalt(
  state: DrawdownHaltState,
  nav: number,
  haltThresholdPct: number,
  resumeThresholdPct: number,
): void {
  if (nav > state.peakNav) {
    state.peakNav = nav;
  }
  const dd = state.peakNav > 0 ? ((state.peakNav - nav) / state.peakNav) * 100 : 0;
  if (!state.halted && dd >= haltThresholdPct) {
    state.halted = true;
  }
  if (state.halted && dd < resumeThresholdPct) {
    state.halted = false;
  }
}

/**
 * Pure batch function: given an equity curve, return a per-date halt mask.
 * Uses the same hysteresis state machine as `stepDrawdownHalt`.
 */
export function computeDrawdownHaltMask(
  series: readonly NavPoint[],
  haltThresholdPct: number,
  resumeThresholdPct: number,
): DrawdownHaltMaskEntry[] {
  const state: DrawdownHaltState = { peakNav: 0, halted: false };
  return series.map(({ date, nav }) => {
    stepDrawdownHalt(state, nav, haltThresholdPct, resumeThresholdPct);
    const dd = state.peakNav > 0 ? ((state.peakNav - nav) / state.peakNav) * 100 : 0;
    return { date, halted: state.halted, drawdownPct: dd };
  });
}
