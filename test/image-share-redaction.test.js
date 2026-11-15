import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { offeredShareScopes } from '../src/sharing/object-share.js';
import { shareBundle } from '../src/sharing/hosted-share.js';
import { legacyCitedShare } from './fixtures/legacy-shares.js';
import { readPng, writePng } from './fixtures/png.js';

const actor = { id: 'human:image-shares', displayName: 'Image share test', actorType: 'HUMAN_SELF' };
const RED = [220, 30, 30], BLUE = [20, 40, 210];
// Red on the left, blue on the right, and a comment no shared copy may carry.
const photo = () => writePng(40, 20, (x) => (x < 20 ? RED : BLUE), { text: 'SECRET-CAMERA-NOTE' });
const rightHalf = (effect) => ({ kind: 'IMAGE', effect, x: 0.5, y: 0, width: 0.5, height: 1 });

async function sharedFolder(t, write) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-image-shares-'));
  const root = path.join(temporary, 'Project'); fs.mkdirSync(root);
  write(root);
  const app = createApplication({ shareBaseUrl: 'http://localhost:4317', dataDir: path.join(temporary, 'history'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  app.dependencies.ensureIndex(project.id);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const share = (object, accessScope, redactions = []) => fetch(`${base}/api/projects/${project.id}/object-shares`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ objectId: object.id, versionId: object.versionId, accessScope, redactions, actor }),
  });
  return { app, project, base, share, objects: app.dependencies.objectsAt(project.id) };
}

const near = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) <= 24);

test('A picture is shared whole or redacted, never as a cited part', () => {
  // Assert
  for (const filename of ['Site.png', 'Photo.JPG', 'Scan.jpeg', 'Chart.gif', 'Shot.webp', 'Survey.tiff']) {
    assert.deepEqual(offeredShareScopes(filename, {}), ['DOCUMENT', 'REDACTED'], filename);
  }
});

test('A 2D drawing is shared whole or redacted, never as a cited part', () => {
  // Assert
  assert.deepEqual(offeredShareScopes('Plan.dxf', {}), ['DOCUMENT', 'REDACTED']);
  assert.deepEqual(offeredShareScopes('Duplex.ifc', {}), ['DOCUMENT', 'REDACTED']);
  assert.ok(offeredShareScopes('Bracket.step', {}).includes('INDEXED'), 'a 3D model keeps its cited part');
});

test('A redacted picture shows its masks burned into a fresh copy, and never the original', async (t) => {
  // Arrange
  const { base, objects, share } = await sharedFolder(t, (root) => fs.writeFileSync(path.join(root, 'Site.png'), photo()));
  const picture = objects.find((object) => object.path === 'Site.png');

  // Act
  const created = await share(picture, 'REDACTED', [rightHalf('BLANK')]);
  const { share: link } = await created.json();
  const page = await (await fetch(`${base}/d/${link.token}`)).text();
  const source = await fetch(`${base}/d/${link.token}/source`);
  const bytes = Buffer.from(await source.arrayBuffer());
  const shown = readPng(bytes);

  // Assert: the page shows the redacted copy
  assert.equal(created.status, 201);
  assert.match(page, new RegExp(`<img class="shared-image" src="/d/${link.token}/source"`));
  assert.match(page, /Redacted copy/);
  assert.doesNotMatch(page, /Download original/);

  // Assert: the copy keeps the left half and hides the right
  assert.equal(source.status, 200);
  assert.equal(source.headers.get('content-type'), 'image/png');
  assert.equal(source.headers.get('cache-control'), 'no-store');
  assert.ok(near(shown.pixel(Math.round(shown.width * 0.2), Math.round(shown.height / 2)), RED), 'the unmasked half is the picture');
  const masked = shown.pixel(Math.round(shown.width * 0.8), Math.round(shown.height / 2));
  assert.ok(!near(masked, BLUE), `the masked half no longer shows the picture (${masked})`);
  assert.ok(!bytes.includes('SECRET-CAMERA-NOTE'), 'the picture’s own metadata is left behind');

  // Assert: the original stays private, and the download is the same copy
  assert.equal((await fetch(`${base}/d/${link.token}/download`)).status, 403);
  const download = await fetch(`${base}/d/${link.token}/excerpt`);
  assert.equal(download.headers.get('content-type'), 'image/png');
  assert.match(download.headers.get('content-disposition'), /Site-redacted-v\d+\.png/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
});

test('A blurred area of a picture carries none of its pixels', async (t) => {
  // Arrange
  const { base, objects, share } = await sharedFolder(t, (root) => fs.writeFileSync(path.join(root, 'Site.png'), photo()));
  const picture = objects.find((object) => object.path === 'Site.png');

  // Act
  const { share: link } = await (await share(picture, 'REDACTED', [rightHalf('BLUR')])).json();
  const shown = readPng(Buffer.from(await (await fetch(`${base}/d/${link.token}/source`)).arrayBuffer()));

  // Assert
  for (const [fx, fy] of [[0.6, 0.2], [0.8, 0.5], [0.95, 0.9]]) {
    const pixel = shown.pixel(Math.round(shown.width * fx), Math.round(shown.height * fy));
    const [r, g, b] = pixel;
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 24, `the blur is grey, not a softened picture (${pixel})`);
  }
});

test('A hosted redacted picture uploads the redacted copy as its only file', async (t) => {
  // Arrange
  const { app, objects, share } = await sharedFolder(t, (root) => fs.writeFileSync(path.join(root, 'Site.png'), photo()));
  const picture = objects.find((object) => object.path === 'Site.png');
  const { share: link } = await (await share(picture, 'REDACTED', [rightHalf('BLANK')])).json();

  // Act
  const bundle = JSON.parse(await shareBundle(app.objectShares.publisher.handler, link));

  // Assert
  const source = bundle.assets.find((asset) => asset.path === 'source');
  assert.equal(source.contentType, 'image/png');
  assert.ok(!Buffer.from(source.body, 'base64').includes('SECRET-CAMERA-NOTE'));
  assert.ok(!bundle.assets.some((asset) => asset.path === 'download'));
});

test('Picture redactions are checked against the picture', async (t) => {
  // Arrange
  const { objects, share } = await sharedFolder(t, (root) => {
    fs.writeFileSync(path.join(root, 'Site.png'), photo());
    fs.writeFileSync(path.join(root, 'Notes.txt'), 'The crane arrives on Monday.\n');
  });
  const picture = objects.find((object) => object.path === 'Site.png');
  const note = objects.find((object) => object.path === 'Notes.txt');

  // Act
  const statuses = await Promise.all([
    share(picture, 'INDEXED'),
    share(picture, 'REDACTED', [{ kind: 'CELL', row: 0, column: 0, effect: 'BLUR' }]),
    share(picture, 'REDACTED', [{ ...rightHalf('BLUR'), kind: 'DRAWING' }]),
    share(picture, 'REDACTED', [{ ...rightHalf('BLUR'), x: 0.8 }]),
    share(picture, 'REDACTED', []),
    share(note, 'REDACTED', [rightHalf('BLUR')]),
  ].map(async (pending) => (await pending).status));

  // Assert
  assert.deepEqual(statuses, [422, 400, 400, 400, 400, 400]);
});

test('A cited-part link made of a picture before pictures lost it still opens', async (t) => {
  // Arrange
  const { app, project, base, objects } = await sharedFolder(t, (root) => fs.writeFileSync(path.join(root, 'Site.png'), photo()));
  const picture = objects.find((object) => object.path === 'Site.png');
  const old = legacyCitedShare(app, { projectId: project.id, object: picture, actor });

  // Act
  const response = await fetch(`${base}/d/${old.token}`);

  // Assert
  assert.equal(response.status, 200);
  assert.equal((await fetch(`${base}/d/${old.token}/download`)).status, 403);
});
