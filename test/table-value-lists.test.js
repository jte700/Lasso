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
async function directory(t, name, contents, others = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-value-lists-'));
  const root = path.join(sandbox, 'Accountant');
  fs.mkdirSync(root);
  for (const [file, text] of Object.entries({ [name]: contents, ...others })) {
    fs.writeFileSync(path.join(root, file), text);
  }
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  await app.workspace.add([fs.realpathSync(root)], actor);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return app;
}

const typed = (app, text, pendingDependencies) => app.workspace.predict({
  text, cursor: text.length, blockIndex: 0, ...(pendingDependencies.length ? { pendingDependencies } : {}),
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


test('a completed table value releases the scope unless a comma continues its list', async t => {
  const app = await directory(t, 'Accounts-Payable.csv', `${PAYABLES.map(row => row.join(',')).join('\n')}\n`);
  const column = await acceptName(app, 'The invoice dat', 'Invoice Date', []);
  const before = `${column.text} is `;
  const prediction = await typed(app, before, column.links);
  const value = prediction.workspaceCompletions[0];
  const text = before + value.replacementText;
  const links = [...column.links, link(value.dependencyCandidate, before.length, text.length)];
  assert.equal((await typed(app, `${text} `, links)).workspaceHeading, undefined);
  assert.equal((await typed(app, `${text}, `, links)).workspaceHeading, 'Values for Invoice Date');
  assert.equal((await typed(app, `${text}, next `, links)).workspaceHeading, undefined);
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
