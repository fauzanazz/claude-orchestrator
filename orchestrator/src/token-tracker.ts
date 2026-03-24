export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export interface CostEstimate extends TokenUsage {
  cost_usd: number;
  model: string | null;
}

// Pricing per 1M tokens. Update as needed.
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheCreation: number }> = {
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0, cacheRead: 0.30, cacheCreation: 3.75 },
  'claude-opus-4-20250514': { input: 15.0, output: 75.0, cacheRead: 1.50, cacheCreation: 18.75 },
  'claude-haiku-3-5-20241022': { input: 0.80, output: 4.0, cacheRead: 0.08, cacheCreation: 1.0 },
};

const DEFAULT_PRICING = { input: 3.0, output: 15.0, cacheRead: 0.30, cacheCreation: 3.75 };

export class TokenTracker {
  private totals: TokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };
  private model: string | null = null;

  /**
   * Parse a stream-json line and accumulate token usage if it's a result event.
   * Returns the parsed usage if found, null otherwise.
   */
  parseAndAccumulate(line: string): TokenUsage | null {
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(line);
    } catch {
      return null;
    }

    if (evt.type !== 'result') return null;

    const usage = evt.usage as Record<string, number> | undefined;
    if (!usage) return null;

    const sessionUsage: TokenUsage = {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
    };

    this.totals.input_tokens += sessionUsage.input_tokens;
    this.totals.output_tokens += sessionUsage.output_tokens;
    this.totals.cache_read_tokens += sessionUsage.cache_read_tokens;
    this.totals.cache_creation_tokens += sessionUsage.cache_creation_tokens;

    if (evt.model && typeof evt.model === 'string') {
      this.model = evt.model;
    }

    return sessionUsage;
  }

  setModel(model: string | null): void {
    if (model) this.model = model;
  }

  getTotals(): TokenUsage {
    return { ...this.totals };
  }

  getModel(): string | null {
    return this.model;
  }

  estimateCost(): CostEstimate {
    const pricing = (this.model ? MODEL_PRICING[this.model] : null) ?? DEFAULT_PRICING;
    const cost =
      (this.totals.input_tokens / 1_000_000) * pricing.input +
      (this.totals.output_tokens / 1_000_000) * pricing.output +
      (this.totals.cache_read_tokens / 1_000_000) * pricing.cacheRead +
      (this.totals.cache_creation_tokens / 1_000_000) * pricing.cacheCreation;

    return {
      ...this.totals,
      cost_usd: Math.round(cost * 10000) / 10000,
      model: this.model,
    };
  }
}
