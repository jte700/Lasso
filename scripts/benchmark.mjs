// Measures Lasso's suggestion accuracy, keystroke latency, indexing speed,
// the language-model context it avoids, peak memory and the disk one saved
// cell costs, on the test folders, and writes the results to
// docs/benchmarks/results.json. Run with:
//
//   node --disable-warning=ExperimentalWarning scripts/benchmark.mjs
//
// LASSO_BENCH_ROOT names the folder that holds the test folders
// (~/Desktop/Software Tests by default). Nothing is written to the user's
// own Lasso library: every run uses a temporary data directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../src/server.js';
import { diskPerOneCellEdit, peakRssBytes } from './storage-measures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const benchRoot = process.env.LASSO_BENCH_ROOT ?? path.join(os.homedir(), 'Desktop', 'Software Tests');
const outputPath = path.join(repoRoot, 'docs', 'benchmarks', 'results.json');
const { corpora, cases } = JSON.parse(fs.readFileSync(path.join(here, 'benchmark-cases.json'), 'utf8'));

// The usual rule of thumb for English text. Numbers, code and CAD files take
// more tokens per character, so this undercounts what a model would read.
const CHARACTERS_PER_TOKEN = 4;
const TOP_N = 3;
// Prefixes shorter than this never ask for suggestions in the Mac app.
const MIN_PREFIX = 2;
const BYTES_PER_MB = 1_000_000;
const TEXT_EXTENSIONS = new Set(['csv', 'tsv', 'md', 'txt', 'json', 'py', 'go', 'ts', 'tsx', 'js', 'sql', 'toml',
  'yaml', 'yml', 'sh', 'r', 'log', 'dxf', 'ifc', 'landxml', 'step', 'stp', 'xml', 'html', 'tex', 'bib']);
const SKIPPED_FOLDERS = new Set(['node_modules', '__pycache__']);

function walk(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    if (entry.name.startsWith('.') || SKIPPED_FOLDERS.has(entry.name)) return [];
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() ? [full] : [];
  });
}

// What an assistant built on a language model would have to read to answer
// from this folder: the folder's text-format files. Binary documents (PDF,
// Word, Excel, PowerPoint) are left out, so the figure is a lower bound.
function folderContext(root) {
  const files = walk(root);
  const textFiles = files.filter((file) => TEXT_EXTENSIONS.has(path.extname(file).slice(1).toLowerCase()));
  const characters = textFiles.reduce((sum, file) => sum + fs.readFileSync(file, 'utf8').length, 0);
  const bytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  return { files: files.length, textFiles: textFiles.length, bytes, characters,
    tokens: Math.ceil(characters / CHARACTERS_PER_TOKEN) };
}

// Every suggestion in one response, in the order the suggestion card shows them.
function suggestionsOf(prediction) {
  const entries = [];
  if (prediction.completion?.insertText) {
    entries.push({ rankOrder: prediction.completion.rankOrder ?? -1, insert: prediction.completion.insertText,
      texts: [prediction.completion.insertText] });
  }
  for (const claim of prediction.claims ?? []) {
    for (const candidate of claim.candidates ?? []) {
      const insert = claim.type === 'QUANTITATIVE' ? (candidate.valueText ?? candidate.label) : candidate.label;
      entries.push({ rankOrder: candidate.rankOrder ?? Number.MAX_SAFE_INTEGER, insert,
        texts: [candidate.label, candidate.valueText].filter(Boolean) });
    }
  }
  for (const list of [prediction.sourceCompletions, prediction.workspaceCompletions]) {
    for (const item of list ?? []) {
      const insert = item.insertText ?? item.label ?? '';
      entries.push({ rankOrder: item.rankOrder ?? Number.MAX_SAFE_INTEGER, insert, texts: [insert, item.label].filter(Boolean) });
    }
  }
  return entries.map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => a.rankOrder - b.rankOrder || a.index - b.index);
}

function matches(suggestion, expected) {
  const wanted = expected.toLowerCase();
  return suggestion.texts.some((text) => text.toLowerCase().includes(wanted));
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return Number(sorted[Math.max(0, index)].toFixed(2));
}

function latencySummary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1);
  return { samples: sorted.length, mean: Number(mean.toFixed(2)), p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), max: percentile(sorted, 1) };
}

async function timedPredict(app, text) {
  const started = performance.now();
  const prediction = await app.workspace.predict({ text, cursor: text.length });
  return { prediction, milliseconds: performance.now() - started };
}

// Types the prompt one key at a time, as the card asks after each keystroke,
// then scores the suggestions offered for the whole prompt.
async function runCase(app, testCase) {
  const latencies = [];
  for (let length = MIN_PREFIX; length < testCase.text.length; length += 1) {
    latencies.push((await timedPredict(app, testCase.text.slice(0, length))).milliseconds);
  }
  const { prediction, milliseconds } = await timedPredict(app, testCase.text);
  latencies.push(milliseconds);
  const suggestions = suggestionsOf(prediction);
  const rank = suggestions.findIndex((suggestion) => matches(suggestion, testCase.expect));
  const accepted = rank === 0 ? suggestions[0].insert : null;
  return { ...testCase, rank: rank >= 0 ? rank + 1 : null, top1: rank === 0, topN: rank >= 0 && rank < TOP_N,
    offered: suggestions.slice(0, TOP_N).map((suggestion) => suggestion.insert),
    typedCharacters: testCase.text.length, insertedCharacters: accepted?.length ?? 0, latencies };
}

async function withApplication(folders, work) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-benchmark-'));
  const app = createApplication({ dataDir, watchProjects: false });
  try {
    const started = performance.now();
    const added = await app.workspace.add(folders);
    const indexMilliseconds = performance.now() - started;
    return await work(app, { indexMilliseconds, projectIds: added.activeProjectIds ?? [] });
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function objectCount(app, projectIds) {
  return projectIds.reduce((sum, id) => sum + app.dependencies.objectsAt(id).length, 0);
}

async function benchmarkCorpus(corpus) {
  const root = path.join(benchRoot, corpus.folder);
  const context = folderContext(root);
  const corpusCases = cases.filter((testCase) => testCase.corpus === corpus.name);
  return withApplication([root], async (app, { indexMilliseconds, projectIds }) => {
    const results = [];
    for (const testCase of corpusCases) results.push(await runCase(app, testCase));
    return { name: corpus.name, folder: corpus.folder, context,
      indexing: { milliseconds: Math.round(indexMilliseconds), objects: objectCount(app, projectIds) },
      results };
  });
}

// The same prompts with every test folder switched on at once, as a library
// grows: suggestions must still come from the right folder, just as fast.
async function benchmarkWholeLibrary() {
  const roots = corpora.map((corpus) => path.join(benchRoot, corpus.folder));
  return withApplication(roots, async (app, { indexMilliseconds, projectIds }) => {
    const results = [];
    for (const testCase of cases) {
      results.push(await runCase(app, testCase));
      process.stdout.write('.');
    }
    return { folders: roots.length, indexing: { milliseconds: Math.round(indexMilliseconds),
      objects: objectCount(app, projectIds) }, results };
  });
}

function scoreOf(results) {
  const latencies = results.flatMap((result) => result.latencies);
  return {
    cases: results.length,
    top1: results.filter((result) => result.top1).length,
    topN: results.filter((result) => result.topN).length,
    latency: latencySummary(latencies),
  };
}

function machine() {
  const macOS = (() => { try { return execFileSync('sw_vers', ['-productVersion']).toString().trim(); } catch { return null; } })();
  return { cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()} ${macOS ?? os.release()}`, node: process.version };
}

function megabytes(bytes) {
  return (bytes / BYTES_PER_MB).toFixed(2);
}

async function main() {
  if (!fs.existsSync(benchRoot)) throw new Error(`Test folders not found at ${benchRoot}. Set LASSO_BENCH_ROOT.`);
  const perCorpus = [];
  for (const corpus of corpora) {
    process.stdout.write(`Benchmarking ${corpus.name}… `);
    const result = await benchmarkCorpus(corpus);
    perCorpus.push(result);
    console.log(`${result.indexing.milliseconds} ms to index, ${result.context.tokens.toLocaleString()} context tokens`);
  }
  process.stdout.write('Benchmarking every folder at once… ');
  const library = await benchmarkWholeLibrary();
  console.log(`${library.indexing.milliseconds} ms to index`);
  // The most memory indexing and suggesting held, read before the saved-cell
  // measurement below, which runs in this process, can add to it.
  const memory = { peakRssBytes: peakRssBytes() };
  // Measured on a generated table in its own temporary library, so the test
  // folders are never written to. bench-storage.mjs has the full breakdown.
  const storage = { diskPerEdit: await diskPerOneCellEdit(createApplication) };
  const singleFolderResults = perCorpus.flatMap((corpus) => corpus.results);
  const report = {
    generatedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim(),
    machine: machine(),
    method: { charactersPerToken: CHARACTERS_PER_TOKEN, topN: TOP_N, minimumPrefix: MIN_PREFIX },
    corpora: perCorpus.map(({ results, ...corpus }) => ({ ...corpus, score: scoreOf(results),
      results: results.map(({ latencies, ...result }) => result) })),
    singleFolder: scoreOf(singleFolderResults),
    wholeLibrary: { folders: library.folders, indexing: library.indexing, score: scoreOf(library.results),
      results: library.results.map(({ latencies, ...result }) => result) },
    memory,
    storage,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  const { top1, topN, cases: total, latency } = report.wholeLibrary.score;
  console.log(`\nWhole library: ${top1}/${total} first, ${topN}/${total} in the first ${TOP_N}; ` +
    `keystroke p50 ${latency.p50} ms, p95 ${latency.p95} ms. Peak memory ${megabytes(memory.peakRssBytes)} MB; ` +
    `one saved cell of a ${megabytes(storage.diskPerEdit.fileBytes)} MB table adds ${megabytes(storage.diskPerEdit.totalBytes)} MB on disk. ` +
    `Written to ${path.relative(repoRoot, outputPath)}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
