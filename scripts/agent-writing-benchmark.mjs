// Writing tasks, offline: does one lasso call give a model every fact its
// draft needs, and at what size, against what a file-reading agent has to
// read? Calls no model and spends nothing; the draft itself is a live run's job.
//
//   node scripts/agent-writing-benchmark.mjs [--out docs/agent] [--label name]
//
// For each task and each of its fixed ask sets: the facts a correct draft
// needs that the answer contains, and its size. The file-reading reference is
// the text of the task's files as a converter gives it (CSV for a workbook,
// the text of a PDF or Word file, STEP and IFC as they are), the least such
// an agent reads, assuming it already knows which files to open.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLocal } from '../src/agent/client.js';
import { formatAnswer } from '../src/agent/render.js';
import { estimateTokens } from '../src/agent/metrics.js';
import { prepareWritingLibrary, writingTasks } from './agent-writing-corpus.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const OUT = path.resolve(ROOT, option('--out', 'docs/agent'));
const LABEL = option('--label', null);
// What a coding agent's harness lets one tool result put in context.
const MAX_TOOL_CHARS = 60_000;

async function main() {
  const library = await prepareWritingLibrary();
  const lasso = openLocal({ dataDir: library.dataDir, scope: ['*'], client: 'writing-benchmark' });
  const rows = [];
  try {
    for (const task of writingTasks()) {
      const reference = task.files.map((file) => library.plain[file]).join('\n');
      const referenceFacts = task.facts.filter((fact) => fact.pattern.test(reference)).length;
      const direct = { tokens: estimateTokens(reference), facts: referenceFacts, overCap: task.files.some((file) => library.plain[file].length > MAX_TOOL_CHARS) };
      const sets = [...task.asks.map((ask) => ({ ask, round: 'development' })), ...task.heldOut1.map((ask) => ({ ask, round: 'held-out 1' })),
        ...task.heldOut2.map((ask) => ({ ask, round: 'held-out 2' }))].map(({ ask, round }) => {
        const text = formatAnswer('ask', lasso.ask({ ask }));
        const found = task.facts.filter((fact) => fact.pattern.test(text));
        return { ask, round, tokens: estimateTokens(text), facts: found.length,
          missing: task.facts.filter((fact) => !found.includes(fact)).map((fact) => fact.label), text };
      });
      rows.push({ id: task.id, files: task.files, needed: task.facts.length, direct, sets });
      console.error(`${task.id}: ${sets.map((set) => `${set.round === 'development' ? '' : `${set.round} `}${set.facts}/${task.facts.length} in ${set.tokens} tokens`).join('; ')} | files ${direct.tokens} tokens`);
    }
  } finally {
    await lasso.close();
    await library.app.close();
    fs.rmSync(library.root, { recursive: true, force: true });
  }
  const tally = (sets) => ({ askSets: sets.length, complete: sets.filter((set) => set.facts === set.needed).length,
    factsFound: sets.reduce((total, set) => total + set.facts, 0), factsNeeded: sets.reduce((total, set) => total + set.needed, 0),
    lassoTokens: Math.round(sets.reduce((total, set) => total + set.tokens, 0) / sets.length) });
  const all = rows.flatMap((row) => row.sets.map((set) => ({ ...set, needed: row.needed })));
  const summary = { generatedAt: new Date().toISOString(), tasks: rows.length,
    rounds: Object.fromEntries(['development', 'held-out 1', 'held-out 2'].map((round) => [round, tally(all.filter((set) => set.round === round))])),
    fileTokens: Math.round(rows.reduce((total, row) => total + row.direct.tokens, 0) / rows.length), rows };
  fs.mkdirSync(OUT, { recursive: true });
  const base = `writing-results${LABEL ? `-${LABEL}` : ''}`;
  fs.writeFileSync(path.join(OUT, `${base}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, `${base}.md`), report(summary));
  console.log(report(summary));
}

function report(summary) {
  const lines = ['# Lasso on writing tasks (offline)', ''];
  lines.push(`Generated ${summary.generatedAt} by \`node scripts/agent-writing-benchmark.mjs\`. No model is called: each row is one \`lasso\` call with a fixed set of asks, checked for the facts a correct draft needs. Token counts are estimates.`, '');
  const line = (name, tally) => `- **${name}: ${tally.complete} of ${tally.askSets} ask sets complete** (${tally.factsFound} of ${tally.factsNeeded} facts); mean answer ${tally.lassoTokens} tokens.`;
  // None of the three is held out any longer: each was run, and Lasso changed, with its misses in view.
  lines.push(line('Development asks (written before any change; Lasso was changed while looking at them)', summary.rounds.development),
    line('Asks set 1 (written after the first changes; its first run had 15 of 24 complete; Lasso was changed since, its misses seen)', summary.rounds['held-out 1']),
    line('Asks set 2 (written after the second changes; its one unseen run had 19 of 24 complete; Lasso was changed since, its misses seen)', summary.rounds['held-out 2']),
    `- Mean text of a task's files, as a file-reading agent gets it: ${summary.fileTokens.toLocaleString('en-US')} tokens.`, '');
  lines.push('| Task | Asks | Set | Facts in the answer | Answer tokens | Missing | Files as text (tokens) |', '|---|---|---|---|---|---|---|');
  for (const row of summary.rows) {
    for (const [index, set] of row.sets.entries()) {
      const files = index ? '' : `${row.direct.tokens.toLocaleString('en-US')}${row.direct.overCap ? ' (over a 60k-character tool result)' : ''}`;
      lines.push(`| ${index ? '' : row.id} | ${set.ask.map((ask) => `"${ask}"`).join(', ')} | ${set.round} | ${set.facts}/${row.needed} | ${set.tokens} | ${set.missing.slice(0, 4).join(', ')}${set.missing.length > 4 ? ` +${set.missing.length - 4}` : ''} | ${files} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
