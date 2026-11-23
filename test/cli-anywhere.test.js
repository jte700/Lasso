import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Anywhere } from '../src/cli/anywhere.js';
import { openBackend } from '../src/cli/backend.js';
import { interpret, quoteEscapes } from '../src/cli/commands.js';
import { parsePlist, quarantineMark, sha256File } from '../src/cli/disk-facts.js';
import { pdfInformation } from '../src/cli/embedded-facts.js';
import { renderAnywhereBlame, renderAnywhereDiff, renderWhence } from '../src/cli/anywhere-views.js';
import { createPainter } from '../src/cli/style.js';
import { writeZip } from '../src/dependencies/zip-archive.js';

const plain = createPainter('none');

function sandbox(t) {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-anywhere-')));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const write = (relative, content) => {
    const file = path.join(folder, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  return { folder, write };
}

/** A Mac whose Spotlight, quarantine marks and file search answer as given; no git. */
function fakeMac({ spotlight = {}, marks = {}, bySize = {}, byName = {} } = {}) {
  return {
    platform: 'darwin',
    gitInstalled: false,
    run(command, args) {
      const file = args.at(-1);
      if (command === 'mdls') return spotlight[file] ? plist(spotlight[file]) : null;
      if (command === 'xattr' && args[1] === 'com.apple.quarantine') return marks[file] ?? null;
      if (command === 'mdfind') {
        const size = String(args[0]).match(/kMDItemFSSize == (\d+)/)?.[1];
        if (size) return (bySize[size] ?? []).join('\n');
        if (args[0] === '-name') return (byName[args[1]] ?? []).join('\n');
      }
      return null;
    },
  };
}

const plist = (values) => `<?xml version="1.0"?><plist version="1.0"><dict>${Object.entries(values).map(([key, value]) => `<key>${key}</key>${
  Array.isArray(value) ? `<array>${value.map((item) => `<string>${item}</string>`).join('')}</array>`
    : typeof value === 'number' ? `<real>${value}</real>` : /^\d{4}-\d\d-\d\dT/.test(value) ? `<date>${value}</date>` : `<string>${value}</string>`}`).join('')}</dict></plist>`;

const docx = ({ creator, lastSavedBy, body }) => writeZip([
  { name: '[Content_Types].xml', content: Buffer.from('<Types/>') },
  { name: 'docProps/core.xml', content: Buffer.from(`<cp:coreProperties xmlns:cp="c" xmlns:dc="d" xmlns:dcterms="t"><dc:creator>${creator}</dc:creator>`
    + `<cp:lastModifiedBy>${lastSavedBy}</cp:lastModifiedBy><dcterms:created>2026-01-15T10:00:00Z</dcterms:created>`
    + '<dcterms:modified>2026-02-03T22:35:19Z</dcterms:modified><cp:revision>4</cp:revision></cp:coreProperties>') },
  { name: 'docProps/app.xml', content: Buffer.from('<Properties><Application>Microsoft Office Word</Application><TotalTime>95</TotalTime></Properties>') },
  { name: 'word/document.xml', content: Buffer.from(`<w:document><w:body>${body}</w:body></w:document>`) },
]);

test('whence reads where a file outside every library came from, its copies and names like it', async (t) => {
  // Arrange
  const { folder, write } = sandbox(t);
  const clip = write('Rotated/clip_rotated.mov', 'the rotated clip');
  const copy = write('Desktop/clip_rotated.mov', 'the rotated clip');
  const sameSizeOther = write('Elsewhere/other.mov', 'another clip, sa');
  const original = write('Originals/clip.mov', 'the original, longer clip');
  const size = fs.statSync(clip).size;
  assert.equal(fs.statSync(sameSizeOther).size, size);
  const system = fakeMac({
    spotlight: { [clip]: { kMDItemWhereFroms: ['https://drive.google.com/file/d/abc', 'https://drive.google.com/'],
      kMDItemEncodingApplications: ['Lavf62.3.100'], kMDItemDurationSeconds: 12.034, kMDItemDateAdded: '2026-02-06T15:16:01Z' } },
    marks: { [clip]: '0083;6996b378;QuickTime Player;' },
    bySize: { [size]: [clip, copy, sameSizeOther] },
    byName: { clip: [clip, copy, original] },
  });
  const anywhere = new Anywhere({ system, cwd: folder });

  // Act
  const answer = anywhere.whence('Rotated/clip_rotated.mov');
  const lines = renderWhence(answer, plain, 120).join('\n');

  // Assert
  assert.deepEqual(answer.matches, []);
  assert.equal(answer.hash, sha256File(clip));
  assert.deepEqual(answer.system.spotlight.whereFrom, ['https://drive.google.com/file/d/abc', 'https://drive.google.com/']);
  assert.deepEqual(answer.system.spotlight.encoders, ['Lavf62.3.100']);
  assert.equal(answer.system.mark.app, 'QuickTime Player');
  assert.equal(answer.system.mark.downloaded, true);
  assert.deepEqual(answer.copies.copies.map((entry) => entry.path), [copy]);
  assert.deepEqual(answer.names.map((entry) => entry.path), [original]);
  assert.match(lines, /downloaded from drive\.google\.com\/file\/d\/abc/);
  assert.match(lines, /written by\s+Lavf62\.3\.100 \(FFmpeg\)/);
  assert.match(lines, /Same bytes elsewhere {2}1 copy/);
  assert.match(lines, /Names like it/);
});

test('whence finds a bare file name with Spotlight when it is not in the folder it was asked from', async (t) => {
  // Arrange
  const { folder, write } = sandbox(t);
  const file = write('Deep/Inside/report.csv', 'a,b\n1,2\n');
  const anywhere = new Anywhere({ system: fakeMac({ byName: { 'report.csv': [file] } }), cwd: path.join(folder, 'Deep') });

  // Act
  const answer = anywhere.whence('report.csv');

  // Assert
  assert.equal(answer.file, file);
  assert.equal(answer.found, 'spotlight');
});

test('whence and blame read an Office file\'s authors and a Word document\'s tracked changes', async (t) => {
  // Arrange
  const { folder, write } = sandbox(t);
  write('Memo.docx', docx({ creator: 'Marie Caron', lastSavedBy: 'Adel Yasin', body: '<w:p><w:r><w:t>Revenue was </w:t></w:r>'
    + '<w:del w:id="1" w:author="Bo Lindqvist" w:date="2026-02-01T09:00:00Z"><w:r><w:delText>3,200</w:delText></w:r></w:del>'
    + '<w:ins w:id="2" w:author="Bo Lindqvist" w:date="2026-02-01T09:00:00Z"><w:r><w:t>3,300</w:t></w:r></w:ins></w:p>' }));
  const anywhere = new Anywhere({ system: fakeMac(), cwd: folder });

  // Act
  const origin = anywhere.whence('Memo.docx');
  const blame = anywhere.blame('Memo.docx');
  const lines = renderAnywhereBlame(blame, plain, 120).join('\n');

  // Assert
  assert.equal(origin.embedded.properties.createdBy, 'Marie Caron');
  assert.equal(origin.embedded.properties.lastSavedBy, 'Adel Yasin');
  assert.equal(origin.embedded.properties.editingMinutes, 95);
  assert.equal(blame.kind, 'word');
  assert.deepEqual(blame.tracked.items.map((item) => [item.kind, item.author, item.text]),
    [['deleted', 'Bo Lindqvist', '3,200'], ['inserted', 'Bo Lindqvist', '3,300']]);
  assert.match(lines, /Bo Lindqvist \+1 −1/);
});

test('blame and diff answer from git for a file in a repository, and whence names the commit that first held its bytes', async (t) => {
  // Arrange
  const { folder, write } = sandbox(t);
  const git = (...args) => execFileSync('git', ['-C', folder, ...args], { stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Maya Chen', GIT_AUTHOR_EMAIL: 'maya@example.com', GIT_COMMITTER_NAME: 'Maya Chen',
      GIT_COMMITTER_EMAIL: 'maya@example.com' } });
  try { git('init', '-q'); } catch { t.skip('git is not installed'); return; }
  write('notes.md', '# Notes\n\nThe intro.\n');
  git('add', '.');
  git('commit', '-q', '-m', 'First notes');
  write('notes.md', '# Notes\n\nA shorter intro.\n\nAn appendix.\n');
  git('commit', '-q', '-am', 'Shorten the intro');
  const system = { platform: 'test', gitInstalled: true, run: (command, args, options) => {
    try { return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...options }); } catch { return null; }
  } };
  const anywhere = new Anywhere({ system, cwd: folder });

  // Act
  const blame = anywhere.blame('notes.md');
  const diff = anywhere.diff(['notes.md']);
  const origin = anywhere.whence('notes.md');
  const shown = renderAnywhereDiff(diff, plain, 120).join('\n');

  // Assert
  assert.equal(blame.kind, 'git');
  assert.deepEqual(blame.authors.map((author) => [author.name, author.lines]), [['Maya Chen', 5]]);
  assert.deepEqual(blame.lines.filter((line) => line.subject === 'Shorten the intro').map((line) => line.text), ['A shorter intro.', '', 'An appendix.']);
  assert.equal(diff.kind, 'git');
  assert.equal(diff.commit.subject, 'First notes');
  assert.equal(diff.newer.subject, 'Shorten the intro');
  assert.match(shown, /\+ A shorter intro\./);
  assert.match(shown, /- The intro\./);
  assert.equal(origin.git.state, 'clean');
  assert.equal(origin.git.firstWithBytes.subject, 'Shorten the intro');
});

test('diff compares two spreadsheets cell by cell, however the words of their names split', async (t) => {
  // Arrange
  const { folder, write } = sandbox(t);
  write('budget.csv', 'Line,Q1,Q2\nRevenue,3200,3400\nRent,900,900\n');
  write('budget final.csv', 'Line,Q1,Q2\nRevenue,3300,3400\nRent,900,900\nTravel,120,80\n');
  const anywhere = new Anywhere({ system: fakeMac(), cwd: folder });

  // Act
  const answer = anywhere.diff(['budget.csv', 'budget', 'final.csv']);
  const shown = renderAnywhereDiff(answer, plain, 120).join('\n');

  // Assert
  assert.equal(answer.kind, 'compare');
  assert.equal(answer.reading, 'sheet');
  assert.equal(answer.sheet.counts.cells, 1);
  assert.equal(answer.sheet.counts.rowsAdded, 1);
  assert.match(shown, /B2\s+Revenue · Q1\s+3200 → 3300/);
  assert.match(shown, /\+ row 4 {2}Travel · 120 · 80/);
});

test('diff says when a file has no earlier version to compare with', async (t) => {
  // Arrange
  const { folder, write } = sandbox(t);
  write('lonely.txt', 'one line\n');
  const anywhere = new Anywhere({ system: fakeMac(), cwd: folder });

  // Act and Assert
  assert.throws(() => anywhere.diff(['lonely.txt']), /no earlier version of lonely\.txt.*\/diff/s);
});

test('verify checks a document\'s numbers against files named for it, or the spreadsheets beside it', async (t) => {
  // Arrange
  const { folder, write } = sandbox(t);
  write('Sources/q3.csv', 'Account,Q3\nRevenue,4215500\nDepreciation,684\n');
  write('memo.md', '# Memo\n\nRevenue reached 4,215,500 this quarter.\n\nDepreciation held at 612.\n');
  write('beside.csv', 'Account,Q3\nDepreciation,612\n');
  const anywhere = new Anywhere({ system: fakeMac(), cwd: folder });

  // Act
  const against = anywhere.verify('memo.md', { against: 'Sources' });
  const beside = anywhere.verify('memo.md');

  // Assert
  assert.equal(against.mode, 'files');
  assert.deepEqual(against.results.map((result) => [result.number, result.status]), [['4,215,500', 'current'], ['612', 'unsourced']]);
  assert.equal(against.results[0].source.path, 'q3.csv');
  assert.equal(against.results[0].source.place, 'B2');
  assert.deepEqual(beside.results.map((result) => [result.number, result.status]), [['4,215,500', 'unsourced'], ['612', 'current']]);
});

test('log reads any folder\'s recent changes from its files\' dates, with who saved an Office file last', async (t) => {
  // Arrange
  const { folder, write } = sandbox(t);
  write('Old/notes.txt', 'old');
  fs.utimesSync(path.join(folder, 'Old/notes.txt'), new Date('2020-01-01'), new Date('2020-01-01'));
  write('Memo.docx', docx({ creator: 'Marie Caron', lastSavedBy: 'Adel Yasin', body: '<w:p/>' }));
  write('.hidden/secret.txt', 'skip me');
  const anywhere = new Anywhere({ system: fakeMac(), cwd: folder });

  // Act
  const answer = anywhere.log('.', {});

  // Assert
  assert.equal(answer.kind, 'folder');
  assert.deepEqual(answer.entries.map((entry) => entry.path), ['Memo.docx']);
  assert.equal(answer.entries[0].savedBy, 'Adel Yasin');
});

test('without a Lasso library the CLI answers on the spot and writes nothing', async (t) => {
  // Arrange
  const { folder, write } = sandbox(t);
  write('report.csv', 'a,b\n1,2\n');
  const backend = openBackend({ cwd: folder, readHistory: false, system: fakeMac(), env: {}, home: path.join(folder, 'home') });
  t.after(() => backend.close());

  // Act
  const hello = await backend.call('hello');
  const origin = await backend.call('whence', 'report.csv');
  const asking = backend.call('run', 'find revenue');

  // Assert
  assert.equal(hello.library, false);
  assert.equal(hello.summary, null);
  assert.equal(origin.name, 'report.csv');
  await assert.rejects(asking, /needs the Lasso app's library/);
  assert.deepEqual(fs.readdirSync(folder), ['report.csv']);
});

test('a path dragged in from Finder reads whole, and a file dropped in alone says where it came from', async (t) => {
  // Arrange
  const { folder, write } = sandbox(t);
  write('BEaTS Lab/clip one.mov', 'clip');

  // Act
  const typed = interpret('/whence BEaTS\\ Lab/clip\\ one.mov', { cwd: folder });
  const dropped = interpret(`${folder}/BEaTS\\ Lab/clip\\ one.mov`, { cwd: folder });
  const folderDropped = interpret(`${folder}/BEaTS\\ Lab`, { cwd: folder });

  // Assert
  assert.deepEqual(typed.parsed.args, ['BEaTS Lab/clip one.mov']);
  assert.equal(dropped.command.name, 'whence');
  assert.deepEqual(dropped.parsed.args, [`${folder}/BEaTS Lab/clip one.mov`]);
  assert.equal(folderDropped.command.name, 'log');
  assert.equal(quoteEscapes('say \\"hi\\"'), 'say \'"\'hi\'"\'');
});

test('property lists, quarantine marks and PDF information read as plain values', () => {
  // Arrange
  const xml = plist({ kMDItemWhereFroms: ['https://example.com/a?x=1&amp;y=2'], kMDItemUseCount: 3, kMDItemDateAdded: '2026-02-06T15:16:01Z' });
  const pdf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-pdf-')), 'paper.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4\n1 0 obj << /Title (Doppler waveforms) /Author (Administrator) /Creator (PScript5.dll)'
    + " /CreationDate (D:20080909162600-04'00') >> endobj\ntrailer << /Info 1 0 R >>\n%%EOF\n");

  // Act
  const values = parsePlist(xml);
  const mark = quarantineMark('0082;6996b378;QuickTime Player;');
  const info = pdfInformation(pdf);

  // Assert
  assert.deepEqual(values, { kMDItemWhereFroms: ['https://example.com/a?x=1&y=2'], kMDItemUseCount: 3, kMDItemDateAdded: '2026-02-06T15:16:01.000Z' });
  assert.deepEqual(mark, { app: 'QuickTime Player', at: '2026-02-19T06:53:44.000Z', downloaded: false });
  assert.equal(quarantineMark(''), null);
  assert.deepEqual(info, { title: 'Doppler waveforms', author: 'Administrator', creator: 'PScript5.dll', created: '2008-09-09T20:26:00.000Z' });
  fs.rmSync(path.dirname(pdf), { recursive: true, force: true });
});
