/**
 * behavioralai CLI entry point (Node only, zero dependencies).
 *
 * Commands: `help`, `inspect`, `simulate`, `serve`. The build adds the
 * shebang banner; this module must not declare one. Exit codes: 0 on
 * success, 1 on runtime errors, 2 on unknown commands.
 *
 * @module
 */

import { parseArgs } from './args.js';
import { runInspect } from './inspect.js';
import { runServe } from './serve.js';
import { runSimulate } from './simulate.js';

const USAGE = `behavioralai 1.0.0
Behavioral AI: behavioral observability for production agents, per-agent fingerprints, real-time drift detection, attribution, and alerting.

Usage:
  behavioralai <command> [flags]

Commands:

  help
    Print this help text and exit.
    Example: behavioralai help

  inspect
    Print learned fingerprints from a persisted state file.
    --state <path>   Path of the state file (default ".behavioralai/state.json").
    Example: behavioralai inspect --state .behavioralai/state.json

  simulate
    Run a deterministic drift simulation and print every detection.
    --turns <n>      Number of simulated turns (default 400).
    --warmup <n>     Observations required before drift evaluation (default 60).
    --drift-at <n>   Turn after which drift is injected (default 60 percent of --turns).
    --seed <n>       Seed of the deterministic random generator (default 42).
    Example: behavioralai simulate --turns 400 --drift-at 240 --seed 42

  serve
    Start an HTTP ingestion server: POST /observe, GET /inspect, GET /healthz.
    --port <n>       Listen port (default 8787).
    --host <addr>    Bind address (default "127.0.0.1").
    --state <path>   Enable file persistence at this path (flushed every 30 seconds).
    --slack <url>    Dispatch alerts to a Slack incoming webhook.
    --webhook <url>  Dispatch alerts to a generic JSON webhook.
    --token <secret> Require "Authorization: Bearer <secret>" on every
                     endpoint except /healthz. Set it whenever binding
                     beyond localhost.
    Example: behavioralai serve --port 8787 --state .behavioralai/state.json
`;

/** Dispatch the parsed command. Exits the process for help and unknown commands. */
async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'help': {
      process.stdout.write(USAGE);
      return;
    }
    case 'inspect': {
      await runInspect(flags);
      return;
    }
    case 'simulate': {
      await runSimulate(flags);
      return;
    }
    case 'serve': {
      await runServe(flags);
      return;
    }
    default: {
      process.stderr.write(`behavioralai: unknown command "${command}"\n\n`);
      process.stderr.write(USAGE);
      process.exit(2);
    }
  }
}

try {
  await main();
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`behavioralai: ${message}\n`);
  process.exit(1);
}
