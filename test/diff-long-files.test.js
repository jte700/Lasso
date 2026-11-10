import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import {
  compactStructuredDiff, createStructuredDiff, diffInternals, expandStructuredDiff,
} from '../src/history/diff.js';
import { MAX_DIFF_STEPS, sequenceOperations } from '../src/history/sequence-diff.js';

const actor = { id: 'human:diff-test', displayName: 'Diff test', actorType: 'HUMAN_SELF' };

const LONG_FILE_LINES = 50_000;

function textDiff(beforeText, afterText, fileType = 'text', filePath = 'run.txt') {
  return createStructuredDiff({
    fileType, filePath, beforeBuffer: Buffer.from(beforeText), afterBuffer: Buffer.from(afterText), changeType: 'MODIFIED',
  });
}

function tableDiff(beforeText, afterText, filePath = 'readings.csv') {
  return textDiff(beforeText, afterText, 'table', filePath);
}

function changes(diff) {
  return diff.operations.filter((operation) => operation.kind !== 'equal');
}

/** Both compared texts, rebuilt from the operations, with every line number checked. */
function rebuiltSides(operations) {
  const before = [];
  const after = [];
  for (const operation of operations) {
    if (operation.kind !== 'add') {
      before.push(operation.text);
      assert.equal(operation.beforeLine, before.length);
    }
    if (operation.kind !== 'remove') {
      after.push(operation.text);
      assert.equal(operation.afterLine, after.length);
    }
  }
  return { before: before.join('\n'), after: after.join('\n') };
}

/** A repeatable stream of whole numbers below `limit`. */
function numberStream(seed) {
  let state = seed >>> 0;
  return (limit) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * limit);
  };
}

function shuffled(items, next) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = next(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function longestCommonLength(before, after) {
  let previous = new Array(after.length + 1).fill(0);
  for (const line of before) {
    const current = [0];
    after.forEach((other, index) => {
      current.push(line === other ? previous[index] + 1 : Math.max(previous[index + 1], current[index]));
    });
    previous = current;
  }
  return previous[after.length];
}

test('A one-line edit to a 50,000-line file reports one change', () => {
  const lines = Array.from({ length: LONG_FILE_LINES }, (_, index) => `reading ${index} stays as measured`);
  const beforeText = `${lines.join('\n')}\n`;
  const edited = lines.with(25_000, 'reading 25000 was corrected');

  const diff = textDiff(beforeText, `${edited.join('\n')}\n`);

  assert.equal(diff.removed, 1);
  assert.equal(diff.added, 1);
  assert.deepEqual(changes(diff), [
    { kind: 'remove', text: 'reading 25000 stays as measured', beforeLine: 25_001 },
    { kind: 'add', text: 'reading 25000 was corrected', afterLine: 25_001 },
  ]);
  assert.equal(diff.operations.length, LONG_FILE_LINES + 2);
  assert.equal(compactStructuredDiff(diff).operationRuns.length, 4);
});

test('Edits at both ends of a long file report only the edited lines', () => {
  const lines = Array.from({ length: LONG_FILE_LINES }, (_, index) => `step ${index}`);
  const edited = [...lines.slice(0, 10), 'a step added near the top', ...lines.slice(10)]
    .filter((line) => line !== 'step 49990');

  const diff = textDiff(lines.join('\n'), edited.join('\n'), 'code', 'pipeline.py');

  assert.deepEqual(changes(diff), [
    { kind: 'add', text: 'a step added near the top', afterLine: 11 },
    { kind: 'remove', text: 'step 49990', beforeLine: 49_991 },
  ]);
  assert.deepEqual(rebuiltSides(diff.operations), { before: lines.join('\n'), after: edited.join('\n') });
});

test('One changed paragraph in a long markdown file reports one changed block', () => {
  const paragraphs = Array.from({ length: 6_000 }, (_, index) => `Paragraph ${index} stays the same.`);
  const beforeText = `# Notes\n\n${paragraphs.join('\n\n')}\n`;
  const afterText = beforeText.replace('Paragraph 3000 stays the same.', 'Paragraph 3000 was rewritten.');

  const diff = textDiff(beforeText, afterText, 'markdown', 'notes.md');

  assert.deepEqual(changes(diff), [
    { kind: 'remove', text: 'Paragraph 3000 stays the same.', beforeLine: 3_002, blockType: 'paragraph' },
    { kind: 'add', text: 'Paragraph 3000 was rewritten.', afterLine: 3_002, blockType: 'paragraph' },
  ]);
});

test('Two unrelated long files are compared in bounded time', () => {
  const next = numberStream(7);
  const lines = Array.from({ length: 40_000 }, (_, index) => `sample ${index}`);
  const before = ['shared heading', ...shuffled(lines, next), 'shared footer'];
  const after = ['shared heading', ...shuffled(lines, next), 'shared footer'];
  const started = process.hrtime.bigint();

  const diff = textDiff(before.join('\n'), after.join('\n'));

  const milliseconds = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(milliseconds < 5_000, `the comparison took ${Math.round(milliseconds)} ms`);
  // Past the work limit the lines between the shared ends are reported as
  // removed and then added, and both texts can still be rebuilt.
  assert.deepEqual(diff.operations.map((operation) => operation.kind).join(' ').replace(/(\w+)( \1)+/g, '$1'),
    'equal remove add equal');
  assert.equal(diff.removed, 40_000);
  assert.equal(diff.added, 40_000);
  assert.deepEqual(rebuiltSides(diff.operations), { before: before.join('\n'), after: after.join('\n') });
});

test('A long file cut down to a few scattered lines keeps those lines as unchanged', () => {
  const lines = Array.from({ length: 20_000 }, (_, index) => `measurement ${index} recorded`);
  const kept = lines.filter((_, index) => index % 100 === 50);

  const cut = sequenceOperations(lines, kept);
  const grown = sequenceOperations(kept, lines);

  assert.equal(cut.filter((operation) => operation.kind === 'equal').length, 200);
  assert.equal(cut.filter((operation) => operation.kind === 'remove').length, 19_800);
  assert.equal(cut.filter((operation) => operation.kind === 'add').length, 0);
  assert.equal(grown.filter((operation) => operation.kind === 'equal').length, 200);
  assert.equal(grown.filter((operation) => operation.kind === 'remove').length, 0);
  assert.equal(grown.filter((operation) => operation.kind === 'add').length, 19_800);
  assert.deepEqual(rebuiltSides(grown), { before: kept.join('\n'), after: lines.join('\n') });
});

test('Two large blocks of new lines in a long file are reported as added only', () => {
  const lines = Array.from({ length: LONG_FILE_LINES }, (_, index) => `row ${index} unchanged`);
  const block = (name) => Array.from({ length: 6_000 }, (_, index) => `${name} line ${index}`);
  const edited = [...lines.slice(0, 10_000), ...block('first'), ...lines.slice(10_000, 40_000), ...block('second'), ...lines.slice(40_000)];

  const diff = textDiff(lines.join('\n'), edited.join('\n'));

  assert.equal(diff.removed, 0);
  assert.equal(diff.added, 12_000);
  assert.deepEqual(changes(diff).map((operation) => operation.afterLine), [
    ...Array.from({ length: 6_000 }, (_, index) => 10_001 + index),
    ...Array.from({ length: 6_000 }, (_, index) => 46_001 + index),
  ]);
});

test('A changed first line and a long appended block in a long file report only those lines', () => {
  const lines = Array.from({ length: LONG_FILE_LINES }, (_, index) => `event ${index} logged`);
  const appended = Array.from({ length: 8_000 }, (_, index) => `new event ${index} logged`);
  const beforeText = `Updated Monday\n${lines.join('\n')}\n`;
  const afterText = `Updated Tuesday\n${[...lines, ...appended].join('\n')}\n`;

  const diff = textDiff(beforeText, afterText, 'text', 'events.log');

  assert.equal(diff.removed, 1);
  assert.equal(diff.added, 8_001);
  assert.deepEqual(changes(diff).slice(0, 3), [
    { kind: 'remove', text: 'Updated Monday', beforeLine: 1 },
    { kind: 'add', text: 'Updated Tuesday', afterLine: 1 },
    { kind: 'add', text: 'new event 0 logged', afterLine: LONG_FILE_LINES + 2 },
  ]);
});

test('A long block appended to a short file whose first line changed reports only those lines', () => {
  // Every third line is blank in both the file and the appended block, so
  // the block shares lines with the file and cannot simply be set aside.
  const body = Array.from({ length: 99 }, (_, index) => (index % 3 === 1 ? '' : `entry ${index}`));
  const appended = Array.from({ length: 9_000 }, (_, index) => (index % 3 === 1 ? '' : `appended entry ${index}`));
  const beforeText = `Last updated: Monday\n${body.join('\n')}\n`;
  const afterText = `Last updated: Tuesday\n${[...body, ...appended].join('\n')}\n`;

  const diff = textDiff(beforeText, afterText);

  assert.equal(diff.removed, 1);
  assert.equal(diff.added, 9_001);
  assert.deepEqual(changes(diff), [
    { kind: 'remove', text: 'Last updated: Monday', beforeLine: 1 },
    { kind: 'add', text: 'Last updated: Tuesday', afterLine: 1 },
    ...appended.map((text, index) => ({ kind: 'add', text, afterLine: 101 + index })),
  ]);
});

test('Long blocks pasted into a short file report only the pasted lines', () => {
  // Every other pasted line is blank, as some lines of the file are, so the
  // pasted lines cannot be set aside and the comparison has to place them.
  const original = Array.from({ length: 120 }, (_, index) => (index % 6 === 5 ? '' : `const value${index} = ${index};`));
  const pasted = (name, count) => Array.from({ length: count }, (_, index) => (index % 2 ? '' : `  ${name}[${index}] = ${index},`));
  const edited = [
    ...original.slice(0, 10), ...pasted('a', 2_700),
    ...original.slice(10, 60), ...pasted('b', 2_700),
    ...original.slice(60, 110), ...pasted('c', 2_600),
    ...original.slice(110),
  ];

  const diff = textDiff(original.join('\n'), edited.join('\n'), 'code', 'values.js');

  assert.equal(diff.removed, 0);
  assert.equal(diff.added, 8_000);
  assert.deepEqual(rebuiltSides(diff.operations), { before: original.join('\n'), after: edited.join('\n') });
});

test('A comparison past its work limit reports the lines between the shared ends as replaced', () => {
  const before = ['top', 'a', 'b', 'c', 'd', 'e', 'f', 'bottom'];
  const after = ['top', 'f', 'e', 'd', 'c', 'b', 'a', 'bottom'];

  const limited = sequenceOperations(before, after, { maxSteps: 3, maxTableCells: 0 });
  const unlimited = sequenceOperations(before, after);

  assert.deepEqual(limited.map((operation) => `${operation.kind} ${operation.text}`), [
    'equal top',
    'remove a', 'remove b', 'remove c', 'remove d', 'remove e', 'remove f',
    'add f', 'add e', 'add d', 'add c', 'add b', 'add a',
    'equal bottom',
  ]);
  assert.equal(unlimited.filter((operation) => operation.kind === 'equal').length, 3);
  assert.ok(MAX_DIFF_STEPS >= 1_000_000, 'ordinary edits to long files stay well inside the limit');
});

/**
 * Compares 400 seeded random pairs of short line lists, some lines found on
 * one side only, and checks each diff rebuilds both lists with the fewest
 * changed lines. `linesOf` gives the lines a list is compared as.
 */
function checkFewestChangedLines(operationsOf, linesOf = (list) => list) {
  const next = numberStream(2026);
  const words = ['alpha', 'beta', 'gamma', 'delta', '', '}'];
  const lineFrom = (side) => (next(8) === 0 ? `only ${side} ${next(3)}` : words[next(words.length)]);
  for (let round = 0; round < 400; round += 1) {
    const before = Array.from({ length: next(24) }, () => lineFrom('before'));
    const after = Array.from({ length: next(24) }, () => lineFrom('after'));

    const operations = operationsOf(before, after);

    const [beforeLines, afterLines] = [linesOf(before), linesOf(after)];
    assert.deepEqual(rebuiltSides(operations), { before: beforeLines.join('\n'), after: afterLines.join('\n') });
    const common = longestCommonLength(beforeLines, afterLines);
    assert.equal(operations.filter((operation) => operation.kind === 'remove').length, beforeLines.length - common, `round ${round} removed`);
    assert.equal(operations.filter((operation) => operation.kind === 'add').length, afterLines.length - common, `round ${round} added`);
  }
}

test('Small edits are reported with the fewest changed lines', () => {
  checkFewestChangedLines(
    (before, after) => diffInternals.lineDiff(before.join('\n'), after.join('\n')).operations,
    // An empty list of lines still reads as one empty line.
    (list) => list.join('\n').split('\n'),
  );
});

test('Small edits found by the step search alone are reported with the fewest changed lines', () => {
  checkFewestChangedLines((before, after) => sequenceOperations(before, after, { maxTableCells: 0 }));
});

test('A replaced line is reported as removed before it is added', () => {
  const diff = textDiff('first\nold second\nold third\nlast', 'first\nnew second\nnew third\nand more\nlast');

  assert.deepEqual(diff.operations, [
    { kind: 'equal', text: 'first', beforeLine: 1, afterLine: 1 },
    { kind: 'remove', text: 'old second', beforeLine: 2 },
    { kind: 'remove', text: 'old third', beforeLine: 3 },
    { kind: 'add', text: 'new second', afterLine: 2 },
    { kind: 'add', text: 'new third', afterLine: 3 },
    { kind: 'add', text: 'and more', afterLine: 4 },
    { kind: 'equal', text: 'last', beforeLine: 4, afterLine: 5 },
  ]);
});

test('A diff stored as runs before this change still expands', () => {
  const before = Buffer.from('title\nsteady\nold value\nold order\nend\n');
  const after = Buffer.from('title\nsteady\nnew order\nnew value\nend\n');
  // Written as the earlier comparison stored it, including an added line
  // ahead of a removed one, which the earlier comparison could produce.
  const storedText = {
    format: 'text',
    added: 2,
    removed: 2,
    operationRuns: [
      { kind: 'equal', beforeLine: 1, afterLine: 1, count: 2 },
      { kind: 'add', afterLine: 3, count: 1 },
      { kind: 'remove', beforeLine: 3, count: 2 },
      { kind: 'add', afterLine: 4, count: 1 },
      { kind: 'equal', beforeLine: 5, afterLine: 5, count: 2 },
    ],
  };
  const beforeNote = Buffer.from('# Plan\n\nFirst draft.\n\n- one\n- two\n');
  const afterNote = Buffer.from('# Plan\n\nSecond draft.\n\n- one\n- two\n');
  const storedMarkdown = {
    format: 'markdown',
    added: 1,
    removed: 1,
    operationRuns: [
      { kind: 'equal', beforeLine: 1, afterLine: 1, count: 1 },
      { kind: 'remove', beforeLine: 2, count: 1 },
      { kind: 'add', afterLine: 2, count: 1 },
      { kind: 'equal', beforeLine: 3, afterLine: 3, count: 1 },
    ],
  };

  const text = expandStructuredDiff(storedText, () => ({ before, after }));
  const markdown = expandStructuredDiff(storedMarkdown, () => ({ before: beforeNote, after: afterNote }));

  assert.deepEqual(text, {
    format: 'text',
    added: 2,
    removed: 2,
    operations: [
      { kind: 'equal', text: 'title', beforeLine: 1, afterLine: 1 },
      { kind: 'equal', text: 'steady', beforeLine: 2, afterLine: 2 },
      { kind: 'add', text: 'new order', afterLine: 3 },
      { kind: 'remove', text: 'old value', beforeLine: 3 },
      { kind: 'remove', text: 'old order', beforeLine: 4 },
      { kind: 'add', text: 'new value', afterLine: 4 },
      { kind: 'equal', text: 'end', beforeLine: 5, afterLine: 5 },
      { kind: 'equal', text: '', beforeLine: 6, afterLine: 6 },
    ],
  });
  assert.deepEqual(markdown, {
    format: 'markdown',
    added: 1,
    removed: 1,
    operations: [
      { kind: 'equal', text: '# Plan', beforeLine: 1, afterLine: 1, blockType: 'heading' },
      { kind: 'remove', text: 'First draft.', beforeLine: 2, blockType: 'paragraph' },
      { kind: 'add', text: 'Second draft.', afterLine: 2, blockType: 'paragraph' },
      { kind: 'equal', text: '- one\n- two', beforeLine: 3, afterLine: 3, blockType: 'list' },
    ],
  });
});

test('A diff of a long file expands from its stored runs to what was computed', () => {
  const lines = Array.from({ length: LONG_FILE_LINES }, (_, index) => `entry ${index}`);
  const before = Buffer.from(lines.join('\n'));
  const after = Buffer.from(lines.toSpliced(40_000, 2, 'entry rewritten', 'entry added', 'entry added again').join('\n'));
  const computed = createStructuredDiff({
    fileType: 'text', filePath: 'log.txt', beforeBuffer: before, afterBuffer: after, changeType: 'MODIFIED',
  });

  const stored = JSON.parse(JSON.stringify(compactStructuredDiff(computed)));
  const expanded = expandStructuredDiff(stored, () => ({ before, after }));

  assert.equal(computed.removed, 2);
  assert.equal(computed.added, 3);
  assert.ok(JSON.stringify(stored).length < 512);
  assert.deepEqual(expanded, computed);
});

test('A row inserted into a table without row names reports one added row', () => {
  const rows = Array.from({ length: 200 }, (_, index) => `site,${index % 7},${index * 3}`);
  const beforeText = `place,group,count\n${rows.join('\n')}\n`;
  const afterText = `place,group,count\n${rows.toSpliced(2, 0, 'site,9,999').join('\n')}\n`;

  const diff = tableDiff(beforeText, afterText);

  assert.deepEqual(diff, {
    format: 'table',
    keyColumn: null,
    rowsAdded: ['row:3'],
    rowsRemoved: [],
    cellsChanged: [],
    summary: { rowsAdded: 1, rowsRemoved: 0, cellsChanged: 0 },
  });
});

test('A sorted table without row names reports no changed cells', () => {
  const rows = ['north,4,12', 'south,2,30', 'north,1,8', 'east,7,3', 'south,2,30'];
  const beforeText = `place,group,count\n${rows.join('\n')}\n`;
  const afterText = `place,group,count\n${rows.toSorted().join('\n')}\n`;

  const diff = tableDiff(beforeText, afterText);

  assert.deepEqual(diff.cellsChanged, []);
  assert.deepEqual(diff.summary, { rowsAdded: 0, rowsRemoved: 0, cellsChanged: 0 });
  assert.deepEqual([diff.rowsAdded, diff.rowsRemoved], [[], []]);
});

test('A changed row in a table without row names reports its changed cells by its new position', () => {
  const beforeText = 'place,group,count\nnorth,4,12\nnorth,1,8\nsouth,2,30\nsouth,5,2\n';
  const afterText = 'place,group,count\nnew,0,0\nnorth,4,12\nnorth,1,9\nsouth,2,30\n';

  const diff = tableDiff(beforeText, afterText);

  // The rows left over once whole rows are matched are paired in order: the
  // first leftover row of each file, then the second.
  assert.deepEqual(diff.cellsChanged, [
    { rowKey: 'row:1', column: 'place', before: 'north', after: 'new' },
    { rowKey: 'row:1', column: 'group', before: '1', after: '0' },
    { rowKey: 'row:1', column: 'count', before: '8', after: '0' },
    { rowKey: 'row:3', column: 'place', before: 'south', after: 'north' },
    { rowKey: 'row:3', column: 'group', before: '5', after: '1' },
    { rowKey: 'row:3', column: 'count', before: '2', after: '9' },
  ]);
  assert.deepEqual(diff.summary, { rowsAdded: 0, rowsRemoved: 0, cellsChanged: 6 });
});

test('Rows removed from a table without row names are named by their old position', () => {
  const beforeText = 'place,count\nnorth,12\nnorth,8\nsouth,30\nsouth,30\n';
  const afterText = 'place,count\nnorth,12\nsouth,30\n';

  const diff = tableDiff(beforeText, afterText);

  assert.deepEqual(diff.rowsRemoved, ['row:2', 'row:4']);
  assert.deepEqual(diff.summary, { rowsAdded: 0, rowsRemoved: 2, cellsChanged: 0 });
});

test('A table with row names still matches rows by name', () => {
  const beforeText = 'patient,age,site\np1,62,north\np2,31,south\np3,50,east\n';
  const afterText = 'patient,age,site\np3,50,east\np1,63,north\np4,44,west\n';

  const diff = tableDiff(beforeText, afterText, 'patients.csv');

  assert.deepEqual(diff, {
    format: 'table',
    keyColumn: 'patient',
    rowsAdded: ['p4'],
    rowsRemoved: ['p2'],
    cellsChanged: [{ rowKey: 'p1', column: 'age', before: '62', after: '63' }],
    summary: { rowsAdded: 1, rowsRemoved: 1, cellsChanged: 1 },
  });
});

test('A repeated row name added to a named table reports only the new row', () => {
  const beforeText = 'patient,age\np1,62\np2,31\n';
  const afterText = 'patient,age\np1,62\np2,31\np2,32\n';

  const diff = tableDiff(beforeText, afterText);

  assert.deepEqual(diff.rowsAdded, ['row:3']);
  assert.deepEqual(diff.rowsRemoved, []);
  assert.deepEqual(diff.cellsChanged, []);
});

test('An event for a long file and a table without row names stores and shows only what changed', async (t) => {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-diff-test-')));
  const root = path.join(sandbox, 'project');
  fs.mkdirSync(root);
  const lines = Array.from({ length: LONG_FILE_LINES }, (_, index) => `log line ${index} with steady content`);
  const rows = Array.from({ length: 300 }, (_, index) => `site,${index % 7},${index * 3}`);
  fs.writeFileSync(path.join(root, 'run.log'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'readings.csv'), `place,group,count\n${rows.join('\n')}\n`);
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => {
    await app.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const { project } = app.timeline.importProject(root, actor);
  fs.writeFileSync(path.join(root, 'run.log'), `${lines.with(12_000, 'log line 12000 was rewritten').join('\n')}\n`);
  fs.writeFileSync(path.join(root, 'readings.csv'), `place,group,count\n${rows.toSpliced(4, 0, 'site,9,999').join('\n')}\n`);

  const { event } = app.timeline.capture(project.id, actor, { source: 'WATCHER', dirtyPaths: ['run.log', 'readings.csv'] });

  const stored = (filePath) => app.db.prepare('SELECT structured_diff_json FROM file_changes WHERE event_id = ? AND path_after = ?')
    .get(event.id, filePath).structured_diff_json;
  const shown = (filePath) => app.timeline.getEvent(event.id).changes.find((change) => change.pathAfter === filePath).structuredDiff;
  assert.ok(stored('run.log').length < 512, `run.log stores ${stored('run.log').length} bytes for a one-line change`);
  assert.deepEqual(changes(shown('run.log')), [
    { kind: 'remove', text: 'log line 12000 with steady content', beforeLine: 12_001 },
    { kind: 'add', text: 'log line 12000 was rewritten', afterLine: 12_001 },
  ]);
  assert.ok(stored('readings.csv').length < 512, `readings.csv stores ${stored('readings.csv').length} bytes for one added row`);
  assert.deepEqual(shown('readings.csv'), {
    format: 'table',
    keyColumn: null,
    rowsAdded: ['row:5'],
    rowsRemoved: [],
    cellsChanged: [],
    summary: { rowsAdded: 1, rowsRemoved: 0, cellsChanged: 0 },
  });
});
