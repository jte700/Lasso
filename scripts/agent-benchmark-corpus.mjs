// The benchmark's corpus, library and direct tools, shared by the offline
// benchmark (scripts/agent-benchmark.mjs) and the live one
// (scripts/agent-benchmark-live.mjs), so both run the same tasks on the same
// data. Everything is generated from a fixed seed; answers are known.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createApplication } from '../src/server.js';
import { INSTRUCTIONS as LASSO_INSTRUCTIONS, TOOLS as ALL_LASSO_TOOLS, toolsNamed } from '../src/agent/mcp.js';

// ── corpus ─────────────────────────────────────────────────────────────────

function prng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = 'order item price total customer invoice account ledger balance region quarter forecast payment refund tax rate vendor contract schedule review report reserve warranty margin cost revenue division budget planning approved scenario'.split(' ');

function pythonFunction(random, name, length) {
  const lines = [`def ${name}(${['value', 'order', 'items', 'context'][Math.floor(random() * 4)]}):`, `    """${name.replace(/_/g, ' ')} for the ${WORDS[Math.floor(random() * WORDS.length)]}."""`];
  for (let index = 0; index < length - 3; index += 1) {
    const word = WORDS[Math.floor(random() * WORDS.length)];
    lines.push(index % 5 === 4 ? `    if ${word}_${index} > ${Math.floor(random() * 100)}:\n        ${word}_${index} -= 1`.split('\n')[0] : `    ${word}_${index} = ${Math.floor(random() * 1000)} * ${(random() * 3).toFixed(2)}`);
  }
  lines.push(`    return ${WORDS[Math.floor(random() * WORDS.length)]}_0`);
  return lines;
}

export function buildCorpus(root) {
  const random = prng(20261027);
  const files = {};
  const truth = {};

  // Shop: a code project. billing.py is long; apply_discount sits deep in it.
  const billing = ['"""Billing rules."""', 'import math', 'from decimal import Decimal', ''];
  let helper = 0;
  while (billing.length < 2090) { billing.push(...pythonFunction(random, `helper_${String(helper++).padStart(4, '0')}`, 8 + Math.floor(random() * 20)), ''); }
  const discount = [
    'def apply_discount(order, code):',
    '    """Apply a discount code to an order and return the new total."""',
    '    if not code:',
    '        return order.total',
    '    rule = DISCOUNTS.get(code.upper())',
    '    if rule is None:',
    '        raise UnknownDiscount(code)',
    '    if rule.expires and rule.expires < order.placed_at:',
    '        raise ExpiredDiscount(code)',
    '    eligible = [line for line in order.lines if line.sku not in rule.excluded]',
    '    subtotal = sum(line.price * line.quantity for line in eligible)',
    '    if subtotal < rule.minimum:',
    '        return order.total',
    '    if rule.kind == "percent":',
    '        saving = subtotal * Decimal(rule.amount) / 100',
    '    else:',
    '        saving = min(Decimal(rule.amount), subtotal)',
    '    saving = saving.quantize(Decimal("0.01"))',
    '    order.discounts.append((code, saving))',
    '    return order.total - saving',
  ];
  const discountStart = billing.length + 1;
  billing.push(...discount, '');
  while (billing.length < 3000) { billing.push(...pythonFunction(random, `helper_${String(helper++).padStart(4, '0')}`, 8 + Math.floor(random() * 20)), ''); }
  files['Shop/lib/billing.py'] = `${billing.join('\n')}\n`;
  truth.discount = { start: discountStart, end: discountStart + discount.length - 1, text: discount.join('\n') };

  for (let module = 0; module < 40; module += 1) {
    const lines = [`"""Module ${module}."""`, ''];
    const names = module === 7 ? ['normalize_sku'] : module === 19 ? ['retry_payment'] : [];
    for (let index = 0; index < 5; index += 1) names.push(`task_${module}_${index}`);
    for (const name of names) lines.push(...pythonFunction(random, name, 12 + Math.floor(random() * 14)), '');
    files[`Shop/pkg/mod_${String(module).padStart(2, '0')}.py`] = `${lines.join('\n')}\n`;
    lines.push(`# MAX_RETRIES is read from config.settings`);
  }
  const routes = ["import express from 'express';", ''];
  for (let index = 0; index < 30; index += 1) {
    routes.push(`export function route${index}(request, response) {`, `  const value = request.query.v${index} ?? ${index};`, `  response.json({ value, index: ${index} });`, '}', '');
  }
  routes.push('export function registerRoutes(app) {');
  for (let index = 0; index < 30; index += 1) routes.push(`  app.get('/route/${index}', route${index});`);
  routes.push('  return app;', '}', '');
  files['Shop/web/routes.js'] = routes.join('\n');
  files['Shop/config/settings.py'] = ['"""Settings."""', '', 'DEBUG = False', 'TIMEOUT_SECONDS = 30', 'MAX_RETRIES = 7', 'REGION = "eu-west"', ''].join('\n');
  files['Shop/server/app.py'] = Array.from({ length: 40 }, (_, index) => index === 0 ? 'from shop import server' : `# server line ${index + 1}`).join('\n') + '\n';
  files['Shop/worker/app.py'] = Array.from({ length: 30 }, (_, index) => index === 0 ? 'from shop import worker' : `# worker line ${index + 1}`).join('\n') + '\n';
  files['Admin/src/app.py'] = Array.from({ length: 50 }, (_, index) => `ADMIN_SETTING_${index + 1} = ${index * 3}`).join('\n') + '\n';

  // Finance: competing budgets, a large ledger, invoices, a long report and a note.
  const divisions = ['North division', 'South division', 'East division', 'Central division',
    ...Array.from({ length: 36 }, (_, index) => `Division ${String(index + 5).padStart(2, '0')}`)];
  const budget = (scenario, offset) => ['Division,Revenue,Reporting period,Headcount,Scenario',
    ...divisions.map((division, index) => `${division},${(10 + index * 0.7 + offset).toFixed(1)},FY2025,${120 + index * 9},${scenario}`)].join('\n') + '\n';
  files['Finance/Planning/budget_2025.csv'] = budget('Planning', 2.4);
  files['Finance/Approved/budget_2025.csv'] = budget('Approved', 1.9);
  truth.southApproved = { Revenue: (10 + 0.7 + 1.9).toFixed(1), 'Reporting period': 'FY2025', Headcount: String(129) };
  truth.eastApprovedRevenue = (10 + 1.4 + 1.9).toFixed(1);
  truth.centralPlanningHeadcount = String(120 + 27);
  truth.northApproved = (10 + 1.9).toFixed(1);

  const ledger = ['Account,Balance,Region,Owner'];
  for (let index = 0; index < 130_000; index += 1) ledger.push(`Account ${100_000 + index},${(index * 37 % 100_000) / 100},Region ${index % 7},Owner ${index % 1000}`);
  files['Finance/ledger.csv'] = `${ledger.join('\n')}\n`;
  truth.balance104233 = String((4233 * 37 % 100_000) / 100);
  truth.balance120001 = String((20001 * 37 % 100_000) / 100);

  const invoices = ['Invoice,Customer,Amount,Date'];
  for (let index = 1; index <= 2000; index += 1) invoices.push(`INV-2025-${String(index).padStart(5, '0')},Customer ${index % 97},${(index * 13.5).toFixed(2)},2025-${String(1 + index % 12).padStart(2, '0')}-15`);
  files['Finance/invoices.csv'] = `${invoices.join('\n')}\n`;
  truth.invoice417 = { Customer: `Customer ${417 % 97}`, Amount: (417 * 13.5).toFixed(2) };
  truth.invoice1200 = `Customer ${1200 % 97}`;

  const report = ['# Annual report 2025', ''];
  let section = 1;
  while (report.length < 2500) {
    if (report.length % 120 === 2) report.push(`## Section ${section++}`, '');
    if (report.length > 1830 && !report.includes('WARRANTY')) {
      report.push('The warranty reserve at year end was $4.2 million, up from $3.1 million a year earlier.', '');
      report.push('WARRANTY', '');
    }
    report.push(Array.from({ length: 18 }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ') + '.', '');
  }
  files['Finance/reports/annual_report.md'] = report.filter((line) => line !== 'WARRANTY').join('\n') + '\n';
  truth.warranty = '$4.2 million';
  files['Finance/notes/short_note.md'] = ['# Vendor notes', '', 'Contracts renew in April.', '', 'The vendor review is scheduled for March 3.', '', 'Bring the signed forms.', ''].join('\n');
  truth.vendorReview = 'March 3';

  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return { files, truth, divisions };
}

// ── direct tools, shaped like a coding agent's ─────────────────────────────

export const DIRECT_DEFINITIONS = [
  { name: 'Read', description: 'Reads a file from the local filesystem. file_path is relative to the workspace root. By default reads up to 2000 lines from the start; offset (1-based line) and limit read part of a file. Output is numbered like cat -n, starting at 1. Use it to read code, text and data files.',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['file_path'] } },
  { name: 'Grep', description: 'Searches file contents with a regular expression (ripgrep syntax). path limits the search to a file or directory; glob filters file names. output_mode "content" shows matching lines (with -n line numbers and -C context lines), "files_with_matches" shows file paths. head_limit caps the output.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] }, '-n': { type: 'boolean' }, '-C': { type: 'integer' }, '-i': { type: 'boolean' }, head_limit: { type: 'integer' } }, required: ['pattern'] } },
  { name: 'Glob', description: 'Finds files by name pattern such as "**/*.py" or "src/**/app.py", relative to the workspace root. Returns matching paths, one per line.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
];
export const LEGACY_DEFINITION = { name: 'lasso_find', description: 'Runs Lasso\'s terminal command `find <query> [--source ext] [--directory dir]` over the indexed folders and returns its result.',
  input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } };
// What a host adds to every call once Lasso is connected: the MCP server's
// default tools and its instructions; with cite when a server is started with it.
const asDefinition = ({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema });
export const LASSO_DEFINITIONS = [...toolsNamed().map(asDefinition), { instructions: LASSO_INSTRUCTIONS }];
export const LASSO_DEFINITIONS_WITH_CITE = [...ALL_LASSO_TOOLS.map(asDefinition), { instructions: LASSO_INSTRUCTIONS }];

/**
 * The first, conservative estimate: one token per punctuation mark and per
 * four letters. Real counts showed it reads JSON at up to 1.8x; it is kept
 * as a sensitivity check beside the calibrated estimateTokens.
 */
export function estimateConservative(text) {
  let tokens = 0;
  for (const match of String(text ?? '').matchAll(/(\p{L}+)|(\p{N}+)|(\s+)|([^\p{L}\p{N}\s])/gu)) {
    if (match[1]) tokens += Math.ceil(match[1].length / 4);
    else if (match[2]) tokens += Math.ceil(match[2].length / 3);
    else if (match[3]) tokens += match[3].includes('\n') ? match[3].split('\n').length - 1 : 0;
    else tokens += 1;
  }
  return tokens;
}

export function globToRegExp(glob) {
  let pattern = '';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*' && glob[index + 1] === '*') { pattern += '(?:.*/)?'; index += glob[index + 2] === '/' ? 2 : 1; }
    else if (character === '*') pattern += '[^/]*';
    else if (character === '?') pattern += '[^/]';
    else pattern += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

export function directTools(root) {
  const all = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'library') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else all.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  };
  walk(root);
  all.sort();
  const contents = new Map();
  // As a shell would read them: "./Shop", "Shop/", "." and "" all mean what they say.
  const clean = (value) => {
    const name = String(value ?? '').replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
    return name === '.' ? '' : name;
  };
  const text = (relative) => {
    if (!contents.has(relative)) contents.set(relative, fs.readFileSync(path.join(root, relative), 'utf8'));
    return contents.get(relative);
  };
  return {
    Read({ file_path: asked, offset = 1, limit = 2000 }) {
      const file_path = clean(asked);
      if (!file_path || file_path.split('/').includes('..') || !fs.existsSync(path.join(root, file_path))
        || !fs.statSync(path.join(root, file_path)).isFile()) return `File does not exist: ${asked}`;
      const lines = fs.readFileSync(path.join(root, file_path), 'utf8').replace(/\n$/, '').split('\n');
      return lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${String(offset + index).padStart(6)}\t${line.slice(0, 2000)}`).join('\n');
    },
    Grep({ pattern, path: asked = '', glob = null, output_mode = 'files_with_matches', '-n': numbers = true, '-C': around = 0, '-i': insensitive = false, head_limit = 0 }) {
      const scope = clean(asked);
      let regex;
      try { regex = new RegExp(pattern, insensitive ? 'i' : ''); } catch (error) { return `Invalid regular expression: ${error.message}`; }
      const filter = glob ? globToRegExp(glob.includes('/') ? glob : `**/${glob}`) : null;
      const candidates = all.filter((file) => (!scope || file === scope || file.startsWith(`${scope.replace(/\/$/, '')}/`)) && (!filter || filter.test(file)));
      const output = [];
      for (const file of candidates) {
        const lines = text(file).split('\n');
        const hits = lines.flatMap((line, index) => regex.test(line) ? [index] : []);
        if (!hits.length) continue;
        if (output_mode === 'files_with_matches') { output.push(file); continue; }
        if (output_mode === 'count') { output.push(`${file}:${hits.length}`); continue; }
        let last = -2;
        for (const hit of hits) {
          const start = Math.max(0, hit - around);
          if (start > last + 1 && output.length && around) output.push('--');
          for (let index = Math.max(start, last + 1); index <= Math.min(lines.length - 1, hit + around); index += 1) {
            output.push(`${file}${index === hit || hits.includes(index) ? ':' : '-'}${numbers ? `${index + 1}${index === hit || hits.includes(index) ? ':' : '-'}` : ''}${lines[index]}`);
            last = index;
          }
        }
      }
      const shown = head_limit ? output.slice(0, head_limit) : output;
      return shown.length ? shown.join('\n') : 'No matches found';
    },
    Glob({ pattern, path: within = '' }) {
      const base = clean(within);
      const regex = globToRegExp(base ? `${base}/${clean(pattern)}` : clean(pattern));
      const matches = all.filter((file) => regex.test(file));
      return matches.length ? matches.join('\n') : 'No files found';
    },
  };
}

export const readLines = (output) => output.split('\n').map((line) => line.replace(/^\s*\d+\t/, ''));
export const grepHits = (output) => output.split('\n').flatMap((line) => {
  const match = line.match(/^(.+?):(\d+):(.*)$/);
  return match ? [{ file: match[1], line: Number(match[2]), text: match[3] }] : [];
});

// ── the tasks, as the user asks them ──────────────────────────────────────

/** Each task's request, worded identically for the offline and the live benchmark. */
export function taskPrompts(truth, oldBillingRev) {
  const discountLines = `${truth.discount.start}-${truth.discount.start + 11}`;
  const citedLines = `${truth.discount.originalStart}-${truth.discount.originalStart + 11}`;
  const repeated = REPEATED_RANGES;
  return {
    'code-range-known': `Show lines ${discountLines} of Shop/lib/billing.py exactly.`,
    'code-duplicate-named': 'Show lines 10-20 of app.py in the Admin folder.',
    'code-duplicate-ambiguous': 'Show lines 1-5 of app.py.',
    'code-function-lookup': 'Show the full apply_discount function.',
    'code-multi-function': 'Show the definitions of normalize_sku, retry_payment and registerRoutes.',
    'code-config-key': 'Where is MAX_RETRIES defined, and what is its value?',
    'code-repeated-inspections': `Show lines ${repeated.map(([first, last]) => `${first}-${last}`).join(', ')} of Shop/lib/billing.py.`,
    'code-stale-reference': `Earlier you cited Shop/lib/billing.py lines ${citedLines} at revision ${oldBillingRev}. Quote exactly those lines as they were then.`,
    'code-modified-on-disk': 'Show lines 1-3 of Shop/web/routes.js as the file is now (it was just edited).',
    'doc-short-file': 'When is the vendor review scheduled, according to Finance/notes/short_note.md?',
    'doc-long-fact': 'What was the warranty reserve at year end, according to the annual report?',
    'doc-large-table': 'What is the balance of Account 104233 in the ledger?',
    'doc-identifier': 'Find invoice INV-2025-00417: which customer, and what amount?',
    'doc-ambiguous-sources': 'What is the North division\'s FY2025 revenue?',
    'doc-related-facts': 'For the South division in the approved budget, give Revenue, Reporting period and Headcount.',
    'doc-missing': 'What is the West division\'s revenue?',
    'doc-history': 'What was the North division\'s planning revenue before the latest change to the planning budget?',
    'doc-multi-batch': 'Give: (a) the balance of Account 120001, (b) the customer of INV-2025-01200, (c) the year-end warranty reserve, (d) the vendor review date, (e) the East division approved revenue, (f) the Central division planning headcount.'
  };
}

/** The ranges the repeated-inspection task asks for. */
export const REPEATED_RANGES = [[300, 310], [900, 910], [1500, 1510], [2400, 2410], [2900, 2910]];

// ── the library ────────────────────────────────────────────────────────────

/**
 * Builds the corpus in a new temporary folder, adds it to a fresh library,
 * then records history (a budget value and a code file change once) and
 * leaves one edit on disk the index has not seen. The app stays open.
 */
export async function prepareLibrary() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-bench-')));
  const actor = { id: 'human:bench', displayName: 'Benchmark', actorType: 'HUMAN_SELF' };
  const { files, truth } = buildCorpus(root);
  const dataDir = path.join(root, 'library');
  const app = createApplication({ dataDir, watchProjects: false, port: 0 });
  const indexStarted = performance.now();
  await app.workspace.add(['Shop', 'Admin', 'Finance'].map((name) => path.join(root, name)), actor);
  const indexMs = performance.now() - indexStarted;
  const folders = Object.fromEntries(app.workspace.state().directories.map((directory) => [directory.name, directory.id]));

  // History: the planning budget changes once, and billing.py gains a header.
  const oldBillingRev = app.timeline.snapshotFile(app.timeline.getProject(folders.Shop).currentSnapshotId, 'lib/billing.py').contentHash.slice(0, 12);
  truth.northPlanningBefore = (10 + 2.4).toFixed(1);
  truth.northPlanningNow = '13.1';
  const planning = path.join(root, 'Finance', 'Planning', 'budget_2025.csv');
  fs.writeFileSync(planning, fs.readFileSync(planning, 'utf8').replace(`North division,${truth.northPlanningBefore},`, 'North division,13.1,'));
  const billingPath = path.join(root, 'Shop', 'lib', 'billing.py');
  fs.writeFileSync(billingPath, `# Reviewed 2026-10\n# Owner: payments\n${fs.readFileSync(billingPath, 'utf8')}`);
  app.timeline.capture(folders.Finance, actor);
  app.timeline.capture(folders.Shop, actor);
  app.dependencies.ensureIndex(folders.Finance);
  app.dependencies.ensureIndex(folders.Shop);
  // An edit the index has not seen yet (the app is not watching).
  const routesPath = path.join(root, 'Shop', 'web', 'routes.js');
  fs.writeFileSync(routesPath, `// Routes, rewritten 2026-10-27\n${fs.readFileSync(routesPath, 'utf8')}`);
  const routesNow = fs.readFileSync(routesPath, 'utf8').split('\n').slice(0, 3).join('\n');
  // The corpus as it now is on disk.
  const current = Object.fromEntries(Object.keys(files).map((relative) => [relative, fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8')]));
  truth.discount.originalStart = truth.discount.start;
  truth.discount.start += 2;
  truth.discount.end += 2;

  return { root, dataDir, app, actor, folders, truth, files: current, oldBillingRev, routesNow, indexMs };
}
