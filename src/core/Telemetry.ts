import type { TelemetryEvent, TelemetryListener } from '../types.js';

/**
 * Minimal synchronous event bus. Listener errors are swallowed so a broken
 * consumer can never disturb the observed agent; the engine is a passive
 * observer by contract.
 */
export class Telemetry {
  private readonly listeners = new Set<TelemetryListener>();

  on(listener: TelemetryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: TelemetryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener failures are intentionally ignored.
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
