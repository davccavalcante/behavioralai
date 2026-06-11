/**
 * Email alert channel over a minimal built-in SMTP client.
 *
 * Node-only module: `node:net` and `node:tls` are loaded with dynamic
 * imports inside `send()`, so the file itself imports cleanly on any
 * runtime; on non-Node platforms delivery attempts resolve to a failed
 * {@link ChannelResult} instead of throwing.
 *
 * @module
 */

import type { Alert, AlertChannel, ChannelResult } from '../types.js';

/**
 * A static credential or a synchronous or asynchronous provider for one.
 * Local copy of the shape used by other modules, kept here so the SMTP
 * module stays decoupled.
 */
export type TokenSource = string | (() => string | Promise<string>);

/** Options accepted by {@link emailChannel}. */
export interface EmailChannelOptions {
  /** SMTP server hostname. Required, non-empty. */
  host: string;
  /** SMTP server port. Default 587. */
  port?: number;
  /** Use implicit TLS from the first byte. Default true only when port is 465. */
  secure?: boolean;
  /** AUTH LOGIN username. Authentication runs only when both credentials are set. */
  username?: string;
  /** AUTH LOGIN password or password provider. */
  password?: TokenSource;
  /** Envelope sender and From header. Required, non-empty. */
  from: string;
  /** One recipient or a list of recipients. Required, non-empty. */
  to: string | readonly string[];
  /** Prefix prepended to the alert title in the Subject header. Default "[behavioralai]". */
  subjectPrefix?: string;
  /** Hostname announced in EHLO. Default "behavioralai.local". */
  helo?: string;
  /** Channel name reported in results. Default "email". */
  name?: string;
  /** Timeout for the whole SMTP transaction, milliseconds. Default 15000. */
  timeoutMs?: number;
}

/** Socket shape shared by plain TCP and TLS connections (type-only import). */
type Socket = import('node:net').Socket;

/** One complete SMTP server reply, possibly spanning multiple lines. */
interface SmtpReply {
  readonly code: number;
  readonly lines: readonly string[];
}

/** Sequential consumer of SMTP replies arriving on a socket. */
interface ReplyReader {
  next(): Promise<SmtpReply>;
  detach(): void;
}

/** Fully resolved configuration captured by the factory. */
interface ResolvedEmailConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly username?: string;
  readonly password?: TokenSource;
  readonly from: string;
  readonly recipients: readonly string[];
  readonly subjectPrefix: string;
  readonly helo: string;
  readonly channelName: string;
}

/**
 * Keeps an unexpected socket error from crashing the process; actual error
 * routing happens through the reply reader and event waiters.
 */
function ignoreSocketError(): void {
  // Intentionally empty: failures surface via the reply reader.
}

/** Extracts a short human-readable message from an unknown thrown value. */
function shortError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

/** Returns the address inside angle brackets when present, the trimmed value otherwise. */
function extractAddress(value: string): string {
  const match = /<([^<>]+)>/.exec(value);
  const inner = match?.[1];
  return (inner ?? value).trim();
}

/** Removes CR and LF so a value is safe inside a single header line. */
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** Encodes a credential for the AUTH LOGIN exchange. */
function toBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

/** True when an EHLO reply advertises the STARTTLS extension. */
function advertisesStartTls(reply: SmtpReply): boolean {
  return reply.lines.some((line) => line.slice(4).trim().toUpperCase() === 'STARTTLS');
}

/**
 * Resolves when the named event fires; rejects on socket error or close.
 * Used for connection establishment and the TLS handshake.
 */
function waitForEvent(socket: Socket, eventName: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      socket.off(eventName, onSuccess);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onSuccess = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('connection closed'));
    };
    socket.once(eventName, onSuccess);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

/**
 * Attaches a line-oriented SMTP reply parser to a socket. A reply is
 * complete when a line matches `/^\d{3} /` (or a bare three-digit code);
 * lines matching `/^\d{3}-/` continue the same reply.
 */
function attachReader(socket: Socket): ReplyReader {
  let buffer = '';
  let current: string[] = [];
  const queue: SmtpReply[] = [];
  let waiter:
    | { readonly resolve: (reply: SmtpReply) => void; readonly reject: (error: Error) => void }
    | undefined;
  let failure: Error | undefined;

  const deliver = (reply: SmtpReply): void => {
    if (waiter !== undefined) {
      const pending = waiter;
      waiter = undefined;
      pending.resolve(reply);
      return;
    }
    queue.push(reply);
  };

  const fail = (error: Error): void => {
    if (failure === undefined) {
      failure = error;
    }
    if (waiter !== undefined) {
      const pending = waiter;
      waiter = undefined;
      pending.reject(error);
    }
  };

  const onData = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      current.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        const code = Number.parseInt(line.slice(0, 3), 10);
        const lines = current;
        current = [];
        deliver({ code, lines });
      }
      index = buffer.indexOf('\n');
    }
  };
  const onError = (error: Error): void => {
    fail(error);
  };
  const onClose = (): void => {
    fail(new Error('connection closed'));
  };

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);

  return {
    next(): Promise<SmtpReply> {
      const queued = queue.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }
      if (failure !== undefined) {
        return Promise.reject(failure);
      }
      return new Promise<SmtpReply>((resolve, reject) => {
        waiter = { resolve, reject };
      });
    },
    detach(): void {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    },
  };
}

/** Awaits the next reply and fails the transaction on any code >= 400. */
async function expectReply(reader: ReplyReader, stage: string): Promise<SmtpReply> {
  const reply = await reader.next();
  if (reply.code >= 400) {
    throw new Error(`SMTP ${reply.code} at ${stage}`);
  }
  return reply;
}

/** Writes one command line and awaits a non-failure reply. */
async function command(
  socket: Socket,
  reader: ReplyReader,
  line: string,
  stage: string,
): Promise<SmtpReply> {
  socket.write(`${line}\r\n`);
  return expectReply(reader, stage);
}

/** Formats the plain-text alert body. */
function buildBody(alert: Alert): string {
  const lines: string[] = [
    alert.title,
    '',
    `Agent: ${alert.agentId}`,
    `Severity: ${alert.severity}`,
    `Kind: ${alert.kind}`,
    `Behavior score: ${alert.behaviorScore}`,
    `Timestamp: ${new Date(alert.timestamp).toISOString()}`,
    '',
    alert.message,
  ];
  const attributions = alert.attributions.slice(0, 5);
  if (attributions.length > 0) {
    lines.push('', 'Attributions:');
    for (const attribution of attributions) {
      lines.push(`- ${attribution.summary}`);
    }
  }
  return lines.join('\n');
}

/**
 * Builds the full RFC 5322 message (headers, blank line, body) with CRLF
 * line endings and dot-stuffed lines.
 */
function buildMessage(alert: Alert, config: ResolvedEmailConfig): string {
  const headers = [
    `From: ${sanitizeHeader(config.from)}`,
    `To: ${sanitizeHeader(config.recipients.join(', '))}`,
    `Subject: ${sanitizeHeader(`${config.subjectPrefix} ${alert.title}`)}`,
    `Date: ${new Date(alert.timestamp).toUTCString()}`,
    `Message-ID: <${sanitizeHeader(alert.id)}@behavioralai>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  const raw = `${headers.join('\n')}\n\n${buildBody(alert)}`;
  return raw
    .split(/\r\n|\r|\n/)
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

/**
 * Runs the full SMTP transaction: connect, EHLO, optional STARTTLS upgrade,
 * optional AUTH LOGIN, envelope, DATA, QUIT. Throws on any failure; every
 * created socket is pushed into `sockets` so the caller can destroy it.
 */
async function performDelivery(
  alert: Alert,
  config: ResolvedEmailConfig,
  sockets: Socket[],
): Promise<ChannelResult> {
  const net = await import('node:net');
  const tls = await import('node:tls');
  const password =
    typeof config.password === 'function' ? await config.password() : config.password;

  let active: Socket;
  if (config.secure) {
    active = tls.connect({ host: config.host, port: config.port, servername: config.host });
    active.on('error', ignoreSocketError);
    sockets.push(active);
    await waitForEvent(active, 'secureConnect');
  } else {
    active = net.connect({ host: config.host, port: config.port });
    active.on('error', ignoreSocketError);
    sockets.push(active);
    await waitForEvent(active, 'connect');
  }

  let reader = attachReader(active);
  await expectReply(reader, 'greeting');
  const ehlo = await command(active, reader, `EHLO ${config.helo}`, 'ehlo');

  if (!config.secure && advertisesStartTls(ehlo)) {
    await command(active, reader, 'STARTTLS', 'starttls');
    reader.detach();
    const upgraded = tls.connect({ socket: active, servername: config.host });
    upgraded.on('error', ignoreSocketError);
    sockets.push(upgraded);
    active = upgraded;
    await waitForEvent(active, 'secureConnect');
    reader = attachReader(active);
    await command(active, reader, `EHLO ${config.helo}`, 'ehlo');
  }

  if (config.username !== undefined && password !== undefined) {
    await command(active, reader, 'AUTH LOGIN', 'auth');
    await command(active, reader, toBase64(config.username), 'auth-username');
    await command(active, reader, toBase64(password), 'auth-password');
  }

  await command(active, reader, `MAIL FROM:<${extractAddress(config.from)}>`, 'mail-from');
  for (const recipient of config.recipients) {
    await command(active, reader, `RCPT TO:<${extractAddress(recipient)}>`, 'rcpt-to');
  }
  await command(active, reader, 'DATA', 'data');
  active.write(`${buildMessage(alert, config)}\r\n.\r\n`);
  await expectReply(reader, 'message');

  try {
    await command(active, reader, 'QUIT', 'quit');
  } catch {
    // The server already accepted the message; a failed QUIT does not undo delivery.
  }
  return { channel: config.channelName, ok: true, status: 250 };
}

/**
 * Creates an email alert channel backed by a minimal built-in SMTP client.
 *
 * Defaults: port 587, implicit TLS only on port 465, opportunistic STARTTLS
 * upgrade when the server advertises it, AUTH LOGIN when both username and
 * password are provided, 15000 ms transaction timeout. `send` never throws
 * and never rejects; failures are reported through the channel result.
 *
 * @throws Error when host, from, or to is empty (factory-time validation).
 */
export function emailChannel(options: EmailChannelOptions): AlertChannel {
  const host = options.host.trim();
  if (host.length === 0) {
    throw new Error('emailChannel: host must be a non-empty string');
  }
  const from = options.from.trim();
  if (from.length === 0) {
    throw new Error('emailChannel: from must be a non-empty string');
  }
  const recipients = (typeof options.to === 'string' ? [options.to] : [...options.to])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (recipients.length === 0) {
    throw new Error('emailChannel: to must contain at least one non-empty recipient');
  }

  const port = options.port ?? 587;
  const config: ResolvedEmailConfig = {
    host,
    port,
    secure: options.secure ?? port === 465,
    from,
    recipients,
    subjectPrefix: options.subjectPrefix ?? '[behavioralai]',
    helo: options.helo ?? 'behavioralai.local',
    channelName: options.name ?? 'email',
    ...(options.username !== undefined ? { username: options.username } : {}),
    ...(options.password !== undefined ? { password: options.password } : {}),
  };
  const timeoutMs = options.timeoutMs ?? 15000;

  return {
    name: config.channelName,
    async send(alert: Alert): Promise<ChannelResult> {
      const sockets: Socket[] = [];
      let timedOut = false;
      let fireTimeout: (() => void) | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        fireTimeout = (): void => {
          timedOut = true;
          for (const socket of sockets) {
            socket.destroy();
          }
          reject(new Error('timeout'));
        };
      });
      const timer = setTimeout(() => {
        fireTimeout?.();
      }, timeoutMs);
      try {
        return await Promise.race([performDelivery(alert, config, sockets), deadline]);
      } catch (error) {
        return {
          channel: config.channelName,
          ok: false,
          error: timedOut ? 'timeout' : shortError(error),
        };
      } finally {
        clearTimeout(timer);
        for (const socket of sockets) {
          socket.destroy();
        }
      }
    },
  };
}
