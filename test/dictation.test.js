import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { dictatedNameEnds, hasSuggestions, namesInFull, softenDictatedPauses } from '../src/dependencies/dictation.js';

const actor = { id: 'human:dictation-writer', displayName: 'Dictation writer', actorType: 'HUMAN_SELF' };

test('a dictated name may end after any word followed by more, nearest first', () => {
  const text = 'We spent on office supplies which came to';
  const ends = dictatedNameEnds(text, 0, text.length);
  assert.deepEqual(ends.map((end) => text.slice(0, end).split(' ').at(-1)), ['supplies', 'office']);
  assert.deepEqual(dictatedNameEnds('Other revenue was ', 0, 18), [13, 5]);
  assert.deepEqual(dictatedNameEnds('Other revenue', 0, 13), [5], 'the last word is never a name with words after it');
  assert.deepEqual(dictatedNameEnds('Revenue was 400 and net income was', 20, 34), [30, 23],
    'nothing before the clause being said');
  assert.ok(!dictatedNameEnds('Net income came to about six hundred thousand dollars', 0, 53).includes(10),
    'a name too many words back is out of reach');
  assert.deepEqual(dictatedNameEnds('', 0, 0), []);
});

test('only the source\'s whole name, as dictation writes it, counts as named', () => {
  assert.ok(namesInFull('Other revenue', 'Other Revenue'));
  assert.ok(namesInFull('L bracket', 'l_bracket'));
  assert.ok(namesInFull('Q3 net-income', 'Q3 Net Income'));
  assert.ok(namesInFull('café revenue', 'Cafe Revenue'));
  assert.ok(!namesInFull('revenue', 'Other Revenue'), 'part of a name is not the name');
  assert.ok(!namesInFull('other revenue growth', 'Other Revenue'));
  assert.ok(!namesInFull('', ''));
});

test('sentence marks dictation put among the last words are read as spaces, at the same offsets', () => {
  assert.equal(softenDictatedPauses('The other revenue. Was', 22), 'The other revenue  Was');
  assert.equal(softenDictatedPauses('Net income? For the year. Was', 29), 'Net income  For the year  Was');
  assert.equal(softenDictatedPauses('The other revenue was', 21), null, 'nothing to soften');
  assert.equal(softenDictatedPauses('The other revenue.', 18), null, 'a mark at the end is the app\'s to leave out');
  assert.equal(softenDictatedPauses('Revenue was 4.5 million', 23), null, 'a decimal point is not a pause');
  const long = 'Earlier on we covered costs. Then we looked at what came in and the other revenue. Was';
  assert.equal(softenDictatedPauses(long, long.length),
    'Earlier on we covered costs. Then we looked at what came in and the other revenue  Was',
    'only the last few words, not sentences said before them');
  const softened = softenDictatedPauses('The other revenue. Was', 22);
  assert.equal(softened.length, 'The other revenue. Was'.length);
});

test('a prediction counts as offering something only when it has a row', () => {
  assert.ok(!hasSuggestions({ sourceCompletions: [], workspaceCompletions: [], claims: [{ candidates: [] }], completion: null }));
  assert.ok(hasSuggestions({ claims: [{ candidates: [{ id: 'x' }] }] }));
  assert.ok(hasSuggestions({ workspaceCompletions: [{}] }));
  assert.ok(hasSuggestions({ completion: { insertText: 'x' } }));
  assert.ok(!hasSuggestions(null));
});

async function finance(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-dictation-'));
  const folder = path.join(sandbox, 'Finance');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'Income-Statement.csv'),
    'Account,Actual\nRevenue,485000\nOther revenue,400\nGross profit,212000\nNet income,48000\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  await app.workspace.add([fs.realpathSync(folder)], actor);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return app;
}

const ask = (app, text, extra = {}) => app.workspace.predict({ text, cursor: text.length, blockIndex: 0, ...extra });
const values = (prediction) => prediction.workspaceCompletions.map((entry) => entry.replacementText ?? entry.insertText);

test('a name dictated in full leads on to its values, as if Tab had accepted it', async (t) => {
  const app = await finance(t);
  const typed = await ask(app, 'Net income was');
  assert.ok(!hasSuggestions(typed), 'typed in full without Tab, the name is plain words, as before');

  const dictated = await ask(app, 'Net income was', { dictated: true });
  assert.equal(dictated.workspaceHeading, 'Values for Net income');
  assert.equal(dictated.sourceContext?.source?.label, 'Net income');
  assert.ok(values(dictated).includes('48000'), values(dictated).join(', '));
  assert.ok(dictated.workspaceCompletions.every((entry) => entry.claimStart === 14 && entry.claimEnd === 14),
    'the value goes after the words said, which stay as they are');

  const further = await ask(app, 'Net income for the year was', { dictated: true });
  assert.equal(further.workspaceHeading, 'Values for Net income', 'the name can be a few words back');
  assert.ok(values(further).includes('48000'));
});

test('a period dictation put at a pause does not end the phrase being said', async (t) => {
  const app = await finance(t);
  const text = 'Net income. Was';
  assert.ok(!hasSuggestions(await ask(app, text)), 'typed, the period ends the sentence, as before');
  const dictated = await ask(app, text, { dictated: true });
  assert.equal(dictated.workspaceHeading, 'Values for Net income');
  assert.ok(values(dictated).includes('48000'));
  assert.ok(dictated.workspaceCompletions.every((entry) => entry.claimStart === text.length && entry.claimEnd === text.length),
    'offsets are the text\'s own, so the value goes at the caret');
});

test('dictation changes nothing where the words already have suggestions, or name nothing in full', async (t) => {
  const app = await finance(t);
  for (const text of ['The gross pro', 'So our other revenue came to', 'Net income was 48000. Then it was']) {
    assert.deepEqual(await ask(app, text, { dictated: true }), await ask(app, text), `${text} is answered as when typed`);
  }
  assert.ok(!hasSuggestions(await ask(app, 'The weather was', { dictated: true })));
  assert.ok(!hasSuggestions(await ask(app, 'The income was', { dictated: true })), 'part of a name is not enough');
});

test('a dictated name is not linked again after its value', async (t) => {
  const app = await finance(t);
  const text = 'Net income was 48000 and it was';
  const link = { projectId: (await ask(app, 'Net income was', { dictated: true })).sourceContext.source.projectId,
    blockIndex: 0, start: 15, end: 20 };
  const valueSource = (await ask(app, 'Net income was', { dictated: true })).workspaceCompletions
    .find((entry) => (entry.replacementText ?? entry.insertText) === '48000').dependencyCandidate;
  const after = await ask(app, text, { dictated: true, pendingDependencies: [{ ...link,
    sourceObjectId: valueSource.id, sourceSnapshotId: valueSource.snapshotId }] });
  assert.notEqual(after.workspaceHeading, 'Values for Net income', 'the accepted value settles the name before it');
});
