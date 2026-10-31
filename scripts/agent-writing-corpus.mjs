// A small company's shared folders, for writing tasks: the requests people
// give an assistant ("email the team our Q4 revenue") rather than lookups.
// Spreadsheets (.xlsx), PDF board reports, Word memos, STEP CAD parts and a
// real IFC building model, all generated from fixed data (the IFC and one
// STEP part are public test files), so every fact a draft needs is known.
//
// Each task lists the facts a correct draft must state, as patterns that
// accept the usual ways of writing them, and the asks a model would send
// Lasso for it. The asks were written before Lasso was changed for these
// tasks and are kept as they were; Lasso was then changed while looking at
// them. Two held-out sets were each written before they were first run: the
// first after those changes (Lasso was then changed again while looking at
// its misses), the second after that, and not looked at before its run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../src/server.js';
import { storedZip, workbook } from '../test/fixtures/workbook.js';
import { bracketPart, fixtureAssembly } from '../test/fixtures/step-models.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DRAWINGS = path.join(ROOT, 'test', 'fixtures', 'drawings');

// ── file builders ──────────────────────────────────────────────────────────

/** A text PDF, one list of lines per page. */
function pdfDocument(title, pages) {
  const escape = (text) => text.replace(/[\\()]/g, (character) => `\\${character}`);
  const fontId = 3 + pages.length * 2;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  pages.forEach((lines, index) => {
    const stream = `BT /F1 11 Tf 15 TL 72 740 Td ${lines.map((line) => `(${escape(line)}) Tj T*`).join(' ')} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${4 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Title (${escape(title)}) /Author (Northwind Finance) >>`);
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => { offsets[index + 1] = Buffer.byteLength(pdf); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

/** A Word document of plain paragraphs. */
function wordDocument(title, paragraphs) {
  const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`).join('');
  return storedZip({
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body>${body}</w:body></w:document>`,
    'docProps/core.xml': `<?xml version="1.0"?><cp:coreProperties xmlns:cp="cp" xmlns:dc="dc" xmlns:dcterms="dcterms"><dc:title>${escape(title)}</dc:title><dc:creator>Northwind</dc:creator></cp:coreProperties>`,
  });
}

// ── the company's data ─────────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const REVENUE = [410200, 398750, 455900, 470300, 462100, 488400, 501250, 495800, 512600, 538900, 551300, 604750];
const COST_RATIO = [0.64, 0.63, 0.63, 0.62, 0.62, 0.61, 0.62, 0.62, 0.61, 0.62, 0.61, 0.60];
const NEW_CUSTOMERS = [31, 28, 36, 40, 38, 44, 47, 45, 49, 52, 55, 63];
const COST = REVENUE.map((value, index) => Math.round(value * COST_RATIO[index]));
const MARGIN = REVENUE.map((value, index) => value - COST[index]);
const sum = (values) => values.reduce((total, value) => total + value, 0);
const quarter = (values, q) => sum(values.slice(q * 3, q * 3 + 3));

const DEPARTMENTS = [
  // name, draft budget, final budget, headcount
  ['Marketing', 120000, 95000, 6], ['Engineering', 640000, 655000, 24], ['Sales', 310000, 310000, 11],
  ['Operations', 205000, 198000, 9], ['Support', 140000, 140000, 7],
];

const millions = (value) => (value / 1e6).toFixed(2);
const percent = (value) => `${Math.round(value * 100)}%`;

export function writingTruth() {
  const quarters = [0, 1, 2, 3].map((q) => ({ revenue: quarter(REVENUE, q), margin: quarter(MARGIN, q) }));
  return { months: MONTHS, revenue: REVENUE, cost: COST, margin: MARGIN, quarters, total: sum(REVENUE),
    q4Growth: quarters[3].revenue / quarters[2].revenue - 1, q3Growth: quarters[2].revenue / quarters[1].revenue - 1, departments: DEPARTMENTS };
}

/**
 * Builds the folders under `root`. Returns the truth and, per file, the text
 * a file-reading agent gets from converting it (CSV for a workbook, the text
 * of a PDF or Word file, the file itself for STEP and IFC, which are text).
 */
export function buildWritingCorpus(root) {
  const truth = writingTruth();
  const plain = {};
  const write = (relative, data, text = null) => {
    const target = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    plain[relative] = text ?? String(data);
  };
  const csv = (rows) => Object.values(rows).map((cells) => cells.join(',')).join('\n');
  const monthly = { 1: ['Month', 'Revenue', 'Cost of sales', 'Gross margin', 'New customers'] };
  MONTHS.forEach((month, index) => { monthly[index + 2] = [month, String(REVENUE[index]), String(COST[index]), String(MARGIN[index]), String(NEW_CUSTOMERS[index])]; });
  write('Finance/Revenue 2025.xlsx', workbook('Monthly', monthly), csv(monthly));
  const budget = (column) => ({ 1: ['Department', 'Budget', 'Headcount'],
    ...Object.fromEntries(DEPARTMENTS.map((row, index) => [index + 2, [row[0], String(row[column]), String(row[3])]])) });
  write('Finance/Budget 2026 draft.xlsx', workbook('Budget', budget(1)), csv(budget(1)));
  write('Finance/Budget 2026 final.xlsx', workbook('Budget', budget(2)), csv(budget(2)));

  const [q1, q2, q3, q4] = truth.quarters;
  const pdf = (relative, title, pages) => write(relative, pdfDocument(title, pages), pages.flat().join('\n'));
  const word = (relative, title, paragraphs) => write(relative, wordDocument(title, paragraphs), paragraphs.join('\n'));
  pdf('Finance/Q3 2025 Board Report.pdf', 'Q3 2025 Board Report', [[
    'Q3 2025 Board Report', '',
    `Third-quarter revenue was $${millions(q3.revenue)} million, up ${percent(truth.q3Growth)} on the second quarter.`,
    `Gross margin for the quarter was ${(q3.margin / q3.revenue * 100).toFixed(1)}%.`,
    'September was the strongest month of the quarter.',
    'We hired four engineers and opened a second warehouse in Leeds.', '',
    'Risks: freight costs rose 9% and one large customer delayed its renewal to January.',
  ]]);
  pdf('Finance/Q4 2025 Board Report.pdf', 'Q4 2025 Board Report', [[
    'Q4 2025 Board Report', '',
    `Fourth-quarter revenue was $${millions(q4.revenue)} million, up ${percent(truth.q4Growth)} on the third quarter.`,
    `December was the strongest month of the year at $${REVENUE[11].toLocaleString('en-US')}, driven by holiday orders.`,
    `Gross margin for the quarter was ${(q4.margin / q4.revenue * 100).toFixed(1)}%, the best of the year.`,
    'The North region grew fastest, at 18%; the South region was flat.',
    'We added 170 new customers in the quarter.', '',
    'Operations: the Leeds warehouse reached full capacity in November.',
  ], [
    'Outlook', '',
    'We expect Q1 2026 revenue of $1.55 million to $1.60 million, reflecting the usual post-holiday slowdown.',
    'The 2026 budget was approved by the board on 9 December.',
    'Risks: one supplier, Brightline Plastics, is on an improvement plan after quality holds.',
  ]]);
  word('Operations/Supplier review memo.docx', 'Supplier review, November 2025', [
    'Supplier review, November 2025',
    'Acme Castings delivered 96% of orders on time this year, above our 95% target.',
    'Brightline Plastics delivered 88% of orders on time and had two quality holds in October.',
    'Recommendation: renew Acme Castings for 2026 and put Brightline Plastics on a 90-day improvement plan.',
    'The Acme Castings contract renews on 31 January 2026.',
    'Prepared by the purchasing team for the operations meeting.',
  ]);
  word('Operations/Meeting notes 2025-12-04.docx', 'Operations meeting, 4 December 2025', [
    'Operations meeting, 4 December 2025',
    'Attendees: Priya Shah, Tom Okafor, Lena Fischer, Sam Ortiz.',
    'Priya Shah will send the final 2026 budget to the department heads by 12 December.',
    'Tom Okafor will confirm the bracket drawing with Acme Castings by 10 December.',
    'Lena Fischer will book the facilities walkthrough of the new office by 19 December.',
    'Decision: the spring promotion launches on 3 March 2026.',
  ]);
  write('Engineering/bracket.step', bracketPart());
  write('Engineering/fixture assembly.step', fixtureAssembly());
  write('Engineering/nist_ctc_01.stp', fs.readFileSync(path.join(DRAWINGS, 'nist_ctc_01_asme1_rd.stp')));
  write('Facilities/FZK-Haus.ifc', fs.readFileSync(path.join(DRAWINGS, 'AC20-FZK-Haus.ifc')));
  return { truth, plain };
}

// ── tasks ──────────────────────────────────────────────────────────────────

/** A number as people write it: 604750, 604,750 or $604,750. */
const amount = (value) => new RegExp(`\\b${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',?')}\\b`);
/** 1694950 as 1.69 million, $1.69M or the full figure. */
const inMillions = (value) => new RegExp(`(?:\\b${millions(value).replace('.', '\\.')}\\s*(?:m\\b|mn\\b|million))|${amount(value).source}`, 'i');

export function writingTasks() {
  const truth = writingTruth();
  const [, , q3, q4] = truth.quarters;
  const fact = (label, pattern) => ({ label, pattern });
  const monthsRevenue = MONTHS.map((month, index) => fact(`${month} revenue`, amount(REVENUE[index])));
  const monthsMargin = MONTHS.map((month, index) => fact(`${month} gross margin`, amount(MARGIN[index])));
  return [
    { id: 'q4-revenue-email', files: ['Finance/Revenue 2025.xlsx', 'Finance/Q4 2025 Board Report.pdf', 'Finance/Q3 2025 Board Report.pdf'],
      prompt: 'Write a short email to the leadership team summarising our Q4 2025 revenue: the total, how it compared with Q3, and the best month.',
      facts: [fact('Q4 revenue', inMillions(q4.revenue)), fact('growth on Q3', new RegExp(`\\b${Math.round(truth.q4Growth * 100)}(?:\\.\\d)?\\s*%`)),
        fact('best month', /December/), fact('December revenue', amount(REVENUE[11]))],
      heldOut1: [['Q4 revenue and growth vs Q3'], ['October to December 2025 revenue', 'fourth quarter results']],
      heldOut2: [['revenue in the last quarter of 2025', 'how did Q4 compare to Q3', 'strongest month in Q4'], ['Q4 2025 Board Report.pdf', 'Revenue 2025.xlsx']],
      asks: [['Q4 2025 revenue', 'Q3 2025 revenue', 'best month in Q4 2025'],
        ['total revenue for Q4 2025 and how it compares with Q3', 'which month in Q4 2025 had the highest revenue']] },
    { id: 'top-months-newsletter', files: ['Finance/Revenue 2025.xlsx'],
      prompt: 'Which months of 2025 had the highest revenue? Write two sentences for the company newsletter.',
      facts: monthsRevenue,
      heldOut1: [['revenue by month for 2025'], ['best performing months of 2025']],
      heldOut2: [['monthly revenue figures 2025'], ['Revenue 2025.xlsx Revenue column']],
      asks: [['2025 monthly revenue'], ['which months had the highest revenue in 2025', 'Revenue 2025.xlsx']] },
    { id: 'quarterly-margin-email', files: ['Finance/Revenue 2025.xlsx'],
      prompt: 'Email the finance team the gross margin for each quarter of 2025, as amounts and percentages.',
      facts: [...monthsRevenue, ...monthsMargin],
      heldOut1: [['quarterly gross margin 2025', 'quarterly revenue 2025'], ['Revenue 2025.xlsx gross margin and revenue']],
      heldOut2: [['margin and revenue per month in 2025'], ['Q1 Q2 Q3 Q4 2025 gross margin and revenue']],
      asks: [['gross margin by month 2025', 'revenue by month 2025'], ['gross margin for each quarter of 2025']] },
    { id: 'annual-total-line', files: ['Finance/Revenue 2025.xlsx'],
      prompt: 'Write one line for the annual report giving total revenue for 2025.',
      facts: monthsRevenue,
      heldOut1: [['full year 2025 revenue'], ['sum of monthly revenue in 2025']],
      heldOut2: [['2025 revenue total for the year'], ['what did we earn in 2025']],
      asks: [['total revenue 2025'], ['2025 revenue by month']] },
    { id: 'budget-note', files: ['Finance/Budget 2026 final.xlsx', 'Finance/Budget 2026 draft.xlsx'],
      prompt: 'Write a note to the department heads giving each department\'s 2026 budget.',
      // The final budget's figures, told apart from the draft's: the final file must be named beside them.
      facts: [...DEPARTMENTS.map(([name, , final]) => fact(`${name} final budget`, amount(final))), fact('final file named', /final/i)],
      heldOut1: [['department budgets for 2026'], ['Budget 2026 final.xlsx']],
      heldOut2: [['2026 budgets by department, final version'], ['how much budget does each department get in 2026']],
      asks: [['2026 budget for each department'], DEPARTMENTS.map(([name]) => `${name} 2026 budget`)] },
    { id: 'q1-outlook-sentence', files: ['Finance/Q4 2025 Board Report.pdf'],
      prompt: 'Draft a sentence for the investor update giving our Q1 2026 revenue outlook.',
      facts: [fact('low end', /1\.55/), fact('high end', /1\.6/)],
      heldOut1: [['what do we expect for Q1 2026 revenue'], ['outlook section of the Q4 board report']],
      heldOut2: [['Q1 2026 forecast'], ['guidance for next quarter']],
      asks: [['Q1 2026 revenue outlook'], ['revenue guidance for the first quarter of 2026']] },
    { id: 'west-region-email', files: ['Finance/Q4 2025 Board Report.pdf'], absent: true,
      prompt: 'Write an email about West region sales in Q4 2025.',
      // Nothing is said about a West region; the draft must say so rather than invent one.
      facts: [fact('regions that are reported', /North/)],
      heldOut1: [['West region Q4 2025 revenue'], ['regional performance in Q4 2025']],
      heldOut2: [['West region'], ['sales in the western region']],
      asks: [['West region sales Q4 2025'], ['Q4 2025 sales by region']] },
    { id: 'supplier-bullets', files: ['Operations/Supplier review memo.docx'],
      prompt: 'Summarise the supplier review for the purchasing team in three bullet points.',
      facts: [fact('Acme on time', /96\s*%/), fact('Brightline on time', /88\s*%/), fact('recommendation', /improvement plan/i),
        fact('renewal date', /31 January 2026/)],
      heldOut1: [['supplier performance review November 2025'], ['Acme Castings and Brightline Plastics on-time delivery']],
      heldOut2: [['supplier review findings and recommendation'], ['Operations/Supplier review memo.docx']],
      asks: [['supplier review'], ['Supplier review memo.docx']] },
    { id: 'meeting-actions-email', files: ['Operations/Meeting notes 2025-12-04.docx'],
      prompt: 'Turn the action items from the 4 December meeting into an email with owners and deadlines.',
      facts: [fact('Priya deadline', /12 December/), fact('Tom deadline', /10 December/), fact('Lena deadline', /19 December/),
        fact('owners', /Priya[\s\S]*Tom[\s\S]*Lena|Lena[\s\S]*Tom[\s\S]*Priya/)],
      heldOut1: [['what was agreed at the operations meeting on 4 December'], ['who owns what after the December operations meeting']],
      heldOut2: [['meeting notes from 4 December 2025'], ['4 December actions, owners and deadlines']],
      asks: [['action items from the 4 December meeting'], ['Meeting notes 2025-12-04.docx']] },
    { id: 'bracket-spec', files: ['Engineering/bracket.step'],
      prompt: 'Write a short spec for the supplier quoting the bracket: its overall size and its hole sizes.',
      facts: [fact('length', /\b100\b/), fact('width', /\b60\b/), fact('thickness', /\b10\b/), fact('large hole', /(?:Ø|⌀|diameter\s*)12\b|\b12\s*mm/i),
        fact('small hole', /(?:Ø|⌀|diameter\s*)8\b|\b8\s*mm/i)],
      heldOut1: [['bracket size and holes'], ['bracket.step overall extents and hole diameters']],
      heldOut2: [['bracket dimensions and hole diameters'], ['Engineering/bracket.step']],
      asks: [['bracket overall dimensions', 'bracket hole diameters'], ['bracket.step']] },
    { id: 'assembly-parts-email', files: ['Engineering/fixture assembly.step'],
      prompt: 'List the parts in the fixture assembly with their sizes and quantities, for a bill-of-materials email.',
      facts: [fact('bracket size', /100\s*[×x]\s*60\s*[×x]\s*10/), fact('pin', /Pin/), fact('two pins', /\b2\b[^\n]*(?:instance|×|x|pins?)|(?:Pin)[^\n]*\b2\b/i),
        fact('pin size', /\b6\b[\s\S]*\b(?:24|27)\b/)],
      heldOut1: [['bill of materials for the fixture assembly'], ['what parts make up the fixture']],
      heldOut2: [['fixture assembly parts and quantities'], ['components of the fixture assembly with sizes']],
      asks: [['parts in the fixture assembly'], ['fixture assembly.step']] },
    { id: 'house-rooms-brochure', files: ['Facilities/FZK-Haus.ifc'],
      prompt: 'Write a short description of the house model for a facilities brochure: its rooms and their floor areas.',
      // Net floor areas as the model stores them; a draft may round them to one or two decimals.
      facts: [['Schlafzimmer', 21.410325], ['Bad', 12.127619], ['Buero', 12.59545], ['Wohnen', 25.2088935], ['Flur', 11.185458], ['Küche', 16.30545],
        ['Galerie', 74.5092415823]].map(([room, area]) => fact(`${room} ${area.toFixed(2)} m²`, new RegExp(`${room}[\\s\\S]{0,200}?\\b(?:${
          [area.toFixed(2), (Math.floor(area * 100) / 100).toFixed(2), `${area.toFixed(1)}(?!\\d)`].map((value) => value.replace('.', '\\.')).join('|')})`))),
      heldOut1: [['floor area of each room in FZK-Haus'], ['FZK-Haus.ifc rooms']],
      heldOut2: [['FZK-Haus rooms with net floor area'], ['room areas in the house']],
      asks: [['rooms and floor areas in the house model'], ['FZK-Haus.ifc']] },
  ];
}

// ── the library ────────────────────────────────────────────────────────────

/** The folders, added to a fresh library and indexed. */
export async function prepareWritingLibrary() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-writing-')));
  const { truth, plain } = buildWritingCorpus(root);
  const dataDir = path.join(root, 'library');
  const app = createApplication({ dataDir, watchProjects: false, port: 0 });
  const actor = { id: 'human:bench', displayName: 'Benchmark', actorType: 'HUMAN_SELF' };
  await app.workspace.add(['Finance', 'Operations', 'Engineering', 'Facilities'].map((name) => path.join(root, name)), actor);
  for (const directory of app.workspace.state().directories) app.dependencies.ensureIndex(directory.id);
  return { root, dataDir, app, truth, plain };
}
