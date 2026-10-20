import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { directoryIssue } from '../src/directory-issues.js';

const actor = { id: 'human:issue-reader', displayName: 'Issue reader', actorType: 'HUMAN_SELF' };
const healthy = { available: true, activationError: null, readerBehind: false, failures: [] };

test('a healthy folder has no issue', () => {
  assert.equal(directoryIssue(healthy), null);
});

test('problems Lasso did not cause are described without a fix', () => {
  const missing = directoryIssue({ ...healthy, available: false });
  assert.equal(missing.kind, 'UNAVAILABLE');
  assert.equal(missing.fix, null);
  assert.match(missing.message, /can't find this folder/);

  const denied = directoryIssue({ ...healthy, activationError: { message: 'EACCES: permission denied', code: 'EACCES' } });
  assert.equal(denied.kind, 'PERMISSION');
  assert.equal(denied.fix, null);
  assert.match(denied.message, /Privacy & Security/);

  const damaged = directoryIssue({ ...healthy, failures: [{ path: 'Reports/Budget.xlsx', code: 'UNREADABLE_CONTENT',
    reason: 'This workbook could not be read. It may be password-protected, damaged or too large.' }] });
  assert.equal(damaged.kind, 'FILES');
  assert.equal(damaged.fix, null);
  assert.equal(damaged.message, 'Budget.xlsx could not be read. It may be password-protected, damaged or too large.');

  const locked = directoryIssue({ ...healthy, failures: [
    { path: 'a.csv', code: 'BUSY', reason: 'file is locked by another process' },
    { path: 'b.csv', code: 'PERMISSION_DENIED', reason: 'permission denied' },
  ] });
  assert.equal(locked.message, '2 files could not be read. a.csv: another app has it locked.');
  assert.equal(locked.fix, null);
});

test('problems of Lasso\'s own come with a fix', () => {
  const failed = directoryIssue({ ...healthy, activationError: { message: 'Index unavailable', code: null } });
  assert.equal(failed.kind, 'ACTIVATION');
  assert.deepEqual(failed.fix, { label: 'Try Again' });
  assert.match(failed.message, /Index unavailable/);

  const behind = directoryIssue({ ...healthy, readerBehind: true });
  assert.equal(behind.kind, 'READER');
  assert.deepEqual(behind.fix, { label: 'Re-read Files' });

  const exhausted = directoryIssue({ ...healthy, failures: [
    { path: 'a.csv', code: 'BUSY', reason: 'file is locked by another process' },
    { path: 'b.csv', code: 'TOO_MANY_FILES', reason: 'too many open files' },
  ] });
  assert.equal(exhausted.message, '2 files could not be read. b.csv: Lasso had too many files open at once.');
  assert.deepEqual(exhausted.fix, { label: 'Try Again' });
});

test('the most serious issue is the one shown', () => {
  const failures = [{ path: 'a.csv', code: 'BUSY', reason: 'file is locked by another process' }];
  assert.equal(directoryIssue({ ...healthy, available: false, readerBehind: true, failures }).kind, 'UNAVAILABLE');
  assert.equal(directoryIssue({ ...healthy, activationError: { message: 'x', code: null }, failures }).kind, 'ACTIVATION');
  // Re-reading with the newer reader may recover files an older one could not read.
  assert.equal(directoryIssue({ ...healthy, readerBehind: true, failures }).kind, 'READER');
});

async function workspace(t, files) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-directory-issues-'));
  const root = path.join(sandbox, 'Work');
  fs.mkdirSync(root);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  await app.workspace.add([fs.realpathSync(root)], actor);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const id = app.workspace.state().directories[0].id;
  const issue = () => app.workspace.state().directories[0].issue;
  return { app, root, sandbox, id, issue };
}

test('the work directory list reports each folder\'s issue', async t => {
  const { app, root, sandbox, id, issue } = await workspace(t, {
    'data.csv': 'Account,Value\nSupplies,400\n', 'Budget.xlsx': 'not a workbook',
  });
  app.dependencies.ensureIndex(id);
  assert.equal(issue().kind, 'FILES');
  assert.match(issue().message, /^Budget\.xlsx could not be read/);
  assert.equal(issue().fix, null);
  await assert.rejects(app.workspace.fixIssue(id, actor), { status: 409 });

  // A sibling with the folder's identity would be followed as a rename, so it goes further away.
  fs.mkdirSync(path.join(sandbox, 'offline'));
  fs.renameSync(root, path.join(sandbox, 'offline', 'Work'));
  assert.equal(issue().kind, 'UNAVAILABLE');
  assert.equal(issue().fix, null);
});

test('Fix re-reads a folder indexed by an older reader', async t => {
  const { app, id, issue } = await workspace(t, { 'data.csv': 'Account,Value\nSupplies,400\n' });
  app.dependencies.ensureIndex(id);
  assert.equal(issue(), null);
  const snapshotId = app.timeline.getProject(id).currentSnapshotId;
  app.db.prepare('UPDATE snapshot_object_indexes SET extractor_version = 0 WHERE snapshot_id = ?').run(snapshotId);
  assert.equal(issue().kind, 'READER');
  const state = await app.workspace.fixIssue(id, actor);
  assert.equal(state.directories[0].issue, null);
});

test('Fix starts a folder again after Lasso failed to start it', async t => {
  const { app, id, issue } = await workspace(t, { 'data.csv': 'Account,Value\nSupplies,400\n' });
  await app.workspace.toggle(id, false, actor);
  const failing = t.mock.method(app.dependencies, 'warmPredictionCaches', () => { throw new Error('Index unavailable'); });
  await assert.rejects(app.workspace.toggle(id, true, actor), { status: 400 });
  assert.equal(issue().kind, 'ACTIVATION');
  assert.deepEqual(issue().fix, { label: 'Try Again' });
  failing.mock.restore();

  // The same request the menu's Fix button sends.
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/workspace/directories/${id}/fix`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor }),
  });
  assert.equal(response.status, 200);
  const directory = (await response.json()).directories[0];
  assert.equal(directory.active, true);
  assert.equal(directory.issue, null);
});
