/**
 * Reddit alert delivery: submits a self post to a subreddit using the
 * script-app OAuth2 password grant.
 *
 * @module
 */

import type { Alert, AlertChannel, ChannelResult } from '../types.js';
import {
  alertText,
  type BaseChannelOptions,
  channelFailure,
  postJson,
  resolveToken,
  type TokenSource,
  truncate,
} from './shared.js';

/** Options for {@link redditChannel}. */
export interface RedditChannelOptions extends BaseChannelOptions {
  /** Script-app client id. */
  clientId: string;
  /** Script-app client secret. */
  clientSecret: TokenSource;
  /** Reddit account username that owns the script app. */
  username: string;
  /** Reddit account password. */
  password: TokenSource;
  /** Target subreddit name, without the "r/" prefix. */
  subreddit: string;
  /** User-Agent header sent with every request. */
  userAgent?: string;
}

/** Default User-Agent identifying this client to Reddit. */
const DEFAULT_USER_AGENT = 'behavioralai/1.0.0 (alert channel)';

/** Default request timeout, milliseconds. */
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Creates an alert channel that posts each alert as a self post to a
 * subreddit. The OAuth2 access token is cached in the closure until 60
 * seconds before its reported expiry (monotonic clock); on a 401 response the
 * cache is invalidated and the submission is retried exactly once.
 */
export function redditChannel(options: RedditChannelOptions): AlertChannel {
  const name = options.name ?? 'reddit';
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let cached: { token: string; expiresAt: number } | undefined;

  const acquireToken = async (): Promise<string> => {
    if (cached !== undefined && cached.expiresAt > performance.now()) {
      return cached.token;
    }
    const secret = await resolveToken(options.clientSecret);
    const password = await resolveToken(options.password);
    const response = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${options.clientId}:${secret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent,
      },
      body: new URLSearchParams({
        grant_type: 'password',
        username: options.username,
        password,
      }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`reddit token request failed with HTTP ${response.status}`);
    }
    const data: unknown = await response.json();
    if (data === null || typeof data !== 'object') {
      throw new Error('reddit token response is not an object');
    }
    const record = data as Record<string, unknown>;
    const accessToken = record.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new Error('reddit token response has no access_token');
    }
    const expiresIn = typeof record.expires_in === 'number' ? record.expires_in : 3600;
    cached = { token: accessToken, expiresAt: performance.now() + (expiresIn - 60) * 1000 };
    return accessToken;
  };

  const submit = (token: string, alert: Alert): Promise<ChannelResult> =>
    postJson({
      name,
      url: 'https://oauth.reddit.com/api/submit',
      form: true,
      body: {
        sr: options.subreddit,
        kind: 'self',
        title: truncate(alert.title, 300),
        text: alertText(alert),
      },
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': userAgent,
      },
      timeoutMs,
    });

  return {
    name,
    async send(alert: Alert): Promise<ChannelResult> {
      try {
        let result = await submit(await acquireToken(), alert);
        if (!result.ok && result.status === 401) {
          cached = undefined;
          result = await submit(await acquireToken(), alert);
        }
        return result;
      } catch (error) {
        return channelFailure(name, error);
      }
    },
  };
}
