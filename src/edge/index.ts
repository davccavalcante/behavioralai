/**
 * Edge-runtime entry for @takk/behavioralai (Cloudflare Workers, Vercel
 * Edge, Deno, Bun).
 *
 * Identical to the core surface minus the Node-only file state backend.
 * Pair it with `@takk/behavioralai/channels` (fetch-based, edge-safe) for
 * alert delivery; persist baselines by bridging a {@link StateBackend} to
 * your platform KV store.
 *
 * @module
 */

export { createBehavioralAI } from '../core/createBehavioralAI.js';
export { resolveSensitivity, SENSITIVITY_PRESETS } from '../drift/sensitivity.js';
export { BehavioralaiError, ClosedError, ConfigurationError, StateError } from '../errors.js';
export { computeBehaviorScore } from '../fingerprint/Fingerprint.js';
export { memoryState } from '../state/memory.js';

export type {
  AgentId,
  Alert,
  AlertChannel,
  AlertEnricher,
  AlertKind,
  AlertPolicy,
  BaselineStatus,
  BehavioralAI,
  BehavioralAIOptions,
  CategoricalFeatureName,
  CategoricalFeatureSnapshot,
  ChannelResult,
  DriftDirection,
  DriftFinding,
  DriftReport,
  FeatureAttribution,
  FeatureName,
  FingerprintSnapshot,
  NumericFeatureName,
  NumericFeatureSnapshot,
  RadarSnapshot,
  SensitivityConfig,
  SensitivityPreset,
  Severity,
  StateBackend,
  StateSnapshot,
  TelemetryEvent,
  TelemetryEventKind,
  TelemetryListener,
  ToolCallRecord,
  TrendForecast,
  TurnObservation,
  WarmupConfig,
} from '../types.js';

export const VERSION = '1.0.0';
