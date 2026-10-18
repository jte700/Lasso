import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

const actor = { id: 'human:lookup-test', displayName: 'Lookup test', actorType: 'HUMAN_SELF' };

function textPdf(text, author, title) {
  const escaped = text.replace(/[\\()]/g, (character) => `\\${character}`);
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Author (${author}) /Title (${title}) >>`,
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

async function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-lookup-'));
  const make = (name, files) => {
    const root = path.join(temporary, name);
    fs.mkdirSync(root);
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(root, file), content);
    return fs.realpathSync(root);
  };
  const roots = [
    make('Finance', { 'Cash.csv': 'Item,Amount\nCapital purchases,8000\nOffice supplies,400\n' }),
    make('Legal', {
      'Clause-Review.txt': 'Clause review for LC-26-008.\n\nSection 9: liability cap CAD 50,000, except fraud. '
        + 'Section 8: confidentiality survives 24 months after termination.\n\nIssue the permit package on 2026-11-06.\n',
      'Agreement.pdf': textPdf('The contractual liability cap is CAD 50,000.', 'Lasso fictional test fixtures', 'Orchard services agreement'),
      'Paper.pdf': textPdf('Findings were consistent.', 'Jane van der Berg', 'Placental findings'),
    }),
    make('Notes', { 'Diary.txt': 'Roof crew arrived at 07:30.\n' }),
  ];
  const app = createApplication({ dataDir: path.join(temporary, 'history'), watchProjects: false });
  await app.workspace.add(roots, actor);
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  return app;
}

const quotes = (answer) => answer.blocks.filter((block) => block.text?.startsWith('“')).map((block) => block.text);

test('a workspace lookup leads with the directory that answers it', async (t) => {
  const app = await fixture(t);
  const answer = app.workspace.terminalRun('ask What is the liability cap?', actor);
  assert.equal(answer.headline, 'Found in 2 indexed passages');
  assert.match(answer.subhead, /^Legal · /);
  assert.deepEqual(quotes(answer), [
    '“Section 9: liability cap CAD 50,000, except fraud.”',
    '“The contractual liability cap is CAD 50,000.”',
  ]);
  assert.ok(answer.blocks.some((block) => block.text === 'No result in the other 2 work directories.'));
  assert.ok(!answer.blocks.some((block) => /Not answerable/.test(block.text ?? '')));
  assert.equal(answer.data.projects.length, 3);
});

test('find matches whole words, so a query term does not match inside longer words', async (t) => {
  const app = await fixture(t);
  const found = app.workspace.terminalRun('find liability cap', actor);
  assert.ok(found.results.length >= 2);
  // Passages and their documents qualify; the unrelated "Capital purchases" row does not.
  assert.ok(found.results.every((item) => /liability cap|Orchard services agreement/i.test(String(item.value))),
    JSON.stringify(found.results.map((item) => item.value)));
  // Each passage appears once, although a one-sentence paragraph is indexed twice.
  const values = found.results.map((item) => `${item.ref.path}|${item.value}`);
  assert.equal(new Set(values).size, values.length);
});

test('questions outside the fixed forms quote only passages containing every content word', async (t) => {
  const app = await fixture(t);
  assert.deepEqual(quotes(app.workspace.terminalRun('ask When is the permit package due?', actor)),
    ['“Issue the permit package on 2026-11-06.”']);
  assert.deepEqual(quotes(app.workspace.terminalRun('ask When does confidentiality end?', actor)),
    ['“Section 8: confidentiality survives 24 months after termination.”']);
  const unsupported = app.workspace.terminalRun('ask What is the court filing deadline?', actor);
  assert.deepEqual(quotes(unsupported), []);
  assert.equal(unsupported.blocks.filter((block) => block.text === 'Not answerable from indexed sources').length, 3);
});

test('organisation authors do not become surnames in labels or citations', async (t) => {
  const app = await fixture(t);
  const legal = app.workspace.state().directories.find((directory) => directory.name === 'Legal');
  const labels = app.dependencies.objectsAt(legal.id)
    .filter((object) => ['PAPER', 'DOCUMENT'].includes(object.objectType) && !object.metadata.componentType)
    .map((object) => object.label).sort();
  assert.ok(labels.includes('Orchard services agreement'), labels.join(', '));
  assert.ok(labels.includes('Berg'), labels.join(', '));
  assert.ok(!labels.includes('fixtures'));
});
