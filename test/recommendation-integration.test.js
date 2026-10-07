import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { anchorForSpan } from '../src/dependencies/service.js';

const writer = { id: 'human:ranking', displayName: 'Ranking Writer', actorType: 'HUMAN_SELF' };

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-ranking-integration-'));
  const root = path.join(temporary, 'workspace');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'draft.md'), '# Draft\n\nSupplies were 120.\n');
  for (const name of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
    fs.writeFileSync(path.join(root, `${name}.csv`), 'Account,Current Period\nSupplies,120\nTravel,80\nPayroll,700\n');
  }
  fs.writeFileSync(path.join(root, 'alpha.md'), 'The interface is optimized for desktop and tablet use.\n');
  fs.writeFileSync(path.join(root, 'beta.md'), 'The interface is designed for focused scientific writing.\n');
  const application = createApplication({ dataDir: path.join(temporary, 'history'), watchProjects: false });
  const project = application.timeline.importProject(root, writer, { watch: false }).project;
  application.dependencies.ensureIndex(project.id);
  t.after(async () => {
    await application.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const source = application.dependencies.objectsAt(project.id)
    .find((object) => object.path === 'beta.csv' && object.objectType === 'DATASET_ROW' && object.label === 'Supplies');
  assert.ok(source);
  const link = {
    documentPath: 'draft.md', anchor: anchorForSpan(1, 'paragraph', 'Supplies were 120.', 0, 8),
    spanText: 'Supplies', sourceObjectId: source.id, sourceSnapshotId: source.snapshotId,
    selectionMethod: 'AUTOCOMPLETE', sessionId: 'writing-session',
  };
  return { application, project, source, link, root, temporary };
}

test('accepted human links record usage atomically and influence project suggestions', async (t) => {
  const { application: app, project, link } = fixture(t);
  const { dependencies, timeline } = app;
  assert.deepEqual(dependencies.ranking.usage(project.id), []);
  const before = timeline.getProject(project.id).currentSnapshotId;
  assert.throws(() => dependencies.link(project.id, { ...link, spanText: 'wrong text' }, writer));
  assert.equal(timeline.getProject(project.id).currentSnapshotId, before);
  assert.deepEqual(dependencies.ranking.usage(project.id), []);
  const linked = dependencies.link(project.id, link, writer).dependency;
  assert.equal(dependencies.ranking.usage(project.id)[0].acceptedSessions, 1);
  assert.equal(dependencies.search(project.id, '')[0].path, 'beta.csv');
  const matches = dependencies.search(project.id, 'Supplies', { documentPath: 'draft.md' });
  assert.equal(matches[0].path, 'beta.csv');
  assert.equal(matches[0].ranking.relationship, true);
  assert.ok(matches.some((candidate) => candidate.path !== 'beta.csv'));
  dependencies.linkMany(project.id, { links: [link, link], sessionId: 'writing-session' }, writer);
  assert.equal(dependencies.ranking.usage(project.id)[0].acceptedSessions, 1);
  dependencies.link(project.id, { ...link, selectionMethod: 'SYSTEM_LINKED', sessionId: 'robot-session' },
    { ...writer, id: 'agent:ranking', actorType: 'AI_AGENT' });
  assert.equal(dependencies.ranking.usage(project.id)[0].acceptedSessions, 1);
  dependencies.recordRecommendationUsage(project.id, { dependencyId: linked.id, kind: 'open', sessionId: 'inspector' });
  assert.equal(dependencies.ranking.usage(project.id)[0].openedSessions, 1);
});

test('typing uses the shared ranking, preserves match confidence and stays quiet on weak input', (t) => {
  const { application: app, project } = fixture(t);
  const input = { text: 'We found that Sup', documentPath: 'draft.md' };
  app.dependencies.recordRecommendationUsage(project.id, { path: 'beta.csv', kind: 'accept', sessionId: 'typing' });
  const prediction = app.dependencies.predict(project.id, input);
  const candidates = prediction.claims.flatMap((claim) => claim.candidates);
  assert.ok(candidates.length > 0 && candidates.length <= 5);
  assert.equal(candidates[0].path, 'beta.csv');
  assert.equal(candidates[0].ranking.relevanceScore, candidates[0].score);
  assert.ok(candidates[0].ranking.usageBoost > 0);
  const empty = app.dependencies.predict(project.id, { text: 'Some completely ordinary prose' });
  assert.equal(empty.claims.flatMap((claim) => claim.candidates).length, 0);
  assert.equal(empty.workspaceCompletions.length, 0);
  assert.equal(empty.completion, null);
  assert.deepEqual(app.dependencies.search(project.id, 'qz'), []);
  assert.deepEqual(app.dependencies.search(project.id, 'unfindable-text'), []);
});

test('sentence completions use accepted-source preferences without bypassing exclusions', (t) => {
  const { application: app, project, root } = fixture(t);
  app.dependencies.recordRecommendationUsage(project.id, { path: 'beta.md', kind: 'accept', sessionId: 'sentences' });
  const input = { text: 'The interface is', documentPath: 'draft.md' };
  const completion = app.dependencies.predict(project.id, input).completion;
  assert.equal(completion.source.path, 'beta.md');
  assert.equal(completion.confidence, 0.99);
  assert.ok(completion.dependencyCandidate.ranking.usageBoost > 0);
  fs.writeFileSync(path.join(root, 'alpha.md'), fs.readFileSync(path.join(root, 'beta.md')));
  app.timeline.capture(project.id, writer);
  assert.equal(app.dependencies.predict(project.id, input).completion.source.path, 'beta.md');
  app.dependencies.suppressedPathPrefixes = () => ['beta.md'];
  assert.equal(app.dependencies.predict(project.id, input).completion.source.path, 'alpha.md');
});

test('explicit Lasso allows broader matches and twelve choices while typing caps strong choices at five', (t) => {
  const { application: app, project } = fixture(t);
  const strong = { text: 'Supplies were 120.', documentPath: 'draft.md' };
  assert.equal(app.dependencies.predict(project.id, strong).claims.flatMap((claim) => claim.candidates).length, 5);
  assert.equal(app.dependencies.predict(project.id, { ...strong, surface: 'search' })
    .claims.flatMap((claim) => claim.candidates).length, 12);
  const weak = { text: 'Supplies chromatic orbital were 121.', documentPath: 'draft.md' };
  for (let index = 0; index < 30; index += 1) {
    app.dependencies.recordRecommendationUsage(project.id, { path: 'beta.csv', kind: 'accept', sessionId: `popular-${index}` });
  }
  assert.deepEqual(app.dependencies.predict(project.id, weak).claims.flatMap((claim) => claim.candidates), []);
  const broader = app.dependencies.predict(project.id, { ...weak, surface: 'search' }).claims.flatMap((claim) => claim.candidates);
  assert.ok(broader.length > 5 && broader.length <= 12);
  assert.ok(broader.every((candidate) => candidate.matchStrength < 0.4));
});

test('file search protects exact values and identifiers from popular partial content matches', (t) => {
  const { application: app, project, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'exact.json'), JSON.stringify({ measurement: 314, identifier: 'IL_6' }));
  fs.writeFileSync(path.join(root, 'popular.json'), JSON.stringify({ measurement: 3140, identifier: 'IL_60' }));
  app.timeline.capture(project.id, writer);
  for (let index = 0; index < 30; index += 1) {
    app.dependencies.recordRecommendationUsage(project.id, { path: 'popular.json', kind: 'accept', sessionId: `popular-${index}` });
  }
  const value = app.dependencies.search(project.id, '314');
  assert.equal(value[0].path, 'exact.json');
  assert.equal(value[0].ranking.reason, 'Exact value match');
  assert.equal(value.find((candidate) => candidate.path === 'popular.json').ranking.tier, 1);
  const identity = app.dependencies.search(project.id, value[0].id);
  assert.equal(identity[0].id, value[0].id);
  assert.equal(identity[0].ranking.reason, 'Exact identifier match');
  assert.equal(app.dependencies.search(project.id, 'IL_6')[0].path, 'exact.json');
  assert.ok(app.dependencies.search(project.id, '', { sourcePath: 'popular.json', diversify: false })
    .every((candidate) => candidate.path === 'popular.json'));
  assert.equal(app.dependencies.search(project.id, '', { sourcePath: 'exact.json', diversify: false }).length, 2);
});

test('search and terminal completion preserve distinct citable works in a shared bibliography', (t) => {
  const { application: app, project, root } = fixture(t);
  const bibliography = Array.from({ length: 4 }, (_, index) => `@article{work${index},\n title={Shared evidence study ${index}},\n author={Researcher, Anne},\n year={2024},\n doi={10.1234/study${index}}\n}`).join('\n');
  fs.writeFileSync(path.join(root, 'references.bib'), bibliography);
  fs.writeFileSync(path.join(root, 'other.bib'), '@article{workOutside,\n title={Shared evidence study outside},\n author={Researcher, Bob},\n year={2025}\n}');
  app.timeline.capture(project.id, writer);
  const results = app.dependencies.search(project.id, 'Shared evidence');
  assert.equal(results.filter((candidate) => candidate.path === 'references.bib').length, 4);
  assert.ok(results.some((candidate) => candidate.path === 'other.bib'));
  assert.equal(app.dependencies.search(project.id, '10.1234/study3')[0].metadata.citationKey, 'work3');
  const terminal = app.terminal.graph.search(project.id, 'Shared evidence');
  assert.equal(terminal.filter((candidate) => candidate.path === 'references.bib').length, 4);
  const completions = app.terminal.executor.complete(project.id, 'trace work').suggestions;
  assert.equal(completions.length, 5);
  assert.equal(completions.filter((candidate) => candidate.path === 'references.bib').length, 4);
  assert.equal(new Set(completions.map((candidate) => candidate.objectId)).size, 5);
});

test('every supplied usage identity is checked before recording project activity', (t) => {
  const { application: app, project, source, link, temporary } = fixture(t);
  const dependency = app.dependencies.link(project.id, link, writer).dependency;
  const otherRoot = path.join(temporary, 'second-project');
  fs.mkdirSync(otherRoot);
  fs.writeFileSync(path.join(otherRoot, 'foreign.csv'), 'metric,value\nforeign,10\n');
  const other = app.timeline.importProject(otherRoot, writer, { watch: false }).project;
  const foreign = app.dependencies.objectsAt(other.id)[0];
  assert.throws(() => app.dependencies.recordRecommendationUsage(project.id, {
    objectId: foreign.id, dependencyId: dependency.id, path: source.path, kind: 'open',
  }), { status: 404 });
  for (const invalid of ['', null, false, 0, {}]) {
    for (const key of ['objectId', 'dependencyId']) {
      assert.throws(() => app.dependencies.recordRecommendationUsage(project.id, {
        [key]: invalid, path: source.path, kind: 'open',
      }), { status: 400 });
    }
  }
  const another = app.dependencies.objectsAt(project.id).find((candidate) => candidate.path === 'alpha.csv');
  assert.throws(() => app.dependencies.recordRecommendationUsage(project.id, {
    objectId: another.id, dependencyId: dependency.id, kind: 'open',
  }), { status: 400 });
  assert.equal(app.dependencies.ranking.usage(project.id)[0].openedSessions, 0);
});

test('exact aliases rank as direct matches while partial aliases remain broader picker matches', (t) => {
  const { application: app, project, source } = fixture(t);
  app.terminal.aliases.create(project.id, { name: 'custom-source-name', objectKey: source.objectKey }, writer, app.terminal.graph);
  const exact = app.dependencies.search(project.id, 'custom-source-name');
  assert.equal(exact[0].id, source.id);
  assert.equal(exact[0].ranking.tier, 0);
  const partial = app.dependencies.search(project.id, 'source');
  assert.equal(partial[0].id, source.id);
  assert.equal(partial[0].ranking.tier, 1);
  assert.equal(partial[0].ranking.reason, 'Matches a source alias');
  assert.equal(partial[0].score, 0.75);
  assert.deepEqual(app.terminal.executor.complete(project.id, 'trace source').suggestions, []);
  const terminal = app.terminal.graph.search(project.id, 'custom-source-name');
  assert.equal(terminal[0].id, source.id);
  assert.equal(terminal[0].ranking.tier, 0);
  assert.equal(app.terminal.graph.resolve(project.id, 'custom-source-name').object.id, source.id);
});

test('usage API validates identity and records only explicit actions', async (t) => {
  const { application: app, project, source, root, temporary } = fixture(t);
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (url, body) => fetch(`${base}${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const endpoint = `/api/projects/${project.id}/recommendation-usage`;
  const objectResponse = await fetch(`${base}/api/dependency-objects/${source.id}`);
  assert.equal((await objectResponse.json()).object.projectId, project.id);
  await fetch(`${base}/api/projects/${project.id}/dependency-objects?query=Supplies`);
  await fetch(`${base}/api/projects/${project.id}/terminal/complete?input=find%20Sup`);
  await post(`/api/projects/${project.id}/terminal/preview`, { ref: { objectId: source.id } });
  await post(`/api/projects/${project.id}/dependencies/predict`, { text: 'We found that Sup' });
  assert.deepEqual(app.dependencies.ranking.usage(project.id), []);
  const first = await post(endpoint, { objectId: source.id, kind: 'accept', sessionId: 'native' });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).usage.recorded, true);
  const duplicate = await post(endpoint, { objectId: source.id, kind: 'accept', sessionId: 'native' });
  assert.equal((await duplicate.json()).usage.recorded, false);
  assert.equal((await post(endpoint, { objectId: source.id, kind: 'open', sessionId: 'native' })).status, 200);
  for (const body of [
    { objectId: source.id, kind: 'impression' }, { path: '/etc/passwd', kind: 'open' },
    { objectId: 'missing', kind: 'accept' }, { dependencyId: {}, kind: 'open' },
    { objectId: source.id, kind: 'accept', sessionId: {} },
  ]) assert.ok([400, 404].includes((await post(endpoint, body)).status));
  const otherRoot = path.join(temporary, 'other');
  fs.mkdirSync(otherRoot);
  fs.writeFileSync(path.join(otherRoot, 'beta.csv'), 'Account,Current Period\nSupplies,5\n');
  const other = app.timeline.importProject(otherRoot, writer, { watch: false }).project;
  assert.equal((await post(`/api/projects/${other.id}/recommendation-usage`, {
    objectId: source.id, path: 'beta.csv', kind: 'open',
  })).status, 404);
  assert.deepEqual(app.dependencies.ranking.usage(other.id), []);
  fs.renameSync(path.join(root, 'beta.csv'), path.join(root, 'renamed.csv'));
  app.timeline.capture(project.id, writer);
  const renamed = await post(endpoint, { objectId: source.id, kind: 'open', sessionId: 'after-rename' });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).usage.path, 'renamed.csv');
  assert.equal(app.dependencies.ranking.usage(project.id)[0].path, 'renamed.csv');
});
