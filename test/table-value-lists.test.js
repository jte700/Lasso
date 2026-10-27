// Writing out a column's values one Tab at a time ("2026-08-18, 2026-09-12,
// ..."): each value inserted is left out of the next list, so the values not
// yet written are the ones offered, down to the last, in any table source.

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

async function directory(t, name, contents) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-value-lists-'));
  const root = path.join(sandbox, 'Accountant');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, name), contents);
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
const CREDITS = ['0', '38500', '32000', '18400', '21000', '47500', '28500', '4500', '1250'];

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
