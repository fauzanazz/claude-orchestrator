import { describe, test, expect } from 'bun:test';
import { TokenTracker } from './token-tracker.ts';

describe('TokenTracker', () => {
  test('parses result event with usage data', () => {
    const tracker = new TokenTracker();
    const line = JSON.stringify({
      type: 'result',
      result: 'done',
      usage: { input_tokens: 5000, output_tokens: 2000, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
    });
    const usage = tracker.parseAndAccumulate(line);
    expect(usage).not.toBeNull();
    expect(usage!.input_tokens).toBe(5000);
    expect(usage!.output_tokens).toBe(2000);
    expect(usage!.cache_read_tokens).toBe(100);
    expect(usage!.cache_creation_tokens).toBe(50);
  });

  test('accumulates across multiple sessions', () => {
    const tracker = new TokenTracker();
    tracker.parseAndAccumulate(JSON.stringify({
      type: 'result',
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
    }));
    tracker.parseAndAccumulate(JSON.stringify({
      type: 'result',
      usage: { input_tokens: 2000, output_tokens: 1000, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 },
    }));
    const totals = tracker.getTotals();
    expect(totals.input_tokens).toBe(3000);
    expect(totals.output_tokens).toBe(1500);
    expect(totals.cache_read_tokens).toBe(30);
    expect(totals.cache_creation_tokens).toBe(15);
  });

  test('ignores non-result events', () => {
    const tracker = new TokenTracker();
    const result = tracker.parseAndAccumulate(JSON.stringify({ type: 'assistant', message: {} }));
    expect(result).toBeNull();
    expect(tracker.getTotals().input_tokens).toBe(0);
  });

  test('estimates cost correctly for sonnet', () => {
    const tracker = new TokenTracker();
    tracker.setModel('claude-sonnet-4-20250514');
    tracker.parseAndAccumulate(JSON.stringify({
      type: 'result',
      usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
    }));
    const estimate = tracker.estimateCost();
    // $3 input + $1.50 output = $4.50
    expect(estimate.cost_usd).toBe(4.5);
    expect(estimate.model).toBe('claude-sonnet-4-20250514');
  });

  test('estimates cost correctly for opus', () => {
    const tracker = new TokenTracker();
    tracker.setModel('claude-opus-4-20250514');
    tracker.parseAndAccumulate(JSON.stringify({
      type: 'result',
      usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
    }));
    const estimate = tracker.estimateCost();
    // $15 input + $7.50 output = $22.50
    expect(estimate.cost_usd).toBe(22.5);
  });

  test('uses default pricing for unknown models', () => {
    const tracker = new TokenTracker();
    tracker.setModel('claude-unknown-model');
    tracker.parseAndAccumulate(JSON.stringify({
      type: 'result',
      usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
    }));
    const estimate = tracker.estimateCost();
    // Default (Sonnet-level): $3 input + $1.50 output = $4.50
    expect(estimate.cost_usd).toBe(4.5);
  });

  test('handles missing usage gracefully', () => {
    const tracker = new TokenTracker();
    const result = tracker.parseAndAccumulate(JSON.stringify({ type: 'result', result: 'ok' }));
    expect(result).toBeNull();
  });

  test('handles invalid JSON gracefully', () => {
    const tracker = new TokenTracker();
    const result = tracker.parseAndAccumulate('not json');
    expect(result).toBeNull();
  });

  test('captures model from result event', () => {
    const tracker = new TokenTracker();
    tracker.parseAndAccumulate(JSON.stringify({
      type: 'result',
      model: 'claude-opus-4-20250514',
      usage: { input_tokens: 100, output_tokens: 50 },
    }));
    expect(tracker.getModel()).toBe('claude-opus-4-20250514');
  });

  test('setModel does not overwrite with null', () => {
    const tracker = new TokenTracker();
    tracker.setModel('claude-sonnet-4-20250514');
    tracker.setModel(null);
    expect(tracker.getModel()).toBe('claude-sonnet-4-20250514');
  });

  test('includes cache tokens in cost estimate', () => {
    const tracker = new TokenTracker();
    tracker.setModel('claude-sonnet-4-20250514');
    tracker.parseAndAccumulate(JSON.stringify({
      type: 'result',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
      },
    }));
    const estimate = tracker.estimateCost();
    // $0.30 cache read + $3.75 cache creation = $4.05
    expect(estimate.cost_usd).toBe(4.05);
  });

  test('handles missing token fields with defaults', () => {
    const tracker = new TokenTracker();
    tracker.parseAndAccumulate(JSON.stringify({
      type: 'result',
      usage: { input_tokens: 500 },
    }));
    const totals = tracker.getTotals();
    expect(totals.input_tokens).toBe(500);
    expect(totals.output_tokens).toBe(0);
    expect(totals.cache_read_tokens).toBe(0);
    expect(totals.cache_creation_tokens).toBe(0);
  });
});
