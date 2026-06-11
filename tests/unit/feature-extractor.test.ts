import { describe, expect, it } from 'vitest';
import { extractFeatures } from '../../src/fingerprint/FeatureExtractor.js';

describe('extractFeatures', () => {
  it('maps a fully populated turn to every numeric dimension', () => {
    const features = extractFeatures({
      agentId: 'support-agent',
      latencyMs: 850,
      costUsd: 0.0021,
      inputTokens: 1200,
      outputTokens: 300,
      contextTokens: 6000,
      retrievalChunks: 4,
      turnIndex: 2,
      toolCalls: [
        { name: 'web_search', ok: true, latencyMs: 120 },
        { name: 'db_query', ok: false },
      ],
      finishReason: 'stop',
    });

    expect(features.numeric.get('latencyMs')).toBe(850);
    expect(features.numeric.get('costUsd')).toBe(0.0021);
    expect(features.numeric.get('inputTokens')).toBe(1200);
    expect(features.numeric.get('outputTokens')).toBe(300);
    expect(features.numeric.get('totalTokens')).toBe(1500);
    expect(features.numeric.get('contextTokens')).toBe(6000);
    expect(features.numeric.get('contextSnr')).toBeCloseTo(300 / 6000, 10);
    expect(features.numeric.get('retrievalChunks')).toBe(4);
    expect(features.numeric.get('turnIndex')).toBe(2);
    expect(features.numeric.get('toolCallCount')).toBe(2);
    expect(features.numeric.get('toolFailureRate')).toBe(0.5);
    expect(features.numeric.get('errorRate')).toBe(0);
    expect(features.toolSelection).toEqual(['web_search', 'db_query']);
    expect(features.finishReason).toBe('stop');
  });

  it('extracts only errorRate from a minimal turn', () => {
    const features = extractFeatures({ agentId: 'a' });
    expect(features.numeric.size).toBe(1);
    expect(features.numeric.get('errorRate')).toBe(0);
    expect(features.toolSelection).toEqual([]);
    expect(features.finishReason).toBeUndefined();
  });

  it('marks errors from boolean and string forms', () => {
    expect(extractFeatures({ agentId: 'a', error: true }).numeric.get('errorRate')).toBe(1);
    expect(extractFeatures({ agentId: 'a', error: 'timeout' }).numeric.get('errorRate')).toBe(1);
    expect(extractFeatures({ agentId: 'a', error: false }).numeric.get('errorRate')).toBe(0);
  });

  it('does not derive contextSnr without outputTokens or with zero context', () => {
    const noOutput = extractFeatures({ agentId: 'a', contextTokens: 1000 });
    expect(noOutput.numeric.has('contextSnr')).toBe(false);
    const zeroContext = extractFeatures({ agentId: 'a', contextTokens: 0, outputTokens: 10 });
    expect(zeroContext.numeric.has('contextSnr')).toBe(false);
  });

  it('records toolCallCount zero and no failure rate for an empty tools array', () => {
    const features = extractFeatures({ agentId: 'a', toolCalls: [] });
    expect(features.numeric.get('toolCallCount')).toBe(0);
    expect(features.numeric.has('toolFailureRate')).toBe(false);
  });

  it('ignores non-finite numbers', () => {
    const features = extractFeatures({ agentId: 'a', latencyMs: Number.NaN });
    expect(features.numeric.has('latencyMs')).toBe(false);
  });
});
