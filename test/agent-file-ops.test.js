import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { openEngine } from '../src/agent/engine.js';
import { formatAnswer } from '../src/agent/render.js';
import { askTextOptions } from '../src/agent/mcp.js';
import { operationsAsked, operationsWritten } from '../src/agent/op-words.js';
import { agentLibrary } from './fixtures/agent-library.js';
import { flangeAssembly } from './fixtures/step-models.js';
import { sequenceVariant } from '../scripts/agent-live/sequence-variants.mjs';

// The two fresh workbooks at a tenth of their size: the same sheets, formulas and planted errors, quick to index.
const VARIANTS = [sequenceVariant('payroll', { rows: 240, cut: 200 }), sequenceVariant('stock', { rows: 180, cut: 150 })];
const numbersIn = (text) => [...String(text).replace(/(\d),(?=\d{3}\b)/g, '$1').matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Math.abs(Number(match[0])));
const has = (text, value) => numbersIn(text).some((number) => Math.abs(number - Math.abs(value)) <= 0.011);

// A contract as a PDF writes one: numbered chapters and sections set apart as headings, cross-references, defined terms.
function contractPdf() {
  const blocks = [['h', '1. Definitions'], ['h', '1.1 Business Day'], ['p', '“Business Day” means a day other than a Saturday, a Sunday or a statutory holiday.'],
    ['h', '1.2 Site'], ['p', '“Site” means the Buyer\'s plant in Hamilton.'],
    ['h', '5. Price and Payment'], ['h', '5.1 Prices'], ['p', 'Prices are fixed for the Term.'],
    ['h', '5.2 Payment'], ['p', 'The Buyer shall pay each invoice within 30 days, subject to Section 9.7 and to Section 5.1.'],
    ['h', '9. Termination'], ['h', '9.3 Sums due'], ['p', 'On termination all sums fall due within five Business Days, as set out in Section 5.2.'],
    ['h', '9.4 Survival'], ['p', 'Section 5.2 survives termination.']];
  const escape = (text) => text.replace(/[\\()]/g, (character) => `\\${character}`).replace(/[“”]/g, '"').replace(/’/g, "'");
  const stream = `BT 60 750 Td 16 TL ${blocks.map(([kind, text]) => `/F${kind === 'h' ? 2 : 1} ${kind === 'h' ? 13 : 10} Tf (${escape(text)}) Tj T* T*`).join(' ')} ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1');
}

// One library for every test here, indexed once: both workbooks, the contract and the assembly.
let shared;
const cleanups = [];
before(async () => {
  const [payroll, stock] = VARIANTS;
  const { dataDir } = await agentLibrary({ after: (cleanup) => cleanups.push(cleanup) }, { extra: { 'Finance/Timesheets 2026.xlsx': payroll.buffer,
    'Finance/Stock movements.xlsx': stock.buffer, 'Finance/Contracts/Supply agreement.pdf': contractPdf(), 'Finance/Tooling/flange.step': flangeAssembly() } });
  const engine = openEngine({ dataDir, scope: ['*'] });
  cleanups.push(() => engine.close());
  shared = { engine, ask: (...asks) => engine.evidence.ask({ ask: asks }, null, { mcp: true }),
    text: (response) => formatAnswer('ask', response, 'text', askTextOptions(['lasso'])) };
});
after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
// The revision a what-if answer made, as a model reads it from the answer.
const revisionOf = (answer) => answer.items[0].rev;

test('a workbook\'s cells are read with their formulas, anywhere on the sheet, and a query can ask about a cell\'s formula', async (t) => {
  // Arrange
  const [payroll] = VARIANTS;
  const { ask, text } = shared;
  const { cells } = payroll.truth;

  // Act
  const response = ask(`Timesheets 2026.xlsx Roll-up!${cells.total}`, 'Timesheets 2026.xlsx Roll-up!B3', 'SELECT COUNT(*) FROM Shifts WHERE KIND(Cost) = \'formula\'',
    'SELECT FORMULA(Cost), CALC(Cost) FROM Shifts WHERE "Shift ID" = \'SH-00001\'', 'formulas in Timesheets 2026.xlsx');
  const [total, rate, kinds, formula, formulas] = response.answers;

  // Assert
  assert.deepEqual([total.kind, total.items[0].cells[0].formula], ['cells', '=SUM(Shifts!H2:H200)'], 'the range that stops short is there to be read');
  assert.ok(has(total.items[0].cells[0].value, payroll.truth.truncated));
  assert.deepEqual(rate.items[0].cells, [{ at: 'B3', value: '0.22' }], 'a cell above the table has a value, and no column or row label');
  assert.deepEqual(kinds.items[0].rows, [[240]]);
  assert.equal(formula.items[0].rows[0][0], '=F2*G2');
  assert.deepEqual([formulas.kind, formulas.items[0].op], ['operation', 'formulas']);
  assert.match(formulas.items[0].text, /=SUM\(Shifts!H2:H200\)/);
  assert.match(text(response), /^\[1\] s1 Roll-up!B11 "Cost" of "All sites": "\d+(?:\.\d+)?" =SUM\(Shifts!H2:H200\)$/m);
});

test('what a cell feeds, and what every cell would be with a formula or a value changed, are worked out without changing the file', async (t) => {
  // Arrange
  const [payroll] = VARIANTS;
  const { ask, text } = shared;
  const file = 'Timesheets 2026.xlsx';

  // Act
  const first = ask({ file, op: 'deps', cell: 'Roll-up!B3', dir: 'dependents' },
    { file, op: 'whatif', formulas: { 'Roll-up!B11': '=SUM(Shifts!H2:H241)' }, show: ['Roll-up!B11', 'Roll-up!B12', 'Roll-up!B13'] });
  const rev = revisionOf(first.answers[1]);
  const second = ask({ file, op: 'whatif', base: rev, set: { 'Roll-up!B3': 0.25 }, show: ['Roll-up!B13'] }, { file, op: 'cells', range: 'Roll-up!B11', rev },
    { file, op: 'pivot' }, 'Timesheets 2026.xlsx Roll-up!B11');
  const response = { ...first, answers: [...first.answers, ...second.answers] };
  const [deps, corrected, changed, onRevision, unknown, original] = response.answers;

  // Assert
  assert.deepEqual(response.answers.slice(0, 4).map((answer) => [answer.kind, answer.status]), Array(4).fill(['operation', 'complete']));
  assert.match(deps.items[0].text, /Roll-up!B12:B13/);
  assert.ok(payroll.truth.corrected.every((value) => has(corrected.items[0].text, value)), corrected.items[0].text);
  assert.ok(has(changed.items[0].text, payroll.truth.changed), changed.items[0].text);
  assert.ok(has(onRevision.items[0].text, payroll.truth.all));
  assert.deepEqual([unknown.kind, unknown.error.code], ['error', 'unsupported']);
  assert.match(unknown.error.message, /its operations are: cells range/);
  assert.equal(original.items[0].cells[0].formula, '=SUM(Shifts!H2:H200)', 'the file itself is as it was');
  assert.match(text(first), /^\[2\] s1 whatif on r\d+: exact, over /m);
});

for (const variant of VARIANTS) {
  test(`the ${variant.id} sequence is answerable step by step from what Lasso returns, on a workbook made after everything it uses`, async (t) => {
    // Arrange
    const { ask, text } = shared;
    const file = variant.path.split('/')[1];
    const { truth, profile } = variant;
    const { data, summary } = profile;
    const sheet = /\W/.test(summary.sheet) ? `'${summary.sheet}'` : summary.sheet;
    const amount = data.columns.at(-1);
    const group = data.columns[3];
    const cell = (name) => `${sheet}!${truth.cells[name]}`;

    // Act: what a model would ask at each of the five steps.
    const first = text(ask(`${file} ${cell('total')}`, `${file} ${data.sheet} sheet total of the ${amount} column`));
    const second = text(ask(`SELECT COUNT(*), SUM(${amount}) FROM ${data.sheet} WHERE ROW() > ${profile.cut}`));
    const corrected = ask({ file, op: 'whatif', formulas: { [cell('total')]: `=SUM(${data.sheet}!H2:H${truth.lastRow})` }, show: [cell('total'), cell('after'), cell('converted')] });
    const rev = revisionOf(corrected.answers[0]);
    const third = text(corrected);
    const fourth = text(ask({ file, op: 'cells', range: `${sheet}!${truth.cells.groups}`, rev }, `distinct ${group} values in ${data.sheet} with counts in ${file}`,
      `total ${amount} for ${data.sheet} rows where ${group} = ${truth.misspeltValue} in ${file}`));
    const fifth = text(ask({ file, op: 'whatif', base: rev, set: { [`${sheet}!${truth.cells.rate}`]: profile.change }, show: [cell('converted')] }));

    // Assert
    assert.ok(has(first, truth.truncated) && has(first, truth.all), first);
    assert.match(first, new RegExp(`=SUM\\(${data.sheet}!H2:H${profile.cut}\\)`), 'the formula shows where its range stops');
    assert.ok(has(second, truth.difference) && has(second, truth.omitted), second);
    assert.ok(truth.corrected.every((value) => has(third, value)), third);
    assert.ok(fourth.includes(truth.misspeltValue) && has(fourth, truth.misspeltAmount), fourth);
    assert.ok(has(fifth, truth.changed), fifth);
  });
}

test('a contract\'s sections, cross-references and defined terms are operations over the whole document, asked by name or in plain words', async (t) => {
  // Arrange
  const { ask, text } = shared;
  const file = 'Supply agreement.pdf';

  // Act
  const response = ask({ file, op: 'outline' }, 'broken cross-references in Supply agreement.pdf', 'what refers to Section 5.2 in Supply agreement.pdf',
    { file, op: 'terms', name: 'Business Day' }, { file, op: 'whatif', renumber: { '5.1': '5.8' } }, 'the text of Section 9.3 in Supply agreement.pdf');
  const [outline, broken, refs, terms, renumbered, read] = response.answers.map((answer) => answer.items?.[0]);

  // Assert
  assert.deepEqual(response.answers.map((answer) => answer.kind), Array(6).fill('operation'), JSON.stringify(response.answers.map((answer) => answer.error?.message)));
  assert.match(outline.text, /5\.2 Payment/);
  assert.deepEqual([broken.op, /9\.7 does not exist/.test(broken.text), /5\.1 does not exist/.test(broken.text)], ['refs', true, false]);
  assert.match(refs.text, /9\.3/);
  assert.match(refs.text, /9\.4/);
  assert.match(terms.text, /defined in 1\.1/);
  assert.match(terms.text, /9\.3/);
  assert.match(renumbered.text, /5\.1/, 'renumbering 5.1 breaks the reference to it');
  assert.match(read.text, /five Business Days/);
  assert.match(text(response), /^\[2\] s1 refs: exact, over \d+ explicit references? in the whole file$/m);
});

test('an assembly is counted over every level, measured and checked for interference; one part has no such operations', async (t) => {
  // Arrange
  const { ask } = shared;

  // Act
  const response = ask('how many bolts are in flange.step, and what is its overall size?', { file: 'flange.step', op: 'find', where: 'zmax > 30' },
    'do any parts overlap in flange.step?');
  const [counted, found, clash] = response.answers;

  // Assert
  assert.deepEqual(counted.items.map((item) => item.op), ['bounds', 'count']);
  assert.match(counted.items[1].text, /Bolt 8/);
  assert.match(counted.items[0].text, /size 112 × 72 × /);
  assert.equal(found.kind, 'operation');
  assert.deepEqual([clash.kind, clash.items[0].op], ['operation', 'clash']);
  assert.match(clash.items[0].text, /^0 interpenetrating pairs$/m);
  assert.doesNotMatch(clash.items[0].text, /clearance/);
});

test('pairs that overlap come with how to ask what would clear them: how deep they overlap is not how far to move one', async (t) => {
  // Arrange: the first bolt moved onto the second.
  const { ask } = shared;

  // Act
  const [moved] = ask('flange.step whatif move:{"Bolt:1":{dx:-7.3,dy:17.7}}; clash').answers;

  // Assert
  assert.deepEqual(moved.items.map((item) => item.op), ['whatif', 'clash'], JSON.stringify(moved));
  assert.match(moved.items[1].text, /^1 interpenetrating pair:\n\s+(Bolt:[12]) × (Bolt:[12]): depth [^\n]+\n\s+\(depth is how deep a pair interpenetrates[^\n]*clearance move:"\1" from:"\2" dir:\[0,0,1\]/m);
});

test('plain words mean an operation only when they say it outright', () => {
  // Arrange
  const conveyor = { occurrences: ['Frame:1', 'Frame:1/Cross member:4', 'Roller set:1', 'Roller set:1/Roller assembly:15', 'Roller set:1/Roller assembly:15/Bearing:1',
    'Roller set:1/Roller assembly:16', 'Drive unit:1', 'Drive unit:1/Motor:1', 'Guard:1', 'Guard:1/Guard end panel:1'] };

  // Act and assert
  assert.deepEqual(operationsAsked('document', 'do any cross-references point to a section that does not exist?'), [{ op: 'refs', broken: true }]);
  assert.deepEqual(operationsAsked('document', 'which sections refer to Section 9.4?'), [{ op: 'refs', to: '9.4' }]);
  assert.deepEqual(operationsAsked('document', 'sections that refer by number to Section 3.3'), [{ op: 'refs', to: '3.3' }]);
  assert.deepEqual(operationsAsked('document', 'all sections that mention "Section 5.5"'), [{ op: 'refs', to: '5.5' }]);
  assert.deepEqual(operationsAsked('document', 'how long is the warranty period?'), []);
  assert.deepEqual(operationsAsked('document', 'Section 5.5 mentions a 45-day payment period for tooling'), [], 'a section that mentions something is not a reference to it');
  assert.deepEqual(operationsAsked('document', 'if the definition of “Business Day” in Section 1.3 were changed, which sections would be affected?'),
    [{ op: 'affected', term: 'Business Day', definition: '1.3' }]);
  assert.deepEqual(operationsAsked('document', 'after renumbering Section 9.4 to Section 9.7 and adding Appendix E, which sections still contain broken cross-references?'),
    [{ op: 'whatif', renumber: { 9.4: '9.7' }, add: ['E'] }]);
  assert.deepEqual(operationsAsked('assembly', 'which part instances extend higher than z = 910 mm?'), [{ op: 'find', where: 'zmax > 910' }]);
  assert.deepEqual(operationsAsked('assembly', 'what material is the bracket?'), []);
  assert.deepEqual(operationsAsked('assembly', 'which part instances have zmax > 910 mm, with their part definitions'), [{ op: 'find', where: 'zmax > 910' }], 'a bound written as the operations write it');
  assert.deepEqual(operationsAsked('assembly', 'where zmax > 910 and xmin < 100'), [{ op: 'find', where: 'zmax > 910 and xmin < 100' }]);
  assert.deepEqual(operationsAsked('assembly', 'part instances with z coordinates above 910 mm, and their part definitions'), [{ op: 'find', where: 'zmax > 910' }]);
  assert.deepEqual(operationsAsked('assembly', 'which parts weigh over 20 kg?'), [], 'a number after "over" is a height only where the words say z');
  assert.deepEqual(operationsAsked('assembly', 'how far would Roller assembly:15 have to be raised along +z so that none of its parts overlaps Cross member:4?', conveyor),
    [{ op: 'clearance', move: 'Roller set:1/Roller assembly:15', from: 'Frame:1/Cross member:4', dir: [0, 0, 1] }]);
  const lift = [{ op: 'clearance', move: 'Roller set:1/Roller assembly:15', from: 'Frame:1/Cross member:4', dir: [0, 0, 1] }];
  assert.deepEqual(operationsAsked('assembly', 'the clearance move needed to raise Roller assembly:15 along +z so that none of its parts overlaps Cross member:4; give the exact distance', conveyor), lift);
  assert.deepEqual(operationsAsked('assembly', 'clearance move from Cross member:4 to Roller assembly:15 in +z, and whether all overlaps with Cross member:4 are resolved by that move', conveyor), lift,
    'the part moved clear is the one not named after "from"');
  assert.deepEqual(operationsAsked('assembly', 'what is the clearance between Motor:1 and Guard end panel:1?', conveyor), [{ op: 'distance', a: 'Drive unit:1/Motor:1', b: 'Guard:1/Guard end panel:1' }],
    'a clearance with nothing moved is the gap as it stands');
  assert.deepEqual(operationsAsked('assembly', 'after moving Roller assembly:15 by dz:10 mm and Drive unit by dx:-20 mm, does anything still overlap? '
    + 'Also report the smallest gap between Motor:1 and Guard end panel:1 in that state.', conveyor),
  [{ op: 'whatif', move: { 'Roller set:1/Roller assembly:15': { dz: 10 }, 'Drive unit:1': { dx: -20 } } }, { op: 'distance', a: 'Drive unit:1/Motor:1', b: 'Guard:1/Guard end panel:1' }]);
  assert.deepEqual(operationsAsked('assembly', 'if the Drive unit is moved 20 mm in −x, what overlaps?', conveyor), [{ op: 'whatif', move: { 'Drive unit:1': { dx: -20 } } }]);
  assert.deepEqual(operationsAsked('assembly', 'do any parts of Roller assembly:15 overlap anything?', conveyor), [{ op: 'clash' }], 'naming a part moves nothing');
});

test('operations written loosely, as a model writes them after seeing them named, are read as written', () => {
  // Arrange
  const conveyor = { occurrences: ['Roller set:1/Roller assembly:15', 'Drive unit:1', 'Drive unit:1/Motor:1', 'Guard:1', 'Guard:1/Guard end panel:1'] };
  const moved = { op: 'whatif', move: { 'Roller assembly:15': { dz: 10 }, 'Drive unit:1': { dx: -20 } } };
  const gap = { op: 'distance', a: 'Drive unit:1/Motor:1', b: 'Guard:1/Guard end panel:1' };

  // Act and assert
  assert.deepEqual(operationsWritten('assembly', 'whatif move:{"Roller assembly:15":{"dz":10},"Drive unit:1":{"dx":-20}}; clash all; distance Drive unit:1/Motor:1 Guard:1/Guard end panel:1', conveyor),
    [moved, { op: 'clash' }, gap]);
  assert.deepEqual(operationsWritten('assembly', 'whatif move:{"Roller assembly:15":{dz:10},"Drive unit:1":{dx:-20}} distance Drive unit:1/Motor:1 Guard:1/Guard end panel:1', conveyor), [moved, gap]);
  assert.deepEqual(operationsWritten('assembly', { op: { 'whatif move': moved.move, clash: 'all', distance: ['Drive unit:1/Motor:1', 'Guard:1/Guard end panel:1'] } }, conveyor), [moved, { op: 'clash' }, gap]);
  assert.deepEqual(operationsWritten('assembly', { ops: [{ op: 'count', under: 'Guard:1' }, 'bounds of Drive unit:1'] }, conveyor), [{ op: 'count', under: 'Guard:1' }, { op: 'bounds', of: 'Drive unit:1' }]);
  assert.deepEqual(operationsWritten('document', 'refs to:9.4; affected term:"Business Day" hops:2'), [{ op: 'refs', to: '9.4' }, { op: 'affected', term: 'Business Day', hops: 2 }]);
  assert.deepEqual(operationsWritten('document', 'refs broken'), [{ op: 'refs', broken: true }]);
  assert.deepEqual(operationsWritten('workbook', 'whatif set:{"Summary!B3":0.15} show:["Summary!B14"]'), [{ op: 'whatif', set: { 'Summary!B3': 0.15 }, show: ['Summary!B14'] }]);
  assert.equal(operationsWritten('assembly', 'count every bolt in the whole assembly, at every level', conveyor), null, 'a sentence that starts with an operation\'s name is still a sentence');
  assert.equal(operationsWritten('document', 'find the clause that sets the warranty period'), null);
});

test('an assembly\'s moves, clearances and gaps are worked out from plain words or from operations written after its name', async (t) => {
  // Arrange
  const { ask } = shared;
  const file = 'flange.step';

  // Act
  const named = ask({ file, op: 'clearance', move: 'Sensor:1', from: 'Base:1', dir: [0, 0, 1] }, { file, op: 'distance', a: 'Sensor:1', b: 'Bolt:3' });
  const worded = ask('how far would Sensor:1 have to be raised so that it no longer overlaps Base:1 in flange.step?', 'the gap between the Sensor and Bolt:3 in flange.step',
    'in flange.step, if Sensor:1 were raised by 10 mm and Bolt:1 moved 5 mm in -x, does anything overlap, and what is the smallest gap between Sensor:1 and Base:1?');
  const written = ask('flange.step whatif move:{"Sensor:1":{dz:10}}; clash all; distance Sensor:1 Base:1', { file, op: { 'whatif move': { Sensor: { dz: 10 } }, distance: ['Sensor:1', 'Base:1'] } });
  const [clearance, gap, moved] = worded.answers;
  const [asWords, asObject] = written.answers;

  // Assert
  assert.deepEqual([clearance.items[0].op, clearance.items[0].text], ['clearance', named.answers[0].items[0].text], JSON.stringify(clearance));
  assert.deepEqual([gap.items[0].op, gap.items[0].text], ['distance', named.answers[1].items[0].text], JSON.stringify(gap));
  assert.deepEqual(moved.items.map((item) => item.op), ['whatif', 'distance'], JSON.stringify(moved));
  assert.match(moved.items[0].text, /Sensor:1 moved \(0, 0, 10\) mm; Bolt:1 moved \(-5, 0, 0\) mm/);
  assert.equal(moved.items[1].rev, moved.items[0].rev, 'the gap is measured with the parts moved');
  assert.deepEqual(asWords.items.map((item) => item.op), ['whatif', 'clash', 'distance'], JSON.stringify(asWords));
  assert.ok(asWords.items.every((item) => item.rev === asWords.items[0].rev), 'each operation after a what-if reads its revision');
  assert.deepEqual(asObject.items.map((item) => item.op), ['whatif', 'distance'], JSON.stringify(asObject));
  assert.equal(asObject.items[1].text, asWords.items[2].text, 'a part named without its number is found when only one has that name');
});

test('references, what a changed definition reaches and a renumbering are answered from the words a model asks them in', async (t) => {
  // Arrange
  const { ask } = shared;
  const file = 'Supply agreement.pdf';

  // Act
  const named = ask({ file, op: 'refs', to: '5.2' }, { file, op: 'affected', term: 'Business Day', hops: 2 });
  const response = ask('Supply agreement.pdf: sections that refer by number to Section 5.2', 'Supply agreement.pdf: all sections that mention "Section 5.2"',
    'Supply agreement.pdf: all sections that use the term "Business Day" or refer by number to a section that does',
    'if the definition of "Business Day" in Section 1.1 were changed, which sections of Supply agreement.pdf would be affected?',
    'in Supply agreement.pdf, after renumbering Section 9.4 to Section 9.7 and adding Appendix E, which sections still contain broken cross-references?',
    'Supply agreement.pdf: refs to:5.2; affected term:"Business Day" hops:2');
  const [refer, mention, twoHops, affected, renumbered, written] = response.answers;

  // Assert
  assert.deepEqual(response.answers.map((answer) => answer.kind), Array(6).fill('operation'), JSON.stringify(response.answers.map((answer) => answer.error?.message ?? answer.kind)));
  assert.equal(refer.items[0].text, named.answers[0].items[0].text);
  assert.equal(mention.items[0].text, named.answers[0].items[0].text);
  assert.equal(twoHops.items.find((item) => item.op === 'affected').text, named.answers[1].items[0].text, 'a section that uses the term, or refers to one that does, is two steps');
  assert.match(affected.items.find((item) => item.op === 'affected').text, /reached from the definition of “Business Day” in 1\.1\n.*9\.3/);
  assert.deepEqual([renumbered.items[0].op, /9\.4 renumbered 9\.7; E added/.test(renumbered.items[0].text), /broken references now \(0\)/.test(renumbered.items[0].text)], ['whatif', true, true], renumbered.items[0].text);
  assert.deepEqual(written.items.map((item) => item.text), named.answers.map((answer) => answer.items[0].text));
});

test('a what-if on a workbook asked in plain words is recalculated, with the cells it names', async (t) => {
  // Arrange
  const [payroll] = VARIANTS;
  const { ask } = shared;
  const file = 'Timesheets 2026.xlsx';
  const { cells } = payroll.truth;

  // Act
  const named = ask({ file, op: 'whatif', set: { [`Roll-up!${cells.rate}`]: 0.25 }, show: [`Roll-up!${cells.converted}`] });
  const response = ask(`${file}: with Roll-up!${cells.total} corrected to =SUM(Shifts!H2:H${payroll.truth.lastRow}) and Roll-up!${cells.rate} changed to 0.25, what would Roll-up!${cells.converted} evaluate to?`,
    `in ${file}, if ${cells.rate} were changed to 25%, what would ${cells.converted} become?`, `${file}: what is Roll-up!${cells.rate} and what would it be worth changing?`);
  const [both, rate, read] = response.answers;
  const requested = (answer) => /^requested: .*$/m.exec(answer.items[0].text)?.[0].replace(/→.*$/, '');

  // Assert
  assert.deepEqual([both.kind, both.items[0].op], ['operation', 'whatif'], JSON.stringify(both));
  assert.ok(has(both.items[0].text, payroll.truth.changed), both.items[0].text);
  assert.deepEqual([rate.items[0].op, /→ /.test(rate.items[0].text)], ['whatif', true], JSON.stringify(rate));
  assert.equal(/requested: .*→ (\S+)/.exec(rate.items[0].text)[1], /requested: .*→ (\S+)/.exec(named.answers[0].items[0].text)[1], 'a cell named without its sheet is the one on the sheet where it is a formula\'s input');
  assert.ok(requested(rate));
  assert.equal(read.kind, 'cells', 'a cell asked about, with nothing set, is read');
});

test('whole-file operations are for a model over MCP, and are offered where an ask about the whole file got rows', async (t) => {
  // Arrange
  const [payroll] = VARIANTS;
  const { engine, ask, text } = shared;

  // Act
  const overMcp = ask('Timesheets 2026.xlsx: if the on-cost rate were changed to 25%, what would the roll-up in EUR become?');
  const otherwise = engine.evidence.ask({ ask: [{ file: 'Timesheets 2026.xlsx', op: 'cells', range: 'Roll-up!B11' }, 'Timesheets 2026.xlsx Roll-up!B11'] });

  // Assert
  assert.ok(!JSON.stringify(otherwise).includes('"operation"') && !JSON.stringify(otherwise).includes('"cells"'), 'any other caller is answered as before');
  assert.match(text(overMcp), /\(the whole workbook, exactly: ask "Timesheets 2026\.xlsx: op; op" with op: cells range:/);
});
