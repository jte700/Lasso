import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { application, network, settled } from './fixtures/connections.js';
import { storedZip } from './fixtures/workbook.js';
import { textPdf } from './fixtures/pdf.js';

const docx = (text) => storedZip({
  'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
});
const refusal = (status) => new Response(JSON.stringify({ error: { message: 'Refused' } }), { status });
const downloads = (calls, pattern) => calls.filter((call) => pattern.test(call.url)).length;

/** Signs a connection in through a fake provider and waits for its first sync. */
async function connect(t, { routes, provider, app: appId, registration, settings }) {
  const { fetch, calls } = network(routes);
  const { app, dataDir } = await application(t, fetch);
  await assert.rejects(app.connections.create({ provider }), /app registration/);
  app.connections.configureApp(appId, registration);
  const { connection, authorizeUrl } = await app.connections.create({ provider, settings });
  await app.connections.completeSignIn({ state: new URL(authorizeUrl).searchParams.get('state'), code: 'the-code' });
  const ready = await settled(app, connection.id);
  const folder = path.join(dataDir, 'connected-apps', connection.id);
  const found = (words) => app.workspace.search(words, { limit: 20 }).some((object) => object.projectId === ready.projectId);
  return { app, calls, ready, folder, authorizeUrl: new URL(authorizeUrl), found };
}

test('OneDrive signs in for files alone, mirrors its folders through Graph, and downloads only what changed', async (t) => {
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const time = '2026-11-20T10:00:00Z';
  let tokenBodies = [];
  const items = [
    { id: 'root', name: 'root', root: {}, folder: {} },
    { id: 'projects', name: 'Projects', folder: {}, parentReference: { id: 'root' } },
    { id: 'budget', name: 'Budget.docx', file: {}, parentReference: { id: 'projects' }, lastModifiedDateTime: time, size: 400,
      webUrl: 'https://onedrive.live.com/budget' },
    { id: 'photo', name: 'photo.jpg', file: {}, parentReference: { id: 'root' }, lastModifiedDateTime: time, size: 400 },
    { id: 'notebook', name: 'Notebook', package: { type: 'oneNote' }, parentReference: { id: 'root' }, lastModifiedDateTime: time },
    { id: 'locked', name: 'Locked.pdf', file: {}, parentReference: { id: 'root' }, lastModifiedDateTime: time, size: 400 },
    { id: 'gone', name: 'Gone.pdf', deleted: {}, parentReference: { id: 'root' } },
  ];
  const routes = [
    ['https://login.microsoftonline.com/common/oauth2/v2.0/token', (url, options) => {
      tokenBodies.push(new URLSearchParams(options.body));
      return { access_token: 'ms-access', refresh_token: 'ms-refresh', expires_in: 3600 };
    }],
    [`${GRAPH}/me?`, () => ({ mail: 'adel@example.com' })],
    [`${GRAPH}/me/drive/root/delta`, () => ({ value: items.slice(0, 3), '@odata.nextLink': `${GRAPH}/delta-page-2` })],
    // The budget comes again on the second page, as Graph sends an item changed while paging.
    [`${GRAPH}/delta-page-2`, () => ({ value: [...items.slice(3), items[2]], '@odata.deltaLink': `${GRAPH}/delta-done` })],
    [`${GRAPH}/me/drive/items/budget/content`, () => new Response(docx('Retention is held at five percent'))],
    [`${GRAPH}/me/drive/items/locked/content`, () => refusal(403)],
  ];
  const { app, calls, ready, folder, authorizeUrl, found } = await connect(t, { routes, provider: 'onedrive', app: 'microsoft',
    registration: { clientId: '00000000-1111-2222-3333-444444444444' } });

  const scopes = authorizeUrl.searchParams.get('scope').split(' ');
  assert.ok(scopes.includes('Files.Read.All') && scopes.includes('offline_access'));
  assert.ok(!scopes.includes('Mail.Read'), 'OneDrive’s sign-in does not reach mail');
  assert.ok(tokenBodies[0].get('scope').includes('Files.Read.All'));
  assert.equal(ready.status, 'ready', ready.error ?? '');
  assert.equal(ready.name, 'OneDrive · adel@example.com');
  assert.ok(fs.existsSync(path.join(folder, 'OneDrive/Projects/Budget.docx')));
  const everything = fs.readdirSync(folder, { recursive: true }).map(String).join('\n');
  assert.doesNotMatch(everything, /photo|Notebook|Locked|Gone/);
  assert.equal(ready.itemCount, 1);
  assert.ok(found('Retention is held'));

  const before = downloads(calls, /\/content$/);
  await app.connections.sync(ready.id);
  assert.equal(downloads(calls, /\/content$/), before + 1, 'only the file it may not read is asked for again');
});

test('SharePoint libraries are an opt-in part of OneDrive, asking for Sites.Read.All only when chosen', async (t) => {
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const time = '2026-11-21T10:00:00Z';
  const routes = [
    ['https://login.microsoftonline.com/common/oauth2/v2.0/token', () => ({ access_token: 'ms-access', refresh_token: 'r', expires_in: 3600 })],
    [`${GRAPH}/me?`, () => ({ mail: 'adel@example.com' })],
    [`${GRAPH}/me/drive?`, () => ({ driveType: 'business' })],
    [`${GRAPH}/me/drive/root/delta`, () => ({ value: [{ id: 'root', name: 'root', root: {}, folder: {} }] })],
    [`${GRAPH}/me/followedSites`, () => ({ value: [{ id: 'site-1', displayName: 'Tower Project' }] })],
    [`${GRAPH}/sites/site-1/drives`, () => ({ value: [{ id: 'lib-1', name: 'Documents', driveType: 'documentLibrary' }] })],
    [`${GRAPH}/drives/lib-1/root/delta`, () => ({ value: [
      { id: 'lib-root', name: 'root', root: {}, folder: {} },
      { id: 'drawings', name: 'Drawings', folder: {}, parentReference: { id: 'lib-root' } },
      { id: 'spec', name: 'Spec.docx', file: {}, parentReference: { id: 'drawings' }, lastModifiedDateTime: time, size: 300,
        webUrl: 'https://contoso.sharepoint.com/spec' },
    ] })],
    [`${GRAPH}/drives/lib-1/items/spec/content`, () => new Response(docx('Anchor bolts are galvanised'))],
  ];
  const registration = { clientId: '00000000-1111-2222-3333-444444444444' };

  const plain = await application(t, network(routes).fetch);
  plain.app.connections.configureApp('microsoft', registration);
  const onedrive = plain.app.connections.catalog().find((entry) => entry.id === 'onedrive');
  assert.ok(onedrive.parts.some((part) => part.id === 'sharepoint' && part.optional), 'SharePoint is offered, off until chosen');
  const plainScopes = new URL((await plain.app.connections.create({ provider: 'onedrive' })).authorizeUrl).searchParams.get('scope');
  assert.doesNotMatch(plainScopes, /Sites\.Read\.All/, 'a OneDrive sign-in alone never asks for SharePoint');

  const { ready, folder, authorizeUrl, found, calls } = await connect(t, { routes, provider: 'onedrive', app: 'microsoft',
    registration, settings: { parts: ['files', 'sharepoint'] } });
  assert.match(authorizeUrl.searchParams.get('scope'), /Sites\.Read\.All/);
  assert.equal(ready.status, 'ready', ready.error ?? '');
  assert.ok(fs.existsSync(path.join(folder, 'SharePoint/Tower Project/Documents/Drawings/Spec.docx')));
  assert.ok(found('Anchor bolts are galvanised'), 'a SharePoint file is searched');
  assert.ok(calls.some((call) => call.url.startsWith(`${GRAPH}/drives/lib-1/items/spec/content`)));
});

test('a personal OneDrive with SharePoint chosen reads its own files and asks no site for its libraries', async (t) => {
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const routes = [
    ['https://login.microsoftonline.com/common/oauth2/v2.0/token', () => ({ access_token: 'ms-access', refresh_token: 'r', expires_in: 3600 })],
    [`${GRAPH}/me?`, () => ({ mail: 'adel@example.com' })],
    [`${GRAPH}/me/drive?`, () => ({ driveType: 'personal' })],
    [`${GRAPH}/me/drive/root/delta`, () => ({ value: [{ id: 'root', name: 'root', root: {}, folder: {} }] })],
  ];
  const { ready, calls } = await connect(t, { routes, provider: 'onedrive', app: 'microsoft',
    registration: { clientId: '00000000-1111-2222-3333-444444444444' }, settings: { parts: ['files', 'sharepoint'] } });
  assert.equal(ready.status, 'ready', ready.error ?? '');
  assert.ok(!calls.some((call) => call.url.includes('followedSites')));
});

test('Outlook still signs in for mail and calendars alone', async (t) => {
  const { app } = await application(t, network([]).fetch);
  app.connections.configureApp('microsoft', { clientId: '00000000-1111-2222-3333-444444444444' });
  const { authorizeUrl } = await app.connections.create({ provider: 'outlook' });
  const scopes = new URL(authorizeUrl).searchParams.get('scope').split(' ');
  assert.ok(scopes.includes('Mail.Read') && scopes.includes('Calendars.Read'));
  assert.ok(!scopes.some((scope) => scope.startsWith('Files.')));
});

test('Dropbox reads its whole folder tree, downloads files, and brings Paper docs in as Markdown', async (t) => {
  const time = '2026-11-20T10:00:00Z';
  const routes = [
    ['https://api.dropboxapi.com/oauth2/token', (url, options) => {
      const body = new URLSearchParams(options.body);
      assert.ok(body.get('code_verifier'), 'Dropbox signs in with PKCE and no secret');
      assert.equal(body.get('client_secret'), null);
      return { access_token: 'dbx-access', refresh_token: 'dbx-refresh', expires_in: 14400 };
    }],
    ['https://api.dropboxapi.com/2/users/get_current_account', () => ({ email: 'adel@example.com' })],
    ['https://api.dropboxapi.com/2/files/list_folder/continue', () => ({ has_more: false, cursor: 'c2', entries: [
      { '.tag': 'file', id: 'id:paper', name: 'Meeting.paper', path_display: '/Meeting.paper', server_modified: time,
        size: 10, is_downloadable: false, export_info: { export_as: 'markdown' } },
      { '.tag': 'file', id: 'id:gone', name: 'Gone.pdf', path_display: '/Gone.pdf', server_modified: time, size: 10, is_downloadable: true },
    ] })],
    ['https://api.dropboxapi.com/2/files/list_folder', (url, options) => {
      assert.equal(JSON.parse(options.body).recursive, true);
      return { has_more: true, cursor: 'c1', entries: [
        { '.tag': 'folder', id: 'id:projects', name: 'Projects', path_display: '/Projects' },
        { '.tag': 'file', id: 'id:notes', name: 'Site notes.md', path_display: '/Projects/Site notes.md', server_modified: time,
          size: 60, is_downloadable: true },
        { '.tag': 'file', id: 'id:clip', name: 'clip.mov', path_display: '/clip.mov', server_modified: time, size: 60, is_downloadable: true },
      ] };
    }],
    ['https://content.dropboxapi.com/2/files/download', (url, options) => {
      const { path: asked } = JSON.parse(options.headers['Dropbox-API-Arg']);
      if (asked === 'id:gone') return refusal(409);
      return new Response('# Site notes\n\nSlab pour on level 2 is set for Tuesday.\n');
    }],
    ['https://content.dropboxapi.com/2/files/export', (url, options) => {
      assert.equal(JSON.parse(options.headers['Dropbox-API-Arg']).export_format, 'markdown');
      return new Response('# Meeting\n\nCrane lift moves to Friday.\n');
    }],
  ];
  const { ready, folder, authorizeUrl, found } = await connect(t, { routes, provider: 'dropbox', app: 'dropbox',
    registration: { clientId: 'dropboxapp1234' } });

  assert.equal(authorizeUrl.origin, 'https://www.dropbox.com');
  assert.equal(authorizeUrl.searchParams.get('token_access_type'), 'offline');
  assert.ok(authorizeUrl.searchParams.get('scope').split(' ').includes('files.content.read'));
  assert.equal(ready.status, 'ready', ready.error ?? '');
  assert.equal(ready.name, 'Dropbox · adel@example.com');
  assert.match(fs.readFileSync(path.join(folder, 'Dropbox/Projects/Site notes.md'), 'utf8'), /Slab pour/);
  assert.match(fs.readFileSync(path.join(folder, 'Dropbox/Meeting.md'), 'utf8'), /Crane lift/);
  const everything = fs.readdirSync(folder, { recursive: true }).map(String).join('\n');
  assert.doesNotMatch(everything, /clip|Gone/);
  assert.ok(found('Crane lift'));
});

test('a cloud drive is a cloud connector, its files open at their web address, and the terminal names it by its service', async (t) => {
  const time = '2026-11-20T10:00:00Z';
  const routes = [
    ['https://api.dropboxapi.com/oauth2/token', () => ({ access_token: 'dbx-access', refresh_token: 'dbx-refresh', expires_in: 14400 })],
    ['https://api.dropboxapi.com/2/users/get_current_account', () => ({ email: 'adel@example.com' })],
    ['https://api.dropboxapi.com/2/files/list_folder', () => ({ has_more: false, entries: [
      { '.tag': 'file', id: 'id:notes', name: 'Site notes.md', path_display: '/Projects/Site notes.md', server_modified: time,
        size: 60, is_downloadable: true },
    ] })],
    ['https://content.dropboxapi.com/2/files/download', () => new Response('# Site notes\n\nThe crane lift moves to Friday.\n')],
  ];
  const { app, ready, folder } = await connect(t, { routes, provider: 'dropbox', app: 'dropbox',
    registration: { clientId: 'dropboxapp1234' } });
  const state = app.workspace.state();
  assert.equal(state.directories.length, 0, 'a cloud drive is never listed as a directory');
  assert.equal(state.connections[0].kind, 'cloud');
  assert.equal(state.connections[0].provider, 'dropbox');

  const links = app.connections.webLinks();
  assert.equal(links[path.join(fs.realpathSync(folder), 'Dropbox/Projects/Site notes.md')],
    'https://www.dropbox.com/home/Projects?preview=Site%20notes.md');

  const row = app.loop.overview().directories.find((entry) => entry.id === ready.projectId);
  assert.equal(row.kind, 'app');
  assert.equal(row.cloud, true);
  assert.equal(row.provider, 'dropbox');

  // With a work directory beside it, each answer says where it came from.
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-local-'));
  t.after(() => fs.rmSync(local, { recursive: true, force: true }));
  fs.writeFileSync(path.join(local, 'schedule.md'), '# Schedule\n\nThe crane lift was first set for Monday.\n');
  await app.workspace.add([local]);
  const asked = app.workspace.terminalRun('ask When does the crane lift move?', { id: 'human:test', displayName: 'Test', actorType: 'HUMAN_SELF' });
  const named = [asked.subhead, ...asked.blocks.map((block) => block.text)].filter(Boolean).join('\n');
  assert.match(named, /Dropbox · adel@example\.com/);
  assert.match(named, /Dropbox\/Projects\/Site notes\.md/);
  assert.doesNotMatch(named, /connected-apps/, 'Lasso’s own copy of the drive is not shown as a folder path');
});
