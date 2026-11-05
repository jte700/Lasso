import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../src/server.js';
import { detectFileType } from '../src/history/file-types.js';
import { quotedPhraseAtCaret } from '../src/dependencies/quoted-phrase.js';
import { transcriptionRuns } from '../src/dependencies/video-extraction.js';

// A 10-second clip whose sound track says, about three seconds apart:
//   0.00 "Welcome to the site visit."
//   1.56 "The concrete pour starts on Tuesday morning."   ("concrete" at 2.34)
//   4.62 "The contractor's crane arrives at noon."        ("crane" at 6.18)
//   7.68 "We found cracks near the north stairwell."      ("north" at about 9.5)
const FIXTURE = fileURLToPath(new URL('./fixtures/videos/site-visit.mp4', import.meta.url));
// The same clip in a QuickTime movie, which macOS tells apart only by its extension.
const MOVIE_FIXTURE = fileURLToPath(new URL('./fixtures/videos/site-visit.mov', import.meta.url));
// On-device transcription needs macOS 26 (Darwin 25) and its speech model.
const canTranscribe = process.platform === 'darwin' && Number(os.release().split('.')[0]) >= 25;
const TIME_TOLERANCE = 0.35;

async function videoFolder(t, { dataDir = null, extra = {}, video = FIXTURE } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-video-'));
  const root = path.join(temporary, 'Site Visits');
  fs.mkdirSync(root, { recursive: true });
  fs.copyFileSync(video, path.join(root, `site-visit${path.extname(video)}`));
  for (const [name, text] of Object.entries(extra)) fs.writeFileSync(path.join(root, name), text);
  const state = dataDir ?? path.join(temporary, 'state');
  const app = createApplication({ dataDir: state, watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  await app.workspace.add([root], { id: 'system:video', displayName: 'Video test', actorType: 'SYSTEM' });
  return { app, root, state };
}

function segmentsOf(app) {
  const [project] = app.workspace.activeProjects();
  return app.dependencies.objectsAt(project.id, null, ['DOCUMENT'])
    .filter((object) => object.metadata.componentType === 'VIDEO_SEGMENT')
    .sort((left, right) => left.anchor.start - right.anchor.start);
}

async function candidates(app, text) {
  const prediction = await app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });
  return {
    prediction,
    all: [
      ...(prediction.completion ? [prediction.completion.dependencyCandidate ?? prediction.completion] : []),
      ...prediction.workspaceCompletions.map((item) => item.dependencyCandidate ?? item),
      ...prediction.claims.flatMap((claim) => claim.candidates ?? []),
    ],
    quoted: prediction.claims.filter((claim) => claim.type === 'QUOTED_PHRASE').flatMap((claim) => claim.candidates),
  };
}

test('A video file is read as a video', () => {
  // Arrange, Act, Assert
  assert.equal(detectFileType('Walkthrough.mp4'), 'video');
  assert.equal(detectFileType('clips/Interview.MOV'), 'video');
  assert.equal(detectFileType('Lecture.m4v'), 'video');
  assert.equal(detectFileType('notes.txt'), 'text');
});

test('A phrase in double, single or curly quotes at the caret is found', () => {
  // Arrange
  const cases = [
    ['He said "concrete pour starts"', 'concrete pour starts'],
    ["He said 'crane arrives at noon'", 'crane arrives at noon'],
    ['She noted “north stairwell” ', 'north stairwell'],
    ["The quote 'the contractor's crane'", "the contractor's crane"],
  ];

  // Act
  const found = cases.map(([text]) => quotedPhraseAtCaret(text, text.length)?.phrase ?? null);

  // Assert
  assert.deepEqual(found, cases.map(([, phrase]) => phrase));
});

test('Text without a closed quote at the caret has no quoted phrase', () => {
  // Arrange
  const texts = [
    'The concrete pour starts',
    "The contractor's crane arrives",
    '"concrete pour starts" was said, and then',
    'He said ""',
  ];

  // Act
  const found = texts.map((text) => quotedPhraseAtCaret(text, text.length));

  // Assert
  assert.deepEqual(found, [null, null, null, null]);
});

test('A short video is transcribed into timed segments', { skip: !canTranscribe }, async (t) => {
  // Arrange
  const { app } = await videoFolder(t);

  // Act
  const segments = segmentsOf(app);

  // Assert
  assert.equal(segments.length, 4, segments.map((segment) => segment.valueText).join(' | '));
  assert.match(segments[1].valueText, /concrete pour starts on Tuesday morning/i);
  for (const segment of segments) {
    assert.equal(segment.path, 'site-visit.mp4');
    assert.equal(segment.anchor.kind, 'video-time');
    assert.ok(segment.anchor.end > segment.anchor.start, `${segment.anchor.start} to ${segment.anchor.end}`);
  }
  assert.ok(Math.abs(segments[1].anchor.start - 1.56) < TIME_TOLERANCE, String(segments[1].anchor.start));
  assert.ok(segments.every((segment, index) => index === 0 || segment.anchor.start >= segments[index - 1].anchor.end - 0.01));
});

test('A QuickTime movie is transcribed like an MPEG-4 video', { skip: !canTranscribe }, async (t) => {
  // Arrange
  const { app } = await videoFolder(t, { video: MOVIE_FIXTURE });

  // Act
  const segments = segmentsOf(app);
  const { quoted } = await candidates(app, "Then: 'crane arrives at noon'");

  // Assert
  assert.equal(segments.length, 4, segments.map((segment) => segment.valueText).join(' | '));
  assert.ok(segments.every((segment) => segment.path === 'site-visit.mov'));
  assert.equal(quoted.length, 1);
  assert.ok(Math.abs(quoted[0].anchor.time - 6.18) < TIME_TOLERANCE, String(quoted[0].anchor.time));
});

test('A phrase typed in double quotes suggests the video at the moment it is said', { skip: !canTranscribe }, async (t) => {
  // Arrange
  const { app } = await videoFolder(t);

  // Act
  const { quoted, all } = await candidates(app, 'In the walkthrough he says "concrete pour starts"');

  // Assert
  assert.equal(quoted.length, 1, JSON.stringify(quoted.map((candidate) => candidate.label)));
  const [video] = quoted;
  assert.equal(video.path, 'site-visit.mp4');
  assert.equal(all[0].id, video.id, 'the quoted video is the first suggestion');
  assert.equal(video.ranking.tier, 0);
  assert.ok(Math.abs(video.anchor.time - 2.34) < TIME_TOLERANCE, String(video.anchor.time));
  assert.equal(video.quotedPhrase, 'concrete pour starts');
  assert.match(video.completionText, /site-visit\.mp4, 0:02/);
});

test('A phrase typed in single or curly quotes suggests the video at its own time', { skip: !canTranscribe }, async (t) => {
  // Arrange
  const { app } = await videoFolder(t);

  // Act
  const single = await candidates(app, "Then: 'crane arrives at noon'");
  const curly = await candidates(app, 'The inspector said “the north stairwell”');

  // Assert
  assert.equal(single.quoted.length, 1);
  assert.ok(Math.abs(single.quoted[0].anchor.time - 6.18) < TIME_TOLERANCE, String(single.quoted[0].anchor.time));
  assert.equal(curly.quoted.length, 1);
  assert.ok(curly.quoted[0].anchor.time > 8.5 && curly.quoted[0].anchor.time < 10, String(curly.quoted[0].anchor.time));
});

test('A quoted phrase no video says falls back to the usual suggestions', { skip: !canTranscribe }, async (t) => {
  // Arrange
  const { app } = await videoFolder(t, { extra: { 'notes.txt': 'The concrete pour schedule moved to Thursday.\n' } });

  // Act
  const { quoted, all } = await candidates(app, 'He said "concrete pour schedule"');

  // Assert
  assert.deepEqual(quoted, []);
  assert.ok(!all.some((candidate) => candidate.anchor?.time != null), 'no video moment is offered');
});

test('Unquoted text still offers what it offered before', { skip: !canTranscribe }, async (t) => {
  // Arrange
  const notes = { 'notes.txt': 'The concrete pour schedule moved to Thursday.\n' };
  const { app } = await videoFolder(t, { extra: notes });
  const plainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-video-plain-'));
  fs.writeFileSync(path.join(plainRoot, 'notes.txt'), notes['notes.txt']);
  const plain = createApplication({ dataDir: path.join(plainRoot, '.state'), watchProjects: false });
  t.after(async () => { await plain.close(); fs.rmSync(plainRoot, { recursive: true, force: true }); });
  await plain.workspace.add([plainRoot], { id: 'system:video-plain', displayName: 'Plain', actorType: 'SYSTEM' });

  // Act
  const withVideo = await candidates(app, 'The concrete pour schedule');
  const withoutVideo = await candidates(plain, 'The concrete pour schedule');

  // Assert
  assert.deepEqual(withVideo.quoted, []);
  const notesLabels = (result) => result.all.filter((candidate) => candidate.path === 'notes.txt').map((candidate) => candidate.label);
  assert.deepEqual(notesLabels(withVideo), notesLabels(withoutVideo));
  assert.ok(notesLabels(withVideo).length > 0, 'the note is still offered');
});

test('A video is transcribed once, and not again on re-indexing or restarting', { skip: !canTranscribe }, async (t) => {
  // Arrange
  const before = transcriptionRuns();
  const { app, root, state } = await videoFolder(t);
  const afterFirst = transcriptionRuns();

  // Act: the same video under a second name, then a restart over the same state
  fs.copyFileSync(FIXTURE, path.join(root, 'site-visit copy.mp4'));
  const actor = { id: 'system:video', displayName: 'Video test', actorType: 'SYSTEM' };
  const [project] = app.workspace.activeProjects();
  app.timeline.capture(project.id, actor);
  const copies = segmentsOf(app).filter((segment) => segment.path === 'site-visit copy.mp4');
  await app.close();
  const restarted = createApplication({ dataDir: state, watchProjects: false });
  t.after(() => restarted.close());
  restarted.dependencies.reindex(project.id, actor, { reason: 'read the folder again' });
  const reread = segmentsOf(restarted);

  // Assert
  assert.equal(afterFirst - before, 1);
  assert.equal(copies.length, 4, 'the copy has the same segments');
  assert.equal(reread.length, 8, 'both clips keep their segments after re-reading');
  assert.equal(transcriptionRuns(), afterFirst, 'no video was heard twice');
});

test('The card preview of a quoted video starts at the phrase', { skip: !canTranscribe }, async (t) => {
  // Arrange
  const { app } = await videoFolder(t);
  const { quoted } = await candidates(app, 'He says "concrete pour starts"');
  const server = await new Promise((resolve) => { const listening = app.server.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const [video] = quoted;

  // Act
  const query = new URLSearchParams({ version: video.versionId, context: 'wide', text: video.quotedPhrase });
  const response = await fetch(`http://127.0.0.1:${port}/api/dependency-objects/${video.id}/preview?${query}`);
  const body = await response.json();

  // Assert
  assert.equal(response.status, 200);
  assert.equal(body.preview.kind, 'video');
  assert.ok(Math.abs(body.preview.openAt.time - 2.34) < TIME_TOLERANCE, String(body.preview.openAt.time));
  assert.equal(body.preview.selectedText, 'concrete pour starts');
  assert.ok(path.isAbsolute(body.preview.localPath) && body.preview.localPath.endsWith('site-visit.mp4'));
  assert.match(body.preview.text, /The concrete pour starts on Tuesday morning\./);
});
