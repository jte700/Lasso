import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../src/server.js';
import { detectFileType } from '../src/history/file-types.js';
import { quotedPhraseAtCaret } from '../src/dependencies/quoted-phrase.js';
import { transcriptDisplayLines, transcriptExcerpts } from '../src/dependencies/video-extraction.js';
import { transcriptionRuns } from '../src/dependencies/video-extraction.js';
import { offeredShareScopes } from '../src/sharing/object-share.js';

// A 10-second clip whose sound track says, about three seconds apart:
//   0.00 "Welcome to the site visit."
//   1.56 "The concrete pour starts on Tuesday morning."   ("concrete" at 2.34)
//   4.62 "The contractor's crane arrives at noon."        ("crane" at 6.18)
//   7.68 "We found cracks near the north stairwell."      ("north" at about 9.5)
const FIXTURE = fileURLToPath(new URL('./fixtures/videos/site-visit.mp4', import.meta.url));
// The same clip in a QuickTime movie, which macOS tells apart only by its extension.
const MOVIE_FIXTURE = fileURLToPath(new URL('./fixtures/videos/site-visit.mov', import.meta.url));
// Two seconds of picture: one with a silent sound track, one with no sound track at all.
const SILENT_FIXTURE = fileURLToPath(new URL('./fixtures/videos/silent.mp4', import.meta.url));
const NO_SOUND_FIXTURE = fileURLToPath(new URL('./fixtures/videos/no-sound.mp4', import.meta.url));
// On-device transcription needs macOS 26 (Darwin 25) and its speech model.
// Build machines without the model, such as GitHub's, set
// LASSO_TRANSCRIPTION=unavailable to skip these tests.
const canTranscribe = process.platform === 'darwin' && Number(os.release().split('.')[0]) >= 25
  && process.env.LASSO_TRANSCRIPTION !== 'unavailable';
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

test('A phrase still being typed after an opening quote is found, its last word unfinished', () => {
  // Arrange
  const cases = [
    ['He said "fire inspection is boo', 'fire inspection is boo', 'double'],
    ['She noted “north stair', 'north stair', 'double'],
    ["It's 'crane arr", 'crane arr', 'single'],
    ['Earlier "a quote" and then "concrete pour ', 'concrete pour', 'double'],
  ];

  // Act
  const found = cases.map(([text]) => quotedPhraseAtCaret(text, text.length));

  // Assert
  assert.deepEqual(found.map((quoted) => [quoted?.phrase, quoted?.quote, quoted?.open]),
    cases.map(([, phrase, quote]) => [phrase, quote, true]));
});

test('Text with no quote open or just closed at the caret has no quoted phrase', () => {
  // Arrange
  const texts = [
    'The concrete pour starts',
    "The contractor's crane arrives",
    '"concrete pour starts" was said, and then',
    'He said ""',
    'He said "the',
    'He said "',
    "The contractor’s crane",
  ];

  // Act
  const found = texts.map((text) => quotedPhraseAtCaret(text, text.length));

  // Assert
  assert.deepEqual(found, [null, null, null, null, null, null, null]);
});

test('A short video is transcribed into timed segments', { skip: !canTranscribe }, async (t) => {
  // Arrange
  const { app } = await videoFolder(t);

  // Act
  const segments = segmentsOf(app);

  // Assert: a clip under a minute is cut into five-second excerpts
  assert.ok(segments.length >= 2 && segments.length <= 3, segments.map((segment) => segment.valueText).join(' | '));
  assert.match(segments[0].valueText, /^Welcome to the site visit\. The concrete pour starts on Tuesday morning\./);
  for (const [index, segment] of segments.entries()) {
    assert.equal(segment.path, 'site-visit.mp4');
    assert.equal(segment.anchor.kind, 'video-time');
    assert.equal(segment.anchor.start, index * 5);
    assert.ok(segment.anchor.end > segment.anchor.start && segment.anchor.end <= segment.anchor.start + 5);
  }
});

test('A QuickTime movie is transcribed like an MPEG-4 video', { skip: !canTranscribe }, async (t) => {
  // Arrange
  const { app } = await videoFolder(t, { video: MOVIE_FIXTURE });

  // Act
  const segments = segmentsOf(app);
  const { quoted } = await candidates(app, "Then: 'crane arrives at noon'");

  // Assert
  assert.ok(segments.length >= 2, segments.map((segment) => segment.valueText).join(' | '));
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
  const excerpts = segmentsOf(app).length;

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
  assert.equal(copies.length, excerpts, 'the copy has the same excerpts');
  assert.equal(reread.length, 2 * excerpts, 'both clips keep their excerpts after re-reading');
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

async function listening(t, app) {
  const server = await new Promise((resolve) => { const started = app.server.listen(0, '127.0.0.1', () => resolve(started)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('A video is shared whole, never redacted or cut to the cited part', () => {
  // Arrange
  const anchor = { kind: 'video-time', start: 1.56, end: 4.62 };

  // Act
  const scopes = ['site-visit.mp4', 'clips/Interview.MOV', 'Lecture.m4v'].map((file) => offeredShareScopes(file, anchor));

  // Assert
  assert.deepEqual(scopes, [['DOCUMENT'], ['DOCUMENT'], ['DOCUMENT']]);
});

test('The source inspector plays a linked video from the moment it cites', { skip: !canTranscribe }, async (t) => {
  // Arrange
  const { app } = await videoFolder(t);
  const [video] = (await candidates(app, 'He says "concrete pour starts"')).quoted;
  const base = await listening(t, app);
  const inspect = (extra) => fetch(`${base}/inspect?${new URLSearchParams({ object: video.id, version: video.versionId, ...extra })}`)
    .then((response) => response.text());

  // Act
  const atMoment = await inspect({ time: String(video.anchor.time) });
  const atSentence = await inspect({});
  const nonsense = await inspect({ time: '-4' });

  // Assert
  const source = `/api/dependency-objects/${video.id}/video?version=${video.versionId}`;
  assert.match(atMoment, new RegExp(`<video[^>]+src="${source.replace(/[?]/g, '\\?')}#t=${video.anchor.time}"`));
  assert.match(atMoment, /"openAt":\{"time":2\.\d+\}/, 'Open Source goes to the quoted moment');
  assert.match(atMoment, /The concrete pour starts on Tuesday morning\./, 'the transcript is shown');
  assert.doesNotMatch(atMoment, /cannot be displayed inline/);
  assert.match(atSentence, new RegExp(`"openAt":\\{"time":${video.anchor.start}\\}`), 'without a time, the sentence start');
  assert.match(nonsense, new RegExp(`"openAt":\\{"time":${video.anchor.start}\\}`), 'a bad time is ignored');
});

test('A linked video is served in byte ranges, as players ask for it', { skip: !canTranscribe }, async (t) => {
  // Arrange
  const { app } = await videoFolder(t);
  const [video] = (await candidates(app, 'He says "concrete pour starts"')).quoted;
  const base = await listening(t, app);
  const url = `${base}/api/dependency-objects/${video.id}/video?version=${video.versionId}`;
  const size = fs.statSync(FIXTURE).size;

  // Act
  const whole = await fetch(url);
  const part = await fetch(url, { headers: { range: 'bytes=100-199' } });
  const tail = await fetch(url, { headers: { range: 'bytes=-10' } });
  const outside = await fetch(url, { headers: { range: `bytes=${size + 5}-` } });

  // Assert
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal(whole.headers.get('content-type'), 'video/mp4');
  assert.equal((await whole.arrayBuffer()).byteLength, size);
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 100-199/${size}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), fs.readFileSync(FIXTURE).subarray(100, 200));
  assert.equal(tail.status, 206);
  assert.equal((await tail.arrayBuffer()).byteLength, 10);
  assert.equal(outside.status, 416);
});

test('A phrase typed after an opening quote suggests the video before the quote is closed', { skip: !canTranscribe }, async (t) => {
  // Arrange
  const { app } = await videoFolder(t);

  // Act
  const typing = await candidates(app, 'He said "concrete pour sta');

  // Assert
  assert.equal(typing.quoted.length, 1);
  const [video] = typing.quoted;
  assert.equal(typing.all[0].id, video.id, 'the video comes before a sentence completion');
  assert.ok(Math.abs(video.anchor.time - 2.34) < TIME_TOLERANCE, String(video.anchor.time));
  assert.deepEqual(video.matchedWords, ['concrete', 'pour', 'starts'], 'only the quoted words are marked');
  assert.equal(video.completionText, 'rts on Tuesday morning." (site-visit.mp4, 0:02)',
    'accepting finishes the spoken sentence, closes the quote and cites the moment');
});

test('The whole video offers none of its transcript as a sentence to continue', { skip: !canTranscribe }, async (t) => {
  // Arrange
  const { app } = await videoFolder(t);
  const [project] = app.workspace.activeProjects();

  // Act
  const whole = app.dependencies.objectsAt(project.id, null, ['DOCUMENT'])
    .find((object) => object.metadata.componentType === 'VIDEO');
  const { prediction } = await candidates(app, 'The concrete pour starts');

  // Assert
  assert.equal(whole.valueText, null);
  assert.notEqual(prediction.completion?.dependencyCandidate?.id ?? null, whole.id);
});

test('A preview of a sentence that names no quoted words starts at that sentence', { skip: !canTranscribe }, async (t) => {
  // Arrange
  const { app } = await videoFolder(t);
  const base = await listening(t, app);
  const crane = segmentsOf(app)[1];

  // Act
  const body = await fetch(`${base}/api/dependency-objects/${crane.id}/preview?${new URLSearchParams({ version: crane.versionId, text: 'for the 15th.' })}`)
    .then((response) => response.json());

  // Assert
  assert.equal(body.preview.openAt.time, crane.anchor.start);
  assert.deepEqual(body.preview.lines.filter((line) => line.cited).map((line) => line.value), [`[0:05] ${crane.valueText}`]);
});

test('Stretches no speech was heard in are shown as lines that say so', () => {
  // Arrange
  const transcript = { status: 'ok', duration: 70, segments: [
    { start: 0, end: 4, text: 'Welcome.', words: [] },
    { start: 40, end: 44, text: 'Back from the break.', words: [] },
  ] };

  // Act
  const lines = transcriptDisplayLines(transcript, 1);

  // Assert
  assert.deepEqual(lines.map((line) => [line.timestamp, line.text, line.cited]), [
    ['0:00', 'Welcome.', false],
    ['0:04', 'No speech could be transcribed from 0:04 to 0:40.', false],
    ['0:40', 'Back from the break.', true],
    ['0:44', 'No speech could be transcribed from 0:44 to 1:10.', false],
  ]);
  assert.ok(lines.filter((line) => !line.spoken).length === 2);
});

test('A video that cannot be transcribed is indexed by name and says why', { skip: !canTranscribe }, async (t) => {
  // Arrange
  const silent = await videoFolder(t, { video: SILENT_FIXTURE });
  const soundless = await videoFolder(t, { video: NO_SOUND_FIXTURE });
  const base = await listening(t, soundless.app);
  const wholeOf = (app) => app.dependencies.objectsAt(app.workspace.activeProjects()[0].id, null, ['DOCUMENT'])
    .filter((object) => object.path.startsWith('site-visit'));

  // Act
  const [quiet] = wholeOf(silent.app);
  const [none] = wholeOf(soundless.app);
  const preview = await fetch(`${base}/api/dependency-objects/${none.id}/preview?version=${none.versionId}`).then((response) => response.json());
  const inspector = await fetch(`${base}/inspect?${new URLSearchParams({ object: none.id, version: none.versionId })}`).then((response) => response.text());

  // Assert
  assert.equal(wholeOf(silent.app).length, 1, 'only the video itself');
  assert.equal(quiet.metadata.transcriptStatus, 'ok');
  assert.equal(none.metadata.transcriptStatus, 'no-audio');
  assert.deepEqual(preview.preview.lines.map((line) => line.value), ['Not transcribable: this video has no sound track to transcribe.']);
  assert.equal(preview.preview.openAt.time, 0);
  assert.match(inspector, /<video[^>]+#t=0"/);
  assert.match(inspector, /Not transcribable: this video has no sound track to transcribe\./);
});

test('A word typed after an opening quote completes the sentence it begins, not the whole excerpt', { skip: !canTranscribe }, async (t) => {
  // Arrange
  const { app } = await videoFolder(t);

  // Act
  const typed = await candidates(app, 'He said "crane ');

  // Assert
  assert.equal(typed.quoted.length, 1);
  assert.equal(typed.quoted[0].completionText, 'arrives at noon." (site-visit.mp4, 0:06)');
});

test('Excerpts are five seconds long up to a minute of video, and ten seconds past it', () => {
  // Arrange
  const words = (from, to) => Array.from({ length: (to - from) / 2 }, (_, index) => ({ text: `w${from + index * 2}`, start: from + index * 2, end: from + index * 2 + 1 }));
  const short = { status: 'ok', duration: 58, segments: [{ start: 0, end: 58, text: '', words: words(0, 58) }] };
  const long = { status: 'ok', duration: 95, segments: [{ start: 0, end: 30, text: '', words: words(0, 30) },
    { start: 60, end: 95, text: '', words: words(60, 94) }] };

  // Act
  const shortExcerpts = transcriptExcerpts(short);
  const longExcerpts = transcriptExcerpts(long);

  // Assert
  assert.deepEqual(shortExcerpts.slice(0, 2).map((excerpt) => [excerpt.start, excerpt.end, excerpt.text]),
    [[0, 5, 'w0 w2 w4'], [5, 10, 'w6 w8']]);
  assert.equal(shortExcerpts.length, 12);
  assert.deepEqual(longExcerpts.map((excerpt) => excerpt.start), [0, 10, 20, 60, 70, 80, 90], 'silent windows have no excerpt');
  assert.equal(longExcerpts.at(-1).end, 95);
});
