import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { compileContext } from '../src/agent/structural/compiler.js';
import { contextDigest, refineContext, applyContextUpdate } from '../src/agent/structural/refinement.js';
import { fixtures, documentFixture, spreadsheetFixture, dependencyIds, selectionFixture } from './structural-context-fixtures.mjs';

const args = process.argv.slice(2);
const option = (key) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
const output = path.resolve(option('--out') ?? 'docs/agent');
let tokenCounter;
const tokenizerModule = option('--tokenizer-module');
if (tokenizerModule) {
  const { getEncoding } = await import(pathToFileURL(path.resolve(tokenizerModule)).href);
  const encoding = getEncoding('o200k_base');
  tokenCounter = (text) => encoding.encode(text).length;
}
const metric = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { bytes: Buffer.byteLength(text, 'utf8'), ...(tokenCounter ? { tokens: tokenCounter(text) } : {}) };
};
const budget = { budgetBytes: 1000000, ...(tokenCounter ? { tokenCounter, budgetTokens: 200000 } : {}) };
const metricKey = tokenCounter ? 'tokens' : 'bytes';
const saving = (base, result) => Number((100 * (1 - result[metricKey] / base[metricKey])).toFixed(2));
const direct = (fixture) => {
  // Competent targeted retrieval baseline: known required roots, deduplicated
  // closure, same local operators, one source header, no optimization search.
  const ids = dependencyIds(fixture.graph.records, fixture.graph.alternatives.flatMap((a) => a.evidence));
  return { source: fixture.input.source, evidence: fixture.graph.records.filter((r) => ids.has(r.id))
    .map((r) => ({ id: r.id, text: r.text, ...(r.source.locator === undefined ? {} : { locator: r.source.locator }) })) };
};
const cases = [];
for (const fixture of fixtures()) {
  const start = performance.now();
  const compiled = compileContext({ ...fixture.graph, ...budget });
  const compileMs = performance.now() - start;
  assert.equal(compiled.payload.status, 'complete_for_declared_requirements');
  const correctness = fixture.check(compiled);
  const variants = { full_context: metric(fixture.full), dependency_complete_inputs: metric(fixture.dependencyComplete),
    direct_local_results: metric(direct(fixture)), compiled: metric(compiled.text),
    greedy: metric(compileContext({ ...fixture.graph, ...budget, mode: 'greedy' }).text) };
  const byteLimited = compileContext({ ...fixture.graph, budgetBytes: variants.compiled.bytes - 1 });
  assert.equal(byteLimited.payload.status, 'partial');
  assert.ok(byteLimited.audit.accounting.responseBytes <= variants.compiled.bytes - 1);
  const stale = compileContext({ ...fixture.graph, ...budget, expectedRevisions: Object.fromEntries(Object.keys(fixture.graph.expectedRevisions).map((key) => [key, 'v-next'])) });
  assert.equal(stale.payload.status, 'partial'); assert.deepEqual(stale.payload.evidence, []);
  cases.push({ name: fixture.name, variants, savingsPercent: Object.fromEntries(Object.entries(variants).filter(([k]) => !['compiled', 'greedy'].includes(k)).map(([k, v]) => [k, saving(v, variants.compiled)])),
    correctness, byteLimitedStatus: byteLimited.payload.status, staleRevisionStatus: stale.payload.status,
    selectedAlternatives: compiled.audit.selectedAlternatives, compileMs: Number(compileMs.toFixed(3)) });
}
const selected = selectionFixture();
const exact = compileContext({ ...selected, ...budget, mode: 'exact' });
const greedy = compileContext({ ...selected, ...budget, mode: 'greedy' });
// This adversarial fixture establishes only an existence result, not average gain.
assert.ok(metric(exact.text)[metricKey] < metric(greedy.text)[metricKey]);
const selection = { exact: metric(exact.text), greedy: metric(greedy.text), exactSelected: exact.audit.selectedAlternatives,
  greedySelected: greedy.audit.selectedAlternatives, savingsPercent: saving(metric(greedy.text), metric(exact.text)), interpretation: 'deliberately adversarial fixture, not a representative workload' };

const doc = documentFixture();
let previous, fullTotal = 0, updateTotal = 0;
const turns = [];
for (let count = 1; count <= doc.graph.requirements.length; count += 1) {
  const requirements = doc.graph.requirements.slice(0, count);
  const request = { ...doc.graph, ...budget, requirements, alternatives: doc.graph.alternatives.filter((a) => a.covers.every((q) => requirements.includes(q))) };
  const full = compileContext(request);
  const update = previous ? refineContext({ previous, request, retainedDigest: contextDigest(previous.payload) }) : { kind: 'full', text: full.text, payload: full.payload, full };
  assert.equal(contextDigest(applyContextUpdate(previous?.payload, update.payload)), contextDigest(full.payload));
  fullTotal += metric(full.text)[metricKey]; updateTotal += metric(update.text)[metricKey];
  turns.push({ turn: count, kind: update.kind, full: metric(full.text), sent: metric(update.text) }); previous = update.full;
}
const recovered = refineContext({ previous, request: { ...doc.graph, ...budget } });
assert.equal(recovered.kind, 'full');
const refinement = { turns, repeatedFullTotal: fullTotal, retainedClientTotal: updateTotal, unit: metricKey,
  savingsPercent: Number((100 * (1 - updateTotal / fullTotal)).toFixed(2)), missingReceipt: recovered.kind,
  limitation: 'new tool payloads only; old conversation tokens, client reconstruction and provider billing excluded' };
const scaling = [10, 100, 1000].map((count) => {
  const fixture = spreadsheetFixture(count, false), packet = compileContext({ ...fixture.graph, ...budget }); fixture.check(packet);
  return { inputCells: count, full: metric(fixture.full), compiled: metric(packet.text), locallyValidatedRecords: packet.audit.validatedRecordIds.length };
});
const results = {
  protocolVersion: 1, tokenizer: tokenCounter ? { package: 'js-tiktoken', encoding: 'o200k_base', measurement: 'local serialized payload tokens, not provider usage' } : null,
  objective: tokenCounter ? 'tokens' : 'bytes', generatedAt: new Date().toISOString(),
  scope: 'Deterministic synthetic normalized graphs; real STEP parser covered separately by unit tests; no model answering or end-to-end MCP calls.',
  exclusions: ['tool schemas', 'request messages', 'MCP transport framing', 'conversation replay', 'model output', 'indexing cost', 'network cost', 'semantic retrieval errors'],
  cases, selection, refinement, scaling,
};
const n = (value) => value[metricKey].toLocaleString('en-US');
const lines = [
  '# Structural context prototype: offline results', '',
  `Measurement: **${tokenCounter ? 'o200k_base tokens via local js-tiktoken' : 'UTF-8 bytes (no tokenizer supplied)'}**. Counts cover serialized response content, not total API usage.`, '',
  'Fixtures are synthetic and required evidence is known in advance. These are structural correctness and payload-size experiments, not a production retrieval or model-answering benchmark.', '',
  `| Workload | Full context | Dependency-complete inputs | Direct local results | Compiled | Saving vs full | Saving vs direct |`,
  '|---|---:|---:|---:|---:|---:|---:|',
  ...cases.map((r) => `| ${r.name} | ${n(r.variants.full_context)} | ${n(r.variants.dependency_complete_inputs)} | ${n(r.variants.direct_local_results)} | ${n(r.variants.compiled)} | ${r.savingsPercent.full_context}% | ${r.savingsPercent.direct_local_results}% |`), '',
  'Negative saving means the compiler emitted more. Direct local results already execute the same supported operators and retain the same required evidence; they use one source header and omit the compiler’s coverage/status metadata. This is a strong baseline. Compiler bookkeeping has a measurable cost.', '',
  'Dependency-complete inputs contain all required raw facts with units and dependencies, before replacing calculations with local results. For small geometry queries, sending two transforms can be cheaper than a rich computed result packet.', '',
  `The deliberately adversarial selection fixture used ${n(selection.exact)} ${metricKey} with exhaustive selection and ${n(selection.greedy)} with greedy selection (${selection.savingsPercent}% smaller). Ordinary workloads above have one alternative per requirement, so they do not establish an optimization advantage.`, '',
  `Three incremental document turns sent ${refinement.retainedClientTotal} ${metricKey}, versus ${refinement.repeatedFullTotal} when sending each complete packet (${refinement.savingsPercent}% reduction in new response content). This assumes an explicitly retained client context. Missing retention confirmation produced a full response. It does not establish a reduction in total billed conversation tokens.`, '',
  '| Aggregate input cells | Full payload | Compiled payload | Locally validated records |', '|---|---:|---:|---:|',
  ...scaling.map((r) => `| ${r.inputCells} | ${n(r.full)} | ${n(r.compiled)} | ${r.locallyValidatedRecords} |`), '',
  'The aggregate’s output remains small while local evaluation still reads every dependent operand. This moves computation out of the language model; it does not make all computation constant-time.', '',
  'All fixture correctness assertions, undersized-byte-budget checks and stale-revision rejection checks passed. Unit tests separately exercise missing qualifiers, missing placements, repeated STEP occurrences, formula cycles, unit mismatches and corrupt refinement patches.', '',
  'No empirical novelty claim, model accuracy score, real customer savings estimate or Claude token count follows from this experiment. See [the specification](structural-framework.md) for contracts, limits and reproduction commands.', '',
];
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'structural-framework-results.json'), JSON.stringify(results, null, 2) + '\n');
await writeFile(path.join(output, 'structural-framework-results.md'), lines.join('\n'));
console.log(JSON.stringify({ objective: results.objective, cases: cases.map((r) => ({ name: r.name, tokensOrBytes: r.variants.compiled[metricKey], savingsPercent: r.savingsPercent })), selection, refinement, output }, null, 2));
