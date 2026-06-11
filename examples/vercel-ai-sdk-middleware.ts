/**
 * Vercel AI SDK middleware: observe every generate/stream call without
 * importing anything from the SDK (structural typing, same pattern as the
 * keymesh and modelchain bridges). Copy this file into your project and
 * wrap your model once; Behavioral AI fingerprints it from then on.
 *
 * Usage with the AI SDK:
 *
 *   import { wrapLanguageModel } from 'ai';
 *   const model = wrapLanguageModel({
 *     model: yourModel,
 *     middleware: behavioralMiddleware(radar, 'support-agent'),
 *   });
 */
import { createBehavioralAI, type BehavioralAI } from '@takk/behavioralai';
import { slackChannel } from '@takk/behavioralai/channels';

/** Structural subset of the AI SDK LanguageModelV2 middleware contract. */
interface GenerateResultLike {
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
  readonly finishReason?: string;
}
interface MiddlewareLike {
  wrapGenerate(options: {
    doGenerate: () => PromiseLike<GenerateResultLike>;
  }): PromiseLike<GenerateResultLike>;
}

/** Wraps doGenerate with one observe() call per completed generation. */
export function behavioralMiddleware(radar: BehavioralAI, agentId: string): MiddlewareLike {
  return {
    async wrapGenerate({ doGenerate }) {
      const startedAt = Date.now();
      try {
        const result = await doGenerate();
        radar.observe({
          agentId,
          latencyMs: Date.now() - startedAt,
          ...(result.usage?.inputTokens !== undefined
            ? { inputTokens: result.usage.inputTokens }
            : {}),
          ...(result.usage?.outputTokens !== undefined
            ? { outputTokens: result.usage.outputTokens }
            : {}),
          ...(result.finishReason !== undefined ? { finishReason: result.finishReason } : {}),
        });
        return result;
      } catch (cause) {
        radar.observe({ agentId, latencyMs: Date.now() - startedAt, error: true });
        throw cause;
      }
    },
  };
}

export const radar = createBehavioralAI({
  channels: [slackChannel({ webhookUrl: process.env.SLACK_WEBHOOK_URL ?? '' })],
});
