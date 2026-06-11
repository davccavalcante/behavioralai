import type { Telemetry } from '../core/Telemetry.js';
import type { Alert, AlertChannel, AlertEnricher, ChannelResult } from '../types.js';

/**
 * Fans one alert out to every configured channel. Fire-and-forget from the
 * caller's perspective (observe() never blocks on network), but every
 * in-flight delivery is tracked so flush() can await full drain. Channel
 * failures surface as telemetry, never as exceptions.
 */
export class AlertDispatcher {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly channels: readonly AlertChannel[],
    private readonly telemetry: Telemetry,
    private readonly enrich: AlertEnricher | undefined,
    private readonly now: () => number,
  ) {}

  /** Start async delivery of one alert to all channels. */
  dispatch(alert: Alert): void {
    if (this.channels.length === 0) return;
    const task = this.deliver(alert).catch(() => {
      // deliver() already reported failures via telemetry.
    });
    this.pending.add(task);
    void task.finally(() => {
      this.pending.delete(task);
    });
  }

  /** Resolve when every in-flight delivery has settled. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  private async deliver(alert: Alert): Promise<void> {
    let payload = alert;
    if (this.enrich !== undefined) {
      try {
        payload = await this.enrich(alert);
      } catch (cause) {
        this.telemetry.emit({
          kind: 'error',
          timestamp: this.now(),
          agentId: alert.agentId,
          message: `alert enricher failed: ${describe(cause)}`,
        });
      }
    }

    const results = await Promise.allSettled(
      this.channels.map((channel) => this.sendTo(channel, payload)),
    );
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const channelResult = result.value;
        this.telemetry.emit({
          kind: channelResult.ok ? 'alert.dispatched' : 'alert.failed',
          timestamp: this.now(),
          agentId: payload.agentId,
          severity: payload.severity,
          channel: channelResult.channel,
          alert: payload,
          ...(channelResult.error !== undefined ? { message: channelResult.error } : {}),
        });
      }
    }
  }

  private async sendTo(channel: AlertChannel, alert: Alert): Promise<ChannelResult> {
    try {
      return await channel.send(alert);
    } catch (cause) {
      // Channels promise not to throw, but a misbehaving one must not leak.
      return { channel: channel.name, ok: false, error: describe(cause) };
    }
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
