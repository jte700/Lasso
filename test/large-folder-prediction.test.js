import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { BoundedCache } from '../src/cache.js';

const actor = { id: 'human:large-folder-test', displayName: 'Large folder test', actorType: 'HUMAN_SELF' };
// The fixture has a few hundred objects; a folder counts as large past this many.
const LARGE_PAST = 10;
// What the object lists may hold in these tests, as 100,000 is to a folder of 166,000.
const LIST_WEIGHT = 60;

const TEXTS = [
  'The moisture',
  'The yield kg',
  'Plot P-014',
  'The nitrogen treatment raised',
  'Grain protein rose with nitrogen',
  'The mean yield was 6.4',
  'Soil moisture was 21.5',
  'The trial',
  'We applied urea in the spring',
];

function writeFolder(root) {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'results'), { recursive: true });
  const rows = Array.from({ length: 40 }, (_, index) => {
    const plot = `P-${String(index + 1).padStart(3, '0')}`;
    return `${plot},${(5 + index * 0.1).toFixed(1)},${(18 + index * 0.25).toFixed(2)},${index % 2 ? 'nitrogen' : 'control'}`;
  });
  fs.writeFileSync(path.join(root, 'data', 'plots.csv'), `plot,yield_kg,moisture,treatment\n${rows.join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'data', 'dictionary.csv'),
    'Variable,Description,Units\nyield_kg,Grain yield per plot,kg\nmoisture,Soil moisture at sowing,percent\n');
  fs.writeFileSync(path.join(root, 'results', 'summary.csv'),
    'Metric,Value\nMean yield,6.4\nGrain protein,12.8\nSoil moisture,21.5\nPlots harvested,40\n');
  fs.writeFileSync(path.join(root, 'notes.md'), ['# Wheat nitrogen trial', '',
    'The nitrogen treatment raised grain protein in every block.', '',
    'We applied urea in the spring at 120 kg per hectare.', ''].join('\n'));
}

function open(t, dataDir, overrides = {}) {
  const app = createApplication({ dataDir, watchProjects: false, syncConnections: false, ...overrides });
  t.after(() => app.close());
  return app;
}

function folder(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-large-folder-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'trial');
  writeFolder(root);
  return { temporary, root };
}

/** Holds the lists of mapped objects to less than the folder has, as a folder of 166,000 objects is held to 100,000. */
function listsTooSmall(app) {
  const weight = (objects) => objects.length;
  for (const name of ['workspaceRetrievalCache', 'studyVariableCache', 'objectCache']) {
    app.dependencies[name] = new BoundedCache({ maxEntries: 16, maxWeight: LIST_WEIGHT, weight });
  }
  app.dependencies.typedObjectCache = new BoundedCache({ maxEntries: 96, maxWeight: LIST_WEIGHT, weight });
  app.dependencies.ranking.snapshotCache = new BoundedCache({ maxEntries: 16, maxWeight: LIST_WEIGHT,
    weight: (snapshot) => snapshot.files.size + snapshot.objects.size });
  app.timeline.objectVersions.sets = new BoundedCache({ maxEntries: 8, maxWeight: LIST_WEIGHT, weight: (set) => set.rows.length });
}

/** Counts the rows each reading of many version rows returns from here on. */
function countIndexReads(t, app) {
  const versions = app.timeline.objectVersions;
  const read = { rows: 0 };
  for (const name of ['resolved', 'resolvedTypes']) {
    const original = versions[name].bind(versions);
    t.mock.method(versions, name, (...args) => {
      const set = original(...args);
      read.rows += set.rows.length;
      return set;
    });
  }
  const locations = versions.locations.bind(versions);
  t.mock.method(versions, 'locations', (...args) => {
    const rows = locations(...args);
    read.rows += rows.length;
    return rows;
  });
  if (versions.resolvedPages) {
    const pages = versions.resolvedPages.bind(versions);
    t.mock.method(versions, 'resolvedPages', function* (...args) {
      for (const rows of pages(...args)) {
        read.rows += rows.length;
        yield rows;
      }
    });
  }
  return read;
}

/** What a prediction offers, without the ids one library gives its objects. */
function offered(prediction) {
  // An object's key starts with its file's id, which each library gives for itself.
  const source = (candidate) => [candidate.label, candidate.path, candidate.objectKey.replace(/^[0-9a-f-]{36}/, ''),
    candidate.score, candidate.reasons];
  return {
    claims: prediction.claims.map((claim) => [claim.type, claim.text, claim.candidates.map(source),
      claim.candidates.map((candidate) => (candidate.sameNamed ?? []).map(source))]),
    workspace: prediction.workspaceCompletions.map((item) => [item.replacementText, item.category, item.confidence,
      source(item.dependencyCandidate)]),
    sources: prediction.sourceCompletions.map((item) => item.replacementText),
    completion: prediction.completion?.replacementText ?? null,
  };
}

test('A folder with more objects than the lists hold is not read again on a second prediction', (t) => {
  const { temporary, root } = folder(t);
  const app = open(t, path.join(temporary, 'history'), { searchIndexObjects: LARGE_PAST });
  listsTooSmall(app);
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  assert.ok(app.timeline.objectVersions.indexedCount(project.currentSnapshotId) > LIST_WEIGHT * 2, 'the folder is over the lists');
  app.dependencies.warmPredictionCaches(project.id);
  const text = 'The moisture';
  const first = app.dependencies.predict(project.id, { text, cursor: text.length });
  assert.ok(first.claims[0]?.candidates.length, 'the first prediction names the column');
  const read = countIndexReads(t, app);

  const second = app.dependencies.predict(project.id, { text, cursor: text.length });

  assert.deepEqual(offered(second), offered(first));
  assert.equal(read.rows, 0, 'the second prediction read no list of version rows');
});

test('No kind of sentence reads a large folder again once it has been typed', (t) => {
  const { temporary, root } = folder(t);
  const app = open(t, path.join(temporary, 'history'), { searchIndexObjects: LARGE_PAST });
  listsTooSmall(app);
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  app.dependencies.warmPredictionCaches(project.id);
  for (const text of TEXTS) app.dependencies.predict(project.id, { text, cursor: text.length });
  const objects = app.timeline.objectVersions.indexedCount(project.currentSnapshotId);
  const read = countIndexReads(t, app);

  for (const text of TEXTS) app.dependencies.predict(project.id, { text, cursor: text.length });

  // Whole files (a handful of objects) are still listed by type; the cells and rows are not.
  assert.ok(read.rows < objects / 4, `${read.rows} rows were read again of ${objects}`);
});

test('A large folder offers what the same folder offers when it is small enough to hold', (t) => {
  const { temporary, root } = folder(t);
  const held = open(t, path.join(temporary, 'held'));
  const large = open(t, path.join(temporary, 'large'), { searchIndexObjects: LARGE_PAST });
  const heldProject = held.timeline.importProject(root, actor, { watch: false }).project;
  const largeProject = large.timeline.importProject(root, actor, { watch: false }).project;
  assert.equal(held.dependencies.searchIndexFor(heldProject.id), null);
  assert.ok(large.dependencies.searchIndexFor(largeProject.id), 'the folder is searched through its index');

  for (const text of TEXTS) {
    const expected = offered(held.dependencies.predict(heldProject.id, { text, cursor: text.length }));
    const actual = offered(large.dependencies.predict(largeProject.id, { text, cursor: text.length }));
    assert.deepEqual(actual, expected, text);
  }
});

test('An accepted source in a large folder lists the values it lists in a small one', (t) => {
  const { temporary, root } = folder(t);
  const held = open(t, path.join(temporary, 'held'));
  const large = open(t, path.join(temporary, 'large'), { searchIndexObjects: LARGE_PAST });
  const values = (app) => {
    const { project } = app.timeline.importProject(root, actor, { watch: false });
    const text = 'The moisture';
    const [column] = app.dependencies.predict(project.id, { text, cursor: text.length }).claims[0].candidates;
    const focus = { id: 'focus', anchor: { blockIndex: 0, start: 0, end: 0 }, source: column };
    const listed = app.dependencies.valuesFromLinkedProjectObject(project.id, { text: '' }, 0, focus);
    return { narrows: app.dependencies.narrowsTo(project.id, column),
      values: listed.completions.map((item) => [item.replacementText, item.provenanceLabel]) };
  };

  const expected = values(held);
  const actual = values(large);

  assert.ok(expected.values.length > 1 && expected.narrows);
  assert.deepEqual(actual, expected);
});

test('A large folder\'s search index is read from disk at the next launch, not built again', async (t) => {
  const { temporary, root } = folder(t);
  const dataDir = path.join(temporary, 'history');
  const text = 'The yield kg';
  const first = createApplication({ dataDir, watchProjects: false, syncConnections: false, searchIndexObjects: LARGE_PAST });
  const { project } = first.timeline.importProject(root, actor, { watch: false });
  first.dependencies.warmPredictionCaches(project.id);
  const expected = offered(first.dependencies.predict(project.id, { text, cursor: text.length }));
  await first.close();
  const second = open(t, dataDir, { searchIndexObjects: LARGE_PAST });
  const read = countIndexReads(t, second);

  second.dependencies.warmPredictionCaches(project.id);
  const actual = offered(second.dependencies.predict(project.id, { text, cursor: text.length }));

  assert.deepEqual(actual, expected);
  assert.ok(read.rows < second.timeline.objectVersions.indexedCount(project.currentSnapshotId) / 4,
    `${read.rows} version rows were read at the second launch`);
});

test('A save in a large folder is offered from the new snapshot', (t) => {
  const { temporary, root } = folder(t);
  const app = open(t, path.join(temporary, 'history'), { searchIndexObjects: LARGE_PAST });
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  app.dependencies.warmPredictionCaches(project.id);
  fs.appendFileSync(path.join(root, 'results', 'summary.csv'), 'Lodging score,2.5\n');

  app.timeline.capture(project.id, actor);
  const text = 'The lodging sc';
  const prediction = app.dependencies.predict(project.id, { text, cursor: text.length });

  const labels = [...prediction.claims.flatMap((claim) => claim.candidates.map((candidate) => candidate.label)),
    ...prediction.workspaceCompletions.map((item) => item.replacementText)];
  assert.ok(labels.some((label) => /lodging score/i.test(label)), JSON.stringify(labels));
  const kept = fs.readdirSync(path.join(temporary, 'history', 'derived', 'search-index'));
  assert.deepEqual(kept.filter((name) => name.endsWith('.idx')), [`${project.id}.${app.timeline.getProject(project.id).currentSnapshotId}.idx`]);
});
