// Writing out a column's values one Tab at a time ("2026-08-18, 2026-09-12,
// ..."): each value inserted is left out of the next list, so the values not
// yet written are the ones offered, down to the last, in any table source.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
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
