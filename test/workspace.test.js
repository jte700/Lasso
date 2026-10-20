import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { createApplication } from '../src/server.js';

const actor = { id: 'human:workspace-test', displayName: 'Workspace test', actorType: 'HUMAN_SELF' };

async function fixture(t, count = 3, rows = 4) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-workspace-'));
  const roots = Array.from({ length: count }, (_, directory) => {
    const root = path.join(temporary, `Directory-${directory}`);
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'data.csv'), 'Metric,Value\n'
      + Array.from({ length: rows }, (_, row) => `Supplies ${row},${directory * 1000 + row + 120}`).join('\n') + '\n');
    fs.writeFileSync(path.join(root, 'draft.md'), 'Supplies were 120.\n');
    return fs.realpathSync(root);
  });
  const dataDir = path.join(temporary, 'history');
  let app = createApplication({ dataDir, watchProjects: false });
  await app.workspace.add(roots, actor);
  const projects = roots.map((root) => app.workspace.state().directories.find((p) => p.rootPath === root));
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  return { get app() { return app; }, roots, projects, dataDir,
    async restart(watchProjects = false) {
      await app.close();
      app = createApplication({ dataDir, watchProjects, watchDebounceMs: 30 });
      await app.workspace.ready;
      return app;
    } };
}

test('workspace searches every enabled root and preserves duplicate filenames and owners', async (t) => {
  const { app, projects } = await fixture(t);
  const objects = app.workspace.search('Supplies', { limit: 100, diversify: false, enrich: false });
  assert.deepEqual(new Set(objects.map((o) => o.projectId)), new Set(projects.map((p) => p.id)));
  assert.ok(objects.every((o) => o.rootPath && o.projectName));
  const prediction = await app.workspace.predict({ text: 'Supplies were 120.', surface: 'search' });
  const candidates = [...prediction.sourceCompletions, ...prediction.workspaceCompletions,
    ...prediction.claims.flatMap((c) => c.candidates)];
  assert.ok(candidates.length);
  assert.ok(candidates.every((o) => projects.some((p) => p.id === o.projectId)));
  assert.ok(candidates.length <= 12);
  assert.equal(prediction.generatedText, false);
  await app.workspace.toggle(projects[0].id, false, actor);
  assert.ok(app.workspace.search('Supplies', { limit: 100 }).every((o) => o.projectId !== projects[0].id));
  const disabledPrediction = await app.workspace.predict({ text: 'Supplies were 120.', surface: 'search' });
  assert.ok(disabledPrediction.claims.flatMap((c) => c.candidates).every((o) => o.projectId !== projects[0].id));
  for (const project of projects.slice(1)) await app.workspace.toggle(project.id, false, actor);
  const empty = await app.workspace.predict({ text: 'Supplies were 120.' });
  assert.deepEqual(empty.claims, []);
  assert.deepEqual(empty.workspaceCompletions, []);
  assert.equal(empty.completion, null);
});

test('toggles persist, disabled watchers stop, and enabling reconciles offline edits', async (t) => {
  const state = await fixture(t, 2);
  const [first, second] = state.projects;
  const before = state.app.timeline.getProject(first.id).currentSnapshotId;
  await state.app.workspace.toggle(first.id, false, actor);
  fs.writeFileSync(path.join(state.roots[0], 'data.csv'), 'Metric,Value\nSupplies,999\n');
  const app = await state.restart(true);
  assert.equal(app.workspace.isActive(first.id), false);
  assert.equal(app.timeline.watchers.has(first.id), false);
  assert.equal(app.timeline.watchers.has(second.id), true);
  assert.equal(app.timeline.getProject(first.id).currentSnapshotId, before);
  await app.workspace.toggle(first.id, true, actor);
  assert.equal(app.timeline.watchers.has(first.id), true);
  assert.notEqual(app.timeline.getProject(first.id).currentSnapshotId, before);
  assert.ok(app.workspace.search('Supplies', { limit: 100 }).some((o) => o.projectId === first.id && o.valueText === '999'));
  await app.workspace.toggle(first.id, false, actor);
  assert.equal(app.timeline.watchers.has(first.id), false);
  assert.equal(app.timeline.pendingTimers.has(first.id), false);
});

test('removing a directory hides it, stops watching, and adding it again restores its history', async (t) => {
  const state = await fixture(t, 2);
  const app = await state.restart(true);
  const [first, second] = state.projects;
  const history = app.timeline.getProject(first.id).currentSnapshotId;
  const removed = await app.workspace.remove(first.id);
  assert.deepEqual(removed.directories.map((d) => d.id), [second.id]);
  assert.equal(app.timeline.watchers.has(first.id), false);
  assert.ok(app.workspace.search('Supplies', { limit: 100 }).every((o) => o.projectId !== first.id));
  assert.ok(fs.existsSync(path.join(state.roots[0], 'data.csv')));
  const restored = await app.workspace.add([state.roots[0]], actor);
  const back = restored.directories.find((d) => d.rootPath === state.roots[0]);
  assert.equal(back.id, first.id);
  assert.equal(back.active, true);
  assert.equal(app.timeline.getProject(first.id).currentSnapshotId, history);
});

test('removing several directories at once takes out exactly the chosen folders', async (t) => {
  const state = await fixture(t, 3);
  const app = await state.restart(true);
  const [first, second, third] = state.projects;
  const removed = await app.workspace.removeMany([first.id, third.id]);
  assert.deepEqual(removed.directories.map((d) => d.id), [second.id]);
  assert.equal(app.timeline.watchers.has(first.id), false);
  assert.equal(app.timeline.watchers.has(third.id), false);
  assert.equal(app.timeline.watchers.has(second.id), true);
  assert.ok(state.roots.every((root) => fs.existsSync(path.join(root, 'data.csv'))), 'folders stay on disk');
  const restored = await app.workspace.add([state.roots[0], state.roots[2]], actor);
  assert.deepEqual(new Set(restored.directories.map((d) => d.id)), new Set([first.id, second.id, third.id]));
});

test('a bulk removal naming an unknown directory removes nothing', async (t) => {
  const { app, projects } = await fixture(t, 2);
  await assert.rejects(app.workspace.removeMany([projects[0].id, 'missing-project']), { status: 404 });
  assert.deepEqual(app.workspace.state().directories.map((d) => d.id), projects.map((p) => p.id));
  assert.throws(() => app.workspace.removeMany([]), { status: 400 });
  assert.throws(() => app.workspace.removeMany('not-a-list'), { status: 400 });
});

test('the bulk removal route removes every listed directory in one request', async (t) => {
  const { app, projects, roots } = await fixture(t, 3);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const removeMany = (projectIds) => fetch(`${base}/api/workspace/directories`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectIds }),
  });
  assert.equal((await removeMany([])).status, 400);
  assert.equal((await removeMany([projects[0].id, 'missing-project'])).status, 404);
  const response = await removeMany([projects[0].id, projects[1].id]);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).directories.map((d) => d.id), [projects[2].id]);
  assert.ok(fs.existsSync(path.join(roots[0], 'data.csv')), 'removing never touches the folder on disk');
});

test('a directory renamed on disk stays linked under its new name', async (t) => {
  const state = await fixture(t, 2);
  const app = await state.restart(true);
  const [first, second] = state.projects;
  await app.workspace.toggle(second.id, false, actor);
  const renamed = path.join(path.dirname(state.roots[0]), 'Renamed Directory');
  const renamedOff = path.join(path.dirname(state.roots[1]), 'Renamed Paused');
  fs.renameSync(state.roots[0], renamed);
  fs.renameSync(state.roots[1], renamedOff);
  const directories = app.workspace.state().directories;
  const moved = directories.find((d) => d.id === first.id);
  assert.equal(moved.rootPath, fs.realpathSync(renamed));
  assert.equal(moved.name, 'Renamed Directory');
  assert.equal(moved.available, true);
  assert.equal(moved.active, true);
  assert.equal(moved.error, null);
  assert.equal(app.timeline.watchers.has(first.id), true);
  const paused = directories.find((d) => d.id === second.id);
  assert.equal(paused.name, 'Renamed Paused');
  assert.equal(paused.active, false);
  assert.ok(app.workspace.search('Supplies', { limit: 100 }).some((o) => o.projectId === first.id));
  fs.writeFileSync(path.join(renamed, 'data.csv'), 'Metric,Value\nSupplies,4321\n');
  app.timeline.capture(first.id, actor);
  assert.ok(app.workspace.search('Supplies', { limit: 100 }).some((o) => o.projectId === first.id && o.valueText === '4321'));
  fs.rmSync(renamed, { recursive: true });
  assert.equal(app.workspace.state().directories.find((d) => d.id === first.id).available, false);
});

test('a directory renamed before its identity was recorded is found by its files', async (t) => {
  const state = await fixture(t, 2);
  const app = await state.restart(true);
  const [first] = state.projects;
  const renamed = path.join(path.dirname(state.roots[0]), 'Finance');
  fs.mkdirSync(path.join(path.dirname(state.roots[0]), 'Unrelated'));
  app.db.prepare('UPDATE projects SET root_inode = NULL').run();
  fs.renameSync(state.roots[0], renamed);
  const moved = app.workspace.state().directories.find((d) => d.id === first.id);
  assert.equal(moved.rootPath, fs.realpathSync(renamed));
  assert.equal(moved.name, 'Finance');
  assert.equal(moved.available, true);
});

test('folder recovery preserves file IDs larger than JavaScript safe integers', async (t) => {
  const originalStat = fs.statSync;
  t.mock.method(fs, 'statSync', function (target, options) {
    const stat = originalStat.call(this, target, options);
    if (stat.isFile()) {
      const exact = originalStat.call(this, target, { bigint: true }).ino + (1n << 60n);
      stat.ino = options?.bigint ? exact : Number(exact);
    }
    return stat;
  });
  const state = await fixture(t, 1);
  const app = await state.restart(true);
  const [first] = state.projects;
  const renamed = path.join(path.dirname(state.roots[0]), 'Finance');
  app.db.prepare('UPDATE projects SET root_inode = NULL').run();
  fs.renameSync(state.roots[0], renamed);
  const moved = app.workspace.state().directories.find((directory) => directory.id === first.id);
  assert.equal(moved.rootPath, fs.realpathSync(renamed));
  assert.equal(moved.available, true);
});

test('directory adding is canonical, validates all roots, and tolerates an unavailable enabled folder on restart', async (t) => {
  const state = await fixture(t, 2);
  await state.app.workspace.add([state.roots[0], `${state.roots[0]}/.`], actor);
  assert.equal(state.app.workspace.state().directories.length, 2);
  await assert.rejects(state.app.workspace.add([state.roots[0], path.join(state.roots[0], 'missing')], actor), { status: 400 });
  // Moved out of its parent, so it is unavailable rather than renamed.
  const offline = path.join(path.dirname(state.roots[0]), 'offline');
  fs.mkdirSync(offline);
  fs.renameSync(state.roots[0], path.join(offline, path.basename(state.roots[0])));
  const app = await state.restart(true);
  const missing = app.workspace.state().directories.find((p) => p.id === state.projects[0].id);
  assert.equal(missing.available, false);
  assert.ok(missing.error);
  assert.deepEqual(app.workspace.activeProjects().map((p) => p.id), [state.projects[1].id]);
  assert.equal(app.timeline.watchers.has(state.projects[1].id), true);
});

test('independent live watchers capture changes in every enabled directory', async (t) => {
  const state = await fixture(t, 3);
  const app = await state.restart(true);
  await app.workspace.toggle(state.projects[2].id, false, actor);
  const heads = state.projects.map((p) => app.timeline.getProject(p.id).currentSnapshotId);
  for (const [index, root] of state.roots.entries()) {
    fs.writeFileSync(path.join(root, 'data.csv'), `Metric,Value\nSupplies,${777 + index}\n`);
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && state.projects.slice(0, 2).some((p, i) => app.timeline.getProject(p.id).currentSnapshotId === heads[i])) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  for (const [index, project] of state.projects.slice(0, 2).entries()) {
    assert.notEqual(app.timeline.getProject(project.id).currentSnapshotId, heads[index]);
    assert.ok(app.workspace.search('Supplies', { limit: 100 }).some((o) => o.projectId === project.id && o.valueText === String(777 + index)));
  }
  assert.equal(app.timeline.getProject(state.projects[2].id).currentSnapshotId, heads[2]);
});

test('workspace review finds cross-directory documents and applies source updates to their owners', async (t) => {
  const { app, projects, roots } = await fixture(t, 3);
  const [sourceProject, destination] = projects;
  const source = app.dependencies.objectsAt(sourceProject.id).find((o) => o.objectType === 'DATASET_VALUE' && o.valueText === '120');
  const document = app.dependencies.getDocument(destination.id, 'draft.md');
  app.dependencies.link(destination.id, {
    documentPath: 'draft.md', sourceObjectId: source.id, sourceSnapshotId: source.snapshotId,
    spanText: 'Supplies were 120.', anchor: { kind: 'manuscript-span', blockIndex: 0, start: 0, end: 18 },
  }, actor);
  fs.writeFileSync(path.join(roots[0], 'data.csv'), 'Metric,Value\nSupplies 0,456\n');
  app.timeline.capture(sourceProject.id, actor);
  const plan = app.workspace.sourceValuePlan(source.id);
  assert.equal(plan.object.projectId, sourceProject.id);
  assert.equal(plan.rewrites, 1);
  assert.equal(plan.edits[0].projectId, destination.id);
  assert.equal(plan.projects.length, 3);
  const applied = app.workspace.applySourceValuePlan(source.id, 'apply', actor, plan);
  assert.equal(applied.applied.length, 1);
  assert.equal(applied.applied[0].projectId, destination.id);
  assert.match(fs.readFileSync(path.join(roots[1], 'draft.md'), 'utf8'), /456/);
  assert.match(fs.readFileSync(path.join(roots[2], 'draft.md'), 'utf8'), /120/);
  assert.equal(app.dependencies.getDocument(destination.id, document.path).dependencies[0].status, 'LINKED');
});

test('workspace terminal aggregates results, previews the owner, and refuses ambiguous mutations', async (t) => {
  const { app, projects } = await fixture(t);
  const answer = await app.workspace.terminalRun('find Supplies', actor);
  assert.equal(answer.ok, true);
  assert.ok(answer.results.length);
  assert.deepEqual(new Set(answer.results.map((r) => r.ref.projectId)), new Set(projects.map((p) => p.id)));
  const ref = answer.results[0].ref;
  assert.ok(app.workspace.terminalPreview(ref));
  assert.equal(app.workspace.terminalSession().directories, 3);
  const completion = app.workspace.terminalComplete('find Sup');
  assert.ok(completion.suggestions.every((s) => s.projectId));
  assert.equal((await app.workspace.terminalRun('unlink Supplies', actor)).ok, false);
  const old = app.timeline.getProject(projects[0].id).currentSnapshotId;
  await app.workspace.toggle(projects[0].id, false, actor);
  assert.throws(() => app.workspace.terminalRun('find Supplies', actor, { projectId: projects[0].id }), { status: 409 });
  assert.equal(app.timeline.getProject(projects[0].id).currentSnapshotId, old);
});

test('workspace prediction cancels an in-flight request after directory toggles', async (t) => {
  const { app, projects } = await fixture(t);
  const prediction = app.workspace.predict({ text: 'Supplies were 120.' });
  const rejected = assert.rejects(prediction, { status: 409 });
  await app.workspace.toggle(projects[0].id, false, actor);
  await rejected;
});

test('source reviews reject changes that arrive while an apply request body is uploading', async (t) => {
  for (const scope of ['workspace', 'project']) await t.test(scope, async (t) => {
    const { app, projects: [project], roots: [root] } = await fixture(t, 1);
    const source = app.dependencies.objectsAt(project.id).find((object) =>
      object.objectType === 'DATASET_VALUE' && object.valueText === '120');
    app.dependencies.link(project.id, {
      documentPath: 'draft.md', sourceObjectId: source.id, sourceSnapshotId: source.snapshotId,
      spanText: '120', anchor: { kind: 'manuscript-span', blockIndex: 0, start: 14, end: 17 },
    }, actor);
    fs.writeFileSync(path.join(root, 'data.csv'), 'Metric,Value\nSupplies 0,456\n');
    app.timeline.capture(project.id, actor);
    const expectedPlan = scope === 'workspace' ? app.workspace.sourceValuePlan(source.id)
      : app.dependencies.planSourceValueUpdate(project.id, source.id);
    assert.equal(expectedPlan.rewrites, 1);
    const request = new PassThrough();
    request.method = 'POST';
    request.headers = { host: '127.0.0.1' };
    request.url = scope === 'workspace' ? `/api/workspace/source-review/${source.id}`
      : `/api/projects/${project.id}/source-review/${source.id}`;
    const response = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    const pending = app.server.listeners('request')[0](request, response);
    // The handler is waiting for the body. A watcher can capture a new source
    // version during that wait, after the user reviewed the previous version.
    fs.writeFileSync(path.join(root, 'data.csv'), 'Metric,Value\nSupplies 0,789\n');
    app.timeline.capture(project.id, actor);
    request.end(JSON.stringify({ actor, action: 'apply', expectedPlan }));
    await pending;
    assert.equal(response.status, 409, response.body);
    assert.equal(fs.readFileSync(path.join(root, 'draft.md'), 'utf8'), 'Supplies were 120.\n');
  });
});

test('shutdown cancels a yielded directory import without accessing closed storage', async (t) => {
  const { app, roots } = await fixture(t, 1);
  const imported = t.mock.method(app.timeline, 'importProject');
  const pending = app.workspace.add(roots, actor);
  const rejected = assert.rejects(pending, { status: 503 });
  await yieldTurn();
  await app.close();
  await rejected;
  assert.equal(imported.mock.callCount(), 0);
  assert.equal(app.timeline.watchers.size, 0);
  await app.close();
});

test('warm multi-directory predictions reuse all indexes with bounded latency', async (t) => {
  const { app } = await fixture(t, 8, 120);
  const input = { text: 'The cost of Supplies 5 is', surface: 'search' };
  await app.workspace.predict(input);
  let reads = 0;
  const original = app.timeline.blobs.get.bind(app.timeline.blobs);
  app.timeline.blobs.get = (...args) => { reads += 1; return original(...args); };
  const timings = [];
  for (let run = 0; run < 8; run++) {
    const start = performance.now();
    await app.workspace.predict(input);
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  t.diagnostic(`8 directories, 960 data rows: median ${timings[4].toFixed(1)} ms, max ${timings.at(-1).toFixed(1)} ms, ${reads} source reads`);
  assert.equal(reads, 0, 'warm searches never rescan or re-extract source content');
  assert.ok(timings[4] < 500, 'warm combined suggestions remain below the typing interaction budget');
});

test('desktop directory requests add, pause, and reactivate with a structured actor', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-desktop-workspace-'));
  const app = createApplication({ dataDir: path.join(temporary, 'history'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  const root = path.join(temporary, 'Desktop Directory');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'data.csv'), 'Metric,Value\nSupplies,120\n');
  const desktopActor = { id: 'human:desktop', displayName: 'Desktop', actorType: 'HUMAN_SELF' };
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (route, body) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  const rejected = await post('/api/workspace/directories', { rootPaths: [root], actor: 'desktop' });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error.message, 'Actor displayName is required.');

  const added = await post('/api/workspace/directories', { rootPaths: [root], actor: desktopActor });
  assert.equal(added.status, 200);
  const state = await added.json();
  assert.equal(state.directories.length, 1);
  const directory = state.directories[0];
  assert.equal(directory.rootPath, fs.realpathSync(root));
  assert.equal(directory.active, true);
  assert.equal(directory.available, true);
  assert.equal(directory.error, null);
  assert.equal(typeof state.revision, 'string');
  assert.deepEqual(state.activeProjectIds, [directory.id]);

  const route = `/api/workspace/directories/${directory.id}`;
  const paused = await post(route, { active: false, actor: desktopActor });
  assert.equal(paused.status, 200);
  const pausedState = await paused.json();
  assert.equal(pausedState.directories[0].active, false);
  assert.deepEqual(pausedState.activeProjectIds, []);
  assert.notEqual(pausedState.revision, state.revision);

  fs.writeFileSync(path.join(root, 'data.csv'), 'Metric,Value\nSupplies,456\n');
  const reactivated = await post(route, { active: true, actor: desktopActor });
  assert.equal(reactivated.status, 200);
  const activeState = await reactivated.json();
  assert.equal(activeState.directories[0].active, true);
  assert.equal(activeState.directories[0].error, null);
  assert.deepEqual(activeState.activeProjectIds, [directory.id]);
  assert.notEqual(activeState.revision, pausedState.revision);
  assert.ok(app.workspace.search('Supplies').some((object) => object.valueText === '456'));
});

test('workspace HTTP routes expose toggles and predictions without enabling disabled projects on open', async (t) => {
  const { app, projects, roots } = await fixture(t, 2);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (route, body) => fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, actor }),
  });
  assert.equal((await fetch(`${base}/api/workspace`)).status, 200);
  assert.equal((await post(`/api/workspace/directories/${projects[0].id}`, { active: false })).status, 200);
  assert.equal((await post(`/api/projects/${projects[0].id}/open`, {})).status, 409);
  const predictionResponse = await post('/api/workspace/dependencies/predict', { text: 'Supplies were 120.' });
  assert.equal(predictionResponse.status, 200);
  const body = await predictionResponse.json();
  assert.ok(body.prediction.workspaceRevision);
  assert.ok(body.prediction.claims.flatMap((c) => c.candidates).every((o) => o.projectId === projects[1].id));
  const library = await (await fetch(`${base}/api/workspace/source-library?query=Supplies`)).json();
  assert.ok(library.objects.every((o) => o.projectId === projects[1].id));
  assert.equal((await post('/api/workspace/directories', { rootPaths: [] })).status, 400);

  await post(`/api/workspace/directories/${projects[0].id}`, { active: true });
  const source = app.dependencies.objectsAt(projects[0].id).find((o) => o.objectType === 'DATASET_VALUE' && o.valueText === '120');
  const linked = await post(`/api/projects/${projects[1].id}/dependencies`, {
    documentPath: 'draft.md', sourceObjectId: source.id, sourceSnapshotId: source.snapshotId,
    spanText: 'Supplies were 120.', anchor: { kind: 'manuscript-span', blockIndex: 0, start: 0, end: 18 },
  });
  assert.equal(linked.status, 201);
  fs.writeFileSync(path.join(roots[0], 'data.csv'), 'Metric,Value\nSupplies 0,456\n');
  app.timeline.capture(projects[0].id, actor);
  const reviewRoute = `/api/workspace/source-review/${source.id}`;
  const outdated = (await (await fetch(`${base}${reviewRoute}`)).json()).plan;
  assert.equal(outdated.edits[0].projectId, projects[1].id);
  fs.writeFileSync(path.join(roots[0], 'data.csv'), 'Metric,Value\nSupplies 0,789\n');
  app.timeline.capture(projects[0].id, actor);
  assert.equal((await post(reviewRoute, { action: 'apply', expectedPlan: outdated })).status, 409);
  const reviewed = (await (await fetch(`${base}${reviewRoute}`)).json()).plan;
  assert.equal((await post(reviewRoute, { action: 'apply', expectedPlan: reviewed })).status, 200);
  assert.match(fs.readFileSync(path.join(roots[1], 'draft.md'), 'utf8'), /789/);

  const remove = (id) => fetch(`${base}/api/workspace/directories/${id}`, { method: 'DELETE' });
  assert.equal((await remove('missing-project')).status, 404);
  const removed = await remove(projects[0].id);
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json()).directories.map((d) => d.id), [projects[1].id]);
  assert.ok(fs.existsSync(path.join(roots[0], 'data.csv')), 'removing never touches the folder on disk');
});

test('notch activity reports pinned source changes, excludes paused folders and does not rewrite documents', async t => {
  const { app, projects, roots } = await fixture(t, 2, 1);
  const first = projects[0];
  app.dependencies.ensureIndex(first.id);
  const source = app.dependencies.objectsAt(first.id).find(o => o.objectType === 'DATASET_VALUE' && o.valueText === '120');
  app.dependencies.getDocument(projects[1].id, 'draft.md');
  app.dependencies.link(projects[1].id, {
    documentPath: 'draft.md', sourceObjectId: source.id, sourceSnapshotId: source.snapshotId,
    spanText: 'Supplies were 120.', anchor: {kind:'manuscript-span', blockIndex:0, start:0, end:18},
  }, actor);
  fs.writeFileSync(path.join(roots[0], 'data.csv'), 'Metric,Value\nSupplies 0,450\n');
  app.timeline.capture(first.id, actor, { source: 'EXPLICIT_CHECKPOINT' });
  const activity = app.workspace.activity();
  assert.equal(activity.directories, 2);
  const change = activity.changes.find(item => item.previousValue === '120' && item.currentValue === '450');
  assert.ok(change);
  assert.equal(change.projectId, first.id);
  assert.equal(change.fileName, 'data.csv');
  assert.equal(change.referenceCount, 1, 'notch includes references in a different enabled directory');
  assert.equal(change.unresolvedReferences, 1, 'notch reports the changed cross-directory reference');
  assert.ok(change.toVersion > change.fromVersion);
  assert.equal(fs.readFileSync(path.join(roots[0], 'draft.md'), 'utf8'), 'Supplies were 120.\n');
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/workspace/activity`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).activity, activity);
  await app.workspace.toggle(first.id, false, actor);
  assert.equal(app.workspace.activity().changes.length, 0, 'disabled sources must not appear in the notch');
  fs.mkdirSync(path.join(path.dirname(roots[1]), 'offline'));
  fs.renameSync(roots[1], path.join(path.dirname(roots[1]), 'offline', path.basename(roots[1])));
  const unavailable = app.workspace.activity();
  assert.equal(unavailable.directories, 0);
  assert.equal(unavailable.failures, 1, 'an unavailable enabled folder remains visible as an issue');
  assert.deepEqual(unavailable.changes, []);
});

test('a folder that was unavailable at startup comes back on its own when it reappears', async (t) => {
  // Arrange: the folder is away (an unmounted drive) when Lasso starts.
  const state = await fixture(t, 1);
  const [root] = state.roots;
  const away = path.join(path.dirname(path.dirname(root)), `away-${path.basename(root)}-${process.pid}`);
  fs.renameSync(root, away);
  t.after(() => fs.rmSync(away, { recursive: true, force: true }));
  const app = await state.restart(false);
  await app.workspace.restore();
  assert.equal(app.workspace.state().activeProjectIds.length, 0);

  // Act: the drive is mounted again.
  fs.renameSync(away, root);
  const recovered = app.workspace.state();

  // Assert
  assert.equal(recovered.directories[0].error, null);
  assert.deepEqual(recovered.activeProjectIds, [state.projects[0].id]);
});

test('notch activity is reused until the workspace or its indexing issues change', async (t) => {
  // Arrange
  const state = await fixture(t, 1);
  const app = state.app;
  const first = app.workspace.activity();
  const sessions = t.mock.method(app.workspace, 'terminalSession');

  // Act
  const repeated = app.workspace.activity();
  fs.writeFileSync(path.join(state.roots[0], 'draft.md'), 'Supplies were 121.\n');
  app.timeline.capture(state.projects[0].id, actor);
  app.workspace.activity();

  // Assert
  assert.deepEqual(repeated, first);
  assert.equal(sessions.mock.callCount(), 1, 'recomputed only after the folder changed');
});
