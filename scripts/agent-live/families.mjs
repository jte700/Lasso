// The task families of the live benchmark. Each prepares its own generated
// library (folders on disk, indexed by the app) and gives, per task: the
// request a model gets, how its answer is graded, and the files a person
// would attach instead of connecting Lasso (the upload arm).
//
//   lookup     the 18 lookup tasks over code, CSV and Markdown (agent-benchmark-corpus.mjs)
//   documents  questions about study reports, memos and workbooks: the evaluation sets of
//              scripts/agent-eval, graded by gradeAnswer (facts, qualifications, conflicts,
//              computed values, absence, numbers found in no evidence)
//   writing    drafts from spreadsheets, PDF and Word reports and 3D models (agent-writing-corpus.mjs),
//              graded by the facts a correct draft states
//   geometry   where part instances of STEP assemblies sit and how they stand to each other,
//              graded against the placements the files were written with
//   scale      a 5,000-row workbook and a 40-page PDF, sizes the other families' small files are not:
//              lookups, totals, a comparison stated once among similar sentences, and an absence

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../../src/server.js';
import { CONVERTING_DEFINITIONS, DIRECT_DEFINITIONS, directTools, graders, prepareLibrary, taskPrompts } from '../agent-benchmark-corpus.mjs';
import { pdfFile, plainText, prepareSpecLibrary, xlsxFile } from '../agent-eval/build.mjs';
import { gradeAnswer } from '../agent-eval/grade.mjs';
import { prepareWritingLibrary, writingTasks, writingTruth } from '../agent-writing-corpus.mjs';
import { bracketPart, fixtureAssembly, flangeAssembly } from '../../test/fixtures/step-models.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const SETS = { dev: 'scripts/agent-eval/dev/spec.json', heldout: 'scripts/agent-eval/heldout/spec.json', heldout2: 'scripts/agent-eval/heldout2/spec.json',
  heldout3: 'scripts/agent-eval/heldout3/spec.json' };
// What a chat upload holds at most; a larger file cannot be attached, and the upload arm skips its task.
export const MAX_UPLOAD_CHARS = 400_000;

const attached = (files) => files.map(({ path: name, text }) => `=== ${name} ===\n${text}`).join('\n\n');
// The kinds of file a task's answer is in, by extension: what the report groups savings by.
const typesOf = (paths) => [...new Set(paths.map((name) => path.extname(name).slice(1).toLowerCase()))].sort();

/** The 18 lookup tasks; two need history only Lasso can reach and are not compared. */
async function lookup() {
  const library = await prepareLibrary();
  const prompts = taskPrompts(library.truth, library.oldBillingRev);
  const grade = graders(library);
  const ids = [['code-range-known', 'code'], ['code-duplicate-named', 'code'], ['code-duplicate-ambiguous', 'code'], ['code-function-lookup', 'code'],
    ['code-multi-function', 'code'], ['code-config-key', 'code'], ['code-repeated-inspections', 'code'], ['code-stale-reference', 'code', true],
    ['code-modified-on-disk', 'code'], ['doc-short-file', 'docs'], ['doc-long-fact', 'docs'], ['doc-large-table', 'docs'], ['doc-identifier', 'docs'],
    ['doc-ambiguous-sources', 'docs'], ['doc-related-facts', 'docs'], ['doc-missing', 'docs'], ['doc-history', 'docs', true], ['doc-multi-batch', 'docs']];
  return [{ name: 'lookup', root: library.root, dataDir: library.dataDir, folders: ['Shop', 'Admin', 'Finance'],
    tools: directTools(library.root), definitions: DIRECT_DEFINITIONS,
    tasks: ids.map(([id, kind, capability = false]) => ({ id, kind, capability, prompt: prompts[id], upload: null,
      grade: (answer) => ({ correct: grade[id](answer) }) })),
    close: async () => { await library.app.close(); fs.rmSync(library.root, { recursive: true, force: true }); } }];
}

/** Each evaluation set's library and its tasks' natural questions, graded on the answer and the evidence the model saw. */
async function documents({ sets = ['heldout', 'heldout2'] } = {}) {
  const workspaces = [];
  for (const set of sets) {
    if (!SETS[set]) throw new Error(`Unknown set ${set}; sets are ${Object.keys(SETS).join(', ')}.`);
    const spec = JSON.parse(fs.readFileSync(path.join(ROOT, SETS[set]), 'utf8'));
    const library = await prepareSpecLibrary(spec);
    const texts = spec.documents.map((document) => ({ path: document.path, text: plainText(document) }));
    workspaces.push({ name: `documents/${set}`, set, root: library.root, dataDir: library.dataDir,
      folders: [...new Set(spec.documents.map((document) => document.path.split('/')[0]))],
      tools: directTools(library.root, { convert: true }), definitions: CONVERTING_DEFINITIONS,
      tasks: spec.tasks.map((task) => {
        // A person attaches the files that hold the answer; for a question about something absent, all of them.
        const patterns = (task.facts ?? []).map((fact) => fact.all.map((pattern) => new RegExp(pattern, 'i')));
        const needed = texts.filter((file) => patterns.some((set_) => set_.every((pattern) => pattern.test(file.text))));
        return { id: `${set}/${task.id}`, kind: task.kind, capability: false, prompt: task.prompt, upload: attached(needed.length ? needed : texts),
          types: typesOf((needed.length ? needed : texts).map((file) => file.path)),
          grade: (answer, evidence) => {
            const graded = gradeAnswer(task, answer, `${evidence}\n${task.prompt}`);
            return { correct: graded.correct, detail: graded };
          } };
      }),
      close: library.close });
  }
  return workspaces;
}

// The amounts an answer states, each with the step its writing implies: "$604,750" (1), "605k" (1,000),
// "$0.60 million" (10,000). An amount is right when the truth rounds to it at that step, so "$5.89 million"
// passes for 5,890,250 and "$5,880,250", exact as written, does not.
function amountsIn(text) {
  const scale = { million: 1e6, m: 1e6, thousand: 1e3, k: 1e3 };
  return [...String(text).replace(/(\d),(?=\d{3}\b)/g, '$1').matchAll(/(\d+)(?:\.(\d+))?\s*(million|thousand|m|k)?\b/gi)].map((match) => {
    const factor = scale[match[3]?.toLowerCase()] ?? 1;
    return { amount: Number(`${match[1]}.${match[2] ?? '0'}`) * factor, step: 10 ** -(match[2]?.length ?? 0) * factor };
  });
}
const consistent = (value) => (answer) => amountsIn(answer).some(({ amount, step }) => Math.abs(amount - value) <= Math.max(step / 2, 0.005) + 1e-9);
// A percentage within 0.05 points, or within the rounding its writing implies when coarser ("38%").
const percentNear = (value) => (answer) => [...String(answer).matchAll(/(\d+)(?:\.(\d+))?\s*%/g)]
  .some((match) => Math.abs(Number(`${match[1]}.${match[2] ?? '0'}`) - value) <= Math.max(10 ** -(match[2]?.length ?? 0) / 2, 0.05) + 1e-9);

/**
 * What a correct draft states, where it differs from what its evidence must hold: the offline benchmark checks
 * that an answer holds every month a draft is worked out from, but the draft itself gives the result (the year's
 * total, the best months, each quarter's margin).
 */
function draftChecks() {
  const truth = writingTruth();
  const quarterly = truth.quarters.flatMap((quarter, index) => [[`Q${index + 1} margin`, consistent(quarter.margin)],
    [`Q${index + 1} margin %`, percentNear(quarter.margin / quarter.revenue * 100)]]);
  return {
    'top-months-newsletter': [['December', (answer) => /December/.test(answer)], ['November', (answer) => /November/.test(answer)],
      ['December revenue', consistent(truth.revenue[11])]],
    'quarterly-margin-email': quarterly,
    'annual-total-line': [['2025 total', consistent(truth.total)]],
  };
}

/** The writing requests; a draft is correct when it states every fact a correct draft states. */
async function writing() {
  const checks = draftChecks();
  const library = await prepareWritingLibrary();
  return [{ name: 'writing', root: library.root, dataDir: library.dataDir, folders: ['Finance', 'Operations', 'Engineering', 'Facilities'],
    tools: directTools(library.root, { convert: true }), definitions: CONVERTING_DEFINITIONS,
    tasks: writingTasks().map((task) => {
      const files = task.files.map((file) => ({ path: file, text: library.plain[file] }));
      const fits = files.every((file) => file.text.length <= MAX_UPLOAD_CHARS);
      return { id: `writing/${task.id}`, kind: 'writing', capability: false, prompt: task.prompt, upload: fits ? attached(files) : null, types: typesOf(task.files),
        ...(fits ? {} : { uploadSkipped: `a file is over ${MAX_UPLOAD_CHARS.toLocaleString('en-US')} characters` }),
        grade: (answer) => {
          const facts = checks[task.id] ?? task.facts.map((fact) => [fact.label, (text) => fact.pattern.test(text)]);
          const missing = facts.filter(([, check]) => !check(answer)).map(([label]) => label);
          return { correct: !missing.length, detail: { facts: `${facts.length - missing.length}/${facts.length}`, missing } };
        } };
    }),
    close: async () => { await library.app.close(); fs.rmSync(library.root, { recursive: true, force: true }); } }];
}

// What an answer must state: numbers, each within its tolerance and in either sign (an offset may be written as
// "25 mm in −x"), or a phrase. The expected values come from the placements the files were written with.
const states = (expected) => (answer) => {
  const numbers = [...String(answer).replace(/(\d),(\d{3})/g, '$1$2').matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  const missing = expected.filter(({ value, within, pattern }) => (pattern ? !pattern.test(answer)
    : !numbers.some((number) => Math.abs(Math.abs(number) - Math.abs(value)) <= within)));
  return { correct: !missing.length, detail: { missing: missing.map(({ label }) => label) } };
};

const GEOMETRY_TASKS = [
  { id: 'fixture-pin-distance', file: 'Engineering/fixture assembly.step',
    prompt: 'In Engineering/fixture assembly.step, how far apart are the origins of Pin:1 and Pin:2, in mm?',
    expected: [{ label: 'distance 58.31 mm', value: 58.31, within: 0.05 }] },
  { id: 'flange-opposite-bolts', file: 'Engineering/Flange assembly.step',
    prompt: 'In Engineering/Flange assembly.step, what is the centre-to-centre distance between Bolt:1 and Bolt:5, in mm?',
    expected: [{ label: 'distance 50 mm', value: 50, within: 0.05 }] },
  { id: 'flange-bolt-pose', file: 'Engineering/Flange assembly.step',
    prompt: 'In Engineering/Flange assembly.step, where is Bolt:3 relative to Bolt:1? Give its offset in Bolt:1\'s own frame (x, y, z in mm) and how far it is turned.',
    expected: [{ label: 'offset 25 in x', value: -25, within: 0.05 }, { label: 'offset 25 in y', value: 25, within: 0.05 }, { label: 'turned 90°', value: 90, within: 0.1 }] },
  { id: 'flange-sensor-tilt', file: 'Engineering/Flange assembly.step',
    prompt: 'In Engineering/Flange assembly.step, what is the angle in degrees between the z axis of Sensor:1 and the z axis of Bolt:3?',
    expected: [{ label: 'angle 30°', value: 30, within: 0.1 }] },
  { id: 'flange-sensor-position', file: 'Engineering/Flange assembly.step',
    prompt: 'How many bolts does Engineering/Flange assembly.step have, and where is Sensor:1 placed in the assembly (x, y, z in mm)?',
    expected: [{ label: '8 bolts', pattern: /\b(?:8|eight)\s+bolts?\b/i }, { label: 'x 90', value: 90, within: 0.05 }, { label: 'y 30', value: 30, within: 0.05 },
      { label: 'z 20', value: 20, within: 0.05 }] },
];

/** STEP assemblies, written with known placements, and questions about their instances. */
async function geometry() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-geometry-')));
  const files = { 'Engineering/fixture assembly.step': fixtureAssembly(), 'Engineering/Flange assembly.step': flangeAssembly(), 'Engineering/bracket.step': bracketPart() };
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  const dataDir = path.join(root, 'library');
  const app = createApplication({ dataDir, watchProjects: false, port: 0 });
  await app.workspace.add([path.join(root, 'Engineering')], { id: 'human:bench', displayName: 'Benchmark', actorType: 'HUMAN_SELF' });
  for (const directory of app.workspace.state().directories) app.dependencies.ensureIndex(directory.id);
  return [{ name: 'geometry', root, dataDir, folders: ['Engineering'], tools: directTools(root), definitions: DIRECT_DEFINITIONS,
    tasks: GEOMETRY_TASKS.map((task) => ({ id: `geometry/${task.id}`, kind: 'geometry', capability: false, prompt: task.prompt, types: typesOf([task.file]),
      upload: attached([{ path: task.file, text: files[task.file] }]), grade: states(task.expected) })),
    close: async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); } }];
}

// A seeded generator, so the large files and their answers are the same on every run.
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const REGIONS = ['North', 'South', 'East', 'West', 'Central'];
const PRODUCTS = ['Valves', 'Pumps', 'Sensors', 'Fittings', 'Controllers', 'Service plans'];

/** 5,000 invoices of 2025: invoice, date, customer, region, product, amount. */
function transactions() {
  const random = seeded(2025);
  return Array.from({ length: 5000 }, (_, index) => {
    const month = 1 + Math.floor(random() * 12);
    const day = 1 + Math.floor(random() * 28);
    return [`INV-2025-${String(index + 1).padStart(5, '0')}`, `2025-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      `Customer ${1 + Math.floor(random() * 400)}`, REGIONS[Math.floor(random() * REGIONS.length)], PRODUCTS[Math.floor(random() * PRODUCTS.length)],
      (50 + Math.floor(random() * 995_000) / 100).toFixed(2)];
  });
}

/**
 * A 40-page annual review: sections of ordinary report prose about regions,
 * products and costs, with the year-end warranty reserve stated once (page
 * 23) beside an earlier half-year figure (page 9), each region's churn on its
 * own page with only Central's called the lowest, and nothing on emissions.
 */
function annualReview() {
  const random = seeded(40);
  const pick = (values) => values[Math.floor(random() * values.length)];
  const metrics = ['revenue', 'operating costs', 'order volume', 'average order value', 'service revenue', 'gross margin', 'inventory days', 'on-time delivery'];
  const causes = ['higher volumes from existing customers', 'price increases agreed in the spring', 'a slower second half', 'new distributor agreements',
    'lower freight costs', 'a delayed product launch', 'stronger demand for replacement parts', 'the consolidation of two warehouses'];
  const sentence = () => {
    const kind = random();
    if (kind < 0.4) return `In the ${pick(REGIONS)} region, ${pick(metrics)} ${random() < 0.6 ? 'rose' : 'fell'} by ${(1 + random() * 14).toFixed(1)}% compared with 2024, reflecting ${pick(causes)}.`;
    if (kind < 0.7) return `${pick(PRODUCTS)} accounted for ${(5 + random() * 25).toFixed(1)}% of sales in the ${pick(REGIONS)} region, against ${(5 + random() * 25).toFixed(1)}% a year earlier.`;
    return `The ${pick(['procurement', 'logistics', 'customer service', 'finance', 'quality'])} team ${pick(['completed', 'began', 'extended', 'reviewed'])} ${pick(['a supplier audit', 'the move to the new planning system', 'its staffing plan', 'the returns process', 'a pricing review'])} during the ${pick(['first', 'second', 'third', 'fourth'])} quarter.`;
  };
  const paragraph = () => ({ paragraph: Array.from({ length: 4 + Math.floor(random() * 3) }, sentence).join(' ') });
  const churn = { North: '6.1', South: '5.4', East: '5.9', West: '7.2' };
  const pages = Array.from({ length: 40 }, (_, index) => [{ heading: `${index + 1}. ${pick(['Regional performance', 'Products', 'Operations', 'Customers', 'Costs', 'Outlook'])}` },
    paragraph(), paragraph(), paragraph()]);
  pages[8].splice(2, 0, { paragraph: 'At the end of June, the warranty reserve stood at $3.6 million, reflecting higher claims on the older pump range.' });
  pages[22].splice(2, 0, { paragraph: 'The warranty reserve at year end was $4.2 million, up from $3.1 million a year earlier, after a review of claims on the older pump range.' });
  Object.entries(churn).forEach(([region, rate], index) => pages[12 + index * 4].splice(1, 0, { paragraph: `Customer churn in the ${region} region was ${rate}% for the year.` }));
  pages[30].splice(1, 0, { paragraph: 'Customer churn in the Central region was 4.8% for the year, the lowest of any region.' });
  return pages;
}

const ABSENT_SAID = /\b(?:not (?:mention|report|discuss|include|contain|cover|say|address)\w*|no (?:mention|information|data|reference)|doesn['’]?t|does not|did not|isn['’]?t)\b/i;

/** The two large files, indexed, and questions whose answers are computed from what was written. */
async function scale() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-scale-')));
  const rows = transactions();
  const header = ['Invoice', 'Date', 'Customer', 'Region', 'Product', 'Amount'];
  const pages = annualReview();
  const files = { 'Finance/Transactions 2025.xlsx': xlsxFile([{ name: 'Transactions', header, rows }]), 'Reports/Annual review 2025.pdf': pdfFile('Annual review 2025', pages) };
  for (const [name, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), data);
  }
  const dataDir = path.join(root, 'library');
  const app = createApplication({ dataDir, watchProjects: false, port: 0 });
  await app.workspace.add(['Finance', 'Reports'].map((name) => path.join(root, name)), { id: 'human:bench', displayName: 'Benchmark', actorType: 'HUMAN_SELF' });
  for (const directory of app.workspace.state().directories) app.dependencies.ensureIndex(directory.id);
  const sheet = { path: 'Finance/Transactions 2025.xlsx', text: plainText({ type: 'xlsx', sheets: [{ name: 'Transactions', header, rows }] }) };
  const report = { path: 'Reports/Annual review 2025.pdf', text: plainText({ type: 'pdf', pages }) };
  const amount = (row) => Number(row[5]);
  const total = rows.reduce((sum, row) => sum + amount(row), 0);
  const west = rows.filter((row) => row[3] === 'West').reduce((sum, row) => sum + amount(row), 0);
  const largest = rows.reduce((best, row) => (amount(row) > amount(best) ? row : best));
  const lookup = rows[3416];
  const all = (...checks) => (answer) => {
    const missing = checks.filter(([, check]) => !check(answer)).map(([label]) => label);
    return { correct: !missing.length, detail: { missing } };
  };
  const tasks = [
    { id: 'invoice-lookup', file: sheet, prompt: `In ${sheet.path}, what is the Amount of invoice ${lookup[0]}, and which customer is it for?`,
      grade: all([`amount ${lookup[5]}`, consistent(amount(lookup))], [lookup[2], (answer) => new RegExp(`\\b${lookup[2]}\\b`).test(answer)]) },
    { id: 'amount-total', file: sheet, prompt: `What is the total of the Amount column in ${sheet.path}?`,
      grade: all([`total ${total.toFixed(2)}`, consistent(total)]) },
    { id: 'west-total', file: sheet, prompt: `What is the total Amount for the West region in ${sheet.path}?`,
      grade: all([`West total ${west.toFixed(2)}`, consistent(west)]) },
    { id: 'largest-invoice', file: sheet, prompt: `Which invoice in ${sheet.path} has the largest Amount, and what is it?`,
      grade: all([largest[0], (answer) => answer.includes(largest[0])], [`amount ${largest[5]}`, consistent(amount(largest))]) },
    { id: 'warranty-reserve', file: report, prompt: `According to ${report.path}, what was the warranty reserve at the end of 2025?`,
      grade: all(['4.2 million', consistent(4.2e6)]) },
    { id: 'lowest-churn', file: report, prompt: `According to ${report.path}, which region had the lowest customer churn in 2025, and what was the rate?`,
      grade: all(['Central', (answer) => /\bCentral\b/.test(answer)], ['4.8%', (answer) => /\b4\.8\s*%/.test(answer)]) },
    { id: 'emissions-absent', file: report, prompt: `What does ${report.path} say about the company's carbon emissions?`,
      grade: all(['says it is not covered', (answer) => ABSENT_SAID.test(answer)]) },
  ];
  return [{ name: 'scale', root, dataDir, folders: ['Finance', 'Reports'], tools: directTools(root, { convert: true }), definitions: CONVERTING_DEFINITIONS,
    tasks: tasks.map((task) => ({ id: `scale/${task.id}`, kind: 'scale', capability: false, prompt: task.prompt, types: typesOf([task.file.path]),
      upload: task.file.text.length <= MAX_UPLOAD_CHARS ? attached([task.file]) : null, grade: task.grade })),
    close: async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); } }];
}

export const FAMILIES = { lookup, documents, writing, geometry, scale };
// The arms each family is run in by default. Upload has no tools: the request comes with the files attached.
export const DEFAULT_ARMS = { lookup: ['direct', 'lasso'], documents: ['direct', 'lasso', 'upload'], writing: ['direct', 'lasso', 'upload'], geometry: ['direct', 'lasso', 'upload'],
  scale: ['direct', 'lasso', 'upload'] };
