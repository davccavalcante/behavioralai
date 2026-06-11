/**
 * Cloudflare Worker: observe at the edge, alert through fetch-based
 * channels. Baselines persist by bridging StateBackend to Workers KV.
 *
 * Deploy with wrangler; bind a KV namespace as BASELINES.
 */
import { createBehavioralAI, type StateBackend, type StateSnapshot } from '@takk/behavioralai/edge';
import { discordChannel } from '@takk/behavioralai/channels';

interface Env {
  readonly BASELINES: {
    get(key: string, type: 'json'): Promise<StateSnapshot | null>;
    put(key: string, value: string): Promise<void>;
  };
  readonly DISCORD_WEBHOOK_URL: string;
}

function kvState(env: Env): StateBackend {
  return {
    async load() {
      return (await env.BASELINES.get('snapshot', 'json')) ?? undefined;
    },
    async save(snapshot) {
      await env.BASELINES.put('snapshot', JSON.stringify(snapshot));
    },
    async close() {},
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const radar = createBehavioralAI({
      state: kvState(env),
      channels: [discordChannel({ webhookUrl: env.DISCORD_WEBHOOK_URL })],
    });
    await radar.ready();

    const turn = await request.json();
    const report = radar.observe(turn as Parameters<typeof radar.observe>[0]);
    await radar.flush();

    return Response.json({ behaviorScore: report.behaviorScore, severity: report.severity });
  },
};
