/**
 * Google OAuth2 access-token acquisition shared by the Google channels.
 * Supports a caller-provided access token or a service-account JWT bearer
 * grant signed with crypto.subtle (RS256).
 *
 * @module
 */

import { resolveToken, type TokenSource } from './shared.js';

/** Authentication input accepted by the Google channels. */
export type GoogleAuth =
  | { accessToken: TokenSource }
  | { serviceAccount: { clientEmail: string; privateKey: string } };

/** Cached service-account tokens keyed by client email plus joined scopes. */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Decodes a PEM PKCS#8 private key into raw DER bytes. */
function pemToBuffer(pem: string): Uint8Array<ArrayBuffer> {
  const base64 = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Base64url-encodes bytes without padding. */
function base64UrlEncode(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Base64url-encodes a UTF-8 string without padding. */
function base64UrlEncodeText(text: string): string {
  return base64UrlEncode(new TextEncoder().encode(text));
}

/**
 * Resolves an access token for the given scopes. A caller-provided
 * `accessToken` source is resolved as-is. A service account goes through the
 * JWT bearer grant (RS256, one hour lifetime) and the resulting token is
 * cached per client email and scope set until 60 seconds before expiry.
 * Throws on failure; the Google channels convert the throw into a failed
 * ChannelResult.
 */
export async function googleAccessToken(
  auth: GoogleAuth,
  scopes: readonly string[],
): Promise<string> {
  if ('accessToken' in auth) {
    return resolveToken(auth.accessToken);
  }
  const { clientEmail, privateKey } = auth.serviceAccount;
  const cacheKey = `${clientEmail}|${scopes.join(' ')}`;
  const cached = tokenCache.get(cacheKey);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.token;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64UrlEncodeText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64UrlEncodeText(
    JSON.stringify({
      iss: clientEmail,
      scope: scopes.join(' '),
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToBuffer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );
  const assertion = `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(`google token request failed with HTTP ${response.status}`);
  }
  const data: unknown = await response.json();
  if (data === null || typeof data !== 'object') {
    throw new Error('google token response is not an object');
  }
  const record = data as Record<string, unknown>;
  const accessToken = record.access_token;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('google token response has no access_token');
  }
  const expiresIn = typeof record.expires_in === 'number' ? record.expires_in : 3600;
  tokenCache.set(cacheKey, {
    token: accessToken,
    expiresAt: Date.now() + (expiresIn - 60) * 1000,
  });
  return accessToken;
}
