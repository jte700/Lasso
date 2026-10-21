import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { bracketPart } from './fixtures/step-models.js';

const actor = { id: 'human:scope-writer', displayName: 'Scope writer', actorType: 'HUMAN_SELF' };

// Two work directories, added the way a writer adds them: CAD models and a finance folder.
async function twoDirectories(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-cross-directory-scope-'));
  const models = path.join(sandbox, 'Models');
  const finance = path.join(sandbox, 'Finance');
  fs.mkdirSync(models);
  fs.mkdirSync(finance);
  fs.writeFileSync(path.join(models, 'Bracket.step'), bracketPart());
  fs.writeFileSync(path.join(finance, 'Income-Statement.csv'),
    'Account,Actual\nRevenue,485000\nGross profit,212000\nNet income,48000\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  await app.workspace.add([fs.realpathSync(models), fs.realpathSync(finance)], actor);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return app;
}

const typed = (app, text, pendingDependencies = []) => app.workspace.predict({
  text, cursor: text.length, blockIndex: 0, ...(pendingDependencies.length ? { pendingDependencies } : {}),
});

// Tab on a suggestion, as the native card does it: the name is inserted and
// the next requests carry it as a pending dependency.
async function accept(app, text, label, filePath) {
  const chosen = candidate => candidate.label === label && candidate.path === filePath;
  const claim = (await typed(app, text)).claims.find(item => item.candidates.some(chosen));
  assert.ok(claim, `${text} suggests ${label} from ${filePath}`);
  const source = claim.candidates.find(chosen);
  const accepted = `${text.slice(0, claim.start)}${source.completionText ?? source.label}`;
  return { accepted, link: { projectId: source.projectId, blockIndex: 0, start: claim.start, end: accepted.length,
    sourceObjectId: source.id, sourceSnapshotId: source.snapshotId } };
}

const named = prediction => prediction.claims.flatMap(claim => claim.candidates.map(candidate => candidate.label));

test('a name from another directory after a joining word ends the accepted source focus', async t => {
  const app = await twoDirectories(t);
  const bracket = await accept(app, 'The brack', 'Bracket', 'Bracket.step');
  assert.equal((await typed(app, `${bracket.accepted} is`, [bracket.link])).workspaceHeading, 'Values for Bracket');
  const revenueAfterPart = await typed(app, `${bracket.accepted} is 100 mm wide and reven`, [bracket.link]);
  assert.equal(revenueAfterPart.workspaceHeading, undefined);
  assert.equal(named(revenueAfterPart)[0], 'Revenue');

  const revenue = await accept(app, 'Reven', 'Revenue', 'Income-Statement.csv');
  assert.equal((await typed(app, `${revenue.accepted} was`, [revenue.link])).workspaceHeading, 'Values for Revenue');
  const partAfterRevenue = await typed(app, `${revenue.accepted} was 485000 and the brack`, [revenue.link]);
  assert.equal(partAfterRevenue.workspaceHeading, undefined);
  assert.equal(named(partAfterRevenue)[0], 'Bracket');
  // A name from the source's own directory already ended it, and still does.
  const sameDirectory = await typed(app, `${revenue.accepted} was 485000 and gross pr`, [revenue.link]);
  assert.equal(sameDirectory.workspaceHeading, undefined);
  assert.equal(named(sameDirectory)[0], 'Gross profit');
});

test('a name typed in a new sentence outranks a value from the sentence before it', async t => {
  const app = await twoDirectories(t);
  const revenue = await accept(app, 'Reven', 'Revenue', 'Income-Statement.csv');
  const text = `${revenue.accepted} was 485000. The brack`;
  const sentenceStart = text.indexOf('The brack');
  for (const links of [[revenue.link], []]) {
    const prediction = await typed(app, text, links);
    assert.equal(named(prediction)[0], 'Bracket', `with ${links.length} accepted source`);
    assert.ok(prediction.claims.every(claim => claim.end > sentenceStart),
      prediction.claims.map(claim => `${claim.type} "${claim.text}"`).join(', '));
  }
});

test('the accepted source keeps its clause until the writer leaves it', async t => {
  const app = await twoDirectories(t);
  const bracket = await accept(app, 'The brack', 'Bracket', 'Bracket.step');
  const text = `${bracket.accepted} is shown next to the reven`;
  // With no joining word or sentence end the clause is still about the part.
  assert.equal((await typed(app, text, [bracket.link])).workspaceHeading, 'Values for Bracket');
  // fn+Left on the card forgets the source, so the request carries no link
  // and every directory answers the same words.
  const released = await typed(app, text);
  assert.equal(released.workspaceHeading, undefined);
  assert.equal(named(released)[0], 'Revenue');
});

// fn+Right focuses a source that need not be in the text.
const focusOn = source => ({ projectId: source.projectId, sourceObjectId: source.id, sourceSnapshotId: source.snapshotId });
const focused = (app, text, focusSource, extra = {}) => app.workspace.predict({
  text, cursor: text.length, blockIndex: 0, focusSource, ...extra,
});
const offered = prediction => prediction.workspaceCompletions.map(item => item.replacementText);

test('fn+Right focuses the last source again, and it holds until fn+Left', async t => {
  const app = await twoDirectories(t);
  const bracket = await accept(app, 'The brack', 'Bracket', 'Bracket.step');
  const part = app.dependencies.objectsAt(bracket.link.projectId).find(object => object.id === bracket.link.sourceObjectId);
  const back = await focused(app, 'The plate is', focusOn(part));
  assert.equal(back.workspaceHeading, 'Values for Bracket');
  assert.equal(back.sourceContext.source.id, part.id);
  assert.equal(offered(back)[0], '100 mm');
  // Chosen with a key, the focus is not ended by the sentence the way an accepted name's is.
  for (const text of ['The plate is 100 mm. Its holes are', 'The plate is 100 mm and reven']) {
    assert.equal((await focused(app, text, focusOn(part))).workspaceHeading, 'Values for Bracket', text);
  }
  // It wins over a name accepted earlier in the field.
  const revenue = await accept(app, 'Reven', 'Revenue', 'Income-Statement.csv');
  const over = await focused(app, `${revenue.accepted} was`, focusOn(part), { pendingDependencies: [revenue.link] });
  assert.equal(over.workspaceHeading, 'Values for Bracket');
});

// fn+Right on a suggestion the writer is typing: the focus rests on the typed words.
const focusOnTyped = (source, text, words) => ({ ...focusOn(source), start: text.lastIndexOf(words),
  end: text.lastIndexOf(words) + words.length });
const replaced = prediction => prediction.workspaceCompletions.map(item => [item.claimStart, item.claimEnd]);

test('fn+Right on a name being typed shows its values, which replace the typed words', async t => {
  const app = await twoDirectories(t);
  const text = 'Hi Sam, the brac';
  const part = (await typed(app, text)).claims[0].candidates[0];
  assert.equal(part.label, 'Bracket');
  assert.equal(part.narrowable, true);
  const values = await focused(app, text, focusOnTyped(part, text, 'brac'));
  assert.equal(values.workspaceHeading, 'Values for Bracket');
  assert.equal(offered(values)[0], '100 mm');
  assert.ok(replaced(values).every(([start, end]) => start === 12 && end === 16), JSON.stringify(replaced(values)));
  // Words typed after fn+Right narrow the list and are replaced with the typed name; a trailing space stays.
  const refined = await focused(app, `${text} ho`, focusOnTyped(part, `${text} ho`, 'brac'));
  assert.equal(refined.workspaceHeading, 'Values for Bracket');
  assert.ok(replaced(refined).every(([start, end]) => start === 12 && end === 19));
  for (const space of [' ', ' ']) {
    const spaced = await focused(app, `${text}${space}`, focusOnTyped(part, `${text}${space}`, 'brac'));
    assert.ok(replaced(spaced).every(([start, end]) => start === 12 && end === 16), JSON.stringify(space));
  }

  // A row named in a table offers its cells, not its own name again.
  const row = (await typed(app, 'Reven')).claims[0].candidates[0];
  assert.equal(row.label, 'Revenue');
  assert.equal(row.narrowable, true);
  const cells = await focused(app, 'Reven', focusOnTyped(row, 'Reven', 'Reven'));
  assert.equal(cells.workspaceHeading, 'Values for Revenue');
  assert.deepEqual(offered(cells), ['485000']);
  assert.deepEqual(replaced(cells), [[0, 5]]);
});

test('fn+Right stops at a value, which has nothing below it', async t => {
  const app = await twoDirectories(t);
  const bracket = await accept(app, 'The brack', 'Bracket', 'Bracket.step');
  const values = await typed(app, `${bracket.accepted} is`, [bracket.link]);
  assert.ok(values.workspaceCompletions.length > 1);
  assert.ok(values.workspaceCompletions.every(item => !item.dependencyCandidate.narrowable),
    'a part\'s measurements are the bottom');
  const revenue = await accept(app, 'Reven', 'Revenue', 'Income-Statement.csv');
  const cells = await typed(app, `${revenue.accepted} was`, [revenue.link]);
  assert.ok(cells.workspaceCompletions.length && cells.workspaceCompletions.every(item => !item.dependencyCandidate.narrowable));
});

test('typed words a focus rests on stop being replaced once they are in an earlier clause', async t => {
  const app = await twoDirectories(t);
  const part = (await typed(app, 'brac')).claims[0].candidates[0];
  const text = 'brac. The plate is';
  const held = await focused(app, text, focusOnTyped(part, text, 'brac'));
  assert.equal(held.workspaceHeading, 'Values for Bracket');
  assert.ok(replaced(held).every(([start, end]) => start === text.length && end === text.length));
  // A range that is not typed text before the caret is ignored the same way.
  for (const range of [{ start: 0, end: 40 }, { start: 3, end: 3 }, { start: '0', end: 4 }]) {
    const prediction = await focused(app, 'The plate is', { ...focusOn(part), ...range });
    assert.equal(prediction.workspaceHeading, 'Values for Bracket', JSON.stringify(range));
    assert.ok(replaced(prediction).every(([start, end]) => start === 12 && end === 12), JSON.stringify(range));
  }
});

test('a focus that cannot be used leaves every directory to answer', async t => {
  const app = await twoDirectories(t);
  const bracket = await accept(app, 'The brack', 'Bracket', 'Bracket.step');
  const part = { projectId: bracket.link.projectId, sourceObjectId: bracket.link.sourceObjectId,
    sourceSnapshotId: bracket.link.sourceSnapshotId };
  for (const focusSource of [{ ...part, sourceObjectId: 'missing' }, { sourceObjectId: 42 }, 'Bracket']) {
    const prediction = await focused(app, 'Reven', focusSource);
    assert.equal(prediction.workspaceHeading, undefined, JSON.stringify(focusSource));
    assert.equal(named(prediction)[0], 'Revenue');
  }
  await app.workspace.toggle(part.projectId, false, actor);
  const paused = await focused(app, 'Reven', part);
  assert.equal(paused.workspaceHeading, undefined);
});

// What the card remembers as the focus after Tab: the source the server scoped it to.
const contextFocus = prediction => {
  const source = prediction.sourceContext?.source;
  return source && { projectId: source.projectId, sourceObjectId: source.id, sourceSnapshotId: source.snapshotId };
};

test('fn+Right returns to an accepted source whose name is still the last thing typed', async t => {
  const app = await twoDirectories(t);
  // Typed as spelled, a file of any type is named by its file name; in plain words, by its readable name.
  for (const [text, label, filePath, heading] of [
    ['Bracket.st', 'Bracket.step', 'Bracket.step', 'Values for Bracket'],
    ['The brack', 'Bracket', 'Bracket.step', 'Values for Bracket'],
  ]) {
    const accepted = await accept(app, text, label, filePath);
    for (const written of [accepted.accepted, `${accepted.accepted} `]) {
      const values = await typed(app, written, [accepted.link]);
      assert.equal(values.workspaceHeading, heading, written);
      // fn+Left: every directory reads the same words, so the name is offered as a file again.
      const out = await typed(app, written);
      assert.equal(out.workspaceHeading, undefined, written);
      // fn+Right: the name in the text is the focus itself, not a new source to choose.
      const back = await focused(app, written, contextFocus(values));
      assert.equal(back.workspaceHeading, heading, written);
      assert.deepEqual(back.claims, [], written);
    }
  }
  // A narrowed focus inside the named file holds the same way.
  const bracket = await accept(app, 'Bracket.st', 'Bracket.step', 'Bracket.step');
  const hole = (await typed(app, `${bracket.accepted} is`, [bracket.link])).workspaceCompletions
    .map(item => item.dependencyCandidate).find(candidate => candidate.label === 'Bracket Ø8 hole diameter');
  const narrowed = await focused(app, bracket.accepted, focusOn(hole));
  assert.equal(narrowed.workspaceHeading, 'Values for Bracket Ø8 hole diameter');
  // Another file named at the caret is still a new source to choose.
  const other = await focused(app, `${bracket.accepted} is beside Income-Statement.cs`, contextFocus(
    await typed(app, `${bracket.accepted} `, [bracket.link])));
  assert.equal(other.claims[0]?.candidates[0]?.path, 'Income-Statement.csv');
});
