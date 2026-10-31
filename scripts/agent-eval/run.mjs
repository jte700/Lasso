// Offline evaluation: each task's fixed ask sets sent to lasso as a model's
// tool call would send them, and the rendered response graded for whether a
// careful reader could complete the task from it alone (grade.mjs). Calls no
// model and spends nothing; whether a model then answers correctly is a live
// run's job (gradeAnswer).
//
//   node scripts/agent-eval/run.mjs [--set dev|heldout|heldout2|heldout3|all] [--label name] [--out docs/agent] [--budget tokens]
//   node scripts/agent-eval/run.mjs --regrade docs/agent/eval-results-phase1.json
//
// --regrade grades a saved run's responses again with the current grader and
// specs, without running Lasso: a grader fix changes no response.
//
// Token counts are estimates of the rendered response (metrics.js), not
// provider-recorded usage. The file-reading reference is the text of the
// documents that state the task's facts, as a converter would give it: an
// estimate of what reading those files whole puts in context.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { openLocal } from '../../src/agent/client.js';
import { formatAnswer } from '../../src/agent/render.js';
import { estimateTokens } from '../../src/agent/metrics.js';
import { plainText, prepareSpecLibrary } from './build.mjs';
import { documentUnits, gradeEvidence, validateSpec } from './grade.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const SETS = { dev: 'scripts/agent-eval/dev/spec.json', heldout: 'scripts/agent-eval/heldout/spec.json', heldout2: 'scripts/agent-eval/heldout2/spec.json',
  heldout3: 'scripts/agent-eval/heldout3/spec.json' };
const chosen = option('--set', 'all');
const LABEL = option('--label', null);
// The evidence budget sent with each ask (tokens), when measuring how much evidence is enough.
const BUDGET = option('--budget', null);
const OUT = path.resolve(ROOT, option('--out', 'docs/agent'));
const REGRADE = option('--regrade', null);

const percentile = (values, share) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)] : null;
};

async function runSet(name, file) {
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const problems = validateSpec(spec);
  if (problems.length) throw new Error(`${file} is not valid:\n${problems.join('\n')}`);
  const library = await prepareSpecLibrary(spec);
  const lasso = openLocal({ dataDir: library.dataDir, scope: ['*'], client: 'eval' });
  const rows = [];
  try {
    for (const task of spec.tasks) {
      // The documents a file-reading agent would have to open: those that state any of the task's facts.
      const patterns = (task.facts ?? []).map((fact) => fact.all.map((pattern) => new RegExp(pattern, 'i')));
      const needed = spec.documents.filter((document) => documentUnits(document).some((unit) => patterns.some((set) => set.every((pattern) => pattern.test(unit)))));
      const fileTokens = estimateTokens(needed.map(plainText).join('\n\n'));
      for (const [index, ask] of task.asks.entries()) {
        const started = performance.now();
        let text;
        try { text = formatAnswer('ask', lasso.ask({ ask, ...(BUDGET ? { budget: Number(BUDGET) } : {}) })); } catch (error) { text = `Error: ${error.message}`; }
        const ms = Math.round(performance.now() - started);
        rows.push({ set: name, task: task.id, kind: task.kind, askSet: index + 1, ask, ms, fileTokens, files: needed.map((document) => document.path),
          ...gradeEvidence(task, text), text });
      }
    }
  } finally {
    await lasso.close();
    await library.close();
  }
  return rows;
}

function summary(rows) {
  const tokens = rows.map((row) => row.tokens);
  return { askSets: rows.length, sufficient: rows.filter((row) => row.sufficient).length,
    material: rows.reduce((sum, row) => sum + Number(row.material.split('/')[0]), 0) + '/' + rows.reduce((sum, row) => sum + Number(row.material.split('/')[1]), 0),
    tokens: { median: percentile(tokens, 0.5), p90: percentile(tokens, 0.9), max: Math.max(...tokens) },
    relevantShare: Math.round(rows.reduce((sum, row) => sum + row.relevantShare, 0) / rows.length * 100) / 100,
    fileTokens: { median: percentile(rows.map((row) => row.fileTokens), 0.5), max: Math.max(...rows.map((row) => row.fileTokens)) },
    ms: { median: percentile(rows.map((row) => row.ms), 0.5), max: Math.max(...rows.map((row) => row.ms)) } };
}

function report(result) {
  const lines = [`# Lasso evaluation (offline)${result.label ? `: ${result.label}` : ''}`, ''];
  lines.push(`Generated ${result.generatedAt}${result.regradedAt ? `, regraded ${result.regradedAt} (responses unchanged)` : ''} by \`node scripts/agent-eval/run.mjs\`. Each row is one \`lasso\` call with a fixed ask set, graded on the rendered response: could a careful reader complete the task from it alone? A fact counts only when all its patterns match in one sentence, record line, or table row read with its header. No model is called; token counts are estimates.`, '');
  lines.push('| Set | Sufficient | Material facts | Response tokens (median / p90 / max) | Share about the task | Files that state the facts, as text (median / max tokens) | Local ms (median / max) |', '|---|---|---|---|---|---|---|');
  for (const [name, set] of Object.entries(result.sets)) {
    lines.push(`| ${name} | ${set.sufficient} of ${set.askSets} | ${set.material} | ${set.tokens.median} / ${set.tokens.p90} / ${set.tokens.max} | ${Math.round(set.relevantShare * 100)}% | ${set.fileTokens.median} / ${set.fileTokens.max} | ${set.ms.median} / ${set.ms.max} |`);
  }
  lines.push('', '| Set | Task | Kind | Asks | Sufficient | Material | Qualifications | Conflicts | Computed | Missing | Tokens | About the task |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const row of result.rows) {
    lines.push(`| ${row.set} | ${row.task} | ${row.kind} | ${row.ask.map((ask) => `"${ask}"`).join(', ')} | ${row.sufficient ? 'yes' : '**no**'} | ${row.material} | ${row.qualifications} | ${row.conflicts} | ${row.computed}${row.absentSaid === false ? ' (absence not said)' : ''} | ${row.missing.join(', ')} | ${row.tokens} | ${Math.round(row.relevantShare * 100)}% |`);
  }
  return `${lines.join('\n')}\n`;
}

function write(result, out, base) {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${base}.json`), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(out, `${base}.md`), report(result));
}

/** A saved run's responses graded again by the current grader and specs; Lasso is not run. */
function regrade(file) {
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const specs = new Map(Object.keys(saved.sets).map((name) => [name, JSON.parse(fs.readFileSync(path.join(ROOT, SETS[name]), 'utf8'))]));
  let changed = 0;
  const rows = saved.rows.map((row) => {
    const task = specs.get(row.set).tasks.find((entry) => entry.id === row.task);
    const graded = { ...row, ...gradeEvidence(task, row.text) };
    if (graded.sufficient !== row.sufficient) changed += 1;
    return graded;
  });
  const result = { ...saved, regradedAt: new Date().toISOString(),
    sets: Object.fromEntries(Object.keys(saved.sets).map((name) => [name, summary(rows.filter((row) => row.set === name))])), rows };
  write(result, path.dirname(file), path.basename(file, '.json'));
  console.log(`Regraded ${file}: ${changed} ask set(s) changed.`);
  console.log(report(result).split('\n').slice(4, 4 + 2 + Object.keys(saved.sets).length).join('\n'));
}

async function main() {
  if (REGRADE) return regrade(path.resolve(ROOT, REGRADE));
  const names = chosen === 'all' ? Object.keys(SETS).filter((name) => fs.existsSync(path.join(ROOT, SETS[name]))) : [chosen];
  const rows = [];
  for (const name of names) rows.push(...await runSet(name, SETS[name]));
  const result = { generatedAt: new Date().toISOString(), label: LABEL,
    sets: Object.fromEntries(names.map((name) => [name, summary(rows.filter((row) => row.set === name))])), rows };
  write(result, OUT, `eval-results${LABEL ? `-${LABEL}` : ''}`);
  console.log(report(result).split('\n').slice(0, 8).join('\n'));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
