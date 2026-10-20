import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { anchorForSpan } from '../src/dependencies/service.js';
import { originalFindingSentence } from '../src/dependencies/completion.js';

const writer = { id: 'human:writer', displayName: 'Writer', actorType: 'HUMAN_SELF' };
const original = 'Researchers found that of the 179 metabolites that were different in FGR cases, 176 of these were found in lower concentrations in FGR placentas.';
const clause = 'of the 179 metabolites that differed in FGR cases, 176 were present at lower concentrations in FGR placentas.';

function textPdf(text) {
  const escaped = text.replace(/[\\()]/g, character => `\\${character}`);
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Author (Test Researcher) /Title (Placental findings) /Subject (Research article, 2024) >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets[index + 1] = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

test('finding context matches only an exact deterministic source clause', () => {
  assert.equal(originalFindingSentence(original, clause), original);
  assert.equal(originalFindingSentence(original, clause.replace('176', '175')), null);
  assert.equal(originalFindingSentence(original, 'unrelated claim about the same metabolites'), null);
});

test('an accepted rewritten PDF finding previews its original sentence from the pinned version', async t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-pdf-finding-context-'));
  const root = path.join(sandbox, 'Study');
  fs.mkdirSync(root);
  const background = 'BACKGROUND_MARKER. ' + 'The introductory section describes laboratory collection and the general study design. '.repeat(18);
  const sourcePath = path.join(root, 'findings.pdf');
  fs.writeFileSync(sourcePath, textPdf(`${background}${original} Additional context describes the original cohort.`));
  fs.writeFileSync(path.join(root, 'draft.md'), '# Draft\n');
  const application = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => { await application.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const project = application.timeline.importProject(root, writer, { watch: false }).project;
  const paper = application.dependencies.objectsAt(project.id, project.currentSnapshotId)
    .find(object => object.objectType === 'PAPER' && object.path === 'findings.pdf');
  assert.ok(paper);
  const citation = 'Researcher (2024)';
  const prompt = `${citation} found that`;
  const prediction = application.dependencies.predict(project.id, {
    text: prompt, cursor: prompt.length, blockIndex: 1, documentPath: 'draft.md',
    pendingDependencies: [{ blockIndex: 1, start: 0, end: citation.length,
      sourceObjectId: paper.id, sourceSnapshotId: paper.snapshotId }],
  });
  const finding = prediction.sourceCompletions.find(item => item.replacementText === clause);
  assert.ok(finding, 'the suggestion must come from the actual indexed PDF');
  assert.equal(finding.sourceSentence, original);
  assert.equal(finding.generated, false);
  assert.equal(finding.dependencyCandidate.metadata.componentType, 'PDF_EXCERPT');
  assert.equal(finding.dependencyCandidate.anchor.pageNumber, 1);
  assert.equal(finding.dependencyCandidate.metadata.rawText, original);
  assert.ok(!paper.metadata.textExcerpt.includes(clause), 'the accepted clause is not a literal PDF substring');
  const completed = `${prompt} ${finding.replacementText}`;
  application.dependencies.saveDocument(project.id, {
    path: 'draft.md', content: `# Draft\n\n${completed}\n`, baseSnapshotId: project.currentSnapshotId,
  }, writer);
  const document = application.dependencies.getDocument(project.id, 'draft.md');
  const blockIndex = document.blocks.findIndex(block => block.text === completed);
  const linked = application.dependencies.link(project.id, {
    documentPath: 'draft.md',
    anchor: anchorForSpan(blockIndex, document.blocks[blockIndex].type, completed, prompt.length + 1, completed.length),
    spanText: finding.replacementText, sourceObjectId: finding.dependencyCandidate.id, sourceSnapshotId: paper.snapshotId,
    selectionMethod: 'AUTOCOMPLETE', expectedSnapshotId: document.snapshotId,
  }, writer);
  const preview = application.dependencies.dependencyPreview(linked.dependency.id, { contextRadius: 0 });
  assert.equal(preview.content.kind, 'text-context');
  assert.equal(preview.content.sourceSentence, original);
  assert.ok(preview.content.text.includes(original));
  assert.ok(!preview.content.text.includes('BACKGROUND_MARKER'), 'context must surround the finding rather than the paper title');
  assert.equal(preview.content.citedText, clause, 'the writer keeps the accepted grammatical wording');

  fs.writeFileSync(sourcePath, textPdf('The latest article now reports a completely different finding.'));
  application.timeline.capture(project.id, writer);
  const preserved = application.dependencies.dependencyPreview(linked.dependency.id, { contextRadius: 0 });
  assert.equal(preserved.content.sourceSentence, original);
  assert.ok(preserved.content.text.includes(original), 'preview must use the linked historical source, not the changed PDF');
  const direct = application.dependencies.sharedSourceContent({ ...linked.dependency, spanText: original }, 'CONTEXT', 0);
  assert.ok(direct.text.includes(original), 'literal quotations retain their direct context lookup');
});
