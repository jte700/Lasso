import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { createShareHandlers } from '../website/lib/shares.mjs';

function memoryStore() {
  const values = new Map();
  return async commands => commands.map(([op, key, ...args]) => {
    if (op === 'INCR') { const n = Number(values.get(key) || 0) + 1; values.set(key, n); return n; }
    if (op === 'EXPIRE') return 1;
    if (op === 'GET') return values.get(key) ?? null;
    if (op === 'SET') {
      if (args.includes('NX') && values.has(key)) return null;
      values.set(key, args[0]); return 'OK';
    }
    if (op === 'EVAL') {
      // The revocation script compares the owner hash and retains a tombstone.
      const stored = JSON.parse(values.get(args[1]) || 'null');
      if (!stored) return 0;
      if (stored.owner !== args[2]) return -1;
      values.set(args[1], JSON.stringify({ ...stored, assets: undefined, revoked: true }));
      return 1;
    }
    throw new Error(`Unsupported test command ${op}`);
  });
}

const origin = 'https://mylasso.ca';
const token = 'a'.repeat(32);
const secret = 'b'.repeat(43);
const payload = () => ({ token, expiresAt: new Date(Date.now() + 3600_000).toISOString(), assets: [
  { path: '', contentType: 'text/html; charset=utf-8', body: Buffer.from('<h1>Shared source</h1>').toString('base64') },
] });
const post = (body, owner = secret) => new Request(`${origin}/api/shares`, { method: 'POST', headers: {
  'content-type': 'application/json', authorization: `Bearer ${owner}`,
}, body: JSON.stringify(body) });
const get = (key = token, asset = '') => new Request(`${origin}/api/shared?token=${key}&asset=${encodeURIComponent(asset)}`);

test('hosted shares require a separate owner key, are immutable, and revoke every asset', async () => {
  const handlers = createShareHandlers({ run: memoryStore() });
  const body = payload();
  assert.equal((await handlers.POST(post(body))).status, 201);
  assert.equal((await handlers.POST(post(body))).status, 201, 'network retries are idempotent');
  assert.equal((await handlers.POST(post({ ...body, assets: [{ ...body.assets[0], body: Buffer.from('changed').toString('base64') }] }))).status, 409);
  assert.equal((await handlers.POST(post(body, 'c'.repeat(43)))).status, 409);
  const response = await handlers.GET(get());
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Shared source/);
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const revoke = owner => new Request(`${origin}/api/shares?token=${token}`, { method: 'DELETE', headers: { authorization: `Bearer ${owner}` } });
  assert.equal((await handlers.DELETE(revoke(token))).status, 401);
  assert.equal((await handlers.DELETE(revoke('c'.repeat(43)))).status, 404);
  assert.equal((await handlers.DELETE(revoke(secret))).status, 200);
  assert.equal((await handlers.DELETE(revoke(secret))).status, 200);
  assert.equal((await handlers.GET(get())).status, 410);
  assert.equal((await handlers.GET(get(token, 'download'))).status, 410);
  assert.equal((await handlers.POST(post(body))).status, 409, 'a revoked URL cannot be recreated');
});

test('hosting refuses malformed, expired, oversized and browser uploads', async () => {
  const handlers = createShareHandlers({ run: memoryStore() });
  for (const body of [null, [], { ...payload(), token: '../invalid' }, { ...payload(), expiresAt: 'bad' },
    { ...payload(), expiresAt: new Date(Date.now() - 1000).toISOString() },
    { ...payload(), expiresAt: new Date(Date.now() + 49 * 3600_000).toISOString() },
    { ...payload(), assets: [{ ...payload().assets[0], path: '../source' }] },
    { ...payload(), assets: [{ ...payload().assets[0], body: 'invalid-base64!' }] }]) {
    assert.equal((await handlers.POST(post(body))).status, 400);
  }
  const browser = post(payload()); browser.headers.set('origin', 'https://evil.example');
  assert.equal((await handlers.POST(browser)).status, 403);
  assert.equal((await handlers.POST(post({ ...payload(), assets: [{ ...payload().assets[0], body: 'A'.repeat(4_000_000) }] }))).status, 413);
  assert.equal((await handlers.GET(get('z'.repeat(32)))).status, 404);
  assert.equal((await handlers.GET(get('../invalid'))).status, 404);
  const unavailable = createShareHandlers({ run: null });
  assert.equal((await unavailable.POST(post(payload()))).status, 503);
});

test('the desktop publishes only the selected content and revokes it on the website', async t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-hosted-'));
  const root = path.join(sandbox, 'Private Folder'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Budget.csv'), 'Account,Value\nSecret payroll,777\nPublic cost,123\n');
  const handlers = createShareHandlers({ run: memoryStore() });
  let uploaded;
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false,
    shareBaseUrl: origin, shareFetch: async (url, options) => {
      if (options.method === 'POST') uploaded = JSON.parse(options.body);
      return handlers[options.method](new Request(url, options));
    } });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, { id: 'owner', displayName: 'Owner', actorType: 'HUMAN_SELF' }, { watch: false });
  const cell = app.dependencies.objectsAt(project.id).find(o => o.anchor?.kind === 'table-cell' && o.valueText === '123');
  assert.ok(cell);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${app.config.port}`;
  const response = await fetch(`${local}/api/projects/${project.id}/object-shares`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ objectId: cell.id, versionId: cell.versionId, accessScope: 'INDEXED' }) });
  assert.equal(response.status, 201, await response.clone().text());
  const { share } = await response.json();
  assert.equal(share.url, `${origin}/d/${share.token}`);
  assert.equal(uploaded.assets.some(asset => asset.path === 'download'), false);
  const publishedText = uploaded.assets.map(asset => Buffer.from(asset.body, 'base64').toString()).join('\n');
  assert.match(publishedText, /123/);
  assert.doesNotMatch(publishedText, /Secret payroll|777|Private Folder|revoke_secret|absolutePath/);
  assert.equal((await handlers.GET(get(share.token))).status, 200);
  assert.equal((await handlers.GET(get(share.token, 'download'))).status, 404);
  const revoked = await fetch(`${local}/api/object-shares/${share.token}/revoke`, { method: 'POST' });
  assert.equal(revoked.status, 200);
  assert.equal((await handlers.GET(get(share.token))).status, 410);
});

test('expiry is enforced on every asset even before Redis removes the record', async () => {
  let time = Date.now();
  const handlers = createShareHandlers({ run: memoryStore(), now: () => time });
  const body = payload();
  body.expiresAt = new Date(time + 60_000).toISOString();
  body.assets.push({ path: 'download', contentType: 'text/html', disposition: 'attachment; filename="source.html"', body: Buffer.from('<script>alert(1)</script>').toString('base64') });
  assert.equal((await handlers.POST(post(body))).status, 201);
  const download = await handlers.GET(get(token, 'download'));
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  time += 60_001;
  assert.equal((await handlers.GET(get())).status, 410);
  assert.equal((await handlers.GET(get(token, 'download'))).status, 410);
});

test('upload limits are enforced across requests', async () => {
  const handlers = createShareHandlers({ run: memoryStore() });
  const body = payload();
  for (let i = 0; i < 30; i++) assert.equal((await handlers.POST(post(body))).status, 201);
  assert.equal((await handlers.POST(post(body))).status, 429);
  assert.equal((await handlers.GET(get())).status, 200, 'limits do not disable existing links');
});

test('hosted state survives restart, failed revocation stays retryable, and failed publication returns no link', async t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-publish-'));
  const root = path.join(sandbox, 'Finance'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Budget.csv'), 'Account,Value\nSecret payroll,777\nPublic cost,123\n');
  const handlers = createShareHandlers({ run: memoryStore() });
  const urls = [];
  let mode = 'ok';
  let lastToken;
  const shareFetch = async (url, options) => {
    urls.push(url);
    if (options.method === 'DELETE' && mode === 'revoke-failure') throw new Error('offline');
    if (options.method === 'POST') lastToken = JSON.parse(options.body).token;
    const response = await handlers[options.method](new Request(url, options));
    if (options.method === 'POST' && mode === 'lost-response') throw new Error('connection lost after upload');
    return response;
  };
  const config = { dataDir: path.join(sandbox, 'history'), watchProjects: false, shareBaseUrl: origin, shareFetch };
  let app = createApplication(config);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, { id: 'owner', displayName: 'Owner', actorType: 'HUMAN_SELF' }, { watch: false });
  const cell = app.dependencies.objectsAt(project.id).find(o => o.anchor?.kind === 'table-cell' && o.valueText === '123');
  const options = { projectId: project.id, objectId: cell.id, versionId: cell.versionId };
  const original = await app.objectShares.createPublishedShare({ ...options, accessScope: 'DOCUMENT' });
  assert.match(await (await handlers.GET(get(original.token, 'download'))).text(), /Secret payroll,777/);
  const redacted = await app.objectShares.createPublishedShare({ ...options, accessScope: 'REDACTED', redactions: [
    { kind: 'CELL', sheet: 0, row: 1, column: 0, effect: 'BLANK' },
    { kind: 'CELL', sheet: 0, row: 1, column: 1, effect: 'BLANK' },
  ] });
  for (const asset of ['', 'excerpt']) {
    const response = await handlers.GET(get(redacted.token, asset));
    assert.equal(response.status, 200);
    assert.doesNotMatch(await response.text(), /Secret payroll|777/);
  }
  assert.equal((await handlers.GET(get(redacted.token, 'download'))).status, 404);
  await app.close();
  assert.equal((await handlers.GET(get(original.token))).status, 200, 'works without the sender running');
  app = createApplication({ ...config, shareBaseUrl: 'https://another.example' });
  assert.equal(app.objectShares.shareUrl(original.token), original.url);
  mode = 'revoke-failure';
  await assert.rejects(app.objectShares.revokeShare(original.token), /Cannot reach/);
  assert.equal(app.objectShares.resolveShare(original.token).status, 'OK', 'do not claim revocation before the host confirms');
  mode = 'ok';
  await app.objectShares.revokeShareById(original.id);
  assert.equal(urls.at(-1), `${origin}/api/shares?token=${original.token}`, 'the saved host is used');
  assert.equal((await handlers.GET(get(original.token))).status, 410);
  mode = 'lost-response';
  await assert.rejects(app.objectShares.createPublishedShare({ ...options, accessScope: 'INDEXED' }), /Cannot reach/);
  assert.equal(app.objectShares.resolveShare(lastToken).status, 'REVOKED');
  assert.equal((await handlers.GET(get(lastToken))).status, 410, 'an ambiguous upload is revoked');
  assert.equal(JSON.stringify(app.objectShares.listShares(project.id)).includes('revoke_secret'), false);
});

test('remote missing or unauthorized responses cannot be mistaken for a successful local revocation', async () => {
  const { HostedSharePublisher } = await import('../src/sharing/hosted-share.js');
  for (const status of [401, 403, 404, 409, 503]) {
    const publisher = new HostedSharePublisher({ config: { shareFetch: async () => new Response('', { status }) } });
    await assert.rejects(publisher.revoke(token, { origin, revoke_secret: secret }), error => error.status === 502);
  }
});

test('upgrading the earlier sharing migration preserves management keys and installs retention', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { openDatabase } = await import('../src/db.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-sharing-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'history.sqlite');
  let db = new DatabaseSync(databasePath);
  for (const file of fs.readdirSync('migrations').sort().filter(file => Number(file.split('_')[0]) <= 26)) {
    db.exec(fs.readFileSync(path.join('migrations', file), 'utf8'));
  }
  db.exec(fs.readFileSync('migrations/031_hosted_shares.sql', 'utf8').replace('VALUES (31,', 'VALUES (27,'));
  db.close();
  db = openDatabase({ databasePath });
  try {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'released_blobs'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'object_share_publications'").get());
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 31);
  } finally { db.close(); }
});
