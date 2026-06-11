import type { SensitivityConfig, SensitivityPreset } from '../types.js';

/**
 * Sensitivity presets. Thresholds are expressed in robust z-score units for
 * numeric features and bias-corrected Jensen-Shannon divergence (0..1) for
 * categorical features (the engine subtracts the finite-sample JSD bias
 * (k - 1) / (4 n ln 2) before comparing, so these values are calibrated to
 * corrected divergence: a two-category mix moving 25 to 35 percentage
 * points lands between warning and critical at the balanced preset). Page-Hinkley parameters are in standardized (z) units because
 * the detector consumes baseline-standardized samples.
 *
 * strict: surfaces small deviations early, more findings, more noise.
 * balanced: production default, tuned to flag clear behavioral change.
 * relaxed: only strong, sustained deviations; minimal noise.
 */
const PRESETS: Record<SensitivityPreset, SensitivityConfig> = {
  strict: {
    warningZ: 2.5,
    criticalZ: 3.5,
    warningDivergence: 0.07,
    criticalDivergence: 0.18,
    ewmaAlpha: 0.08,
    pageHinkleyDelta: 0.01,
    pageHinkleyLambda: 50,
  },
  balanced: {
    warningZ: 3,
    criticalZ: 4.5,
    warningDivergence: 0.1,
    criticalDivergence: 0.25,
    ewmaAlpha: 0.05,
    pageHinkleyDelta: 0.02,
    pageHinkleyLambda: 75,
  },
  relaxed: {
    warningZ: 4,
    criticalZ: 6,
    warningDivergence: 0.16,
    criticalDivergence: 0.38,
    ewmaAlpha: 0.03,
    pageHinkleyDelta: 0.04,
    pageHinkleyLambda: 110,
  },
};

/** Resolve a preset name or a partial override into a full config. */
export function resolveSensitivity(
  input: SensitivityPreset | Partial<SensitivityConfig> | undefined,
): SensitivityConfig {
  if (input === undefined) return PRESETS.balanced;
  if (typeof input === 'string') {
    return PRESETS[input];
  }
  return { ...PRESETS.balanced, ...input };
}

export const SENSITIVITY_PRESETS: Readonly<Record<SensitivityPreset, SensitivityConfig>> = PRESETS;
