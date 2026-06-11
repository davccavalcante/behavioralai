/**
 * X (Twitter) alert delivery: posts a tweet through the v2 API using either
 * an OAuth2 user-context bearer token or OAuth 1.0a user-context signing.
 *
 * @module
 */

import type { Alert, AlertChannel, ChannelResult } from '../types.js';
import {
  alertCompact,
  type BaseChannelOptions,
  channelFailure,
  postJson,
  resolveToken,
  type TokenSource,
  truncate,
} from './shared.js';

/**
 * Options for {@link xChannel}. Provide either an OAuth2 user-context bearer
 * token, or the four OAuth 1.0a user-context credentials.
 */
export type XChannelOptions = BaseChannelOptions &
  (
    | { bearerToken: TokenSource }
    | { apiKey: string; apiSecret: string; accessToken: string; accessTokenSecret: string }
  );

/** Tweet creation endpoint of the X API v2. */
const TWEET_URL = 'https://api.x.com/2/tweets';

/** RFC 3986 percent encoding: encodeURIComponent plus escaping ! ' ( ) *. */
function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Converts bytes to standard base64. */
function bytesToBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}

/** Random 16-byte nonce rendered as 32 hex characters. */
function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Computes a base64 HMAC-SHA1 signature with crypto.subtle. */
async function hmacSha1Base64(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return bytesToBase64(new Uint8Array(signature));
}

/**
 * Builds an OAuth 1.0a Authorization header for a JSON POST. Body parameters
 * are not part of the signature base string for JSON payloads; only the
 * oauth_* parameters (and query parameters, of which there are none here)
 * are signed, which matches X API v2 JSON usage.
 */
async function oauth1Header(
  credentials: {
    apiKey: string;
    apiSecret: string;
    accessToken: string;
    accessTokenSecret: string;
  },
  method: string,
  url: string,
  timestampSec: number,
): Promise<string> {
  const params: Record<string, string> = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: createNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestampSec),
    oauth_token: credentials.accessToken,
    oauth_version: '1.0',
  };
  const paramString = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key] ?? '')}`)
    .join('&');
  const baseString = `${method}&${percentEncode(url)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(credentials.apiSecret)}&${percentEncode(
    credentials.accessTokenSecret,
  )}`;
  params.oauth_signature = await hmacSha1Base64(signingKey, baseString);
  const header = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(params[key] ?? '')}"`)
    .join(', ');
  return `OAuth ${header}`;
}

/**
 * Creates an alert channel that posts the compact alert line (truncated to
 * 280 characters) as a tweet. The OAuth 1.0a timestamp is derived from the
 * alert timestamp.
 */
export function xChannel(options: XChannelOptions): AlertChannel {
  const name = options.name ?? 'x';
  return {
    name,
    async send(alert: Alert): Promise<ChannelResult> {
      try {
        const authorization =
          'bearerToken' in options
            ? `Bearer ${await resolveToken(options.bearerToken)}`
            : await oauth1Header(options, 'POST', TWEET_URL, Math.floor(alert.timestamp / 1000));
        return await postJson({
          name,
          url: TWEET_URL,
          body: { text: truncate(alertCompact(alert), 280) },
          headers: { Authorization: authorization },
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
      } catch (error) {
        return channelFailure(name, error);
      }
    },
  };
}
