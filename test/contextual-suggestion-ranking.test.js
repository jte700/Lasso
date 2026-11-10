import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

const actor = { id: 'human:context-ranking', displayName: 'Context ranking', actorType: 'HUMAN_SELF' };

async function fixture(t, separateRoots = false) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-context-ranking-'));
  const roots = [...new Set(['north', 'south'].map((region) => path.join(temporary, separateRoots ? region : 'project')))];
  for (const [index, region] of ['north', 'south'].entries()) {
    const directory = separateRoots ? roots[index] : path.join(roots[0], region);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'sales.csv'), `Metric,Value\nRevenue,${index ? 200 : 100}\nCosts,80\n`);
  }
  const app = createApplication({ dataDir: path.join(temporary, 'history'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  await app.workspace.add(roots, actor);
  const projects = app.workspace.state().directories;
  const northPath = separateRoots ? 'sales.csv' : 'north/sales.csv';
  const north = projects.find((project) => separateRoots ? project.name === 'north'
    : app.timeline.snapshotFile(project.currentSnapshotId, northPath));
  for (let index = 0; index < 30; index += 1) {
    app.dependencies.recordRecommendationUsage(north.id,
      { path: northPath, kind: 'accept', sessionId: `popular-${index}` });
  }
  return { app, projects, north };
}

const candidates = (prediction) => prediction.claims.flatMap((claim) => claim.candidates);

test('the current sentence selects the right source before equal names are deduplicated', async (t) => {
  const { app, north } = await fixture(t);
  const predict = (text) => app.dependencies.predict(north.id, { text });
  const selected = candidates(predict('The south region Rev'));
  assert.equal(selected[0].completionText, 'Revenue');
  assert.equal(selected[0].path, 'south/sales.csv');
  assert.ok(selected[0].ranking.contextScore > 0);
  // The same name in another document follows it as its own suggestion.
  assert.deepEqual(selected.filter((candidate) => candidate.completionText === 'Revenue')
    .map((candidate) => candidate.path), ['south/sales.csv', 'north/sales.csv']);
  assert.equal(candidates(predict('The north region Rev'))[0].path, 'north/sales.csv');
  assert.equal(candidates(predict('The south region was reviewed. The Rev'))[0].path, 'north/sales.csv',
    'an earlier sentence must not override the current sentence and usage preference');
  assert.equal(candidates(predict('The unknown region Rev'))[0].path, 'north/sales.csv',
    'unmatched context must preserve valid name completions');
});

test('sentence context remains ahead of popularity when suggestions merge across directories', async (t) => {
  const { app } = await fixture(t, true);
  const prediction = await app.workspace.predict({ text: 'The south region Rev' });
  assert.equal(candidates(prediction)[0].path, 'sales.csv');
  assert.equal(candidates(prediction)[0].projectName, 'south');
  assert.ok(candidates(prediction)[0].ranking.contextScore > 0);
  assert.equal(prediction.deterministic, true);
  assert.equal(prediction.generatedText, false);
});

test('an unknown topic keeps contextual suggestions quiet before and after the word boundary', async (t) => {
  const { app, north } = await fixture(t);
  const predict = (text) => app.dependencies.predict(north.id, { text });
  // Reporting cues name no source, so they offer nothing either.
  assert.deepEqual(predict('Our results showed that').workspaceCompletions, []);
  for (const text of ['Our results showed geomembrane', 'Our results showed geomembrane ',
    'Our results showed geomembr']) {
    const prediction = predict(text);
    assert.deepEqual(prediction.workspaceCompletions, [], text);
    assert.equal(prediction.completion, null, text);
    assert.deepEqual(candidates(prediction), [], text);
  }
});


test('sentence context selects deep table rows before the materialization cap', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-deep-context-ranking-'));
  const root = path.join(temporary, 'project');
  for (const region of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'south']) {
    const directory = path.join(root, region);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'sales.csv'), 'Region,Value\n'
      + Array.from({ length: 1_100 }, (_, index) => `District ${index + 1},${index + 5}`).join('\n') + '\n');
  }
  const app = createApplication({ dataDir: path.join(temporary, 'history'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  const [project] = (await app.workspace.add([root], actor)).directories;
  const materialize = t.mock.method(app.dependencies, 'indexedObjects');
  const [selected] = candidates(app.dependencies.predict(project.id, { text: 'The south District 1001' }));
  assert.equal(selected.label, 'District 1001');
  assert.equal(selected.path, 'south/sales.csv', 'the ninth file must survive the eight-row cap');
  assert.ok(selected.ranking.contextScore > 0);
  assert.ok(materialize.mock.calls.length <= 8, 'context ranking keeps row materialization bounded');
});
