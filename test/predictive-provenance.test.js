import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { anchorForSpan, detectClaimSpans } from '../src/dependencies/service.js';
import { diffInternals } from '../src/history/diff.js';

const maya = { id: 'human:maya', displayName: 'Maya Chen', actorType: 'HUMAN_SELF' };
const alex = { id: 'human:alex', displayName: 'Alex Rivera', actorType: 'HUMAN_COLLABORATOR' };
const agent = { id: 'agent:writer', displayName: 'CoLab Writing Agent', actorType: 'AI_AGENT' };

function manuscriptAnchor(content, text) {
  const blocks = diffInternals.markdownBlocks(content);
  const blockIndex = blocks.findIndex((block) => block.text.includes(text));
  assert.notEqual(blockIndex, -1, `Expected a Markdown block containing ${text}`);
  const block = blocks[blockIndex];
  const claim = detectClaimSpans(block.text).find((item) => item.text === text)
    ?? detectClaimSpans(block.text).find((item) => item.text.includes(text) || text.includes(item.text));
  assert.ok(claim, `Expected a detected claim for ${text}`);
  return {
    claim,
    anchor: anchorForSpan(blockIndex, block.type, block.text, claim.start, claim.end),
  };
}

test('predictive provenance editor acceptance workflows', async (suite) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'colab-predictive-test-'));
  const projectRoot = path.join(sandbox, 'IGFStudy');
  const dataDir = path.join(sandbox, 'history');
  fs.mkdirSync(path.join(projectRoot, 'manuscript'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'results'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'analysis'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'references'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });

  const manuscriptPath = path.join(projectRoot, 'manuscript', 'results.md');
  const resultPath = path.join(projectRoot, 'results', 'igf18_summary.csv');
  const manuscript = '# Results\n\nIGF-18 levels decreased by 16%.\n';
  const introduction = '# Introduction\n\nPrior studies reported IGF-18 recovery effects.\n\nAn unsupported marker increased by 77%.\n';
  fs.writeFileSync(manuscriptPath, manuscript);
  fs.writeFileSync(path.join(projectRoot, 'manuscript', 'introduction.md'), introduction);
  fs.writeFileSync(resultPath, 'marker,effect_change\nIGF-18,-16%\n\n');
  fs.writeFileSync(path.join(projectRoot, 'results', 'control_summary.csv'), 'marker,effect_change\nControl,-16%\n');
  fs.writeFileSync(path.join(projectRoot, 'analysis', 'igf18_model.py'), 'method = "mixed-effects model"\n');
  fs.writeFileSync(path.join(projectRoot, 'analysis', 'run_2026_08_17_1021.json'), '{"status":"complete","model":"igf18_model"}\n');
  fs.writeFileSync(path.join(projectRoot, 'data', 'dataset_v13.csv'), 'patient_id,group\nP001,treatment\n');
  fs.writeFileSync(path.join(projectRoot, 'references', 'library.bib'), `@article{smith2024,
  title={IGF-18 signaling in recovery},
  author={Smith, Jordan and Chen, Maya},
  year={2024},
  doi={10.1000/igf18},
  pmid={12345678}
}\n`);

  let application = createApplication({ dataDir, watchProjects: false });
  let project = application.timeline.importProject(projectRoot, maya, { watch: false }).project;
  let dependencyId;

  await suite.test('A — deterministic prediction ranks the matching object and preserves alternatives', () => {
    const result = application.dependencies.predict(project.id, {
      text: 'IGF-18 levels decreased by 16%.',
      cursor: 31,
    });
    assert.equal(result.deterministic, true);
    assert.equal(result.generatedText, false);
    assert.ok(result.claims.length > 0);
    assert.equal(result.claims[0].candidates[0].path, 'results/igf18_summary.csv');
    assert.equal(result.claims[0].candidates[0].valueText, '-16%');
    assert.ok(result.claims[0].candidates.some((candidate) => candidate.path === 'results/control_summary.csv'));
  });

  await suite.test('B — an accepted suggestion creates a canonical, versioned dependency', () => {
    const prediction = application.dependencies.predict(project.id, {
      text: 'IGF-18 levels decreased by 16%.',
      cursor: 31,
    }).claims[0];
    const selected = prediction.candidates[0];
    application.timeline.addProvenanceLink(project.id, {
      fromSnapshotId: selected.snapshotId,
      fromPath: selected.path,
      relation: 'GENERATED_BY',
      toSnapshotId: selected.snapshotId,
      toPath: 'analysis/run_2026_08_17_1021.json',
      metadata: { run: 'run_2026_08_17_1021' },
    });
    application.timeline.addProvenanceLink(project.id, {
      fromSnapshotId: selected.snapshotId,
      fromPath: 'analysis/run_2026_08_17_1021.json',
      relation: 'USED',
      toSnapshotId: selected.snapshotId,
      toPath: 'analysis/igf18_model.py',
      metadata: { symbol: 'method' },
    });
    application.timeline.addProvenanceLink(project.id, {
      fromSnapshotId: selected.snapshotId,
      fromPath: 'analysis/run_2026_08_17_1021.json',
      relation: 'USES_DATASET',
      toSnapshotId: selected.snapshotId,
      toPath: 'data/dataset_v13.csv',
      metadata: { dataset: 'dataset_v13' },
    });
    const located = manuscriptAnchor(manuscript, prediction.text);
    const linked = application.dependencies.link(project.id, {
      documentPath: 'manuscript/results.md',
      anchor: located.anchor,
      spanText: located.claim.text,
      sourceObjectId: selected.id,
      sourceSnapshotId: selected.snapshotId,
      selectionMethod: 'PREDICTED_ACCEPTED',
      confidence: selected.score,
      expectedSnapshotId: project.currentSnapshotId,
    }, maya);
    project = application.timeline.getProject(project.id);
    dependencyId = linked.dependency.id;
    assert.equal(linked.dependency.status, 'LINKED');
    assert.equal(linked.dependency.selectionMethod, 'PREDICTED_ACCEPTED');
    assert.equal(linked.dependency.source.path, 'results/igf18_summary.csv');
    assert.equal(linked.event.source, 'DEPENDENCY_LINKED');
    assert.equal(linked.event.dependencyChanges[0].changeType, 'DEPENDENCY_LINKED');
    assert.equal(fs.readFileSync(manuscriptPath, 'utf8'), manuscript, 'metadata linking must not rewrite manuscript text');

    const audit = application.dependencies.getDocument(project.id, 'manuscript/results.md').audit;
    assert.equal(audit.summary.linked, 1);
    assert.equal(audit.summary.unlinked, 0);
  });

  await suite.test('C — RFI traverses the accepted dependency as first-class provenance', () => {
    const dependency = application.dependencies.getDependency(dependencyId);
    const result = application.rfi.request(project.id, {
      path: dependency.documentPath,
      snapshotId: project.currentSnapshotId,
      anchor: dependency.anchor,
    });
    assert.equal(result.dependencyStatus, 'LINKED');
    assert.equal(result.linkedDependency.id, dependencyId);
    assert.equal(result.provenanceEstablished, true);
    assert.equal(result.provenance[0].relation, 'DEPENDS_ON');
    assert.equal(result.provenance[0].to.path, 'results/igf18_summary.csv');
    assert.deepEqual(new Set(result.provenance.map((link) => link.relation)), new Set([
      'DEPENDS_ON', 'GENERATED_BY', 'USED', 'USES_DATASET',
    ]));
  });

  await suite.test('D — collaborator edits migrate the stable span anchor without losing attribution', () => {
    const revised = '# Results\n\nAfter quality control, IGF-18 levels decreased by 16%.\n';
    fs.writeFileSync(manuscriptPath, revised);
    const capture = application.timeline.capture(project.id, alex, {
      expectedSnapshotId: project.currentSnapshotId,
      source: 'COLLABORATOR_SYNC',
    });
    project = application.timeline.getProject(project.id);
    const dependency = application.dependencies.getDependency(dependencyId);
    assert.equal(capture.event.actor.displayName, 'Alex Rivera');
    assert.equal(dependency.status, 'LINKED');
    assert.ok(dependency.anchor.start > 0);
    const migrationEvent = application.timeline.listEvents(project.id)
      .find((event) => event.dependencyCount > 0 && event.id !== capture.event.id);
    assert.ok(migrationEvent);
    assert.equal(application.timeline.getEvent(migrationEvent.id).dependencyChanges[0].changeType, 'DEPENDENCY_CHANGED');
  });

  await suite.test('E — a changed source marks the link stale and creates a timeline event', () => {
    fs.writeFileSync(resultPath, 'marker,effect_change\nIGF-18,-12%\n');
    const capture = application.timeline.capture(project.id, maya, {
      expectedSnapshotId: project.currentSnapshotId,
      source: 'WATCHER',
    });
    project = application.timeline.getProject(project.id);
    const dependency = application.dependencies.getDependency(dependencyId);
    assert.equal(capture.changed, true);
    assert.equal(dependency.status, 'STALE');
    assert.equal(dependency.statusDetails.linkedSourceValue, '-16%');
    assert.equal(dependency.statusDetails.currentSourceValue, '-12%');
    assert.equal(dependency.linkedBy.displayName, 'Maya Chen');
    assert.equal(dependency.createdBy.actorType, 'SYSTEM');
    const event = application.timeline.listEvents(project.id).find((item) => item.source === 'DEPENDENCY_STALE');
    assert.ok(event);
    assert.equal(application.timeline.getEvent(event.id).dependencyChanges[0].changeType, 'DEPENDENCY_STALE');
    assert.match(fs.readFileSync(manuscriptPath, 'utf8'), /decreased by 16%/, 'staleness must not silently rewrite the claim');
    const versionBeforeAudit = application.timeline.getProject(project.id).currentVersion;
    application.dependencies.getDocument(project.id, 'manuscript/results.md');
    application.dependencies.getDocument(project.id, 'manuscript/results.md');
    assert.equal(application.timeline.getProject(project.id).currentVersion, versionBeforeAudit, 'reading a stale manuscript must not create timeline events');
  });

  await suite.test('F — manual review can pin the historical source version', () => {
    const reviewed = application.dependencies.revise(dependencyId, maya, {
      action: 'KEEP_HISTORICAL',
      expectedSnapshotId: project.currentSnapshotId,
    });
    project = application.timeline.getProject(project.id);
    assert.equal(reviewed.dependency.status, 'LINKED');
    assert.equal(reviewed.dependency.statusDetails.pinnedHistoricalVersion, true);
    assert.equal(reviewed.event.dependencyChanges[0].changeType, 'DEPENDENCY_REVIEWED');
  });

  await suite.test('G — methods and literature retrieve typed scientific objects', () => {
    const method = application.dependencies.predict(project.id, {
      text: 'We used a mixed-effects model.', cursor: 27,
    }).claims[0];
    assert.ok(method.candidates.some((candidate) => candidate.objectType === 'METHOD'));
    const literature = application.dependencies.predict(project.id, {
      text: 'Prior studies reported IGF-18 recovery effects.', cursor: 45,
    }).claims[0];
    assert.equal(literature.type, 'LITERATURE');
    const reference = literature.candidates.find((candidate) => candidate.objectType === 'REFERENCE');
    assert.ok(reference);
    const located = manuscriptAnchor(introduction, literature.text);
    const linked = application.dependencies.link(project.id, {
      documentPath: 'manuscript/introduction.md',
      anchor: located.anchor,
      spanText: located.claim.text,
      sourceObjectId: reference.id,
      sourceSnapshotId: reference.snapshotId,
      selectionMethod: 'MANUAL',
      expectedSnapshotId: project.currentSnapshotId,
    }, maya);
    project = application.timeline.getProject(project.id);
    assert.equal(linked.dependency.source.objectType, 'REFERENCE');
    assert.equal(linked.dependency.selectionMethod, 'MANUAL');
    const literatureRfi = application.rfi.request(project.id, {
      path: 'manuscript/introduction.md', snapshotId: project.currentSnapshotId, anchor: linked.dependency.anchor,
    });
    assert.equal(literatureRfi.linkedDependency.source.metadata.pmid, '12345678');
    assert.equal(literatureRfi.provenance[0].relation, 'DEPENDS_ON');

    const unsupportedPrediction = application.dependencies.predict(project.id, {
      text: 'An unsupported marker increased by 77%.', cursor: 39,
    }).claims[0];
    assert.equal(unsupportedPrediction.candidates.length, 0);
    const unsupported = manuscriptAnchor(introduction, unsupportedPrediction.text);
    const unsupportedRfi = application.rfi.request(project.id, {
      path: 'manuscript/introduction.md', snapshotId: project.currentSnapshotId, anchor: unsupported.anchor,
    });
    assert.equal(unsupportedRfi.dependencyStatus, 'UNLINKED');
    assert.equal(unsupportedRfi.dependencyMessage, 'No dependency linked');
    assert.equal(unsupportedRfi.provenanceEstablished, false);
  });

  await suite.test('H — AI-authored factual text proposes and records structured dependencies', () => {
    const currentText = fs.readFileSync(manuscriptPath, 'utf8');
    const proposedText = `${currentText.trim()}\n\nThe updated IGF-18 estimate decreased by 12%.\n`;
    const proposal = application.timeline.proposeAgentEdit(project.id, {
      path: 'manuscript/results.md',
      request: 'Add the updated estimate.',
      content: proposedText,
      baseSnapshotId: project.currentSnapshotId,
      agent,
      initiatedBy: maya,
    });
    assert.ok(proposal.proposal.dependencyProposals.length > 0);
    assert.ok(proposal.proposal.dependencyProposals.some((item) => item.verified));
    const approved = application.timeline.approveAgentEdit(proposal.id);
    project = application.timeline.getProject(project.id);
    assert.ok(approved.dependencyLinks.length > 0);
    const aiDependency = approved.dependencyLinks.at(-1).dependency;
    assert.equal(aiDependency.selectionMethod, 'SYSTEM_LINKED');
    assert.equal(aiDependency.createdBy.actorType, 'AI_AGENT');
    assert.equal(approved.event.actor.actorType, 'AI_AGENT');
    assert.equal(approved.event.initiatedBy.displayName, 'Maya Chen');
  });

  await suite.test('I — dependencies and RFI survive application restart', async () => {
    const eventCount = application.timeline.listEvents(project.id).length;
    await application.close();
    application = createApplication({ dataDir, watchProjects: false });
    project = application.timeline.getProject(project.id);
    const dependency = application.dependencies.getDependency(dependencyId);
    assert.equal(dependency.status, 'LINKED');
    assert.equal(application.timeline.listEvents(project.id).length, eventCount);
    const result = application.rfi.request(project.id, {
      path: dependency.documentPath,
      snapshotId: project.currentSnapshotId,
      anchor: dependency.anchor,
    });
    assert.equal(result.linkedDependency.id, dependencyId);
    assert.equal(result.provenance[0].relation, 'DEPENDS_ON');
  });

  await application.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
});
