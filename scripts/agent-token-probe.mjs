// Real token counts for design choices, read from a provider's usage records.
// Each probe sends one text with a minimal call and reads input_tokens back,
// less the same call's count for a one-character input. A full probe of the
// benchmark's answers costs a few cents.
//
//   OPENAI_API_KEY=… node scripts/agent-token-probe.mjs [--model gpt-5.4-mini] [--key-file f] [--out docs/agent]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLocal } from '../src/agent/client.js';
import { formatAnswer } from '../src/agent/render.js';
import { INSTRUCTIONS, toolsNamed } from '../src/agent/mcp.js';
import { estimateTokens } from '../src/agent/metrics.js';
import { DIRECT_DEFINITIONS, prepareLibrary } from './agent-benchmark-corpus.mjs';
import { INSTRUCTIONS_V1, INSTRUCTIONS_V2, TOOLS_V1, TOOLS_V2 } from './agent-tools-versions.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const MODEL = option('--model', 'gpt-5.4-mini');
const OUT = path.resolve(ROOT, option('--out', 'docs/agent'));
const KEY = process.env.OPENAI_API_KEY ?? (option('--key-file', null) && fs.readFileSync(option('--key-file'), 'utf8').trim());

async function inputTokens(body) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_output_tokens: 16, store: false, reasoning: { effort: 'low' }, ...body }) });
    const value = await response.json();
    if (response.ok) return value.usage.input_tokens;
    if ([429, 500, 502, 503].includes(response.status) && attempt < 4) { await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt)); continue; }
    throw new Error(`OpenAI ${response.status}: ${value.error?.message}`);
  }
}

const asFunctions = (tools) => tools.map(({ name, description, inputSchema, input_schema: schema }) => ({ type: 'function', name, description,
  parameters: inputSchema ?? schema, strict: false }));

// What the benchmark's Lasso arms ask, one request per task family.
function requests() {
  return [
    ['suggest', 'record with fields', { queries: [{ text: 'North division', fields: ['Revenue', 'Scenario'] }] }],
    ['suggest', 'six facts batched', { queries: [
      { text: 'Account 120001', fields: ['Balance'] }, { text: 'INV-2025-01200', fields: ['Customer'] },
      { text: 'warranty reserve year end', kind: 'passage' }, { text: 'vendor review', kind: 'passage' },
      { text: 'East division', folder: 'Finance', under: 'Approved', fields: ['Revenue'] },
      { text: 'Central division', folder: 'Finance', under: 'Planning', fields: ['Headcount'] }] }],
    ['suggest', 'code name', { queries: [{ text: 'MAX_RETRIES', kind: 'code' }] }],
    ['suggest', 'passage', { queries: [{ text: 'warranty reserve year end', kind: 'passage' }] }],
    ['suggest', 'file name', { queries: [{ text: 'app.py', kind: 'file' }] }],
    ['inspect', 'line range', { items: [{ file: 'lib/billing.py', folder: 'Shop', lines: '300-310' }] }],
    ['inspect', 'symbol', { items: [{ symbol: 'apply_discount' }] }],
    ['inspect', 'outline', { items: [{ file: 'web/routes.js', folder: 'Shop' }] }],
    ['inspect', 'ambiguous name', { items: [{ file: 'app.py', lines: '1-5' }] }],
  ];
}

async function main() {
  if (!KEY) throw new Error('Set OPENAI_API_KEY or pass --key-file.');
  const library = await prepareLibrary();
  const lasso = openLocal({ dataDir: library.dataDir, scope: ['*'], client: 'probe' });
  const base = await inputTokens({ input: 'x' });
  const real = async (text) => (await inputTokens({ input: text })) - base + 1;
  const rows = [];
  try {
    // Answers, as JSON and as compact text, at the default limit and at 5.
    for (const [operation, name, request] of requests()) {
      for (const limit of operation === 'suggest' ? [undefined, 5] : [undefined]) {
        const answer = lasso[operation](limit ? { ...request, limit } : request);
        const json = formatAnswer(operation, answer, 'json');
        const text = formatAnswer(operation, answer, 'text');
        rows.push({ kind: 'answer', name: `${operation}: ${name}${limit ? ` (limit ${limit})` : ''}`, json: await real(json), text: await real(text),
          estimatedJson: estimateTokens(json), estimatedText: estimateTokens(text) });
      }
    }
    // Tool definitions and instructions, as a host sends them on every call.
    // The median of three, and a count no larger than the bare input's is asked again: one probe once read 0.
    const steady = async (body) => {
      const counts = [];
      for (let attempt = 0; counts.length < 3 && attempt < 8; attempt += 1) {
        const value = await inputTokens(body);
        if (value > base) counts.push(value);
      }
      return counts.sort((left, right) => left - right)[Math.floor((counts.length - 1) / 2)];
    };
    const plain = await steady({ input: 'x', tools: asFunctions(DIRECT_DEFINITIONS) });
    const definitions = {
      direct: plain - base,
      lassoV1: (await steady({ input: 'x', tools: asFunctions([...DIRECT_DEFINITIONS, ...TOOLS_V1]), instructions: INSTRUCTIONS_V1 })) - plain,
      lassoV2: (await steady({ input: 'x', tools: asFunctions([...DIRECT_DEFINITIONS, ...TOOLS_V2]), instructions: INSTRUCTIONS_V2 })) - plain,
      lassoCurrent: (await steady({ input: 'x', tools: asFunctions([...DIRECT_DEFINITIONS, ...toolsNamed()]), instructions: INSTRUCTIONS })) - plain,
    };
    const summary = { model: MODEL, measuredAt: new Date().toISOString(), definitions, answers: rows,
      totals: { json: rows.reduce((sum, row) => sum + row.json, 0), text: rows.reduce((sum, row) => sum + row.text, 0) } };
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'token-probe.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`Definitions (real tokens per call): direct ${definitions.direct}, Lasso v1 +${definitions.lassoV1}, v2 +${definitions.lassoV2}, current +${definitions.lassoCurrent}`);
    console.log('Answer | JSON | text | saved | est. JSON | est. text');
    for (const row of rows) console.log(`${row.name} | ${row.json} | ${row.text} | ${Math.round((1 - row.text / row.json) * 100)}% | ${row.estimatedJson} | ${row.estimatedText}`);
    console.log(`All answers: JSON ${summary.totals.json}, text ${summary.totals.text} (${Math.round((1 - summary.totals.text / summary.totals.json) * 100)}% fewer)`);
  } finally {
    await lasso.close();
    await library.app.close();
    fs.rmSync(library.root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
