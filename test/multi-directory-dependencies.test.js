import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { anchorForSpan } from '../src/dependencies/service.js';

const actor = { id: 'human:directories', displayName: 'Directory writer', actorType: 'HUMAN_SELF' };

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-directory-dependencies-'));
  const sourceRoot = path.join(sandbox, 'Sources');
  const documentRoot = path.join(sandbox, 'Documents');
  const otherRoot = path.join(sandbox, 'Other');
  for (const root of [sourceRoot, documentRoot, otherRoot]) fs.mkdirSync(root);
  fs.writeFileSync(path.join(sourceRoot, 'data.csv'), 'Account,Value\nSupplies,400\nTravel,80\n');
  fs.writeFileSync(path.join(documentRoot, 'draft.md'), '# Report\n\nSupplies cost 400.\n');
  fs.writeFileSync(path.join(otherRoot, 'data.csv'), 'Account,Value\nSupplies,900\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => {
    await app.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const sourceProject = app.timeline.importProject(sourceRoot, actor, { watch: false }).project;
  const documentProject = app.timeline.importProject(documentRoot, actor, { watch: false }).project;
  const otherProject = app.timeline.importProject(otherRoot, actor, { watch: false }).project;
  const source = app.dependencies.objectsAt(sourceProject.id)
    .find((object) => object.objectType === 'DATASET_VALUE' && object.valueText === '400');
  assert.ok(source);
  const link = {
    documentPath: 'draft.md', anchor: anchorForSpan(1, 'paragraph', 'Supplies cost 400.', 14, 17),
    spanText: '400', sourceObjectId: source.id, sourceSnapshotId: source.snapshotId,
    selectionMethod: 'AUTOCOMPLETE', sessionId: 'cross-directory-writing',
  };
  const active = new Set([sourceProject.id, documentProject.id, otherProject.id]);
  app.dependencies.workspace = { isActive: (projectId) => active.has(projectId) };
  return { app, sourceRoot, documentRoot, sourceProject, documentProject, otherProject, source, link, active };
}

test('foreign sources keep destination history, source identity and usage separate', (t) => {
  const { app, sourceProject, documentProject, source, link } = fixture(t);
  const sourceVersion = app.timeline.getProject(sourceProject.id).currentVersion;
  const linked = app.dependencies.link(documentProject.id, link, actor).dependency;
  assert.equal(linked.status, 'LINKED');
  assert.equal(linked.source.projectId, sourceProject.id);
  assert.equal(linked.source.snapshotId, source.snapshotId);
  assert.equal(app.timeline.getSnapshot(linked.snapshotId).projectId, documentProject.id);
  assert.equal(app.timeline.getProject(sourceProject.id).currentVersion, sourceVersion);
  assert.equal(app.dependencies.ranking.usage(sourceProject.id)[0].acceptedSessions, 1);
  assert.deepEqual(app.dependencies.ranking.usage(documentProject.id), []);
  app.dependencies.recordRecommendationUsage(documentProject.id, {
    dependencyId: linked.id, objectId: source.id, kind: 'open', sessionId: 'cross-directory-inspector',
  });
  assert.equal(app.dependencies.ranking.usage(sourceProject.id)[0].openedSessions, 1);
  assert.throws(() => app.dependencies.objectsAt(documentProject.id, source.snapshotId), { status: 400 });
  assert.throws(() => app.dependencies.recordRecommendationUsage(documentProject.id, {
    objectId: source.id, kind: 'open', sessionId: 'foreign-identity-without-dependency',
  }), { status: 404 });
  const sourceShare = app.objectShares.createShare({ projectId: sourceProject.id, objectId: source.id, actor });
  assert.equal(app.objectShares.resolveShare(sourceShare.token).status, 'OK');
});

test('source edits reconcile foreign references and apply updates only to destination documents', (t) => {
  const { app, sourceRoot, documentRoot, sourceProject, documentProject, otherProject, source, link } = fixture(t);
  const linked = app.dependencies.link(documentProject.id, link, actor).dependency;
  assert.throws(() => app.dependencies.planSourceValueUpdate(otherProject.id, source.id), { status: 404 });
  fs.writeFileSync(path.join(sourceRoot, 'data.csv'), 'Account,Value\nSupplies,438\nTravel,80\n');
  app.timeline.capture(sourceProject.id, actor);
  assert.equal(app.dependencies.getDependency(linked.id).status, 'STALE');
  const sourceHead = app.timeline.getProject(sourceProject.id).currentSnapshotId;
  const plan = app.dependencies.planSourceValueUpdate(documentProject.id, source.id);
  assert.equal(plan.object.projectId, sourceProject.id);
  assert.equal(plan.object.snapshotId, sourceHead);
  assert.equal(plan.rewrites, 1);
  assert.equal(plan.edits[0].nextSpanText, '438');
  const applied = app.dependencies.applySourceValueUpdate(documentProject.id, source.id, actor);
  assert.equal(applied.applied.length, 1);
  assert.match(fs.readFileSync(path.join(documentRoot, 'draft.md'), 'utf8'), /Supplies cost 438/);
  assert.equal(app.timeline.getProject(sourceProject.id).currentSnapshotId, sourceHead);
  const revised = app.dependencies.getDependency(linked.id);
  assert.equal(revised.status, 'LINKED');
  assert.equal(revised.source.snapshotId, sourceHead);
  assert.equal(revised.source.valueText, '438');
  assert.equal(app.timeline.getSnapshot(revised.snapshotId).projectId, documentProject.id);
});

test('source update preflights every destination before writing or capturing uncaptured changes', (t) => {
  const { app, sourceRoot, documentRoot, sourceProject, documentProject, source, link } = fixture(t);
  app.dependencies.link(documentProject.id, link, actor);
  fs.writeFileSync(path.join(documentRoot, 'second.md'), '# Report\n\nSupplies cost 400.\n');
  app.timeline.capture(documentProject.id, actor);
  app.dependencies.link(documentProject.id, { ...link, documentPath: 'second.md' }, actor);
  fs.writeFileSync(path.join(sourceRoot, 'data.csv'), 'Account,Value\nSupplies,438\nTravel,80\n');
  app.timeline.capture(sourceProject.id, actor);
  const snapshotId = app.timeline.getProject(documentProject.id).currentSnapshotId;
  fs.appendFileSync(path.join(documentRoot, 'second.md'), '\nUncaptured note.\n');
  assert.throws(() => app.dependencies.applySourceValueUpdate(documentProject.id, source.id, actor), { status: 409 });
  assert.equal(fs.readFileSync(path.join(documentRoot, 'draft.md'), 'utf8'), '# Report\n\nSupplies cost 400.\n');
  assert.match(fs.readFileSync(path.join(documentRoot, 'second.md'), 'utf8'), /Uncaptured note/);
  assert.equal(app.timeline.getProject(documentProject.id).currentSnapshotId, snapshotId);
});

test('source update refuses a source value that changed again before watcher capture', (t) => {
  const { app, sourceRoot, documentRoot, sourceProject, documentProject, source, link } = fixture(t);
  app.dependencies.link(documentProject.id, link, actor);
  fs.writeFileSync(path.join(sourceRoot, 'data.csv'), 'Account,Value\nSupplies,438\nTravel,80\n');
  app.timeline.capture(sourceProject.id, actor);
  fs.writeFileSync(path.join(sourceRoot, 'data.csv'), 'Account,Value\nSupplies,500\nTravel,80\n');
  assert.throws(() => app.dependencies.applySourceValueUpdate(documentProject.id, source.id, actor), { status: 409 });
  assert.match(fs.readFileSync(path.join(documentRoot, 'draft.md'), 'utf8'), /Supplies cost 400/);
});

test('disabled directories reject new foreign links but retain historical previews and keep decisions', (t) => {
  const { app, sourceRoot, sourceProject, documentProject, source, link, active } = fixture(t);
  const linked = app.dependencies.linkMany(documentProject.id, { links: [link] }, actor).dependencies[0];
  fs.writeFileSync(path.join(sourceRoot, 'data.csv'), 'Account,Value\nSupplies,438\nTravel,80\n');
  app.timeline.capture(sourceProject.id, actor);
  active.delete(sourceProject.id);
  const before = app.timeline.getProject(documentProject.id).currentSnapshotId;
  assert.throws(() => app.dependencies.link(documentProject.id, link, actor), { status: 409 });
  assert.equal(app.timeline.getProject(documentProject.id).currentSnapshotId, before);
  assert.equal(app.dependencies.getDependency(linked.id).source.valueText, '400');
  assert.ok(app.dependencies.dependencyPreview(linked.id));
  assert.equal(app.dependencies.keepCurrentValue(documentProject.id, source.id, actor).kept.length, 1);
  app.dependencies.reconcileProject(documentProject.id);
  const kept = app.dependencies.getDependency(linked.id);
  assert.equal(kept.status, 'LINKED');
  assert.equal(kept.statusDetails.pinnedHistoricalVersion, true);
});

test('linked foreign source predictions use that source directory and avoid same-path collisions', (t) => {
  const { app, sourceProject, documentProject, source } = fixture(t);
  const text = 'Value for Supplies is ';
  const prediction = app.dependencies.predict(documentProject.id, {
    text,
    pendingDependencies: [{ sourceObjectId: source.id, sourceSnapshotId: source.snapshotId, start: 10, end: 18 }],
  });
  assert.equal(prediction.sourceContext.source.projectId, sourceProject.id);
  assert.ok(prediction.workspaceCompletions.length);
  assert.ok(prediction.workspaceCompletions.every((completion) => completion.dependencyCandidate.projectId === sourceProject.id));
  assert.ok(prediction.workspaceCompletions.some((completion) => completion.replacementText.includes('400')));
});

test('capturing one directory leaves other prediction corpora warm', (t) => {
  const { app, sourceRoot, sourceProject, documentProject, otherProject } = fixture(t);
  for (const project of [sourceProject, documentProject, otherProject]) app.dependencies.warmPredictionCaches(project.id);
  const otherHead = app.timeline.getProject(otherProject.id).currentSnapshotId;
  const otherCorpus = app.dependencies.workspaceRetrievalCache.get(otherHead);
  fs.writeFileSync(path.join(sourceRoot, 'data.csv'), 'Account,Value\nSupplies,438\nTravel,80\n');
  app.timeline.capture(sourceProject.id, actor);
  assert.equal(app.dependencies.workspaceRetrievalCache.get(otherHead), otherCorpus);
  assert.equal(app.dependencies.workspaceRetrievalObjects(otherProject.id), otherCorpus);
});

test('terminal commands resolve referenced foreign sources and preserve source previews and destination writes', (t) => {
  const { app, sourceRoot, documentRoot, sourceProject, documentProject, source, link } = fixture(t);
  const linked = app.dependencies.link(documentProject.id, link, actor).dependency;
  const graph = app.terminal.graph;
  const object = graph.objectById(documentProject.id, source.id);
  assert.equal(object.projectId, sourceProject.id);
  assert.equal(graph.resolve(documentProject.id, object.name).object.id, source.id);
  const shared = app.objectShares.createShare({ projectId: sourceProject.id, objectId: source.id, actor });
  const traced = graph.trace(documentProject.id, object);
  assert.equal(traced.sourceProjectId, sourceProject.id);
  assert.equal(traced.references.length, 1);
  assert.equal(traced.references[0].dependencyId, linked.id);
  assert.ok(traced.shares.some((share) => share.id === shared.id));
  assert.equal(graph.impactOf(documentProject.id, [object]).documents[0].documentPath, 'draft.md');
  const preview = app.terminal.executor.preview(documentProject.id, { objectId: source.id });
  assert.equal(preview.projectId, sourceProject.id);
  assert.equal(preview.kind, 'table');
  assert.ok(preview.rows.some((row) => row.cells.includes('400')));
  assert.ok(app.terminal.executor.complete(documentProject.id, `trace ${object.name.slice(0, 3)}`)
    .suggestions.some((suggestion) => suggestion.objectId === source.id));
  fs.writeFileSync(path.join(sourceRoot, 'data.csv'), 'Account,Value\nSupplies,438\nTravel,80\n');
  app.timeline.capture(sourceProject.id, actor);
  const current = graph.objectById(documentProject.id, source.id);
  assert.equal(current.valueText, '438');
  const changes = graph.valueChanges(documentProject.id);
  assert.ok(changes.some((change) => change.objectId === source.id && change.currentValue === '438'
    && change.projectId === sourceProject.id && change.unresolvedReferences === 1));
  const applied = app.terminal.executor.run(documentProject.id, `update ${object.name} --apply`, actor);
  assert.equal(applied.ok, true);
  assert.match(fs.readFileSync(path.join(documentRoot, 'draft.md'), 'utf8'), /Supplies cost 438/);
  assert.equal(app.dependencies.getDependency(linked.id).status, 'LINKED');
  const unlinked = app.terminal.executor.run(documentProject.id, `unlink ${object.name} --apply`, actor);
  assert.equal(unlinked.ok, true);
  assert.deepEqual(app.dependencies.currentDependencies(documentProject.id), []);
});

test('index status counts every enabled root and labels disabled roots accurately', (t) => {
  const { app, sourceProject, documentProject, otherProject } = fixture(t);
  app.db.prepare('UPDATE projects SET workspace_active = 0 WHERE id = ?').run(otherProject.id);
  const status = app.terminal.indexing.status(documentProject.id);
  assert.equal(status.workspace.directories, 2);
  assert.equal(status.grantedDirectories.find((directory) => directory.id === sourceProject.id).active, true);
  assert.equal(status.grantedDirectories.find((directory) => directory.id === documentProject.id).active, true);
  assert.equal(status.grantedDirectories.find((directory) => directory.id === otherProject.id).active, false);
});

test('workspace uses the newest eligible linked source across roots', async (t) => {
  const { app, sourceProject, otherProject, source } = fixture(t);
  app.dependencies.workspace = app.workspace;
  const newer = app.dependencies.objectsAt(otherProject.id)
    .find((object) => object.objectType === 'DATASET_VALUE' && object.valueText === '900');
  const text = 'Supplies then Supplies is ';
  const prediction = await app.workspace.predict({ text, pendingDependencies: [
    { sourceObjectId: source.id, sourceSnapshotId: source.snapshotId, start: 0, end: 8 },
    { sourceObjectId: newer.id, sourceSnapshotId: newer.snapshotId, start: 14, end: 22 },
  ] });
  assert.equal(prediction.sourceContext.source.id, newer.id);
  assert.equal(prediction.sourceContext.source.projectId, otherProject.id);
  assert.ok(prediction.workspaceCompletions.length);
  assert.ok(prediction.workspaceCompletions.every((completion) => completion.projectId === otherProject.id));
  assert.ok(prediction.workspaceCompletions.some((completion) => completion.replacementText.includes('900')));
  assert.ok(prediction.workspaceCompletions.every((completion) => !completion.replacementText.includes('400')));
  const olderScope = await app.workspace.predict({ text, sourceScopeBoundary: 10, pendingDependencies: [
    { sourceObjectId: source.id, sourceSnapshotId: source.snapshotId, start: 0, end: 8 },
    { sourceObjectId: newer.id, sourceSnapshotId: newer.snapshotId, start: 14, end: 22, blockIndex: 1 },
  ] });
  assert.ok(!olderScope.sourceContext?.source);
  assert.ok(!olderScope.workspaceCompletions.some((completion) => completion.replacementText === '900'));
  assert.notEqual(sourceProject.id, otherProject.id);
});

test('failed directory reactivation rolls back active status and reports a recoverable error', async (t) => {
  const { app, sourceRoot, sourceProject } = fixture(t);
  await app.workspace.toggle(sourceProject.id, false, actor);
  const original = app.dependencies.warmPredictionCaches.bind(app.dependencies);
  t.mock.method(app.dependencies, 'warmPredictionCaches', (projectId, ...args) => {
    if (projectId === sourceProject.id) throw new Error('Index unavailable');
    return original(projectId, ...args);
  });
  await assert.rejects(app.workspace.add([sourceRoot], actor), { status: 400 });
  assert.equal(app.workspace.isActive(sourceProject.id), false);
  assert.equal(app.timeline.watchers.has(sourceProject.id), false);
  assert.match(app.workspace.state().directories.find((directory) => directory.id === sourceProject.id).error, /Index unavailable/);
});

test('live directory loss invalidates an in-flight workspace prediction', async (t) => {
  const { app, sourceRoot, sourceProject } = fixture(t);
  const prediction = app.workspace.predict({ text: 'Supplies cost 400.' });
  const rejected = assert.rejects(prediction, { status: 409 });
  fs.renameSync(sourceRoot, `${sourceRoot}-offline`);
  await rejected;
  assert.ok(app.workspace.activeProjects().every((project) => project.id !== sourceProject.id));
  assert.throws(() => app.workspace.terminalRun('find Supplies', actor, { projectId: sourceProject.id }), { status: 409 });
});

test('workspace browsing prefers recent use across roots before older frequent use', (t) => {
  const { app, sourceProject, otherProject } = fixture(t);
  const oldTime = Date.parse('2026-09-01T00:00:00Z');
  let clock = oldTime;
  app.dependencies.ranking.now = () => clock;
  for (let session = 0; session < 30; session++) {
    app.dependencies.recordRecommendationUsage(sourceProject.id, {
      path: 'data.csv', kind: 'accept', sessionId: `old-${session}`,
    });
  }
  clock += 4 * 24 * 60 * 60 * 1000;
  app.dependencies.recordRecommendationUsage(otherProject.id, { path: 'data.csv', kind: 'accept', sessionId: 'recent' });
  const objects = app.workspace.search('', { limit: 10, enrich: false });
  assert.equal(objects[0].projectId, otherProject.id);
  assert.ok(objects.some((object) => object.projectId === sourceProject.id));
});

test('natural terminal questions query every enabled work directory', (t) => {
  const { app, otherProject } = fixture(t);
  const answer = app.workspace.terminalRun('what is 900?', actor);
  assert.equal(answer.command, 'ask');
  assert.ok(answer.data.projects.some((entry) => entry.projectId === otherProject.id && entry.answered));
});

test('RFI follows a foreign source into the provenance recorded by its owning directory', (t) => {
  const { app, sourceProject, documentProject, source, link } = fixture(t);
  app.timeline.addProvenanceLink(sourceProject.id, {
    fromSnapshotId: source.snapshotId, fromPath: source.path, fromAnchor: source.anchor,
    relation: 'GENERATED_BY', toSnapshotId: source.snapshotId, toPath: 'analysis.py',
  });
  app.dependencies.link(documentProject.id, link, actor);
  const rfi = app.rfi.request(documentProject.id, {
    path: 'draft.md', anchor: { kind: 'markdown-block', blockIndex: 1, selection: { start: 14, end: 17 } },
  });
  assert.equal(rfi.selection.value, '400');
  assert.equal(rfi.linkedDependency.source.projectId, sourceProject.id);
  assert.ok(rfi.provenance.some((item) => item.relation === 'DEPENDS_ON'));
  assert.ok(rfi.provenance.some((item) => item.relation === 'GENERATED_BY' && item.to.path === 'analysis.py'));
});
