// The model providers of the live benchmark, behind one conversation shape:
// start a conversation with instructions, tools and the user's request; each
// `next(results)` sends the previous turn's tool results and returns the
// model's tool calls or final text, with the provider's own usage record.
//
//   openai  OpenAI's Responses API; usage as the provider records it
//   claude  Anthropic's Messages API through its SDK (@anthropic-ai/sdk); usage as the provider
//           records it, cache reads and writes apart
//   mock    a scripted model that calls the tools it is given and answers
//           with what they return. It spends nothing and its token counts
//           are estimates: it checks the harness end to end, not a model.

import { estimateTokens } from '../../src/agent/metrics.js';

// Standard-tier prices per million tokens, from developers.openai.com/api/docs/pricing on 2026-10-27.
// A model without a price here is refused, so a run can never spend at an unknown rate.
export const PRICES = {
  'gpt-5.5': { input: 5, cached: 0.5, output: 30 },
  'gpt-5.4': { input: 2.5, cached: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cached: 0.02, output: 1.25 },
  'gpt-5.3-codex': { input: 1.75, cached: 0.175, output: 14 },
  'gpt-5.2': { input: 1.75, cached: 0.175, output: 14 },
  'gpt-5.1': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2 },
  // From the Claude API reference on 2026-10-30. Cache reads are `cached`; cache writes (`written`, at the
  // 5-minute TTL) cost 1.25× input. Haiku 5.5 costs more for prompts over 100K tokens.
  'claude-fable-5-1': { input: 10, cached: 0.25, written: 12.5, output: 50 },
  'claude-opus-5-5': { input: 4, cached: 0.2, written: 5, output: 20 },
  'claude-sonnet-5-5': { input: 2, cached: 0.2, written: 2.5, output: 10 },
  'claude-haiku-5-5': { input: 0.1, cached: 0.01, written: 0.125, output: 0.5,
    above: { tokens: 100_000, input: 0.5, cached: 0.05, written: 0.625, output: 2.5 } },
  mock: { input: 0, cached: 0, output: 0 },
};
// What one Claude reply may write, thinking included: enough that an answer is not cut short.
export const CLAUDE_MAX_TOKENS = 16_000;
// Effort levels the Claude API takes; OpenAI's "minimal" is its lowest.
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const asFunction = ({ name, description, input_schema: parameters }) => ({ type: 'function', name, description, parameters, strict: false });

async function create(key, body) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const value = await response.json().catch(() => ({ error: { message: `HTTP ${response.status}` } }));
    if (response.ok) return value;
    if ([429, 500, 502, 503].includes(response.status) && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
      continue;
    }
    throw new Error(`OpenAI ${response.status}: ${value.error?.message ?? 'request failed'}`);
  }
}

const messageText = (response) => response.output.filter((item) => item.type === 'message')
  .flatMap((item) => item.content ?? []).filter((part) => part.type === 'output_text').map((part) => part.text).join('');

function openai(model, { key, effort, maxOutput }) {
  if (!key) throw new Error('Set OPENAI_API_KEY or pass --key-file for OpenAI models.');
  return {
    model, estimated: false, maxOutput,
    start({ instructions, tools, prompt }) {
      let previous = null;
      return {
        async next(results = []) {
          const input = previous ? results.map((result) => ({ type: 'function_call_output', call_id: result.id, output: result.output }))
            : [{ role: 'user', content: prompt }];
          const response = await create(key, { model, instructions, input, ...(tools.length ? { tools: tools.map(asFunction), parallel_tool_calls: true } : {}),
            reasoning: { effort }, max_output_tokens: maxOutput, ...(previous ? { previous_response_id: previous } : {}) });
          previous = response.id;
          const usage = response.usage;
          return {
            usage: { input: usage.input_tokens, cached: usage.input_tokens_details?.cached_tokens ?? 0, output: usage.output_tokens,
              reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0 },
            calls: response.output.filter((item) => item.type === 'function_call').map((call) => ({ id: call.call_id, name: call.name, arguments: call.arguments ?? '' })),
            text: messageText(response), incomplete: response.status === 'incomplete',
          };
        },
      };
    },
  };
}

/**
 * A Claude model through the Messages API, as a host runs it: adaptive
 * thinking at the run's effort, automatic prompt caching (cache reads and
 * writes are recorded apart, as they are priced apart), and each reply sent
 * back whole, thinking blocks included, since the API checks them against the
 * conversation. Server-side refusal fallbacks are not enabled: a fallback
 * would answer with another model under this one's name. A refusal ends the
 * task and is recorded as one.
 */
async function claude(model, { key, effort, fetch }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  // Without a key the SDK finds the person's own credentials (ANTHROPIC_API_KEY, an `ant auth login` profile).
  const client = new Anthropic({ ...(key ? { apiKey: key } : {}), maxRetries: 4, ...(fetch ? { fetch } : {}) });
  return {
    model, estimated: false, maxOutput: CLAUDE_MAX_TOKENS,
    start({ instructions, tools, prompt }) {
      const messages = [{ role: 'user', content: prompt }];
      return {
        async next(results = []) {
          // Every tool result of a turn goes back in one message.
          if (results.length) {
            messages.push({ role: 'user', content: results.map((result) => ({ type: 'tool_result', tool_use_id: result.id, content: result.output,
              ...(result.error ? { is_error: true } : {}) })) });
          }
          const response = await client.messages.create({ model, max_tokens: CLAUDE_MAX_TOKENS, system: instructions, messages,
            ...(tools.length ? { tools: tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })) } : {}),
            thinking: { type: 'adaptive' }, output_config: { effort: CLAUDE_EFFORTS.has(effort) ? effort : 'low' }, cache_control: { type: 'ephemeral' } });
          messages.push({ role: 'assistant', content: response.content });
          const usage = response.usage;
          const cached = usage.cache_read_input_tokens ?? 0;
          const written = usage.cache_creation_input_tokens ?? 0;
          return {
            // input counts the whole prompt, as OpenAI's does: tokens read at full price, read from cache and written to it.
            usage: { input: usage.input_tokens + cached + written, cached, written, output: usage.output_tokens,
              reasoning: usage.output_tokens_details?.thinking_tokens ?? 0 },
            calls: response.stop_reason === 'tool_use'
              ? response.content.filter((block) => block.type === 'tool_use').map((block) => ({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) }))
              : [],
            text: response.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
            incomplete: ['max_tokens', 'model_context_window_exceeded'].includes(response.stop_reason), refused: response.stop_reason === 'refusal',
          };
        },
      };
    },
  };
}

/**
 * A model that calls the tools it is given, as a plain first attempt would:
 * lasso with the request; or Glob, then Read of the files whose names share
 * the request's words; or, with no tools, the attached text. It answers with
 * what came back. Its usage is estimated from everything sent and written.
 */
function mock(model) {
  return {
    model, estimated: true, maxOutput: 0,
    start({ instructions, tools, prompt }) {
      const names = new Set(tools.map((tool) => tool.name));
      let sent = estimateTokens(`${instructions}\n${JSON.stringify(tools)}\n${prompt}`);
      let turn = 0;
      let files = [];
      const seen = [];
      const words = new Set(String(prompt).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
      const reply = (calls, text = '') => {
        const output = estimateTokens(`${text}${calls.map((call) => call.arguments).join('')}`);
        const usage = { input: sent, cached: 0, output, reasoning: 0 };
        sent += output;
        turn += 1;
        return { usage, calls, text, incomplete: false };
      };
      const answer = () => reply([], `${seen.join('\n').slice(0, 6000)}\nANSWER: ${seen.join(' ').replace(/\s+/g, ' ').slice(0, 1500)}`);
      return {
        async next(results = []) {
          for (const result of results) { seen.push(result.output); sent += estimateTokens(result.output); }
          if (names.has('lasso')) return turn === 0 ? reply([{ id: 'm1', name: 'lasso', arguments: JSON.stringify({ ask: [prompt] }) }]) : answer();
          if (names.has('Glob') && names.has('Read')) {
            if (turn === 0) return reply([{ id: 'm1', name: 'Glob', arguments: JSON.stringify({ pattern: '**/*' }) }]);
            if (turn === 1) {
              const listed = String(results[0]?.output ?? '').split('\n').filter(Boolean);
              const score = (file) => (file.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((word) => words.has(word)).length;
              files = listed.map((file) => [file, score(file)]).sort((left, right) => right[1] - left[1]).slice(0, 2).map(([file]) => file);
              if (files.length) return reply(files.map((file, index) => ({ id: `m${index + 2}`, name: 'Read', arguments: JSON.stringify({ file_path: file }) })));
            }
            return answer();
          }
          seen.push(prompt);
          return answer();
        },
      };
    },
  };
}

/**
 * The provider for a model: Claude's for claude-*, the scripted mock for
 * "mock", OpenAI's otherwise. `options`: { openaiKey, anthropicKey, effort,
 * maxOutput, fetch } (fetch replaces the network, for tests).
 */
export async function providerFor(model, options = {}) {
  if (!PRICES[model]) throw new Error(`No price recorded for ${model}; add it to PRICES first.`);
  if (model === 'mock') return mock(model);
  if (model.startsWith('claude-')) return claude(model, { key: options.anthropicKey, effort: options.effort, fetch: options.fetch });
  return openai(model, { key: options.openaiKey, effort: options.effort, maxOutput: options.maxOutput });
}

/** A model's prices for a call of this size: Haiku 5.5 costs more once a prompt passes 100K tokens. */
const pricesFor = (model, input) => {
  const price = PRICES[model];
  return price.above && input > price.above.tokens ? price.above : price;
};

/** A call's cost in dollars, from the provider's usage record: input read at full price, from cache and written to it, and output. */
export function costOf(model, usage) {
  const price = pricesFor(model, usage.input);
  const written = usage.written ?? 0;
  return ((usage.input - usage.cached - written) * price.input + usage.cached * price.cached + written * (price.written ?? price.input)
    + usage.output * price.output) / 1e6;
}

/** What a call could cost at most: its expected input with room to grow, all of it written to cache, and the most output it may write. */
export function worstCost(model, expectedInput, maxOutput) {
  const price = pricesFor(model, expectedInput + 40_000);
  return ((expectedInput + 40_000) * Math.max(price.input, price.written ?? 0) + maxOutput * price.output) / 1e6;
}
