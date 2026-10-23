import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { fieldCue, fieldRole, recordFields, spokenValue } from '../src/dependencies/record-fields.js';

const actor = { id: 'human:record-test', displayName: 'Record test', actorType: 'HUMAN_SELF' };

test('a note with a title and labelled fields is read as a record', () => {
  const text = '# Meeting with Dr. Lavalee\n\n- **Date:** Tuesday, October 27\n- **Time:** 1:00 PM\n'
    + '- **Ends:** 2:00 PM\n- **Organizer:** Dana Lee <dana@example.com>\n\nBring the scans.\n';
  const record = recordFields(text);
  assert.equal(record.title, 'Meeting with Dr. Lavalee');
  assert.deepEqual(record.fields.map((field) => [field.label, field.role, field.text]), [
    ['Date', 'date', 'Tuesday, October 27'], ['Time', 'time', '1:00 PM'], ['Ends', 'end', '2:00 PM'],
    ['Organizer', 'people', 'Dana Lee']]);
  const date = record.fields[0];
  assert.equal(text.slice(date.start, date.end), 'Tuesday, October 27');
  assert.equal(date.line, 3);
  assert.equal(recordFields('# Notes\n\n- **Date:** Monday\n\nOne field is a note, not a record.'), null);
  assert.equal(recordFields('Intro first\n# Title\n- **A:** 1\n- **B:** 2'), null);
  assert.equal(fieldRole('Last edited'), 'date');
  assert.equal(fieldRole('Assignee'), 'people');
  assert.equal(fieldRole('Room'), 'place');
  assert.equal(spokenValue('Ana <a@x.com>, b@y.com, <c@z.com>'), 'Ana, b@y.com, c@z.com');
  assert.deepEqual(fieldCue(' on'), { word: 'on', roles: ['date', 'place'], typed: '' });
  assert.deepEqual(fieldCue(' at 1'), { word: 'at', roles: ['time', 'place'], typed: '1' });
  assert.equal(fieldCue(' '), null, 'no cue yet: the fields wait');
  assert.equal(fieldCue(' and Dr. Smith'), null);
  assert.equal(fieldCue(' on the second floor near the old lab'), null, 'a sentence that went on');
});

async function calendar(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-records-'));
  const app = createApplication({ dataDir, watchProjects: false, syncConnections: false, connectorApps: {} });
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const year = new Date().getFullYear();
  const { connection } = await app.connections.create({ provider: 'apple-calendar' });
  await app.connections.receive(connection.id, [
    { id: 'E1', title: 'Meeting with Dr. Lavalee', start: new Date(year, 9, 27, 13).toISOString(),
      end: new Date(year, 9, 27, 14).toISOString(), calendar: 'Work', location: 'Room 204',
      attendees: [{ name: 'Dr. Lavalee', address: 'lavalee@example.com' }] },
    { id: 'E2', title: 'Dentist', start: new Date(year, 9, 29, 9).toISOString(), end: new Date(year, 9, 29, 10).toISOString(),
      calendar: 'Home', location: '12 King St' },
  ]);
  const event = app.workspace.search('Meeting with Dr. Lavalee', { limit: 10 })
    .find((object) => object.objectType === 'DOCUMENT' && object.metadata.recordFields);
  return { app, event };
}

const link = (start, end, object) => ({ projectId: object.projectId, blockIndex: 0, start, end,
  sourceObjectId: object.id, sourceSnapshotId: object.snapshotId });
const ask = (app, text, pendingDependencies) => app.workspace.predict({ text, cursor: text.length, blockIndex: 0, pendingDependencies });
const offered = (prediction) => prediction.workspaceCompletions.map((completion) => `${completion.category}: ${completion.replacementText}`);

test('after a linked event, the word written picks its field: on a date, at a time, with its people', async (t) => {
  const { app, event } = await calendar(t);
  assert.ok(event, 'the event is a record');
  const typed = 'I have a meeting with Dr. lavalee';
  const title = link(9, typed.length, event);

  // Typing its title finds the event, and "Dr." does not end the sentence.
  const finding = await ask(app, 'I have a meeting with Dr. lav', []);
  assert.ok(finding.claims.some((claim) => claim.candidates.some((candidate) => candidate.id === event.id)));

  const on = await ask(app, `${typed} on`, [title]);
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    .format(new Date(new Date().getFullYear(), 9, 27));
  assert.equal(offered(on)[0], `Date: ${day}`);
  assert.equal(on.sourceContext.source.id, event.id);
  assert.equal(on.workspaceHeading, 'Meeting with Dr. Lavalee');
  assert.equal(on.workspaceCompletions[0].claimStart, typed.length + 3, 'inserted after "on", replacing nothing');
  assert.equal(offered(await ask(app, `${typed} at`, [title]))[0].split(':')[0], 'Time');
  assert.deepEqual(offered(await ask(app, `${typed} in`, [title]))[0], 'Location: Room 204');
  assert.deepEqual(offered(await ask(app, `${typed} with`, [title])), ['Attendees: Dr. Lavalee'], 'names, not addresses');
  assert.deepEqual(offered(await ask(app, `${typed} on ${day.slice(0, 3)}`, [title])), [`Date: ${day}`]);
  const partial = await ask(app, `${typed} on ${day.slice(0, 3)}`, [title]);
  assert.equal(partial.workspaceCompletions[0].claimStart, typed.length + 4, 'what was typed of the value is replaced');
  const all = offered(await ask(app, `${typed} is`, [title])).map((entry) => entry.split(':')[0]);
  assert.deepEqual(all, ['Date', 'Time', 'Ends', 'Location', 'Attendees', 'Calendar'], 'in the order the event lists them');
  assert.deepEqual(offered(await ask(app, `${typed} and Dr. Smith`, [title])), []);
  assert.ok(!offered(await ask(app, `${typed}. Then the`, [title])).some((entry) => entry.startsWith('Date')));
  assert.ok(!offered(await ask(app, `${typed} on`, [title])).some((entry) => entry.includes('12 King St')), 'only this event');

  // A field written leads on to the rest of the same event.
  const date = on.workspaceCompletions[0];
  const withDate = `${typed} on ${date.replacementText}`;
  const dateLink = link(withDate.length - date.replacementText.length, withDate.length, date.dependencyCandidate);
  const next = offered(await ask(app, `${withDate} at`, [title, dateLink]));
  assert.equal(next[0].split(':')[0], 'Time');
  assert.ok(!offered(await ask(app, `${withDate} on`, [title, dateLink])).some((entry) => entry.startsWith('Date')),
    'a field already written is not offered again');
});

test('mail is a record too: "from" offers its sender', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-records-'));
  const app = createApplication({ dataDir, watchProjects: false, syncConnections: false, connectorApps: {} });
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(dataDir, 'notes-')));
  fs.writeFileSync(path.join(root, 'retention.md'), '# Retention terms\n\n- **From:** Dana Lee <dana@example.com>\n'
    + '- **To:** Me <me@example.com>\n- **Date:** Monday, October 19\n\nRetention is 5 %.\n');
  fs.writeFileSync(path.join(root, 'plain.md'), '# Site notes\n\nThe slab was poured on Monday. Retention terms were discussed.\n');
  await app.workspace.add([root], actor);
  const mail = app.workspace.search('Retention terms', { limit: 10 })
    .find((object) => object.objectType === 'DOCUMENT' && object.path === 'retention.md');
  assert.deepEqual(mail.metadata.recordFields, ['From', 'To', 'Date']);
  const typed = 'The email about retention terms';
  const from = await ask(app, `${typed} from`, [link(16, typed.length, mail)]);
  assert.deepEqual(offered(from)[0], 'From: Dana Lee');
  assert.deepEqual(offered(await ask(app, `${typed} to`, [link(16, typed.length, mail)]))[0], 'To: Me');

  // A note without fields is read as before.
  const plain = app.workspace.search('Site notes', { limit: 10 }).find((object) => object.path === 'plain.md'
    && object.objectType === 'DOCUMENT' && !object.metadata.componentType);
  assert.equal(plain.metadata.recordFields, undefined);
  assert.equal(app.dependencies.objectsAt(mail.projectId).filter((object) => object.path === 'plain.md'
    && object.metadata.componentType === 'RECORD_FIELD').length, 0);
  // A field line is a field, not also a passage of prose.
  assert.ok(!app.dependencies.objectsAt(mail.projectId).some((object) => object.path === 'retention.md'
    && object.metadata.componentType === 'TEXT_EXCERPT' && /Dana Lee/.test(object.valueText)));
});
