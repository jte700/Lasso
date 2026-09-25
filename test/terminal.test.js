import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { anchorForSpan } from '../src/dependencies/service.js';
import { parseCommand, parseSince, tokenize, completionContext } from '../src/terminal/parser.js';
import { columnLetter, dependencyName, parseAddress, slug, sourceLocator } from '../src/terminal/names.js';
import { parseRuleSentence } from '../src/terminal/rules.js';

const ada = { id: 'human:ada', displayName: 'Ada Okafor', actorType: 'HUMAN_SELF' };

const INCOME_V1 = [
  'Account,Current Period,Prior Period',
  'Depreciation-Direct,612,590',
  'Office Supplies,400,310',
  'Payroll tax,225,210',
].join('\n') + '\n';

const INCOME_V2 = [
  'Account,Current Period,Prior Period',
  'Depreciation-Direct,684,590',
  'Office Supplies,438,310',
  'Payroll tax,225,210',
].join('\n') + '\n';

/** A workspace whose shape mirrors the ambiguity the terminal has to handle. */
function buildWorkspace() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'colab-terminal-test-'));
  const root = path.join(sandbox, 'Workspace');
  for (const directory of ['Finance/Q3', 'Analytics', 'Client-A', 'manuscript', 'Archive']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'Finance/Q3/Income-Statement.csv'), INCOME_V1);
  fs.writeFileSync(path.join(root, 'Finance/Q3/model.csv'), 'metric,value\nrevenue,4200000\n');
  fs.writeFileSync(path.join(root, 'Analytics/report.csv'), 'metric,value\nrevenue,4180000\n');
  fs.writeFileSync(path.join(root, 'Client-A/forecast.csv'), 'metric,value\nrevenue,1900000\n');
  fs.writeFileSync(path.join(root, 'Archive/old-figures.csv'), 'metric,value\nrevenue,900000\n');
  // An old file, so `--updated` has something to exclude.
  const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(root, 'Archive/old-figures.csv'), longAgo, longAgo);
  fs.writeFileSync(path.join(root, 'manuscript/accounting.md'),
    '# Accounting\n\nThe expected depreciation value is 612.\n\nOffice supplies totalled 400.\n');
  fs.writeFileSync(path.join(root, 'manuscript/q3-summary.md'),
    '# Q3 summary\n\nDepreciation remained at 612.\n');

  const application = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  const { project } = application.timeline.importProject(root, ada);
  application.dependencies.ensureIndex(project.id);
  return { sandbox, root, application, project };
}

/** Links a claim the way the document editor does, through the same service. */
function linkClaim(application, project, documentPath, needle, objectId) {
  const document_ = application.dependencies.getDocument(project.id, documentPath);
  const blockIndex = document_.blocks.findIndex((block) => block.text.includes(needle));
  assert.ok(blockIndex >= 0, `expected ${needle} in ${documentPath}`);
  const blockText = document_.blocks[blockIndex].text;
  const start = blockText.indexOf(needle);
  return application.dependencies.link(project.id, {
    documentPath,
    anchor: anchorForSpan(blockIndex, document_.blocks[blockIndex].type, blockText, start, start + needle.length),
    spanText: needle,
    sourceObjectId: objectId,
    selectionMethod: 'MANUAL',
    status: 'LINKED',
  }, ada);
}

test('terminal command layer', async (suite) => {
  const { sandbox, root, application, project } = buildWorkspace();
  const { executor, graph, aliases, rules, indexing } = application.terminal;
  const run = (input) => executor.run(project.id, input, ada);

  suite.after(async () => {
    await application.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const depreciation = graph.resolve(project.id, 'depreciation-direct');
  const supplies = graph.resolve(project.id, 'office-supplies');

  await suite.test('names address the value cell, not the row or the column', () => {
    assert.equal(slug('Office Supplies'), 'office-supplies');
    assert.equal(columnLetter(0), 'A');
    assert.equal(columnLetter(1), 'B');
    assert.equal(columnLetter(26), 'AA');
    assert.equal(depreciation.status, 'RESOLVED');
    assert.equal(depreciation.object.name, 'depreciation-direct');
    assert.equal(depreciation.object.valueText, '612');
    // A second value column is qualified rather than colliding with the first.
    const prior = graph.resolve(project.id, 'depreciation-direct-prior-period');
    assert.equal(prior.status, 'RESOLVED');
    assert.equal(prior.object.valueText, '590');
  });

  await suite.test('a workbook cell reads as sheet and A1 cell', () => {
    const cell = dependencyName({
      anchor: { kind: 'table-cell', rowKey: 'Office Supplies', rowIndex: 20, columnIndex: 1, column: 'Current Period', sheet: 'Accounting' },
      metadata: { orientation: 'ROW', variable: 'Office Supplies', sheet: 'Accounting' },
      label: 'Office Supplies · Current Period',
      path: 'Finance/Q3/Income-Statement.xlsx',
    });
    assert.equal(cell, 'office-supplies');
    assert.equal(sourceLocator({
      anchor: { kind: 'table-cell', rowIndex: 20, columnIndex: 1, sheet: 'Accounting' },
      metadata: { sheet: 'Accounting' },
      path: 'Finance/Q3/Income-Statement.xlsx',
    }), 'Accounting!B21');
  });

  await suite.test('find returns matching indexed dependencies with provenance', () => {
    const result = run('find revenue');
    assert.equal(result.ok, true);
    assert.ok(result.results.length >= 4);
    const values = result.results.filter((item) => item.title === 'revenue');
    assert.equal(values.length, 4, 'four directories each define revenue');
    // Every result carries enough provenance to tell it from its namesakes.
    for (const item of values) {
      assert.ok(item.lines.some((line) => line.endsWith('.csv')), 'a source path');
      assert.ok(item.lines.some((line) => /row \d/.test(line)), 'a source location');
      assert.ok(item.value, 'a value');
    }
    assert.equal(new Set(values.map((item) => item.lines[0])).size, 4, 'four distinct sources');
  });

  await suite.test('find honours source, directory and updated filters', () => {
    const scoped = run('find revenue --directory Finance');
    assert.ok(scoped.results.every((item) => item.lines[0].startsWith('Finance/')));
    assert.equal(run('find revenue --source xlsx').results.length, 0, 'no workbook holds it');
    assert.ok(run('find revenue --source csv').results.length > 0);
    // The archived copy was written ninety days ago, so a recent window drops it.
    const recent = run('find revenue --updated 7d').results.map((item) => item.lines[0]);
    assert.ok(recent.length > 0);
    assert.ok(!recent.some((line) => line.startsWith('Archive/')));
    assert.ok(run('find revenue --updated 180d').results.some((item) => item.lines[0].startsWith('Archive/')));
    assert.equal(run('find revenue --updated soon').ok, false);
  });

  await suite.test('an ambiguous name is never resolved arbitrarily', () => {
    const resolution = graph.resolve(project.id, 'revenue');
    assert.equal(resolution.status, 'AMBIGUOUS');
    assert.equal(resolution.candidates.length, 4);
    const traced = run('trace revenue');
    assert.equal(traced.ok, false);
    assert.match(traced.headline, /matches 4 indexed sources/);
    assert.equal(traced.results.length, 4);
    // The candidates are offered, and one is not silently chosen.
    assert.equal(new Set(traced.results.map((item) => item.lines[0])).size, 4);
  });

  await suite.test('trace returns the exact source', () => {
    const result = run('trace office-supplies');
    assert.equal(result.ok, true);
    assert.equal(result.headline, 'office-supplies');
    const fields = Object.fromEntries(result.blocks
      .filter((block) => block.kind === 'fields')
      .flatMap((block) => block.rows.map((row) => [row.label, row.value])));
    assert.equal(fields.value, '400');
    assert.equal(fields.source, 'Finance/Q3/Income-Statement.csv');
    assert.equal(fields.location, 'row 3 · Current Period');
    assert.ok(fields.updated && fields.updated !== '—', 'the source modification time');
    assert.ok(fields.indexed && fields.indexed !== '—', 'when it was indexed');
    assert.equal(result.data.value, '400');
    assert.equal(result.data.path, 'Finance/Q3/Income-Statement.csv');
  });

  await suite.test('impact returns all known downstream references', () => {
    linkClaim(application, project, 'manuscript/accounting.md', 'The expected depreciation value is 612.', depreciation.object.id);
    linkClaim(application, project, 'manuscript/q3-summary.md', 'Depreciation remained at 612.', depreciation.object.id);
    linkClaim(application, project, 'manuscript/accounting.md', 'Office supplies totalled 400.', supplies.object.id);

    const single = run('impact depreciation-direct');
    assert.equal(single.ok, true);
    assert.equal(single.results.length, 2);
    assert.deepEqual(single.data.documents.map((document) => document.documentPath).sort(),
      ['manuscript/accounting.md', 'manuscript/q3-summary.md']);
    assert.ok(single.results.every((item) => item.lines.some((line) => line.startsWith('"'))),
      'every reference shows the text it holds');

    const bySource = run('impact Income-Statement.csv');
    assert.equal(bySource.ok, true);
    assert.deepEqual(bySource.data.affected.map((entry) => entry.name).sort(),
      ['depreciation-direct', 'office-supplies']);
    assert.equal(bySource.data.documents.reduce((total, document) => total + document.references, 0), 3);
  });

  await suite.test('trace reports the documents that reference a dependency', () => {
    const result = run('trace depreciation-direct');
    assert.equal(result.results.length, 2);
    assert.equal(result.data.references.length, 2);
    assert.ok(result.data.references.every((reference) => reference.status === 'LINKED'));
    assert.equal(result.data.valid, true);
  });

  await suite.test('change detection identifies changed source values', () => {
    fs.writeFileSync(path.join(root, 'Finance/Q3/Income-Statement.csv'), INCOME_V2);
    application.timeline.capture(project.id, ada, { source: 'EXPLICIT_CHECKPOINT' });
    application.dependencies.ensureIndex(project.id);

    const result = run('changes');
    assert.equal(result.ok, true);
    const byName = Object.fromEntries(result.data.changes.map((change) => [change.name, change]));
    assert.equal(byName['depreciation-direct'].previousValue, '612');
    assert.equal(byName['depreciation-direct'].currentValue, '684');
    assert.equal(byName['depreciation-direct'].referenceCount, 2);
    assert.equal(byName['office-supplies'].previousValue, '400');
    assert.equal(byName['office-supplies'].currentValue, '438');
    assert.ok(!byName['payroll-tax'], 'an unchanged value is not reported');
    // A column profile is the indexer's own description, not a source value.
    assert.ok(!Object.keys(byName).includes('current-period'));
  });

  await suite.test('changes filters by time, source and unresolved references', () => {
    assert.ok(run('changes --since 1h').data.changes.length > 0);
    assert.equal(run('changes --since 2999-01-01').data.changes.length, 0);
    assert.equal(run('changes --since bananas').ok, false);
    assert.ok(run('changes --source Finance').data.changes.length > 0);
    assert.equal(run('changes --source Analytics').data.changes.length, 0);
    assert.ok(run('changes --unresolved').data.changes
      .every((change) => change.unresolvedReferences > 0));
  });

  await suite.test('stale detection compares referenced and current values', () => {
    const result = run('stale');
    assert.equal(result.ok, true);
    const entries = Object.fromEntries(result.data.stale.map((entry) => [entry.name, entry]));
    assert.equal(entries['depreciation-direct'].documentValue, '612');
    assert.equal(entries['depreciation-direct'].sourceValue, '684');
    assert.equal(entries['depreciation-direct'].referenceCount, 2);
    assert.equal(entries['office-supplies'].documentValue, '400');
    assert.equal(entries['office-supplies'].sourceValue, '438');
    assert.ok(!entries['payroll-tax'], 'an unchanged dependency is not stale');
  });

  await suite.test('update plans an edit before writing anything', () => {
    const before = fs.readFileSync(path.join(root, 'manuscript/accounting.md'), 'utf8');
    const plan = run('update depreciation-direct');
    assert.equal(plan.ok, true);
    assert.equal(plan.data.rewrites, 2);
    assert.equal(fs.readFileSync(path.join(root, 'manuscript/accounting.md'), 'utf8'), before,
      'a plan does not touch the document');
    const rewrite = plan.data.edits.find((edit) => edit.documentPath === 'manuscript/accounting.md');
    assert.equal(rewrite.nextSpanText, 'The expected depreciation value is 684.');
  });

  await suite.test('update --apply rewrites the documents and relinks them', () => {
    const applied = run('update depreciation-direct --apply');
    assert.equal(applied.ok, true);
    assert.equal(applied.data.applied.length, 2);
    assert.match(fs.readFileSync(path.join(root, 'manuscript/accounting.md'), 'utf8'),
      /The expected depreciation value is 684\./);
    assert.match(fs.readFileSync(path.join(root, 'manuscript/q3-summary.md'), 'utf8'),
      /Depreciation remained at 684\./);
    // The other dependency is untouched: an update is scoped to what was named.
    assert.match(fs.readFileSync(path.join(root, 'manuscript/accounting.md'), 'utf8'),
      /Office supplies totalled 400\./);

    const remaining = run('stale').data.stale.map((entry) => entry.name);
    assert.deepEqual(remaining, ['office-supplies']);
  });

  await suite.test('a rejected actor leaves no document half-written', () => {
    const revert = graph.resolve(project.id, 'office-supplies');
    const before = fs.readFileSync(path.join(root, 'manuscript/accounting.md'), 'utf8');
    assert.throws(
      () => application.dependencies.applySourceValueUpdate(project.id, revert.object.id, { actorType: 'HUMAN_SELF' }),
      /Actor displayName is required/);
    assert.equal(fs.readFileSync(path.join(root, 'manuscript/accounting.md'), 'utf8'), before);
    assert.throws(
      () => application.dependencies.keepCurrentValue(project.id, revert.object.id, {}),
      /Actor displayName is required/);
  });

  await suite.test('update --keep pins a reference to the value it was linked at', () => {
    const kept = run('update office-supplies --keep');
    assert.equal(kept.ok, true);
    assert.equal(kept.data.kept.length, 1);
    assert.deepEqual(run('stale').data.stale, []);
  });

  await suite.test('history returns versions in chronological order', () => {
    const result = run('history depreciation-direct');
    assert.equal(result.ok, true);
    const versions = result.data.versions;
    assert.ok(versions.length >= 2);
    assert.equal(versions[0].value, '684');
    assert.equal(versions.at(-1).value, '612');
    const recorded = versions.map((version) => Date.parse(version.recordedAt));
    assert.deepEqual(recorded, [...recorded].sort((a, b) => b - a), 'newest first');
    const projectVersions = versions.map((version) => version.projectVersion);
    assert.deepEqual(projectVersions, [...projectVersions].sort((a, b) => b - a));
    assert.ok(versions.every((version) => version.path === 'Finance/Q3/Income-Statement.csv'));
    assert.ok(versions.every((version) => version.locator === 'row 2 · Current Period'));
  });

  await suite.test('history --at inspects one recorded state', () => {
    const versions = run('history depreciation-direct').data.versions;
    const target = versions.at(-1);
    const result = executor.run(project.id, `history depreciation-direct --at ${target.recordedAt}`, ada);
    assert.equal(result.ok, true);
    assert.equal(result.data.state.value, '612');
    const before = executor.run(project.id, 'history depreciation-direct --at 2000-01-01', ada);
    assert.equal(before.ok, false, 'a state before the first version is not invented');
  });

  await suite.test('aliases resolve to the intended source', () => {
    assert.equal(graph.resolve(project.id, 'revenue').status, 'AMBIGUOUS');
    const created = run('alias q3-revenue Finance/Q3/model.csv:row 2 · value');
    assert.equal(created.ok, true);
    const traced = run('trace q3-revenue');
    assert.equal(traced.ok, true);
    assert.equal(traced.data.path, 'Finance/Q3/model.csv');
    assert.equal(traced.data.value, '4200000');
    assert.equal(traced.data.alias, 'q3-revenue');

    assert.equal(run('aliases').data.aliases.length, 1);
    // The editor's source search finds the same object by the alias.
    const searched = application.dependencies.search(project.id, 'q3-revenue');
    assert.equal(searched[0].path, 'Finance/Q3/model.csv');

    assert.equal(run('unalias q3-revenue').ok, true);
    assert.equal(run('aliases').data.aliases.length, 0);
    assert.equal(run('trace q3-revenue').ok, false, 'the alias no longer resolves');
  });

  await suite.test('an alias refuses an address that matches several sources', () => {
    const ambiguous = run('alias everything Finance/Q3/Income-Statement.csv');
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.headline, /matches \d+ indexed sources/);
    assert.equal(run('alias nothing Finance/Q3/missing.csv:A1').ok, false);
  });

  await suite.test('conflicts lists names carried by more than one source', () => {
    const all = run('conflicts');
    assert.equal(all.ok, true);
    const revenue = all.data.conflicts.find((conflict) => conflict.name === 'revenue');
    assert.equal(revenue.candidates.length, 4);

    const one = run('conflicts revenue');
    assert.equal(one.headline, 'revenue');
    assert.equal(one.results.length, 4);
    assert.equal(new Set(one.results.map((item) => item.title)).size, 4);
    assert.ok(one.data.conflict.candidates.every((candidate) => candidate.address.includes(':')));

    // An alias resolves the conflict without removing the candidates.
    run(`alias pinned-revenue ${revenue.candidates[0].address}`);
    assert.equal(run('conflicts revenue').data.conflict.resolved, true);
    run('unalias pinned-revenue');
  });

  await suite.test('share listing maps to the correct dependency', () => {
    const object = graph.resolve(project.id, 'office-supplies').object;
    const share = application.objectShares.createShare({
      projectId: project.id,
      objectId: object.id,
      versionId: object.versionId,
      actor: ada,
    });
    const listed = run('shares');
    assert.equal(listed.ok, true);
    assert.equal(listed.data.shares.length, 1);
    const [entry] = listed.data.shares;
    assert.equal(entry.name, 'office-supplies');
    assert.equal(entry.objectId, object.id);
    assert.equal(entry.path, 'Finance/Q3/Income-Statement.csv');
    assert.equal(entry.status, 'active');
    assert.equal(entry.token, share.token);
    assert.equal(run('shares office-supplies').data.shares.length, 1);
    assert.equal(run('shares depreciation-direct').data.shares.length, 0);

    // The share is visible from the dependency it was made from.
    assert.equal(run('trace office-supplies').data.shares.length, 1);
  });

  await suite.test('revoked shares are reported correctly', () => {
    const [entry] = run('shares').data.shares;
    assert.equal(run('shares --revoked').data.shares.length, 0);
    const revoked = run(`revoke ${entry.token}`);
    assert.equal(revoked.ok, true);

    assert.equal(run('shares').data.shares.length, 0, 'a revoked share is not active');
    const revokedList = run('shares --revoked');
    assert.equal(revokedList.data.shares.length, 1);
    assert.equal(revokedList.data.shares[0].status, 'revoked');
    assert.ok(revokedList.data.shares[0].revokedAt);
    // Revocation takes effect on the public route immediately.
    assert.equal(application.objectShares.resolveShare(entry.token).status, 'REVOKED');
    assert.equal(run(`revoke ${entry.token}`).headline, 'office-supplies was already revoked');
  });

  await suite.test('index status reflects the actual indexed directories', () => {
    const result = run('index status');
    assert.equal(result.ok, true);
    const status = result.data;
    assert.equal(status.project.rootPath, fs.realpathSync(root));
    const snapshot = application.timeline.getSnapshot(application.timeline.getProject(project.id).currentSnapshotId);
    assert.equal(status.project.files, snapshot.files.length);
    const directories = Object.fromEntries(status.directories.map((entry) => [entry.name, entry]));
    assert.deepEqual(Object.keys(directories).sort(), ['Analytics', 'Archive', 'Client-A', 'Finance', 'manuscript']);
    assert.equal(directories.Finance.files, 2);
    assert.equal(directories.Finance.health, 'healthy');
    assert.equal(status.project.dependencies, application.db
      .prepare(`SELECT COUNT(*) AS count FROM scientific_object_versions v
        JOIN scientific_objects o ON o.id = v.object_id
        WHERE o.project_id = ? AND v.snapshot_id = ?`)
      .get(project.id, snapshot.id).count);
  });

  await suite.test('index remove excludes a directory from the next scan', () => {
    assert.equal(run('index excluded').data.exclusions.length, 0);
    const excluded = run('index remove Archive');
    assert.equal(excluded.ok, true);
    assert.deepEqual(indexing.exclusions(project.id).map((entry) => entry.pathPrefix), ['Archive']);

    run('index refresh');
    const snapshot = application.timeline.getSnapshot(application.timeline.getProject(project.id).currentSnapshotId);
    assert.ok(!snapshot.files.some((file) => file.path.startsWith('Archive/')), 'the excluded path is not rescanned');
    assert.equal(run('index status').data.directories.find((entry) => entry.name === 'Archive')?.health, 'excluded');

    run('index include Archive');
    run('index refresh');
    const restored = application.timeline.getSnapshot(application.timeline.getProject(project.id).currentSnapshotId);
    assert.ok(restored.files.some((file) => file.path.startsWith('Archive/')));
  });

  await suite.test('index failures report what could not be read', () => {
    assert.equal(run('index failures').data.failures.length, 0);
    indexing.recordFailures(project.id, [
      { path: 'Client-A/budget.xlsx', code: 'DISAPPEARED', reason: 'file changed during indexing' },
      { path: 'Analytics/raw-data.csv', code: 'PERMISSION_DENIED', reason: 'permission denied' },
    ]);
    const failures = run('index failures');
    assert.equal(failures.data.failures.length, 2);
    assert.deepEqual(failures.data.failures.map((entry) => entry.reason).sort(),
      ['file changed during indexing', 'permission denied']);
    assert.ok(failures.data.failures.every((entry) => entry.retryable));
    assert.equal(run('index status').data.failures.length, 2);
    assert.equal(run('index status').data.directories.find((entry) => entry.name === 'Client-A').health, '1 error');

    // A scan that no longer sees the failure resolves it rather than deleting it.
    indexing.recordFailures(project.id, []);
    assert.equal(run('index failures').data.failures.length, 0);
    assert.equal(indexing.failures(project.id, { includeResolved: true }).length, 2);
  });

  await suite.test('rules are deterministic and flag what they match', () => {
    const added = run('rules add when source path starts with Finance/Q3 then flag affected dependencies');
    assert.equal(added.ok, true);
    const listed = run('rules');
    assert.equal(listed.data.rules.length, 1);
    assert.equal(listed.data.rules[0].triggerText, 'source path starts with Finance/Q3');
    assert.equal(listed.data.rules[0].actionText, 'flag affected dependencies');
    assert.equal(listed.data.rules[0].enabled, true);

    executor.evaluateRules(project.id);
    const flagged = run('rules flags').data.flags;
    assert.ok(flagged.length > 0);
    assert.ok(flagged.every((flag) => flag.detail.path.startsWith('Finance/Q3')));

    assert.equal(run('rules disable 1').data.rule.enabled, false);
    assert.equal(run('rules list').data.rules[0].enabled, false);
    assert.equal(run('rules remove 1').ok, true);
    assert.equal(run('rules').data.rules.length, 0);
    assert.equal(run('rules add when the moon is full then panic').ok, false);
  });

  await suite.test('a share-stale rule flags a share the source outran', () => {
    const before = graph.resolve(project.id, 'payroll-tax').object;
    const share = application.objectShares.createShare({
      projectId: project.id, objectId: before.id, versionId: before.versionId, actor: ada,
    });
    run('rules add when a shared source changes then mark the share as potentially stale');

    // A share made from the current value is not stale.
    executor.evaluateRules(project.id);
    assert.equal(run('rules flags').data.flags.filter((flag) => flag.subjectKind === 'SHARE').length, 0);

    fs.writeFileSync(path.join(root, 'Finance/Q3/Income-Statement.csv'), INCOME_V2.replace(',225,', ',241,'));
    application.timeline.capture(project.id, ada, { source: 'EXPLICIT_CHECKPOINT' });
    application.dependencies.ensureIndex(project.id);
    executor.evaluateRules(project.id);

    const flags = run('rules flags').data.flags.filter((flag) => flag.subjectKind === 'SHARE');
    assert.equal(flags.length, 1);
    assert.equal(flags[0].subject, share.token);
    assert.equal(flags[0].detail.name, 'payroll-tax');
    assert.equal(flags[0].detail.previousValue, '225');
    assert.equal(flags[0].detail.currentValue, '241');

    // The rule reports; it does not revoke, and the recipient still sees the
    // version that was shared.
    assert.equal(application.objectShares.resolveShare(share.token).status, 'OK');
    const listed = run('shares').data.shares.find((entry) => entry.token === share.token);
    assert.equal(listed.sharedValue, '225');
    assert.equal(listed.currentValue, '241');
    assert.equal(listed.drifted, true);

    run(`revoke ${share.token}`);
    run('rules remove 1');
  });

  await suite.test('an autocomplete-suppression rule affects the editor, not search', () => {
    run('rules add "Archive suppression" when source path starts with Archive then exclude from autocomplete');
    assert.deepEqual(rules.suppressedPathPrefixes(project.id), ['Archive']);
    const permitted = application.dependencies.autocompleteFilter(project.id);
    assert.equal(permitted({ path: 'Archive/old-figures.csv' }), false);
    assert.equal(permitted({ path: 'Finance/Q3/model.csv' }), true);
    // Explicitly searching still reaches it.
    assert.ok(run('find revenue --directory Archive').results.length > 0);
    run('rules remove 1');
  });

  await suite.test('ask answers only from indexed sources', () => {
    const source = run('ask which source contains our latest depreciation-direct?');
    assert.equal(source.data.answered, true);
    assert.match(source.headline, /684/);
    const lines = source.blocks.filter((block) => block.kind === 'text').map((block) => block.text);
    assert.ok(lines.includes('Source'));
    assert.ok(lines.some((line) => line.includes('Finance/Q3/Income-Statement.csv')));
    assert.ok(lines.some((line) => line.includes('row 2 · Current Period')));

    const previous = run('ask what was our office-supplies value before the latest update?');
    assert.equal(previous.data.answered, true);
    assert.equal(previous.headline, 'Previous value: 400');
    assert.equal(previous.data.current.value, '438');

    const when = run('ask when was depreciation-direct last updated?');
    assert.equal(when.data.answered, true);
    assert.match(when.headline, /was last updated/);

    const dependents = run('ask what depends on depreciation-direct?');
    assert.equal(dependents.data.answered, true);
    assert.equal(dependents.data.documents.length, 2);
  });

  await suite.test('ask does not answer when no source supports the answer', () => {
    const missing = run('ask what is our gross margin?');
    assert.equal(missing.data.answered, false);
    assert.equal(missing.headline, 'Not answerable from indexed sources');

    const ambiguous = run('ask what is our revenue?');
    assert.equal(ambiguous.data.answered, false);
    assert.match(ambiguous.blocks[0].text, /names 4 different indexed sources/);

    const generative = run('ask write me a poem about depreciation');
    assert.equal(generative.data.answered, false);
    assert.equal(generative.headline, 'This terminal queries and operates on indexed CoLab sources.');

    const unsupported = run('ask why is the sky blue?');
    assert.equal(unsupported.data.answered, false);
    assert.match(unsupported.headline, /Not answerable/);
  });

  await suite.test('unknown commands refuse rather than answer generally', () => {
    const result = run('write me an email');
    assert.equal(result.ok, false);
    assert.equal(result.blocks[0].text, 'This terminal queries and operates on indexed CoLab sources.');
  });

  await suite.test('completion offers commands, dependencies, subcommands and flags', () => {
    assert.deepEqual(executor.complete(project.id, 'tra').suggestions.map((item) => item.value), ['trace']);
    const dependencies = executor.complete(project.id, 'trace dep').suggestions;
    const names = dependencies.map((item) => item.value);
    assert.ok(names.includes('depreciation-direct'));
    // Prefix matches lead; anything else is offered after them and labelled.
    const lastPrefix = names.findLastIndex((name) => name.startsWith('dep'));
    assert.ok(names.slice(0, lastPrefix + 1).every((name) => name.startsWith('dep')));
    assert.ok(dependencies.every((item) => item.detail));
    assert.ok(dependencies.filter((item) => item.value.startsWith('dep'))
      .every((item) => item.kind === 'dependency' || item.kind === 'alias'));
    // A value is offered alongside the name, so a cell can be told from its row.
    assert.equal(dependencies.find((item) => item.value === 'depreciation-direct').preview, '684');
    assert.deepEqual(executor.complete(project.id, 'index st').suggestions.map((item) => item.value), ['status']);
    assert.deepEqual(executor.complete(project.id, 'find revenue --dir').suggestions.map((item) => item.value), ['--directory']);
    const files = executor.complete(project.id, 'impact Fin').suggestions.filter((item) => item.kind === 'source');
    assert.ok(files.some((item) => item.value.startsWith('Finance/')));
  });

  await suite.test('completion falls back to related sources rather than nothing', () => {
    // Nothing is *named* `supplies` — the name is `office-supplies` — but the
    // index knows what the word refers to.
    const fallback = executor.complete(project.id, 'trace supplies').suggestions;
    assert.ok(fallback.length > 0, 'an empty box helps nobody');
    assert.ok(fallback.every((item) => item.kind === 'related'), 'and it says they are related');
    assert.ok(fallback.some((item) => item.value === 'office-supplies'));
    assert.ok(fallback.every((item) => item.value && item.detail != null));

    // With prefix matches, the loose ones are left out rather than padding it.
    const prefixed = executor.complete(project.id, 'trace office').suggestions;
    assert.ok(prefixed.length > 0);
    assert.ok(prefixed.every((item) => item.kind !== 'related'));
    assert.ok(prefixed.every((item) => item.value.startsWith('office')));

    // A fragment that matches nothing at all still returns nothing.
    assert.equal(executor.complete(project.id, 'trace zzzznothing').suggestions.length, 0);
  });

  await suite.test('completion offers indexed files, not only names', () => {
    // A file is usually named after what it holds, so it is the most direct
    // handle a source has — and container objects never surface as names.
    const found = executor.complete(project.id, 'find Income').suggestions;
    assert.equal(found[0].kind, 'source');
    assert.equal(found[0].value, 'Finance/Q3/Income-Statement.csv');
    assert.match(found[0].detail, /\d+ indexed/);
    assert.equal(executor.complete(project.id, 'find Income').heading, 'source or dependency');

    // The completed line is a query the command actually answers.
    const searched = run(`find ${found[0].value}`);
    assert.equal(searched.ok, true);
    assert.ok(searched.results.length > 0);
    assert.ok(searched.results.every((item) => item.lines[0] === 'Finance/Q3/Income-Statement.csv'),
      'naming a file means that file, not every sibling sharing its directory');
    assert.equal(searched.subhead, 'everything indexed from Finance/Q3/Income-Statement.csv');
    assert.ok(searched.results.every((item) => item.badge == null));

    // Matching mid-path works too, so a directory finds its files.
    assert.ok(executor.complete(project.id, 'find statement').suggestions
      .some((item) => item.kind === 'source' && item.value.endsWith('Income-Statement.csv')));

    // Having typed a whole file name, that file is the answer — its contents
    // are not listed back as loose matches.
    const whole = executor.complete(project.id, 'impact Income-Statement.csv').suggestions;
    assert.equal(whole[0].kind, 'source');
    assert.ok(whole.every((item) => item.kind !== 'related'));
  });

  await suite.test('flag values complete against the index', () => {
    const directories = executor.complete(project.id, 'find revenue --directory Fin');
    assert.equal(directories.position, 'flagValue');
    assert.equal(directories.heading, '--directory');
    assert.deepEqual(directories.suggestions.map((item) => item.value), ['Finance', 'Finance/Q3']);
    assert.ok(directories.suggestions.every((item) => /\d+ files?/.test(item.detail)));
    // And the completed line filters as promised.
    assert.ok(run('find revenue --directory Finance').results
      .every((item) => item.lines[0].startsWith('Finance/')));

    const types = executor.complete(project.id, 'find revenue --source ');
    assert.equal(types.heading, '--source');
    assert.ok(types.suggestions.some((item) => item.value === 'csv'));
    assert.ok(types.suggestions.every((item) => !item.value.startsWith('.')));

    const when = executor.complete(project.id, 'changes --since ');
    assert.deepEqual(when.suggestions.map((item) => item.value),
      ['yesterday', 'today', '24h', '7d', '30d']);
    assert.ok(when.suggestions.every((item) => parseSince(item.value) !== null));

    const paths = executor.complete(project.id, 'changes --source Fin');
    assert.ok(paths.suggestions.some((item) => item.kind === 'directory'));
    assert.ok(paths.suggestions.some((item) => item.kind === 'source'));

    // A flag that takes no value offers nothing rather than guessing.
    assert.equal(executor.complete(project.id, 'changes --unresolved ').suggestions.length, 0);
  });

  await suite.test('index and alias complete paths and addresses', () => {
    const target = executor.complete(project.id, 'index remove Arch');
    assert.equal(target.heading, 'path');
    assert.ok(target.suggestions.some((item) => item.value === 'Archive'));

    const addresses = executor.complete(project.id, 'alias q3-revenue model');
    assert.equal(addresses.heading, 'source address');
    const pinned = addresses.suggestions.find((item) => item.value.startsWith('Finance/Q3/model.csv:'));
    assert.ok(pinned, 'the address includes the exact location, not just the file');
    assert.ok(pinned.value.includes(':'));

    // The completed address is one `alias` accepts.
    assert.equal(run(`alias completed-revenue "${pinned.value}"`).ok, true);
    assert.equal(run('trace completed-revenue').data.path, 'Finance/Q3/model.csv');
    run('unalias completed-revenue');
  });

  await suite.test('impact completes source paths before dependency names', () => {
    const completion = executor.complete(project.id, 'impact Fin');
    assert.equal(completion.heading, 'source or dependency');
    // Files lead, because a file is the most identifiable handle a source has.
    const files = completion.suggestions.filter((item) => item.kind === 'source');
    assert.ok(files.length > 0);
    assert.equal(completion.suggestions[0].kind, 'source');
    assert.ok(completion.suggestions[0].value.startsWith('Finance/'));
    assert.equal(completion.suggestions.findIndex((item) => item.kind !== 'source'), files.length);
  });

  await suite.test('the completion box says what it is offering', () => {
    assert.equal(executor.complete(project.id, 'tra').heading, 'command');
    assert.equal(executor.complete(project.id, 'trace off').heading, 'dependency');
    assert.equal(executor.complete(project.id, 'index st').heading, 'index subcommand');
    assert.equal(executor.complete(project.id, 'changes --sou').heading, 'changes flag');
    assert.equal(executor.complete(project.id, 'unalias q').heading, 'alias');
  });

  await suite.test('the banner counts what needs review', () => {
    const banner = executor.banner(project.id);
    assert.equal(banner.project.id, project.id);
    assert.ok(banner.dependencies > 0);
    assert.ok(banner.conflicts > 0);
    assert.ok(banner.commands.includes('trace'));
  });

  await suite.test('previews show the source rows around a result', () => {
    const object = graph.resolve(project.id, 'office-supplies').object;
    const preview = executor.preview(project.id, { kind: 'object', objectId: object.id });
    assert.equal(preview.kind, 'table');
    assert.equal(preview.fileName, 'Income-Statement.csv');
    assert.equal(preview.locator, 'row 3 · Current Period');
    assert.equal(preview.highlightColumn, 1);
    const highlighted = preview.rows.find((row) => row.highlighted);
    assert.equal(highlighted.cells[0], 'Office Supplies');
    assert.equal(highlighted.cells[1], '438');
  });

  await suite.test('a command needing a name says so instead of guessing', () => {
    for (const input of ['trace', 'impact', 'history', 'update', 'find']) {
      const result = run(input);
      assert.equal(result.ok, false, `${input} without an argument`);
      assert.ok(result.hints.length > 0);
    }
    const missing = run('trace nothing-like-this');
    assert.equal(missing.ok, false);
    assert.match(missing.headline, /No indexed dependency named/);
  });
});

test('a claim follows its text, and is retired when the text goes', async (suite) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'colab-anchor-test-'));
  const root = path.join(sandbox, 'Workspace');
  fs.mkdirSync(path.join(root, 'Finance'), { recursive: true });
  fs.mkdirSync(path.join(root, 'manuscript'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Finance/Income-Statement.csv'), INCOME_V1);
  const documentPath = path.join(root, 'manuscript/notes.md');
  const ORIGINAL = '# Notes\n\nI took a look at the supplies and 400 was the cost.\n';
  fs.writeFileSync(documentPath, ORIGINAL);

  const application = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  const { project } = application.timeline.importProject(root, ada);
  application.dependencies.ensureIndex(project.id);
  const { graph } = application.terminal;
  const supplies = graph.resolve(project.id, 'office-supplies');

  suite.after(async () => {
    await application.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const rewrite = (text) => {
    fs.writeFileSync(documentPath, text);
    application.timeline.capture(project.id, ada, { source: 'DOCUMENT_CHANGE' });
    application.dependencies.reconcileProject(project.id);
  };
  const live = () => application.dependencies.currentDependencies(project.id);
  const link = (needle) => linkClaim(application, project, 'manuscript/notes.md', needle, supplies.object.id)
    .dependency.id;

  let dependencyId = link('supplies');

  await suite.test('an edit around the claim keeps it anchored', () => {
    rewrite('# Notes\n\nI had a look at the supplies and 400 was the cost.\n');
    const [dependency] = live();
    assert.equal(dependency.id, dependencyId);
    assert.equal(dependency.statusDetails.anchorIssue, undefined);
    // The claim moved by one character, and followed the edit.
    assert.match(dependency.anchor.prefix, /a look at the $/);
  });

  await suite.test('the claim follows its paragraph to a new position', () => {
    rewrite('# Notes\n\nA new opening paragraph.\n\nI had a look at the supplies and 400 was the cost.\n');
    const [dependency] = live();
    assert.equal(dependency.anchor.blockIndex, 2);
    assert.equal(dependency.statusDetails.anchorIssue, undefined);
  });

  await suite.test('deleting the claim retires the link', () => {
    rewrite('# Notes\n\n');
    assert.deepEqual(live(), [], 'the document no longer holds the claim, so nothing links to it');
    // The record survives: a removal is a revision, not a deletion.
    const retired = application.dependencies.getDependency(dependencyId);
    assert.equal(retired.removed, true);
    assert.match(retired.statusDetails.retiredReason, /no longer in the document/);
    assert.equal(application.db.prepare(`
      SELECT change_type FROM dependency_changes WHERE dependency_id = ?
      ORDER BY rowid DESC LIMIT 1
    `).get(dependencyId).change_type, 'DEPENDENCY_REMOVED');
  });

  await suite.test('typing the same word later does not resurrect it', () => {
    rewrite('# Notes\n\ni looked at supplies\n');
    assert.deepEqual(live(), [], 'the word is present, but this is not the claim that was linked');
  });

  await suite.test('nor does restoring the original wording — relinking is explicit', () => {
    rewrite(ORIGINAL);
    assert.deepEqual(live(), []);
    // Linking again is a new dependency, recorded as such.
    dependencyId = link('supplies');
    assert.equal(live().length, 1);
    assert.notEqual(live()[0].id, undefined);
  });

  await suite.test('an ambiguous repeat is not chosen between', () => {
    rewrite('# Notes\n\nsupplies here.\n\nsupplies there.\n');
    assert.deepEqual(live(), [], 'two equally plausible homes is not one claim');
  });

  await suite.test('unlink retires a resolved link on request', () => {
    rewrite(ORIGINAL);
    dependencyId = link('supplies');
    assert.equal(live().length, 1);

    const run = (input) => application.terminal.executor.run(project.id, input, ada);
    const plan = run('unlink office-supplies');
    assert.equal(plan.ok, true);
    assert.equal(plan.data.targets.length, 1);
    assert.equal(live().length, 1, 'a plan writes nothing');

    const applied = run('unlink office-supplies --apply');
    assert.equal(applied.data.removed.length, 1);
    assert.deepEqual(live(), []);
    assert.equal(application.dependencies.getDependency(dependencyId).removed, true);
  });
});

test('terminal recommendations share relevance, relationship and usage priorities', async (suite) => {
  const { sandbox, root, application, project } = buildWorkspace();
  const { graph, executor } = application.terminal;
  const ranking = application.dependencies.ranking;
  const currentTime = Date.parse('2026-09-12T15:00:00Z');
  let time = currentTime;
  ranking.now = () => time;
  const record = (filePath, kind = 'accept', sessionId = 'terminal-test') => ranking.record(project.id, { path: filePath, kind, sessionId });

  fs.writeFileSync(path.join(root, 'Analytics/revenue-notes.csv'), 'metric,value\nrevenue-plan,500\n');
  fs.writeFileSync(path.join(root, 'Analytics/many-values.csv'),
    `metric,value\n${Array.from({ length: 60 }, (_, index) => `indicator-${String(index).padStart(2, '0')},${index}`).join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'Client-A/metrics-special.csv'), 'metric,value\nindicator-z-favorite,999\n');
  application.timeline.capture(project.id, ada, { source: 'EXPLICIT_CHECKPOINT' });
  application.dependencies.ensureIndex(project.id);

  suite.beforeEach(() => {
    time = currentTime;
    application.timeline.db.prepare('DELETE FROM recommendation_usage WHERE project_id = ?').run(project.id);
  });
  suite.after(async () => {
    await application.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  await suite.test('an exact dependency beats a popular prefix without resolving ambiguity', () => {
    for (let session = 0; session < 20; session += 1) record('Analytics/revenue-notes.csv', 'accept', `popular-${session}`);
    const found = executor.run(project.id, 'find revenue', ada);
    assert.deepEqual(found.results.slice(0, 4).map((item) => item.title), ['revenue', 'revenue', 'revenue', 'revenue']);
    const prefix = found.results.find((item) => item.title === 'revenue-plan');
    assert.ok(prefix.ranking.usageBoost > 0);
    assert.ok(found.results.every((item) => item.ranking && item.reason && item.ref.objectId && item.ref.path));
    assert.equal(graph.resolve(project.id, 'revenue').status, 'AMBIGUOUS');
  });

  await suite.test('empty queries suggest recent files before historically frequent files', () => {
    time = currentTime - 10 * 86400000;
    for (let session = 0; session < 20; session += 1) record('Finance/Q3/Income-Statement.csv', 'accept', `older-${session}`);
    time = currentTime;
    record('Client-A/forecast.csv', 'open', 'recent-open');
    const suggestions = executor.complete(project.id, 'find ').suggestions;
    assert.equal(suggestions[0].path, 'Client-A/forecast.csv');
    assert.equal(suggestions[1].path, 'Finance/Q3/Income-Statement.csv');
    assert.ok(suggestions.every((item) => item.kind === 'source'));
    assert.equal(new Set(suggestions.map((item) => item.path)).size, suggestions.length);
    assert.match(suggestions[0].ranking.reason, /Recently used/);
  });

  await suite.test('completion ranks the full candidate pool before limiting and carries source identity', () => {
    record('Client-A/metrics-special.csv');
    const suggestions = executor.complete(project.id, 'trace indicator').suggestions;
    assert.equal(suggestions[0].value, 'indicator-z-favorite');
    assert.equal(suggestions[0].path, 'Client-A/metrics-special.csv');
    assert.ok(suggestions[0].objectId && suggestions[0].objectKey && suggestions[0].ranking.reason);
    assert.ok(suggestions.filter((item) => item.path === 'Analytics/many-values.csv').length <= 2);
  });

  await suite.test('broad results are diverse while exact source drilldowns remain complete and filtered', () => {
    const broad = executor.run(project.id, 'find indicator', ada);
    const counts = new Map();
    for (const item of broad.results) counts.set(item.ref.path, (counts.get(item.ref.path) ?? 0) + 1);
    assert.ok(counts.size > 1);
    assert.ok([...counts.values()].every((count) => count <= 2));
    const exact = executor.run(project.id, 'find Analytics/many-values.csv --limit=200', ada);
    const expected = graph.addressableObjects(project.id).filter((object) => object.path === 'Analytics/many-values.csv').length;
    assert.equal(exact.results.length, expected);
    assert.ok(exact.results.length > 50);
    const addresses = graph.addressSuggestions(project.id, 'Analytics/many-values.csv', 200);
    assert.equal(addresses.length, expected, 'an explicit source also exposes every address when pinning an alias');
    assert.equal(executor.run(project.id, 'find Analytics/many-values.csv --directory Finance', ada).results.length, 0);
    assert.equal(executor.run(project.id, 'find Analytics/many-values.csv --source md', ada).results.length, 0);
    assert.equal(executor.run(project.id, 'find Archive/old-figures.csv --updated 7d', ada).results.length, 0);
  });

  await suite.test('current writing context precedes unrelated usage and passive reads add no usage', () => {
    record('Archive/old-figures.csv');
    const countUsage = () => application.timeline.db.prepare('SELECT COUNT(*) AS count FROM recommendation_usage WHERE project_id = ?').get(project.id).count;
    const before = countUsage();
    const sources = executor.complete(project.id, 'find ', { context: 'depreciation' }).suggestions;
    assert.equal(sources[0].path, 'Finance/Q3/Income-Statement.csv');
    assert.equal(sources[0].ranking.tier, 1);
    const suggestion = executor.complete(project.id, 'trace office').suggestions[0];
    assert.ok(executor.preview(project.id, suggestion));
    executor.run(project.id, 'find revenue', ada);
    assert.equal(countUsage(), before, 'suggestions, searches and highlighted previews are passive');
  });

  await suite.test('current-document relationships break relevant ties before usage', () => {
    const source = graph.resolve(project.id, 'revenue', { directory: 'Finance' }).object;
    linkClaim(application, project, 'manuscript/accounting.md', 'Office supplies totalled 400.', source.id);
    for (let session = 0; session < 20; session += 1) record('Archive/old-figures.csv', 'accept', `archive-${session}`);
    const options = { documentPath: 'manuscript/accounting.md' };
    const found = executor.run(project.id, 'find revenue', ada, options);
    assert.equal(found.results[0].ref.path, 'Finance/Q3/model.csv');
    assert.equal(found.results[0].ranking.relationship, true);
    const recent = executor.complete(project.id, 'find ', options).suggestions;
    assert.equal(recent[0].path, 'Finance/Q3/model.csv');
    assert.match(recent[0].ranking.reason, /this document/);
  });
});

test('terminal command parser', async (suite) => {
  await suite.test('splits quoted arguments', () => {
    assert.deepEqual(tokenize('history dep --at "Aug 19"'), ['history', 'dep', '--at', 'Aug 19']);
    assert.deepEqual(tokenize("alias q3 'a b.csv:X!1'"), ['alias', 'q3', 'a b.csv:X!1']);
    assert.deepEqual(tokenize('   '), []);
  });

  await suite.test('separates flags from positional arguments', () => {
    // A boolean flag does not swallow the word after it.
    const boolean = parseCommand('find --all revenue', new Set(['all']));
    assert.deepEqual(boolean.args, ['revenue']);
    assert.deepEqual(boolean.flags, { all: true });
    assert.deepEqual(parseCommand('find --all revenue').flags, { all: 'revenue' },
      'and without that knowledge it still takes it, as a plain parser must');

    const command = parseCommand('find revenue --source xlsx --updated=30d --unresolved');
    assert.equal(command.name, 'find');
    assert.deepEqual(command.args, ['revenue']);
    assert.deepEqual(command.flags, { source: 'xlsx', updated: '30d', unresolved: true });

    const literal = parseCommand('find -- --weird');
    assert.deepEqual(literal.args, ['--weird']);
    assert.deepEqual(literal.flags, {});

    assert.equal(parseCommand('ask which source has revenue?').rest, 'which source has revenue?');
    assert.equal(parseCommand('').empty, true);
  });

  await suite.test('an address splits at the path, not the last colon', () => {
    assert.deepEqual(parseAddress('Finance/Q3/model.xlsx:Summary!B17'),
      { path: 'Finance/Q3/model.xlsx', locator: 'Summary!B17' });
    // A locator may hold a colon of its own; a path never does.
    assert.deepEqual(parseAddress('Analytics/report.csv:column: revenue'),
      { path: 'Analytics/report.csv', locator: 'column: revenue' });
    assert.deepEqual(parseAddress('Finance/Q3/model.csv'),
      { path: 'Finance/Q3/model.csv', locator: null });
    assert.equal(parseAddress('  '), null);
  });

  await suite.test('understands the time vocabulary', () => {
    const reference = Date.parse('2026-08-21T14:00:00Z');
    assert.equal(parseSince('7d', reference), reference - 7 * 86400000);
    assert.equal(parseSince('24h', reference), reference - 86400000);
    assert.ok(parseSince('yesterday', reference) < reference);
    assert.ok(parseSince('today', reference) <= reference);
    assert.equal(parseSince('2026-08-19'), Date.parse('2026-08-19'));
    assert.equal(parseSince('soonish'), null);
  });

  await suite.test('knows where the caret is', () => {
    assert.deepEqual(completionContext('tra'),
      { position: 'command', fragment: 'tra', command: null, flag: null, argIndex: 0 });
    assert.equal(completionContext('trace dep').position, 'argument');
    assert.equal(completionContext('trace dep').fragment, 'dep');
    assert.equal(completionContext('find x --sou').position, 'flag');
    assert.equal(completionContext('find x --sou').fragment, 'sou');

    // The word after a value-taking flag is that flag's value, not an argument.
    const value = completionContext('find x --source cs');
    assert.equal(value.position, 'flagValue');
    assert.equal(value.flag, 'source');
    assert.equal(value.fragment, 'cs');
    assert.equal(completionContext('find x --source ').position, 'flagValue');
    assert.equal(completionContext('find --source csv rev').argIndex, 0);

    // A flag known to take no value leaves the next word alone.
    const booleans = new Set(['unresolved']);
    assert.equal(completionContext('changes --unresolved ', booleans).position, 'argument');
    assert.equal(completionContext('changes --unresolved ').position, 'flagValue');
  });

  await suite.test('rule sentences use a closed vocabulary', () => {
    const good = parseRuleSentence('when source path starts with Finance/Q3 then flag affected dependencies');
    assert.deepEqual(good, { ok: true, trigger: { kind: 'SOURCE_PATH_PREFIX', value: 'Finance/Q3' }, action: 'FLAG_DEPENDENTS' });
    assert.equal(parseRuleSentence('when a shared source changes then mark the share as potentially stale').action, 'MARK_SHARE_STALE');
    assert.equal(parseRuleSentence('when source path starts with Archive then exclude from autocomplete').action, 'EXCLUDE_FROM_AUTOCOMPLETE');
    assert.equal(parseRuleSentence('flag everything').ok, false);
    assert.equal(parseRuleSentence('when it feels right then flag affected dependencies').ok, false);
  });
});
