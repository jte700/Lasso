import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

const actor = { id: 'human:scope-writer', displayName: 'Scope writer', actorType: 'HUMAN_SELF' };

// An income statement whose section headings are rows with no values, as exported statements have.
async function statement(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-empty-source-scope-'));
  const folder = path.join(sandbox, 'Finance');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'Income-Statement.csv'),
    'Account,Actual\nREVENUES,\nRevenue,485000\nOPERATING EXPENSES,\nOffice supplies,400\nOther expenses,1200\nNet income,48000\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  await app.workspace.add([fs.realpathSync(folder)], actor);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return app;
}

const ask = (app, text, pendingDependencies = []) => app.workspace.predict({
  text, cursor: text.length, blockIndex: 0, ...(pendingDependencies.length ? { pendingDependencies } : {}),
});

// Tab on a suggestion, as the native card does it.
async function accept(app, text, label) {
  const claim = (await ask(app, text)).claims.find((item) => item.candidates.some((c) => c.label === label));
  assert.ok(claim, `${text} suggests ${label}`);
  const source = claim.candidates.find((c) => c.label === label);
  const accepted = `${text.slice(0, claim.start)}${source.label}`;
  return { accepted, link: { projectId: source.projectId, blockIndex: 0, start: claim.start, end: accepted.length,
    sourceObjectId: source.id, sourceSnapshotId: source.snapshotId } };
}

const named = (prediction) => prediction.claims.flatMap((claim) => claim.candidates.map((candidate) => candidate.label));

test('a name written after an accepted source with nothing to offer gets its suggestions', async (t) => {
  const app = await statement(t);
  const heading = await accept(app, 'The operating exp', 'OPERATING EXPENSES');
  const scoped = await ask(app, `${heading.accepted} were`, [heading.link]);
  assert.equal(scoped.workspaceHeading, 'Values for OPERATING EXPENSES', 'the words right after it are still its own');
  assert.equal(named(scoped).length + scoped.workspaceCompletions.length, 0);

  const other = await ask(app, `${heading.accepted} additionally, the other exp`, [heading.link]);
  assert.equal(other.workspaceHeading, undefined);
  assert.equal(named(other)[0], 'Other expenses');
  assert.equal(named(await ask(app, `${heading.accepted} additionally, net inc`, [heading.link]))[0], 'Net income');
});

test('a source with values keeps its sentence, and so does one whose values were all written', async (t) => {
  const app = await statement(t);
  const other = await accept(app, 'Other exp', 'Other expenses');
  const values = await ask(app, `${other.accepted} additionally, net inc`, [other.link]);
  assert.equal(values.workspaceHeading, 'Values for Other expenses', 'a name needs "and" or a new sentence to end it, as before');
  const written = `${other.accepted} came to 1200, `;
  const value = { ...other.link, start: written.indexOf('1200'), end: written.indexOf('1200') + 4,
    sourceObjectId: values.workspaceCompletions[0].dependencyCandidate.id,
    sourceSnapshotId: values.workspaceCompletions[0].dependencyCandidate.snapshotId };
  const after = await ask(app, written, [other.link, value]);
  assert.equal(named(after).length, 0, 'no name follows, so nothing else is offered');
});
