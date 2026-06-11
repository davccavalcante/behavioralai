/**
 * Unit tests for the authenticated channels: x (OAuth2 bearer and OAuth 1.0a),
 * google-auth (service-account JWT bearer grant), and the Google Sheets and
 * Google Docs channels.
 *
 * All network access is stubbed. The RSA key pair is generated in-process and
 * the JWT signature is verified against the matching public key.
 */

import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { googleAccessToken } from '../../src/channels/google-auth.js';
import { googleDocsChannel } from '../../src/channels/googledocs.js';
import { googleSheetsChannel } from '../../src/channels/googlesheets.js';
import { alertCompact, alertText } from '../../src/channels/shared.js';
import { xChannel } from '../../src/channels/x.js';
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

const TWEET_URL = 'https://api.x.com/2/tweets';

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(respond: (call: CapturedCall) => Response): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: unknown) => {
      const call: CapturedCall = { url: String(url), init: (init ?? {}) as RequestInit };
      calls.push(call);
      return respond(call);
    }),
  );
  return calls;
}

function stubFetchOk(): CapturedCall[] {
  return stubFetch(() => new Response('{"ok":true}', { status: 200 }));
}

function at(calls: readonly CapturedCall[], index: number): CapturedCall {
  const call = calls[index];
  if (call === undefined) {
    throw new Error(`expected a fetch call at index ${index}, observed ${calls.length} calls`);
  }
  return call;
}

function headerOf(init: RequestInit, key: string): string | null {
  return new Headers(init.headers).get(key);
}

function requireHeader(init: RequestInit, key: string): string {
  const value = headerOf(init, key);
  if (value === null) {
    throw new Error(`expected a ${key} header`);
  }
  return value;
}

function bodyJson(init: RequestInit): unknown {
  const parsed: unknown = JSON.parse(String(init.body));
  return parsed;
}

/** RFC 3986 percent encoding mirroring the implementation under test. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Parses an OAuth 1.0a Authorization header into decoded key/value pairs. */
function parseOAuthHeader(header: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of header.slice('OAuth '.length).matchAll(/([a-z_]+)="([^"]*)"/g)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) {
      map.set(key, decodeURIComponent(value));
    }
  }
  return map;
}

// One shared RSA-2048 key pair for the service-account tests.
const { publicKey: PUBLIC_KEY_PEM, privateKey: PRIVATE_KEY_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('xChannel OAuth2 bearer mode', () => {
  it('posts the compact alert line to the tweets endpoint with a Bearer header', async () => {
    const calls = stubFetchOk();
    const result = await xChannel({ bearerToken: 'xb-token' }).send(ALERT);
    const call = at(calls, 0);
    expect(call.url).toBe(TWEET_URL);
    expect(call.init.method).toBe('POST');
    expect(headerOf(call.init, 'authorization')).toBe('Bearer xb-token');
    expect(headerOf(call.init, 'content-type')).toBe('application/json');
    expect(bodyJson(call.init)).toEqual({
      text: '[CRITICAL] Behavioral drift detected: agent-x: Behavior score 41/100. latencyMs is above baseline',
    });
    expect(result).toEqual({ channel: 'x', ok: true, status: 200 });
  });

  it('keeps the tweet text within 280 characters for long alerts', async () => {
    const calls = stubFetchOk();
    const verbose: Alert = { ...ALERT, message: 'm'.repeat(500) };
    await xChannel({ bearerToken: 'xb-token' }).send(verbose);
    const body = bodyJson(at(calls, 0).init) as { text: string };
    // alertCompact pre-truncates to 240, so the 280 cap is never the binding limit.
    expect(body.text).toBe(alertCompact(verbose));
    expect(body.text.length).toBeLessThanOrEqual(280);
  });
});

describe('xChannel OAuth 1.0a mode', () => {
  const credentials = {
    apiKey: 'ck',
    apiSecret: 'cs',
    accessToken: 'at-1',
    accessTokenSecret: 'as-1',
  };

  it('builds a structurally complete OAuth header with the alert-derived timestamp', async () => {
    const calls = stubFetchOk();
    await xChannel(credentials).send(ALERT);
    const call = at(calls, 0);
    expect(call.url).toBe(TWEET_URL);
    const header = requireHeader(call.init, 'authorization');
    expect(header.startsWith('OAuth ')).toBe(true);
    expect(header).toContain('oauth_consumer_key="ck"');
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(header).toContain('oauth_timestamp="1750000000"');
    expect(header).toContain('oauth_token="at-1"');
    expect(header).toContain('oauth_version="1.0"');
    expect(header).toMatch(/oauth_nonce="[0-9a-f]{32}"/);
    expect(header).toMatch(/oauth_signature="[A-Za-z0-9%]+"/);
  });

  it('signs the oauth parameters with HMAC-SHA1 over the RFC 5849 base string', async () => {
    const calls = stubFetchOk();
    await xChannel(credentials).send(ALERT);
    const header = requireHeader(at(calls, 0).init, 'authorization');
    const params = parseOAuthHeader(header);
    const signedKeys = [
      'oauth_consumer_key',
      'oauth_nonce',
      'oauth_signature_method',
      'oauth_timestamp',
      'oauth_token',
      'oauth_version',
    ];
    const paramString = signedKeys
      .map((key) => `${rfc3986(key)}=${rfc3986(params.get(key) ?? '')}`)
      .join('&');
    const baseString = `POST&${rfc3986(TWEET_URL)}&${rfc3986(paramString)}`;
    const signingKey = `${rfc3986(credentials.apiSecret)}&${rfc3986(credentials.accessTokenSecret)}`;
    const expected = createHmac('sha1', signingKey).update(baseString).digest('base64');
    expect(params.get('oauth_signature')).toBe(expected);
  });

  it('produces a fresh nonce on every send', async () => {
    const calls = stubFetchOk();
    const channel = xChannel(credentials);
    await channel.send(ALERT);
    await channel.send(ALERT);
    const first = parseOAuthHeader(requireHeader(at(calls, 0).init, 'authorization'));
    const second = parseOAuthHeader(requireHeader(at(calls, 1).init, 'authorization'));
    expect(first.get('oauth_nonce')).toMatch(/^[0-9a-f]{32}$/);
    expect(second.get('oauth_nonce')).toMatch(/^[0-9a-f]{32}$/);
    expect(first.get('oauth_nonce')).not.toBe(second.get('oauth_nonce'));
  });
});

describe('googleAccessToken service account mode', () => {
  const tokenResponse = (): Response =>
    new Response(JSON.stringify({ access_token: 'ga-token', expires_in: 3600 }), { status: 200 });

  it('posts a verifiable RS256 JWT bearer assertion to the token endpoint', async () => {
    const calls = stubFetch(tokenResponse);
    const token = await googleAccessToken(
      { serviceAccount: { clientEmail: 'svc@test.iam', privateKey: PRIVATE_KEY_PEM } },
      ['scope-a'],
    );
    expect(token).toBe('ga-token');

    const call = at(calls, 0);
    expect(call.url).toBe('https://oauth2.googleapis.com/token');
    expect(call.init.method).toBe('POST');
    expect(headerOf(call.init, 'content-type')).toBe('application/x-www-form-urlencoded');

    const form = new URLSearchParams(String(call.init.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = form.get('assertion');
    if (assertion === null) {
      throw new Error('expected an assertion in the token request body');
    }

    const parts = assertion.split('.');
    expect(parts).toHaveLength(3);
    const [headerPart, claimsPart, signaturePart] = parts;
    if (headerPart === undefined || claimsPart === undefined || signaturePart === undefined) {
      throw new Error('expected a three-part JWT assertion');
    }

    const jwtHeader: unknown = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    expect(jwtHeader).toEqual({ alg: 'RS256', typ: 'JWT' });

    const claims: unknown = JSON.parse(Buffer.from(claimsPart, 'base64url').toString('utf8'));
    expect(claims).toMatchObject({
      iss: 'svc@test.iam',
      scope: 'scope-a',
      aud: 'https://oauth2.googleapis.com/token',
    });

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerPart}.${claimsPart}`);
    expect(verifier.verify(PUBLIC_KEY_PEM, Buffer.from(signaturePart, 'base64url'))).toBe(true);
  });

  it('caches the token per client email and scope set', async () => {
    const calls = stubFetch(tokenResponse);
    const auth = {
      serviceAccount: { clientEmail: 'svc-cache@test.iam', privateKey: PRIVATE_KEY_PEM },
    };
    const first = await googleAccessToken(auth, ['scope-a']);
    const second = await googleAccessToken(auth, ['scope-a']);
    expect(first).toBe('ga-token');
    expect(second).toBe('ga-token');
    expect(calls).toHaveLength(1);
  });

  it('returns a caller-provided access token without any fetch', async () => {
    const calls = stubFetch(() => {
      throw new Error('no fetch expected');
    });
    await expect(googleAccessToken({ accessToken: 'plain-tok' }, ['scope-a'])).resolves.toBe(
      'plain-tok',
    );
    await expect(
      googleAccessToken({ accessToken: () => Promise.resolve('fn-tok') }, ['scope-a']),
    ).resolves.toBe('fn-tok');
    expect(calls).toHaveLength(0);
  });
});

describe('googleSheetsChannel', () => {
  it('appends one row to the default sheet with a Bearer header', async () => {
    const calls = stubFetchOk();
    const channel = googleSheetsChannel({
      spreadsheetId: 'sheet-123',
      auth: { accessToken: 'tok' },
    });
    const result = await channel.send(ALERT);
    const call = at(calls, 0);
    expect(call.url).toBe(
      'https://sheets.googleapis.com/v4/spreadsheets/sheet-123/values/Sheet1!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
    );
    expect(call.init.method).toBe('POST');
    expect(headerOf(call.init, 'authorization')).toBe('Bearer tok');
    expect(headerOf(call.init, 'content-type')).toBe('application/json');
    expect(bodyJson(call.init)).toEqual({
      values: [
        [
          new Date(ALERT.timestamp).toISOString(),
          'agent-x',
          'critical',
          'drift',
          41,
          'latencyMs',
          'Behavior score 41/100. latencyMs is above baseline',
        ],
      ],
    });
    expect(result).toEqual({ channel: 'googlesheets', ok: true, status: 200 });
  });
});

describe('googleDocsChannel', () => {
  it('appends the alert text through a batchUpdate insertText request', async () => {
    const calls = stubFetchOk();
    const channel = googleDocsChannel({ documentId: 'doc-9', auth: { accessToken: 'tok' } });
    const result = await channel.send(ALERT);
    const call = at(calls, 0);
    expect(call.url).toBe('https://docs.googleapis.com/v1/documents/doc-9:batchUpdate');
    expect(call.init.method).toBe('POST');
    expect(headerOf(call.init, 'authorization')).toBe('Bearer tok');
    expect(headerOf(call.init, 'content-type')).toBe('application/json');
    expect(bodyJson(call.init)).toEqual({
      requests: [
        {
          insertText: {
            endOfSegmentLocation: { segmentId: '' },
            text: `\n${alertText(ALERT)}\n`,
          },
        },
      ],
    });
    expect(result).toEqual({ channel: 'googledocs', ok: true, status: 200 });
  });
});
