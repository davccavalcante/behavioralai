/**
 * @takk/behavioralai - error hierarchy.
 *
 * Every error thrown by this package is a {@link BehavioralaiError}. Channel
 * delivery failures are never thrown; they surface as `ChannelResult.ok ===
 * false` and as `alert.failed` telemetry events, so one broken webhook can
 * never crash the observed agent.
 *
 * @module
 */

/** Base class for every error thrown by @takk/behavioralai. */
export class BehavioralaiError extends Error {
  override readonly name: string = 'BehavioralaiError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Invalid options or invalid observation shape supplied by the caller. */
export class ConfigurationError extends BehavioralaiError {
  override readonly name = 'ConfigurationError';
}

/** A state backend failed to load or persist a snapshot. */
export class StateError extends BehavioralaiError {
  override readonly name = 'StateError';
}

/** The engine was used after `close()`. */
export class ClosedError extends BehavioralaiError {
  override readonly name = 'ClosedError';
}
