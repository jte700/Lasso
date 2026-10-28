// Agent benchmark: the same tasks, done with ordinary file tools and with
// Lasso, on a generated library whose answers are known.
//
//   node scripts/agent-benchmark.mjs [--out docs/agent] [--runs 3] [--keep]
//
// What is measured, and what is not:
//  - Tools really run. Direct tools (Read, Grep, Glob) read the corpus; Lasso
//    tools call the evidence service exactly as the MCP server does. Their
//    outputs, round count, call count and local time are measured.
//  - Each arm follows a scripted, competent policy (parallel calls, grep with
//    context, reading headers rather than whole tables). The final answer is
//    parsed from the tool outputs and graded against the generator's truth.
//  - Model tokens are accounted with T(π) = Σ_t (I_t + O_t): every invocation
//    re-reads the system prompt, the tool definitions and everything said so
//    far. Sizes are ESTIMATES from a tokenizer-free estimator applied equally
//    to every arm. Reasoning tokens are not modelled. No provider usage was
//    recorded; a live run is required for that.

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { openLocal, connect } from '../src/agent/client.js';
import { ASK_DEFINITIONS, DIRECT_DEFINITIONS, LASSO_DEFINITIONS, LASSO_DEFINITIONS_WITH_CITE, LEGACY_DEFINITION, composeAnswer, directTools, estimateConservative,
  graders, grepHits, prepareLibrary, readLines, REPEATED_RANGES, taskPrompts } from './agent-benchmark-corpus.mjs';
import { blockRange, definitions } from '../src/agent/evidence.js';
import { formatAnswer } from '../src/agent/render.js';
import { estimateTokens } from '../src/agent/metrics.js';
import { readDiscovery } from '../src/agent/rest.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'src', 'agent', 'cli.js');
const args = process.argv.slice(2);
const OUT = path.resolve(ROOT, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'docs/agent');
const KEEP = args.includes('--keep');
// Folder ids are random, so ranking ties and handle strings differ between runs; repeat and report the spread.
const RUNS = args.includes('--runs') ? Number(args[args.indexOf('--runs') + 1]) : 3;
// Tool definitions as a provider counted them (scripts/agent-token-probe.mjs), when measured; estimated otherwise.
const PROBE = path.join(ROOT, 'docs', 'agent', 'token-probe.json');
const MEASURED = fs.existsSync(PROBE) ? JSON.parse(fs.readFileSync(PROBE, 'utf8')).definitions : null;

// Accounting constants, the same for every arm.
const SYSTEM_TOKENS = 1000;
const CALL_OVERHEAD = 15;
const RESULT_OVERHEAD = 10;
// Claude Opus 5.5 list prices per million tokens, for the cost columns only.
const PRICE = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

// ── trajectories and accounting ────────────────────────────────────────────

class Trajectory {
  constructor({ arm, task, tools, definitions }) {
    this.arm = arm;
    this.task = task;
    this.tools = tools;
    this.definitions = JSON.stringify(definitions);
    // Measured per-call cost of these definitions, when the probe has measured all of them.
    const names = definitions.map((definition) => definition.name).filter(Boolean);
    const searchRead = names.some((name) => name === 'lasso_search' || name === 'lasso_read');
    const ask = names.includes('lasso');
    // The probe measures v3's search and read and the current lasso tool; cite, when offered, is added as estimated.
    // A probe from before the lasso tool measured v3 as current.
    const v3 = MEASURED?.lassoV3 ?? MEASURED?.lassoCurrent;
    const v4 = MEASURED?.lassoV3 != null ? MEASURED.lassoCurrent : null;
    const cite = definitions.find((definition) => definition.name === 'lasso_cite');
    this.measuredDefinitions = MEASURED && !names.includes('lasso_find') && !(ask && v4 == null)
      ? MEASURED.direct + (searchRead ? v3 : 0) + (ask ? v4 : 0) + (cite ? estimateTokens(JSON.stringify(cite)) : 0) : null;
    this.rounds = [];
    this.ms = 0;
    this.answer = null;
  }

  /** One model turn's tool calls, run as a host runs parallel calls. */
  async round(calls) {
    const results = [];
    const record = [];
    for (const [name, input] of calls) {
      const started = performance.now();
      let output = await this.tools[name](input);
      this.ms += performance.now() - started;
      if (output?.forModel !== undefined) {
        results.push(output.value);
        output = output.forModel;
      } else {
        if (typeof output !== 'string') output = JSON.stringify(output);
        results.push(output);
      }
      record.push({ name, input, output });
    }
    this.rounds.push(record);
    return results;
  }

  /** T(π) and its parts under one token estimator. */
  account(estimate, answer) {
    const callTokens = (call) => estimate(JSON.stringify(call.input)) + estimate(call.name) + CALL_OVERHEAD;
    const resultTokens = (call) => estimate(call.output) + RESULT_OVERHEAD;
    const definitionTokens = this.measuredDefinitions ?? estimate(this.definitions);
    const fixed = SYSTEM_TOKENS + definitionTokens + estimate(this.task.prompt);
    const invocations = [];
    let history = 0;
    for (let turn = 0; turn <= this.rounds.length; turn += 1) {
      const calls = turn < this.rounds.length ? this.rounds[turn] : null;
      const output = calls ? calls.reduce((sum, call) => sum + callTokens(call), 0) : estimate(answer);
      const input = fixed + history;
      // With prompt caching, everything the previous invocation already sent is a cache read.
      const cached = turn === 0 ? 0 : invocations[turn - 1].input + invocations[turn - 1].output;
      invocations.push({ input, output, cached: Math.min(cached, input) });
      if (calls) history += calls.reduce((sum, call) => sum + callTokens(call) + resultTokens(call), 0);
    }
    const input = invocations.reduce((sum, item) => sum + item.input, 0);
    const output = invocations.reduce((sum, item) => sum + item.output, 0);
    const cached = invocations.reduce((sum, item) => sum + item.cached, 0);
    const evidence = this.rounds.flat().reduce((sum, call) => sum + resultTokens(call), 0);
    return { invocations: invocations.length, input, output, cached, evidence, overhead: invocations.length * definitionTokens };
  }

  finish(answer) {
    this.answer = answer;
    const { invocations, input, output, cached, evidence, overhead } = this.account(estimateTokens, answer);
    const conservative = this.account(estimateConservative, answer);
    const outputs = this.rounds.flat().map((call) => call.output).join('\n');
    return {
      task: this.task.id, family: this.task.family, arm: this.arm, capability: Boolean(this.task.capability),
      correct: this.task.grade(answer), retrieved: this.task.retrieved ? this.task.retrieved(outputs) : null,
      invocations, rounds: this.rounds.length, calls: this.rounds.flat().length,
      tokens: input + output, input, output, evidence, definitionOverhead: overhead, cachedInput: cached,
      conservativeTokens: conservative.input + conservative.output, conservativeEvidence: conservative.evidence,
      costUsd: (input * PRICE.input + output * PRICE.output) / 1e6,
      cachedCostUsd: ((input - cached) * PRICE.input + cached * PRICE.cacheRead + output * PRICE.output) / 1e6,
      localMs: Math.round(this.ms * 10) / 10, answer,
      ...(this.task.grade(answer) ? {} : { outputs: this.rounds.flat().map((call) => `${call.name} ${JSON.stringify(call.input)} -> ${call.output.slice(0, 1500)}`) }),
    };
  }
}

const json = (output) => JSON.parse(output);
const candidatesOf = (output, index = 0) => json(output).results[index].candidates;

/** One call: the request as the person wrote it, then an answer from what came back. */
async function askPolicy(t) {
  const [result] = await t.round([['lasso', { ask: [t.task.prompt] }]]);
  return t.finish(composeAnswer(json(result)));
}

// ── tasks ──────────────────────────────────────────────────────────────────

function tasks(truth, oldBillingRev, routesNow) {
  const prompts = taskPrompts(truth, oldBillingRev);
  const discountLines = `${truth.discount.start}-${truth.discount.start + 11}`;
  const citedLines = `${truth.discount.originalStart}-${truth.discount.originalStart + 11}`;
  const discountHead = truth.discount.text.split('\n').slice(0, 12).join('\n');
  const repeated = REPEATED_RANGES;
  const billingLines = fs.readFileSync(path.join(globalThis.corpusRoot, 'Shop/lib/billing.py'), 'utf8').replace(/\n$/, '').split('\n');
  const repeatedTruth = repeated.map(([first, last]) => billingLines.slice(first - 1, last).join('\n')).join('\n---\n');
  const blockFromRead = (output, firstLine) => {
    const lines = readLines(output);
    const range = blockRange(lines, definitions(lines)[0] ?? { line: 1, indent: 0 });
    return { text: lines.slice(range.start - 1, range.end).join('\n'), complete: range.end < lines.length, first: firstLine };
  };
  const functionTruth = (name) => {
    for (const [file, contents] of Object.entries(globalThis.corpusFiles)) {
      const lines = contents.replace(/\n$/, '').split('\n');
      const found = definitions(lines).find((definition) => definition.name === name);
      if (found) { const range = blockRange(lines, found); return lines.slice(range.start - 1, range.end).join('\n'); }
    }
    return null;
  };
  const multiNames = ['normalize_sku', 'retry_payment', 'registerRoutes'];
  const multiTruth = multiNames.map(functionTruth).join('\n---\n');

  return [
    {
      id: 'code-range-known', family: 'code', features: { fileKnown: true, smallRead: true },
      prompt: prompts['code-range-known'],
      grade: (answer) => answer === discountHead, retrieved: (outputs) => outputs.includes('def apply_discount'),
      direct: async (t) => t.finish(readLines((await t.round([['Read', { file_path: 'Shop/lib/billing.py', offset: truth.discount.start, limit: 12 }]]))[0]).join('\n')),
      lasso: async (t) => t.finish(json((await t.round([['lasso_read', { items: [{ file: 'lib/billing.py', folder: 'Shop', lines: discountLines }] }]]))[0]).items[0].text),
    },
    {
      id: 'code-duplicate-named', family: 'code', features: {},
      prompt: prompts['code-duplicate-named'],
      grade: (answer) => answer === Array.from({ length: 11 }, (_, index) => `ADMIN_SETTING_${index + 10} = ${(index + 9) * 3}`).join('\n'),
      direct: async (t) => {
        const [found] = await t.round([['Glob', { pattern: 'Admin/**/app.py' }]]);
        const [read] = await t.round([['Read', { file_path: found.split('\n')[0], offset: 10, limit: 11 }]]);
        return t.finish(readLines(read).join('\n'));
      },
      lasso: async (t) => t.finish(json((await t.round([['lasso_read', { items: [{ file: 'app.py', folder: 'Admin', lines: '10-20' }] }]]))[0]).items[0].text),
    },
    {
      id: 'code-duplicate-ambiguous', family: 'code', features: { ambiguousName: true },
      prompt: prompts['code-duplicate-ambiguous'],
      // Correct behaviour is to list every app.py and ask, not to pick one.
      grade: (answer) => ['Admin/src/app.py', 'Shop/server/app.py', 'Shop/worker/app.py'].every((name) => answer.includes(name)) && answer.startsWith('Which'),
      direct: async (t) => {
        const [found] = await t.round([['Glob', { pattern: '**/app.py' }]]);
        return t.finish(`Which app.py do you mean? ${found.split('\n').join(', ')}`);
      },
      lasso: async (t) => {
        const [result] = await t.round([['lasso_read', { items: [{ file: 'app.py', lines: '1-5' }] }]]);
        return t.finish(`Which app.py do you mean? ${json(result).items[0].error.matches.map((match) => `${match.folder}/${match.path}`).join(', ')}`);
      },
    },
    {
      id: 'code-function-lookup', family: 'code', features: {},
      prompt: prompts['code-function-lookup'],
      grade: (answer) => answer === truth.discount.text, retrieved: (outputs) => outputs.includes('return order.total - saving'),
      direct: async (t) => {
        const [grep] = await t.round([['Grep', { pattern: 'def apply_discount', output_mode: 'content', '-n': true }]]);
        const [hit] = grepHits(grep);
        const [read] = await t.round([['Read', { file_path: hit.file, offset: hit.line, limit: 80 }]]);
        return t.finish(blockFromRead(read, hit.line).text);
      },
      legacy: async (t) => {
        const [found] = await t.round([['lasso_find', { command: 'find apply_discount' }]]);
        const result = json(found).results[0];
        const line = Number(String(result.lines.find((value) => /line \d+/.test(value ?? '')) ?? '').match(/line (\d+)/)?.[1]);
        const [read] = await t.round([['Read', { file_path: `Shop/${result.ref.path}`, offset: line, limit: 80 }]]);
        return t.finish(blockFromRead(read, line).text);
      },
      lasso: async (t) => {
        const [found] = await t.round([['lasso_search', { queries: [{ text: 'apply_discount', kind: 'code' }] }]]);
        const [block] = await t.round([['lasso_read', { items: [{ h: candidatesOf(found)[0].h, symbol: true }] }]]);
        return t.finish(json(block).items[0].text);
      },
      optimized: async (t) => t.finish(json((await t.round([['lasso_read', { items: [{ symbol: 'apply_discount' }] }]]))[0]).items[0].text),
    },
    {
      id: 'code-multi-function', family: 'code', features: { multiFact: true },
      prompt: prompts['code-multi-function'],
      grade: (answer) => answer === multiTruth,
      direct: async (t) => {
        const [grep] = await t.round([['Grep', { pattern: '(def normalize_sku|def retry_payment|function registerRoutes)\\b', output_mode: 'content', '-n': true }]]);
        const hits = grepHits(grep);
        const order = multiNames.map((name) => hits.find((hit) => hit.text.includes(name)));
        const reads = await t.round(order.map((hit) => ['Read', { file_path: hit.file, offset: hit.line, limit: 80 }]));
        return t.finish(reads.map((read, index) => blockFromRead(read, order[index].line).text).join('\n---\n'));
      },
      lasso: async (t) => {
        const results = await t.round(multiNames.map((name) => ['lasso_read', { items: [{ symbol: name }] }]));
        return t.finish(results.map((result) => json(result).items[0].text).join('\n---\n'));
      },
      optimized: async (t) => t.finish(json((await t.round([['lasso_read', { items: multiNames.map((symbol) => ({ symbol })) }]]))[0]).items.map((item) => item.text).join('\n---\n')),
    },
    {
      id: 'code-config-key', family: 'code', features: {},
      prompt: prompts['code-config-key'],
      grade: (answer) => answer === 'Shop/config/settings.py: 7',
      direct: async (t) => {
        const [grep] = await t.round([['Grep', { pattern: '^\\s*MAX_RETRIES\\s*=', output_mode: 'content', '-n': true }]]);
        const [hit] = grepHits(grep);
        return t.finish(`${hit.file}: ${hit.text.split('=')[1].trim()}`);
      },
      legacy: async (t) => {
        const [found] = await t.round([['lasso_find', { command: 'find MAX_RETRIES' }]]);
        const result = json(found).results.find((entry) => String(entry.value ?? '').includes('='));
        return t.finish(`Shop/${result.ref.path}: ${String(result.value).split('=')[1].trim()}`);
      },
      lasso: async (t) => {
        const [found] = await t.round([['lasso_search', { queries: [{ text: 'MAX_RETRIES', kind: 'code', limit: 3 }] }]]);
        const response = json(found);
        const candidate = response.results[0].candidates.find((entry) => String(entry.value ?? '').includes('='));
        const source = response.sources[candidate.src];
        return t.finish(`${source.folder}/${source.path}: ${candidate.value.split('=')[1].trim()}`);
      },
    },
    {
      id: 'code-repeated-inspections', family: 'code', features: { fileKnown: true, multiFact: true },
      prompt: prompts['code-repeated-inspections'],
      grade: (answer) => answer === repeatedTruth,
      direct: async (t) => {
        const reads = await t.round(repeated.map(([first, last]) => ['Read', { file_path: 'Shop/lib/billing.py', offset: first, limit: last - first + 1 }]));
        return t.finish(reads.map((read) => readLines(read).join('\n')).join('\n---\n'));
      },
      lasso: async (t) => {
        const results = await t.round(repeated.map(([first, last]) => ['lasso_read', { items: [{ file: 'lib/billing.py', folder: 'Shop', lines: `${first}-${last}` }] }]));
        return t.finish(results.map((result) => json(result).items[0].text).join('\n---\n'));
      },
      optimized: async (t) => {
        const [result] = await t.round([['lasso_read', { items: repeated.map(([first, last]) => ({ file: 'lib/billing.py', folder: 'Shop', lines: `${first}-${last}` })) }]]);
        return t.finish(json(result).items.map((item) => item.text).join('\n---\n'));
      },
    },
    {
      id: 'code-stale-reference', family: 'code', capability: true, features: { history: true },
      prompt: prompts['code-stale-reference'],
      grade: (answer) => answer === discountHead,
      direct: async (t) => t.finish(readLines((await t.round([['Read', { file_path: 'Shop/lib/billing.py', offset: truth.discount.originalStart, limit: 12 }]]))[0]).join('\n')),
      lasso: async (t) => t.finish(json((await t.round([['lasso_read', { items: [{ file: 'lib/billing.py', folder: 'Shop', lines: citedLines, rev: oldBillingRev }] }]]))[0]).items[0].text),
    },
    {
      id: 'code-modified-on-disk', family: 'code', features: { fileKnown: true, smallRead: true },
      prompt: prompts['code-modified-on-disk'],
      grade: (answer) => answer === routesNow,
      direct: async (t) => t.finish(readLines((await t.round([['Read', { file_path: 'Shop/web/routes.js', offset: 1, limit: 3 }]]))[0]).join('\n')),
      lasso: async (t) => {
        const [first] = await t.round([['lasso_read', { items: [{ file: 'web/routes.js', folder: 'Shop', lines: '1-3' }] }]]);
        const response = json(first);
        if (response.sources[response.items[0].src].disk !== 'changed') return t.finish(response.items[0].text);
        const [second] = await t.round([['lasso_read', { items: [{ file: 'web/routes.js', folder: 'Shop', lines: '1-3', version: 'disk' }] }]]);
        return t.finish(json(second).items[0].text);
      },
      optimized: async (t) => t.finish(json((await t.round([['lasso_read', { items: [{ file: 'web/routes.js', folder: 'Shop', lines: '1-3', version: 'disk' }] }]]))[0]).items[0].text),
    },
    {
      id: 'doc-short-file', family: 'docs', features: { fileKnown: true, smallRead: true },
      prompt: prompts['doc-short-file'],
      grade: (answer) => answer === truth.vendorReview,
      direct: async (t) => {
        const [read] = await t.round([['Read', { file_path: 'Finance/notes/short_note.md' }]]);
        return t.finish(read.match(/scheduled for ([A-Z][a-z]+ \d+)/)[1]);
      },
      lasso: async (t) => {
        const [found] = await t.round([['lasso_search', { queries: [{ text: 'vendor review', kind: 'passage', folder: 'Finance', limit: 3 }] }]]);
        return t.finish(candidatesOf(found).map((candidate) => candidate.value).join(' ').match(/scheduled for ([A-Z][a-z]+ \d+)/)[1]);
      },
    },
    {
      id: 'doc-long-fact', family: 'docs', features: {},
      prompt: prompts['doc-long-fact'],
      grade: (answer) => answer === truth.warranty,
      direct: async (t) => {
        const [grep] = await t.round([['Grep', { pattern: 'warranty reserve', path: 'Finance', output_mode: 'content', '-n': true, '-C': 1, '-i': true }]]);
        return t.finish(grep.match(/was (\$[\d.]+ million)/)[1]);
      },
      legacy: async (t) => {
        const [found] = await t.round([['lasso_find', { command: 'find warranty reserve' }]]);
        return t.finish(found.match(/was (\$[\d.]+ million)/)[1]);
      },
      lasso: async (t) => {
        // Lasso matches terms, not phrases: the question's other words narrow it.
        const [found] = await t.round([['lasso_search', { queries: [{ text: 'warranty reserve year end', kind: 'passage', limit: 3 }] }]]);
        return t.finish(candidatesOf(found).map((candidate) => candidate.value).join(' ').match(/was (\$[\d.]+ million)/)[1]);
      },
    },
    {
      id: 'doc-large-table', family: 'docs', features: { largeTable: true },
      prompt: prompts['doc-large-table'],
      grade: (answer) => answer === truth.balance104233,
      direct: async (t) => {
        const [found] = await t.round([['Glob', { pattern: '**/*ledger*' }]]);
        const file = found.split('\n')[0];
        const [grep, header] = await t.round([['Grep', { pattern: '^Account 104233,', path: file, output_mode: 'content', '-n': true }],
          ['Read', { file_path: file, offset: 1, limit: 1 }]]);
        const columns = readLines(header)[0].split(',');
        return t.finish(grepHits(grep)[0].text.split(',')[columns.indexOf('Balance')]);
      },
      lasso: async (t) => {
        const [found] = await t.round([['lasso_search', { queries: [{ text: 'Account 104233', fields: ['Balance'], limit: 3 }] }]]);
        return t.finish(candidatesOf(found).find((candidate) => candidate.row === 'Account 104233').fields.Balance.value);
      },
    },
    {
      id: 'doc-identifier', family: 'docs', features: {},
      prompt: prompts['doc-identifier'],
      grade: (answer) => answer === `${truth.invoice417.Customer}, ${truth.invoice417.Amount}`,
      direct: async (t) => {
        const [grep] = await t.round([['Grep', { pattern: 'INV-2025-00417', output_mode: 'content', '-n': true }]]);
        const [hit] = grepHits(grep);
        const [header] = await t.round([['Read', { file_path: hit.file, offset: 1, limit: 1 }]]);
        const columns = readLines(header)[0].split(',');
        const values = hit.text.split(',');
        return t.finish(`${values[columns.indexOf('Customer')]}, ${values[columns.indexOf('Amount')]}`);
      },
      legacy: async (t) => {
        const [found] = await t.round([['lasso_find', { command: 'find INV-2025-00417' }]]);
        const results = json(found).results;
        // A cell is told by its locator ("row 418 · Customer"); the first data column carries the row's own name.
        const field = (name) => results.find((entry) => entry.ref?.path === 'invoices.csv'
          && entry.lines?.some((line) => /^row \d+ · /.test(String(line)) && String(line).endsWith(` · ${name}`)) && entry.title?.startsWith('inv-2025-00417'))?.value;
        // find shows at most two results per file, so a field it left out is asked for by its exact name.
        const missing = ['Customer', 'Amount'].filter((name) => field(name) === undefined);
        if (missing.length) {
          const more = await t.round(missing.map((name) => ['lasso_find', { command: `find inv-2025-00417${name === 'Customer' ? '' : `-${name.toLowerCase()}`}` }]));
          more.forEach((output) => results.push(...json(output).results));
        }
        return t.finish(`${field('Customer')}, ${field('Amount')}`);
      },
      lasso: async (t) => {
        const [found] = await t.round([['lasso_search', { queries: [{ text: 'INV-2025-00417', fields: ['Customer', 'Amount'], limit: 3 }] }]]);
        const record = candidatesOf(found).find((candidate) => candidate.type === 'record');
        return t.finish(`${record.fields.Customer.value}, ${record.fields.Amount.value}`);
      },
    },
    {
      id: 'doc-ambiguous-sources', family: 'docs', features: { ambiguousIntent: true },
      prompt: prompts['doc-ambiguous-sources'],
      // Two budgets answer it differently; correct is to show both and ask which one.
      grade: (answer) => answer.startsWith('Which') && answer.includes(`${truth.northPlanningNow} (Planning`) && answer.includes(`${truth.northApproved} (Approved`),
      direct: async (t) => {
        const [grep] = await t.round([['Grep', { pattern: '^North division,', path: 'Finance', glob: '*.csv', output_mode: 'content', '-n': true }]]);
        const hits = grepHits(grep);
        const headers = await t.round(hits.map((hit) => ['Read', { file_path: hit.file, offset: 1, limit: 1 }]));
        const options = hits.map((hit, index) => {
          const columns = readLines(headers[index])[0].split(',');
          const values = hit.text.split(',');
          return `${values[columns.indexOf('Revenue')]} (${values[columns.indexOf('Scenario')]}, ${hit.file})`;
        });
        return t.finish(`Which budget do you mean? ${options.join('; ')}`);
      },
      lasso: async (t) => {
        const [found] = await t.round([['lasso_search', { queries: [{ text: 'North division', fields: ['Revenue', 'Scenario'], limit: 4 }] }]]);
        const response = json(found);
        const options = response.results[0].candidates.filter((candidate) => candidate.type === 'record' && candidate.row === 'North division')
          .map((record) => `${record.fields.Revenue.value} (${record.fields.Scenario.value}, ${response.sources[record.src].path})`);
        return t.finish(`Which budget do you mean? ${options.join('; ')}`);
      },
    },
    {
      id: 'doc-related-facts', family: 'docs', features: { multiFact: true },
      prompt: prompts['doc-related-facts'],
      grade: (answer) => answer === `${truth.southApproved.Revenue}; ${truth.southApproved['Reporting period']}; ${truth.southApproved.Headcount}`,
      direct: async (t) => {
        const [grep] = await t.round([['Grep', { pattern: '^South division,', path: 'Finance/Approved', output_mode: 'content', '-n': true }]]);
        const [hit] = grepHits(grep);
        const [header] = await t.round([['Read', { file_path: hit.file, offset: 1, limit: 1 }]]);
        const columns = readLines(header)[0].split(',');
        const values = hit.text.split(',');
        return t.finish(['Revenue', 'Reporting period', 'Headcount'].map((name) => values[columns.indexOf(name)]).join('; '));
      },
      lasso: async (t) => {
        const [found] = await t.round([['lasso_search', { queries: [{ text: 'South division', folder: 'Finance', under: 'Approved', fields: ['Revenue', 'Reporting period', 'Headcount'], limit: 2 }] }]]);
        const record = candidatesOf(found).find((candidate) => candidate.row === 'South division');
        return t.finish(['Revenue', 'Reporting period', 'Headcount'].map((name) => record.fields[name].value).join('; '));
      },
      // Deterministic insertion: the values reach the answer through bind, not by copying.
      ablation: async (t) => {
        const fields = ['Revenue', 'Reporting period', 'Headcount'];
        const [found] = await t.round([['lasso_search', { queries: [{ text: 'South division', folder: 'Finance', under: 'Approved', fields, limit: 2 }] }]]);
        const record = candidatesOf(found).find((candidate) => candidate.row === 'South division');
        const [bound] = await t.round([['lasso_cite', { task: 'bench-south', bind: { revenue: record.fields.Revenue.h, period: record.fields['Reporting period'].h, headcount: record.fields.Headcount.h },
          same_record: [['revenue', 'period', 'headcount']], template: '{{revenue}}; {{period}}; {{headcount}}', cite: 'none' }]]);
        return t.finish(json(bound).text);
      },
    },
    {
      id: 'doc-missing', family: 'docs', features: {},
      prompt: prompts['doc-missing'],
      grade: (answer) => answer === 'not found',
      direct: async (t) => {
        const [grep] = await t.round([['Grep', { pattern: 'West division', path: 'Finance', output_mode: 'files_with_matches' }]]);
        return t.finish(grep === 'No matches found' ? 'not found' : 'found');
      },
      lasso: async (t) => {
        const [found] = await t.round([['lasso_search', { queries: [{ text: 'West division', fields: ['Revenue'], limit: 3 }] }]]);
        // No exact match anywhere in the ranked list, only rows sharing a word.
        const result = json(found).results[0];
        return t.finish(result.coverage.exact === 0 ? 'not found' : 'found');
      },
    },
    {
      id: 'doc-history', family: 'docs', capability: true, features: { history: true },
      prompt: prompts['doc-history'],
      grade: (answer) => answer === truth.northPlanningBefore,
      direct: async (t) => {
        const [grep] = await t.round([['Grep', { pattern: '^North division,', path: 'Finance/Planning', output_mode: 'content', '-n': true }]]);
        return t.finish(grepHits(grep)[0]?.text.split(',')[1] ?? 'unknown');
      },
      lasso: async (t) => {
        const [found] = await t.round([['lasso_search', { queries: [{ text: 'North division', folder: 'Finance', under: 'Planning', fields: ['Revenue'], limit: 2 }] }]]);
        const record = candidatesOf(found).find((candidate) => candidate.row === 'North division');
        const [history] = await t.round([['lasso_read', { items: [{ h: record.fields.Revenue.h, history: true }] }]]);
        return t.finish(json(history).items[0].versions[1]?.value ?? 'unknown');
      },
    },
    {
      id: 'doc-multi-batch', family: 'docs', features: { multiFact: true },
      prompt: prompts['doc-multi-batch'],
      grade: (answer) => answer === [truth.balance120001, truth.invoice1200, truth.warranty, truth.vendorReview, truth.eastApprovedRevenue, truth.centralPlanningHeadcount].join(' | '),
      direct: async (t) => {
        const [ledger, invoice, warranty, review, east, central] = await t.round([
          ['Grep', { pattern: '^Account 120001,', output_mode: 'content', '-n': true }],
          ['Grep', { pattern: '^INV-2025-01200,', output_mode: 'content', '-n': true }],
          ['Grep', { pattern: 'warranty reserve', path: 'Finance', output_mode: 'content', '-n': true, '-i': true }],
          ['Grep', { pattern: 'vendor review', path: 'Finance', output_mode: 'content', '-n': true, '-i': true }],
          ['Grep', { pattern: '^East division,', path: 'Finance/Approved', output_mode: 'content', '-n': true }],
          ['Grep', { pattern: '^Central division,', path: 'Finance/Planning', output_mode: 'content', '-n': true }],
        ]);
        const tables = [ledger, invoice, east, central].map((output) => grepHits(output)[0]);
        const headers = (await t.round(tables.map((hit) => ['Read', { file_path: hit.file, offset: 1, limit: 1 }]))).map((output) => readLines(output)[0].split(','));
        const value = (index, column) => tables[index].text.split(',')[headers[index].indexOf(column)];
        return t.finish([value(0, 'Balance'), value(1, 'Customer'), warranty.match(/was (\$[\d.]+ million)/)[1],
          review.match(/scheduled for ([A-Z][a-z]+ \d+)/)[1], value(2, 'Revenue'), value(3, 'Headcount')].join(' | '));
      },
      lasso: async (t) => {
        const queries = [
          { text: 'Account 120001', fields: ['Balance'], limit: 2 }, { text: 'INV-2025-01200', fields: ['Customer'], limit: 2 },
          { text: 'warranty reserve year end', kind: 'passage', limit: 2 }, { text: 'vendor review', kind: 'passage', limit: 2 },
          { text: 'East division', folder: 'Finance', under: 'Approved', fields: ['Revenue'], limit: 2 },
          { text: 'Central division', folder: 'Finance', under: 'Planning', fields: ['Headcount'], limit: 2 },
        ];
        const outputs = await t.round(queries.map((query) => ['lasso_search', { queries: [query] }]));
        return t.finish(answerMulti(outputs.map((output) => candidatesOf(output))));
      },
      optimized: async (t) => {
        const queries = [
          { id: 'a', text: 'Account 120001', fields: ['Balance'], limit: 2 }, { id: 'b', text: 'INV-2025-01200', fields: ['Customer'], limit: 2 },
          { id: 'c', text: 'warranty reserve year end', kind: 'passage', limit: 2 }, { id: 'd', text: 'vendor review', kind: 'passage', limit: 2 },
          { id: 'e', text: 'East division', folder: 'Finance', under: 'Approved', fields: ['Revenue'], limit: 2 },
          { id: 'f', text: 'Central division', folder: 'Finance', under: 'Planning', fields: ['Headcount'], limit: 2 },
        ];
        const [output] = await t.round([['lasso_search', { queries }]]);
        return t.finish(answerMulti(json(output).results.map((result) => result.candidates)));
      },
    },
  ];
}

function answerMulti([ledger, invoice, warranty, review, east, central]) {
  const field = (candidates, row, name) => candidates.find((candidate) => candidate.row === row)?.fields[name]?.value;
  return [field(ledger, 'Account 120001', 'Balance'), field(invoice, 'INV-2025-01200', 'Customer'),
    warranty.map((candidate) => candidate.value).join(' ').match(/was (\$[\d.]+ million)/)[1],
    review.map((candidate) => candidate.value).join(' ').match(/scheduled for ([A-Z][a-z]+ \d+)/)[1],
    field(east, 'East division', 'Revenue'), field(central, 'Central division', 'Headcount')].join(' | ');
}

// ── lifecycle measurements ─────────────────────────────────────────────────

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.floor((sorted.length - 1) / 2)] * 10) / 10 : null;
};

function rssOf(pid) {
  return new Promise((resolve) => {
    const child = spawn('ps', ['-o', 'rss=', '-o', '%cpu=', '-p', String(pid)]);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('exit', () => {
      const [rss, cpu] = output.trim().split(/\s+/).map(Number);
      resolve({ rssMb: Math.round(rss / 1024), cpu });
    });
  });
}

async function mcpStartup(dataDir) {
  const started = performance.now();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'mcp', '--data-dir', dataDir, '--scope', '*'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on('line', (line) => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
  const request = (id, method, params) => new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench' } });
  const initializedMs = performance.now() - started;
  await request(2, 'tools/call', { name: 'lasso_read', arguments: { items: [{ file: 'lib/billing.py', folder: 'Shop', lines: '1-5' }] } });
  const firstResultMs = performance.now() - started;
  await request(3, 'tools/call', { name: 'lasso_search', arguments: { queries: [{ text: 'North division', fields: ['Revenue'] }] } });
  const memory = await rssOf(child.pid);
  const closing = performance.now();
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  child.stdin.end();
  const code = await exited;
  return { initializedMs, firstResultMs, exitMs: performance.now() - closing, exitCode: code, rssMb: memory.rssMb };
}

async function restLifecycle(dataDir) {
  const coldStarted = performance.now();
  const first = await connect({ dataDir, scope: ['*'], idleSeconds: 3, client: 'bench' });
  await first.inspect({ items: [{ file: 'lib/billing.py', folder: 'Shop', lines: '1-5' }] });
  const coldFirstResultMs = performance.now() - coldStarted;
  const warmStarted = performance.now();
  const second = await connect({ dataDir, scope: ['*'], idleSeconds: 3, client: 'bench-2' });
  await second.inspect({ items: [{ file: 'lib/billing.py', folder: 'Shop', lines: '1-5' }] });
  const warmFirstResultMs = performance.now() - warmStarted;
  const pid = first.pid;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const idle = await rssOf(pid);
  await first.close();
  await second.close();
  const released = performance.now();
  let stoppedAfterMs = null;
  while (performance.now() - released < 15_000) {
    if (!readDiscovery(dataDir)) { stoppedAfterMs = performance.now() - released; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { coldFirstResultMs, warmFirstResultMs, reusedProcess: second.pid === pid, idleRssMb: idle.rssMb, idleCpuPercent: idle.cpu,
    idleSeconds: 3, stoppedAfterReleaseMs: stoppedAfterMs };
}

// ── run ────────────────────────────────────────────────────────────────────

const routesDirect = (task) => Boolean(task.features.fileKnown && task.features.smallRead);

async function runOnce() {
  const { root, dataDir, app, actor, truth, files, oldBillingRev, routesNow, indexMs } = await prepareLibrary();
  globalThis.corpusRoot = root;
  globalThis.corpusFiles = files;

  const direct = directTools(root);
  const suite = tasks(truth, oldBillingRev, routesNow);
  // The ask policy's answers are in a model's own words, so they are graded as live answers are.
  const graded = graders({ truth, files, routesNow });
  const runs = [];
  const local = { cold: null, warm: null };
  // Each Lasso arm gets its own engine, so one arm's warm caches never speed up another's.
  // The first pass runs on freshly opened engines; the second on the same engines, warm.
  let opened = performance.now();
  const clients = { lasso: openLocal({ dataDir, scope: ['*'], client: 'bench' }) };
  local.cold = performance.now() - opened;
  clients.optimized = openLocal({ dataDir, scope: ['*'], client: 'bench' });
  clients.ask = openLocal({ dataDir, scope: ['*'], client: 'bench' });
  opened = performance.now();
  openLocal({ dataDir, scope: ['*'], client: 'bench' }).close();
  local.warm = performance.now() - opened;
  for (const phase of ['cold', 'warm']) {
    // The model is charged for the compact text an MCP host shows it; the scripted policy reads the same answer as JSON.
    const answer = (operation, value) => ({ forModel: formatAnswer(operation, value), value: JSON.stringify(value) });
    const toolsOf = (client) => ({ lasso_search: (input) => answer('suggest', client.suggest(input)),
      lasso_read: (input) => answer('inspect', client.inspect(input)), lasso_cite: (input) => answer('bind', client.bind(input)) });
    const legacyTool = { lasso_find: async ({ command }) => app.workspace.terminalRun(command, actor) };
    const askTool = { lasso: (input) => answer('ask', clients.ask.ask(input)) };
    for (const task of suite) {
      const arms = {
        direct: [task.direct, { ...direct }, DIRECT_DEFINITIONS],
        legacy: [task.legacy ?? task.direct, { ...direct, ...legacyTool }, [...DIRECT_DEFINITIONS, LEGACY_DEFINITION]],
        lasso: [task.lasso, { ...direct, ...toolsOf(clients.lasso) }, [...DIRECT_DEFINITIONS, ...LASSO_DEFINITIONS]],
        optimized: [task.optimized ?? task.lasso, { ...direct, ...toolsOf(clients.optimized) }, [...DIRECT_DEFINITIONS, ...LASSO_DEFINITIONS]],
        ...(task.ablation ? { 'optimized+bind': [task.ablation, { ...direct, ...toolsOf(clients.optimized) }, [...DIRECT_DEFINITIONS, ...LASSO_DEFINITIONS_WITH_CITE]] } : {}),
        // A short read of a file the request names goes to direct tools; the rest to Lasso.
        // Lasso's definitions are still sent on those tasks: a connected server's tools are.
        routed: [routesDirect(task) ? task.direct : task.optimized ?? task.lasso, { ...direct, ...toolsOf(clients.optimized) }, [...DIRECT_DEFINITIONS, ...LASSO_DEFINITIONS]],
        // The same, if the host loaded Lasso's definitions only when a task used them (the loading call itself is not counted).
        'routed-deferred': [routesDirect(task) ? task.direct : task.optimized ?? task.lasso, { ...direct, ...toolsOf(clients.optimized) },
          routesDirect(task) ? DIRECT_DEFINITIONS : [...DIRECT_DEFINITIONS, ...LASSO_DEFINITIONS]],
        // v4: every task through one plain-language lasso call.
        ask: [askPolicy, { ...direct, ...askTool }, [...DIRECT_DEFINITIONS, ...ASK_DEFINITIONS], { ...task, grade: graded[task.id] }],
      };
      for (const [arm, [policy, tools, definitionsOf, asTask = task]] of Object.entries(arms)) {
        // Direct and legacy arms do not depend on the Lasso engine's warmth.
        if (phase === 'warm' && ['direct', 'legacy'].includes(arm)) continue;
        if (phase === 'cold' && ['optimized+bind', 'routed', 'routed-deferred'].includes(arm)) continue;
        let outcome;
        try {
          outcome = await policy(new Trajectory({ arm, task: asTask, tools, definitions: definitionsOf }));
        } catch (error) {
          outcome = { task: task.id, family: task.family, arm, capability: Boolean(task.capability), correct: false, failed: error.message,
            tokens: null, rounds: null, calls: null };
        }
        runs.push({ ...outcome, phase: ['direct', 'legacy'].includes(arm) ? 'n/a' : phase,
          sameAsDirect: arm === 'legacy' && !task.legacy, ...(arm.startsWith('routed') ? { routedTo: routesDirect(task) ? 'direct' : 'lasso' } : {}) });
      }
    }
  }
  await clients.lasso.close();
  await clients.optimized.close();
  await clients.ask.close();


  const lifecycle = { indexMs: Math.round(indexMs), engineOpenColdMs: Math.round(local.cold * 10) / 10, engineOpenWarmMs: Math.round(local.warm * 10) / 10 };
  const mcpRuns = [];
  for (let index = 0; index < 5; index += 1) mcpRuns.push(await mcpStartup(dataDir));
  lifecycle.mcp = { runs: mcpRuns.length, initializedMs: median(mcpRuns.map((run) => run.initializedMs)),
    firstResultMs: median(mcpRuns.map((run) => run.firstResultMs)), exitAfterDisconnectMs: median(mcpRuns.map((run) => run.exitMs)),
    exitCodes: [...new Set(mcpRuns.map((run) => run.exitCode))], rssMb: median(mcpRuns.map((run) => run.rssMb)) };
  lifecycle.rest = await restLifecycle(dataDir);
  const discovered = readDiscovery(dataDir);
  if (discovered) try { process.kill(discovered.pid); } catch { /* gone */ }

  await app.close();
  if (!KEEP) fs.rmSync(root, { recursive: true, force: true });
  else console.error(`Corpus kept at ${root}`);
  return summarize(runs, lifecycle, suite);
}

async function main() {
  const repeats = [];
  for (let index = 0; index < RUNS; index += 1) repeats.push(await runOnce());
  const results = repeats.at(-1);
  results.repeats = Object.fromEntries(Object.keys(results.savings).map((arm) => {
    const spread = (key) => {
      const values = repeats.map((run) => run.savings[arm][key]);
      return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
    };
    return [arm, { runs: RUNS, S: spread('S'), conservativeS: spread('conservativeS'), evidenceS: spread('evidenceS'),
      correct: repeats.map((run) => `${run.totals[arm].correct}/${run.totals[arm].tasks}`) }];
  }));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'benchmark-results.json'), `${JSON.stringify(results, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, 'benchmark-results.md'), report(results));
  console.log(report(results));
}

function summarize(runs, lifecycle, suite) {
  const warm = runs.filter((run) => run.phase !== 'cold');
  const of = (arm, filter = () => true) => warm.filter((run) => run.arm === arm && filter(run));
  const comparable = (run) => !run.capability;
  const arms = ['direct', 'legacy', 'lasso', 'optimized', 'routed', 'routed-deferred', 'ask'];
  const totals = Object.fromEntries(arms.map((arm) => {
    const rows = of(arm, comparable);
    const sum = (key) => rows.reduce((total, run) => total + (run[key] ?? 0), 0);
    return [arm, { tasks: rows.length, correct: rows.filter((run) => run.correct).length, tokens: sum('tokens'), conservativeTokens: sum('conservativeTokens'),
      evidence: sum('evidence'), conservativeEvidence: sum('conservativeEvidence'), definitionOverhead: sum('definitionOverhead'),
      rounds: sum('rounds'), calls: sum('calls'), costUsd: Math.round(sum('costUsd') * 10000) / 10000,
      cachedCostUsd: Math.round(sum('cachedCostUsd') * 10000) / 10000, localMs: Math.round(sum('localMs')) }];
  }));
  const savings = Object.fromEntries(arms.filter((arm) => arm !== 'direct').map((arm) => {
    const paired = suite.filter((task) => !task.capability).map((task) => [of('direct').find((run) => run.task === task.id), of(arm).find((run) => run.task === task.id)]);
    const ratios = paired.map(([base, lasso]) => lasso.tokens / base.tokens);
    const families = Object.fromEntries(['code', 'docs'].map((family) => {
      const pairs = paired.filter(([base]) => base.family === family);
      return [family, Math.round((1 - pairs.reduce((sum, [, lasso]) => sum + lasso.tokens, 0) / pairs.reduce((sum, [base]) => sum + base.tokens, 0)) * 1000) / 10];
    }));
    return [arm, { S: Math.round((1 - totals[arm].tokens / totals.direct.tokens) * 1000) / 10,
      conservativeS: Math.round((1 - totals[arm].conservativeTokens / totals.direct.conservativeTokens) * 1000) / 10,
      evidenceS: Math.round((1 - totals[arm].evidence / totals.direct.evidence) * 1000) / 10, families,
      perTaskRatio: { min: Math.round(Math.min(...ratios) * 100) / 100, median: Math.round(median(ratios) * 100) / 100, max: Math.round(Math.max(...ratios) * 100) / 100 },
      regressions: paired.filter(([base, lasso]) => lasso.tokens > base.tokens).map(([base, lasso]) => ({ task: base.task, direct: base.tokens, arm: lasso.tokens })) }];
  }));
  const coldWarm = ['lasso', 'optimized', 'ask'].map((arm) => ({ arm,
    coldLocalMs: Math.round(runs.filter((run) => run.arm === arm && run.phase === 'cold').reduce((sum, run) => sum + (run.localMs ?? 0), 0)),
    warmLocalMs: Math.round(runs.filter((run) => run.arm === arm && run.phase === 'warm').reduce((sum, run) => sum + (run.localMs ?? 0), 0)) }));
  return { generatedAt: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}`,
    constants: { SYSTEM_TOKENS, CALL_OVERHEAD, RESULT_OVERHEAD, measuredDefinitions: MEASURED, toolDefinitionTokens: {
      direct: estimateTokens(JSON.stringify(DIRECT_DEFINITIONS)), lasso: estimateTokens(JSON.stringify(LASSO_DEFINITIONS)),
      ask: estimateTokens(JSON.stringify(ASK_DEFINITIONS)),
      legacy: estimateTokens(JSON.stringify(LEGACY_DEFINITION)) }, price: PRICE },
    totals, savings, coldWarm, lifecycle,
    ablation: runs.filter((run) => run.arm === 'optimized+bind' || (run.task === 'doc-related-facts' && ['direct', 'optimized'].includes(run.arm) && run.phase !== 'cold'))
      .map(({ task, arm, correct, tokens, rounds, calls }) => ({ task, arm, correct, tokens, rounds, calls })),
    capability: runs.filter((run) => run.capability && run.phase !== 'cold' && ['direct', 'optimized', 'ask'].includes(run.arm))
      .map(({ task, arm, correct, tokens }) => ({ task, arm, correct, tokens })),
    runs: warm.map(({ answer, ...run }) => ({ ...run, answer: typeof answer === 'string' && answer.length > 160 ? `${answer.slice(0, 157)}…` : answer })) };
}

function report(results) {
  const lines = [];
  const pct = (value) => `${value > 0 ? '' : ''}${value}%`;
  lines.push('# Lasso agent benchmark: results', '');
  lines.push(`Generated ${results.generatedAt} on ${results.platform}, Node ${results.node}. Produced by \`node scripts/agent-benchmark.mjs\`; the numbers below are this run's.`, '');
  lines.push('**Token figures are estimates** (tokenizer-free estimator, same for every arm) of complete-task model input and output under scripted, competent policies. They are not provider-recorded usage, reasoning tokens are not modelled, and a live model may take different steps.', '');
  lines.push('Arms: `lasso` and `optimized` are v3\'s scripted search-then-read policies (search and read tools); `routed` sends short reads of a named file to direct tools; `ask` is v4, one `lasso` call per task with the request as written, answered from what came back by one rule for every task and graded as live answers are (the known values present; a question when the files leave the choice open).', '');
  lines.push('## Complete-task totals (tasks with a direct-tools equivalent)', '');
  lines.push('| Arm | Correct | Est. tokens T | of which tool definitions | Evidence tokens | T, conservative estimate | Rounds J | Tool calls | Est. cost (no cache) | Est. cost (prefix cache) | Local tool time |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [arm, total] of Object.entries(results.totals)) {
    const n = (value) => value.toLocaleString('en-US');
    lines.push(`| ${arm} | ${total.correct}/${total.tasks} | ${n(total.tokens)} | ${n(total.definitionOverhead)} | ${n(total.evidence)} | ${n(total.conservativeTokens)} | ${total.rounds} | ${total.calls} | $${total.costUsd.toFixed(4)} | $${total.cachedCostUsd.toFixed(4)} | ${total.localMs} ms |`);
  }
  lines.push('', '## Aggregate savings S = 1 − ΣT_L / ΣT_0 against direct tools', '');
  lines.push('Negative S means the arm used more tokens than direct tools.', '');
  lines.push('| Arm | S (all) | S, conservative estimate | S (code) | S (docs) | Evidence-only saving | Per-task T_L/T_0 min / median / max | Tasks with more tokens than direct |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const [arm, saving] of Object.entries(results.savings)) {
    lines.push(`| ${arm} | ${pct(saving.S)} | ${pct(saving.conservativeS)} | ${pct(saving.families.code)} | ${pct(saving.families.docs)} | ${pct(saving.evidenceS)} | ${saving.perTaskRatio.min} / ${saving.perTaskRatio.median} / ${saving.perTaskRatio.max} | ${saving.regressions.length} of ${results.totals[arm].tasks} |`);
  }
  if (results.repeats) {
    lines.push('', `## Spread over ${Object.values(results.repeats)[0].runs} runs`, '');
    lines.push('Folder ids are random, so ranking ties and handle strings differ between runs. The tables above and below are the last run.', '');
    lines.push('| Arm | S median (min…max) | S conservative median (min…max) | Evidence-only median (min…max) | Correct per run |', '|---|---|---|---|---|');
    for (const [arm, spread] of Object.entries(results.repeats)) {
      const show = (value) => `${value.median}% (${value.min}…${value.max})`;
      lines.push(`| ${arm} | ${show(spread.S)} | ${show(spread.conservativeS)} | ${show(spread.evidenceS)} | ${spread.correct.join(', ')} |`);
    }
  }
  lines.push('', '## Per task (warm engine)', '');
  lines.push('| Task | Family | Arm | Correct | Est. tokens | Evidence | Rounds | Calls | Local ms |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const run of results.runs.filter((item) => !item.arm.startsWith('routed') && item.arm !== 'optimized+bind')) {
    lines.push(`| ${run.task}${run.capability ? ' *' : ''} | ${run.family} | ${run.arm}${run.sameAsDirect ? ' (=direct)' : ''} | ${run.correct ? 'yes' : `**no**${run.failed ? ` (${run.failed})` : ''}`} | ${run.tokens ?? '–'} | ${run.evidence ?? '–'} | ${run.rounds ?? '–'} | ${run.calls ?? '–'} | ${run.localMs ?? '–'} |`);
  }
  lines.push('', '\\* capability task: needs history the direct tools cannot reach, so it is left out of the savings and reported as a capability difference.', '');
  lines.push('## Ablation: deterministic insertion (bind)', '');
  lines.push('| Task | Arm | Correct | Est. tokens | Rounds | Calls |', '|---|---|---|---|---|---|');
  for (const row of results.ablation) lines.push(`| ${row.task} | ${row.arm} | ${row.correct ? 'yes' : 'no'} | ${row.tokens} | ${row.rounds} | ${row.calls} |`);
  lines.push('');
  lines.push('## Routing', '');
  lines.push('The routed arms send a short read of a file the request already names to direct tools and everything else to Lasso (optimized). "routed" still carries Lasso\'s definitions on direct tasks, as a connected server does; "routed-deferred" assumes a host that loads them only when used, and does not count the loading call, so it is a lower bound. Tasks sent to direct tools:', '');
  lines.push(results.runs.filter((run) => run.arm === 'routed' && run.routedTo === 'direct').map((run) => `- ${run.task}`).join('\n'), '');
  lines.push('## Startup, shutdown and idle cost', '');
  const { lifecycle } = results;
  lines.push(`- Indexing the corpus in the app (one time, not per agent call): ${lifecycle.indexMs} ms.`);
  lines.push(`- In-process engine open: cold ${lifecycle.engineOpenColdMs} ms, warm ${lifecycle.engineOpenWarmMs} ms.`);
  lines.push(`- MCP over stdio (median of ${lifecycle.mcp.runs} launches): initialize answered ${lifecycle.mcp.initializedMs} ms after spawn; first tool result ${lifecycle.mcp.firstResultMs} ms after spawn; process exited ${lifecycle.mcp.exitAfterDisconnectMs} ms after the host closed stdin (exit codes ${lifecycle.mcp.exitCodes.join(', ')}); RSS ${lifecycle.mcp.rssMb} MB.`);
  lines.push(`- REST, started on demand: first result ${Math.round(lifecycle.rest.coldFirstResultMs)} ms cold (spawn + open + call), ${Math.round(lifecycle.rest.warmFirstResultMs)} ms for a second client reusing it (same process: ${lifecycle.rest.reusedProcess}); idle RSS ${lifecycle.rest.idleRssMb} MB at ${lifecycle.rest.idleCpuPercent}% CPU; stopped ${lifecycle.rest.stoppedAfterReleaseMs == null ? 'not within 15 s' : `${Math.round(lifecycle.rest.stoppedAfterReleaseMs)} ms`} after both leases were released (idle time ${lifecycle.rest.idleSeconds} s).`);
  lines.push('', '## Cold versus warm Lasso engine (sum of local tool time over the suite)', '');
  lines.push('Cold: the first pass, on engines opened for it. Warm: the same tasks again on the same engines. The routed arms run on the optimized arm\'s engine after it, so their local time is warm.', '');
  for (const row of results.coldWarm) lines.push(`- ${row.arm}: cold ${row.coldLocalMs} ms, warm ${row.warmLocalMs} ms.`);
  lines.push('', '## Constants', '');
  if (results.constants.measuredDefinitions) {
    const measured = results.constants.measuredDefinitions;
    lines.push(measured.lassoV3 != null
      ? `Tool definitions are charged as a provider counted them (docs/agent/token-probe.json, gpt-5.4-mini): direct ${measured.direct}, Lasso search and read (v3) +${measured.lassoV3}, the lasso tool (v4) +${measured.lassoCurrent} per call. The terminal-find arm is still estimated.`
      : `Tool definitions are charged as a provider counted them (docs/agent/token-probe.json, gpt-5.4-mini): direct ${measured.direct}, Lasso +${measured.lassoCurrent} per call. The terminal-find arm is still estimated.`, '');
  }
  lines.push(`System prompt ${results.constants.SYSTEM_TOKENS} tokens per invocation; ${results.constants.CALL_OVERHEAD} tokens per tool call and ${results.constants.RESULT_OVERHEAD} per tool result of framing; estimated tool definitions: direct ${results.constants.toolDefinitionTokens.direct}, Lasso search and read ${results.constants.toolDefinitionTokens.lasso}, the lasso tool ${results.constants.toolDefinitionTokens.ask} (each added to the direct tools, never replacing them), terminal find ${results.constants.toolDefinitionTokens.legacy}. Prices: Claude Opus 5.5 list ($${results.constants.price.input}/$${results.constants.price.output} per M input/output, cache reads $${results.constants.price.cacheRead}).`, '');
  return `${lines.join('\n')}\n`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
