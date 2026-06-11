import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { emailChannel } from '../../src/smtp/index.js';
import type { Alert } from '../../src/types.js';

const ALERT = {
  id: 'agent-x-drift-1750000000000-1',
  agentId: 'agent-x',
  kind: 'drift',
  severity: 'critical',
  title: 'Behavioral drift detected: agent-x',
  message: 'Behavior score 41/100. latencyMs is above baseline',
  behaviorScore: 41,
  attributions: [
    {
      feature: 'latencyMs',
      contribution: 1,
      score: 5.2,
      direction: 'above',
      observed: 3400,
      expected: 800,
      summary: 'latencyMs is above baseline: observed 3400 vs expected 800 (z=5.2)',
    },
  ],
  timestamp: 1_750_000_000_000,
} as const satisfies Alert;

/** Scripted replies for the fake SMTP server; defaults model a happy path. */
interface SmtpScript {
  /** Accept the connection but never write anything (greeting starvation). */
  readonly silent?: boolean;
  readonly greeting?: string;
  /** Full EHLO reply; embed CRLF for multi-line replies. */
  readonly ehlo?: string;
  readonly authChallenge?: string;
  readonly authUsernameReply?: string;
  readonly authPasswordReply?: string;
  readonly mailFrom?: string;
  readonly rcptTo?: string;
  readonly data?: string;
  readonly messageAccepted?: string;
  readonly quit?: string;
}

interface FakeSmtpServer {
  readonly port: number;
  /** Every command-mode line received, including AUTH LOGIN credential lines. */
  readonly commands: readonly string[];
  /** Raw lines received inside the DATA block, before dot-unstuffing. */
  readonly dataLines: readonly string[];
  closedConnections(): number;
  waitForConnectionClose(): Promise<void>;
  close(): Promise<void>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('expected an AddressInfo from server.address()'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function startFakeSmtpServer(script: SmtpScript = {}): Promise<FakeSmtpServer> {
  const commands: string[] = [];
  const dataLines: string[] = [];
  const openSockets = new Set<Socket>();
  let closed = 0;
  let closeWaiters: Array<() => void> = [];

  const server = createServer((socket) => {
    openSockets.add(socket);
    socket.on('error', () => {
      // The client may destroy the socket mid-transaction; that is expected.
    });
    socket.on('close', () => {
      openSockets.delete(socket);
      closed += 1;
      const waiters = closeWaiters;
      closeWaiters = [];
      for (const waiter of waiters) {
        waiter();
      }
    });

    let buffer = '';
    let mode: 'command' | 'data' = 'command';
    let authState: 'none' | 'username' | 'password' = 'none';
    const reply = (text: string): void => {
      socket.write(`${text}\r\n`);
    };

    const handleCommand = (line: string): void => {
      commands.push(line);
      if (authState === 'username') {
        authState = 'password';
        reply(script.authUsernameReply ?? '334 UGFzc3dvcmQ6');
        return;
      }
      if (authState === 'password') {
        authState = 'none';
        reply(script.authPasswordReply ?? '235 2.7.0 Authentication successful');
        return;
      }
      const upper = line.toUpperCase();
      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        reply(script.ehlo ?? '250-fake.local\r\n250 SIZE 1000000');
        return;
      }
      if (upper === 'AUTH LOGIN') {
        authState = 'username';
        reply(script.authChallenge ?? '334 VXNlcm5hbWU6');
        return;
      }
      if (upper.startsWith('MAIL FROM')) {
        reply(script.mailFrom ?? '250 2.1.0 OK');
        return;
      }
      if (upper.startsWith('RCPT TO')) {
        reply(script.rcptTo ?? '250 2.1.5 OK');
        return;
      }
      if (upper === 'DATA') {
        const dataReply = script.data ?? '354 End data with <CR><LF>.<CR><LF>';
        reply(dataReply);
        if (dataReply.startsWith('354')) {
          mode = 'data';
        }
        return;
      }
      if (upper === 'QUIT') {
        reply(script.quit ?? '221 2.0.0 Bye');
        socket.end();
        return;
      }
      reply('500 5.5.1 Unrecognized command');
    };

    const handleLine = (line: string): void => {
      if (mode === 'data') {
        if (line === '.') {
          mode = 'command';
          reply(script.messageAccepted ?? '250 2.0.0 OK: queued');
          return;
        }
        dataLines.push(line);
        return;
      }
      handleCommand(line);
    };

    socket.on('data', (chunk: Buffer) => {
      if (script.silent === true) {
        return;
      }
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
        index = buffer.indexOf('\n');
      }
    });

    if (script.silent !== true) {
      reply(script.greeting ?? '220 fake.local ESMTP behavioralai-test');
    }
  });

  const port = await listen(server);
  return {
    port,
    commands,
    dataLines,
    closedConnections: () => closed,
    waitForConnectionClose(): Promise<void> {
      if (closed > 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        closeWaiters.push(resolve);
      });
    },
    close(): Promise<void> {
      for (const socket of openSockets) {
        socket.destroy();
      }
      return new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

const servers: FakeSmtpServer[] = [];

async function startServer(script: SmtpScript = {}): Promise<FakeSmtpServer> {
  const server = await startFakeSmtpServer(script);
  servers.push(server);
  return server;
}

function lineAt(lines: readonly string[], index: number): string {
  const value = lines[index];
  if (value === undefined) {
    throw new Error(`expected a line at index ${index}`);
  }
  return value;
}

function decodeBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers.length = 0;
});

describe('emailChannel', () => {
  it('delivers an alert without auth and dot-stuffs the message body', async () => {
    const server = await startServer();
    const channel = emailChannel({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      from: 'BehavioralAI Alerts <alerts@example.com>',
      to: ['ops@example.com', 'sre@example.com'],
    });
    expect(channel.name).toBe('email');

    const alert: Alert = { ...ALERT, message: `${ALERT.message}\n.leading dot line` };
    const result = await channel.send(alert);
    expect(result).toEqual({ channel: 'email', ok: true, status: 250 });

    expect(server.commands).toContain('EHLO behavioralai.local');
    expect(server.commands).toContain('MAIL FROM:<alerts@example.com>');
    const rcptLines = server.commands.filter((line) => line.startsWith('RCPT TO'));
    expect(rcptLines).toEqual(['RCPT TO:<ops@example.com>', 'RCPT TO:<sre@example.com>']);
    expect(server.commands).toContain('DATA');
    expect(server.commands).toContain('QUIT');
    expect(server.commands).not.toContain('STARTTLS');
    expect(server.commands.some((line) => line.startsWith('AUTH'))).toBe(false);

    expect(server.dataLines).toContain('From: BehavioralAI Alerts <alerts@example.com>');
    expect(server.dataLines).toContain('To: ops@example.com, sre@example.com');
    expect(server.dataLines).toContain(
      'Subject: [behavioralai] Behavioral drift detected: agent-x',
    );
    expect(server.dataLines).toContain('Message-ID: <agent-x-drift-1750000000000-1@behavioralai>');
    expect(server.dataLines).toContain(
      '- latencyMs is above baseline: observed 3400 vs expected 800 (z=5.2)',
    );
    expect(server.dataLines).toContain('..leading dot line');
    expect(server.dataLines).not.toContain('.leading dot line');
  });

  it('runs AUTH LOGIN with base64 credentials before MAIL FROM', async () => {
    const server = await startServer({
      ehlo: '250-fake.local\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 1000000',
    });
    const channel = emailChannel({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      username: 'alice',
      password: 'secret-pass',
      from: 'alerts@example.com',
      to: 'ops@example.com',
    });

    const result = await channel.send(ALERT);
    expect(result).toEqual({ channel: 'email', ok: true, status: 250 });

    const authIndex = server.commands.indexOf('AUTH LOGIN');
    expect(authIndex).toBeGreaterThan(-1);
    expect(decodeBase64(lineAt(server.commands, authIndex + 1))).toBe('alice');
    expect(decodeBase64(lineAt(server.commands, authIndex + 2))).toBe('secret-pass');
    const mailFromIndex = server.commands.findIndex((line) => line.startsWith('MAIL FROM'));
    expect(mailFromIndex).toBeGreaterThan(authIndex + 2);
    expect(server.commands).not.toContain('STARTTLS');
  });

  it('reports a failed result and closes the socket when RCPT TO is rejected', async () => {
    const server = await startServer({ rcptTo: '550 5.1.1 No such user' });
    const channel = emailChannel({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      from: 'alerts@example.com',
      to: 'nobody@example.com',
    });

    const result = await channel.send(ALERT);
    expect(result.ok).toBe(false);
    expect(result.channel).toBe('email');
    expect(result.error).toContain('SMTP 550');
    expect(result.error).toContain('rcpt-to');

    await server.waitForConnectionClose();
    expect(server.closedConnections()).toBeGreaterThanOrEqual(1);
    expect(server.commands).not.toContain('DATA');
  });

  it('fails with a timeout error when the server never sends a greeting', async () => {
    const server = await startServer({ silent: true });
    const channel = emailChannel({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      timeoutMs: 300,
      from: 'alerts@example.com',
      to: 'ops@example.com',
    });

    const result = await channel.send(ALERT);
    expect(result).toEqual({ channel: 'email', ok: false, error: 'timeout' });
    await server.waitForConnectionClose();
  });

  it('throws synchronously on an empty host', () => {
    expect(() =>
      emailChannel({ host: '', from: 'alerts@example.com', to: 'ops@example.com' }),
    ).toThrow('emailChannel: host must be a non-empty string');
    expect(() =>
      emailChannel({ host: '   ', from: 'alerts@example.com', to: 'ops@example.com' }),
    ).toThrow('emailChannel: host must be a non-empty string');
  });

  it('throws synchronously on an empty from or an empty recipient list', () => {
    expect(() => emailChannel({ host: '127.0.0.1', from: ' ', to: 'ops@example.com' })).toThrow(
      'emailChannel: from must be a non-empty string',
    );
    expect(() => emailChannel({ host: '127.0.0.1', from: 'alerts@example.com', to: [] })).toThrow(
      'emailChannel: to must contain at least one non-empty recipient',
    );
    expect(() =>
      emailChannel({ host: '127.0.0.1', from: 'alerts@example.com', to: ['  '] }),
    ).toThrow('emailChannel: to must contain at least one non-empty recipient');
  });
});
