/**
 * `behavioralai simulate`: deterministic end-to-end drift simulation.
 *
 * Generates a healthy traffic profile, injects a behavioral drift at a
 * configurable turn, and prints every detection the engine emits plus a
 * closing summary. All randomness comes from a seeded linear congruential
 * generator and all timestamps from a simulated clock, so identical seeds
 * produce byte-identical output.
 *
 * @module
 */

import type { DriftReport, ToolCallRecord, TurnObservation } from '../index.js';
import { createBehavioralAI } from '../index.js';
import { flagNumber } from './args.js';

/** Fixed simulation start, epoch milliseconds. Never reads the wall clock. */
const EPOCH_MS = 1_750_000_000_000;
/** Simulated time between two turns, milliseconds. */
const CLOCK_STEP_MS = 30_000;
/** Identifier of the simulated agent. */
const AGENT_ID = 'sim-agent';
/** Tools the simulated agent can call. */
const TOOLS = ['web_search', 'db_query', 'calculator'] as const;
/** Tool selection weights while healthy. */
const HEALTHY_WEIGHTS = [0.5, 0.3, 0.2] as const;
/** Tool selection weights after drift injection. */
const DRIFTED_WEIGHTS = [0.1, 0.2, 0.7] as const;
/** Turns over which the latency multiplier ramps from 1.0 to 1.8. */
const RAMP_TURNS = 50;

/**
 * Run the simulate command. Flags: `--turns` (default 400), `--warmup`
 * (default 60), `--drift-at` (default 60 percent of turns), `--seed`
 * (default 42).
 */
export async function runSimulate(flags: ReadonlyMap<string, string | true>): Promise<void> {
  const turns = flagNumber(flags, 'turns') ?? 400;
  const warmup = flagNumber(flags, 'warmup') ?? 60;
  const driftAt = flagNumber(flags, 'drift-at') ?? Math.floor(turns * 0.6);
  const seed = flagNumber(flags, 'seed') ?? 42;
  if (turns < 1) {
    throw new Error('flag --turns must be at least 1');
  }

  // Linear congruential generator (Numerical Recipes constants). The product
  // stays below 2^53, so the modular step is exact in double precision.
  let lcgState = seed >>> 0;
  const next = (): number => {
    lcgState = (lcgState * 1664525 + 1013904223) >>> 0;
    return lcgState / 2 ** 32;
  };
  // Standard normal deviate via Box-Muller from two LCG uniforms.
  const gauss = (): number => {
    const u1 = Math.max(next(), 1e-12);
    const u2 = next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const pickTool = (weights: readonly number[]): string => {
    const draw = next();
    let cumulative = 0;
    for (let index = 0; index < TOOLS.length; index += 1) {
      cumulative += weights[index] ?? 0;
      if (draw < cumulative) return TOOLS[index] ?? 'calculator';
    }
    return TOOLS[TOOLS.length - 1] ?? 'calculator';
  };

  let simulatedClock = EPOCH_MS;
  const engine = createBehavioralAI({
    warmup: { minObservations: warmup },
    alerts: { canary: true },
    now: () => simulatedClock,
  });

  const write = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  let currentTurn = 0;
  let firstDetectionTurn: number | undefined;
  engine.on((event) => {
    if (event.kind === 'baseline.ready') {
      write(`turn ${currentTurn} baseline.ready agent=${event.agentId ?? 'unknown'}`);
      return;
    }
    if (event.kind === 'drift.detected') {
      const finding = event.report?.findings.find((entry) => entry.feature === event.feature);
      const score = finding?.score ?? 0;
      const behavior = event.report?.behaviorScore ?? 0;
      write(
        `turn ${currentTurn} drift.detected feature=${event.feature ?? 'unknown'} severity=${
          event.severity ?? 'info'
        } score=${score.toFixed(2)} behavior=${behavior}`,
      );
      if (firstDetectionTurn === undefined && currentTurn > driftAt) {
        firstDetectionTurn = currentTurn;
      }
      return;
    }
    if (event.kind === 'drift.recovered') {
      const behavior = event.report?.behaviorScore ?? 0;
      write(
        `turn ${currentTurn} drift.recovered agent=${event.agentId ?? 'unknown'} behavior=${behavior}`,
      );
      return;
    }
    if (event.kind === 'forecast.detected') {
      const forecast = event.report?.forecasts.find((entry) => entry.feature === event.feature);
      const summary = forecast?.summary ?? '';
      write(
        `turn ${currentTurn} forecast.detected feature=${event.feature ?? 'unknown'} ${summary}`,
      );
    }
  });

  write(`simulation: turns=${turns} warmup=${warmup} drift-at=${driftAt} seed=${seed}`);

  let lastReport: DriftReport | undefined;
  for (let turn = 1; turn <= turns; turn += 1) {
    currentTurn = turn;
    const drifted = turn > driftAt;
    const latencyMultiplier = drifted ? 1 + 0.8 * Math.min(1, (turn - driftAt) / RAMP_TURNS) : 1;
    const errorProbability = drifted ? 0.15 : 0.02;
    const weights = drifted ? DRIFTED_WEIGHTS : HEALTHY_WEIGHTS;
    const lengthProbability = drifted ? 0.4 : 0.05;

    const latencyMs = Math.max(1, (800 + gauss() * 120) * latencyMultiplier);
    const costUsd = 0.002 + next() * 0.0005;
    const inputTokens = Math.round(1200 + (next() * 2 - 1) * 200);
    const outputTokens = Math.round(300 + (next() * 2 - 1) * 80);
    const toolOk = next() > errorProbability;
    const toolCalls: readonly ToolCallRecord[] = [{ name: pickTool(weights), ok: toolOk }];
    const finishReason = next() < lengthProbability ? 'length' : 'stop';

    const observation: TurnObservation = {
      agentId: AGENT_ID,
      timestamp: simulatedClock,
      latencyMs,
      costUsd,
      inputTokens,
      outputTokens,
      toolCalls,
      finishReason,
      error: !toolOk,
    };
    lastReport = engine.observe(observation);
    simulatedClock += CLOCK_STEP_MS;
  }

  await engine.close();

  const summary: string[] = [];
  summary.push('--- summary ---');
  summary.push(`turns: ${turns}`);
  summary.push(`drift injected at turn: ${driftAt}`);
  if (firstDetectionTurn !== undefined) {
    summary.push(
      `first detection: turn ${firstDetectionTurn} (delay ${firstDetectionTurn - driftAt} turns)`,
    );
  } else {
    summary.push('first detection: not detected');
  }
  summary.push(
    `final behavior score: ${lastReport === undefined ? 'n/a' : lastReport.behaviorScore}`,
  );
  const top = (lastReport?.attributions ?? []).slice(0, 3);
  if (top.length === 0) {
    summary.push('top attributions: none');
  } else {
    summary.push('top attributions:');
    for (const attribution of top) {
      summary.push(
        `  ${attribution.feature} contribution=${attribution.contribution.toFixed(2)} ${attribution.summary}`,
      );
    }
  }
  write(summary.join('\n'));
}
