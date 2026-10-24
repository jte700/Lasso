import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { codeOfLines, fileLines, fileNameBefore, lineMentionAtEnd, lineMentionBeforeName } from '../src/dependencies/code-lines.js';

const actor = { id: 'human:code-lines', displayName: 'Code lines test', actorType: 'HUMAN_SELF' };

const SERVER = [
  "import http from 'node:http';",
  '',
  'export function start(port) {',
  '  const server = http.createServer(handle);',
  '  server.listen(port);',
  '  return server;',
  '}',
  '',
  'function handle(request, response) {',
  "  response.end('ok');",
  '}',
  '',
].join('\n');

test('a line or a range of lines is read from the words that name it', () => {
  const at = (text) => {
    const mention = lineMentionAtEnd(text, 0, text.length);
    return mention && [mention.first, mention.last];
  };
  assert.deepEqual(at('the bug is on line 42'), [42, 42]);
  assert.deepEqual(at('see line 42:'), [42, 42]);
  assert.deepEqual(at('Lines 10-20 '), [10, 20]);
  assert.deepEqual(at('line 10 through line 20'), [10, 20]);
  assert.deepEqual(at('lines 10 to 20'), [10, 20]);
  assert.deepEqual(at('line 10 thru 12'), [10, 12]);
  assert.equal(at('line 10 through'), null, 'a range waits for its last line');
  assert.equal(at('the outline 4'), null);
  assert.equal(at('line 42 has a bug'), null, 'the sentence went on');
  assert.equal(at('line 42.'), null);
  const before = 'Look at line 4 through 6 of ';
  assert.deepEqual([lineMentionBeforeName(before, before.length).first, lineMentionBeforeName(before, before.length).last], [4, 6]);
  assert.deepEqual(fileNameBefore('In src/app.py, ', 'In src/app.py, '.length), { name: 'src/app.py', start: 3 });
  assert.equal(fileNameBefore('In the app ', 'In the app '.length), null);
});

test('one line is inserted without its indentation, a range keeps its own', () => {
  const lines = fileLines(SERVER);
  assert.equal(lines.length, 11, 'the final line break ends the last line');
  assert.equal(codeOfLines(lines, 4, 4), 'const server = http.createServer(handle);');
  assert.equal(codeOfLines(lines, 3, 7), 'export function start(port) {\n  const server = http.createServer(handle);\n  server.listen(port);\n  return server;\n}');
  assert.equal(codeOfLines(lines, 4, 6), 'const server = http.createServer(handle);\nserver.listen(port);\nreturn server;');
});

async function project(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-code-lines-'));
  const root = path.join(sandbox, 'App');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'server.js'), SERVER);
  fs.writeFileSync(path.join(root, 'docker-compose.yaml'), 'services:\n  web:\n    image: app\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  await app.workspace.add([fs.realpathSync(root)], actor);
  const projectId = app.workspace.state().directories[0].id;
  const file = app.dependencies.objectsAt(projectId).find((object) => object.path === 'src/server.js' && object.metadata.codeFile);
  return { app, root: fs.realpathSync(root), projectId, file };
}

const link = (start, end, object) => ({ projectId: object.projectId, blockIndex: 0, start, end,
  sourceObjectId: object.id, sourceSnapshotId: object.snapshotId });
const ask = (app, text, pendingDependencies = []) => app.workspace.predict({ text, cursor: text.length, blockIndex: 0, pendingDependencies });

test('after a code file is accepted, "line N" offers that line and Tab inserts its code', async (t) => {
  // Arrange
  const { app, projectId, file } = await project(t);
  const typed = 'The server starts in server.js';
  const accepted = link(typed.length - 'server.js'.length, typed.length, file);

  // Act
  const named = await ask(app, 'The server starts in server.j');
  const one = await ask(app, `${typed} line 4`, [accepted]);
  const range = await ask(app, `${typed} lines 3 through 7`, [accepted]);
  const spelled = await ask(app, `${typed}, line 3 to line 5:`, [accepted]);

  // Assert
  assert.ok(named.claims.some((claim) => claim.candidates.some((candidate) => candidate.id === file.id)), 'a code file can be named');
  const line = one.workspaceCompletions[0];
  assert.equal(line.replacementText, 'const server = http.createServer(handle);');
  assert.equal(line.claimStart, `${typed} line 4`.length, 'inserted after the words, replacing nothing');
  assert.equal(line.claimEnd, line.claimStart);
  assert.equal(line.dependencyCandidate.label, 'Line 4');
  assert.deepEqual(line.dependencyCandidate.anchor, { kind: 'line-range', lineStart: 4, lineEnd: 4 });
  assert.equal(line.shareable, undefined);
  assert.equal(line.dependencyCandidate.shareable, false, 'code is never offered as a share link');
  assert.equal(one.workspaceHeading, 'Line 4 of server.js');
  assert.equal(one.sourceContext.source.id, file.id);
  const block = range.workspaceCompletions[0];
  assert.equal(block.replacementText, '\nexport function start(port) {\n  const server = http.createServer(handle);\n  server.listen(port);\n  return server;\n}');
  assert.equal(block.detail, '5 lines');
  assert.equal(block.label, 'export function start(port) { …');
  assert.equal(spelled.workspaceCompletions[0].dependencyCandidate.label, 'Lines 3–5');
  assert.match(app.dependencies.objectById(block.dependencyCandidate.id).objectKey, /:lines:3-7$/,
    'the lines are a source of their own');
  assert.equal(projectId, block.dependencyCandidate.projectId);
});

test('lines are found before the file, after its name written out, and after a line already inserted', async (t) => {
  // Arrange
  const { app, file } = await project(t);

  // Act
  const before = 'Look at line 10 of server.js';
  const ofFile = await ask(app, before, [link(before.length - 'server.js'.length, before.length, file)]);
  const written = await ask(app, 'In src/server.js line 5');
  const yaml = await ask(app, 'docker-compose.yaml lines 2-3');
  const first = (await ask(app, 'server.js line 4')).workspaceCompletions[0];
  const inserted = `server.js line 4 ${first.replacementText}`;
  const more = await ask(app, `${inserted} and line 5`, [link(inserted.length - first.replacementText.length, inserted.length, first.dependencyCandidate)]);

  // Assert
  assert.equal(ofFile.workspaceCompletions[0].replacementText, "response.end('ok');");
  assert.equal(written.workspaceCompletions[0].replacementText, 'server.listen(port);');
  assert.equal(yaml.workspaceCompletions[0].replacementText, '\nweb:\n  image: app');
  assert.equal(more.workspaceCompletions[0].replacementText, 'server.listen(port);', 'the next line of the same file');
});

test('a line that is not there, blank or still being typed offers nothing else', async (t) => {
  // Arrange
  const { app, file } = await project(t);
  const typed = 'In server.js';
  const accepted = [link(3, typed.length, file)];

  // Act
  const past = await ask(app, `${typed} line 99`, accepted);
  const blank = await ask(app, `${typed} line 2`, accepted);
  const typing = await ask(app, `${typed} lines 9 through 1`, accepted);
  const huge = await ask(app, `${typed} lines 1-900`, accepted);

  // Assert
  assert.deepEqual(past.workspaceCompletions, []);
  assert.equal(past.notice, 'server.js has 11 lines.');
  assert.equal(blank.notice, 'Line 2 of server.js is blank.');
  assert.deepEqual(typing.workspaceCompletions, []);
  assert.deepEqual(typing.claims, [], 'nothing else is offered while the range is typed');
  assert.equal(huge.notice, 'server.js has 11 lines.');
});

test('a linked line follows its line number through edits, and code is never shared', async (t) => {
  // Arrange
  const { app, root, projectId } = await project(t);
  app.server.listen(0, '127.0.0.1');
  await new Promise((resolve) => app.server.once('listening', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const line = (await ask(app, 'server.js lines 4-5')).workspaceCompletions[0].dependencyCandidate;

  // Act
  const preview = await (await fetch(`${base}/api/dependency-objects/${line.id}/preview?version=${line.versionId}`)).json();
  const shared = await fetch(`${base}/api/projects/${projectId}/object-shares`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ objectId: line.id, versionId: line.versionId, actor, accessScope: 'DOCUMENT' }) });
  const inspector = await fetch(`${base}/inspect?object=${line.id}&version=${line.versionId}&reference=r1`);
  const ranch = app.ranch.overview().sources.find((source) => source.path === 'src/server.js');
  fs.writeFileSync(path.join(root, 'src', 'server.js'), `// Entry point\n${SERVER}`);
  app.timeline.capture(projectId, actor);
  const after = app.dependencies.objectsAt(projectId).find((object) => object.objectKey === line.objectKey);

  // Assert
  assert.equal(preview.preview.location, 'Lines 4–5');
  assert.deepEqual(preview.preview.lines.filter((entry) => entry.cited).map((entry) => entry.lineNumber), [4, 5]);
  assert.deepEqual(preview.preview.openAt, { line: 4 });
  assert.deepEqual(preview.shareScopes, []);
  assert.equal(shared.status, 422);
  assert.equal(inspector.headers.get('x-lasso-shareable'), '0');
  assert.doesNotMatch(await inspector.text(), /data-action="share"/);
  assert.equal(ranch.shareable, false);
  assert.throws(() => app.ranch.shareTarget({ directoryId: projectId, path: 'src/server.js' }), /code files/);
  assert.equal(after.valueText, 'export function start(port) {\n  const server = http.createServer(handle);',
    'a later reading of the file records the same lines again');
});
