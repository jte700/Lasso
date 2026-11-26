import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { application, network, settled } from './fixtures/connections.js';
import { storedZip, workbook } from './fixtures/workbook.js';
import { textPdf } from './fixtures/pdf.js';

const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DRIVE = 'https://www.googleapis.com/drive/v3';

const docx = (text) => storedZip({
  'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
});

const idToken = (claims) => ['{}', JSON.stringify(claims), 'signature']
  .map((part) => Buffer.from(part).toString('base64url')).join('.');

/** A Drive account: folders and files by id, answered as the Drive API answers. */
function fakeDrive() {
  const time = '2026-11-20T10:00:00.000Z';
  const entries = new Map([
    ['projects', { id: 'projects', name: 'Projects', mimeType: FOLDER, parents: ['root-id'] }],
    ['tower', { id: 'tower', name: 'Tower', mimeType: FOLDER, parents: ['projects'] }],
    ['budget', { id: 'budget', name: 'Budget memo', mimeType: DOC, parents: ['tower'], modifiedTime: time,
      webViewLink: 'https://docs.google.com/document/d/budget/edit', bytes: docx('Retention is held at five percent') }],
    ['loads', { id: 'loads', name: 'Loads', mimeType: SHEET, parents: ['tower'], modifiedTime: time,
      bytes: workbook('Loads', { 1: ['Level', 'Live load'], 2: ['Level 2', '12.5 kN/m2'] }) }],
    ['survey', { id: 'survey', name: 'Survey.pdf', mimeType: 'application/pdf', modifiedTime: time, size: '900',
      bytes: textPdf('Boundary survey of lot 14') }],
    ['notes', { id: 'notes', name: 'Site notes.md', mimeType: 'text/markdown', parents: ['root-id'], modifiedTime: time,
      size: '60', bytes: Buffer.from('# Site notes\n\nSlab pour on level 2 is set for Tuesday.\n') }],
    ['report-a', { id: 'report-a', name: 'Report.pdf', mimeType: 'application/pdf', parents: ['root-id'], modifiedTime: time,
      size: '900', bytes: textPdf('First report') }],
    ['report-b', { id: 'report-b', name: 'Report.pdf', mimeType: 'application/pdf', parents: ['root-id'], modifiedTime: time,
      size: '900', bytes: textPdf('Second report') }],
    ['plan', { id: 'plan', name: 'Q3/Q4 plan', mimeType: DOC, parents: ['root-id'], modifiedTime: time, bytes: docx('Quarter plan') }],
    ['evil', { id: 'evil', name: '../../outside.md', mimeType: 'text/markdown', parents: ['root-id'], modifiedTime: time,
      size: '9', bytes: Buffer.from('# Outside') }],
    ['photo', { id: 'photo', name: 'photo.jpg', mimeType: 'image/jpeg', parents: ['root-id'], modifiedTime: time, size: '5000' }],
    ['huge', { id: 'huge', name: 'Huge.pdf', mimeType: 'application/pdf', parents: ['root-id'], modifiedTime: time,
      size: String(900 * 1024 * 1024) }],
    ['binned', { id: 'binned', name: 'Old.pdf', mimeType: 'application/pdf', parents: ['root-id'], modifiedTime: time,
      size: '900', trashed: true, bytes: textPdf('Thrown away') }],
  ]);
  const refused = new Map();
  // Shared drives the account belongs to, answered by drives.list.
  const sharedDrives = [];
  let listing = null;
  const metadata = ({ bytes, trashed, ...entry }) => entry;
  const routes = [
    ['https://oauth2.googleapis.com/token', () => ({ access_token: 'drive-access', refresh_token: 'drive-refresh',
      expires_in: 3600, id_token: idToken({ email: 'adel@example.com' }) })],
    [`${DRIVE}/files/root?`, () => ({ id: 'root-id' })],
    [/\/drive\/v3\/files\/([^/?]+)\/export\?/, (url) => {
      const id = url.match(/\/files\/([^/?]+)\/export/)[1];
      if (refused.has(id)) return new Response(JSON.stringify({ error: { errors: [{ reason: refused.get(id) }], message: 'Refused' } }), { status: 403 });
      return new Response(entries.get(id).bytes);
    }],
    [/\/drive\/v3\/files\/([^/?]+)\?alt=media/, (url) => {
      const id = url.match(/\/files\/([^/?]+)\?/)[1];
      if (refused.has(id)) return new Response(JSON.stringify({ error: { errors: [{ reason: refused.get(id) }], message: 'Refused' } }), { status: 403 });
      return new Response(entries.get(id).bytes);
    }],
    [`${DRIVE}/drives?`, () => ({ drives: sharedDrives })],
    [`${DRIVE}/files?`, (url) => {
      if (listing) return listing;
      const query = new URL(url).searchParams.get('q');
      const folders = query.includes(`mimeType = '${FOLDER}'`);
      const files = [...entries.values()].filter((entry) => !entry.trashed && (entry.mimeType === FOLDER) === folders);
      // Newest edits first, as Drive answers orderBy=modifiedTime desc.
      if (new URL(url).searchParams.get('orderBy')) files.sort((left, right) => right.modifiedTime.localeCompare(left.modifiedTime));
      return { files: files.map(metadata) };
    }],
  ];
  return { entries, refused, sharedDrives, routes, failListing: (answer) => { listing = answer; } };
}

async function connectedDrive(t, prepare = () => {}) {
  const drive = fakeDrive();
  prepare(drive);
  const { fetch, calls } = network(drive.routes);
  const { app, dataDir } = await application(t, fetch);
  app.connections.configureApp('google', { clientId: '1234-abc.apps.googleusercontent.com', clientSecret: 'desktop-secret' });
  const { connection, authorizeUrl } = await app.connections.create({ provider: 'google-drive' });
  const state = new URL(authorizeUrl).searchParams.get('state');
  await app.connections.completeSignIn({ state, code: 'the-code' });
  const ready = await settled(app, connection.id);
  return { app, drive, calls, ready, authorizeUrl, folder: path.join(dataDir, 'connected-apps', connection.id) };
}

const downloads = (calls) => calls.filter((call) => /\/export\?|alt=media/.test(call.url)).length;

test('Google Drive asks only for read access to Drive, and Google Calendar only for its calendars', async (t) => {
  const { app } = await application(t, network([]).fetch);
  const drive = () => app.connections.catalog().find((entry) => entry.id === 'google-drive');
  assert.equal(drive().auth, 'oauth');
  await assert.rejects(app.connections.create({ provider: 'google-drive' }), /app registration/);
  app.connections.configureApp('google', { clientId: '1234-abc.apps.googleusercontent.com', clientSecret: 'desktop-secret' });
  assert.equal(drive().signIn.configured, true);
  const scopes = async (provider) => new URL((await app.connections.create({ provider })).authorizeUrl).searchParams.get('scope').split(' ');
  const driveScopes = await scopes('google-drive');
  assert.ok(driveScopes.includes('https://www.googleapis.com/auth/drive.readonly'));
  assert.ok(driveScopes.includes('email'));
  assert.ok(!driveScopes.some((scope) => scope.includes('calendar')));
  const calendarScopes = await scopes('google-calendar');
  assert.ok(calendarScopes.includes('https://www.googleapis.com/auth/calendar.readonly'));
  assert.ok(!calendarScopes.some((scope) => scope.includes('drive')));
});

test('Google Drive mirrors its folders, exports Docs and Sheets as Office files, and its text is suggested', async (t) => {
  const { app, drive, calls, ready, folder } = await connectedDrive(t);
  assert.equal(ready.status, 'ready', ready.error ?? '');
  assert.equal(ready.name, 'Google Drive · adel@example.com');
  const file = (relative) => fs.readFileSync(path.join(folder, relative));

  assert.deepEqual(file('My Drive/Projects/Tower/Budget memo.docx'), drive.entries.get('budget').bytes);
  assert.ok(calls.some((call) => call.url.includes('/files/budget/export?') && call.url.includes(encodeURIComponent(DOCX))));
  assert.deepEqual(file('My Drive/Projects/Tower/Loads.xlsx'), drive.entries.get('loads').bytes);
  assert.ok(calls.some((call) => call.url.includes('/files/loads/export?') && call.url.includes(encodeURIComponent(XLSX))));
  assert.deepEqual(file('Shared with me/Survey.pdf'), drive.entries.get('survey').bytes, 'a file without a parent of its own was shared');
  assert.match(file('My Drive/Site notes.md').toString(), /Slab pour on level 2/);
  assert.deepEqual(file('My Drive/Q3 Q4 plan.docx'), drive.entries.get('plan').bytes, 'a slash in a name is not a folder');

  const reports = ['Report.pdf', 'Report (2).pdf'].map((name) => file(`My Drive/${name}`).toString());
  assert.deepEqual(reports.map((text) => /First report/.test(text) || /Second report/.test(text)), [true, true]);
  assert.notEqual(reports[0], reports[1], 'files of the same name in one folder are both kept');

  const everything = fs.readdirSync(folder, { recursive: true }).map(String);
  assert.ok(everything.every((name) => !/photo\.jpg|Huge\.pdf|Old\.pdf/.test(name)), 'pictures, very large files and the bin are left out');
  assert.ok(everything.includes(path.join('My Drive', 'outside.md')), 'a name that climbs out stays inside the folder');
  assert.equal(fs.existsSync(path.join(folder, '..', 'outside.md')), false);
  assert.equal(ready.itemCount, 8);
  assert.ok(calls.filter((call) => call.url.startsWith(DRIVE)).every((call) => call.headers.authorization === 'Bearer drive-access'));

  const found = (words) => app.workspace.search(words, { limit: 20 }).some((object) => object.projectId === ready.projectId);
  assert.ok(found('Slab pour'), 'a Markdown file from Drive is searched');
  assert.ok(found('Retention is held'), 'a Google Doc exported as Word is searched');
});

test('Google Drive syncs only what changed, follows moves without downloading, and skips files it may not read', async (t) => {
  const { app, drive, calls, ready, folder } = await connectedDrive(t);
  const sync = async () => { await app.connections.sync(ready.id).catch(() => {}); return app.connections.connection(ready.id); };
  const exists = (relative) => fs.existsSync(path.join(folder, relative));

  let before = downloads(calls);
  await sync();
  assert.equal(downloads(calls), before, 'nothing unchanged is downloaded again');

  drive.entries.set('notes', { ...drive.entries.get('notes'), modifiedTime: '2026-11-25T09:00:00.000Z',
    bytes: Buffer.from('# Site notes\n\nSlab pour moved to Thursday.\n') });
  drive.entries.set('survey', { ...drive.entries.get('survey'), parents: ['projects'] });
  drive.entries.delete('report-b');
  before = downloads(calls);
  await sync();
  assert.equal(downloads(calls), before + 1, 'only the edited file is downloaded');
  assert.match(fs.readFileSync(path.join(folder, 'My Drive/Site notes.md'), 'utf8'), /Thursday/);
  assert.ok(exists('My Drive/Projects/Survey.pdf'), 'a moved file follows its folder');
  assert.equal(exists('Shared with me'), false, 'an emptied folder is removed');
  assert.equal(exists('My Drive/Report (2).pdf'), false, 'a removed file is removed');

  drive.entries.set('budget', { ...drive.entries.get('budget'), modifiedTime: '2026-11-25T09:00:00.000Z', bytes: docx('Changed') });
  drive.refused.set('budget', 'exportSizeLimitExceeded');
  drive.entries.set('locked', { id: 'locked', name: 'Locked.pdf', mimeType: 'application/pdf', parents: ['root-id'],
    modifiedTime: '2026-11-25T09:00:00.000Z', size: '900', bytes: textPdf('Locked') });
  drive.refused.set('locked', 'cannotDownloadFile');
  const partial = await sync();
  assert.equal(partial.status, 'ready', partial.error ?? '');
  assert.match(fs.readFileSync(path.join(folder, 'My Drive/Projects/Tower/Budget memo.docx')).toString(), /Retention is held/,
    'a file Drive will not export keeps the copy already here');
  assert.equal(exists('My Drive/Locked.pdf'), false);

  drive.failListing(new Response(JSON.stringify({ error: { message: 'Invalid Credentials' } }), { status: 401 }));
  const failed = await sync();
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /Connect it again/);
});

test('Google Drive keeps each of two same-named files when the second is edited and comes first', async (t) => {
  const { app, drive, ready, folder } = await connectedDrive(t);
  drive.entries.set('report-b', { ...drive.entries.get('report-b'), modifiedTime: '2026-11-25T09:00:00.000Z',
    bytes: textPdf('Second report revised') });
  await app.connections.sync(ready.id);
  const files = JSON.parse(app.connections.row(ready.id).sync_state_json).files;
  assert.notEqual(files['report-a'].path, files['report-b'].path);
  assert.match(fs.readFileSync(path.join(folder, files['report-a'].path)).toString(), /First report/);
  assert.match(fs.readFileSync(path.join(folder, files['report-b'].path)).toString(), /Second report revised/);
});

test('Google Drive brings in the rest when a name is too long in bytes or a file is named like a folder', async (t) => {
  const { app, drive, ready, folder } = await connectedDrive(t);
  const time = '2026-11-25T09:00:00.000Z';
  drive.entries.set('long', { id: 'long', name: `${'測'.repeat(150)}.md`, mimeType: 'text/markdown', parents: ['root-id'],
    modifiedTime: time, size: '20', bytes: Buffer.from('# Long name\n\nCrane lift plan.\n') });
  drive.entries.set('notes-folder', { id: 'notes-folder', name: 'Notes.txt', mimeType: FOLDER, parents: ['root-id'] });
  drive.entries.set('inside', { id: 'inside', name: 'inside.md', mimeType: 'text/markdown', parents: ['notes-folder'],
    modifiedTime: time, size: '9', bytes: Buffer.from('# Inside') });
  drive.entries.set('notes-file', { id: 'notes-file', name: 'Notes.txt', mimeType: 'text/plain', parents: ['root-id'],
    modifiedTime: '2026-11-24T09:00:00.000Z', size: '9', bytes: Buffer.from('A note') });
  await app.connections.sync(ready.id);
  const connection = app.connections.connection(ready.id);
  assert.equal(connection.status, 'ready', connection.error ?? '');
  const files = JSON.parse(app.connections.row(ready.id).sync_state_json).files;
  assert.ok(Buffer.byteLength(path.basename(files.long.path)) <= 255);
  assert.match(fs.readFileSync(path.join(folder, files.long.path), 'utf8'), /Crane lift plan/);
  assert.ok(files.inside || files['notes-file'], 'one of the file and the folder of the same name comes in');
});

test('Google shared drives come in, each under a top folder named after the shared drive', async (t) => {
  const time = '2026-11-21T10:00:00.000Z';
  const { app, calls, ready, folder } = await connectedDrive(t, (drive) => {
    drive.sharedDrives.push({ id: 'team-drive', name: 'Site Team' }, { id: 'empty-drive', name: 'Archive' });
    drive.entries.set('drawings', { id: 'drawings', name: 'Drawings', mimeType: FOLDER, parents: ['team-drive'], driveId: 'team-drive' });
    drive.entries.set('spec', { id: 'spec', name: 'Spec.pdf', mimeType: 'application/pdf', parents: ['drawings'],
      driveId: 'team-drive', modifiedTime: time, size: '900', bytes: textPdf('Curtain wall anchors are stainless') });
    drive.entries.set('minutes', { id: 'minutes', name: 'Minutes', mimeType: DOC, parents: ['team-drive'],
      driveId: 'team-drive', modifiedTime: time, bytes: docx('Crane hire moves to March') });
  });
  assert.equal(ready.status, 'ready', ready.error ?? '');
  assert.match(fs.readFileSync(path.join(folder, 'Site Team/Drawings/Spec.pdf')).toString(), /Curtain wall anchors/);
  assert.ok(fs.existsSync(path.join(folder, 'Site Team/Minutes.docx')), 'a file at the top of a shared drive sits in its folder');
  assert.ok(fs.existsSync(path.join(folder, 'My Drive/Site notes.md')), 'My Drive still comes in beside it');

  const listings = calls.filter((call) => call.url.startsWith(`${DRIVE}/files?`)).map((call) => new URL(call.url).searchParams);
  assert.ok(listings.every((query) => query.get('corpora') === 'allDrives' && query.get('includeItemsFromAllDrives') === 'true'
    && query.get('supportsAllDrives') === 'true'), 'every listing reaches the shared drives');
  assert.ok(calls.some((call) => call.url.includes('/files/spec?alt=media') && call.url.includes('supportsAllDrives=true')));
  const found = (words) => app.workspace.search(words, { limit: 20 }).some((object) => object.projectId === ready.projectId);
  assert.ok(found('Curtain wall anchors'), 'a shared drive file is searched');
});

test('Google Drive without shared drives lists only the account’s own files', async (t) => {
  const { calls, ready } = await connectedDrive(t);
  assert.equal(ready.status, 'ready', ready.error ?? '');
  const listings = calls.filter((call) => call.url.startsWith(`${DRIVE}/files?`)).map((call) => new URL(call.url).searchParams);
  assert.ok(listings.length && listings.every((query) => !query.has('corpora')));
});
