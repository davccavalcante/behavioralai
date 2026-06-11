/**
 * `behavioralai inspect`: print learned fingerprints from a persisted state
 * file as plain aligned text.
 *
 * @module
 */

import type { FingerprintSnapshot } from '../index.js';
import { createBehavioralAI, fileState } from '../index.js';
import { flagString } from './args.js';

const DEFAULT_STATE_PATH = '.behavioralai/state.json';

const NUMERIC_COLUMNS = ['mean', 'stdDev', 'p50', 'p95', 'p99'] as const;

/**
 * Run the inspect command. Reads the state file given by `--state` (default
 * ".behavioralai/state.json"), hydrates an engine from it, and prints every
 * learned fingerprint. Prints "no state found at <path>" when the file does
 * not exist or contains no agents.
 */
export async function runInspect(flags: ReadonlyMap<string, string | true>): Promise<void> {
  const path = flagString(flags, 'state') ?? DEFAULT_STATE_PATH;
  const engine = createBehavioralAI({ state: fileState({ path }) });
  engine.on((event) => {
    if (event.kind === 'error' && event.message !== undefined) {
      process.stderr.write(`behavioralai inspect: ${event.message}\n`);
    }
  });
  await engine.ready();

  const snapshot = engine.inspect();
  if (snapshot.agents.length === 0) {
    process.stdout.write(`no state found at ${path}\n`);
    return;
  }

  const lines: string[] = [];
  for (const agent of snapshot.agents) {
    lines.push(...formatAgent(agent));
    lines.push('');
  }
  const totalObservations = snapshot.agents.reduce((sum, agent) => sum + agent.observations, 0);
  lines.push(`total agents=${snapshot.agents.length} observations=${totalObservations}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** Format one fingerprint as a header, an aligned numeric table, and frozen features. */
function formatAgent(agent: FingerprintSnapshot): string[] {
  const lines: string[] = [];
  lines.push(`agent ${agent.agentId} ${agent.status} observations=${agent.observations}`);

  if (agent.numeric.length > 0) {
    const rows = agent.numeric.map((feature) => ({
      feature: feature.feature as string,
      values: [feature.mean, feature.stdDev, feature.p50, feature.p95, feature.p99].map((value) =>
        value.toFixed(2),
      ),
    }));
    const featureWidth = Math.max('feature'.length, ...rows.map((row) => row.feature.length));
    const valueWidths = NUMERIC_COLUMNS.map((title, column) =>
      Math.max(title.length, ...rows.map((row) => row.values[column]?.length ?? 0)),
    );
    const header = [
      'feature'.padEnd(featureWidth),
      ...NUMERIC_COLUMNS.map((title, column) =>
        title.padStart(valueWidths[column] ?? title.length),
      ),
    ].join('  ');
    lines.push(`  ${header}`);
    for (const row of rows) {
      const cells = [
        row.feature.padEnd(featureWidth),
        ...row.values.map((value, column) => value.padStart(valueWidths[column] ?? value.length)),
      ];
      lines.push(`  ${cells.join('  ')}`);
    }
  }

  if (agent.frozen.length > 0) {
    lines.push(`  frozen: ${agent.frozen.join(', ')}`);
  }
  return lines;
}
