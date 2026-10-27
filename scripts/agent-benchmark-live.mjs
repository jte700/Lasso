// Live agent benchmark: a real model does the benchmark's tasks through
// OpenAI's Responses API on the same generated library, in three arms:
//   direct       ordinary file tools (Read, Grep, Glob)
//   lasso        those tools plus Lasso's; the model chooses (adaptive routing)
//   lasso-first  the same, told to prefer Lasso and fall back to the file tools
// Token counts are the provider's own usage records for every model call.
//
//   OPENAI_API_KEY=… node scripts/agent-benchmark-live.mjs --model gpt-5.4-mini [--model …]
//     [--runs 1] [--effort low] [--budget 4] [--tasks id,id] [--out docs/agent]
//
// The model chooses its own steps; nothing is scripted. Answers are graded
// against the generator's truth. A guard stops before a call could take the
// run's spend past --budget dollars, and results are written after each task.

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { openLocal } from '../src/agent/client.js';
import { INSTRUCTIONS as LASSO_INSTRUCTIONS, TOOLS as LASSO_TOOLS } from '../src/agent/mcp.js';
import { blockRange, definitions } from '../src/agent/evidence.js';
import { estimateTokens } from '../src/agent/metrics.js';
import { DIRECT_DEFINITIONS, directTools, prepareLibrary, REPEATED_RANGES, taskPrompts } from './agent-benchmark-corpus.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const MODELS = args.flatMap((value, index) => (args[index - 1] === '--model' ? [value] : []));
const RUNS = Number(option('--runs', 1));
const EFFORT = option('--effort', 'low');
const BUDGET = Number(option('--budget', 4));
const ONLY = option('--tasks', null)?.split(',');
const LABEL = option('--label', null);
// Regrade a saved results file with the current graders, calling no model.
const REGRADE = option('--regrade', null);
const OUT = path.resolve(ROOT, option('--out', 'docs/agent'));
const KEY = process.env.OPENAI_API_KEY ?? (option('--key-file', null) && fs.readFileSync(option('--key-file'), 'utf8').trim());

// Standard-tier prices per million tokens, from developers.openai.com/api/docs/pricing on 2026-10-27.
// A model without a price here is refused, so a run can never spend at an unknown rate.
const PRICES = {
  'gpt-5.5': { input: 5, cached: 0.5, output: 30 },
  'gpt-5.4': { input: 2.5, cached: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cached: 0.02, output: 1.25 },
  'gpt-5.3-codex': { input: 1.75, cached: 0.175, output: 14 },
  'gpt-5.2': { input: 1.75, cached: 0.175, output: 14 },
  'gpt-5.1': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2 },
};
const MAX_TURNS = 14;
const MAX_OUTPUT_TOKENS = 6000;
// A coding agent's harness also caps what one tool result can put in context.
const MAX_TOOL_CHARS = 60_000;

const INSTRUCTIONS = [
  'You are an agent answering questions about the files in a workspace. Its top-level folders are Shop, Admin and Finance; tool paths are relative to the workspace root.',
  'Use the tools to find and read what you need. Quote values and code exactly as the files have them; when asked for lines, reproduce them exactly, without line numbers.',
  'If several sources could be meant and the request does not say which, list them and ask which one is meant instead of choosing. If what was asked for does not exist, say so.',
  'End your reply with a line that starts with "ANSWER:" followed by the answer.',
].join(' ');

// What a person who set Lasso up for their agent might add to its instructions.
const PREFER_LASSO = 'Prefer the lasso_ tools for finding and reading evidence; use the file tools only when Lasso cannot answer.';
const ARMS = ['direct', 'lasso', 'lasso-first'];

const asFunction = ({ name, description, input_schema: parameters }) => ({ type: 'function', name, description, parameters, strict: false });
const DIRECT_FUNCTIONS = DIRECT_DEFINITIONS.map(asFunction);
const LASSO_FUNCTIONS = LASSO_TOOLS.map(({ name, description, inputSchema }) => asFunction({ name, description, input_schema: inputSchema }));

// ── grading ────────────────────────────────────────────────────────────────

function graders(library) {
  const { truth, files, routesNow } = library;
  const lines = (relative) => files[relative].replace(/\n$/, '').split('\n');
  const block = (name) => {
    for (const contents of Object.values(files)) {
      const all = contents.replace(/\n$/, '').split('\n');
      const found = definitions(all).find((definition) => definition.name === name);
      if (found) { const range = blockRange(all, found); return all.slice(range.start - 1, range.end).join('\n'); }
    }
    return null;
  };
  const discountHead = truth.discount.text.split('\n').slice(0, 12).join('\n');
  const answerLine = (text) => text.split('\n').reverse().find((line) => /^\s*\**ANSWER:?\**/i.test(line)) ?? text;
  const contains = (text, ...needles) => needles.every((needle) => text.includes(needle));
  // Asking which source is meant, with or without a question mark ("tell me which budget you mean").
  const asks = (text) => text.includes('?') || /\b(?:which (?:one|budget|file|source|of these)|tell me which|let me know which|specify which|if you mean[t]?)\b/i.test(text);
  return {
    'code-range-known': (text) => contains(text, discountHead),
    'code-duplicate-named': (text) => contains(text, lines('Admin/src/app.py').slice(9, 20).join('\n')),
    'code-duplicate-ambiguous': (text) => contains(text, 'Admin', 'server/app.py', 'worker/app.py') && /src\/app\.py/.test(text) && asks(text),
    'code-function-lookup': (text) => contains(text, truth.discount.text),
    'code-multi-function': (text) => contains(text, block('normalize_sku'), block('retry_payment'), block('registerRoutes')),
    'code-config-key': (text) => /settings\.py/.test(answerLine(text)) && /\b7\b/.test(answerLine(text)),
    'code-repeated-inspections': (text) => REPEATED_RANGES.every(([first, last]) => contains(text, lines('Shop/lib/billing.py').slice(first - 1, last).join('\n'))),
    'code-stale-reference': (text) => contains(text, discountHead),
    'code-modified-on-disk': (text) => contains(text, routesNow),
    'doc-short-file': (text) => contains(answerLine(text), truth.vendorReview),
    'doc-long-fact': (text) => /\$?4\.2 million/.test(answerLine(text)),
    'doc-large-table': (text) => contains(answerLine(text), truth.balance104233),
    'doc-identifier': (text) => contains(answerLine(text), truth.invoice417.Customer, truth.invoice417.Amount),
    'doc-ambiguous-sources': (text) => contains(text, truth.northPlanningNow, truth.northApproved) && asks(text),
    'doc-related-facts': (text) => contains(answerLine(text), truth.southApproved.Revenue, truth.southApproved['Reporting period'], truth.southApproved.Headcount),
    // Says the division is absent, in any wording, and gives it no number.
    'doc-missing': (text) => {
      const answer = answerLine(text).replace(/[`*"“”']/g, '');
      return (/\b(?:no|not|none|n't|cannot|can't|unable|absent|missing)\b/i.test(answer) || /not (?:found|present|available)/i.test(answer))
        && !/\d+\.\d/.test(answer);
    },
    'doc-history': (text) => contains(answerLine(text), truth.northPlanningBefore),
    'doc-multi-batch': (text) => contains(text, truth.balance120001, truth.invoice1200, truth.vendorReview, truth.eastApprovedRevenue, truth.centralPlanningHeadcount) && /4\.2 million/.test(text),
  };
}

const TASKS = [
  ['code-range-known', 'code'], ['code-duplicate-named', 'code'], ['code-duplicate-ambiguous', 'code'], ['code-function-lookup', 'code'],
  ['code-multi-function', 'code'], ['code-config-key', 'code'], ['code-repeated-inspections', 'code'], ['code-stale-reference', 'code', true],
  ['code-modified-on-disk', 'code'], ['doc-short-file', 'docs'], ['doc-long-fact', 'docs'], ['doc-large-table', 'docs'], ['doc-identifier', 'docs'],
  ['doc-ambiguous-sources', 'docs'], ['doc-related-facts', 'docs'], ['doc-missing', 'docs'], ['doc-history', 'docs', true], ['doc-multi-batch', 'docs'],
].map(([id, family, capability = false]) => ({ id, family, capability })).filter((task) => !ONLY || ONLY.includes(task.id));

// ── the model loop ─────────────────────────────────────────────────────────

class BudgetExceeded extends Error {}

class Spend {
  constructor(limit) { this.limit = limit; this.spent = 0; }
  cost(model, usage) {
    const price = PRICES[model];
    const cached = usage.input_tokens_details?.cached_tokens ?? 0;
    return ((usage.input_tokens - cached) * price.input + cached * price.cached + usage.output_tokens * price.output) / 1e6;
  }
  /** Refuses a call that could, at its worst, take the run past the limit. */
  check(model, expectedInput) {
    const price = PRICES[model];
    const worst = ((expectedInput + 40_000) * price.input + MAX_OUTPUT_TOKENS * price.output) / 1e6;
    if (this.spent + worst > this.limit) throw new BudgetExceeded(`stopping: $${this.spent.toFixed(3)} spent, a further call could pass $${this.limit}`);
  }
}

async function create(body) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
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

async function runTask({ model, arm, task, prompt, tools, execute, instructions, spend }) {
  const calls = [];
  const toolCalls = {};
  // Every tool call's arguments and whether it failed, to see how the model used each tool.
  const trace = [];
  let toolMs = 0;
  let input = [{ role: 'user', content: prompt }];
  let previous = null;
  let final = '';
  let stop = 'turns';
  const started = performance.now();
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    spend.check(model, calls.at(-1)?.input ?? 2000);
    const response = await create({ model, instructions, input, tools, reasoning: { effort: EFFORT },
      max_output_tokens: MAX_OUTPUT_TOKENS, parallel_tool_calls: true, ...(previous ? { previous_response_id: previous } : {}) });
    const usage = response.usage;
    const cost = spend.cost(model, usage);
    spend.spent += cost;
    calls.push({ input: usage.input_tokens, cached: usage.input_tokens_details?.cached_tokens ?? 0, output: usage.output_tokens,
      reasoning: usage.output_tokens_details?.reasoning_tokens ?? 0, cost, status: response.status });
    const functionCalls = response.output.filter((item) => item.type === 'function_call');
    if (!functionCalls.length) {
      final = messageText(response);
      stop = response.status === 'incomplete' ? 'incomplete' : 'answered';
      break;
    }
    input = [];
    for (const call of functionCalls) {
      let parsed;
      try { parsed = JSON.parse(call.arguments || '{}'); } catch { parsed = null; }
      const toolStarted = performance.now();
      let output;
      try {
        output = parsed ? await execute(call.name, parsed) : 'Error: the arguments were not valid JSON.';
      } catch (error) {
        output = JSON.stringify({ error: { code: error.code ?? 'error', message: error.message } });
      }
      toolMs += performance.now() - toolStarted;
      if (typeof output !== 'string') output = JSON.stringify(output);
      if (output.length > MAX_TOOL_CHARS) output = `${output.slice(0, MAX_TOOL_CHARS)}\n[output truncated at ${MAX_TOOL_CHARS} characters]`;
      toolCalls[call.name] = (toolCalls[call.name] ?? 0) + 1;
      trace.push({ turn, name: call.name, args: (call.arguments ?? '').slice(0, 400),
        error: /^\{"error"|^Error|^File does not exist|^Invalid regular/.test(output) || /"error":\{"code"/.test(output.slice(0, 2000)) });
      input.push({ type: 'function_call_output', call_id: call.call_id, output });
    }
    previous = response.id;
  }
  const sum = (key) => calls.reduce((total, call) => total + call[key], 0);
  return { model, arm, task: task.id, family: task.family, capability: task.capability, stop, final,
    modelCalls: calls.length, toolCalls: Object.values(toolCalls).reduce((total, count) => total + count, 0), toolsUsed: toolCalls,
    usedLasso: Object.keys(toolCalls).some((name) => name.startsWith('lasso_')), trace,
    input: sum('input'), cached: sum('cached'), output: sum('output'), reasoning: sum('reasoning'), tokens: sum('input') + sum('output'),
    firstInput: calls[0]?.input ?? null, costUsd: sum('cost'), wallMs: Math.round(performance.now() - started), toolMs: Math.round(toolMs) };
}

// ── runs and the report ────────────────────────────────────────────────────

function shuffle(values, seed) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const other = seed % (index + 1);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

function summarize(results, spent) {
  const models = [...new Set(results.map((row) => row.model))];
  const byModel = {};
  for (const model of models) {
    const rows = results.filter((row) => row.model === model && !row.error);
    byModel[model] = { arms: {} };
    for (const armName of ARMS.slice(1)) byModel[model].arms[armName] = compare(rows, armName);
    byModel[model].capability = rows.filter((row) => row.capability).map(({ run, arm: name, task, correct, tokens }) => ({ run, arm: name, task, correct, tokens }));
    const firstInput = (name) => {
      const values = rows.filter((row) => row.arm === name && row.firstInput).map((row) => row.firstInput).sort((a, b) => a - b);
      return values[Math.floor((values.length - 1) / 2)] ?? null;
    };
    byModel[model].firstCallInput = Object.fromEntries(ARMS.map((name) => [name, firstInput(name)]));
  }
  return { generatedAt: new Date().toISOString(), effort: EFFORT, runs: RUNS, budgetUsd: BUDGET, spentUsd: Math.round(spent * 10000) / 10000,
    estimatedDefinitionTokens: { direct: estimateTokens(JSON.stringify(DIRECT_FUNCTIONS)),
      lasso: estimateTokens(JSON.stringify(LASSO_FUNCTIONS)) + estimateTokens(LASSO_INSTRUCTIONS) },
    // Answers are kept whole, so a grader can be checked or rerun without calling the model again.
    models: byModel, results: results.map(({ final, ...row }) => ({ ...row, answer: final })) };
}

/** One arm against direct tools, over the tasks both did in the same run. */
function compare(rows, armName) {
  const pairs = [];
  for (const row of rows.filter((item) => item.arm === 'direct' && !item.capability)) {
    const other = rows.find((item) => item.arm === armName && item.task === row.task && item.run === row.run);
    if (other) pairs.push([row, other]);
  }
  const total = (index, key) => pairs.reduce((sum, pair) => sum + pair[index][key], 0);
  const arm = (index) => ({ tasks: pairs.length, correct: pairs.filter((pair) => pair[index].correct).length,
    tokens: total(index, 'tokens'), input: total(index, 'input'), cached: total(index, 'cached'), output: total(index, 'output'),
    reasoning: total(index, 'reasoning'), modelCalls: total(index, 'modelCalls'), toolCalls: total(index, 'toolCalls'),
    costUsd: Math.round(total(index, 'costUsd') * 10000) / 10000, wallSeconds: Math.round(total(index, 'wallMs') / 100) / 10 });
  const family = (name) => {
    const subset = pairs.filter(([direct]) => direct.family === name);
    const lasso = subset.reduce((sum, [, row]) => sum + row.tokens, 0);
    const direct = subset.reduce((sum, [row]) => sum + row.tokens, 0);
    return direct ? Math.round((1 - lasso / direct) * 1000) / 10 : null;
  };
  const ratios = pairs.map(([direct, lasso]) => lasso.tokens / direct.tokens).sort((a, b) => a - b);
  const lassoRows = rows.filter((row) => row.arm === armName && !row.capability);
  return {
    direct: arm(0), arm: arm(1),
    S: pairs.length ? Math.round((1 - total(1, 'tokens') / total(0, 'tokens')) * 1000) / 10 : null,
    families: { code: family('code'), docs: family('docs') },
    perTaskRatio: ratios.length ? { min: Math.round(ratios[0] * 100) / 100, median: Math.round(ratios[Math.floor((ratios.length - 1) / 2)] * 100) / 100,
      max: Math.round(ratios.at(-1) * 100) / 100 } : null,
    moreTokensThanDirect: pairs.filter(([direct, lasso]) => lasso.tokens > direct.tokens).length,
    lassoUse: { tasksUsingLasso: lassoRows.filter((row) => row.usedLasso).length, tasks: lassoRows.length,
      // Tasks that also needed the file tools: the fallback rate f of E[T_L] = c + f·B_f.
      fellBack: lassoRows.filter((row) => row.usedLasso && Object.keys(row.toolsUsed).some((name) => !name.startsWith('lasso_'))).length,
      calls: lassoRows.reduce((counts, row) => {
        for (const [name, count] of Object.entries(row.toolsUsed)) counts[name] = (counts[name] ?? 0) + count;
        return counts;
      }, {}) },
  };
}

function report(summary) {
  const lines = ['# Lasso agent benchmark: live model runs', ''];
  lines.push(`Generated ${summary.generatedAt}. Produced by \`node scripts/agent-benchmark-live.mjs\`. Reasoning effort ${summary.effort}; ${summary.runs} run(s); spent $${summary.spentUsd.toFixed(3)} of a $${summary.budgetUsd} limit.`, '');
  lines.push('**Token counts are the provider\'s usage records** for every model call: input counts everything sent each call (instructions, tool definitions, the conversation so far), output includes reasoning. The model chose its own steps. Tasks, corpus and grading are the offline benchmark\'s ([benchmark-results.md](benchmark-results.md)).', '');
  for (const [model, result] of Object.entries(summary.models)) {
    lines.push(`## ${model}`, '');
    lines.push('Each arm is compared with direct tools on the same tasks in the same runs (capability tasks excluded).', '');
    lines.push('| Arm | Correct | Tokens T | Input | of which cached | Output | of which reasoning | Model calls J | Tool calls | Cost | Wall time |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
    const n = (value) => value.toLocaleString('en-US');
    const line = (name, row) => `| ${name} | ${row.correct}/${row.tasks} | ${n(row.tokens)} | ${n(row.input)} | ${n(row.cached)} | ${n(row.output)} | ${n(row.reasoning)} | ${row.modelCalls} | ${row.toolCalls} | $${row.costUsd.toFixed(4)} | ${row.wallSeconds} s |`;
    const first = Object.values(result.arms)[0];
    if (first) lines.push(line('direct', first.direct));
    for (const [name, comparison] of Object.entries(result.arms)) lines.push(line(name, comparison.arm));
    lines.push('');
    for (const [name, comparison] of Object.entries(result.arms)) {
      lines.push(`- **${name}**: S = 1 − ΣT/ΣT_direct over ${comparison.direct.tasks} paired tasks = **${comparison.S}%** (code ${comparison.families.code}%, docs ${comparison.families.docs}%); per-task ratio min ${comparison.perTaskRatio?.min}, median ${comparison.perTaskRatio?.median}, max ${comparison.perTaskRatio?.max}; more tokens than direct on ${comparison.moreTokensThanDirect} of ${comparison.direct.tasks}. Used Lasso on ${comparison.lassoUse.tasksUsingLasso} of ${comparison.lassoUse.tasks} tasks, also needing file tools on ${comparison.lassoUse.fellBack} of those (${Object.entries(comparison.lassoUse.calls).map(([tool, count]) => `${tool} ×${count}`).join(', ')}).`);
    }
    lines.push(`- First-call input (instructions + tool definitions + request), median: ${Object.entries(result.firstCallInput).map(([name, value]) => `${name} ${value}`).join(', ')} tokens. Lasso's definitions and instructions cost **${result.firstCallInput.lasso - result.firstCallInput.direct} tokens per call** in this model's tokenizer (offline estimate: ${summary.estimatedDefinitionTokens.lasso}).`);
    lines.push(`- Capability tasks (not in S): ${result.capability.map((row) => `${row.task} run ${row.run} ${row.arm} ${row.correct ? 'correct' : 'wrong'}`).join('; ') || 'none run'}.`, '');
    lines.push('| Run | Task | Arm | Correct | Tokens | Cached | Output | Model calls | Tool calls | Tools | Wall s | Stop |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const row of summary.results.filter((item) => item.model === model)) {
      if (row.error) { lines.push(`| ${row.run} | ${row.task} | ${row.arm} | error | | | | | | ${row.error} | | |`); continue; }
      lines.push(`| ${row.run} | ${row.task}${row.capability ? ' *' : ''} | ${row.arm} | ${row.correct ? 'yes' : '**no**'} | ${row.tokens} | ${row.cached} | ${row.output} | ${row.modelCalls} | ${row.toolCalls} | ${Object.entries(row.toolsUsed).map(([name, count]) => `${name}×${count}`).join(' ')} | ${(row.wallMs / 1000).toFixed(1)} | ${row.stop} |`);
    }
    lines.push('', '\\* capability task: needs history direct tools cannot reach.', '');
  }
  return `${lines.join('\n')}\n`;
}

async function regrade(file) {
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const library = await prepareLibrary();
  const grade = graders(library);
  let changed = 0;
  const results = saved.results.map((row) => {
    if (row.error || row.stop !== 'answered') return { ...row, final: row.answer ?? '' };
    const correct = grade[row.task](row.answer);
    if (correct !== row.correct) changed += 1;
    return { ...row, correct, final: row.answer };
  });
  await library.app.close();
  fs.rmSync(library.root, { recursive: true, force: true });
  const summary = { ...summarize(results, saved.spentUsd), generatedAt: saved.generatedAt, effort: saved.effort, runs: saved.runs, budgetUsd: saved.budgetUsd };
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(file.replace(/\.json$/, '.md'), report(summary));
  console.error(`Regraded ${file}: ${changed} grade(s) changed.`);
}

async function main() {
  if (REGRADE) return regrade(path.resolve(REGRADE));
  if (!KEY) throw new Error('Set OPENAI_API_KEY or pass --key-file.');
  if (!MODELS.length) throw new Error('Name at least one --model.');
  for (const model of MODELS) if (!PRICES[model]) throw new Error(`No price recorded for ${model}; add it to PRICES first.`);
  const spend = new Spend(BUDGET);
  const results = [];
  const save = () => {
    const summary = summarize(results, spend.spent);
    fs.mkdirSync(OUT, { recursive: true });
    // One file pair per model set, so runs of different models do not overwrite each other.
    const base = `live-results-${MODELS.join('+')}${LABEL ? `-${LABEL}` : ''}`;
    fs.writeFileSync(path.join(OUT, `${base}.json`), `${JSON.stringify(summary, null, 2)}\n`);
    fs.writeFileSync(path.join(OUT, `${base}.md`), report(summary));
    return summary;
  };
  try {
    for (let run = 1; run <= RUNS; run += 1) {
      const library = await prepareLibrary();
      const prompts = taskPrompts(library.truth, library.oldBillingRev);
      const grade = graders(library);
      const direct = directTools(library.root);
      const lasso = openLocal({ dataDir: library.dataDir, scope: ['*'], client: 'live-benchmark' });
      const lassoTools = { lasso_suggest: (input) => lasso.suggest(input), lasso_inspect: (input) => lasso.inspect(input), lasso_bind: (input) => lasso.bind(input) };
      const arms = {
        direct: { tools: DIRECT_FUNCTIONS, instructions: INSTRUCTIONS, execute: (name, input) => direct[name](input) },
        lasso: { tools: [...DIRECT_FUNCTIONS, ...LASSO_FUNCTIONS], instructions: `${INSTRUCTIONS}\n\n${LASSO_INSTRUCTIONS}`,
          execute: (name, input) => (lassoTools[name] ?? direct[name])(input) },
        'lasso-first': { tools: [...DIRECT_FUNCTIONS, ...LASSO_FUNCTIONS], instructions: `${INSTRUCTIONS}\n\n${LASSO_INSTRUCTIONS} ${PREFER_LASSO}`,
          execute: (name, input) => (lassoTools[name] ?? direct[name])(input) },
      };
      try {
        for (const [index, task] of TASKS.entries()) {
          for (const model of MODELS) {
            for (const name of shuffle(ARMS, run * 1000 + index)) {
              try {
                const row = await runTask({ model, arm: name, task, prompt: prompts[task.id], spend, ...arms[name] });
                results.push({ run, ...row, correct: row.stop === 'answered' && grade[task.id](row.final) });
                console.error(`run ${run} ${model} ${task.id} ${name}: ${results.at(-1).correct ? 'correct' : 'wrong'}, ${row.tokens} tokens, $${spend.spent.toFixed(3)} so far`);
              } catch (error) {
                if (error instanceof BudgetExceeded) throw error;
                results.push({ run, model, arm: name, task: task.id, family: task.family, capability: task.capability, error: error.message, final: '' });
                console.error(`run ${run} ${model} ${task.id} ${name}: error ${error.message}`);
              }
              save();
            }
          }
        }
      } finally {
        await lasso.close();
        await library.app.close();
        fs.rmSync(library.root, { recursive: true, force: true });
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    console.error(error.message);
  }
  const summary = save();
  console.log(report(summary));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
