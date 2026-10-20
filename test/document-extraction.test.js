import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { extractDocxDocument, extractPdfDocument, extractSpreadsheetTables } from '../src/dependencies/document-extraction.js';
import { buildSharePreview } from '../src/sharing/share-preview.js';
import { anchorForSpan } from '../src/dependencies/service.js';

const researcher = { id: 'human:researcher', displayName: 'Researcher', actorType: 'HUMAN_SELF' };

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBuffer);
    localOffset += local.length + nameBuffer.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

const opaquePdf = Buffer.from(`%PDF-1.7
1 0 obj
<< /Author (S. Mohammad and J. Bhattacharjee) /Title (Metabolomics to understand placental biology: Where are we now?) /Subject (Tissue and Cell 73, 2021. doi:10.1016/j.tice.2021.101663. Placental amino acid levels were 1.8-fold higher in supplemented pregnancies. Hydroxyproline was significantly associated with placental tissue metabolism.) /CreationDate (D:20211122) >>
endobj
%%EOF
`);

const sampleDocx = storedZip({
  'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Placental transcriptomics review</w:t></w:r></w:p><w:p><w:r><w:t>O'Connor et al. summarize the cohort.</w:t></w:r></w:p></w:body></w:document>`,
  'docProps/core.xml': `<?xml version="1.0"?><cp:coreProperties xmlns:cp="cp" xmlns:dc="dc" xmlns:dcterms="dcterms"><dc:title>Placental transcriptomics review</dc:title><dc:creator>Elena O'Connor</dc:creator><dc:subject>Review article, 2023</dc:subject><cp:keywords>placenta; transcriptomics</cp:keywords><dcterms:created>2023-03-01</dcterms:created></cp:coreProperties>`,
});

const sampleXlsx = storedZip({
  'xl/workbook.xml': `<?xml version="1.0"?><workbook><sheets><sheet name="Data Dictionary" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/sharedStrings.xml': `<?xml version="1.0"?><sst><si><t>variable</t></si><si><t>description</t></si><si><t>plac_wt</t></si><si><t>Placental weight after delivery</t></si></sst>`,
  'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row></sheetData></worksheet>`,
});

function biffRecord(id, data = Buffer.alloc(0)) {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
}

function biffBof(type) {
  const data = Buffer.alloc(16);
  data.writeUInt16LE(0x0600, 0);
  data.writeUInt16LE(type, 2);
  return biffRecord(0x0809, data);
}

function biffSst(strings) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(strings.length, 0);
  header.writeUInt32LE(strings.length, 4);
  const values = strings.map((value) => {
    const text = Buffer.from(value, 'latin1');
    const stringHeader = Buffer.alloc(3);
    stringHeader.writeUInt16LE(value.length, 0);
    return Buffer.concat([stringHeader, text]);
  });
  return biffRecord(0x00fc, Buffer.concat([header, ...values]));
}

function biffLabelSst(row, column, stringIndex) {
  const data = Buffer.alloc(10);
  data.writeUInt16LE(row, 0);
  data.writeUInt16LE(column, 2);
  data.writeUInt32LE(stringIndex, 6);
  return biffRecord(0x00fd, data);
}

function biffNumber(row, column, value) {
  const data = Buffer.alloc(14);
  data.writeUInt16LE(row, 0);
  data.writeUInt16LE(column, 2);
  data.writeDoubleLE(value, 6);
  return biffRecord(0x0203, data);
}

function sampleLegacyXls(headerRow = 0, dataRow = 1) {
  const strings = ['Account', 'Current Period', 'Prior Period', 'Payroll Taxes and Benefits-Direct'];
  const sheet = Buffer.concat([
    biffBof(0x0010),
    biffLabelSst(headerRow, 0, 0), biffLabelSst(headerRow, 1, 1), biffLabelSst(headerRow, 2, 2),
    biffLabelSst(dataRow, 0, 3), biffNumber(dataRow, 1, 225), biffNumber(dataRow, 2, 215),
    biffRecord(0x000a),
  ]);
  const sheetName = Buffer.from('Accounting', 'latin1');
  const boundData = Buffer.alloc(8 + sheetName.length);
  boundData[6] = sheetName.length;
  sheetName.copy(boundData, 8);
  const globalsWithoutOffset = [biffBof(0x0005), biffSst(strings), biffRecord(0x0085, boundData), biffRecord(0x000a)];
  boundData.writeUInt32LE(globalsWithoutOffset.reduce((total, part) => total + part.length, 0), 0);
  const workbook = Buffer.concat([...globalsWithoutOffset, sheet]);
  const workbookStream = Buffer.alloc(4096);
  workbook.copy(workbookStream);

  const header = Buffer.alloc(512, 0);
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header);
  header.writeUInt16LE(0x003e, 24);
  header.writeUInt16LE(3, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(1, 44);
  header.writeUInt32LE(0, 48);
  header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(0xfffffffe, 60);
  header.writeUInt32LE(0, 64);
  header.writeUInt32LE(0xfffffffe, 68);
  header.writeUInt32LE(0, 72);
  for (let index = 0; index < 109; index += 1) header.writeUInt32LE(0xffffffff, 76 + index * 4);
  header.writeUInt32LE(9, 76);

  const directory = Buffer.alloc(512);
  const writeDirectoryEntry = (offset, name, type, startSector, size) => {
    const encoded = Buffer.from(`${name}\0`, 'utf16le');
    encoded.copy(directory, offset, 0, Math.min(encoded.length, 64));
    directory.writeUInt16LE(Math.min(encoded.length, 64), offset + 64);
    directory[offset + 66] = type;
    directory.writeUInt32LE(0xffffffff, offset + 68);
    directory.writeUInt32LE(0xffffffff, offset + 72);
    directory.writeUInt32LE(0xffffffff, offset + 76);
    directory.writeUInt32LE(startSector, offset + 116);
    directory.writeBigUInt64LE(BigInt(size), offset + 120);
  };
  writeDirectoryEntry(0, 'Root Entry', 5, 0xfffffffe, 0);
  writeDirectoryEntry(128, 'Workbook', 2, 1, workbookStream.length);

  const fat = Buffer.alloc(512, 0xff);
  fat.writeUInt32LE(0xfffffffe, 0);
  for (let sector = 1; sector < 8; sector += 1) fat.writeUInt32LE(sector + 1, sector * 4);
  fat.writeUInt32LE(0xfffffffe, 8 * 4);
  fat.writeUInt32LE(0xfffffffd, 9 * 4);
  return Buffer.concat([header, directory, workbookStream, fat]);
}

function unicodeMappedPdf(sentence) {
  const characters = [...new Set(sentence)];
  const codes = new Map(characters.map((character, index) => [character, (index + 1).toString(16).padStart(4, '0')]));
  const encoded = [...sentence].map((character) => codes.get(character)).join('');
  const map = characters.map((character) => {
    const unicode = character.codePointAt(0).toString(16).padStart(4, '0');
    return `<${codes.get(character)}> <${unicode}>`;
  }).join('\n');
  return Buffer.from(`%PDF-1.7
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F0 5 0 R >> >> /Contents 4 0 R >> endobj
4 0 obj << /Length 999 >> stream
BT /F0 12 Tf <${encoded}> Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R >> endobj
6 0 obj << /Length 999 >> stream
/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
${characters.length} beginbfchar
${map}
endbfchar endcmap end end
endstream endobj
7 0 obj << /Author (Test Researcher) /Title (Placental findings) /Subject (Research article, 2024) >> endobj
%%EOF`);
}

function figurePdf() {
  const content = `q 0.15 0.45 0.85 rg 90 390 180 220 re f 0.95 0.5 0.1 rg 315 390 180 145 re f Q
BT /F1 16 Tf 72 310 Td (Figure 2. Experimental response across study groups) Tj ET
BT /F1 12 Tf 72 280 Td (Blue and orange panels are embedded in the source PDF.) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets[index + 1] = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('PDF extraction reads embedded authors, title, year, and DOI from an opaque filename', () => {
  const metadata = extractPdfDocument(opaquePdf);
  assert.equal(metadata.author, 'S. Mohammad and J. Bhattacharjee');
  assert.equal(metadata.title, 'Metabolomics to understand placental biology: Where are we now?');
  assert.equal(metadata.year, '2021');
  assert.equal(metadata.doi, '10.1016/j.tice.2021.101663');
});

test('PDF extraction decodes body text through embedded ToUnicode font maps', () => {
  const finding = 'Placental amino acid levels were significantly higher in supplemented pregnancies.';
  const metadata = extractPdfDocument(unicodeMappedPdf(finding));
  assert.equal(metadata.extraction, 'PDF_METADATA_AND_TEXT');
  assert.match(metadata.textExcerpt, /Placental amino acid levels were significantly higher/);
});

test('PDF figure dependencies render the actual cited page instead of a scalar value', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-pdf-figure-test-'));
  const root = path.join(sandbox, 'FigureProject');
  fs.mkdirSync(path.join(root, 'Readings'), { recursive: true });
  fs.writeFileSync(path.join(root, 'draft.md'), '# Findings\n\nFigure 2\n');
  fs.writeFileSync(path.join(root, 'Readings', 'study.pdf'), figurePdf());
  const application = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  try {
    const project = application.timeline.importProject(root, researcher, { watch: false }).project;
    const prediction = application.dependencies.predict(project.id, {
      text: 'Figure 2', cursor: 8, context: 'Figure 2', documentPath: 'draft.md',
    });
    const figure = prediction.claims[0].candidates[0];
    assert.equal(figure.objectType, 'FIGURE');
    assert.equal(figure.metadata.identifier, '2');
    const document = application.dependencies.getDocument(project.id, 'draft.md');
    const blockIndex = document.blocks.findIndex((block) => block.text === 'Figure 2');
    const linked = application.dependencies.link(project.id, {
      documentPath: 'draft.md',
      anchor: anchorForSpan(blockIndex, document.blocks[blockIndex].type, 'Figure 2', 0, 8),
      spanText: 'Figure 2', sourceObjectId: figure.id, sourceSnapshotId: figure.snapshotId,
      selectionMethod: 'AUTOCOMPLETE', expectedSnapshotId: project.currentSnapshotId,
    }, researcher);
    const preview = application.dependencies.dependencyPreview(linked.dependency.id);
    assert.equal(preview.content.kind, 'pdf-figure');
    assert.equal(preview.content.pageNumber, 1);
    assert.match(preview.content.caption, /Experimental response across study groups/);
    const image = application.dependencies.figurePreviewImage(linked.dependency.id);
    assert.equal(image.located, true);
    assert.equal(image.image.subarray(1, 4).toString(), 'PNG');
    const viewer = application.dependencies.dependencySourceViewer(linked.dependency.id);
    assert.equal(viewer.kind, 'pdf');
    assert.equal(viewer.pageNumber, 1);
    assert.match(viewer.fileUrl, /\/source-file$/);
    const sourceFile = application.dependencies.dependencySourceFile(linked.dependency.id);
    assert.equal(sourceFile.contentType, 'application/pdf');
    assert.equal(sourceFile.content.subarray(0, 4).toString(), '%PDF');
  } finally {
    await application.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('DOCX extraction reads OOXML metadata and visible document text', () => {
  const metadata = extractDocxDocument(sampleDocx);
  assert.equal(metadata.author, "Elena O'Connor");
  assert.equal(metadata.title, 'Placental transcriptomics review');
  assert.equal(metadata.year, '2023');
  assert.match(metadata.textExcerpt, /O'Connor et al\. summarize the cohort/);
});

test('XLSX extraction exposes worksheet rows for data-dictionary indexing', () => {
  const sheets = extractSpreadsheetTables(sampleXlsx);
  assert.deepEqual(sheets, [{
    name: 'Data Dictionary', rowNumbers: [1, 2], merges: [], tables: [],
    rows: [['variable', 'description'], ['plac_wt', 'Placental weight after delivery']],
  }]);
});

test('XLSX dates and percentages read as the sheet shows them', () => {
  // Arrange: style 1 is a custom date format, style 2 the built-in 0.00%.
  const workbook = storedZip({
    'xl/workbook.xml': '<workbook><workbookPr/><sheets><sheet name="Close" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/styles.xml': '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="mmm d, yyyy"/></numFmts>'
      + '<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>'
      + '<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="164" applyNumberFormat="1"/><xf numFmtId="10"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="inlineStr"><is><t>Closed</t></is></c><c r="B1" t="inlineStr"><is><t>Margin</t></is></c><c r="C1" t="inlineStr"><is><t>Units</t></is></c></row>'
      + '<row r="2"><c r="A2" s="1"><v>45352</v></c><c r="B2" s="2"><v>0.1534</v></c><c r="C2"><v>1200</v></c></row>'
      + '</sheetData></worksheet>',
  });

  // Act
  const [sheet] = extractSpreadsheetTables(workbook);

  // Assert
  assert.deepEqual(sheet.rows[1], ['2024-03-01', '15.34%', '1200']);
});

test('legacy XLS extraction exposes named rows and their cell values', () => {
  const sheets = extractSpreadsheetTables(sampleLegacyXls());
  assert.deepEqual(sheets, [{
    name: 'Accounting', rowNumbers: [1, 2], merges: [],
    rows: [
      ['Account', 'Current Period', 'Prior Period'],
      ['Payroll Taxes and Benefits-Direct', '225', '215'],
    ],
  }]);
});

test('legacy spreadsheet row names autocomplete in ordinary document prose', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-legacy-xls-index-test-'));
  const root = path.join(sandbox, 'Accounting');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'Income-Statement-Template.xls'), sampleLegacyXls());
  fs.writeFileSync(path.join(root, 'AccountingDoc.md'), '# Notes\n\nThe payroll taxes\n');
  const application = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  try {
    const project = application.timeline.importProject(root, researcher, { watch: false }).project;
    const text = 'The payroll taxes';
    const prediction = application.dependencies.predict(project.id, {
      text, cursor: text.length, context: text, documentPath: 'AccountingDoc.md', blockIndex: 1,
    });
    assert.equal(prediction.claims[0]?.type, 'STUDY_VARIABLE');
    assert.equal(prediction.claims[0]?.candidates[0]?.completionText, 'Payroll Taxes and Benefits-Direct');
    assert.equal(prediction.claims[0]?.candidates[0]?.metadata.row, 'Payroll Taxes and Benefits-Direct');
    assert.equal(prediction.claims[0]?.candidates[0]?.path, 'Income-Statement-Template.xls');
  } finally {
    await application.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('opaque project papers autocomplete from internal metadata with tolerant author matching', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-document-index-test-'));
  const root = path.join(sandbox, 'OpaquePapers');
  fs.mkdirSync(path.join(root, 'manuscript'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Readings'), { recursive: true });
  fs.writeFileSync(path.join(root, 'manuscript', 'draft.md'), '# Draft\n\nThe paper from Mohammed et al.,\n');
  fs.writeFileSync(path.join(root, 'Readings', '1-s2.0-S0040816621001798-main.pdf'), opaquePdf);
  fs.writeFileSync(path.join(root, 'Readings', 'review-not-named-for-author.docx'), sampleDocx);
  fs.writeFileSync(path.join(root, 'Readings', 'library.bib'), `@article{thiele2015,
  title={Systematic genome assessment of B-vitamin biosynthesis suggests co-operation among gut microbes},
  author={Thiele, Ines},
  year={2015}
}\n`);
  fs.writeFileSync(path.join(root, 'Readings', 'thiele-findings.md'), `# Thiele findings

Table 1. B-vitamin biosynthesis pathways across gut microbes.

Figure 2. Predicted nutrient cross-feeding between microbial species.
`);

  const application = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  const project = application.timeline.importProject(root, researcher, { watch: false }).project;
  const prediction = application.dependencies.predict(project.id, {
    text: 'The paper from Mohammed et al.,',
    cursor: 30,
    context: 'The paper from Mohammed et al.,',
    documentPath: 'manuscript/draft.md',
  });
  assert.equal(prediction.claims[0].type, 'LITERATURE');
  assert.equal(prediction.claims[0].candidates.length, 1);
  const paper = prediction.claims[0].candidates[0];
  assert.equal(paper.objectType, 'PAPER');
  assert.equal(paper.path, 'Readings/1-s2.0-S0040816621001798-main.pdf');
  assert.equal(paper.label, 'Mohammad et al., 2021');
  assert.equal(paper.metadata.doi, '10.1016/j.tice.2021.101663');
  assert.ok(paper.reasons.includes('similar author'));

  const progressive = application.dependencies.predict(project.id, {
    text: 'The paper by Moham',
    cursor: 18,
    context: 'The paper by Moham',
    documentPath: 'manuscript/draft.md',
  });
  assert.equal(progressive.claims[0].type, 'LITERATURE');
  assert.equal(progressive.claims[0].partial, true);
  assert.equal(progressive.claims[0].value, 'Moham');
  assert.equal(progressive.claims[0].candidates[0].path, 'Readings/1-s2.0-S0040816621001798-main.pdf');
  assert.equal(progressive.claims[0].candidates[0].citationText, 'Mohammad et al. (2021)');

  const lowercaseProgressive = application.dependencies.predict(project.id, {
    text: 'from the paper by moh',
    cursor: 'from the paper by moh'.length,
    context: 'from the paper by moh',
    documentPath: 'manuscript/draft.md',
  });
  assert.equal(lowercaseProgressive.claims[0].type, 'LITERATURE');
  assert.equal(lowercaseProgressive.claims[0].partial, true);
  assert.equal(lowercaseProgressive.claims[0].value, 'moh');
  assert.equal(lowercaseProgressive.claims[0].referenceMode, 'author');
  assert.equal(lowercaseProgressive.claims[0].candidates[0].path, 'Readings/1-s2.0-S0040816621001798-main.pdf');
  assert.equal(lowercaseProgressive.claims[0].candidates[0].citationText, 'Mohammad et al. (2021)');

  const titleProgressive = application.dependencies.predict(project.id, {
    text: 'from the document placental trans',
    cursor: 'from the document placental trans'.length,
    context: 'from the document placental trans',
    documentPath: 'manuscript/draft.md',
  });
  assert.equal(titleProgressive.claims[0].type, 'LITERATURE');
  assert.equal(titleProgressive.claims[0].referenceMode, 'any');
  assert.equal(titleProgressive.claims[0].candidates[0].path, 'Readings/review-not-named-for-author.docx');
  assert.equal(titleProgressive.claims[0].candidates[0].citationText, 'Placental transcriptomics review');

  const fileProgressive = application.dependencies.predict(project.id, {
    text: 'using the file review-not',
    cursor: 'using the file review-not'.length,
    context: 'using the file review-not',
    documentPath: 'manuscript/draft.md',
  });
  assert.equal(fileProgressive.claims[0].candidates[0].path, 'Readings/review-not-named-for-author.docx');
  assert.equal(fileProgressive.claims[0].candidates[0].citationText, 'Placental transcriptomics review');

  for (const prompt of ['The paper from Ines', 'The paper by Thie']) {
    const authorIntent = application.dependencies.predict(project.id, {
      text: prompt, cursor: prompt.length, context: prompt, documentPath: 'manuscript/draft.md',
    });
    assert.equal(authorIntent.claims[0].referenceMode, 'author');
    assert.equal(authorIntent.claims[0].candidates[0].path, 'Readings/library.bib');
    assert.equal(authorIntent.claims[0].candidates[0].citationText, 'Thiele (2015)');
    assert.notEqual(authorIntent.claims[0].candidates[0].citationText,
      'Systematic genome assessment of B-vitamin biosynthesis suggests co-operation among gut microbes');
  }

  for (const prompt of [
    "The paper's title is Systematic genome",
    'The title of the paper is Systematic genome',
    'The paper titled Systematic genome',
  ]) {
    const titleIntent = application.dependencies.predict(project.id, {
      text: prompt, cursor: prompt.length, context: prompt, documentPath: 'manuscript/draft.md',
    });
    assert.equal(titleIntent.claims[0].referenceMode, 'title');
    assert.equal(titleIntent.claims[0].candidates[0].path, 'Readings/library.bib');
    assert.equal(titleIntent.claims[0].candidates[0].citationText,
      'Systematic genome assessment of B-vitamin biosynthesis suggests co-operation among gut microbes');
  }

  const tableIntent = application.dependencies.predict(project.id, {
    text: 'Table 1 showed', cursor: 'Table 1 showed'.length,
    context: 'Table 1 showed', documentPath: 'manuscript/draft.md',
  });
  assert.equal(tableIntent.claims[0].type, 'TABLE_REFERENCE');
  assert.equal(tableIntent.claims[0].candidates[0].objectType, 'TABLE');
  assert.equal(tableIntent.claims[0].candidates[0].label, 'Table 1');
  assert.equal(tableIntent.claims[0].candidates[0].path, 'Readings/thiele-findings.md');

  const partialTableIntent = application.dependencies.predict(project.id, {
    text: 'Tab', cursor: 3, context: 'Tab', documentPath: 'manuscript/draft.md',
  });
  assert.equal(partialTableIntent.claims[0].partial, true);
  assert.equal(partialTableIntent.claims[0].candidates[0].componentText, 'Table 1');

  fs.writeFileSync(path.join(root, 'Readings', 'sebastian-findings.md'), `# Sebastian et al. (2027)

Table 1. Sebastian cohort characteristics.

Figure 2. Sebastian-specific endothelial response.
`);
  fs.writeFileSync(path.join(root, 'Readings', 'white-findings.md'), `# White et al. (2025)

Table 1. White cohort characteristics.

Figure 2. White-specific placental signaling network.
`);
  const componentCapture = application.timeline.capture(project.id, researcher);
  application.dependencies.ensureIndex(project.id, componentCapture.snapshot.id);
  const indexedObjects = application.dependencies.objectsAt(project.id, componentCapture.snapshot.id);
  const sebastianPaper = indexedObjects.find((object) => object.objectType === 'PAPER'
    && object.path === 'Readings/sebastian-findings.md');
  assert.ok(sebastianPaper);
  const scopedComponentText = 'Sebastian et al. (2027) and what I found was that in Figure 2';
  const scopedFigurePrediction = application.dependencies.predict(project.id, {
    text: scopedComponentText,
    cursor: scopedComponentText.length,
    blockIndex: 1,
    context: scopedComponentText,
    documentPath: 'manuscript/draft.md',
    pendingDependencies: [{
      id: 'pending-sebastian-citation', blockIndex: 1, start: 0, end: 'Sebastian et al. (2027)'.length,
      sourceObjectId: sebastianPaper.id, sourceSnapshotId: sebastianPaper.snapshotId,
    }],
  });
  const scopedFigure = scopedFigurePrediction.claims.find((claim) => claim.type === 'FIGURE');
  assert.ok(scopedFigure);
  assert.ok(scopedFigure.candidates.length);
  assert.ok(scopedFigure.candidates.every((candidate) => candidate.path === 'Readings/sebastian-findings.md'),
    'a figure after a linked paper must never compete with same-numbered figures from other papers');
  assert.match(scopedFigure.candidates[0].valueText, /Sebastian-specific endothelial response/);
  assert.equal(scopedFigurePrediction.sourceContext.kind, 'LINKED_SOURCE');
  assert.equal(scopedFigurePrediction.sourceContext.source.id, sebastianPaper.id);
  assert.equal(scopedFigurePrediction.sourceContext.exclusive, true);

  const completedCitation = `The paper by ${progressive.claims[0].candidates[0].citationText}`;
  application.dependencies.saveDocument(project.id, {
    path: 'manuscript/draft.md', content: `# Draft\n\n${completedCitation}\n`,
    baseSnapshotId: application.timeline.getProject(project.id).currentSnapshotId,
  }, researcher);
  const savedProject = application.timeline.getProject(project.id);
  const savedDocument = application.dependencies.getDocument(project.id, 'manuscript/draft.md');
  const blockIndex = savedDocument.blocks.findIndex((block) => block.text === completedCitation);
  const citationStart = completedCitation.indexOf('Mohammad');
  const citationEnd = completedCitation.length;
  const pendingAttributedDraft = `${completedCitation} found that`;
  const pendingSourcePrediction = application.dependencies.predict(project.id, {
    text: pendingAttributedDraft,
    cursor: pendingAttributedDraft.length,
    blockIndex,
    context: pendingAttributedDraft,
    documentPath: 'manuscript/draft.md',
    pendingDependencies: [{
      id: 'pending-citation', blockIndex, start: citationStart, end: citationEnd,
      sourceObjectId: paper.id, sourceSnapshotId: paper.snapshotId,
    }],
  });
  assert.equal(pendingSourcePrediction.sourceContext.exclusive, true,
    'a locally accepted citation must scope findings before the five-minute autosave');
  assert.equal(pendingSourcePrediction.sourceContext.source.id, paper.id);
  assert.ok(pendingSourcePrediction.sourceCompletions.length >= 2);

  const linked = application.dependencies.link(project.id, {
    documentPath: 'manuscript/draft.md',
    anchor: anchorForSpan(blockIndex, savedDocument.blocks[blockIndex].type, completedCitation, citationStart, citationEnd),
    spanText: 'Mohammad et al. (2021)',
    sourceObjectId: progressive.claims[0].candidates[0].id,
    sourceSnapshotId: progressive.claims[0].candidates[0].snapshotId,
    selectionMethod: 'AUTOCOMPLETE',
    expectedSnapshotId: savedProject.currentSnapshotId,
  }, researcher);
  assert.equal(linked.dependency.spanText, 'Mohammad et al. (2021)');
  assert.notEqual(linked.dependency.spanText, 'Moham');

  const attributedDraft = `${completedCitation}, the authors found that`;
  const sourcePrediction = application.dependencies.predict(project.id, {
    text: attributedDraft,
    cursor: attributedDraft.length,
    blockIndex,
    context: attributedDraft,
    documentPath: 'manuscript/draft.md',
  });
  assert.equal(sourcePrediction.sourceContext.exclusive, true);
  assert.equal(sourcePrediction.sourceContext.source.id, paper.id);
  assert.equal(sourcePrediction.claims.length, 0);
  assert.equal(sourcePrediction.completion, null);
  assert.ok(sourcePrediction.sourceCompletions.length >= 2);
  assert.ok(sourcePrediction.sourceCompletions.every((finding) => finding.dependencyCandidate.id === paper.id));

  const endedSourcePrediction = application.dependencies.predict(project.id, {
    text: attributedDraft,
    cursor: attributedDraft.length,
    blockIndex,
    context: attributedDraft,
    documentPath: 'manuscript/draft.md',
    sourceScopeBoundary: attributedDraft.length,
  });
  assert.equal(endedSourcePrediction.sourceContext, null,
    'ending source scope at the caret must exclude earlier linked papers');
  assert.equal(endedSourcePrediction.sourceCompletions.length, 0);

  const secondCitationPrefix = `${completedCitation}. The paper by `;
  const secondCitationText = progressive.claims[0].candidates[0].citationText;
  const secondCitationDraft = `${secondCitationPrefix}${secondCitationText} found that`;
  const secondCitationStart = secondCitationPrefix.length;
  const secondCitationEnd = secondCitationStart + secondCitationText.length;
  const newSourcePrediction = application.dependencies.predict(project.id, {
    text: secondCitationDraft,
    cursor: secondCitationDraft.length,
    blockIndex,
    context: secondCitationDraft,
    documentPath: 'manuscript/draft.md',
    sourceScopeBoundary: completedCitation.length,
    pendingDependencies: [{
      id: 'pending-second-citation', blockIndex, start: secondCitationStart, end: secondCitationEnd,
      sourceObjectId: paper.id, sourceSnapshotId: paper.snapshotId,
    }],
  });
  assert.equal(newSourcePrediction.sourceContext.dependencyId, 'pending-second-citation',
    'a citation accepted after the boundary must establish a new source scope');
  assert.ok(newSourcePrediction.sourceCompletions.length >= 2);

  const directAttribution = `${completedCitation} found that`;
  const directSourcePrediction = application.dependencies.predict(project.id, {
    text: directAttribution,
    cursor: directAttribution.length,
    blockIndex,
    context: directAttribution,
    documentPath: 'manuscript/draft.md',
  });
  assert.equal(directSourcePrediction.sourceContext.exclusive, true,
    'a reporting verb immediately after the linked citation must retain that paper as the exclusive source');
  assert.equal(directSourcePrediction.sourceContext.source.id, paper.id);
  assert.equal(directSourcePrediction.claims.length, 0);
  assert.equal(directSourcePrediction.completion, null);
  assert.ok(directSourcePrediction.sourceCompletions.length >= 2);
  assert.ok(directSourcePrediction.sourceCompletions.every((finding) => finding.dependencyCandidate.id === paper.id));

  const selectedFinding = sourcePrediction.sourceCompletions
    .find((finding) => finding.replacementText.startsWith('hydroxyproline was significantly associated'));
  assert.ok(selectedFinding);

  const completedFinding = `${attributedDraft} ${selectedFinding.replacementText}`;
  const projectBeforeFinding = application.timeline.getProject(project.id);
  application.dependencies.saveDocument(project.id, {
    path: 'manuscript/draft.md', content: `# Draft\n\n${completedFinding}\n`,
    baseSnapshotId: projectBeforeFinding.currentSnapshotId,
  }, researcher);
  const findingProject = application.timeline.getProject(project.id);
  const findingDocument = application.dependencies.getDocument(project.id, 'manuscript/draft.md');
  const findingBlockIndex = findingDocument.blocks.findIndex((block) => block.text === completedFinding);
  const findingStart = attributedDraft.length + 1;
  const findingLinked = application.dependencies.link(project.id, {
    documentPath: 'manuscript/draft.md',
    anchor: anchorForSpan(findingBlockIndex, findingDocument.blocks[findingBlockIndex].type,
      completedFinding, findingStart, completedFinding.length),
    spanText: selectedFinding.replacementText,
    sourceObjectId: selectedFinding.dependencyCandidate.id,
    sourceSnapshotId: selectedFinding.dependencyCandidate.snapshotId,
    selectionMethod: 'AUTOCOMPLETE',
    expectedSnapshotId: findingProject.currentSnapshotId,
  }, researcher);
  assert.equal(findingLinked.dependency.source.id, linked.dependency.source.id);
  assert.equal(findingLinked.dependency.spanText, selectedFinding.replacementText);

  const absent = application.dependencies.predict(project.id, {
    text: 'Unknownsurname et al.', cursor: 20, context: 'Unknownsurname et al.',
  }).claims[0];
  assert.equal(absent.candidates.length, 0, 'an explicit unknown author must not surface arbitrary papers');

  const docxPath = path.join(root, 'Readings', 'review-not-named-for-author.docx');
  const originalDocx = fs.readFileSync(docxPath);
  const beforeLayer = application.timeline.getProject(project.id);
  application.dependencies.saveDocument(project.id, {
    path: 'Readings/review-not-named-for-author.docx',
    content: '# Revised review\n\nThis paragraph was edited in Lasso without replacing the DOCX.\n',
    baseSnapshotId: beforeLayer.currentSnapshotId,
  }, researcher);
  const editedDocx = application.dependencies.getDocument(project.id, 'Readings/review-not-named-for-author.docx');
  assert.equal(editedDocx.fileType, 'document');
  assert.equal(editedDocx.editingMode, 'TEXT_LAYER');
  assert.equal(editedDocx.originalPreserved, true);
  assert.equal(editedDocx.blocks[0].type, 'heading');
  assert.match(editedDocx.blocks[1].text, /edited in Lasso/);
  assert.deepEqual(fs.readFileSync(docxPath), originalDocx);

  await application.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
});


test('XLSX follows worksheet relationships and extracts offset table headings', () => {
  const workbook = storedZip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Budget" r:id="rId9"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId9" Target="worksheets/sheet7.xml"/></Relationships>',
    'xl/worksheets/sheet7.xml': '<worksheet><sheetData><row r="30"><c r="D30" t="inlineStr"><is><t>Account</t></is></c><c r="E30" t="inlineStr"><is><t>Total</t></is></c></row><row r="31"><c r="D31" t="inlineStr"><is><t>Rent</t></is></c><c r="E31"><v>42</v></c></row></sheetData><mergeCells><mergeCell ref="D28:E28"/></mergeCells><tableParts><tablePart r:id="t1"/></tableParts></worksheet>',
    'xl/worksheets/_rels/sheet7.xml.rels': '<Relationships><Relationship Id="t1" Target="../tables/table3.xml"/></Relationships>',
    'xl/tables/table3.xml': '<table ref="D30:E31"><tableColumns><tableColumn name="Account"/><tableColumn name="Total"/></tableColumns></table>',
  });
  const [sheet] = extractSpreadsheetTables(workbook);
  assert.equal(sheet.name, 'Budget');
  assert.deepEqual(sheet.rowNumbers, [30, 31]);
  assert.deepEqual(sheet.tables[0], {firstRow:30,lastRow:31,firstColumn:3,lastColumn:4,headerRowCount:1,headers:['Account','Total']});
  assert.deepEqual(sheet.merges[0], {firstRow:28,lastRow:28,firstColumn:3,lastColumn:4});
});

test('XLSX keeps literal greater-than characters inside quoted sheet and column names', () => {
  const workbook = storedZip({
    'xl/workbook.xml': "<workbook><sheets><sheet name='A > B' r:id='r1'/></sheets></workbook>",
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData><tableParts><tablePart r:id="t1"/></tableParts></worksheet>',
    'xl/worksheets/_rels/sheet1.xml.rels': '<Relationships><Relationship Id="t1" Target="../tables/table1.xml"/></Relationships>',
    'xl/tables/table1.xml': '<table ref="A1:A2"><tableColumns><tableColumn name="Actual > budget"/></tableColumns></table>',
  });
  const [sheet] = extractSpreadsheetTables(workbook);
  assert.equal(sheet.name, 'A > B');
  assert.deepEqual(sheet.rows, [['42']]);
  assert.deepEqual(sheet.tables[0].headers, ['Actual > budget']);
});

for (const prefix of ['', 'x:']) {
  test(`XLSX ${prefix || 'default namespace'} keeps empty cells, cached formulas and physical coordinates`, () => {
    const qualify = xml => xml.replace(/<(\/?)([A-Za-z][A-Za-z0-9]*)/g, `<$1${prefix}$2`);
    const workbook = storedZip({
      'xl/workbook.xml': qualify('<workbook><sheets><sheet name="Clinic capacity" links:id="clinic"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': '<pkg:Relationships><pkg:Relationship Id="clinic" Target="/xl/worksheets/sheet7.xml"/></pkg:Relationships>',
      'xl/sharedStrings.xml': qualify('<sst><si><t>Clinic</t></si><si/><si><r><t>Harbour </t></r><r><t>North</t></r></si></sst>'),
      'xl/worksheets/sheet7.xml': qualify(`<worksheet><sheetData>
        <row r="20"><c r="A20" t="s"/><c r="B20" t="s"><v>0</v></c><c r="C20" t="inlineStr"><is><r><t>Available </t></r><r><t>slots</t></r></is></c></row>
        <row r="21"/><row r="22"><c r="A22" s="1"/><c r="B22" s="1"/></row>
        <row r="23"><c r="A23" s="1"/><c r="B23" t="s"><v>2</v></c><c r="C23"><f>SUM(C10:C12)</f><v>90</v></c><c r="D23"/></row>
        <row r="24"/><row><c/><c t="s"><v>1</v></c><c><v>21</v></c></row>
        </sheetData><mergeCells><mergeCell ref="B18:C18"/></mergeCells><tableParts><tablePart links:id="capacity"/></tableParts></worksheet>`),
      'xl/worksheets/_rels/sheet7.xml.rels': '<pkg:Relationships><pkg:Relationship Id="capacity" Target="../tables/table3.xml"/></pkg:Relationships>',
      'xl/tables/table3.xml': qualify('<table ref="B20:C23"><tableColumns><tableColumn name="Clinic"/><tableColumn name="Available slots"/></tableColumns></table>'),
    });
    const [sheet] = extractSpreadsheetTables(workbook);
    assert.equal(sheet.name, 'Clinic capacity');
    assert.deepEqual(sheet.rowNumbers, [20, 23, 25]);
    assert.deepEqual(sheet.rows, [['', 'Clinic', 'Available slots'], ['', 'Harbour North', '90', ''], ['', '', '21']]);
    assert.deepEqual(sheet.merges, [{ firstRow: 18, lastRow: 18, firstColumn: 1, lastColumn: 2 }]);
    assert.deepEqual(sheet.tables, [{ firstRow: 20, lastRow: 23, firstColumn: 1, lastColumn: 2,
      headerRowCount: 1, headers: ['Clinic', 'Available slots'] }]);
    const preview = buildSharePreview({ path: 'capacity.xlsx', content: workbook },
      { rowIndex: 1, columnIndex: 2, sheet: 'Clinic capacity' });
    assert.deepEqual(preview.columns, ['B', 'C']);
    assert.deepEqual(preview.headers, ['Clinic', 'Available slots']);
    const selected = preview.rows.find(row => row.rowNumber === 23);
    assert.equal(selected.cells[1].value, '90');
    assert.equal(selected.cells[1].cited, true);
  });
}

test('line items indented behind spacer columns are still named rows', async () => {
  // A statement template puts its line items in column C, leaving A and B
  // empty apart from a stray mark, and heads the figures with the years.
  // Reading row labels from column A would name every row after its number,
  // and nothing in the sheet could then be referred to by name.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-spacer-test-'));
  const root = path.join(sandbox, 'Statements');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'statement.xlsx'), storedZip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="SingleStep" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst>'
      + '<si><t>Expenses</t></si><si><t>Advertising</t></si><si><t>Bad debt</t></si>'
      + '<si><t>Commissions</t></si><si><t>Depreciation</t></si><si><t>Utilities</t></si>'
      + '</sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
      + '<row r="1"><c r="B1" s="9" t="s"><v>0</v></c><c r="D1"><v>2020</v></c><c r="E1"><v>2019</v></c></row>'
      + '<row r="2"><c r="B2" s="9"/><c r="C2" t="s"><v>1</v></c><c r="D2"><v>1000</v></c><c r="E2"><v>900</v></c></row>'
      + '<row r="3"><c r="B3" s="9"/><c r="C3" t="s"><v>2</v></c><c r="D3"><v>250</v></c><c r="E3"><v>240</v></c></row>'
      + '<row r="4"><c r="B4" s="9"/><c r="C4" t="s"><v>3</v></c><c r="D4"><v>700</v></c><c r="E4"><v>650</v></c></row>'
      + '<row r="5"><c r="B5" s="9"/><c r="C5" t="s"><v>4</v></c><c r="D5"><v>612</v></c><c r="E5"><v>612</v></c></row>'
      + '<row r="6"><c r="B6" s="9"/><c r="C6" t="s"><v>5</v></c><c r="D6"><v>180</v></c><c r="E6"><v>175</v></c></row>'
      + '</sheetData></worksheet>',
  }));
  const application = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  try {
    const project = application.timeline.importProject(root, researcher, { watch: false }).project;
    const objects = application.dependencies.objectsAt(project.id);
    const rows = objects.filter((object) => object.objectType === 'DATASET_ROW').map((object) => object.label);
    assert.ok(rows.includes('Advertising'), `named rows were ${JSON.stringify(rows)}`);
    assert.ok(rows.includes('Commissions'));
    assert.ok(!rows.some((label) => /^row:\d+$/.test(label)), 'no row is named after its position');

    // And the name is what a writer can reach for mid-sentence.
    const prediction = application.dependencies.predict(project.id, {
      text: 'I was looking at the advertisi', cursor: 30,
    });
    const candidate = prediction.claims[0].candidates[0];
    assert.equal(candidate.label, 'Advertising');
    assert.equal(candidate.objectType, 'DATASET_ROW');
  } finally {
    await application.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('a formatted empty cell does not swallow the cell after it', () => {
  // Excel writes a cell that carries formatting but no value as a
  // self-closing tag. Treating it as the opening of a cell runs on to the
  // next closing tag, which hands the empty cell's column the following
  // cell's value and drops that cell's own type - so a shared string
  // surfaces as its raw index, and a row of line items reads as numbers.
  const workbook = storedZip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Sheet1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Expenses</t></si><si><t>Advertising</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData>'
      + '<row r="1"><c r="B1" s="25" t="s"><v>0</v></c></row>'
      + '<row r="2"><c r="B2" s="19"/><c r="C2" s="20" t="s"><v>1</v></c><c r="D2"><v>1000</v></c></row>'
      + '</sheetData></worksheet>',
  });
  const [sheet] = extractSpreadsheetTables(workbook);
  assert.equal(sheet.rows[0][1], 'Expenses');
  assert.equal(sheet.rows[1][2], 'Advertising', 'the shared string resolves instead of leaking its index');
  assert.equal(sheet.rows[1][3], '1000', 'the value stays in its own column');
  assert.ok(!sheet.rows[1].includes('1'), 'no raw shared-string index reaches the grid');
});

test('legacy Excel previews retain distant period headings and the physical cited row', () => {
  const preview = buildSharePreview({path:'statement.xls',content:sampleLegacyXls(7,23)}, {rowIndex:1,columnIndex:2,sheet:'Accounting'});
  assert.deepEqual(preview.headers, ['Account','Current Period','Prior Period']);
  assert.equal(preview.rows[0].rowNumber, 24);
  assert.equal(preview.rows[0].cells[2].value, '215');
  assert.equal(preview.rows[0].cells[2].cited, true);
});

// Synthetic shape of the reported workbook: formatted empty cells, indented
// account labels, year headings, empty rows and unrelated sidebar content.
const statementXlsx = storedZip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Income" sheetId="1" r:id="r1"/></sheets></workbook>',
  'xl/sharedStrings.xml': '<sst><si><t>Revenue</t></si><si><t>Sales revenue</t></si><si><t>Service revenue</t></si><si><t>Interest revenue</t></si><si><t>Other revenue</t></si><si><t>Total Revenues</t></si></sst>',
  'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
    <row r="4"><c r="A4" s="2"/><c r="B4" t="s"><v>0</v></c><c r="C4" s="2"/><c r="D4"><v>2020</v></c><c r="E4"><v>2019</v></c></row>
    <row r="5"><c r="B5" s="2"/><c r="C5" t="s"><v>1</v></c><c r="D5"><v>120</v></c><c r="E5"><v>100</v></c></row>
    <row r="6"><c r="B6"/><c r="C6"/></row><row r="7"/>
    <row r="8"><c r="B8"/><c r="C8" t="s"><v>2</v></c><c r="D8"><v>80</v></c><c r="E8"><v>70</v></c></row>
    <row r="9"><c r="B9"/><c r="C9" t="s"><v>3</v></c><c r="D9"><v>10</v></c><c r="E9"><v>5</v></c></row>
    <row r="10"><c r="B10"/><c r="C10" t="s"><v>4</v></c><c r="D10"><v>20</v></c><c r="E10"><v>10</v></c></row>
    <row r="12"><c r="B12" t="s"><v>5</v></c><c r="C12"/><c r="D12"><f>SUM(D5:D10)</f><v>230</v></c><c r="E12"><v>185</v></c></row>
  </sheetData></worksheet>`,
});

test('formatted empty Excel cells never absorb the next cell or its shared string', () => {
  const sheet = extractSpreadsheetTables(statementXlsx)[0];
  assert.equal(sheet.rows[0][1], 'Revenue');
  assert.equal(sheet.rows[0][2], '');
  assert.equal(sheet.rows[0][3], '2020');
  assert.equal(sheet.rows[1][2], 'Sales revenue');
  assert.equal(sheet.rows[1][3], '120');
  assert.deepEqual(sheet.rowNumbers, [4, 5, 8, 9, 10, 12]);
});

test('income statement suggestions retain alternatives, physical cells and linked follow-ups', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-income-regression-'));
  fs.mkdirSync(path.join(root, 'project'));
  fs.writeFileSync(path.join(root, 'project', 'income.xlsx'), statementXlsx);
  const app = createApplication({ dataDir: path.join(root, 'history'), watchProjects: false });
  try {
    const project = app.timeline.importProject(path.join(root, 'project'), researcher, { watch: false }).project;
    const text = 'I was looking at the revenue';
    const result = app.dependencies.predict(project.id, { text, cursor: text.length, blockIndex: 0 });
    const candidates = result.claims[0].candidates;
    // Every revenue row of the statement is offered, with the heading first.
    assert.deepEqual(new Set(candidates.map(c => c.label)), new Set(['Revenue', 'Sales revenue', 'Service revenue',
      'Interest revenue', 'Other revenue', 'Total Revenues']));
    assert.equal(candidates[0].label, 'Revenue');
    assert.ok(candidates.some(c => c.label === 'Sales revenue'));
    assert.ok(!candidates.some(c => c.valueText?.includes('inferred numeric')));
    const objects = app.dependencies.objectsAt(project.id);
    const value = objects.find(o => o.anchor?.rowKey === 'Service revenue' && o.anchor?.column === '2020' && o.objectType === 'DATASET_VALUE');
    assert.equal(value.valueText, '80');
    assert.equal(value.anchor.rowIndex, 8);
    assert.equal(value.anchor.columnIndex, 3);
    const preview = buildSharePreview({ path: 'income.xlsx', content: statementXlsx }, value.anchor, value.metadata);
    const citedRow = preview.rows.find(row => row.cells.some(cell => cell.cited));
    assert.equal(citedRow.rowNumber, 8);
    assert.equal(citedRow.cells.find(cell => cell.cited).value, '80');
    assert.ok(preview.headers.includes('2020'));
    assert.equal(objects.find(o => o.anchor?.rowKey === 'Total Revenues' && o.anchor?.column === '2020').valueText, '230');
    const source = candidates[0];
    const followText = text + ' was ';
    const follow = app.dependencies.predict(project.id, { text: followText, cursor: followText.length, blockIndex: 0,
      pendingDependencies: [{ blockIndex: 0, start: 21, end: 28, sourceObjectId: source.id, sourceSnapshotId: source.snapshotId }] });
    assert.ok(follow.workspaceCompletions.length > 1);
    assert.ok(follow.workspaceCompletions.every(c => c.dependencyCandidate.path === 'income.xlsx'));
    assert.ok(follow.workspaceCompletions.some(c => ['120', '100', '80', '70'].includes(c.replacementText)));
    // A bad object from the previous extractor remains accessible by its pinned
    // identity, but never competes with the repaired source in new suggestions.
    app.db.prepare("INSERT INTO scientific_objects(id, project_id, object_key, object_type, created_at) VALUES ('legacy-revenue', ?, 'legacy:variable:revenue', 'VARIABLE', ?)")
      .run(project.id, new Date().toISOString());
    app.db.prepare(`INSERT INTO scientific_object_versions(id, object_id, snapshot_id, path, label, value_text, search_text, content_hash, metadata_json, created_at)
      VALUES ('legacy-version', 'legacy-revenue', ?, 'income.xlsx', 'Revenue', 'revenue; inferred numeric variable; examples 41, 5', 'revenue', ?, '{}', ?)`)
      .run(source.snapshotId, source.contentHash, new Date().toISOString());
    // An existing Windows history must re-index without deleting pinned evidence.
    app.db.prepare('UPDATE snapshot_object_indexes SET spreadsheet_index_version = 0 WHERE snapshot_id = ?').run(project.currentSnapshotId);
    app.dependencies.ensureIndex(project.id);
    assert.equal(app.dependencies.objectAt(project.id, source.snapshotId, source.id).versionId, source.versionId);
    assert.equal(app.dependencies.objectsAt(project.id).length, objects.length);
    assert.match(app.dependencies.objectAt(project.id, source.snapshotId, 'legacy-revenue').valueText, /inferred numeric/);
    assert.ok(!app.dependencies.predict(project.id, { text, cursor: text.length, blockIndex: 0 }).claims[0].candidates.some(c => c.id === 'legacy-revenue'));
  } finally { app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
