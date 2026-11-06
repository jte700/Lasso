import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { TimelineService } from '../src/history/service.js';
import { RecommendationRanking, directRecommendationMatch } from '../src/dependencies/ranking.js';

const actor = { id: 'human:ranking', displayName: 'Ranking tester', actorType: 'HUMAN_SELF' };
const DAY_MS = 24 * 60 * 60 * 1000;

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-ranking-'));
  const root = path.join(sandbox, 'project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'alpha.csv'), 'id,value\nA,10\n');
  fs.writeFileSync(path.join(root, 'beta.csv'), 'id,value\nB,20\n');
  fs.writeFileSync(path.join(root, 'gamma.csv'), 'id,value\nC,30\n');
  fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n\nThe result is 10.\n');
  const config = createConfig({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  let time = Date.UTC(2026, 8, 12, 12);
  const state = { sandbox, root, config };
  function connect() {
    state.db = openDatabase(config);
    state.timeline = new TimelineService(state.db, config);
    state.ranking = new RecommendationRanking(state.timeline, { now: () => time });
  }
  connect();
  state.project = state.timeline.importProject(root, actor, { watch: false }).project;
  state.advance = (milliseconds) => { time += milliseconds; };
  state.restart = () => {
    state.timeline.close();
    state.db.close();
    connect();
  };
  state.record = (filePath, kind = 'accept', sessionId, documentPath) => state.ranking.record(state.project.id, {
    path: filePath, kind, sessionId, documentPath,
  });
  state.popular = (filePath, count = 30) => {
    for (let i = 0; i < count; i += 1) state.record(filePath, 'accept', `session-${i}`);
  };
  state.rank = (candidates, options = {}) => state.ranking.rank(state.project.id, candidates, options);
  state.usage = () => state.ranking.usage(state.project.id);
  t.after(() => {
    state.timeline.close();
    state.db.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  return state;
}

function candidate(filePath, score = 0.83, extra = {}) {
  return { id: filePath, path: filePath, label: path.basename(filePath), score, ...extra };
}

test('exact matches beat popular prefix matches and context matches without changing relevance', (t) => {
  const f = fixture(t);
  f.popular('beta.csv');
  const exact = candidate('alpha.csv', 0.81);
  const context = candidate('beta.csv', 0.99, { matchTier: 1 });
  const result = f.rank([context, exact], { query: 'alpha' });
  assert.equal(result[0].path, 'alpha.csv');
  assert.equal(result[0].score, 0.81);
  assert.equal(result[0].ranking.relevanceScore, 0.81);
  assert.equal(result[0].ranking.reason, 'Exact name match');
  const prefix = candidate('beta.csv', 1, { label: 'alpha details', matchTier: 0 });
  const exactWithSameScore = candidate('alpha.csv', 1);
  assert.equal(f.rank([prefix, exactWithSameScore], { query: 'alpha' })[0].path, 'alpha.csv');
});

test('usage is additive, capped and restricted to close relevance bands and valid confidence', (t) => {
  const f = fixture(t);
  f.popular('beta.csv', 100);
  const popular = candidate('beta.csv', 0.83, { matchTier: 1 });
  const close = candidate('alpha.csv', 0.85, { matchTier: 1 });
  const result = f.rank([close, popular], { query: 'results' });
  assert.equal(result[0].path, 'beta.csv');
  assert.ok(result[0].ranking.usageBoost <= 0.06);
  assert.equal(result[0].score, 0.83);
  assert.equal(f.rank([candidate('alpha.csv', 0.879), candidate('beta.csv', 0.81)], { query: 'results' })[0].path, 'alpha.csv');
  assert.equal(f.rank([candidate('alpha.csv', 0.88), candidate('beta.csv', 0.879)], { query: 'results' })[0].path, 'alpha.csv');
  assert.deepEqual(f.rank([candidate('alpha.csv', 0.85), candidate('beta.csv', 0.79)], {
    query: 'results', minimumScore: 0.8,
  }).map((item) => item.path), ['alpha.csv']);
});

test('acceptances count more than opens, repeat sessions contribute and activity decays', (t) => {
  const f = fixture(t);
  f.record('alpha.csv', 'open', 'session-1');
  f.record('beta.csv', 'accept', 'session-1');
  let usage = new Map(f.usage().map((item) => [item.path, item]));
  assert.ok(usage.get('beta.csv').usageBoost > usage.get('alpha.csv').usageBoost);
  const beforeRepeat = usage.get('beta.csv').usageBoost;
  f.record('beta.csv', 'accept', 'session-2');
  usage = new Map(f.usage().map((item) => [item.path, item]));
  assert.ok(usage.get('beta.csv').usageBoost > beforeRepeat);
  const freshBoost = usage.get('beta.csv').usageBoost;
  f.advance(90 * DAY_MS);
  assert.ok(f.usage().find((item) => item.path === 'beta.csv').usageBoost < freshBoost / 20);
  f.record('alpha.csv', 'open', 'fresh-open');
  assert.equal(f.rank([candidate('beta.csv'), candidate('alpha.csv')], { query: '' })[0].path, 'alpha.csv');
});

test('a file action is counted once per kind and session, including a server fallback session', (t) => {
  const f = fixture(t);
  assert.equal(f.record('alpha.csv', 'accept', 'same-session').recorded, true);
  for (let i = 0; i < 20; i += 1) assert.equal(f.record('alpha.csv', 'accept', 'same-session').recorded, false);
  assert.equal(f.record('alpha.csv', 'open', 'same-session').recorded, true);
  assert.equal(f.record('alpha.csv', 'accept').recorded, true);
  assert.equal(f.record('alpha.csv', 'accept').recorded, false);
  f.advance(31 * 60 * 1000);
  assert.equal(f.record('alpha.csv', 'accept').recorded, true);
  assert.equal(f.record('alpha.csv', 'accept', 'same-session').recorded, false);
  assert.equal(f.usage()[0].acceptedSessions, 3);
  assert.equal(f.usage()[0].openedSessions, 1);
});

test('later use refreshes recency and retains multiple document relationships without inflating frequency', (t) => {
  const f = fixture(t);
  f.record('alpha.csv', 'accept', 'same-session', 'notes.md');
  const original = f.usage()[0];
  f.advance(10 * DAY_MS);
  const oldUsage = f.usage()[0];
  assert.equal(f.record('alpha.csv', 'accept', 'same-session', 'beta.csv').recorded, false);
  const refreshed = f.usage()[0];
  assert.equal(refreshed.acceptedSessions, 1);
  assert.equal(refreshed.decayedFrequency, oldUsage.decayedFrequency);
  assert.ok(refreshed.recentScore > oldUsage.recentScore);
  assert.ok(refreshed.lastUsedAt > original.lastUsedAt);
  assert.equal(refreshed.documentProjectFileIds.length, 2);
  for (const documentPath of ['notes.md', 'beta.csv']) {
    assert.equal(f.rank([candidate('gamma.csv', 0.85), candidate('alpha.csv', 0.82)], {
      query: 'result', documentPath,
    })[0].path, 'alpha.csv');
  }
});

test('usage validates the project, indexed path, action and bounded session ID', (t) => {
  const f = fixture(t);
  assert.throws(() => f.record('missing.csv'), { status: 404 });
  assert.throws(() => f.record('../alpha.csv'), { status: 404 });
  assert.throws(() => f.record('alpha.csv', 'impression'), { status: 400 });
  assert.throws(() => f.record('alpha.csv', 'open', 'x'.repeat(129)), { status: 400 });
  assert.throws(() => f.record('alpha.csv', 'open', 'bad\nsession'), { status: 400 });
  assert.throws(() => f.ranking.record('other-project', { path: 'alpha.csv', kind: 'open' }), { status: 404 });
  assert.deepEqual(f.usage(), []);
});

test('usage is isolated between projects sharing filenames and persists after restart', (t) => {
  const f = fixture(t);
  const secondRoot = path.join(f.sandbox, 'second-project');
  fs.mkdirSync(secondRoot);
  fs.writeFileSync(path.join(secondRoot, 'alpha.csv'), 'id,value\nD,40\n');
  const second = f.timeline.importProject(secondRoot, actor, { watch: false }).project;
  f.record('alpha.csv', 'accept', 'same-session');
  const before = f.usage();
  assert.deepEqual(f.ranking.usage(second.id), []);
  f.restart();
  assert.deepEqual(f.usage(), before);
  assert.equal(f.record('alpha.csv', 'accept', 'same-session').recorded, false);
  assert.deepEqual(f.ranking.usage(second.id), []);
});

test('file and document renames retain usage and document co-use through stable IDs', (t) => {
  const f = fixture(t);
  const recorded = f.record('beta.csv', 'accept', 'co-use', 'notes.md');
  fs.renameSync(path.join(f.root, 'beta.csv'), path.join(f.root, 'renamed.csv'));
  fs.renameSync(path.join(f.root, 'notes.md'), path.join(f.root, 'draft.md'));
  f.timeline.capture(f.project.id, actor);
  const usage = f.usage()[0];
  assert.equal(usage.path, 'renamed.csv');
  assert.equal(usage.projectFileId, recorded.projectFileId);
  const results = f.rank([candidate('alpha.csv', 0.85), candidate('renamed.csv', 0.82)], {
    query: 'result', documentPath: 'draft.md',
  });
  assert.equal(results[0].path, 'renamed.csv');
  assert.equal(results[0].ranking.reason, 'Used with this document');
});

test('explicit document relationships beat popularity within a close band', (t) => {
  const f = fixture(t);
  f.popular('alpha.csv');
  const results = f.rank([candidate('alpha.csv', 0.86), candidate('beta.csv', 0.82)], {
    query: 'result', documentPath: 'notes.md', relatedPaths: ['beta.csv'],
  });
  assert.equal(results[0].path, 'beta.csv');
  assert.equal(results[0].ranking.reason, 'Used in this document');
  assert.equal(results[0].ranking.usageBoost, 0);
  assert.equal(f.rank([candidate('alpha.csv', 0.89), candidate('beta.csv', 0.82)], {
    query: 'result', relatedPaths: ['beta.csv'],
  })[0].path, 'alpha.csv');
});

// Persist actual versioned dependency rows to exercise latest-version and rename
// resolution independently of the link route, which also records an acceptance.
function seedRelationship(f) {
  const p = f.timeline.getProject(f.project.id);
  const document = f.timeline.snapshotFile(p.currentSnapshotId, 'notes.md');
  f.db.prepare(`INSERT INTO scientific_objects (id, project_id, object_key, object_type, created_at)
    VALUES ('ranking-object', ?, 'ranking-source', 'DATASET', '2026-09-12')`).run(p.id);
  f.db.prepare(`INSERT INTO scientific_object_versions
    (id, object_id, snapshot_id, path, label, search_text, content_hash, created_at)
    VALUES ('ranking-object-version', 'ranking-object', ?, 'beta.csv', 'Beta', 'result beta', 'fixture-hash', '2026-09-12')`).run(p.currentSnapshotId);
  f.db.prepare(`INSERT INTO claim_dependencies (id, project_id, document_project_file_id, created_at)
    VALUES ('ranking-dependency', ?, ?, '2026-09-12')`).run(p.id, document.projectFileId);
  f.db.prepare(`INSERT INTO claim_dependency_versions
    (id, dependency_id, snapshot_id, document_snapshot_id, document_path, document_anchor_json,
     span_text, source_object_id, source_snapshot_id, selection_method, status, created_by_actor_id, created_at)
    VALUES ('ranking-dependency-version', 'ranking-dependency', ?, ?, 'notes.md', '{}', 'result',
      'ranking-object', ?, 'IMPORTED', 'LINKED', ?, '2026-09-12')`)
    .run(p.currentSnapshotId, p.currentSnapshotId, p.currentSnapshotId, actor.id);
  return p.currentSnapshotId;
}

test('current linked sources are related after renames, while removed dependency versions are excluded', (t) => {
  const f = fixture(t);
  const originalSnapshot = seedRelationship(f);
  const options = { query: 'result', documentPath: 'notes.md' };
  assert.equal(f.rank([candidate('alpha.csv', 0.85), candidate('beta.csv', 0.82)], options)[0].path, 'beta.csv');
  fs.renameSync(path.join(f.root, 'beta.csv'), path.join(f.root, 'renamed.csv'));
  const captured = f.timeline.capture(f.project.id, actor);
  const candidates = [candidate('alpha.csv', 0.85), candidate('renamed.csv', 0.82)];
  assert.equal(f.rank(candidates, options)[0].path, 'renamed.csv');
  f.db.prepare(`INSERT INTO claim_dependency_versions
    (id, dependency_id, snapshot_id, document_snapshot_id, document_path, document_anchor_json,
     span_text, source_object_id, source_snapshot_id, selection_method, status, created_by_actor_id, created_at, is_removed)
    VALUES ('ranking-dependency-removed', 'ranking-dependency', ?, ?, 'notes.md', '{}', 'result',
      'ranking-object', ?, 'IMPORTED', 'LINKED', ?, '2026-09-13', 1)`)
    .run(captured.snapshot.id, captured.snapshot.id, originalSnapshot, actor.id);
  assert.equal(f.rank(candidates, options)[0].path, 'alpha.csv');
  assert.equal(f.rank(candidates, options)[1].ranking.relationship, false);
  assert.deepEqual(f.usage(), []);
});

test('diversity includes other files, keeps exact matches first and preserves focused single-file choices', (t) => {
  const f = fixture(t);
  const alphaRows = Array.from({ length: 5 }, (_, index) => candidate('alpha.csv', 0.84, { id: `alpha-${index}`, matchTier: 1 }));
  const others = [candidate('beta.csv', 0.83), candidate('gamma.csv', 0.82)];
  const diversified = f.rank([...alphaRows, ...others], { query: 'result', limit: 8 });
  assert.deepEqual(diversified.slice(0, 3).map((item) => item.path), ['alpha.csv', 'beta.csv', 'gamma.csv']);
  assert.equal(diversified.filter((item) => item.path === 'alpha.csv').length, 2);
  const directRows = alphaRows.map((item) => ({ ...item, matchTier: 0 }));
  const exact = f.rank([...directRows, ...others], { query: 'alpha', limit: 4 });
  assert.deepEqual(exact.slice(0, 2).map((item) => item.path), ['alpha.csv', 'alpha.csv']);
  const prefix = candidate('beta.csv', 0.84, { label: 'alpha additional', matchTier: 0 });
  const exactBeforePrefix = f.rank([prefix, ...directRows], { query: 'alpha', limit: 3 });
  assert.deepEqual(exactBeforePrefix.map((item) => item.path), ['alpha.csv', 'alpha.csv', 'beta.csv']);
  assert.equal(f.rank(alphaRows, { query: 'result', limit: 5 }).length, 5);
  assert.equal(f.rank([...alphaRows, ...others], { query: 'result', diversify: false, limit: 8 }).length, 7);
  const references = alphaRows.slice(0, 3).map((item) => ({ ...item, diversityKey: item.id }));
  const referenceResults = f.rank([...references, ...others], { query: 'result', limit: 8 });
  assert.equal(referenceResults.filter((item) => item.path === 'alpha.csv').length, 3);
});

test('no-query recommendations prioritize recency then repeated sessions before relationships', (t) => {
  const f = fixture(t);
  f.record('alpha.csv', 'accept', 'old');
  f.advance(10 * DAY_MS);
  f.record('beta.csv', 'open', 'current');
  assert.equal(f.rank([candidate('alpha.csv'), candidate('beta.csv')])[0].path, 'beta.csv');
  const related = f.rank([candidate('alpha.csv'), candidate('beta.csv')], { relatedPaths: ['alpha.csv'] });
  assert.equal(related[0].path, 'beta.csv');
  assert.equal(related[0].ranking.reason, 'Recently used in this project');
  f.record('gamma.csv', 'open', 'current');
  f.record('gamma.csv', 'open', 'second');
  assert.equal(f.rank([candidate('beta.csv'), candidate('gamma.csv')])[0].path, 'gamma.csv');
});

test('ranking is read-only, explains explicit context and retains genuine caller ties', (t) => {
  const f = fixture(t);
  const input = [candidate('gamma.csv', 0.8, { matchTier: 1 }), candidate('alpha.csv', 0.8, { matchTier: 1 })];
  const original = structuredClone(input);
  for (let index = 0; index < 5; index += 1) {
    const results = f.rank(input);
    assert.deepEqual(results.map((item) => item.path), ['gamma.csv', 'alpha.csv']);
    assert.equal(results[0].ranking.reason, 'Available in this project');
  }
  assert.deepEqual(input, original);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM recommendation_usage').get().count, 0);
  const inferred = f.rank([{ path: 'alpha.csv', label: 'Alpha', id: 'alpha' }], { query: 'alpha' });
  assert.equal(inferred[0].score, 1);
  assert.equal(inferred[0].ranking.tier, 0);
  const scientific = f.rank([candidate('alpha.csv', 0.9, {
    label: 'Alpha result', matchTier: 0, reasons: ['Matching value'],
  })], { query: 'result' });
  assert.equal(scientific[0].ranking.reason, 'Matching value');
});

test('internal ranking retains the requested candidate pool before caller deduplication', (t) => {
  const f = fixture(t);
  const candidates = Array.from({ length: 1200 }, (_, index) => candidate('alpha.csv', 0.9, { id: `item-${index}` }));
  assert.equal(f.rank(candidates, { query: 'result', limit: candidates.length, diversify: false }).length, 1200);
});

test('exact values and identifiers remain ahead of popular content and name prefixes', (t) => {
  const f = fixture(t);
  f.popular('beta.csv');
  for (const [query, identity, reason] of [
    ['-12.5%', { valueText: '-12.5%' }, 'Exact value match'],
    ['TP53', { metadata: { variable: 'TP53' } }, 'Exact identifier match'],
    ['10.1234/study', { metadata: { doi: '10.1234/study' } }, 'Exact identifier match'],
    ['object:alpha', { id: 'object:alpha' }, 'Exact identifier match'],
  ]) {
    const exact = candidate('alpha.csv', 0.83, { ...identity, matchTier: 1 });
    const prefix = candidate('beta.csv', 0.99, { label: `${query} additional`, matchTier: 0 });
    const results = f.rank([prefix, exact], { query });
    assert.equal(results[0].path, 'alpha.csv');
    assert.equal(results[0].ranking.reason, reason);
    assert.equal(results[0].ranking.relevanceScore, 0.83);
  }
  assert.equal(directRecommendationMatch({ valueText: '120' }, '12').direct, false);
  assert.equal(directRecommendationMatch({ valueText: '-12.5%' }, '12.5%').direct, false);
});

test('a file name names the file, not each row, column or cell inside it', () => {
  const inFile = (extra) => ({ path: 'data/pressure_log.csv', ...extra });
  assert.equal(directRecommendationMatch(inFile({ objectType: 'DATASET', label: 'pressure_log' }), 'pres').direct, true);
  for (const part of [
    { objectType: 'VARIABLE', label: 'Day' },
    { objectType: 'DATASET_VALUE', label: 'Mon · Flow Rate' },
    { objectType: 'RESULT', label: 'pressure_log · included rows' },
  ]) assert.equal(directRecommendationMatch(inFile(part), 'pres').direct, false, part.label);
  assert.equal(directRecommendationMatch(inFile({ objectType: 'VARIABLE', label: 'Peak Pressure' }), 'peak pres').reason,
    'Name starts with your query');
  // Underscores are spelling: the typed words name the column exactly.
  assert.equal(directRecommendationMatch(inFile({ objectType: 'VARIABLE', label: 'birth_weight_g' }), 'birth weight g').exact, true);
  assert.equal(directRecommendationMatch({ label: '12.5% growth' }, '-12.5%').direct, false);
});

test('only exact matches are most specific; a match only its caller vouches for ranks with name prefixes', (t) => {
  const f = fixture(t);
  const vouched = candidate('beta.csv', 0.99, { label: 'Beta', matchTier: 0, reasons: ['matching value'] });
  const results = f.rank([vouched, candidate('alpha.csv', 0.81)], { query: 'alpha' });
  assert.deepEqual(results.map((item) => item.path), ['alpha.csv', 'beta.csv']);
  assert.equal(results[0].ranking.directSpecificity, 2);
  assert.equal(results[1].ranking.directSpecificity, 1);
  assert.equal(results[1].ranking.reason, 'Matching value', 'a reason is shown capitalised');
});

test('ranking rejects invented paths and foreign identities while preserving indexed historical scope', (t) => {
  const f = fixture(t);
  const otherRoot = path.join(f.sandbox, 'other');
  fs.mkdirSync(otherRoot);
  fs.writeFileSync(path.join(otherRoot, 'alpha.csv'), 'id,value\nD,40\n');
  const other = f.timeline.importProject(otherRoot, actor, { watch: false }).project;
  const originalSnapshot = f.project.currentSnapshotId;
  seedRelationship(f);
  f.db.prepare(`INSERT INTO scientific_objects (id, project_id, object_key, object_type, created_at)
    VALUES ('foreign-object', ?, 'foreign-source', 'DATASET', '2026-09-12')`).run(other.id);
  f.db.prepare(`INSERT INTO scientific_object_versions
    (id, object_id, snapshot_id, path, label, search_text, content_hash, created_at)
    VALUES ('foreign-version', 'foreign-object', ?, 'alpha.csv', 'Foreign', '', 'fixture', '2026-09-12')`)
    .run(other.currentSnapshotId);
  const inputs = [candidate('missing.csv', 1), candidate('../alpha.csv', 1),
    candidate('alpha.csv', 1, { snapshotId: other.currentSnapshotId }),
    candidate('alpha.csv', 1, { projectId: other.id }),
    candidate('alpha.csv', 1, { id: 'foreign-object', objectType: 'DATASET', snapshotId: originalSnapshot }),
    candidate('alpha.csv', 1, { objectId: 'foreign-object' }), candidate('alpha.csv', 0.9)];
  assert.deepEqual(f.rank(inputs, { query: 'alpha' }).map((item) => item.path), ['alpha.csv']);
  fs.renameSync(path.join(f.root, 'beta.csv'), path.join(f.root, 'renamed.csv'));
  f.timeline.capture(f.project.id, actor);
  assert.equal(f.rank([candidate('beta.csv')]).length, 0);
  assert.equal(f.rank([candidate('beta.csv', 0.9, { snapshotId: originalSnapshot })])[0].path, 'beta.csv');
  assert.equal(f.rank([candidate('beta.csv', 0.9, {
    id: 'ranking-object', objectType: 'DATASET', snapshotId: originalSnapshot,
  })])[0].id, 'ranking-object');
});

test('historical source usage follows file identity when a renamed path is reused', (t) => {
  const f = fixture(t);
  const originalSnapshot = f.project.currentSnapshotId;
  f.record('beta.csv', 'accept', 'before-rename', 'notes.md');
  fs.renameSync(path.join(f.root, 'beta.csv'), path.join(f.root, 'renamed.csv'));
  f.timeline.capture(f.project.id, actor);
  fs.writeFileSync(path.join(f.root, 'beta.csv'), 'id,value\nReplacement,99\n');
  f.timeline.capture(f.project.id, actor);
  const historical = candidate('beta.csv', 0.83, { id: 'historic', snapshotId: originalSnapshot });
  const replacement = candidate('beta.csv', 0.83, { id: 'replacement' });
  const results = f.rank([replacement, historical], { query: 'result', documentPath: 'notes.md', diversify: false });
  assert.equal(results[0].id, 'historic');
  assert.ok(results[0].ranking.usageBoost > 0);
  assert.equal(results[0].ranking.relationship, true);
  assert.equal(results[1].ranking.usageBoost, 0);
  assert.equal(results[1].ranking.relationship, false);
  const mixedVersions = f.rank([
    ...Array.from({ length: 4 }, (_, index) => ({ ...historical, id: `history-${index}` })),
    candidate('renamed.csv', 0.83), candidate('alpha.csv', 0.83),
  ], { query: 'result', limit: 6 });
  assert.equal(mixedVersions.filter((item) => ['beta.csv', 'renamed.csv'].includes(item.path)).length, 2);
  assert.ok(mixedVersions.some((item) => item.path === 'alpha.csv'));
});

test('name spelling keeps signs, decimals and meaningful punctuation distinct', (t) => {
  const f = fixture(t);
  f.popular('alpha.csv');
  const differentNames = [
    ['12 mg', '-12 mg'],
    ['12 mg', '+12 mg'],
    ['Dose 12 mg', 'Dose -12 mg'],
    ['Dose 12 mg', 'Dose +12 mg'],
    ['Dose 1.5 mg', 'Dose 1 5 mg'],
    ['Report 2026-10-31', 'Report 2026 10 31'],
    ['C++', 'C'],
    ['C#', 'C'],
    ['mg/mL', 'mg mL'],
    ['m-2', 'm 2'],
    ['Dose-12 mg', 'Dose 12 mg'],
  ];
  for (const [label, query] of differentNames) {
    assert.equal(directRecommendationMatch({ label }, query).exact, undefined, `${label} is not ${query}`);
    assert.equal(directRecommendationMatch({ label: query }, label).exact, undefined, `${query} is not ${label}`);
    // A popular, higher-scored lookalike must not tie the name actually typed.
    const result = f.rank([
      candidate('alpha.csv', 0.99, { label }),
      candidate('beta.csv', 0.81, { label: query }),
    ], { query });
    assert.equal(result[0].path, 'beta.csv', query);
    assert.equal(result[0].ranking.reason, 'Exact name match', query);
  }
  for (const [label, query] of [
    ['birth_weight_g', 'birth weight g'],
    ['birth-weight-g', 'birth weight g'],
    ['birth.weight.g', 'birth weight g'],
    ['phase2-results', 'phase2 results'],
    ['Dose_-12.5_mg', 'Dose -12.5 mg'],
  ]) {
    assert.equal(directRecommendationMatch({ label }, query).exact, true, label);
  }
  assert.equal(directRecommendationMatch({ label: 'birth_weight_g' }, 'birth wei').direct, true);
});


test('current sentence context beats history only among similarly relevant matches', (t) => {
  const f = fixture(t);
  f.popular('alpha.csv');
  const popular = candidate('alpha.csv', 0.86, { label: 'Revenue' });
  const contextual = candidate('beta.csv', 0.82, { label: 'Revenue', contextScore: 0.5 });
  const result = f.rank([popular, contextual], { query: 'Revenue', relatedPaths: ['alpha.csv'] });
  assert.equal(result[0].path, 'beta.csv');
  assert.equal(result[0].ranking.contextScore, 0.5);
  assert.equal(result[0].ranking.reason, 'Exact name match');
  assert.equal(f.rank([popular, { ...contextual, label: 'Revenue growth' }], { query: 'Revenue' })[0].path,
    'alpha.csv', 'sentence context cannot override an exact name with a prefix');
  assert.equal(f.rank([{ ...popular, score: 0.9 }, contextual], { query: 'Revenue' })[0].path,
    'alpha.csv', 'sentence context cannot override a stronger relevance band');
  assert.equal(f.rank([popular, contextual])[0].path,
    'alpha.csv', 'browsing without a query still uses project history');
  const broader = f.rank([popular, contextual], { query: 'forecast' });
  assert.equal(broader[0].path, 'beta.csv');
  assert.equal(broader[0].ranking.reason, 'Matches your sentence context');
  for (const [contextScore, expected] of [[undefined, 0], [-1, 0], [NaN, 0], [Infinity, 0], [3, 1]]) {
    assert.equal(f.rank([{ ...contextual, contextScore }], { query: 'Revenue' })[0].ranking.contextScore,
      expected, String(contextScore));
  }
});
