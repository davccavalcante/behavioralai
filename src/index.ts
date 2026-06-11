/**
 * @takk/behavioralai - Behavioral AI: behavioral observability for
 * Massive Intelligence (IM) agents and non-human entities (NHE).
 *
 * Learns a per-agent behavioral fingerprint in production, detects drift in
 * real time before any visible failure, attributes the cause, and forecasts
 * the trend. Channel integrations live under `@takk/behavioralai/channels`
 * (fetch-based, universal) and `@takk/behavioralai/smtp` (Node only);
 * OpenTelemetry ingestion under `@takk/behavioralai/otel`; sibling-package
 * adapters under `@takk/behavioralai/integrations`.
 *
 * @module
 */

export { createBehavioralAI } from './core/createBehavioralAI.js';
export { resolveSensitivity, SENSITIVITY_PRESETS } from './drift/sensitivity.js';
export { BehavioralaiError, ClosedError, ConfigurationError, StateError } from './errors.js';
export { computeBehaviorScore } from './fingerprint/Fingerprint.js';
export { type FileStateOptions, fileState } from './state/file.js';
export { memoryState } from './state/memory.js';

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
} from './types.js';

export const VERSION = '1.0.0';
