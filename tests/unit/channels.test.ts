/**
 * Unit tests for the webhook-style alert channels and the shared helpers.
 *
 * All network access is stubbed: fetch is replaced per test and restored in
 * afterEach. Timestamps are fixed epoch constants, never the wall clock.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { discordChannel } from '../../src/channels/discord.js';
import { googleChatChannel } from '../../src/channels/googlechat.js';
import { notionChannel } from '../../src/channels/notion.js';
import { pagerdutyChannel } from '../../src/channels/pagerduty.js';
import { redditChannel } from '../../src/channels/reddit.js';
import {
  alertCompact,
  alertText,
  resolveToken,
  severityColorHex,
  truncate,
} from '../../src/channels/shared.js';
import { slackChannel } from '../../src/channels/slack.js';
import { teamsChannel } from '../../src/channels/teams.js';
import { telegramChannel } from '../../src/channels/telegram.js';
import { webhookChannel } from '../../src/channels/webhook.js';
import type { Alert, AlertChannel, FeatureAttribution } from '../../src/types.js';

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

const ALERT_ISO = new Date(ALERT.timestamp).toISOString();

const COMPACT_LINE =
  '[CRITICAL] Behavioral drift detected: agent-x: Behavior score 41/100. latencyMs is above baseline';

const HOOK_URL = 'https://hooks.example.test/alert';

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

function stubFetchSequence(responses: ReadonlyArray<() => Response>): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: unknown) => {
      calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
      const factory = responses[calls.length - 1];
      if (factory === undefined) {
        throw new Error(`unexpected fetch call number ${calls.length}`);
      }
      return factory();
    }),
  );
  return calls;
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

function bodyJson(init: RequestInit): unknown {
  const parsed: unknown = JSON.parse(String(init.body));
  return parsed;
}

function bodyForm(init: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init.body));
}

function attribution(feature: FeatureAttribution['feature'], summary: string): FeatureAttribution {
  return { feature, contribution: 0.1, score: 1, direction: 'above', summary };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shared helpers', () => {
  it('resolveToken returns a static string as-is', async () => {
    await expect(resolveToken('static-secret')).resolves.toBe('static-secret');
  });

  it('resolveToken invokes sync and async function sources', async () => {
    await expect(resolveToken(() => 'sync-secret')).resolves.toBe('sync-secret');
    await expect(resolveToken(() => Promise.resolve('tok-123'))).resolves.toBe('tok-123');
  });

  it('truncate keeps text at or under the boundary and appends an ellipsis when cut', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello', 5)).toBe('hello');
    expect(truncate('hello!', 5)).toBe('he...');
    expect(truncate('hello!', 5)).toHaveLength(5);
    expect(truncate('abcdef', 3)).toBe('abc');
    expect(truncate('abcdef', 2)).toBe('ab');
    expect(truncate('', 0)).toBe('');
  });

  it('severityColorHex maps each severity to its hex color', () => {
    expect(severityColorHex('info')).toBe('#439fe0');
    expect(severityColorHex('warning')).toBe('#f2c744');
    expect(severityColorHex('critical')).toBe('#e01e5a');
  });

  it('alertText renders title, agent, severity, score, timestamp, message, attributions', () => {
    const text = alertText(ALERT);
    expect(text).toContain('Behavioral drift detected: agent-x');
    expect(text).toContain('Agent: agent-x');
    expect(text).toContain('Severity: critical');
    expect(text).toContain('Kind: drift');
    expect(text).toContain('Behavior score: 41/100');
    expect(text).toContain(ALERT_ISO);
    expect(text).toContain('Behavior score 41/100. latencyMs is above baseline');
    expect(text).toContain('- latencyMs is above baseline: observed 3400 vs expected 800 (z=5.2)');
  });

  it('alertText lists at most five attribution summaries', () => {
    const crowded: Alert = {
      ...ALERT,
      attributions: [
        attribution('latencyMs', 'summary-1'),
        attribution('costUsd', 'summary-2'),
        attribution('inputTokens', 'summary-3'),
        attribution('outputTokens', 'summary-4'),
        attribution('toolCallCount', 'summary-5'),
        attribution('errorRate', 'summary-6'),
      ],
    };
    const lines = alertText(crowded)
      .split('\n')
      .filter((line) => line.startsWith('- '));
    expect(lines).toHaveLength(5);
    expect(alertText(crowded)).not.toContain('summary-6');
  });

  it('alertCompact renders a [SEVERITY] title: message line truncated to 240 characters', () => {
    expect(alertCompact(ALERT)).toBe(COMPACT_LINE);
    const verbose: Alert = { ...ALERT, message: 'm'.repeat(400) };
    const compact = alertCompact(verbose);
    expect(compact).toHaveLength(240);
    expect(compact.endsWith('...')).toBe(true);
    expect(compact.startsWith('[CRITICAL] Behavioral drift detected: agent-x: ')).toBe(true);
  });
});

describe('shared delivery behavior', () => {
  const channelFactories: ReadonlyArray<{
    label: string;
    make: (name?: string) => AlertChannel;
  }> = [
    {
      label: 'slack',
      make: (name) =>
        slackChannel({ webhookUrl: HOOK_URL, ...(name === undefined ? {} : { name }) }),
    },
    {
      label: 'discord',
      make: (name) =>
        discordChannel({ webhookUrl: HOOK_URL, ...(name === undefined ? {} : { name }) }),
    },
    {
      label: 'teams',
      make: (name) =>
        teamsChannel({ webhookUrl: HOOK_URL, ...(name === undefined ? {} : { name }) }),
    },
    {
      label: 'googlechat',
      make: (name) =>
        googleChatChannel({ webhookUrl: HOOK_URL, ...(name === undefined ? {} : { name }) }),
    },
    {
      label: 'telegram',
      make: (name) =>
        telegramChannel({
          botToken: 'bot-token-1',
          chatId: '42',
          ...(name === undefined ? {} : { name }),
        }),
    },
    {
      label: 'pagerduty',
      make: (name) =>
        pagerdutyChannel({ routingKey: 'rk-1', ...(name === undefined ? {} : { name }) }),
    },
    {
      label: 'webhook',
      make: (name) => webhookChannel({ url: HOOK_URL, ...(name === undefined ? {} : { name }) }),
    },
    {
      label: 'notion',
      make: (name) =>
        notionChannel({
          token: 'notion-tok',
          databaseId: 'db-1',
          ...(name === undefined ? {} : { name }),
        }),
    },
  ];

  for (const { label, make } of channelFactories) {
    describe(label, () => {
      it('returns ok true with status 200 and the default channel name', async () => {
        stubFetchOk();
        const result = await make().send(ALERT);
        expect(result).toEqual({ channel: label, ok: true, status: 200 });
      });

      it('returns ok false with the truncated response body on HTTP 500', async () => {
        stubFetch(() => new Response('X'.repeat(300), { status: 500 }));
        const result = await make().send(ALERT);
        expect(result.ok).toBe(false);
        expect(result.status).toBe(500);
        expect(result.error).toBe(`${'X'.repeat(197)}...`);
        expect(result.error).toHaveLength(200);
      });

      it('returns ok false when fetch throws and never propagates the exception', async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => {
            throw new Error('network down');
          }),
        );
        const result = await make().send(ALERT);
        expect(result).toEqual({ channel: label, ok: false, error: 'network down' });
      });

      it('reports the overridden channel name in the result', async () => {
        stubFetchOk();
        const result = await make(`${label}-custom`).send(ALERT);
        expect(result.channel).toBe(`${label}-custom`);
      });
    });
  }
});

describe('slackChannel payload', () => {
  it('posts the compact fallback text plus a section and a context block', async () => {
    const calls = stubFetchOk();
    await slackChannel({ webhookUrl: HOOK_URL }).send(ALERT);
    const call = at(calls, 0);
    expect(call.url).toBe(HOOK_URL);
    expect(call.init.method).toBe('POST');
    expect(headerOf(call.init, 'content-type')).toBe('application/json');
    expect(bodyJson(call.init)).toMatchObject({
      text: COMPACT_LINE,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*${ALERT.title}*\n${ALERT.message}` },
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: 'agent agent-x | severity critical | score 41/100' }],
        },
      ],
    });
  });
});

describe('discordChannel payload', () => {
  it('posts one embed with title, numeric severity color, fields, and timestamp', async () => {
    const calls = stubFetchOk();
    await discordChannel({ webhookUrl: HOOK_URL }).send(ALERT);
    const call = at(calls, 0);
    expect(call.url).toBe(HOOK_URL);
    expect(call.init.method).toBe('POST');
    expect(headerOf(call.init, 'content-type')).toBe('application/json');
    expect(bodyJson(call.init)).toMatchObject({
      content: COMPACT_LINE,
      embeds: [
        {
          title: 'Behavioral drift detected: agent-x',
          description: ALERT.message,
          color: 0xe01e5a,
          fields: [
            {
              name: 'latencyMs',
              value: 'latencyMs is above baseline: observed 3400 vs expected 800 (z=5.2)',
            },
          ],
          timestamp: ALERT_ISO,
        },
      ],
    });
  });
});

describe('teamsChannel payload', () => {
  it('posts a message attachment carrying an Adaptive Card 1.4', async () => {
    const calls = stubFetchOk();
    await teamsChannel({ webhookUrl: HOOK_URL }).send(ALERT);
    const call = at(calls, 0);
    expect(call.url).toBe(HOOK_URL);
    expect(call.init.method).toBe('POST');
    expect(headerOf(call.init, 'content-type')).toBe('application/json');
    expect(bodyJson(call.init)).toMatchObject({
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: { type: 'AdaptiveCard', version: '1.4' },
        },
      ],
    });
  });
});

describe('googleChatChannel payload', () => {
  it('posts the plain-text alert rendering containing the title', async () => {
    const calls = stubFetchOk();
    await googleChatChannel({ webhookUrl: HOOK_URL }).send(ALERT);
    const call = at(calls, 0);
    expect(call.url).toBe(HOOK_URL);
    expect(call.init.method).toBe('POST');
    expect(headerOf(call.init, 'content-type')).toBe('application/json');
    expect(bodyJson(call.init)).toMatchObject({
      text: expect.stringContaining('Behavioral drift detected: agent-x'),
    });
  });
});

describe('telegramChannel payload', () => {
  it('posts to the Bot API sendMessage URL with chat_id and the alert text', async () => {
    const calls = stubFetchOk();
    await telegramChannel({ botToken: 'bot-token-1', chatId: '42' }).send(ALERT);
    const call = at(calls, 0);
    expect(call.url).toBe('https://api.telegram.org/botbot-token-1/sendMessage');
    expect(call.init.method).toBe('POST');
    expect(headerOf(call.init, 'content-type')).toBe('application/json');
    expect(bodyJson(call.init)).toMatchObject({
      chat_id: '42',
      text: alertText(ALERT),
      disable_web_page_preview: true,
    });
  });

  it('truncates the message text to 4000 characters', async () => {
    const calls = stubFetchOk();
    const verbose: Alert = { ...ALERT, message: 'm'.repeat(5000) };
    await telegramChannel({ botToken: 'bot-token-1', chatId: '42' }).send(verbose);
    const body = bodyJson(at(calls, 0).init) as { text: string };
    expect(body.text).toHaveLength(4000);
    expect(body.text.endsWith('...')).toBe(true);
  });
});

describe('pagerdutyChannel payload', () => {
  it('triggers an event with routing key, dedup key, and mapped severity', async () => {
    const calls = stubFetchOk();
    await pagerdutyChannel({ routingKey: 'rk-1' }).send(ALERT);
    const call = at(calls, 0);
    expect(call.url).toBe('https://events.pagerduty.com/v2/enqueue');
    expect(call.init.method).toBe('POST');
    expect(headerOf(call.init, 'content-type')).toBe('application/json');
    expect(bodyJson(call.init)).toMatchObject({
      routing_key: 'rk-1',
      event_action: 'trigger',
      dedup_key: 'agent-x-drift-1750000000000-1',
      payload: {
        summary: COMPACT_LINE,
        source: 'agent-x',
        severity: 'critical',
        timestamp: ALERT_ISO,
        custom_details: { behaviorScore: 41, kind: 'drift' },
      },
    });
  });
});

describe('webhookChannel payload', () => {
  it('round-trips the complete alert object as the JSON body', async () => {
    const calls = stubFetchOk();
    await webhookChannel({ url: HOOK_URL }).send(ALERT);
    const call = at(calls, 0);
    expect(call.url).toBe(HOOK_URL);
    expect(call.init.method).toBe('POST');
    expect(headerOf(call.init, 'content-type')).toBe('application/json');
    const parsed = bodyJson(call.init);
    expect(parsed).toEqual(ALERT);
    expect(parsed).toMatchObject({ agentId: 'agent-x' });
  });
});

describe('notionChannel payload', () => {
  it('creates a page in the database with versioned headers and title property', async () => {
    const calls = stubFetchOk();
    await notionChannel({ token: 'notion-tok', databaseId: 'db-1' }).send(ALERT);
    const call = at(calls, 0);
    expect(call.url).toBe('https://api.notion.com/v1/pages');
    expect(call.init.method).toBe('POST');
    expect(headerOf(call.init, 'content-type')).toBe('application/json');
    expect(headerOf(call.init, 'authorization')).toBe('Bearer notion-tok');
    expect(headerOf(call.init, 'notion-version')).toBe('2022-06-28');
    expect(bodyJson(call.init)).toMatchObject({
      parent: { database_id: 'db-1' },
      properties: {
        Name: { title: [{ text: { content: 'Behavioral drift detected: agent-x' } }] },
        Severity: { select: { name: 'critical' } },
        Agent: { rich_text: [{ text: { content: 'agent-x' } }] },
        Score: { number: 41 },
        Message: { rich_text: [{ text: { content: ALERT.message } }] },
      },
    });
  });
});

describe('TokenSource as function', () => {
  it('resolves the source on every send', async () => {
    stubFetchOk();
    const source = vi.fn(() => Promise.resolve('tok-123'));
    const channel = telegramChannel({ botToken: source, chatId: '42' });
    await channel.send(ALERT);
    await channel.send(ALERT);
    expect(source).toHaveBeenCalledTimes(2);
  });
});

describe('redditChannel', () => {
  const tokenResponse = (token: string) => () =>
    new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), { status: 200 });
  const okResponse = () => () => new Response('{"ok":true}', { status: 200 });

  const makeChannel = (): AlertChannel =>
    redditChannel({
      clientId: 'cid',
      clientSecret: 'csecret',
      username: 'u1',
      password: 'p1',
      subreddit: 'aiops',
    });

  it('exchanges credentials for a token and submits a self post', async () => {
    const calls = stubFetchSequence([tokenResponse('t1'), okResponse()]);
    const result = await makeChannel().send(ALERT);
    expect(result).toEqual({ channel: 'reddit', ok: true, status: 200 });
    expect(calls).toHaveLength(2);

    const tokenCall = at(calls, 0);
    expect(tokenCall.url).toBe('https://www.reddit.com/api/v1/access_token');
    const expectedBasic = `Basic ${Buffer.from('cid:csecret').toString('base64')}`;
    expect(headerOf(tokenCall.init, 'authorization')).toBe(expectedBasic);
    expect(headerOf(tokenCall.init, 'content-type')).toBe('application/x-www-form-urlencoded');
    expect(headerOf(tokenCall.init, 'user-agent')).toBe('behavioralai/1.0.0 (alert channel)');
    const grant = bodyForm(tokenCall.init);
    expect(grant.get('grant_type')).toBe('password');
    expect(grant.get('username')).toBe('u1');
    expect(grant.get('password')).toBe('p1');

    const submitCall = at(calls, 1);
    expect(submitCall.url).toBe('https://oauth.reddit.com/api/submit');
    expect(headerOf(submitCall.init, 'authorization')).toBe('Bearer t1');
    expect(headerOf(submitCall.init, 'user-agent')).toBe('behavioralai/1.0.0 (alert channel)');
    expect(headerOf(submitCall.init, 'content-type')).toBe('application/x-www-form-urlencoded');
    const submission = bodyForm(submitCall.init);
    expect(submission.get('sr')).toBe('aiops');
    expect(submission.get('kind')).toBe('self');
    expect(submission.get('title')).toBe('Behavioral drift detected: agent-x');
    expect(submission.get('text')).toBe(alertText(ALERT));
  });

  it('reuses the cached token across sends', async () => {
    const calls = stubFetchSequence([tokenResponse('t1'), okResponse(), okResponse()]);
    const channel = makeChannel();
    await channel.send(ALERT);
    await channel.send(ALERT);
    expect(calls).toHaveLength(3);
    const tokenCalls = calls.filter((call) => call.url.includes('access_token'));
    expect(tokenCalls).toHaveLength(1);
    expect(headerOf(at(calls, 2).init, 'authorization')).toBe('Bearer t1');
  });

  it('refreshes the token exactly once and retries on a 401 submit response', async () => {
    const calls = stubFetchSequence([
      tokenResponse('t1'),
      () => new Response('unauthorized', { status: 401 }),
      tokenResponse('t2'),
      okResponse(),
    ]);
    const result = await makeChannel().send(ALERT);
    expect(result).toEqual({ channel: 'reddit', ok: true, status: 200 });
    expect(calls).toHaveLength(4);
    expect(at(calls, 2).url).toBe('https://www.reddit.com/api/v1/access_token');
    expect(headerOf(at(calls, 1).init, 'authorization')).toBe('Bearer t1');
    expect(headerOf(at(calls, 3).init, 'authorization')).toBe('Bearer t2');
  });
});
