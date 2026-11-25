// A Word document carries Lasso's AI record inside itself, so a document sent
// to someone else who has Lasso shows them the same parts an AI wrote, who
// recorded them and who has edited them since. The record is a part Word
// keeps through its own saves; Lasso signs it, writes it only once Word has
// closed the file, and never counts its own write as anyone's edit.

import test from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { readZip, writeZip, zipBytes } from '../src/dependencies/zip-archive.js';
import { locateSpans, readCarried, recordXml, withRecord } from '../src/provenance/carried-record.js';
import { recentHistory } from '../src/loop/history.js';
import { aiLabels } from '../src/cli/ai-facts.js';

const TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '</Types>';
const PACKAGE_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + '</Relationships>';
const DOCUMENT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '</Relationships>';

const body = (paragraphs) => '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
  + `${paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;

/** A Word document as Word writes one, a paragraph per entry. */
function docx(paragraphs) {
  return writeZip([
    { name: '[Content_Types].xml', content: Buffer.from(TYPES) },
    { name: '_rels/.rels', content: Buffer.from(PACKAGE_RELS) },
    { name: 'word/document.xml', content: Buffer.from(body(paragraphs)) },
    { name: 'word/_rels/document.xml.rels', content: Buffer.from(DOCUMENT_RELS) },
    { name: 'word/styles.xml', content: Buffer.from('<w:styles/>') },
  ]);
}

/** The document saved again by Word with new words: every other part, the record among them, kept. */
function savedInWord(buffer, paragraphs) {
  const entries = readZip(buffer);
  return writeZip([...entries.values()].map((entry) => (entry.name === 'word/document.xml'
    ? { name: entry.name, content: Buffer.from(body(paragraphs)) } : entry)));
}

const part = (buffer, name) => zipBytes(readZip(buffer).get(name), 1 << 24).toString('utf8');

/** One person's Mac with Lasso following a Documents folder. */
function mac(t, name, files = {}) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-ai-record-')));
  const root = path.join(sandbox, 'Documents');
  fs.mkdirSync(root);
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(root, file), content);
  const application = createApplication({ dataDir: path.join(sandbox, 'library'), watchProjects: false, port: 0, aiRecordSettleMs: 0 });
  t.after(async () => {
    await application.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  application.authorship.identity.update({ name });
  const self = { id: 'human:self', displayName: name, actorType: 'HUMAN_SELF' };
  const project = application.timeline.importProject(root, self, { watch: false }).project;
  const file = (relative) => path.join(root, relative);
  const save = async () => {
    application.timeline.capture(project.id, self);
    await application.authorship.settled();
  };
  const stamp = async () => {
    await application.authorship.stampPending();
    await application.authorship.settled();
  };
  const elsewhere = (relative, content) => {
    const target = path.join(sandbox, 'Downloads', relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };
  return { application, project, root, sandbox, file, save, stamp, elsewhere, self };
}

const PASTED = 'The pump held a steady flow for six hours.';

/** Adel's Mac with report.docx holding a paragraph pasted from ChatGPT, saved and closed. */
async function pastedReport(t) {
  const adel = mac(t, 'Adel', { 'report.docx': docx(['Pump trial report']) });
  adel.application.authorship.record({ kind: 'paste', agent: 'ChatGPT', tool: 'chatgpt.com', text: PASTED, hostApp: 'Microsoft Word' });
  fs.writeFileSync(adel.file('report.docx'), docx(['Pump trial report', PASTED]));
  await adel.save();
  await adel.stamp();
  return adel;
}

test('A Word document holding a paste from ChatGPT carries Lasso\'s signed record once saved, and nothing else in it changes', async (t) => {
  const adel = mac(t, 'Adel', { 'report.docx': docx(['Pump trial report']) });
  adel.application.authorship.record({ kind: 'paste', agent: 'ChatGPT', tool: 'chatgpt.com', text: PASTED, hostApp: 'Microsoft Word' });
  const saved = docx(['Pump trial report', PASTED]);
  fs.writeFileSync(adel.file('report.docx'), saved);
  const savedAt = new Date('2026-11-20T10:00:00Z');
  fs.utimesSync(adel.file('report.docx'), savedAt, savedAt);

  await adel.save();
  await adel.stamp();

  const written = fs.readFileSync(adel.file('report.docx'));
  const carried = readCarried(written);
  assert.equal(carried.valid, true);
  assert.equal(carried.signer.name, 'Adel');
  assert.deepEqual(carried.payload.spans.map((span) => span.text), [PASTED]);
  assert.equal(carried.payload.marks[0].agent, 'ChatGPT');
  assert.equal(carried.payload.marks[0].kind, 'paste');
  for (const name of ['word/document.xml', 'word/styles.xml', '_rels/.rels']) assert.equal(part(written, name), part(saved, name));
  assert.equal(fs.statSync(adel.file('report.docx')).mtimeMs, savedAt.getTime());

  const latest = adel.application.timeline.listEvents(adel.project.id)[0];
  assert.equal(latest.source, 'AI_RECORD');
  assert.equal(latest.actor.displayName, 'Lasso');
  const loop = recentHistory(adel.application.db, [adel.project.id], Date.now()).entries;
  assert.deepEqual(loop.map((entry) => entry.source), ['WATCHER', 'IMPORT']);
  assert.deepEqual(adel.application.authorship.forPath(adel.file('report.docx')).spans.map((span) => span.text), [PASTED]);
});

test('Lasso waits until Word has closed a document before writing its record into it', async (t) => {
  const adel = mac(t, 'Adel', { 'report.docx': docx(['Pump trial report']) });
  adel.application.authorship.record({ kind: 'paste', agent: 'ChatGPT', text: PASTED });
  fs.writeFileSync(adel.file('report.docx'), docx(['Pump trial report', PASTED]));
  // Word keeps an owner file beside a document while it is open.
  fs.writeFileSync(adel.file('~$port.docx'), 'Adel');
  await adel.save();
  await adel.stamp();
  assert.equal(readCarried(fs.readFileSync(adel.file('report.docx'))), null);

  fs.rmSync(adel.file('~$port.docx'));
  await adel.stamp();
  assert.equal(readCarried(fs.readFileSync(adel.file('report.docx')))?.valid, true);
});

test('Lasso waits while another program holds the document open, as Word does while it shows one', async (t) => {
  const adel = mac(t, 'Adel', { 'report.docx': docx(['Pump trial report']) });
  adel.application.authorship.record({ kind: 'paste', agent: 'ChatGPT', text: PASTED });
  fs.writeFileSync(adel.file('report.docx'), docx(['Pump trial report', PASTED]));
  await adel.save();
  const holder = spawn(process.execPath, ['-e', 'require("fs").openSync(process.argv[1], "r+"); console.log("open"); setInterval(() => {}, 1000)',
    adel.file('report.docx')], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => holder.kill());
  await new Promise((resolve) => holder.stdout.once('data', resolve));

  await adel.stamp();
  assert.equal(readCarried(fs.readFileSync(adel.file('report.docx'))), null);

  holder.kill();
  await new Promise((resolve) => holder.once('exit', resolve));
  await adel.stamp();
  assert.equal(readCarried(fs.readFileSync(adel.file('report.docx')))?.valid, true);
});

test('A Word document no AI wrote in is never written', async (t) => {
  const adel = mac(t, 'Adel', { 'report.docx': docx(['Pump trial report']) });
  const saved = docx(['Pump trial report', 'Written by hand.']);
  fs.writeFileSync(adel.file('report.docx'), saved);
  await adel.save();
  await adel.stamp();
  assert.deepEqual(fs.readFileSync(adel.file('report.docx')), saved);
});

test('With records switched off, Lasso writes none', async (t) => {
  const adel = mac(t, 'Adel', { 'report.docx': docx(['Pump trial report']) });
  adel.application.authorship.identity.update({ carry: false });
  adel.application.authorship.record({ kind: 'paste', agent: 'ChatGPT', text: PASTED });
  fs.writeFileSync(adel.file('report.docx'), docx(['Pump trial report', PASTED]));
  await adel.save();
  await adel.stamp();
  assert.equal(readCarried(fs.readFileSync(adel.file('report.docx'))), null);
});

test('Prompts stay out of a record until they are included', async (t) => {
  const adel = mac(t, 'Adel', { 'draft.docx': docx(['Dear team,']) });
  const answer = 'The pump trial ran for six hours at a steady flow.';
  adel.application.authorship.record({ kind: 'writer', agent: 'ChatGPT', tool: 'Lasso writer', prompt: 'summarise the pump trial', text: answer });
  fs.writeFileSync(adel.file('draft.docx'), docx(['Dear team,', answer]));
  await adel.save();
  await adel.stamp();
  assert.equal(readCarried(fs.readFileSync(adel.file('draft.docx'))).payload.marks[0].prompt, undefined);

  adel.application.authorship.identity.update({ includePrompts: true });
  fs.writeFileSync(adel.file('draft.docx'), savedInWord(fs.readFileSync(adel.file('draft.docx')), ['Dear team,', answer, 'Thanks']));
  await adel.save();
  await adel.stamp();
  assert.equal(readCarried(fs.readFileSync(adel.file('draft.docx'))).payload.marks[0].prompt, 'summarise the pump trial');
});

test('Another Mac\'s Lasso shows the parts a received document carries, as recorded by the sender', async (t) => {
  const adel = await pastedReport(t);
  const sam = mac(t, 'Sam');
  const received = sam.elsewhere('report.docx', fs.readFileSync(adel.file('report.docx')));

  const answer = sam.application.authorship.forPath(received);

  assert.equal(answer.found ?? true, true);
  assert.deepEqual(answer.spans.map((span) => span.text), [PASTED]);
  assert.equal(answer.carried.by, 'Adel');
  assert.equal(answer.carried.valid, true);
  const [mark] = answer.marks;
  assert.equal(mark.agent.name, 'ChatGPT');
  assert.equal(mark.kind, 'paste');
  assert.equal(mark.recordedBy.name, 'Adel');
  assert.equal(mark.recordedBy.you, false);
  assert.deepEqual(mark.askedBy, { name: 'Adel', you: false });
});

test('A record changed after Lasso signed it is not believed', async (t) => {
  const adel = await pastedReport(t);
  const sam = mac(t, 'Sam');
  const signed = fs.readFileSync(adel.file('report.docx'));
  const entries = readZip(signed);
  const record = [...entries.keys()].find((name) => /^customXml\/item\d+\.xml$/.test(name));
  const forged = writeZip([...entries.values()].map((entry) => (entry.name === record
    ? { name: record, content: Buffer.from(part(signed, record).replace('ChatGPT', 'Claude')) } : entry)));

  const answer = sam.application.authorship.forPath(sam.elsewhere('report.docx', forged));

  assert.deepEqual(answer.spans, []);
  assert.equal(answer.carried.valid, false);
});

test('Edits on another Mac carry the record on, and each record says who edited the AI\'s words', async (t) => {
  const adel = await pastedReport(t);
  const sam = mac(t, 'Sam');
  fs.writeFileSync(sam.file('report.docx'), fs.readFileSync(adel.file('report.docx')));
  await sam.save();
  assert.deepEqual(sam.application.authorship.forPath(sam.file('report.docx')).spans.map((span) => span.text), [PASTED]);

  const rewritten = 'The pump held a steady flow for nine hours.';
  fs.writeFileSync(sam.file('report.docx'), savedInWord(fs.readFileSync(sam.file('report.docx')), ['Pump trial report', rewritten]));
  await sam.save();
  await sam.stamp();

  const fromSam = readCarried(fs.readFileSync(sam.file('report.docx')));
  assert.equal(fromSam.valid, true);
  assert.equal(fromSam.signer.name, 'Sam');
  assert.equal(fromSam.payload.marks[0].recordedBy.name, 'Adel');
  assert.deepEqual(fromSam.payload.marks[0].editors.map((editor) => editor.name), ['Sam']);

  // The document comes back to Adel.
  fs.writeFileSync(adel.file('report.docx'), fs.readFileSync(sam.file('report.docx')));
  await adel.save();
  const back = adel.application.authorship.forPath(adel.file('report.docx'));
  const [mark] = back.marks;
  assert.equal(mark.agent.name, 'ChatGPT');
  assert.equal(mark.recordedBy.you, true);
  assert.deepEqual(mark.editors.map((editor) => [editor.name, editor.you]), [['Sam', false]]);
  assert.ok(mark.kept < mark.written);
});

test('The lasso command names the AI record a received document carries', async (t) => {
  const adel = await pastedReport(t);
  const labels = aiLabels(adel.file('report.docx'));
  assert.equal(labels.madeWithAi, true);
  assert.equal(labels.record.by, 'Adel');
  assert.equal(labels.record.valid, true);
  assert.deepEqual(labels.record.agents, [{ name: 'ChatGPT', parts: 1, characters: PASTED.length }]);
});

test('The record settings are read and changed through the server', async (t) => {
  const adel = mac(t, 'Adel');
  adel.application.server.listen(0, '127.0.0.1');
  await new Promise((resolve) => adel.application.server.once('listening', resolve));
  const base = `http://127.0.0.1:${adel.application.server.address().port}`;

  const read = await (await fetch(`${base}/api/ai-record`)).json();
  const changed = await (await fetch(`${base}/api/ai-record`, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Adel Y', includePrompts: true }) })).json();

  assert.deepEqual([read.name, read.carry, read.includePrompts], ['Adel', true, false]);
  assert.deepEqual([changed.name, changed.carry, changed.includePrompts], ['Adel Y', true, true]);
});

test('A record goes into a bare package and reads back, and Word\'s own way of writing the part still verifies', async (t) => {
  const { RecordIdentity } = await import('../src/provenance/record-identity.js');
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-ai-record-unit-'));
  t.after(() => fs.rmSync(library, { recursive: true, force: true }));
  const identity = new RecordIdentity({ dataDir: library });
  identity.update({ name: 'Zoë' });
  const payloadText = JSON.stringify({ format: 'lasso-ai-record', version: 1, signer: identity.signer(), marks: [], spans: [] })
    .replace(/[\u007f-￿]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const bare = writeZip([
    { name: '[Content_Types].xml', content: Buffer.from('<Types/>') },
    { name: 'word/document.xml', content: Buffer.from(body(['One.'])) },
  ]);

  const stamped = withRecord(bare, recordXml(payloadText, identity.sign(payloadText)));
  const carried = readCarried(stamped);
  assert.equal(carried.valid, true);
  assert.equal(carried.signer.name, 'Zoë');
  assert.match(part(stamped, 'word/_rels/document.xml.rels'), /customXml\/item1\.xml/);
  assert.match(part(stamped, '[Content_Types].xml'), /customXml\/itemProps1\.xml/);

  // Word writes the part back with prefixes and its own escaping.
  const name = 'customXml/item1.xml';
  const reworded = part(stamped, name).replace(/<(\/?)(aiRecord|payload|signature)/g, '<$1ns0:$2')
    .replace('xmlns=', 'xmlns:ns0=').replace(/&quot;|"(?=[^<]*<\/ns0:payload>)/g, '&quot;');
  const rewritten = writeZip([...readZip(stamped).values()].map((entry) => (entry.name === name
    ? { name, content: Buffer.from(reworded) } : entry)));
  assert.equal(readCarried(rewritten).valid, true);
  // Written again, the record replaces itself rather than adding a second part.
  const again = withRecord(rewritten, recordXml(payloadText, identity.sign(payloadText)));
  assert.deepEqual([...readZip(again).keys()].filter((entry) => /^customXml\/item\d+\.xml$/.test(entry)), [name]);
});

test('A record\'s parts are found again where the words now are', () => {
  const now = 'Intro.\nA new first line.\nThe pump held a steady flow.\nThe pump held a steady flow.\nEnd.';
  const spans = [{ mark: 'm1', start: 7, end: 35, text: 'The pump held a steady flow.', prefix: 'Intro.\n', suffix: '\nEnd.' }];
  assert.deepEqual(locateSpans(now, spans), [{ m: 'm1', s: 54, e: 82 }]);
  assert.deepEqual(locateSpans(now, [{ ...spans[0], text: 'Gone words.' }]), []);
});
