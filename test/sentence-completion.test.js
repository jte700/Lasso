import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { buildSentenceCorpus, completeFromLinkedSource, completeSentence } from '../src/dependencies/completion.js';
import { anchorForSpan } from '../src/dependencies/service.js';

const researcher = { id: 'human:writer', displayName: 'Writer', actorType: 'HUMAN_SELF' };

test('identical passages retain distinct citable works in a shared bibliography', () => {
  const sentence = 'Researchers found that folate levels were higher in the supplemented group.';
  const works = ['paper:a', 'paper:b'].map((id) => ({
    path: 'references.bib', snapshotId: 'v1', text: `${sentence} ${sentence}`,
    dependencyCandidate: { id, objectType: 'REFERENCE', metadata: {} },
  }));
  const corpus = buildSentenceCorpus(works);
  assert.equal(corpus.length, 2);
  for (const work of works) {
    const findings = completeFromLinkedSource(corpus, { text: 'The authors found that' }, work.dependencyCandidate);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].dependencyCandidate.id, work.dependencyCandidate.id);
  }
});

test('sentence completion finishes an exact project-corpus sentence without creating a dependency', () => {
  const corpus = buildSentenceCorpus([{
    path: 'notes/interface.md', snapshotId: 'v1',
    text: 'The interface is optimized for desktop and tablet use.',
  }]);
  const completion = completeSentence(corpus, { text: 'The interface is', cursor: 16, documentPath: 'draft.md' });
  assert.equal(completion.insertText, ' optimized for desktop and tablet use.');
  assert.equal(completion.matchKind, 'PREFIX');
  assert.equal(completion.generated, false);
});

test('sentence completion uses scientific concept equivalents instead of literal word overlap', () => {
  const corpus = buildSentenceCorpus([{
    path: 'notes/analysis.md', snapshotId: 'v1',
    text: 'The analysis showed that placental folate levels were higher in the supplemented group.',
  }]);
  const completion = completeSentence(corpus, {
    text: 'The results indicate that placental', cursor: 35, documentPath: 'draft.md',
  });
  assert.equal(completion.insertText, ' folate levels were higher in the supplemented group.');
  assert.equal(completion.matchKind, 'SEMANTIC_SEQUENCE');
  assert.equal(completion.sourceSentence, 'The analysis showed that placental folate levels were higher in the supplemented group.');
});

test('linked-paper findings prefer grammatical narrative clauses over flattened PDF table rows', () => {
  const source = {
    id: 'paper:mohammad', objectType: 'PAPER', label: 'Mohammad et al., 2021',
    path: 'papers/mohammad.pdf', snapshotId: 'v1', metadata: { title: 'Placental metabolomics' },
  };
  const corpus = buildSentenceCorpus([{
    path: source.path, snapshotId: source.snapshotId, dependencyCandidate: source,
    text: [
      'Untargeted UPLC-MS 574 metabolites showed significant difference between SGA and uncomplicated pregnancies.',
      'Researchers found that of the 179 metabolites that were different in FGR cases, 176 of these were found in lower concentrations in FGR placentas.',
      'Moreover, compared to uncomplicated term pregnancies, preeclamptic placental tissue showed significant alterations in 86 metabolites.',
    ].join(' '),
  }]);
  const citation = 'The paper by Mohammad et al. (2021)';
  const text = `${citation} found that`;
  const findings = completeFromLinkedSource(corpus, { text, cursor: text.length }, source, {
    sourceEnd: citation.length,
  });
  assert.equal(findings.length, 2);
  assert.ok(findings.every((finding) => !finding.replacementText.startsWith('untargeted')));
  assert.ok(findings.every((finding) => !finding.replacementText.startsWith('researchers found that')));
  assert.ok(findings.some((finding) => finding.replacementText.includes('metabolites that differed in FGR cases')));
  assert.ok(findings.some((finding) => finding.replacementText.includes('176 were present at lower concentrations')));
  assert.ok(findings.some((finding) => finding.replacementText.startsWith('compared to uncomplicated term pregnancies')));
});

test('the prediction API binds sentence completion to a canonical dependency source', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-sentence-completion-test-'));
  const root = path.join(sandbox, 'SentenceStudy');
  fs.mkdirSync(path.join(root, 'manuscript'), { recursive: true });
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'manuscript', 'draft.md'), '# Draft\n');
  fs.writeFileSync(path.join(root, 'notes', 'interpretation.md'),
    'The analysis showed that placental folate levels were higher in the supplemented group.\n');
  const application = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  const project = application.timeline.importProject(root, researcher, { watch: false }).project;
  const prediction = application.dependencies.predict(project.id, {
    text: 'The results indicate that placental', cursor: 35, documentPath: 'manuscript/draft.md',
  });
  assert.equal(prediction.claims.length, 0);
  assert.equal(prediction.completion.insertText, ' folate levels were higher in the supplemented group.');
  assert.equal(prediction.completion.source.path, 'notes/interpretation.md');
  assert.equal(prediction.completion.source.objectType, 'DOCUMENT');
  assert.equal(prediction.completion.dependencyCandidate.path, 'notes/interpretation.md');
  assert.equal(prediction.completion.dependencyCandidate.objectType, 'DOCUMENT');
  assert.ok(prediction.completion.dependencyCandidate.id);

  const completedSentence = `The results indicate that placental${prediction.completion.insertText}`;
  application.dependencies.saveDocument(project.id, {
    path: 'manuscript/draft.md', content: `# Draft\n\n${completedSentence}\n`,
    baseSnapshotId: project.currentSnapshotId,
  }, researcher);
  const savedProject = application.timeline.getProject(project.id);
  const savedDocument = application.dependencies.getDocument(project.id, 'manuscript/draft.md');
  const blockIndex = savedDocument.blocks.findIndex((block) => block.text === completedSentence);
  assert.notEqual(blockIndex, -1);

  const linked = application.dependencies.link(project.id, {
    documentPath: 'manuscript/draft.md',
    anchor: anchorForSpan(blockIndex, savedDocument.blocks[blockIndex].type, completedSentence, 0, completedSentence.length),
    spanText: completedSentence,
    sourceObjectId: prediction.completion.dependencyCandidate.id,
    sourceSnapshotId: prediction.completion.dependencyCandidate.snapshotId,
    selectionMethod: 'AUTOCOMPLETE',
    expectedSnapshotId: savedProject.currentSnapshotId,
  }, researcher);
  assert.equal(linked.dependency.spanText, completedSentence);
  assert.equal(linked.dependency.source.path, 'notes/interpretation.md');
  assert.equal(linked.dependency.selectionMethod, 'AUTOCOMPLETE');
  await application.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
});
