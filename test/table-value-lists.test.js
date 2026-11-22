// Writing out a column's values one Tab at a time ("2026-08-18, 2026-09-12,
// ..."): each value inserted is left out of the next list, so the values not
// yet written are the ones offered, down to the last, in any table source.

import { typedValueCloseness } from '../src/dependencies/workspace-completion.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { LINKED_VALUES_SHOWN } from '../src/dependencies/service.js';
import { workbook } from './fixtures/workbook.js';

const actor = { id: 'human:list-writer', displayName: 'List writer', actorType: 'HUMAN_SELF' };

// Seven invoices; Oak Courier's date repeats Cedar Packaging's.
const PAYABLES = [
  ['Supplier', 'Invoice', 'Invoice Date', 'Outstanding CAD'],
  ['Maple Paper Distribution', 'BILL-1160', '2026-08-18', '22000'],
  ['Harbour Office Furniture', 'BILL-1174', '2026-09-12', '18400'],
  ['North Ridge Technology', 'BILL-1181', '2026-09-20', '35000'],
  ['Cedar Packaging', 'BILL-1188', '2026-09-25', '17250'],
  ['Pine Facilities Supply', 'BILL-1190', '2026-09-28', '32500'],
  ['City Office Consumables', 'BILL-1192', '2026-09-30', '1250'],
  ['Oak Courier', 'BILL-1193', '2026-09-25', '900'],
  ['TOTAL', '', '', '127300'],
];
const suppliers = PAYABLES.slice(1, -1).map(([supplier]) => supplier);

// A work directory holding the file, and any others beside it, by name.
async function directory(t, name, contents, others = {}, options = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-value-lists-'));
  const root = path.join(sandbox, 'Accountant');
  fs.mkdirSync(root);
  for (const [file, text] of Object.entries({ [name]: contents, ...others })) {
    fs.writeFileSync(path.join(root, file), text);
  }
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false, ...options });
  await app.workspace.add([fs.realpathSync(root)], actor);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return app;
}

const typed = (app, text, pendingDependencies, extra = {}) => app.workspace.predict({
  text, cursor: text.length, blockIndex: 0, ...(pendingDependencies.length ? { pendingDependencies } : {}), ...extra,
});
const link = (candidate, start, end) => ({ projectId: candidate.projectId, blockIndex: 0, start, end,
  sourceObjectId: candidate.id, sourceSnapshotId: candidate.snapshotId });

// Tab on a named suggestion, as the card does: the next requests carry it.
async function acceptName(app, text, label, links) {
  const claim = (await typed(app, text, links)).claims.find(item => item.candidates.some(c => c.label === label));
  assert.ok(claim, `${text} suggests ${label}`);
  const candidate = claim.candidates.find(c => c.label === label);
  const accepted = `${text.slice(0, claim.start)}${candidate.completionText ?? candidate.label}`;
  return { text: accepted, links: [...links, link(candidate, claim.start, accepted.length)] };
}

// Inserts each supplier's invoice date in table order with Tab, checking
// that every list leaves out what was already written.
async function writeEveryDate(app, start) {
  let { text, links } = start;
  text += ' are ';
  for (const supplier of suppliers) {
    const prediction = await typed(app, text, links);
    assert.equal(prediction.workspaceHeading, 'Values for Invoice Date', text);
    const offered = prediction.workspaceCompletions;
    const written = new Set(links.map(item => item.sourceObjectId));
    assert.deepEqual(offered.filter(item => written.has(item.dependencyCandidate.id))
      .map(item => item.dependencyCandidate.anchor.rowKey), [], `nothing written is offered again, before ${supplier}`);
    const next = offered.find(item => item.dependencyCandidate.anchor.rowKey === supplier);
    assert.ok(next, `${supplier}'s date is offered after ${text}`);
    const at = text.length;
    text += next.replacementText;
    links = [...links, link(next.dependencyCandidate, at, text.length)];
    text += ', ';
  }
  const done = await typed(app, text, links);
  assert.deepEqual(done.workspaceCompletions, [], 'every date has been written');
  return text;
}

test('every invoice date of a CSV can be inserted in turn after accepting the file and its column', async t => {
  const app = await directory(t, 'Accounts-Payable.csv', `${PAYABLES.map(row => row.join(',')).join('\n')}\n`);
  const file = await acceptName(app, 'Accounts-Payable.cs', 'Accounts-Payable.csv', []);
  const column = await acceptName(app, `${file.text} invoice dat`, 'Invoice Date', file.links);
  const text = await writeEveryDate(app, column);
  assert.ok(text.endsWith('2026-09-30, 2026-09-25, '), text);
});

test('every invoice date of an Excel sheet can be inserted in turn after accepting its column', async t => {
  const rows = Object.fromEntries(PAYABLES.map((row, index) => [index + 1, row]));
  const app = await directory(t, 'Accounts-Payable.xlsx', workbook('Payables', rows));
  const column = await acceptName(app, 'The invoice dat', 'Invoice Date', []);
  await writeEveryDate(app, column);
});


test('a value tabbed from a column keeps the column listed until fn+Left drops it', async t => {
  // Arrange
  const app = await directory(t, 'Accounts-Payable.csv', `${PAYABLES.map(row => row.join(',')).join('\n')}\n`);
  const column = await acceptName(app, 'Inv', 'Invoice', []);
  const before = `${column.text} had approximately 3 values I was looking into, it was `;
  const first = (await typed(app, before, column.links)).workspaceCompletions
    .find(item => item.replacementText === 'BILL-1160');
  const text = before + first.replacementText;
  const links = [...column.links, link(first.dependencyCandidate, before.length, text.length)];
  // Act
  const after = await Promise.all([' and ', ' and BI', ' and BILL-1190 who had some values. Then the next ']
    .map(more => typed(app, text + more, links)));
  const widened = await typed(app, `${text} and `, []);
  // Assert
  for (const prediction of after) assert.equal(prediction.workspaceHeading, 'Values for Invoice');
  assert.ok(!offered(after[0]).includes('BILL-1160'), 'the value already written is left out of its sentence');
  assert.ok(offered(after[0]).includes('BILL-1190'));
  assert.ok(offered(after[2]).includes('BILL-1160'), 'a new sentence may name it again');
  assert.notEqual(widened.workspaceHeading, 'Values for Invoice', 'with the column dropped, every directory answers');
});

// A general ledger: Credit CAD has nine different amounts, 0 among them, over fifteen rows.
const LEDGER = `Date,Journal ID,Account Code,Account,Debit CAD,Credit CAD,Reference,Description
2026-09-03,JE-0901,1100,Accounts receivable,38500,0,INV-0921,Customer invoice posted
2026-09-03,JE-0901,4000,Revenue,0,38500,INV-0921,Customer invoice posted
2026-09-08,JE-0902,1000,Cash,32000,0,RCPT-0908,Customer payment received
2026-09-08,JE-0902,1100,Accounts receivable,0,32000,RCPT-0908,Customer payment received
2026-09-12,JE-0903,6100,Office supplies,18400,0,BILL-1174,Furniture and supplies
2026-09-12,JE-0903,2000,Accounts payable,0,18400,BILL-1174,Furniture and supplies
2026-09-15,JE-0904,6200,Payroll,21000,0,PAY-0915,Mid-month payroll
2026-09-15,JE-0904,1000,Cash,0,21000,PAY-0915,Mid-month payroll
2026-09-25,JE-0905,1000,Cash,76000,0,DEP-0925,Deposits
2026-09-25,JE-0905,4000,Revenue,0,47500,DEP-0925,Deposits
2026-09-25,JE-0905,1100,Accounts receivable,0,28500,DEP-0925,Deposits
2026-09-29,JE-0906,6300,Rent,4500,0,RENT-09,September rent
2026-09-29,JE-0906,1000,Cash,0,4500,RENT-09,September rent
2026-09-30,JE-0907,6400,Bank fees,1250,0,BANK-09,Bank fees
2026-09-30,JE-0907,1000,Cash,0,1250,BANK-09,Bank fees
`;
// Every cell of a column has its own place in the list, equal values included, so the arrows reach each one.
const columnCells = (csv, heading) => {
  const [header, ...rows] = csv.trim().split('\n').map((line) => line.split(','));
  return rows.map((row) => row[header.indexOf(heading)]);
};
const CREDITS = columnCells(LEDGER, 'Credit CAD');

// fn+Right on a suggestion, as the card sends it, resting on the words typed to find it when there are any.
const focusOn = (candidate, start, end) => ({ projectId: candidate.projectId, sourceObjectId: candidate.id,
  sourceSnapshotId: candidate.snapshotId, ...(start === undefined ? {} : { start, end }) });
const dive = (app, text, focusSource) => app.workspace.predict({ text, cursor: text.length, blockIndex: 0, focusSource });
const offered = prediction => prediction.workspaceCompletions.map(item => item.replacementText);

async function suggested(app, text, label) {
  const claim = (await typed(app, text, [])).claims.find(item => item.candidates.some(c => c.label === label));
  assert.ok(claim, `${text} suggests ${label}`);
  return { claim, candidate: claim.candidates.find(c => c.label === label) };
}

test('fn+Right into a column lists every one of its values, more than eight among them', async t => {
  const app = await directory(t, 'General-Ledger.csv', LEDGER);
  const { claim, candidate } = await suggested(app, 'The credit ca', 'Credit CAD');
  assert.equal(candidate.narrowable, true);
  for (const [text, focus] of [
    ['The credit ca', focusOn(candidate, claim.start, claim.end)],
    ['The credit was ', focusOn(candidate)],
  ]) {
    const values = await dive(app, text, focus);
    assert.equal(values.workspaceHeading, 'Values for Credit CAD', text);
    assert.deepEqual(offered(values).toSorted(), CREDITS.toSorted(), text);
  }
  // Accepted with Tab rather than dived into, the column lists the same values.
  const column = await acceptName(app, 'The credit ca', 'Credit CAD', []);
  assert.deepEqual(offered(await typed(app, `${column.text} was `, column.links)).toSorted(), CREDITS.toSorted());
});

test('a column with more values than the card lists offers the rest as their digits are typed', async t => {
  const amounts = Array.from({ length: LINKED_VALUES_SHOWN + 50 }, (_, index) => String(10_000 + index * 37));
  const app = await directory(t, 'Receipts.csv',
    `Receipt,Amount CAD\n${amounts.map((amount, index) => `R-${index + 1},${amount}`).join('\n')}\n`);
  const { candidate } = await suggested(app, 'The amount ca', 'Amount CAD');
  const listed = offered(await dive(app, 'The amount was ', focusOn(candidate)));
  assert.equal(listed.length, LINKED_VALUES_SHOWN);
  const unlisted = amounts.find(amount => !listed.includes(amount));
  assert.ok(unlisted, 'some amount is past the end of the list');
  assert.equal(offered(await dive(app, `The amount was ${unlisted}`, focusOn(candidate)))[0], unlisted);
});

// A trial balance is its own document, with its own Credit CAD column; 28500 is in both files.
const TRIAL_BALANCE = `Account Code,Account,Debit CAD,Credit CAD
1000,Cash,52000,0
1100,Accounts receivable,28500,0
2000,Accounts payable,0,126400
3000,Retained earnings,0,28500
4000,Revenue,0,485000
`;

test('a column in two documents is two suggestions, and each lists only its own values', async t => {
  const app = await directory(t, 'General-Ledger.csv', LEDGER, { 'Trial-Balance.csv': TRIAL_BALANCE });
  const claim = (await typed(app, 'The credit ca', [])).claims.find(item => item.candidates.some(c => c.label === 'Credit CAD'));
  assert.ok(claim, 'Credit CAD is suggested');
  const columns = claim.candidates.filter(c => c.label === 'Credit CAD');
  assert.deepEqual(columns.map(c => c.path).toSorted(), ['General-Ledger.csv', 'Trial-Balance.csv']);
  // Side by side in the card, one row each.
  const first = claim.candidates.indexOf(columns[0]);
  assert.equal(claim.candidates[first + 1], columns[1]);
  const ledger = columns.find(c => c.path === 'General-Ledger.csv');
  const trial = columns.find(c => c.path === 'Trial-Balance.csv');
  for (const [column, expected] of [[ledger, CREDITS], [trial, columnCells(TRIAL_BALANCE, 'Credit CAD')]]) {
    const values = await dive(app, 'The credit was ', focusOn(column));
    assert.deepEqual(offered(values).toSorted(), expected.toSorted(), column.path);
    assert.deepEqual([...new Set(values.workspaceCompletions.map(item => item.dependencyCandidate.path))], [column.path]);
  }
  // Typing digits finds them in the chosen document only: 485000 is the trial balance's.
  assert.ok(!offered(await dive(app, 'The credit was 4', focusOn(ledger))).includes('485000'));
  // Accepted with Tab, the ledger's column lists the ledger's values too.
  const accepted = 'The Credit CAD';
  const values = await typed(app, `${accepted} was `, [link(ledger, 4, accepted.length)]);
  assert.deepEqual(offered(values).toSorted(), CREDITS.toSorted());
});

// Sheet order is neither alphabetical by supplier nor by value, so a sorted list cannot pass by chance.
const OPEN_BILLS = `Supplier,Invoice,Outstanding CAD
Maple Paper,BILL-1160,22000
Harbour Office,BILL-1174,18400
North Ridge,BILL-1181,35000
Cedar Packaging,BILL-1188,17250
`;

test('fn+Right with nothing typed after it lists a column from top to bottom', async t => {
  // Arrange
  const app = await directory(t, 'Accounts-Payable.csv', OPEN_BILLS);
  const { claim, candidate } = await suggested(app, 'invoice', 'Invoice');

  // Act
  const values = await dive(app, 'invoice', focusOn(candidate, claim.start, claim.end));

  // Assert
  assert.deepEqual(offered(values), ['BILL-1160', 'BILL-1174', 'BILL-1181', 'BILL-1188']);
  assert.deepEqual(values.workspaceCompletions.map(item => item.rankOrder), [0, 1, 2, 3], 'the card sorts by this');
});

test('fn+Right on a row with nothing typed after it lists its cells from left to right', async t => {
  // Arrange
  const app = await directory(t, 'Accounts-Payable.csv', OPEN_BILLS);
  const { claim, candidate } = await suggested(app, 'Cedar Pack', 'Cedar Packaging');

  // Act
  const values = await dive(app, 'Cedar Pack', focusOn(candidate, claim.start, claim.end));

  // Assert
  assert.deepEqual(offered(values), ['BILL-1188', '17250']);
});

test('digits typed in a dive still bring the values they begin to the top', async t => {
  // Arrange
  const app = await directory(t, 'Accounts-Payable.csv', OPEN_BILLS);
  const { candidate } = await suggested(app, 'outstanding', 'Outstanding CAD');

  // Act
  const values = await dive(app, 'The outstanding was 3', focusOn(candidate));

  // Assert
  assert.equal(offered(values)[0], '35000');
});

test('after Tab a column lists from top to bottom, and a word like "was" narrows nothing', async t => {
  // Arrange
  const app = await directory(t, 'Accounts-Payable.csv', OPEN_BILLS);
  const column = await acceptName(app, 'invoice', 'Invoice', []);

  // Act, Assert
  for (const text of [column.text, `${column.text} `, `${column.text} was `]) {
    assert.deepEqual(offered(await typed(app, text, column.links)),
      ['BILL-1160', 'BILL-1174', 'BILL-1181', 'BILL-1188'], JSON.stringify(text));
  }
});

test('after Tab a row lists its cells from left to right', async t => {
  // Arrange
  const app = await directory(t, 'Accounts-Payable.csv', OPEN_BILLS);
  const row = await acceptName(app, 'Cedar Pack', 'Cedar Packaging', []);

  // Act
  const values = await typed(app, `${row.text} was `, row.links);

  // Assert
  assert.deepEqual(offered(values), ['BILL-1188', '17250']);
});

test('more typed narrows the list, after Tab or in a dive', async t => {
  // Arrange
  const app = await directory(t, 'Accounts-Payable.csv', OPEN_BILLS, { 'Bill-Status.csv':
    'Bill,Status\nBILL-1160,Not yet due\nBILL-1174,Due soon\nBILL-1181,Overdue\nBILL-1188,Paid\n' });
  const amounts = await acceptName(app, 'outstanding', 'Outstanding CAD', []);
  const statuses = await acceptName(app, 'status', 'Status', []);
  const { claim, candidate } = await suggested(app, 'status', 'Status');

  // Act
  const digits = offered(await typed(app, `${amounts.text} was 3`, amounts.links));
  const wordList = await typed(app, `${statuses.text} overd`, statuses.links);
  const word = offered(wordList);
  const dived = offered(await dive(app, 'status overd', focusOn(candidate, claim.start, claim.end)));

  // Assert
  assert.equal(digits[0], '35000', 'digits bring the values they begin first');
  assert.equal(word[0], 'Overdue', 'a word brings the value it begins first');
  assert.equal(dived[0], 'Overdue', 'in a dive as well');
  assert.equal(wordList.workspaceCompletions[0].claimStart, statuses.text.length + 1, 'and takes the place of the word typed');
  assert.equal(word.length, 4, 'with the other values still in the list');
});

test('what is typed reorders the list whatever its punctuation: the values it begins, then those it is inside', () => {
  // Arrange
  const closeness = (typed, value) => typedValueCloseness(typed, value);

  // Assert
  assert.equal(closeness(' BILL-117', 'BILL-1174'), 2, 'a code with its hyphen');
  assert.equal(closeness(' bill 117', 'BILL-1174'), 2, 'or with a space for it');
  assert.equal(closeness(' 117', 'BILL-1174'), 1, 'digits inside a code');
  assert.equal(closeness(' 2026-09', '2026-09-25'), 2, 'the start of a date');
  assert.equal(closeness(' $46,3', '46350'), 2, 'an amount with its currency and comma');
  assert.equal(closeness(' Not y', 'Not yet due'), 2, 'words of a phrase');
  assert.equal(closeness(' BILL-117 was ', 'BILL-1174'), 2, 'a finished cue after it changes nothing');
  assert.equal(closeness(' was ', 'Washington'), 0, 'a cue alone names nothing');
  assert.equal(closeness('', 'BILL-1174'), 0, 'nor does nothing');
  assert.equal(closeness(' BILL-119', 'BILL-1174'), 0);
});

test('a code typed after a dive or Tab brings its value to the top, the rest staying in sheet order', async t => {
  // Arrange
  const app = await directory(t, 'Accounts-Payable.csv', OPEN_BILLS);
  const { claim, candidate } = await suggested(app, 'invoice', 'Invoice');
  const focus = focusOn(candidate, claim.start, claim.end);
  const column = await acceptName(app, 'invoice', 'Invoice', []);

  // Act
  const dived = offered(await dive(app, 'invoice BILL-117', focus));
  const inside = offered(await dive(app, 'invoice 1181', focus));
  const several = offered(await dive(app, 'invoice bill 118', focus));
  const tabbed = await typed(app, `${column.text} BILL-117`, column.links);

  // Assert
  assert.deepEqual(dived, ['BILL-1174', 'BILL-1160', 'BILL-1181', 'BILL-1188']);
  assert.equal(inside[0], 'BILL-1181');
  assert.deepEqual(several, ['BILL-1181', 'BILL-1188', 'BILL-1160', 'BILL-1174']);
  assert.deepEqual(offered(tabbed), dived);
  const first = tabbed.workspaceCompletions[0];
  assert.equal(`${column.text} BILL-117`.slice(0, first.claimStart) + first.replacementText, `${column.text} BILL-1174`);
});

test('a typed date or amount reorders its column too', async t => {
  // Arrange
  const app = await directory(t, 'Due.csv',
    'Bill,Due Date,Amount CAD\nA-1,2026-09-17,46350\nA-2,2026-10-12,18400\nA-3,2026-10-20,46900\nA-4,2026-11-01,5000\n');
  const dates = await suggested(app, 'due date', 'Due Date');
  const amounts = await suggested(app, 'amount', 'Amount CAD');

  // Act
  const date = offered(await dive(app, 'due date 2026-10', focusOn(dates.candidate, dates.claim.start, dates.claim.end)));
  const amount = offered(await dive(app, 'amount $46,3', focusOn(amounts.candidate, amounts.claim.start, amounts.claim.end)));

  // Assert
  assert.deepEqual(date, ['2026-10-12', '2026-10-20', '2026-09-17', '2026-11-01']);
  assert.equal(amount[0], '46350');
});

// "Invoice ... it was BILL-1160 and BILL-1190 who had values that didnt quite
// add up being 22000 and 32500": the rows of the values tabbed in a sentence
// join the list kept for their column, below it, and their digits bring them up.
async function writeRowAmounts(app) {
  // Arrange
  const column = await acceptName(app, 'Inv', 'Invoice', []);
  let text = `${column.text} had approximately 3 values I was looking into, it was `;
  let links = column.links;
  for (const bill of ['BILL-1160', 'BILL-1190']) {
    const value = (await typed(app, text, links)).workspaceCompletions.find(item => item.replacementText === bill);
    assert.ok(value, `${bill} is offered after ${text}`);
    links = [...links, link(value.dependencyCandidate, text.length, text.length + bill.length)];
    text += bill === 'BILL-1160' ? `${bill} and ` : `${bill} who had some values that didnt quite add up being `;
  }
  // Act
  const listed = offered(await typed(app, text, links));
  const first = offered(await typed(app, `${text}22`, links));
  const second = offered(await typed(app, `${text}22000 and 32`, links));
  // Assert
  assert.equal(listed[0], 'BILL-1174', 'the column\'s own values stay on top');
  assert.ok(listed.indexOf('22000') > listed.indexOf('BILL-1193') && listed.includes('32500'), listed.join(' | '));
  assert.ok(!listed.includes('18400'), 'a row nobody tabbed adds nothing');
  assert.equal(first[0], '22000');
  assert.equal(second[0], '32500');
}

test('the rows of values tabbed from a CSV column join its kept list', async t => {
  const app = await directory(t, 'Accounts-Payable.csv', `${PAYABLES.map(row => row.join(',')).join('\n')}\n`);
  await writeRowAmounts(app);
});

test('the rows of values tabbed from an Excel column join its kept list', async t => {
  const rows = Object.fromEntries(PAYABLES.map((row, index) => [index + 1, row]));
  const app = await directory(t, 'Accounts-Payable.xlsx', workbook('Payables', rows));
  await writeRowAmounts(app);
});

// The column that names a sheet's rows holds its values as the rows themselves.
const SUPPLIER_NAMES = ['Maple Paper', 'Harbour Office', 'North Ridge', 'Cedar Packaging'];
const SHEETS_NAMED_BY_A_COLUMN = [
  ['a CSV', 'Accounts-Payable.csv', OPEN_BILLS, {}],
  ['an Excel sheet', 'Accounts-Payable.xlsx', workbook('Payables', Object.fromEntries(OPEN_BILLS.trim().split('\n')
    .map((line, index) => [index + 1, line.split(',')]))), {}],
  ['a folder searched in its index', 'Accounts-Payable.csv', OPEN_BILLS, { searchIndexObjects: 1 }],
];

for (const [kind, name, contents, options] of SHEETS_NAMED_BY_A_COLUMN) {
  test(`fn+Right on the column naming ${kind}'s rows lists every name from top to bottom`, async t => {
    // Arrange
    const app = await directory(t, name, contents, {}, options);
    const { claim, candidate } = await suggested(app, 'last months top supplier', 'Supplier');

    // Act
    const values = await dive(app, 'last months top supplier', focusOn(candidate, claim.start, claim.end));

    // Assert
    assert.equal(candidate.narrowable, true, 'fn+Right has something to show');
    assert.equal(values.workspaceHeading, 'Values for Supplier');
    assert.deepEqual(offered(values), SUPPLIER_NAMES);
  });

  test(`after Tab the column naming ${kind}'s rows lists every name`, async t => {
    // Arrange
    const app = await directory(t, name, contents, {}, options);
    const column = await acceptName(app, 'last months top supplier', 'Supplier', []);

    // Act
    const values = await typed(app, `${column.text} was `, column.links);

    // Assert
    assert.deepEqual(offered(values), SUPPLIER_NAMES);
  });
}

test('a name tabbed from the column naming the rows keeps the names listed, with that row\'s cells', async t => {
  // Arrange
  const app = await directory(t, 'Accounts-Payable.csv', OPEN_BILLS);
  const column = await acceptName(app, 'The top supplier', 'Supplier', []);
  const before = `${column.text} was `;
  const name = (await typed(app, before, column.links)).workspaceCompletions
    .find(item => item.replacementText === 'North Ridge');
  const text = before + name.replacementText;
  const links = [...column.links, link(name.dependencyCandidate, before.length, text.length)];

  // Act
  const after = await typed(app, `${text} and `, links);

  // Assert
  assert.equal(after.workspaceHeading, 'Values for Supplier');
  assert.ok(!offered(after).includes('North Ridge'), 'the name already written is left out of its sentence');
  assert.ok(offered(after).includes('Cedar Packaging'));
  assert.ok(offered(after).includes('BILL-1181') && offered(after).includes('35000'), offered(after).join(' | '));
});

// A wide count table: its first rows spend the indexed cells, and the table index holds the rest.
const SAMPLES = Array.from({ length: 40 }, (_, index) => `S${index + 1}`);
const GENES = Array.from({ length: LINKED_VALUES_SHOWN + 40 }, (_, index) => `gene_${String(index + 1).padStart(4, '0')}`);
const count = (gene, sample) => String((gene * 7 + sample * 13) % 997);
const COUNTS = `gene_id,${SAMPLES.join(',')}\n${GENES.map((gene, row) =>
  `${gene},${SAMPLES.map((_, column) => count(row, column)).join(',')}`).join('\n')}\n`;

test('a wide table lists a column down past its first indexed rows, as far as the card lists', async t => {
  // Arrange
  const app = await directory(t, 'counts.csv', COUNTS);
  const sample = await suggested(app, 'sample s7', 'S7');
  const genes = await suggested(app, 'the gene id', 'gene_id');

  // Act
  const counts = offered(await dive(app, 'sample s7 was ', focusOn(sample.candidate)));
  const names = offered(await dive(app, 'the gene id was ', focusOn(genes.candidate)));

  // Assert
  assert.deepEqual(counts, GENES.slice(0, LINKED_VALUES_SHOWN).map((_, row) => count(row, 6)));
  assert.deepEqual(names, GENES.slice(0, LINKED_VALUES_SHOWN));
});

// Row mates of a tabbed Excel or CSV cell carry that tabbed cell in their top-right label,
// and fn+Left first exits back to the column's own values only before widening to all directories.
async function checkMarkedRowMatesAndStepBack(app) {
  // Arrange: accept Invoice, then BILL-1160.
  const column = await acceptName(app, 'Inv', 'Invoice', []);
  const before = `${column.text} was `;
  const bill1160 = (await typed(app, before, column.links)).workspaceCompletions
    .find(item => item.replacementText === 'BILL-1160');
  assert.ok(bill1160, 'BILL-1160 is offered for Invoice');
  const after1160 = before + bill1160.replacementText;
  const bill1160End = after1160.length;
  const links1160 = [...column.links, link(bill1160.dependencyCandidate, before.length, bill1160End)];

  // Act: with BILL-1160 tabbed, its row mates join the list marked as related to BILL-1160.
  const withMates = await typed(app, `${after1160} and `, links1160);
  const mates = withMates.workspaceCompletions.filter(item => item.rowMateOf);
  const ownValues = withMates.workspaceCompletions.filter(item => !item.rowMateOf);

  // Assert: row mates (including the supplier label cell) are marked for BILL-1160; Invoice's own values are not.
  assert.equal(withMates.sourceContext?.hasRowMates, true);
  assert.deepEqual(mates.map(item => item.replacementText), ['Maple Paper Distribution', '2026-08-18', '22000']);
  assert.deepEqual(mates.map(item => [item.rowMateOf, item.detail]), [
    ['BILL-1160', 'Supplier of BILL-1160'],
    ['BILL-1160', 'Invoice Date of BILL-1160'],
    ['BILL-1160', 'Outstanding CAD of BILL-1160'],
  ]);
  assert.ok(ownValues.length > 0 && ownValues.every(item => item.rowMateOf == null
    && /^Invoice column · /.test(item.detail)), 'own values name their column and row');

  // Act: tabbing a row mate (22000) keeps Invoice and the remaining BILL-1160 row mates listed.
  const beforeAmount = `${after1160} for `;
  const amount22000 = mates.find(item => item.replacementText === '22000');
  const afterAmount = beforeAmount + amount22000.replacementText;
  const linksWithAmount = [...links1160, link(amount22000.dependencyCandidate, beforeAmount.length, afterAmount.length)];
  const stillHeld = await typed(app, `${afterAmount} on `, linksWithAmount);
  assert.equal(stillHeld.workspaceHeading, 'Values for Invoice');
  assert.equal(stillHeld.sourceContext?.hasRowMates, true);
  assert.deepEqual(stillHeld.workspaceCompletions.filter(item => item.rowMateOf).map(item => item.replacementText),
    ['Maple Paper Distribution', '2026-08-18']);

  // Act: first fn+Left sends rowScopeBoundary at the end of BILL-1160, returning to Invoice's own values only.
  const invoiceOnly = await typed(app, `${after1160} and `, links1160, { rowScopeBoundary: bill1160End });
  assert.equal(invoiceOnly.workspaceHeading, 'Values for Invoice');
  assert.ok(!invoiceOnly.sourceContext?.hasRowMates);
  assert.deepEqual(invoiceOnly.workspaceCompletions.filter(item => item.rowMateOf), []);
  assert.ok(offered(invoiceOnly).includes('BILL-1174') && !offered(invoiceOnly).includes('22000'));

  // Act: tabbing BILL-1190 after stepping out of BILL-1160's row brings only BILL-1190's row mates.
  const before1190 = `${after1160} and `;
  const bill1190 = invoiceOnly.workspaceCompletions.find(item => item.replacementText === 'BILL-1190');
  assert.ok(bill1190);
  const after1190 = before1190 + bill1190.replacementText;
  const links1190 = [...links1160, link(bill1190.dependencyCandidate, before1190.length, after1190.length)];
  const secondMates = await typed(app, `${after1190} for `, links1190, { rowScopeBoundary: bill1160End });
  assert.equal(secondMates.sourceContext?.hasRowMates, true);
  assert.deepEqual(secondMates.workspaceCompletions.filter(item => item.rowMateOf).map(item => [item.replacementText, item.detail]), [
    ['Pine Facilities Supply', 'Supplier of BILL-1190'],
    ['2026-09-28', 'Invoice Date of BILL-1190'],
    ['32500', 'Outstanding CAD of BILL-1190'],
  ]);

  // Act: second fn+Left drops the column and releases past the tabbed value, returning to all active directories.
  const allDirs = await typed(app, `${after1160} and `, [], { settledValueEnd: bill1160End, sourceScopeBoundary: bill1160End });
  assert.notEqual(allDirs.workspaceHeading, 'Values for Invoice');
}

test('tabbed CSV cell row mates are marked for that cell and fn+Left exits them before widening', async t => {
  const app = await directory(t, 'Accounts-Payable.csv', `${PAYABLES.map(row => row.join(',')).join('\n')}\n`);
  await checkMarkedRowMatesAndStepBack(app);
});

test('tabbed Excel cell row mates are marked for that cell and fn+Left exits them before widening', async t => {
  const rows = Object.fromEntries(PAYABLES.map((row, index) => [index + 1, row]));
  const app = await directory(t, 'Accounts-Payable.xlsx', workbook('Payables', rows));
  await checkMarkedRowMatesAndStepBack(app);
});

test('two tabbed cells in one sentence mark each row mate with its own tabbed cell', async t => {
  // Arrange
  const app = await directory(t, 'Accounts-Payable.csv', `${PAYABLES.map(row => row.join(',')).join('\n')}\n`);
  const column = await acceptName(app, 'Inv', 'Invoice', []);
  let text = `${column.text} was `;
  let links = column.links;
  for (const bill of ['BILL-1160', 'BILL-1190']) {
    const value = (await typed(app, text, links)).workspaceCompletions.find(item => item.replacementText === bill);
    links = [...links, link(value.dependencyCandidate, text.length, text.length + bill.length)];
    text += bill === 'BILL-1160' ? `${bill} and ` : `${bill} with `;
  }

  // Act
  const prediction = await typed(app, text, links);
  const byValue = new Map(prediction.workspaceCompletions.map(item => [item.replacementText, item]));

  // Assert
  assert.equal(byValue.get('22000')?.detail, 'Outstanding CAD of BILL-1160');
  assert.equal(byValue.get('2026-08-18')?.detail, 'Invoice Date of BILL-1160');
  assert.equal(byValue.get('Maple Paper Distribution')?.detail, 'Supplier of BILL-1160');
  assert.equal(byValue.get('32500')?.detail, 'Outstanding CAD of BILL-1190');
  assert.equal(byValue.get('2026-09-28')?.detail, 'Invoice Date of BILL-1190');
  assert.equal(byValue.get('Pine Facilities Supply')?.detail, 'Supplier of BILL-1190');
});

test('row mates work for row-naming code columns, unnamed rows, and row-naming text columns alike', async t => {
  // Arrange: Batches.csv has a row-naming code column (B-1, B-2), Numeric.csv has no naming column at all.
  const batches = 'Year,Batch,Amount\n2026,B-1,1500\n2026,B-1,2500\n2025,B-2,3500\n';
  const numeric = 'Year,Quarter,Amount\n2026,1,1500\n2026,1,2500\n2025,2,3500\n';
  const app = await directory(t, 'Batches.csv', batches, { 'Numeric.csv': numeric, 'Accounts-Payable.csv': OPEN_BILLS });

  // Act 1: code column that names rows (tab Batch -> B-2 -> row mates 2025 and 3500 marked Year of B-2 and Amount of B-2).
  const batch = await acceptName(app, 'Bat', 'Batch', []);
  const beforeBatch = `${batch.text} was `;
  const b2 = (await typed(app, beforeBatch, batch.links)).workspaceCompletions.find(item => item.replacementText === 'B-2');
  assert.ok(b2);
  const afterB2 = beforeBatch + b2.replacementText;
  const codeRowResult = await typed(app, `${afterB2} `, [...batch.links, link(b2.dependencyCandidate, beforeBatch.length, afterB2.length)]);

  // Act 2: genuinely unnamed row (all numeric columns: tab Quarter -> 2 -> row mates 2025 and 3500 marked by their fields).
  const quarter = await acceptName(app, 'Quar', 'Quarter', []);
  const beforeQuarter = `${quarter.text} was `;
  const q2 = (await typed(app, beforeQuarter, quarter.links)).workspaceCompletions.find(item => item.replacementText === '2');
  assert.ok(q2);
  const afterQ2 = beforeQuarter + q2.replacementText;
  const unnamedResult = await typed(app, `${afterQ2} `, [...quarter.links, link(q2.dependencyCandidate, beforeQuarter.length, afterQ2.length)]);

  // Act 3: text column that names rows (tab Supplier -> North Ridge -> row mates BILL-1181 and 35000 marked by their fields).
  const supplier = await acceptName(app, 'The top supplier', 'Supplier', []);
  const beforeSupplier = `${supplier.text} was `;
  const north = (await typed(app, beforeSupplier, supplier.links)).workspaceCompletions.find(item => item.replacementText === 'North Ridge');
  assert.ok(north);
  const afterNorth = beforeSupplier + north.replacementText;
  const namedResult = await typed(app, `${afterNorth} `, [...supplier.links, link(north.dependencyCandidate, beforeSupplier.length, afterNorth.length)]);

  // Assert
  assert.equal(codeRowResult.sourceContext?.hasRowMates, true);
  assert.deepEqual(codeRowResult.workspaceCompletions.filter(item => item.rowMateOf).map(item => [item.replacementText, item.detail]), [
    ['2025', 'Year of B-2'],
    ['3500', 'Amount of B-2'],
  ]);
  assert.equal(unnamedResult.sourceContext?.hasRowMates, true);
  assert.deepEqual(unnamedResult.workspaceCompletions.filter(item => item.rowMateOf).map(item => [item.replacementText, item.detail]), [
    ['2025', 'Year of 2'],
    ['3500', 'Amount of 2'],
  ]);
  assert.equal(namedResult.sourceContext?.hasRowMates, true);
  assert.deepEqual(namedResult.workspaceCompletions.filter(item => item.rowMateOf).map(item => [item.replacementText, item.detail]), [
    ['BILL-1181', 'Invoice of North Ridge'],
    ['35000', 'Outstanding CAD of North Ridge'],
  ]);
});

test('typing a row-mate supplier name brings it up, and large folders and tall sheets keep marked row mates', async t => {
  // Arrange: a folder searched in its search index AND a tall CSV exceeding LINKED_VALUES_SHOWN rows.
  const tallRows = Array.from({ length: LINKED_VALUES_SHOWN + 15 }, (_, index) =>
    `Supplier ${index + 1},INV-${1000 + index},${10000 + index * 25}`);
  const tallCsv = `Supplier,Invoice,Amount\n${tallRows.join('\n')}\n`;
  const indexedApp = await directory(t, 'Accounts-Payable.csv', `${PAYABLES.map(row => row.join(',')).join('\n')}\n`,
    {}, { searchIndexObjects: 1 });
  const tallApp = await directory(t, 'Tall.csv', tallCsv);

  // Act 1: typing "Map" after Invoice -> BILL-1160 brings Maple Paper Distribution to top replacing "Map".
  const column = await acceptName(indexedApp, 'Inv', 'Invoice', []);
  const before = `${column.text} was `;
  const bill1160 = (await typed(indexedApp, before, column.links)).workspaceCompletions
    .find(item => item.replacementText === 'BILL-1160');
  const after = before + bill1160.replacementText;
  const links = [...column.links, link(bill1160.dependencyCandidate, before.length, after.length)];
  const typedSupplier = await typed(indexedApp, `${after} from Map`, links);

  // Act 2: in a tall sheet (> LINKED_VALUES_SHOWN rows), row mates of INV-1000 survive the list limit.
  const tallCol = await acceptName(tallApp, 'Inv', 'Invoice', []);
  const tallBefore = `${tallCol.text} was `;
  const inv1000 = (await typed(tallApp, tallBefore, tallCol.links)).workspaceCompletions
    .find(item => item.replacementText === 'INV-1000');
  const tallAfter = tallBefore + inv1000.replacementText;
  const tallLinks = [...tallCol.links, link(inv1000.dependencyCandidate, tallBefore.length, tallAfter.length)];
  const tallWithMates = await typed(tallApp, `${tallAfter} `, tallLinks);
  const tallExited = await typed(tallApp, `${tallAfter} `, tallLinks, { rowScopeBoundary: tallAfter.length });

  // Assert
  assert.equal(typedSupplier.workspaceCompletions[0].replacementText, 'Maple Paper Distribution');
  assert.equal(typedSupplier.workspaceCompletions[0].detail, 'Supplier of BILL-1160');
  assert.equal(typedSupplier.workspaceCompletions[0].claimStart, `${after} from `.length);
  assert.equal(tallWithMates.sourceContext?.hasRowMates, true);
  assert.deepEqual(tallWithMates.workspaceCompletions.filter(item => item.rowMateOf).map(item => [item.replacementText, item.detail]), [
    ['Supplier 1', 'Supplier of INV-1000'],
    ['10000', 'Amount of INV-1000'],
  ]);
  assert.ok(!tallExited.sourceContext?.hasRowMates);
  assert.deepEqual(tallExited.workspaceCompletions.filter(item => item.rowMateOf), []);
});
