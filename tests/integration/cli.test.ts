import { execFile, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

const execFileAsync = promisify(execFile);

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Launch the CLI as a single node process with the tsx loader instead of the
// tsx wrapper binary: the wrapper relays signals to an inner node process and
// reports its own exit code (128 + signal) on relayed SIGINT, which is not
// the exit code of the CLI under test.
const NODE = process.execPath;
const LOADER = ['--import', 'tsx'];
const CLI = join(ROOT, 'src', 'cli', 'index.ts');

interface ExecFailure {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function isExecFailure(value: unknown): value is ExecFailure {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === 'number' &&
    typeof record.stdout === 'string' &&
    typeof record.stderr === 'string'
  );
}

function runCli(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(NODE, [...LOADER, CLI, ...args], { cwd: ROOT });
}

describe('cli help', () => {
  it('prints usage on stdout and exits 0', async () => {
    const { stdout } = await runCli(['help']);
    expect(stdout.startsWith('behavioralai 1.0.0')).toBe(true);
    expect(stdout).toContain('simulate');
    expect(stdout).toContain('serve');
  });
});

describe('cli unknown command', () => {
  it('exits 2 with a message on stderr', async () => {
    let failure: ExecFailure | undefined;
    try {
      await runCli(['frobnicate']);
    } catch (cause) {
      if (isExecFailure(cause)) failure = cause;
    }
    expect(failure).toBeDefined();
    expect(failure?.code).toBe(2);
    expect(failure?.stderr.length).toBeGreaterThan(0);
    expect(failure?.stderr).toContain('unknown command "frobnicate"');
  });
});

describe('cli simulate', () => {
  it('is deterministic for a fixed seed and reports a detection', async () => {
    const args = ['simulate', '--turns', '160', '--warmup', '30', '--seed', '7'];
    const first = await runCli(args);
    const second = await runCli(args);

    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout).toContain('simulation: turns=160 warmup=30 drift-at=96 seed=7');
    expect(first.stdout).toContain('baseline.ready agent=sim-agent');
    expect(first.stdout).toContain('drift.detected');
    expect(first.stdout).toContain('--- summary ---');
    expect(first.stdout).toContain('turns: 160');
    expect(first.stdout).toContain('drift injected at turn: 96');
    expect(first.stdout).toContain('first detection: turn ');
    expect(first.stdout).not.toContain('first detection: not detected');
  });
});

describe('cli inspect', () => {
  it('reports a missing state file on stdout and exits 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'behavioralai-cli-'));
    const statePath = join(dir, 'missing.json');
    const { stdout } = await runCli(['inspect', '--state', statePath]);
    expect(stdout).toContain('no state found');
    expect(stdout).toContain(statePath);
  });
});

describe('cli serve', () => {
  it('serves healthz, observe, and 404 routes, then shuts down on SIGINT', async () => {
    // serve.ts prints the configured port literally, so --port 0 would not
    // reveal the OS-assigned port. Use a pid-derived high port instead.
    const port = 18_000 + (process.pid % 2_000);
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(
      NODE,
      [...LOADER, CLI, 'serve', '--port', String(port), '--host', '127.0.0.1'],
      {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    try {
      await new Promise<void>((resolve, reject) => {
        let buffer = '';
        const onData = (chunk: Buffer): void => {
          buffer += chunk.toString('utf8');
          if (buffer.includes(`listening on http://127.0.0.1:${port}`)) {
            child.stdout.off('data', onData);
            resolve();
          }
        };
        child.stdout.on('data', onData);
        child.once('exit', (code) => {
          reject(new Error(`serve exited before listening, code=${String(code)}`));
        });
        child.once('error', reject);
      });

      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      const healthBody: unknown = await health.json();
      expect(healthBody).toEqual({ ok: true });

      const observation = {
        agentId: 'http-agent',
        timestamp: 1_750_000_000_000,
        latencyMs: 820,
        costUsd: 0.002,
        inputTokens: 1200,
        outputTokens: 300,
        toolCalls: [{ name: 'web_search', ok: true }],
        finishReason: 'stop',
        error: false,
      };
      const observed = await fetch(`${base}/observe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(observation),
      });
      expect(observed.status).toBe(200);
      const observedBody: unknown = await observed.json();
      expect(observedBody !== null && typeof observedBody === 'object').toBe(true);
      const reports = (observedBody as { reports?: unknown }).reports;
      expect(Array.isArray(reports)).toBe(true);
      if (Array.isArray(reports)) {
        expect(reports).toHaveLength(1);
        const report = reports[0] as { agentId?: unknown };
        expect(report.agentId).toBe('http-agent');
      }

      const badJson = await fetch(`${base}/observe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json{{{',
      });
      expect(badJson.status).toBe(400);

      const notFound = await fetch(`${base}/nope`);
      expect(notFound.status).toBe(404);

      const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        child.once('exit', (code, signal) => {
          resolve({ code, signal });
        });
      });
      child.kill('SIGINT');
      const exit = await exitPromise;
      // The SIGINT handler in serve.ts calls process.exit(0) after shutdown.
      expect(exit.code).toBe(0);
      expect(exit.signal).toBeNull();
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('cli serve --token', () => {
  it('rejects requests without the bearer token and accepts the right one', async () => {
    const port = 18_000 + ((process.pid + 7) % 2_000);
    const base = `http://127.0.0.1:${port}`;
    const child = spawn(
      NODE,
      [
        ...LOADER,
        CLI,
        'serve',
        '--port',
        String(port),
        '--host',
        '127.0.0.1',
        '--token',
        'secret-1',
      ],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes('listening on')) resolve();
        });
        child.once('exit', (code) => {
          reject(new Error(`serve exited before listening, code=${String(code)}`));
        });
        child.once('error', reject);
      });

      // /healthz stays open (liveness probes have no secrets).
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);

      // No token: rejected.
      const denied = await fetch(`${base}/observe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'auth-agent', latencyMs: 100 }),
      });
      expect(denied.status).toBe(401);

      // Wrong token: rejected.
      const wrong = await fetch(`${base}/inspect`, {
        headers: { authorization: 'Bearer nope' },
      });
      expect(wrong.status).toBe(401);

      // Correct token: accepted.
      const allowed = await fetch(`${base}/observe`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer secret-1',
        },
        body: JSON.stringify({ agentId: 'auth-agent', latencyMs: 100 }),
      });
      expect(allowed.status).toBe(200);
      const body = (await allowed.json()) as { reports: unknown[] };
      expect(body.reports).toHaveLength(1);
    } finally {
      child.kill('SIGINT');
      await new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(resolve, 3000);
      });
    }
  }, 30_000);
});
