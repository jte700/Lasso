import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { directoryIssue, directoryNote } from '../src/directory-issues.js';

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

  const locked = directoryIssue({ ...healthy, failures: [
    { path: 'a.csv', code: 'BUSY', reason: 'file is locked by another process' },
    { path: 'b.csv', code: 'PERMISSION_DENIED', reason: 'permission denied' },
  ] });
  assert.equal(locked.message, '2 files could not be read. a.csv: another app has it locked.');
  assert.equal(locked.fix, null);
});

test('what the readers made of files they read is a note, not an issue', () => {
  const damaged = [{ path: 'Reports/Budget.xlsx', code: 'UNREADABLE_CONTENT',
    reason: 'This workbook could not be read. It may be password-protected, damaged or too large.' }];
  assert.equal(directoryIssue({ ...healthy, failures: damaged }), null, 'a damaged workbook does not badge its folder');
  assert.deepEqual(directoryNote(damaged), { kind: 'NOTES',
    message: 'Budget.xlsx could not be read. It may be password-protected, damaged or too large.' });

  // A sheet read in part and an unsupported CAD export are what nearly every
  // real folder holds; badging them put a warning on every folder.
  const sheet = { path: 'data/DeathCounts.xlsx', code: 'PARTIALLY_INDEXED',
    reason: 'Sheet “Sheet1” could not be read (too large or damaged). The other sheets are indexed.' };
  const model = { path: 'nist.stp', code: 'DRAWING_UNSUPPORTED', reason: 'Cannot read STEP geometry.' };
  assert.equal(directoryIssue({ ...healthy, failures: [sheet, model] }), null);
  assert.match(directoryNote([sheet, model]).message, /^1 file was not indexed; 1 file was only partially indexed\./);

  // A file that could not be read from disk still badges the folder, and the
  // badge names it rather than the reader's notes.
  const locked = { path: 'a.csv', code: 'BUSY', reason: 'file is locked by another process' };
  assert.equal(directoryIssue({ ...healthy, failures: [sheet, locked] }).message, 'a.csv: another app has it locked.');
  assert.equal(directoryNote([locked]), null);
  assert.equal(directoryNote([]), null);
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
  assert.equal(issue(), null, 'a workbook the reader could not open is not a folder problem');
  assert.match(app.workspace.state().directories[0].note.message, /^Budget\.xlsx could not be read/);
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
  const failing = t.mock.method(app.dependencies, 'warmPredictionCacheSteps', function* () { throw new Error('Index unavailable'); });
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


test('partial geometry and unsupported formats are not reported as unreadable files', () => {
  const partials = Array.from({ length: 6 }, (_, index) => ({ path: `part${index}.stp`, code: 'DRAWING_PARTIAL',
    reason: 'Some curved-face extents cannot be bounded exactly. The other measurements are indexed.' }));
  const partial = directoryNote(partials);
  assert.match(partial.message, /^6 files were only partially indexed\./);
  assert.doesNotMatch(partial.message, /could not be read/);
  assert.match(directoryNote(partials.slice(0, 1)).message, /^part0\.stp was only partially indexed\./);
  const mixed = directoryNote([partials[0],
    { path: 'bad.xlsx', code: 'UNREADABLE_CONTENT', reason: 'This workbook could not be read. It may be damaged.' },
    { path: 'native.dwg', code: 'DRAWING_UNSUPPORTED', reason: 'Export a DXF drawing to index this file.' },
  ]);
  assert.equal(mixed.message, '1 file could not be read; 1 file was not indexed; 1 file was only partially indexed. bad.xlsx: This workbook could not be read. It may be damaged.');
  assert.match(directoryNote([{ path: 'native.dwg', code: 'DRAWING_UNSUPPORTED',
    reason: 'Export a DXF drawing to index this file.' }]).message,
  /^native\.dwg was not indexed\. Export a DXF drawing/);
});

test('index limits report missing indexing rather than failed file reads', () => {
  const issue = directoryNote([
    { path: 'a.csv', code: 'PARTIALLY_INDEXED', reason: 'Only some items were indexed because the folder limit was reached.' },
    { path: 'b.csv', code: 'NOT_INDEXED_LIMIT', reason: 'The folder limit was reached.' },
    { path: 'b.csv', code: 'NOT_INDEXED_LIMIT', reason: 'The folder limit was reached.' },
  ]);
  assert.match(issue.message, /^1 file was not indexed; 1 file was only partially indexed\./);
  assert.match(issue.message, /b\.csv: The folder limit was reached/);
  assert.doesNotMatch(issue.message, /could not be read/);
});
