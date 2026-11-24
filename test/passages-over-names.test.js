import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { textPdf } from './fixtures/pdf.js';

const actor = { id: 'human:site-writer', displayName: 'Site writer', actorType: 'HUMAN_SELF' };

// A site's weekly brief as a PDF beside its change register, and an
// accountant's payables with a TOTAL row in another folder.
const BRIEF = 'Willow site weekly brief. CO-001 roof curb repair is approved for CAD 4,800. '
  + 'CO-002 additional bollards is pending for CAD 2,200. CO-003 drainage reroute is approved for CAD 7,500. '
  + 'Approved changes total CAD 12,300; pending changes total CAD 2,200. Loading bay handover is planned for 2026-10-30.';
const REGISTER_CSV = `Change ID,Description,Status,Amount CAD,Decision date
CO-001,Roof curb repair,Approved,4800,2026-10-12
CO-002,Additional bollards,Pending,2200,
CO-003,Drainage reroute,Approved,7500,2026-10-14
`;
const PAYABLES_CSV = `Supplier,Invoice,Due Date,Outstanding CAD,Status as of 2026-10-11
Maple Paper Distribution,BILL-1160,2026-09-17,22000,Overdue
Harbour Office Furniture,BILL-1174,2026-10-12,18400,Due within seven days
TOTAL,,,40400,Agrees with trial balance
`;

async function siteAndAccounts(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-passages-'));
  const construction = path.join(sandbox, 'Construction');
  const accountant = path.join(sandbox, 'Accountant');
  for (const root of [construction, accountant]) fs.mkdirSync(root);
  fs.writeFileSync(path.join(construction, 'Willow-Site-Weekly-Brief.pdf'), textPdf(BRIEF));
  fs.writeFileSync(path.join(construction, 'Willow-Change-Register.csv'), REGISTER_CSV);
  fs.writeFileSync(path.join(accountant, 'Accounts-Payable.csv'), PAYABLES_CSV);
  fs.writeFileSync(path.join(accountant, 'Room-Schedule.csv'), 'Room,Area m2\nCONFERENCE 202,40\nOFFICE 203,18\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  await app.workspace.add([construction, accountant].map((root) => fs.realpathSync(root)), actor);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return app;
}

const typed = (app, text) => app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });

/** Every suggestion on the card, in the card's order, as the words it offers and its file. */
function offered(prediction) {
  const items = [
    ...prediction.workspaceCompletions.map((item) => ({ rank: item.rankOrder, text: item.replacementText, path: item.dependencyCandidate?.path })),
    ...prediction.claims.flatMap((claim) => claim.candidates.map((item) => ({ rank: item.rankOrder, text: item.valueText ?? item.label, path: item.path }))),
    ...(prediction.completion ? [{ rank: prediction.completion.rankOrder,
      text: prediction.completion.replacementText ?? prediction.completion.insertText ?? prediction.completion.text,
      path: prediction.completion.dependencyCandidate?.path }] : []),
  ];
  return items.sort((left, right) => left.rank - right.rank);
}

test('a passage holding every typed word goes before a row named by one of them', async (t) => {
  // Arrange
  const app = await siteAndAccounts(t);

  // Act
  const card = offered(await typed(app, 'Pending changes total '));

  // Assert
  assert.equal(card[0]?.path, 'Willow-Site-Weekly-Brief.pdf', JSON.stringify(card.slice(0, 4)));
  assert.match(card[0].text, /pending changes total CAD 2,200/);
});

test('an identifier the sentence has moved past still lets its figure and passage be offered', async (t) => {
  // Arrange
  const app = await siteAndAccounts(t);

  // Act
  const card = offered(await typed(app, 'The CO-003 drainage reroute is approved for '));

  // Assert
  assert.ok(card.length > 0, 'something is offered');
  assert.match(card[0].text, /7,?500/, JSON.stringify(card.slice(0, 4)));
  assert.ok(!card.slice(0, 2).some((item) => /CO-00[12]/.test(item.text)), JSON.stringify(card.slice(0, 4)));
});

test('an identifier typed in full offers that identifier, not its neighbours', async (t) => {
  // Arrange
  const app = await siteAndAccounts(t);

  // Act
  const card = offered(await typed(app, 'The CO-003'));
  const begun = offered(await typed(app, 'The CO-00'));

  // Assert
  assert.deepEqual(card.filter((item) => /^CO-00\d$/.test(item.text)).map((item) => item.text), ['CO-003'], JSON.stringify(card));
  assert.ok(!card.some((item) => /CONFERENCE/.test(item.text)), 'a word the identifier\'s letters begin is not it');
  assert.ok(begun.filter((item) => /^CO-00\d$/.test(item.text)).length >= 2, 'a begun identifier still offers each it begins');
});
