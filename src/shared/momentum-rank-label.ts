/** Human-readable momentum rank with eligible vs full-universe denominator. */
export function formatMomentumRankLabel(
  rank: number,
  eligibleCount: number,
  universeTotal: number,
): string {
  if (eligibleCount === universeTotal) {
    return `#${String(rank)} of ${String(eligibleCount)}`;
  }
  return `#${String(rank)} of ${String(eligibleCount)} eligible (${String(universeTotal)} universe)`;
}
