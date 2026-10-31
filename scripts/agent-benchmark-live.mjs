// Live agent benchmark: a real model (OpenAI's, or Claude through Anthropic's SDK) does tasks through its provider's API,
// on generated libraries, in arms that differ only in how it reaches the files:
//   direct          ordinary file tools (Read, Grep, Glob); for documents, Read and Grep see a PDF's,
//                   Word file's or workbook's text, as an agent with a converter does
//   lasso           those tools plus the current MCP server's lasso tool and instructions; the model chooses
//   upload          no tools: the request comes with the files that answer it attached, as a chat upload does
//   lasso-v1 … v4   earlier definitions (scripts/agent-tools-versions.mjs), lookup tasks only; they reach
//                   the current server, so they compare definitions, not the old resolvers
// Task families (scripts/agent-live/families.mjs): lookup, documents (the evaluation sets of
// scripts/agent-eval, graded by gradeAnswer), writing and geometry (STEP assemblies).
// Token counts are the provider's own usage records for every model call; the mock provider's are estimates.
//
//   OPENAI_API_KEY=… ANTHROPIC_API_KEY=… node scripts/agent-benchmark-live.mjs --model gpt-5.4-mini --model claude-sonnet-5-5
//     [--families lookup,documents,writing,geometry] [--sets heldout,heldout2] [--arms direct,lasso,upload]
//     [--runs 1] [--effort low] [--budget 4] [--task-budget 0.2] [--tasks id,id] [--label name] [--out docs/agent]
//   node scripts/agent-benchmark-live.mjs --model mock --families all      # a dry run: no API call, nothing spent
//   node scripts/agent-benchmark-live.mjs --regrade docs/agent/live-results-….json
//
// The model chooses its own steps; nothing is scripted. A guard stops before a call could take the run's
// spend past --budget dollars; --task-budget ends one task's conversation once it has cost that much (recorded
// as stopped at the cap, and wrong). Results are written after each task.

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { openLocal } from '../src/agent/client.js';
import { INSTRUCTIONS as LASSO_INSTRUCTIONS, toolsNamed } from '../src/agent/mcp.js';
import { formatAnswer } from '../src/agent/render.js';
import { estimateTokens } from '../src/agent/metrics.js';
import { INSTRUCTIONS_V1, INSTRUCTIONS_V2, INSTRUCTIONS_V3, INSTRUCTIONS_V4, TOOLS_V1, TOOLS_V2, TOOLS_V3, TOOLS_V4 } from './agent-tools-versions.mjs';
import { costOf, providerFor, worstCost } from './agent-live/providers.mjs';
import { DEFAULT_ARMS, FAMILIES } from './agent-live/families.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const MODELS = args.flatMap((value, index) => (args[index - 1] === '--model' ? [value] : []));
const RUNS = Number(option('--runs', 1));
const EFFORT = option('--effort', 'low');
const BUDGET = Number(option('--budget', 4));
const TASK_BUDGET = option('--task-budget', null) == null ? Infinity : Number(option('--task-budget'));
const ONLY = option('--tasks', null)?.split(',');
const LABEL = option('--label', null);
const FAMILY_NAMES = (() => {
  const asked = option('--families', 'lookup');
  return asked === 'all' ? Object.keys(FAMILIES) : asked.split(',');
})();
const SET_NAMES = option('--sets', 'heldout,heldout2').split(',');
const ASKED_ARMS = option('--arms', null)?.split(',');
// Regrade a saved results file with the current graders, calling no model.
const REGRADE = option('--regrade', null);
const OUT = path.resolve(ROOT, option('--out', 'docs/agent'));
const keyFile = (name) => (option(name, null) ? fs.readFileSync(option(name), 'utf8').trim() : undefined);
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? keyFile('--key-file');
// Without one, the SDK finds the person's own Anthropic credentials (ANTHROPIC_API_KEY, an `ant auth login` profile).
const ANTHROPIC_KEY = keyFile('--anthropic-key-file');
const MAX_TURNS = 14;
const MAX_OUTPUT_TOKENS = 6000;
// A coding agent's harness also caps what one tool result can put in context.
const MAX_TOOL_CHARS = 60_000;
// What a result row keeps of the tool output the model saw, to regrade numbers against it later.
const KEPT_EVIDENCE_CHARS = 40_000;

const instructionsFor = (folders) => [
  `You are an agent answering questions about the files in a workspace. Its top-level folders are ${folders.join(', ')}; tool paths are relative to the workspace root.`,
  'Use the tools to find and read what you need. Quote values and code exactly as the files have them; when asked for lines, reproduce them exactly, without line numbers.',
  'If several sources could be meant and the request does not say which, list them and ask which one is meant instead of choosing. If what was asked for does not exist, say so.',
  'End your reply with a line that starts with "ANSWER:" followed by the answer.',
].join(' ');
const UPLOAD_INSTRUCTIONS = [
  'You are an assistant answering questions about files the user attached to their message. Answer from the attached files.',
  'Quote values exactly as the files have them. If the files leave the choice between sources open, say so instead of choosing. If what was asked for is not in them, say so.',
  'End your reply with a line that starts with "ANSWER:" followed by the answer.',
].join(' ');
// What a person who set Lasso up for their agent might add to its instructions.
const PREFER_LASSO = 'Prefer the lasso_ tools for finding and reading evidence; use the file tools only when Lasso cannot answer.';
const HISTORICAL_ARMS = ['lasso-v1', 'lasso-v2', 'lasso-v2-first', 'lasso-v3', 'lasso-v4'];

const definitionsOf = (tools) => tools.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema }));
const LASSO_DEFINITIONS = definitionsOf(toolsNamed());
const isLasso = (name) => name === 'lasso' || name.startsWith('lasso_');

class BudgetExceeded extends Error {}

class Spend {
  constructor(limit) { this.limit = limit; this.spent = 0; }
  /** Refuses a call that could, at its worst, take the run past the limit. */
  check(provider, expectedInput) {
    const worst = worstCost(provider.model, expectedInput, provider.maxOutput);
    if (this.spent + worst > this.limit) throw new BudgetExceeded(`stopping: $${this.spent.toFixed(3)} spent, a further call could pass $${this.limit}`);
  }
}

// ── one task in one arm ────────────────────────────────────────────────────

async function runTask({ provider, arm, task, prompt, tools, execute, instructions, spend }) {
  const calls = [];
  const toolCalls = {};
  // Every tool call's arguments and whether it failed, to see how the model used each tool.
  const trace = [];
  const evidence = [];
  let toolMs = 0;
  let final = '';
  let stop = 'turns';
  const started = performance.now();
  const conversation = provider.start({ instructions, tools, prompt });
  let results = [];
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    if (calls.reduce((total, call) => total + call.cost, 0) >= TASK_BUDGET) { stop = 'cost-cap'; break; }
    spend.check(provider, calls.at(-1)?.input ?? estimateTokens(`${instructions}${JSON.stringify(tools)}${prompt}`));
    const reply = await conversation.next(results);
    const cost = costOf(provider.model, reply.usage);
    spend.spent += cost;
    calls.push({ ...reply.usage, cost });
    if (!reply.calls.length) {
      final = reply.text;
      stop = reply.refused ? 'refused' : reply.incomplete ? 'incomplete' : 'answered';
      break;
    }
    results = [];
    for (const call of reply.calls) {
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
      const failed = /^\{"error"|^Error|^File does not exist|^Invalid regular/.test(output) || /"error":\{"code"/.test(output.slice(0, 2000));
      trace.push({ turn, name: call.name, args: (call.arguments ?? '').slice(0, 400), error: failed });
      evidence.push(output);
      results.push({ id: call.id, output, error: failed });
    }
  }
  const sum = (key) => calls.reduce((total, call) => total + (call[key] ?? 0), 0);
  return { model: provider.model, estimated: provider.estimated, arm, task: task.id, kind: task.kind, capability: task.capability, stop, final,
    evidence: evidence.join('\n').slice(0, KEPT_EVIDENCE_CHARS),
    modelCalls: calls.length, toolCalls: Object.values(toolCalls).reduce((total, count) => total + count, 0), toolsUsed: toolCalls,
    usedLasso: Object.keys(toolCalls).some(isLasso), trace,
    input: sum('input'), cached: sum('cached'), written: sum('written'), output: sum('output'), reasoning: sum('reasoning'), tokens: sum('input') + sum('output'),
    firstInput: calls[0]?.input ?? null, costUsd: sum('cost'), wallMs: Math.round(performance.now() - started), toolMs: Math.round(toolMs) };
}

/** The arms a workspace is run in: what each gives the model and how its tool calls are answered. */
function armsFor(workspace, lasso) {
  const instructions = instructionsFor(workspace.folders);
  const direct = workspace.tools;
  const ask = (input) => formatAnswer('ask', lasso.ask(input));
  // Earlier definitions reach the current server: v1 answered in JSON, v2 and v3 in compact text.
  const v1Tools = { lasso_suggest: (input) => lasso.suggest(input), lasso_inspect: (input) => lasso.inspect(input), lasso_bind: (input) => lasso.bind(input) };
  const v2Tools = { lasso_search: (input) => formatAnswer('suggest', lasso.suggest(input)),
    lasso_read: (input) => formatAnswer('inspect', lasso.inspect(input)), lasso_cite: (input) => formatAnswer('bind', lasso.bind(input)) };
  const arms = {
    direct: { tools: workspace.definitions, instructions, execute: (name, input) => direct[name](input) },
    lasso: { tools: [...workspace.definitions, ...LASSO_DEFINITIONS], instructions: `${instructions}\n\n${LASSO_INSTRUCTIONS}`,
      execute: (name, input) => (name === 'lasso' ? ask(input) : direct[name](input)) },
    upload: { tools: [], instructions: UPLOAD_INSTRUCTIONS, execute: () => 'Error: no tools in this conversation.' },
  };
  if (workspace.name === 'lookup') {
    Object.assign(arms, {
      'lasso-v1': { tools: [...workspace.definitions, ...definitionsOf(TOOLS_V1)], instructions: `${instructions}\n\n${INSTRUCTIONS_V1}`,
        execute: (name, input) => (v1Tools[name] ?? direct[name])(input) },
      'lasso-v2': { tools: [...workspace.definitions, ...definitionsOf(TOOLS_V2)], instructions: `${instructions}\n\n${INSTRUCTIONS_V2}`,
        execute: (name, input) => (v2Tools[name] ?? direct[name])(input) },
      'lasso-v2-first': { tools: [...workspace.definitions, ...definitionsOf(TOOLS_V2)], instructions: `${instructions}\n\n${INSTRUCTIONS_V2} ${PREFER_LASSO}`,
        execute: (name, input) => (v2Tools[name] ?? direct[name])(input) },
      'lasso-v3': { tools: [...workspace.definitions, ...definitionsOf(TOOLS_V3)], instructions: `${instructions}\n\n${INSTRUCTIONS_V3}`,
        execute: (name, input) => (v2Tools[name] ?? direct[name])(input) },
      'lasso-v4': { tools: [...workspace.definitions, ...definitionsOf(TOOLS_V4)], instructions: `${instructions}\n\n${INSTRUCTIONS_V4}`,
        execute: (name, input) => (name === 'lasso' ? ask(input) : direct[name](input)) },
    });
  }
  return arms;
}

const familyOf = (workspace) => workspace.name.split('/')[0];
function armNames(workspace) {
  const available = [...DEFAULT_ARMS[familyOf(workspace)], ...(workspace.name === 'lookup' ? HISTORICAL_ARMS : [])];
  const chosen = ASKED_ARMS ? ASKED_ARMS.filter((name) => available.includes(name)) : DEFAULT_ARMS[familyOf(workspace)];
  // Direct tools are in every comparison.
  return chosen.includes('direct') ? chosen : ['direct', ...chosen];
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

/** One arm against a baseline arm, over the tasks both did in the same run. */
function compare(rows, armName, baseName) {
  const pairs = [];
  for (const row of rows.filter((item) => item.arm === baseName && !item.capability && !item.skipped)) {
    const other = rows.find((item) => item.arm === armName && item.task === row.task && item.run === row.run && !item.skipped);
    if (other) pairs.push([row, other]);
  }
  const total = (index, key) => pairs.reduce((sum, pair) => sum + (pair[index][key] ?? 0), 0);
  const arm = (index) => ({ tasks: pairs.length, correct: pairs.filter((pair) => pair[index].correct).length,
    tokens: total(index, 'tokens'), input: total(index, 'input'), cached: total(index, 'cached'), written: total(index, 'written'), output: total(index, 'output'),
    reasoning: total(index, 'reasoning'), modelCalls: total(index, 'modelCalls'), toolCalls: total(index, 'toolCalls'),
    costUsd: Math.round(total(index, 'costUsd') * 10000) / 10000, wallSeconds: Math.round(total(index, 'wallMs') / 100) / 10 });
  const ratios = pairs.map(([base, other]) => other.tokens / Math.max(1, base.tokens)).sort((a, b) => a - b);
  const armRows = rows.filter((row) => row.arm === armName && !row.capability && !row.skipped);
  return {
    base: arm(0), arm: arm(1),
    S: pairs.length ? Math.round((1 - total(1, 'tokens') / Math.max(1, total(0, 'tokens'))) * 1000) / 10 : null,
    perTaskRatio: ratios.length ? { min: Math.round(ratios[0] * 100) / 100, median: Math.round(ratios[Math.floor((ratios.length - 1) / 2)] * 100) / 100,
      max: Math.round(ratios.at(-1) * 100) / 100 } : null,
    moreTokens: pairs.filter(([base, other]) => other.tokens > base.tokens).length,
    lassoUse: { tasksUsingLasso: armRows.filter((row) => row.usedLasso).length, tasks: armRows.length,
      // Tasks that also needed the file tools: the fallback rate f of E[T_L] = c + f·B_f.
      fellBack: armRows.filter((row) => row.usedLasso && Object.keys(row.toolsUsed).some((name) => !isLasso(name))).length },
  };
}

function summarize(results, spent, options) {
  const groups = {};
  for (const row of results.filter((item) => !item.error)) {
    const key = `${row.model} · ${row.workspace}`;
    (groups[key] ??= { model: row.model, workspace: row.workspace, estimated: row.estimated, rows: [] }).rows.push(row);
  }
  const comparisons = Object.fromEntries(Object.entries(groups).map(([key, group]) => {
    const arms = [...new Set(group.rows.map((row) => row.arm))];
    const against = (base) => Object.fromEntries(arms.filter((name) => name !== base).map((name) => [name, compare(group.rows, name, base)]));
    return [key, { model: group.model, workspace: group.workspace, estimated: group.estimated,
      vsDirect: against('direct'), ...(arms.includes('upload') ? { vsUpload: against('upload') } : {}) }];
  }));
  return { generatedAt: new Date().toISOString(), options, spentUsd: Math.round(spent * 10000) / 10000,
    estimatedDefinitionTokens: { lasso: estimateTokens(JSON.stringify(LASSO_DEFINITIONS)) + estimateTokens(LASSO_INSTRUCTIONS) },
    comparisons,
    // Answers and what the model saw are kept, so a grader can be checked or rerun without calling the model again.
    results: results.map(({ final, ...row }) => ({ ...row, answer: final })) };
}

// What people call the kinds of file a task's answer is in.
const KIND_OF = { step: '3D model', stp: '3D model', ifc: '3D model', xlsx: 'Excel', csv: 'Excel', pdf: 'PDF', docx: 'Word', md: 'notes' };
function fileKind(types) {
  const kinds = [...new Set((types ?? []).map((type) => KIND_OF[type] ?? type))];
  return kinds.length === 1 ? kinds[0] : kinds.length ? `mixed (${kinds.join(' + ')})` : null;
}

/** Per model and kind of file: each arm's correct answers and tokens, and Lasso's saving against direct tools and against uploading. */
function byFileKind(results) {
  const rows = results.filter((row) => !row.error && !row.capability && fileKind(row.types));
  const lines = [];
  for (const model of [...new Set(rows.map((row) => row.model))]) {
    const ofModel = rows.filter((row) => row.model === model);
    for (const kind of [...new Set(ofModel.map((row) => fileKind(row.types)))].sort()) {
      const tasks = [...new Set(ofModel.filter((row) => fileKind(row.types) === kind).map((row) => `${row.run}|${row.task}`))];
      const find = (key, arm) => ofModel.find((row) => `${row.run}|${row.task}` === key && row.arm === arm && !row.skipped);
      const pair = (arm, base) => {
        const pairs = tasks.map((key) => [find(key, base), find(key, arm)]).filter(([left, right]) => left && right);
        const sum = (index) => pairs.reduce((total, entry) => total + entry[index].tokens, 0);
        return { pairs: pairs.length, base: sum(0), arm: sum(1), S: pairs.length ? Math.round((1 - sum(1) / Math.max(1, sum(0))) * 1000) / 10 : null };
      };
      const arm = (name) => {
        const ran = tasks.map((key) => find(key, name)).filter(Boolean);
        return ran.length ? `${ran.filter((row) => row.correct).length}/${ran.length}, ${ran.reduce((total, row) => total + row.tokens, 0).toLocaleString('en-US')}` : '–';
      };
      const direct = pair('lasso', 'direct');
      const upload = pair('lasso', 'upload');
      lines.push(`| ${model} | ${kind} | ${tasks.length} | ${arm('direct')} | ${arm('lasso')} | ${arm('upload')} | ${direct.S ?? '–'}${direct.S == null ? '' : '%'} | ${upload.S ?? '–'}${upload.S == null ? '' : '%'} |`);
    }
  }
  return lines.length ? ['## By kind of file', '', 'Tasks grouped by the files their answer is in. Each arm: correct answers, then tokens. Savings are 1 − ΣT_lasso / ΣT_other over the tasks both arms ran.', '',
    '| Model | Kind of file | Tasks | direct | lasso | upload | Lasso vs direct | Lasso vs upload |', '|---|---|---|---|---|---|---|---|', ...lines, ''] : [];
}

function report(summary) {
  const n = (value) => value.toLocaleString('en-US');
  const lines = ['# Lasso agent benchmark: live model runs', ''];
  const { options } = summary;
  lines.push(`Generated ${summary.generatedAt} by \`node scripts/agent-benchmark-live.mjs\`. Models ${options.models.join(', ')}; families ${options.families.join(', ')}${options.families.includes('documents') ? ` (sets ${options.sets.join(', ')})` : ''}; reasoning effort ${options.effort}; ${options.runs} run(s); spent $${summary.spentUsd.toFixed(3)} of a $${options.budget} limit.`, '');
  const estimated = Object.values(summary.comparisons).some((group) => group.estimated);
  lines.push(estimated
    ? '**These rows come from the mock provider: a scripted model, with token counts estimated, not recorded by a provider. They check the harness, not Lasso or a model.**'
    : '**Token counts are the provider\'s usage records** for every model call: input counts everything sent each call (instructions, tool definitions, the conversation so far), whether read at full price, from cache or written to it; output includes reasoning. Claude runs use automatic prompt caching, as hosts do; OpenAI caches by itself. The model chose its own steps.', '');
  for (const group of Object.values(summary.comparisons)) {
    lines.push(`## ${group.model}: ${group.workspace}`, '');
    lines.push('| Arm | Correct | Tokens | Input | of which read from cache | of which written to cache | Output | of which reasoning | Model calls | Tool calls | Cost | Wall time |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
    const line = (name, row) => `| ${name} | ${row.correct}/${row.tasks} | ${n(row.tokens)} | ${n(row.input)} | ${n(row.cached)} | ${n(row.written)} | ${n(row.output)} | ${n(row.reasoning)} | ${row.modelCalls} | ${row.toolCalls} | $${row.costUsd.toFixed(4)} | ${row.wallSeconds} s |`;
    const first = Object.values(group.vsDirect)[0];
    if (first) lines.push(line('direct', first.base));
    for (const [name, comparison] of Object.entries(group.vsDirect)) lines.push(line(name, comparison.arm));
    lines.push('');
    for (const [name, comparison] of Object.entries(group.vsDirect)) {
      lines.push(`- **${name}** vs direct tools: S = 1 − ΣT/ΣT_direct over ${comparison.base.tasks} paired tasks = **${comparison.S}%**; per-task ratio min ${comparison.perTaskRatio?.min}, median ${comparison.perTaskRatio?.median}, max ${comparison.perTaskRatio?.max}; more tokens on ${comparison.moreTokens} of ${comparison.base.tasks}.${name.startsWith('lasso') ? ` Used Lasso on ${comparison.lassoUse.tasksUsingLasso} of ${comparison.lassoUse.tasks} tasks, also needing file tools on ${comparison.lassoUse.fellBack}.` : ''}`);
    }
    for (const [name, comparison] of Object.entries(group.vsUpload ?? {})) {
      if (name === 'direct') continue;
      lines.push(`- **${name}** vs uploading the files: ${comparison.arm.correct}/${comparison.arm.tasks} correct against ${comparison.base.correct}/${comparison.base.tasks}; tokens ${n(comparison.arm.tokens)} against ${n(comparison.base.tokens)} (S = ${comparison.S}%).`);
    }
    lines.push('');
  }
  lines.push(...byFileKind(summary.results));
  lines.push('| Run | Model | Task | Arm | Correct | Tokens | Cached | Output | Model calls | Tool calls | Tools | Wall s | Stop |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const row of summary.results) {
    if (row.error) { lines.push(`| ${row.run} | ${row.model} | ${row.task} | ${row.arm} | error | | | | | | ${row.error} | | |`); continue; }
    if (row.skipped) { lines.push(`| ${row.run} | ${row.model} | ${row.task} | ${row.arm} | skipped | | | | | | ${row.skipped} | | |`); continue; }
    lines.push(`| ${row.run} | ${row.model} | ${row.task}${row.capability ? ' *' : ''} | ${row.arm} | ${row.correct ? 'yes' : '**no**'} | ${row.tokens} | ${row.cached} | ${row.output} | ${row.modelCalls} | ${row.toolCalls} | ${Object.entries(row.toolsUsed).map(([name, count]) => `${name}×${count}`).join(' ')} | ${(row.wallMs / 1000).toFixed(1)} | ${row.stop} |`);
  }
  lines.push('', '\\* capability task: needs history direct tools cannot reach; not in the comparisons.',
    ...(options.taskBudget ? [`A task whose conversation reached $${options.taskBudget} was stopped there (stop "cost-cap") and counts as wrong.`] : []), '');
  return `${lines.join('\n')}\n`;
}

async function workspacesOf(families, sets) {
  const workspaces = [];
  for (const name of families) {
    if (!FAMILIES[name]) throw new Error(`Unknown family ${name}; families are ${Object.keys(FAMILIES).join(', ')}.`);
    workspaces.push(...await FAMILIES[name]({ sets }));
  }
  return workspaces;
}

async function regrade(file) {
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const workspaces = await workspacesOf(saved.options.families, saved.options.sets);
  const tasks = new Map(workspaces.flatMap((workspace) => workspace.tasks.map((task) => [task.id, task])));
  let changed = 0;
  const results = saved.results.map((row) => {
    const task = tasks.get(row.task);
    if (row.error || row.skipped || row.stop !== 'answered') return { ...row, ...(task?.types ? { types: task.types } : {}), final: row.answer ?? '' };
    const graded = task.grade(row.answer, row.arm === 'upload' ? task.upload : row.evidence ?? '');
    if (graded.correct !== row.correct) changed += 1;
    return { ...row, ...(task.types ? { types: task.types } : {}), correct: graded.correct, ...(graded.detail ? { detail: graded.detail } : {}), final: row.answer };
  });
  for (const workspace of workspaces) await workspace.close();
  const summary = { ...summarize(results, saved.spentUsd, saved.options), generatedAt: saved.generatedAt };
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(file.replace(/\.json$/, '.md'), report(summary));
  console.error(`Regraded ${file}: ${changed} grade(s) changed.`);
}

async function main() {
  if (REGRADE) return regrade(path.resolve(REGRADE));
  if (!MODELS.length) throw new Error('Name at least one --model (mock for a dry run).');
  const providers = await Promise.all(MODELS.map((model) => providerFor(model, { openaiKey: OPENAI_KEY, anthropicKey: ANTHROPIC_KEY, effort: EFFORT,
    maxOutput: MAX_OUTPUT_TOKENS })));
  const options = { models: MODELS, families: FAMILY_NAMES, sets: SET_NAMES, arms: ASKED_ARMS, effort: EFFORT, runs: RUNS, budget: BUDGET,
    ...(Number.isFinite(TASK_BUDGET) ? { taskBudget: TASK_BUDGET } : {}), tasks: ONLY };
  const spend = new Spend(BUDGET);
  const results = [];
  const save = () => {
    const summary = summarize(results, spend.spent, options);
    fs.mkdirSync(OUT, { recursive: true });
    // One file pair per model set and families, so runs do not overwrite each other.
    const base = `live-results-${MODELS.join('+')}-${FAMILY_NAMES.join('+')}${LABEL ? `-${LABEL}` : ''}`;
    fs.writeFileSync(path.join(OUT, `${base}.json`), `${JSON.stringify(summary, null, 2)}\n`);
    fs.writeFileSync(path.join(OUT, `${base}.md`), report(summary));
    return summary;
  };
  try {
    for (let run = 1; run <= RUNS; run += 1) {
      for (const family of FAMILY_NAMES) for (const workspace of await workspacesOf([family], SET_NAMES)) {
        const lasso = openLocal({ dataDir: workspace.dataDir, scope: ['*'], client: 'live-benchmark' });
        const arms = armsFor(workspace, lasso);
        const names = armNames(workspace);
        try {
          for (const [index, task] of workspace.tasks.filter((item) => !ONLY || ONLY.includes(item.id) || ONLY.includes(item.id.split('/').pop())).entries()) {
            for (const provider of providers) {
              for (const name of shuffle(names, run * 1000 + index)) {
                const head = { run, workspace: workspace.name, model: provider.model, estimated: provider.estimated, arm: name, task: task.id, kind: task.kind,
                  capability: task.capability, ...(task.types ? { types: task.types } : {}) };
                if (name === 'upload' && !task.upload) {
                  results.push({ ...head, skipped: task.uploadSkipped ?? 'no files to attach for this task', final: '' });
                  continue;
                }
                try {
                  const prompt = name === 'upload' ? `${task.upload}\n\n${task.prompt}` : task.prompt;
                  const row = await runTask({ provider, arm: name, task, prompt, spend, ...arms[name] });
                  // An upload's evidence is the files attached to the request.
                  const graded = row.stop === 'answered' ? task.grade(row.final, name === 'upload' ? task.upload : row.evidence) : { correct: false };
                  results.push({ run, workspace: workspace.name, ...row, ...(task.types ? { types: task.types } : {}), correct: graded.correct,
                    ...(graded.detail ? { detail: graded.detail } : {}) });
                  console.error(`run ${run} ${provider.model} ${task.id} ${name}: ${graded.correct ? 'correct' : 'wrong'}, ${row.tokens} tokens, $${spend.spent.toFixed(3)} so far`);
                } catch (error) {
                  if (error instanceof BudgetExceeded) throw error;
                  results.push({ ...head, error: error.message, final: '' });
                  console.error(`run ${run} ${provider.model} ${task.id} ${name}: error ${error.message}`);
                }
                save();
              }
            }
          }
        } finally {
          await lasso.close();
          await workspace.close();
        }
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    console.error(error.message);
  }
  const summary = save();
  console.log(report(summary).split('\n').filter((line) => !line.startsWith('| ') || !/^\| \d+ \|/.test(line)).join('\n'));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

