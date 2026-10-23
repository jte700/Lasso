import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { parseCalendar, describeRule, parseDate } from '../src/connections/ics.js';
import { relativePathFor, renderItem } from '../src/connections/providers.js';

const day = 86_400_000;
const stamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function feed(events, name = 'Site Visits') {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', `X-WR-CALNAME:${name}`, ...events.flatMap((event) => [
    'BEGIN:VEVENT', `UID:${event.uid}`, `DTSTART:${stamp(event.start)}`, `DTEND:${stamp(event.end ?? event.start)}`,
    `SUMMARY:${event.title}`, ...(event.lines ?? []), 'BEGIN:VALARM', 'DESCRIPTION:Reminder', 'END:VALARM', 'END:VEVENT',
  ]), 'END:VCALENDAR'].join('\r\n');
}

/** A network that answers from a table of handlers, recording what was asked. */
function network(routes) {
  const calls = [];
  const fetch = async (input, options = {}) => {
    const url = String(input);
    calls.push({ url, method: options.method ?? 'GET', headers: options.headers ?? {}, body: options.body });
    const route = routes.find(([pattern]) => (typeof pattern === 'string' ? url.startsWith(pattern) : pattern.test(url)));
    if (!route) return new Response(JSON.stringify({ error: { message: `No route for ${url}` } }), { status: 404 });
    const answer = await route[1](url, options);
    if (answer instanceof Response) return answer;
    return new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), {
      status: 200, headers: { 'content-type': typeof answer === 'string' ? 'text/calendar' : 'application/json' } });
  };
  return { fetch, calls };
}

async function application(t, fetch, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-connections-'));
  const app = createApplication({ dataDir, watchProjects: false, syncConnections: false, notionSpacingMs: 0,
    connectorApps: {}, fetch, port: 4319, ...overrides });
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { app, dataDir };
}

async function settled(app, id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    await app.connections.syncing.get(id)?.catch(() => {});
    const connection = app.workspace.state().connections.find((entry) => entry.id === id);
    if (connection && !['syncing', 'connecting'].includes(connection.status)) return connection;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The connection did not finish syncing.');
}

test('reads iCal feeds: folded lines, zones, whole days, repeats and the range asked for', () => {
  const text = ['BEGIN:VCALENDAR', 'X-WR-CALNAME:Project', 'BEGIN:VEVENT', 'UID:a', 'DTSTART;TZID=Europe/Berlin:20261021T091500',
    'DTEND;TZID=Europe/Berlin:20261021T101500', 'SUMMARY:Slab pour', '  review', 'LOCATION:Site\\, gate 2', 'DESCRIPTION:Line one\\nLine two',
    'ATTENDEE;CN="Lee, Dana":mailto:dana@example.com', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'DTSTART;VALUE=DATE:20261024', 'SUMMARY:Holiday', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c', 'DTSTART:20250105T080000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE', 'SUMMARY:Standup', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:d', 'DTSTART:20240101T080000Z', 'SUMMARY:Long ago', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const calendar = parseCalendar(text, { from: new Date('2026-10-01'), to: new Date('2026-12-31') });
  assert.equal(calendar.name, 'Project');
  assert.deepEqual(calendar.events.map((event) => event.title), ['Slab pour review', 'Holiday', 'Standup']);
  const [pour, holiday, standup] = calendar.events;
  assert.equal(pour.start, '2026-10-21T07:15:00.000Z');
  assert.equal(pour.location, 'Site, gate 2');
  assert.equal(pour.description, 'Line one\nLine two');
  assert.deepEqual(pour.attendees, [{ name: 'Lee, Dana', address: 'dana@example.com' }]);
  assert.equal(holiday.allDay, true);
  assert.equal(standup.recurrence, 'Every 2 weeks on Mon, Wed');
  assert.equal(describeRule('FREQ=MONTHLY;COUNT=3'), 'Every month, 3 times');
  assert.equal(parseDate({ params: { TZID: 'Eastern Standard Time' }, value: '20260701T120000' }).date.toISOString(), '2026-07-01T16:00:00.000Z');
  assert.throws(() => parseCalendar('<html>Sign in</html>'), /did not return a calendar/);
});

test('writes each item as Markdown with its fields, under a safe file name', () => {
  const message = { id: 'AAMk-123/xyz', kind: 'message', title: '.Q3 budget: final?', received: '2026-10-21T09:14:00Z',
    from: { name: 'Dana Lee', address: 'dana@example.com' }, to: [{ name: '', address: 'me@example.com' }],
    folder: 'Inbox', body: 'Total is € 48,210.\n\n\n\nThanks', link: 'https://outlook.office.com/mail/id (1)' };
  const file = relativePathFor(message);
  assert.match(file, /^Mail\/2026-10-2\d Q3 budget final \([0-9a-f]{6}\)\.md$/);
  assert.notEqual(relativePathFor({ ...message, id: 'b@google.com' }), relativePathFor({ ...message, id: 'a@google.com' }));
  const text = renderItem(message, { providerName: 'Outlook' });
  assert.match(text, /^# \.Q3 budget: final\?\n/);
  assert.match(text, /- \*\*From:\*\* Dana Lee <dana@example.com>/);
  assert.match(text, /- \*\*Folder:\*\* Inbox/);
  assert.match(text, /Total is € 48,210\.\n\nThanks/);
  assert.match(text, /\[Open in Outlook\]\(https:\/\/outlook\.office\.com\/mail\/id%20%281%29\)/);
  assert.doesNotMatch(renderItem({ ...message, link: 'javascript:alert(1)' }, { providerName: 'Outlook' }), /Open in/);
});

test('a calendar feed is indexed as a connected app, listed apart from folders, and switched like one', async (t) => {
  const now = Date.now();
  let events = [
    { uid: 'pour', title: 'Slab pour on level 2', start: new Date(now + 2 * day), lines: ['LOCATION:Gate 2'] },
    { uid: 'audit', title: 'Fire safety audit', start: new Date(now - 3 * day) },
  ];
  const { fetch, calls } = network([['https://calendar.example.com/', () => feed(events)]]);
  const { app, dataDir } = await application(t, fetch);
  await assert.rejects(app.connections.create({ provider: 'ics', url: 'file:///etc/passwd' }), /iCal address/);
  await assert.rejects(app.connections.create({ provider: 'ics', url: 'http://127.0.0.1:4319/api/health' }), /from the web/);

  const { connection } = await app.connections.create({ provider: 'ics', url: 'webcal://calendar.example.com/feed.ics' });
  assert.equal(calls[0].url, 'https://calendar.example.com/feed.ics');
  const ready = await settled(app, connection.id);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.name, 'Site Visits · calendar.example.com');
  assert.equal(ready.itemCount, 2);
  assert.equal(ready.active, true);

  const state = app.workspace.state();
  assert.equal(state.directories.length, 0, 'a connected app is not listed as a work directory');
  assert.equal(state.connections.length, 1);
  assert.ok(state.activeProjectIds.includes(ready.projectId), 'its items answer suggestions');
  const folder = path.join(dataDir, 'connected-apps', connection.id);
  assert.deepEqual(fs.readdirSync(path.join(folder, 'Calendar')).length, 2);
  assert.ok(app.workspace.search('Slab pour', { limit: 20 }).some((object) => object.projectId === ready.projectId));

  // The secret address stays out of the database and in a file only this user can read.
  const credentials = path.join(dataDir, 'connection-credentials.json');
  assert.equal(fs.statSync(credentials).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(credentials, 'utf8'), /calendar\.example\.com\/feed\.ics/);
  assert.doesNotMatch(JSON.stringify(app.db.prepare('SELECT * FROM app_connections').all()), /feed\.ics/);

  // A sync rewrites only what changed and removes what the calendar dropped.
  events = [events[0], { uid: 'handover', title: 'Handover meeting', start: new Date(now + 5 * day) }];
  const before = fs.statSync(path.join(folder, app.connections.row(connection.id).sync_state_json
    && JSON.parse(app.connections.row(connection.id).sync_state_json).files.pour.path)).mtimeMs;
  await app.connections.sync(connection.id);
  const files = JSON.parse(app.connections.row(connection.id).sync_state_json).files;
  assert.deepEqual(Object.keys(files).sort(), ['handover', 'pour']);
  assert.equal(fs.statSync(path.join(folder, files.pour.path)).mtimeMs, before);
  assert.ok(app.workspace.search('Handover meeting', { limit: 20 }).some((object) => object.projectId === ready.projectId));
  assert.ok(!app.workspace.search('Fire safety audit', { limit: 20 }).some((object) => object.projectId === ready.projectId));

  await app.connections.setActive(connection.id, false);
  const paused = app.workspace.state();
  assert.equal(paused.connections[0].active, false);
  assert.ok(!paused.activeProjectIds.includes(ready.projectId));
  assert.ok(!app.workspace.search('Slab pour', { limit: 20 }).some((object) => object.projectId === ready.projectId));
  await app.connections.setActive(connection.id, true);
  assert.ok(app.workspace.state().activeProjectIds.includes(ready.projectId));

  const after = await app.connections.disconnect(connection.id);
  assert.deepEqual(after.connections, []);
  assert.equal(fs.existsSync(folder), false);
  assert.doesNotMatch(fs.readFileSync(credentials, 'utf8'), /feed\.ics/);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM projects WHERE id = ?').get(ready.projectId).n, 0,
    'the history of its items is forgotten');
});

test('the Mac app sends the Calendar app’s events, and they are checked before they are written', async (t) => {
  const { app, dataDir } = await application(t, async () => { throw new Error('no network'); });
  const { connection } = await app.connections.create({ provider: 'apple-calendar', settings: { calendars: ['home'] } });
  assert.equal(connection.status, 'syncing');
  await assert.rejects(app.connections.sync(connection.id), /Mac app/);
  await assert.rejects(app.connections.receive(connection.id, 'not a list'), /as a list/);
  const start = new Date(Date.now() + day).toISOString();
  const received = await app.connections.receive(connection.id, [
    { id: 'E1', title: 'Design review', start, end: start, calendar: 'Work', attendees: [{ name: 'Dana', address: 'd@x.com' }],
      url: 'javascript:alert(1)' },
    { id: 'E2', title: 'Dentist', start, allDay: true, calendar: 'Home' },
    { title: 'No id is dropped' },
  ]);
  assert.equal(received.status, 'ready');
  assert.equal(received.itemCount, 2);
  const folder = path.join(dataDir, 'connected-apps', connection.id, 'Calendar');
  const review = fs.readdirSync(folder).find((name) => name.includes('Design review'));
  const text = fs.readFileSync(path.join(folder, review), 'utf8');
  assert.match(text, /- \*\*Calendar:\*\* Work/);
  assert.doesNotMatch(text, /javascript/);
  await app.connections.receive(connection.id, [{ id: 'E2', title: 'Dentist', start, allDay: true, calendar: 'Home' }]);
  assert.deepEqual(fs.readdirSync(folder).map((name) => name.includes('Dentist')), [true]);
});

test('Notion: the secret is checked, pages become Markdown, and unchanged pages are not read again', async (t) => {
  let edited = '2026-10-20T10:00:00.000Z';
  const page = () => ({ object: 'page', id: 'page-1', url: 'https://www.notion.so/Load-cases-page1', last_edited_time: edited,
    parent: { type: 'workspace' }, properties: {
      Name: { type: 'title', title: [{ plain_text: 'Load cases' }] },
      Status: { type: 'status', status: { name: 'In review' } },
      Live: { type: 'number', number: 12.5 } } });
  const { fetch, calls } = network([
    ['https://api.notion.com/v1/users/me', (url, options) => (options.headers.authorization === 'Bearer ntn_valid_secret_0123456789'
      ? { bot: { workspace_name: 'Studio' } } : new Response('{"message":"API token is invalid."}', { status: 401 }))],
    ['https://api.notion.com/v1/search', () => ({ results: [page()], has_more: false })],
    ['https://api.notion.com/v1/blocks/page-1/children', () => ({ has_more: false, results: [
      { id: 'b1', type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Floors' }] } },
      { id: 'b2', type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Live load 12.5 kN/m²' }] } },
      { id: 'b3', type: 'to_do', to_do: { checked: true, rich_text: [{ plain_text: 'Check with engineer' }] } },
    ] })],
  ]);
  const { app, dataDir } = await application(t, fetch);
  await assert.rejects(app.connections.create({ provider: 'notion', token: 'short' }), /secret/);
  await assert.rejects(app.connections.create({ provider: 'notion', token: 'ntn_wrong_secret_0123456789' }), /no longer accepts/);
  const { connection } = await app.connections.create({ provider: 'notion', token: 'ntn_valid_secret_0123456789' });
  assert.equal(connection.account, 'Studio');
  const ready = await settled(app, connection.id);
  assert.equal(ready.name, 'Notion · Studio');
  const pages = path.join(dataDir, 'connected-apps', connection.id, 'Pages');
  const file = path.join(pages, fs.readdirSync(pages).find((name) => name.startsWith('Load cases (')));
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /# Load cases/);
  assert.match(text, /- \*\*Status:\*\* In review/);
  assert.match(text, /## Floors\n\n- Live load 12\.5 kN\/m²\n- \[x\] Check with engineer/);
  assert.equal(calls.find((call) => call.url.includes('/search')).headers['notion-version'], '2022-06-28');

  const reads = () => calls.filter((call) => call.url.includes('/blocks/')).length;
  const first = reads();
  await app.connections.sync(connection.id);
  assert.equal(reads(), first, 'an unchanged page keeps its file');
  edited = '2026-10-22T10:00:00.000Z';
  await app.connections.sync(connection.id);
  assert.equal(reads(), first + 1, 'an edited page is read again');
});

test('Outlook signs in through the browser with PKCE, reads mail and events, and refreshes its access', async (t) => {
  let tokenRequests = 0;
  const { fetch, calls } = network([
    ['https://login.microsoftonline.com/common/oauth2/v2.0/token', (url, options) => {
      tokenRequests++;
      const body = new URLSearchParams(options.body);
      if (body.get('grant_type') === 'authorization_code') {
        assert.equal(body.get('code'), 'the-code');
        assert.ok(body.get('code_verifier')?.length >= 43);
        assert.equal(body.get('redirect_uri'), 'http://localhost:4319/connect/callback');
        return { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 1 };
      }
      assert.equal(body.get('refresh_token'), 'refresh-1');
      return { access_token: 'access-2', expires_in: 3600 };
    }],
    ['https://graph.microsoft.com/v1.0/me?', () => ({ mail: 'adel@example.com' })],
    ['https://graph.microsoft.com/v1.0/me/mailFolders', () => ({ value: [{ id: 'f1', displayName: 'Inbox' }] })],
    ['https://graph.microsoft.com/v1.0/me/messages', () => ({ value: [{ id: 'm1', subject: 'Retention terms',
      from: { emailAddress: { name: 'Dana Lee', address: 'dana@example.com' } }, toRecipients: [],
      receivedDateTime: new Date().toISOString(), body: { content: 'Retention is 5 %.' }, parentFolderId: 'f1' }] })],
    ['https://graph.microsoft.com/v1.0/me/calendarView', () => ({ value: [{ id: 'e1', subject: 'Site walk',
      start: { dateTime: '2026-10-30T14:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-30T15:00:00.0000000', timeZone: 'UTC' },
      location: { displayName: 'North gate' }, attendees: [] }] })],
  ]);
  const { app, dataDir } = await application(t, fetch);
  const outlook = () => app.connections.catalog().find((entry) => entry.id === 'outlook');
  assert.equal(outlook().signIn.configured, false);
  await assert.rejects(app.connections.create({ provider: 'outlook' }), /app registration/);
  app.connections.configureApp('microsoft', { clientId: '00000000-1111-2222-3333-444444444444' });
  assert.equal(outlook().signIn.configured, true);

  const { connection, authorizeUrl } = await app.connections.create({ provider: 'outlook', settings: { parts: ['mail', 'calendar'] } });
  assert.equal(connection.status, 'connecting');
  const url = new URL(authorizeUrl);
  assert.equal(url.origin + url.pathname, 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('scope'), /Mail\.Read Calendars\.Read/);
  await assert.rejects(app.connections.completeSignIn({ state: 'forged', code: 'x' }), /expired/);

  const connected = await app.connections.completeSignIn({ state: url.searchParams.get('state'), code: 'the-code' });
  assert.equal(connected.account, 'adel@example.com');
  await assert.rejects(app.connections.completeSignIn({ state: url.searchParams.get('state'), code: 'the-code' }), /expired/,
    'a sign-in is finished once');
  const ready = await settled(app, connection.id);
  assert.equal(ready.status, 'ready', ready.error ?? '');
  assert.equal(ready.name, 'Outlook · adel@example.com');
  const folder = path.join(dataDir, 'connected-apps', connection.id);
  assert.equal(fs.readdirSync(path.join(folder, 'Mail')).length, 1);
  assert.match(fs.readFileSync(path.join(folder, 'Calendar', fs.readdirSync(path.join(folder, 'Calendar'))[0]), 'utf8'),
    /- \*\*Location:\*\* North gate/);
  assert.equal(tokenRequests, 2, 'the short-lived access was refreshed before reading');
  assert.ok(calls.filter((call) => call.url.startsWith('https://graph')).every((call) => call.headers.authorization === 'Bearer access-2'
    || call.url.includes('/me?')));
});

test('the HTTP routes list the catalog, refuse other sites, and finish sign-ins on the callback page', async (t) => {
  const { app } = await application(t, async () => new Response('{}', { status: 500 }), { port: 0 });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const listed = await (await fetch(`${base}/api/connections?native=1`)).json();
  assert.ok(listed.catalog.find((entry) => entry.id === 'apple-calendar').available);
  assert.deepEqual(listed.connections, []);
  const browserOnly = await (await fetch(`${base}/api/connections`)).json();
  assert.equal(browserOnly.catalog.find((entry) => entry.id === 'apple-calendar').available, false);
  const crossSite = await fetch(`${base}/api/connections`, { method: 'POST', headers: { origin: 'https://evil.example' },
    body: JSON.stringify({ provider: 'apple-calendar' }) });
  assert.equal(crossSite.status, 403);
  const created = await fetch(`${base}/api/connections`, { method: 'POST', body: JSON.stringify({ provider: 'apple-calendar' }) });
  assert.equal(created.status, 201);
  const callback = await fetch(`${base}/connect/callback?state=unknown&code=x`);
  assert.equal(callback.status, 400);
  assert.match(await callback.text(), /Lasso could not connect/);
  const page = await fetch(`${base}/connect.html`);
  assert.equal(page.status, 200);
});
