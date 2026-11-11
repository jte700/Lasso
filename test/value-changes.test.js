// A suggested value that changed recently says what it was, once, in the
// suggestion's own `change` field; a value typed as it was before the change
// is offered its current value; a preview lists the value's history; and
// The Ranch's Recent Changes name the value a save changed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

const actor = { id: 'human:writer', displayName: 'Writer', actorType: 'HUMAN_SELF' };

const BUDGET = (total) => `Line,Amount\nRent,4200\nPayroll,${total}\nSoftware,950\n`;

async function folder(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-value-changes-'));
  const root = fs.realpathSync(sandbox) + '/Budget';
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'budget.csv'), BUDGET('18400'));
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  await app.workspace.add([root], actor);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const project = app.timeline.listProjects().find((item) => item.rootPath === root);
  const save = (total) => {
    fs.writeFileSync(path.join(root, 'budget.csv'), BUDGET(total));
    app.timeline.capture(project.id, actor);
    app.dependencies.ensureIndex(project.id);
  };
  const payroll = () => app.dependencies.objectsAt(project.id).find((object) => object.label === 'Payroll · Amount');
  return { app, project, save, payroll };
}

const typed = (app, text) => app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });

/** Every suggestion in a prediction, whichever group it came in. */
const suggestions = (prediction) => [
  ...prediction.claims.flatMap((claim) => claim.candidates),
  ...prediction.sourceCompletions, ...prediction.workspaceCompletions,
  ...(prediction.completion ? [prediction.completion] : []),
];

test('A suggestion whose value changed recently says what it was', async (t) => {
  // Arrange
  const { app, save } = await folder(t);
  save('19250');

  // Act
  const offered = suggestions(await typed(app, 'Payroll was 1'))
    .find((item) => (item.dependencyCandidate ?? item).label === 'Payroll · Amount');

  // Assert
  assert.ok(offered, 'payroll is suggested');
  assert.equal(offered.change?.kind, 'edited');
  assert.equal(offered.change.previousValue, '18400');
  assert.equal(offered.change.currentValue, '19250');
  assert.ok(offered.change.changedAt && offered.change.snapshotId);
});

test('A value accepted since it changed is not called out again', async (t) => {
  // Arrange
  const { app, project, save, payroll } = await folder(t);
  save('19250');
  await new Promise((resolve) => setTimeout(resolve, 5));
  app.dependencies.recordRecommendationUsage(project.id, { objectId: payroll().id, kind: 'accept', sessionId: 'typing' });

  // Act
  const offered = suggestions(await typed(app, 'Payroll was 1'))
    .find((item) => (item.dependencyCandidate ?? item).label === 'Payroll · Amount');

  // Assert
  assert.ok(offered);
  assert.equal(offered.change, undefined);
});

test('A suggestion whose value never changed carries no change', async (t) => {
  // Arrange
  const { app } = await folder(t);

  // Act
  const offered = suggestions(await typed(app, 'Payroll was 1'))
    .find((item) => (item.dependencyCandidate ?? item).label === 'Payroll · Amount');

  // Assert
  assert.ok(offered);
  assert.equal(Object.hasOwn(offered, 'change'), false);
});

test('Typing the earlier value of a changed cell offers the current one', async (t) => {
  // Arrange
  const { app, project, save, payroll } = await folder(t);
  app.dependencies.recordRecommendationUsage(project.id, { objectId: payroll().id, kind: 'accept', sessionId: 'typing' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  save('19250');

  // Act
  const prediction = await typed(app, 'Payroll was 18400');
  const stale = suggestions(prediction).find((item) => item.change?.kind === 'stale-typed');

  // Assert
  assert.ok(stale, 'the changed cell is offered');
  assert.equal(stale.change.previousValue, '18400');
  assert.equal(stale.change.currentValue, '19250');
  assert.equal(stale.valueText, '19250');
});

test('Typing an earlier value of a source never used is left alone', async (t) => {
  // Arrange
  const { app, save } = await folder(t);
  save('19250');

  // Act
  const prediction = await typed(app, 'Payroll was 18400');

  // Assert
  assert.equal(suggestions(prediction).some((item) => item.change?.kind === 'stale-typed'), false);
});

test('A preview lists the value history of its object', async (t) => {
  // Arrange
  const { app, project, save, payroll } = await folder(t);
  save('18900');
  save('19250');
  app.server.listen(0, '127.0.0.1');
  await new Promise((resolve) => app.server.once('listening', resolve));

  // Act
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/dependency-objects/${payroll().id}/preview?projectId=${project.id}`);
  const preview = await response.json();

  // Assert
  assert.equal(response.status, 200);
  assert.deepEqual(preview.history.map((entry) => entry.value), ['19250', '18900', '18400']);
});

test('Recent Changes name the value a save changed', async (t) => {
  // Arrange
  const { app, project, save } = await folder(t);
  save('19250');

  // Act
  const { entries } = app.ranch.recentChanges ? app.ranch.recentChanges() : { entries: [] };
  const { recentHistory } = await import('../src/ranch/history.js');
  const history = recentHistory(app.db, [project.id], Date.now());
  const edited = history.entries.find((entry) => entry.change === 'edited');

  // Assert
  assert.ok(Array.isArray(entries));
  assert.equal(edited?.valueChanges?.count, 1);
  assert.deepEqual(edited.valueChanges.first, { label: 'Payroll · Amount', before: '18400', after: '19250' });
});

test('A Needs Review row for a changed link says the old and new value and the claim', async (t) => {
  // Arrange
  const { linkReviewItems, shareReviewItems } = await import('../src/ranch/review.js');
  const link = { id: 'd1', projectId: 'p', documentPath: 'memo.md', status: 'STALE', spanText: 'Payroll came to 18400',
    statusDetails: { linkedSourceValue: '18400', currentSourceValue: '19250' },
    source: { projectId: 'p', path: 'budget.csv', label: 'Payroll · Amount', valueText: '18400' } };
  const share = { id: 's1', drifted: true, directoryId: 'p', path: 'budget.csv', fileId: 'f',
    sharedValue: '18400', currentValue: '19250', documentPath: 'memo.md' };

  // Act
  const [changed] = linkReviewItems([link], () => 'f');
  const [drifted] = shareReviewItems([share]);

  // Assert
  assert.deepEqual({ before: changed.before, after: changed.after, claim: changed.claim, document: changed.document },
    { before: '18400', after: '19250', claim: 'Payroll came to 18400', document: 'memo.md' });
  assert.deepEqual({ before: drifted.before, after: drifted.after, document: drifted.document },
    { before: '18400', after: '19250', document: 'memo.md' });
  assert.deepEqual(drifted.documents, []);
});
