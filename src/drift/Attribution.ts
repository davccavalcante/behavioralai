import type { DriftFinding, FeatureAttribution, FeatureName } from '../types.js';

/** Features below this share of their critical threshold are not attributed. */
const MIN_DEVIATION = 0.25;
/** Maximum attributions reported per drift event. */
const MAX_ATTRIBUTIONS = 5;

/**
 * Rank the features that explain a deviation. Contribution is the squared
 * normalized deviation of each feature divided by the sum over all reported
 * features, so contributions always sum to 1 across the returned list.
 */
export function buildAttributions(
  deviations: ReadonlyMap<FeatureName, number>,
  findings: readonly DriftFinding[],
): FeatureAttribution[] {
  const findingByFeature = new Map<FeatureName, DriftFinding>();
  for (const finding of findings) findingByFeature.set(finding.feature, finding);

  const candidates: Array<{ feature: FeatureName; deviation: number }> = [];
  for (const [feature, deviation] of deviations) {
    if (deviation >= MIN_DEVIATION || findingByFeature.has(feature)) {
      candidates.push({ feature, deviation });
    }
  }
  if (candidates.length === 0) return [];

  candidates.sort((a, b) => b.deviation - a.deviation);
  const top = candidates.slice(0, MAX_ATTRIBUTIONS);
  let sumSquares = 0;
  for (const candidate of top) sumSquares += candidate.deviation * candidate.deviation;
  if (sumSquares === 0) return [];

  return top.map(({ feature, deviation }) => {
    const finding = findingByFeature.get(feature);
    const attribution: FeatureAttribution = {
      feature,
      contribution: round4((deviation * deviation) / sumSquares),
      score: finding?.score ?? deviation,
      direction: finding?.direction ?? 'above',
      summary:
        finding?.summary ??
        `${feature} deviates at ${Math.round(deviation * 100)}% of its critical threshold`,
      ...(finding?.observed !== undefined ? { observed: finding.observed } : {}),
      ...(finding?.expected !== undefined ? { expected: finding.expected } : {}),
    };
    return attribution;
  });
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
