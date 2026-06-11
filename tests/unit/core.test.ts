import { describe, expect, it } from 'vitest';
import { AlertGovernor } from '../../src/core/AlertGovernor.js';
import { Telemetry } from '../../src/core/Telemetry.js';
import { buildAttributions } from '../../src/drift/Attribution.js';
import { resolveSensitivity, SENSITIVITY_PRESETS } from '../../src/drift/sensitivity.js';
import type { Alert, AlertPolicy, DriftFinding, FeatureName } from '../../src/types.js';

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'a-1',
    agentId: 'agent-x',
    kind: 'drift',
    severity: 'warning',
    title: 'Behavioral drift detected: agent-x',
    message: 'latency above baseline',
    behaviorScore: 55,
    attributions: [
      {
        feature: 'latencyMs',
        contribution: 1,
        score: 3.4,
        direction: 'above',
        summary: 'latencyMs above baseline',
      },
    ],
    timestamp: 1_750_000_000_000,
    ...overrides,
  };
}

const POLICY: AlertPolicy = {
  cooldownMs: 300_000,
  minSeverity: 'warning',
  canary: false,
  notifyRecovery: true,
  notifyForecast: true,
};

describe('AlertGovernor', () => {
  it('suppresses everything in canary mode', () => {
    const governor = new AlertGovernor({ ...POLICY, canary: true });
    const decision = governor.decide(makeAlert({ severity: 'critical' }), 0);
    expect(decision).toEqual({ allow: false, reason: 'canary' });
  });

  it('applies the severity floor to drift alerts only', () => {
    const governor = new AlertGovernor({ ...POLICY, minSeverity: 'critical' });
    expect(governor.decide(makeAlert({ severity: 'warning' }), 0).reason).toBe(
      'below-min-severity',
    );
    expect(governor.decide(makeAlert({ kind: 'recovery', severity: 'info' }), 0).allow).toBe(true);
  });

  it('enforces the cooldown per agent, kind, and top feature', () => {
    const governor = new AlertGovernor(POLICY);
    expect(governor.decide(makeAlert(), 0).allow).toBe(true);
    expect(governor.decide(makeAlert({ id: 'a-2' }), 60_000).reason).toBe('cooldown');
    expect(governor.decide(makeAlert({ id: 'a-3' }), 300_001).allow).toBe(true);
  });

  it('lets an escalation bypass the cooldown', () => {
    const governor = new AlertGovernor(POLICY);
    expect(governor.decide(makeAlert(), 0).allow).toBe(true);
    const escalated = makeAlert({ id: 'a-2', severity: 'critical' });
    expect(governor.decide(escalated, 1000).allow).toBe(true);
  });
});

describe('Telemetry', () => {
  it('delivers events and supports unsubscribe', () => {
    const bus = new Telemetry();
    const seen: string[] = [];
    const off = bus.on((event) => {
      seen.push(event.kind);
    });
    bus.emit({ kind: 'observation.recorded', timestamp: 1 });
    off();
    bus.emit({ kind: 'observation.recorded', timestamp: 2 });
    expect(seen).toEqual(['observation.recorded']);
  });

  it('swallows listener errors', () => {
    const bus = new Telemetry();
    bus.on(() => {
      throw new Error('broken listener');
    });
    expect(() => bus.emit({ kind: 'error', timestamp: 1 })).not.toThrow();
  });
});

describe('buildAttributions', () => {
  const finding: DriftFinding = {
    feature: 'latencyMs',
    severity: 'critical',
    direction: 'above',
    score: 5.5,
    observed: 3400,
    expected: 800,
    summary: 'latencyMs is above baseline',
  };

  it('returns contributions that sum to one, sorted by deviation', () => {
    const deviations = new Map<FeatureName, number>([
      ['latencyMs', 1.4],
      ['costUsd', 0.7],
      ['errorRate', 0.3],
    ]);
    const attributions = buildAttributions(deviations, [finding]);
    expect(attributions[0]?.feature).toBe('latencyMs');
    const total = attributions.reduce((acc, attribution) => acc + attribution.contribution, 0);
    expect(total).toBeCloseTo(1, 2);
    expect(attributions[0]?.observed).toBe(3400);
    expect(attributions[0]?.expected).toBe(800);
  });

  it('filters tiny deviations without findings', () => {
    const deviations = new Map<FeatureName, number>([
      ['costUsd', 0.1],
      ['errorRate', 0.05],
    ]);
    expect(buildAttributions(deviations, [])).toEqual([]);
  });

  it('caps the list at five attributions', () => {
    const deviations = new Map<FeatureName, number>([
      ['latencyMs', 1],
      ['costUsd', 0.9],
      ['inputTokens', 0.8],
      ['outputTokens', 0.7],
      ['totalTokens', 0.6],
      ['errorRate', 0.5],
    ]);
    expect(buildAttributions(deviations, []).length).toBe(5);
  });
});

describe('sensitivity resolution', () => {
  it('resolves presets and defaults to balanced', () => {
    expect(resolveSensitivity('strict')).toEqual(SENSITIVITY_PRESETS.strict);
    expect(resolveSensitivity(undefined)).toEqual(SENSITIVITY_PRESETS.balanced);
  });

  it('merges partial overrides over balanced', () => {
    const merged = resolveSensitivity({ warningZ: 2 });
    expect(merged.warningZ).toBe(2);
    expect(merged.criticalZ).toBe(SENSITIVITY_PRESETS.balanced.criticalZ);
  });
});
