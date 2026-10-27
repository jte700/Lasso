// Measurements of the agent path. Everything here is local: what Lasso spent
// and what it sent. What a model then spent (input tokens across turns,
// reasoning, caching) is only known from the provider's usage records, which
// the benchmark harness reads separately. The token figures below are
// estimates of a response's size, used to compare responses with each other.

import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

/**
 * A tokenizer-free estimate of how many tokens a text costs a model. Words
 * cost about one token per four letters, numbers one per three digits, and
 * each punctuation mark or symbol about one. Calibrated loosely against BPE
 * tokenizers on JSON and source code; good for ratios, not for billing.
 */
export function estimateTokens(text) {
  const value = String(text ?? '');
  let tokens = 0;
  for (const match of value.matchAll(/(\p{L}+)|(\p{N}+)|(\s+)|([^\p{L}\p{N}\s])/gu)) {
    if (match[1]) tokens += Math.ceil(match[1].length / 4);
    else if (match[2]) tokens += Math.ceil(match[2].length / 3);
    else if (match[3]) tokens += match[3].includes('\n') ? match[3].split('\n').length - 1 : 0;
    else tokens += 1;
  }
  return tokens;
}

export class AgentMetrics {
  constructor({ logPath = process.env.LASSO_AGENT_METRICS ?? null } = {}) {
    this.logPath = logPath;
    this.startedAt = Date.now();
    this.calls = 0;
    this.errors = 0;
    this.byOperation = new Map();
    this.events = {};
  }

  /** Counts something that is not a call: an engine opening, a cache hit. */
  note(name, value = 1) {
    this.events[name] = (this.events[name] ?? 0) + value;
  }

  /** Runs `work`, recording its time, its response's size and whether it failed. */
  measure(operation, transport, work) {
    const started = performance.now();
    let response;
    let failed = false;
    try {
      response = work();
      return response;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const ms = performance.now() - started;
      const text = response === undefined ? '' : JSON.stringify(response);
      const entry = this.byOperation.get(operation) ?? { calls: 0, errors: 0, ms: 0, bytes: 0, tokens: 0 };
      const tokens = estimateTokens(text);
      entry.calls += 1;
      entry.errors += failed ? 1 : 0;
      entry.ms += ms;
      entry.bytes += Buffer.byteLength(text);
      entry.tokens += tokens;
      this.byOperation.set(operation, entry);
      this.calls += 1;
      this.errors += failed ? 1 : 0;
      if (this.logPath) {
        try {
          fs.appendFileSync(this.logPath, `${JSON.stringify({ at: new Date().toISOString(), operation, transport,
            ms: Math.round(ms * 10) / 10, bytes: Buffer.byteLength(text), estimatedTokens: tokens, failed })}\n`);
        } catch { /* measurement never fails a request */ }
      }
    }
  }

  snapshot() {
    const memory = process.memoryUsage();
    return {
      uptimeMs: Date.now() - this.startedAt,
      calls: this.calls,
      errors: this.errors,
      operations: Object.fromEntries([...this.byOperation].map(([name, entry]) => [name, {
        ...entry, ms: Math.round(entry.ms), meanMs: Math.round(entry.ms / Math.max(1, entry.calls) * 10) / 10,
      }])),
      events: { ...this.events },
      memory: { rssMb: Math.round(memory.rss / 1e6), heapUsedMb: Math.round(memory.heapUsed / 1e6) },
    };
  }
}
