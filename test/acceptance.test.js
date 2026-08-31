import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { buildPreview } from '../src/history/preview.js';
import { UNKNOWN_MESSAGE } from '../src/history/rfi.js';

const maya = { id: 'human:maya', displayName: 'Maya Chen', actorType: 'HUMAN_SELF' };
const alex = { id: 'human:alex', displayName: 'Alex Rivera', actorType: 'HUMAN_COLLABORATOR' };
const agent = { id: 'agent:stats', displayName: 'CoLab Stats Agent', actorType: 'AI_AGENT' };

test('scientific timeline and RFI acceptance workflows', async (suite) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'colab-timeline-test-'));
  const projectRoot = path.join(sandbox, 'LungAtlas');
  const dataDir = path.join(sandbox, 'history');
  fs.mkdirSync(path.join(projectRoot, 'analysis'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'results'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Results\n\nBaseline result.\n');
  fs.writeFileSync(path.join(projectRoot, 'analysis', 'model.py'), 'model = "outcome ~ treatment"\n');
  fs.writeFileSync(path.join(projectRoot, 'results', 'de_model.csv'), 'marker,effect\nIL6,-0.18\n');

  let application = createApplication({ dataDir, watchProjects: false });
  let service = application.timeline;
  let project;

  await suite.test('A — initial import creates immutable Version 1', () => {
    const result = service.importProject(`'${projectRoot}'`, maya, { watch: false });
    project = result.project;
    assert.equal(result.imported, true);
    assert.equal(project.currentVersion, 1);
    assert.equal(result.event.title, 'Project imported');
    assert.equal(result.event.actor.displayName, 'Maya Chen');
    assert.equal(service.getSnapshot(project.currentSnapshotId).files.length, 3);
  });

  let humanEvent;
  await suite.test('B — a human Markdown edit creates a before/after event', () => {
    fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Results\n\nTreatment remained significant after adjustment for age.\n');
    const result = service.capture(project.id, maya, { expectedSnapshotId: project.currentSnapshotId, source: 'WATCHER' });
    humanEvent = result.event;
    project = service.getProject(project.id);
    assert.equal(result.changed, true);
    assert.equal(project.currentVersion, 2);
    assert.equal(humanEvent.previousVersion, 1);
    assert.equal(humanEvent.resultingVersion, 2);
    assert.equal(humanEvent.actor.actorType, 'HUMAN_SELF');
    assert.equal(humanEvent.changes[0].structuredDiff.format, 'markdown');
    assert.ok(humanEvent.changes[0].structuredDiff.operations.some((item) => item.kind === 'add' && item.text.includes('significant')));
  });

  await suite.test('D — collaborator execution context remains distinct', () => {
    fs.writeFileSync(path.join(projectRoot, 'analysis', 'model.py'), 'model = "outcome ~ treatment + age"\n');
    const result = service.capture(project.id, alex, { expectedSnapshotId: project.currentSnapshotId, source: 'COLLABORATOR_SYNC' });
    project = service.getProject(project.id);
    assert.equal(result.event.actor.displayName, 'Alex Rivera');
    assert.equal(result.event.actor.actorType, 'HUMAN_COLLABORATOR');
  });

  await suite.test('E — event detail always retains its immediate V1 → V2 comparison', () => {
    const event = service.getEvent(humanEvent.id);
    assert.equal(event.previousVersion, 1);
    assert.equal(event.resultingVersion, 2);
    assert.notEqual(event.resultingSnapshotId, project.currentSnapshotId);
    const before = service.snapshotFile(event.previousSnapshotId, 'README.md');
    const after = service.snapshotFile(event.resultingSnapshotId, 'README.md');
    assert.match(service.blobs.get(before.contentHash).toString(), /Baseline result/);
    assert.match(service.blobs.get(after.contentHash).toString(), /remained significant/);
  });

  let aiSnapshot;
  await suite.test('C — approved AI edit records agent and requesting user on the normal timeline', () => {
    const proposal = service.proposeAgentEdit(project.id, {
      path: 'README.md',
      request: 'Add the IL-6 result.',
      content: '# Results\n\nTreatment remained significant after adjustment for age.\n\nTreatment reduced IL-6 by 18%.\n',
      baseSnapshotId: project.currentSnapshotId,
      agent,
      initiatedBy: maya,
      provenance: [{
        relation: 'DERIVED_FROM',
        toSnapshotId: project.currentSnapshotId,
        toPath: 'results/de_model.csv',
        metadata: { row: 'IL6', effect: '-0.18' },
      }],
    });
    assert.equal(proposal.status, 'PROPOSED');
    assert.match(fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8'), /adjustment for age\.\n$/);
    const approved = service.approveAgentEdit(proposal.id);
    project = service.getProject(project.id);
    aiSnapshot = approved.snapshot;
    assert.equal(approved.event.actor.actorType, 'AI_AGENT');
    assert.equal(approved.event.actor.displayName, 'CoLab Stats Agent');
    assert.equal(approved.event.initiatedBy.displayName, 'Maya Chen');
    assert.match(fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8'), /reduced IL-6 by 18%/);
  });

  await suite.test('F — RFI identifies AI introduction and traverses recorded provenance', () => {
    const file = service.snapshotFile(aiSnapshot.id, 'README.md');
    const preview = buildPreview(aiSnapshot, file, service.blobs.get(file.contentHash));
    const item = preview.items.find((candidate) => candidate.text.includes('reduced IL-6'));
    const result = application.rfi.request(project.id, { snapshotId: aiSnapshot.id, path: 'README.md', anchor: item.anchor });
    assert.equal(result.selection.value, 'Treatment reduced IL-6 by 18%.');
    assert.equal(result.firstRecorded.version, aiSnapshot.version);
    assert.equal(result.firstRecorded.actor.displayName, 'CoLab Stats Agent');
    assert.equal(result.firstRecorded.initiatedBy.displayName, 'Maya Chen');
    assert.equal(result.provenanceEstablished, true);
    assert.equal(result.provenance[0].relation, 'DERIVED_FROM');
    assert.equal(result.provenance[0].to.path, 'results/de_model.csv');
  });

  await suite.test('G — unknown upstream provenance is explicit and never guessed', () => {
    fs.appendFileSync(path.join(projectRoot, 'README.md'), '\nA manually pasted observation.\n');
    const captured = service.capture(project.id, maya, { expectedSnapshotId: project.currentSnapshotId, source: 'WATCHER' });
    project = service.getProject(project.id);
    const file = service.snapshotFile(captured.snapshot.id, 'README.md');
    const preview = buildPreview(captured.snapshot, file, service.blobs.get(file.contentHash));
    const item = preview.items.find((candidate) => candidate.text.includes('manually pasted'));
    const result = application.rfi.request(project.id, { snapshotId: captured.snapshot.id, path: 'README.md', anchor: item.anchor });
    assert.equal(result.provenanceEstablished, false);
    assert.equal(result.message, UNKNOWN_MESSAGE);
    assert.equal(result.firstRecorded.actor.displayName, 'Maya Chen');
  });

  await suite.test('H — a same-identity file rename is not split into delete and add', () => {
    fs.renameSync(path.join(projectRoot, 'analysis', 'model.py'), path.join(projectRoot, 'analysis', 'de_analysis.py'));
    const result = service.capture(project.id, maya, { expectedSnapshotId: project.currentSnapshotId, source: 'WATCHER' });
    project = service.getProject(project.id);
    assert.equal(result.event.changes.length, 1);
    assert.equal(result.event.changes[0].changeType, 'RENAMED');
    assert.equal(result.event.changes[0].pathBefore, 'analysis/model.py');
    assert.equal(result.event.changes[0].pathAfter, 'analysis/de_analysis.py');
  });

  await suite.test('concurrent parent mismatch is flagged before an AI proposal overwrites work', () => {
    const proposal = service.proposeAgentEdit(project.id, {
      path: 'README.md', request: 'Conflicting proposal', content: '# Results\nAgent replacement\n',
      baseSnapshotId: project.currentSnapshotId, agent, initiatedBy: maya,
    });
    fs.appendFileSync(path.join(projectRoot, 'README.md'), '\nConcurrent collaborator note.\n');
    service.capture(project.id, alex, { expectedSnapshotId: project.currentSnapshotId, source: 'COLLABORATOR_SYNC' });
    project = service.getProject(project.id);
    assert.throws(() => service.approveAgentEdit(proposal.id), (error) => error.status === 409);
    assert.match(fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8'), /Concurrent collaborator note/);
    assert.equal(service.getExecution(proposal.id).status, 'CONFLICT');
  });

  await suite.test('I — restart preserves snapshots, identities, diffs, and provenance', async () => {
    const eventCount = service.listEvents(project.id).length;
    await application.close();
    application = createApplication({ dataDir, watchProjects: false });
    service = application.timeline;
    const reopened = service.getProject(project.id);
    assert.equal(reopened.currentVersion, project.currentVersion);
    assert.equal(service.listEvents(project.id).length, eventCount);
    const file = service.snapshotFile(aiSnapshot.id, 'README.md');
    const preview = buildPreview(aiSnapshot, file, service.blobs.get(file.contentHash));
    const item = preview.items.find((candidate) => candidate.text.includes('reduced IL-6'));
    const result = application.rfi.request(project.id, { snapshotId: aiSnapshot.id, path: 'README.md', anchor: item.anchor });
    assert.equal(result.provenance[0].to.path, 'results/de_model.csv');
  });

  await application.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
});
