import { describe, expect, it, vi } from 'vitest';
import { observeSpan, turnFromSpan } from '../../src/otel/index.js';
import type { TurnObservation } from '../../src/types.js';

function requireTurn(turn: TurnObservation | undefined): TurnObservation {
  if (turn === undefined) {
    throw new Error('expected the span to map to a turn');
  }
  return turn;
}

describe('turnFromSpan', () => {
  it('maps a chat span with GenAI semconv attributes and UnixNano timestamps', () => {
    const turn = requireTurn(
      turnFromSpan({
        name: 'chat claude',
        attributes: {
          'gen_ai.agent.id': 'support-agent',
          'gen_ai.usage.input_tokens': '1200',
          'gen_ai.usage.output_tokens': 300,
          'gen_ai.usage.cost': 0.0021,
          'gen_ai.response.finish_reasons': ['stop'],
        },
        startTimeUnixNano: '1750000000000000000',
        endTimeUnixNano: '1750000000850000000',
      }),
    );
    expect(turn.agentId).toBe('support-agent');
    expect(turn.inputTokens).toBe(1200);
    expect(turn.outputTokens).toBe(300);
    expect(turn.costUsd).toBe(0.0021);
    expect(turn.finishReason).toBe('stop');
    // UnixNano values of this magnitude lose sub-millisecond precision in a
    // double, so the mapper yields 849.99975... rather than exactly 850.
    expect(turn.latencyMs).toBeCloseTo(850, 3);
    expect(turn.timestamp).toBeCloseTo(1_750_000_000_850, 3);
    expect(turn.error).toBeUndefined();
  });

  it('parses legacy prompt/completion token attribute names', () => {
    const turn = requireTurn(
      turnFromSpan({
        attributes: {
          'gen_ai.agent.id': 'support-agent',
          'gen_ai.usage.prompt_tokens': '64',
          'gen_ai.usage.completion_tokens': 16,
        },
      }),
    );
    expect(turn.inputTokens).toBe(64);
    expect(turn.outputTokens).toBe(16);
  });

  describe('agent id resolution', () => {
    it('lets an explicit options.agentId win over span attributes', () => {
      const turn = requireTurn(
        turnFromSpan(
          { attributes: { 'gen_ai.agent.id': 'attribute-agent' } },
          { agentId: 'explicit-agent' },
        ),
      );
      expect(turn.agentId).toBe('explicit-agent');
    });

    it('respects a custom agentIdAttributes probe list', () => {
      const span = {
        attributes: {
          'gen_ai.agent.id': 'default-agent',
          'custom.agent': 'custom-agent',
        },
      };
      const turn = requireTurn(turnFromSpan(span, { agentIdAttributes: ['custom.agent'] }));
      expect(turn.agentId).toBe('custom-agent');
      // The custom list replaces the defaults entirely.
      const miss = turnFromSpan(
        { attributes: { 'gen_ai.agent.id': 'default-agent' } },
        { agentIdAttributes: ['custom.agent'] },
      );
      expect(miss).toBeUndefined();
    });

    it('falls back through gen_ai.agent.name then service.name', () => {
      const byName = requireTurn(
        turnFromSpan({
          attributes: { 'gen_ai.agent.name': 'named-agent', 'service.name': 'svc' },
        }),
      );
      expect(byName.agentId).toBe('named-agent');
      const byService = requireTurn(turnFromSpan({ attributes: { 'service.name': 'svc' } }));
      expect(byService.agentId).toBe('svc');
    });

    it('returns undefined when no agent id resolves', () => {
      expect(turnFromSpan({ attributes: { 'http.method': 'GET' } })).toBeUndefined();
      expect(turnFromSpan({})).toBeUndefined();
    });
  });

  describe('tool spans', () => {
    it('maps an execute_tool span to a tool fingerprint with an error tool call', () => {
      const turn = requireTurn(
        turnFromSpan({
          name: 'execute_tool web_search',
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': 'web_search',
          },
          status: { code: 2 },
          durationMs: 120,
        }),
      );
      expect(turn.agentId).toBe('tool:web_search');
      expect(turn.toolCalls).toEqual([{ name: 'web_search', ok: false, latencyMs: 120 }]);
      expect(turn.error).toBe(true);
      expect(turn.latencyMs).toBe(120);
    });

    it('falls back to the span name when gen_ai.tool.name is missing', () => {
      const turn = requireTurn(
        turnFromSpan({
          name: 'lookup_order',
          attributes: { 'gen_ai.operation.name': 'execute_tool' },
        }),
      );
      expect(turn.agentId).toBe('tool:lookup_order');
      expect(turn.toolCalls).toEqual([{ name: 'lookup_order', ok: true }]);
    });

    it('returns undefined for a tool span with neither tool name nor span name', () => {
      expect(
        turnFromSpan({ attributes: { 'gen_ai.operation.name': 'execute_tool' } }),
      ).toBeUndefined();
    });

    it('treats gen_ai.tool.name without usage tokens as a tool span', () => {
      const turn = requireTurn(turnFromSpan({ attributes: { 'gen_ai.tool.name': 'calculator' } }));
      expect(turn.agentId).toBe('tool:calculator');
      expect(turn.toolCalls).toEqual([{ name: 'calculator', ok: true }]);
    });

    it('does not treat gen_ai.tool.name with usage tokens as a tool span', () => {
      const turn = requireTurn(
        turnFromSpan({
          attributes: {
            'gen_ai.agent.id': 'support-agent',
            'gen_ai.tool.name': 'calculator',
            'gen_ai.usage.input_tokens': 10,
            'gen_ai.usage.output_tokens': 5,
          },
        }),
      );
      expect(turn.agentId).toBe('support-agent');
      expect(turn.toolCalls).toBeUndefined();
    });

    it('honors a custom toolProfilePrefix and an explicit agentId override', () => {
      const prefixed = requireTurn(
        turnFromSpan(
          { attributes: { 'gen_ai.operation.name': 'tool', 'gen_ai.tool.name': 'web_search' } },
          { toolProfilePrefix: 'unit/' },
        ),
      );
      expect(prefixed.agentId).toBe('unit/web_search');
      const overridden = requireTurn(
        turnFromSpan(
          { attributes: { 'gen_ai.operation.name': 'tool', 'gen_ai.tool.name': 'web_search' } },
          { agentId: 'pinned' },
        ),
      );
      expect(overridden.agentId).toBe('pinned');
    });
  });

  describe('timestamps and duration', () => {
    it('derives latency from hrtime tuples without emitting a timestamp', () => {
      const turn = requireTurn(
        turnFromSpan({
          attributes: { 'gen_ai.agent.id': 'support-agent' },
          startTime: [1_750_000_000, 0] as const,
          endTime: [1_750_000_000, 850_000_000] as const,
        }),
      );
      expect(turn.latencyMs).toBe(850);
      expect('timestamp' in turn).toBe(false);
      expect(Object.keys(turn)).not.toContain('timestamp');
    });

    it('treats plain-number times as epoch milliseconds and emits a timestamp', () => {
      const turn = requireTurn(
        turnFromSpan({
          attributes: { 'gen_ai.agent.id': 'support-agent' },
          startTime: 1_750_000_000_000,
          endTime: 1_750_000_000_850,
        }),
      );
      expect(turn.latencyMs).toBe(850);
      expect(turn.timestamp).toBe(1_750_000_000_850);
    });

    it('lets durationMs win over timestamp-derived latency', () => {
      const turn = requireTurn(
        turnFromSpan({
          attributes: { 'gen_ai.agent.id': 'support-agent' },
          startTime: 1_750_000_000_000,
          endTime: 1_750_000_000_850,
          durationMs: 42,
        }),
      );
      expect(turn.latencyMs).toBe(42);
      expect(turn.timestamp).toBe(1_750_000_000_850);
    });
  });

  describe('error status', () => {
    it('marks string status ERROR and STATUS_CODE_ERROR as errors', () => {
      const byError = requireTurn(
        turnFromSpan({
          attributes: { 'gen_ai.agent.id': 'support-agent' },
          status: { code: 'ERROR' },
        }),
      );
      expect(byError.error).toBe(true);
      const byOtlp = requireTurn(
        turnFromSpan({
          attributes: { 'gen_ai.agent.id': 'support-agent' },
          status: { code: 'STATUS_CODE_ERROR' },
        }),
      );
      expect(byOtlp.error).toBe(true);
    });

    it('does not mark status codes 0 and 1 as errors', () => {
      const unset = requireTurn(
        turnFromSpan({
          attributes: { 'gen_ai.agent.id': 'support-agent' },
          status: { code: 0 },
        }),
      );
      expect(unset.error).toBeUndefined();
      expect(Object.keys(unset)).not.toContain('error');
      const ok = requireTurn(
        turnFromSpan({
          attributes: { 'gen_ai.agent.id': 'support-agent' },
          status: { code: 1 },
        }),
      );
      expect(ok.error).toBeUndefined();
    });
  });

  it('omits optional keys entirely on a minimal span', () => {
    const turn = requireTurn(turnFromSpan({ attributes: { 'gen_ai.agent.id': 'support-agent' } }));
    expect(turn.agentId).toBe('support-agent');
    const keys = Object.keys(turn);
    expect(keys).not.toContain('latencyMs');
    expect(keys).not.toContain('costUsd');
    expect(keys).not.toContain('finishReason');
    expect(keys).not.toContain('timestamp');
    expect(keys).not.toContain('inputTokens');
    expect(keys).not.toContain('outputTokens');
    expect(keys).not.toContain('error');
    expect(keys).toEqual(['agentId']);
  });
});

describe('observeSpan', () => {
  it('returns true and feeds the mapped turn to the engine exactly once', () => {
    const observed: TurnObservation[] = [];
    const observe = vi.fn((turn: TurnObservation): unknown => {
      observed.push(turn);
      return undefined;
    });
    const result = observeSpan(
      { observe },
      {
        attributes: { 'gen_ai.agent.id': 'support-agent', 'gen_ai.usage.output_tokens': 300 },
        durationMs: 120,
      },
    );
    expect(result).toBe(true);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([{ agentId: 'support-agent', latencyMs: 120, outputTokens: 300 }]);
  });

  it('returns false and never calls observe for an unmappable span', () => {
    const observe = vi.fn((_turn: TurnObservation): unknown => undefined);
    const result = observeSpan({ observe }, { attributes: { 'http.method': 'GET' } });
    expect(result).toBe(false);
    expect(observe).not.toHaveBeenCalled();
  });
});
