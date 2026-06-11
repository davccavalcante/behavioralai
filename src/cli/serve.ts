/**
 * `behavioralai serve`: HTTP ingestion server (Node only).
 *
 * Bridges non-Node runtimes into the engine: any process that can emit HTTP
 * (for example a Python Hermes Agent plugin) POSTs per-turn JSON to
 * `/observe` and reads fingerprints from `/inspect`. Optional flags enable
 * file persistence and Slack or generic webhook alerting.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { slackChannel, webhookChannel } from '../channels/index.js';
import type { AlertChannel, BehavioralAI, DriftReport, TurnObservation } from '../index.js';
import { createBehavioralAI, fileState } from '../index.js';
import { flagNumber, flagString } from './args.js';

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1_048_576;
const FLUSH_INTERVAL_MS = 30_000;

/**
 * Run the serve command. Flags: `--port` (default 8787), `--host` (default
 * "127.0.0.1"), `--state <path>` (optional file persistence, flushed every
 * 30 seconds), `--slack <webhookUrl>` and `--webhook <url>` (optional alert
 * channels), `--token <secret>` (require `Authorization: Bearer <secret>`
 * on every endpoint except `/healthz`; set it whenever binding beyond
 * localhost). Resolves once the server is listening; SIGINT and SIGTERM
 * stop the server, close the engine, and exit 0.
 */
export async function runServe(flags: ReadonlyMap<string, string | true>): Promise<void> {
  const port = flagNumber(flags, 'port') ?? DEFAULT_PORT;
  const host = flagString(flags, 'host') ?? DEFAULT_HOST;
  const statePath = flagString(flags, 'state');
  const slackUrl = flagString(flags, 'slack');
  const webhookUrl = flagString(flags, 'webhook');
  const token = flagString(flags, 'token');

  const channels: AlertChannel[] = [];
  if (slackUrl !== undefined) channels.push(slackChannel({ webhookUrl: slackUrl }));
  if (webhookUrl !== undefined) channels.push(webhookChannel({ url: webhookUrl }));

  const engine = createBehavioralAI({
    ...(statePath !== undefined ? { state: fileState({ path: statePath }) } : {}),
    ...(channels.length > 0 ? { channels } : {}),
  });
  await engine.ready();

  if (statePath !== undefined) {
    setInterval(() => {
      engine.flush().catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        process.stderr.write(`behavioralai serve: periodic flush failed: ${message}\n`);
      });
    }, FLUSH_INTERVAL_MS).unref();
  }

  const server = createServer((request, response) => {
    void handleRequest(engine, request, response, token);
  });

  const shutdown = async (): Promise<void> => {
    server.closeIdleConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    try {
      await engine.close();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`behavioralai serve: close failed: ${message}\n`);
    }
    process.exit(0);
  };
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  process.stdout.write(`behavioralai serve listening on http://${host}:${port}\n`);
}

/** Route one request. Never rejects; failures become JSON error responses. */
async function handleRequest(
  engine: BehavioralAI,
  request: IncomingMessage,
  response: ServerResponse,
  token?: string,
): Promise<void> {
  try {
    const method = request.method ?? 'GET';
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

    // Bearer auth (enabled by --token) protects every endpoint except the
    // liveness probe; mandatory hygiene before binding beyond localhost.
    if (token !== undefined && pathname !== '/healthz') {
      const header = request.headers.authorization ?? '';
      if (header !== `Bearer ${token}`) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
    }

    if (method === 'POST' && pathname === '/observe') {
      await handleObserve(engine, request, response);
      return;
    }
    if (method === 'GET' && pathname === '/inspect') {
      sendJson(response, 200, engine.inspect());
      return;
    }
    if (method === 'GET' && pathname === '/healthz') {
      sendJson(response, 200, { ok: true });
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!response.headersSent) {
      sendJson(response, 500, { error: message });
    } else {
      response.end();
    }
  }
}

/** Handle POST /observe: one TurnObservation or an array of them. */
async function handleObserve(
  engine: BehavioralAI,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readBody(request);
  if (body === undefined) {
    sendJson(response, 413, { error: 'request body exceeds 1 MB' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(response, 400, { error: 'invalid JSON' });
    return;
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  const observations: TurnObservation[] = [];
  for (const item of items) {
    if (!isTurnObservation(item)) {
      sendJson(response, 400, {
        error: 'each observation must be an object with a non-empty string agentId',
      });
      return;
    }
    observations.push(item);
  }

  try {
    const reports: DriftReport[] = observations.map((observation) => engine.observe(observation));
    sendJson(response, 200, { reports });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    sendJson(response, 400, { error: message });
  }
}

/** Minimal shape check: an object carrying a non-empty string agentId. */
function isTurnObservation(value: unknown): value is TurnObservation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const agentId = (value as { agentId?: unknown }).agentId;
  return typeof agentId === 'string' && agentId.length > 0;
}

/**
 * Read the full request body as UTF-8 with a 1 MB cap. Resolves undefined
 * when the cap is exceeded; rejects only on transport errors.
 */
function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overflow = false;
    request.on('data', (chunk: Buffer) => {
      if (overflow) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolve(overflow ? undefined : Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', (cause) => {
      reject(cause);
    });
  });
}

/** Serialize a JSON response with the given status code. */
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(body);
}
