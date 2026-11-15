import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAnswer } from '../src/agent/render.js';
import { askTextOptions } from '../src/agent/mcp.js';

// An answer as the evidence service returns it: a search of one report asked twice, and a table row two budgets disagree on.
const answered = () => ({
  sources: {
    s1: { folder: 'Reviews', path: 'Pilot evaluation.pdf', rev: 'f920bb864b23' },
    s2: { folder: 'Finance', path: 'Approved/budget.csv', rev: 'a1adad958009', disk: 'changed' },
  },
  answers: [
    { n: 1, kind: 'found', status: 'ranked', files: 6, counts: { files: 1, matching_files: 4, sentences: 3, left_out: 3 },
      left_out_in: [['2 Previous studies', 2], ['1 Introduction', 1]], missing: ['popular'], absent: ['popular'],
      items: [{ src: 's1', type: 'excerpts', excerpts: [
        { at: 'p.1', section: 'Abstract', text: 'The library lends "household" tools for a small fee.', h: 'CTZ5760D1X' },
        { at: 'p.7', caption: 'Table 3. Loans with damage recorded at return', header: 'Category Loans Returned damaged', rows: ['Power tools 1,240 64'] },
        { at: 'p.8', section: '7 Conclusions', text: 'The pilot met its aims for reach.', h: '5ZGWNC0TFA' },
      ] }] },
    { n: 2, kind: 'found', status: 'ranked', files: 6, counts: { files: 1, matching_files: 2, sentences: 3, left_out: 0 },
      items: [{ src: 's1', type: 'excerpts', excerpts: [
        { at: 'p.1', same: '1' },
        { at: 'p.8', same: '1' },
        { at: 'p.8', section: '7 Conclusions', text: 'Savings were uncertain\nin size.', h: 'F8V76VEY8V' },
      ] }] },
    { n: 3, kind: 'record', items: [{ src: 's2', row: 'North division', at: 'row 2', fields: { Revenue: { value: '9.10', h: 'ADE2V0Q3BV' } } }] },
  ],
});

test('over MCP an answer is written lean: no handles, short revisions, excerpts as plain text, and no count of sentences', () => {
  // Arrange
  const response = answered();

  // Act
  const text = formatAnswer('ask', response, 'text', { lean: true, handles: false });
  const lines = text.split('\n');

  // Assert
  assert.equal(lines[0], 's1 = Reviews/Pilot evaluation.pdf @f920bb86', 'a revision is cut to the eight characters an ask can name it by');
  assert.equal(lines[1], 's2 = Finance/Approved/budget.csv @a1adad95 (changed on disk since indexed)');
  assert.equal(lines[2], '[1] ranked: 1/4 matching files; no indexed text in the 6 shared files has "popular"; 3 more matched (2 Previous studies 2, 1 Introduction 1); a larger "budget" shows more',
    'how to get what was left out is still said');
  assert.equal(lines[4], '  p.1 §Abstract: The library lends "household" tools for a small fee.', 'an excerpt is the file\'s words, unquoted');
  assert.deepEqual(lines.slice(5, 7), ['  p.7: Table 3. Loans with damage recorded at return [Category Loans Returned damaged]', '    Power tools 1,240 64']);
  assert.doesNotMatch(text, /#[0-9A-Z]{10}/, 'nothing offered takes a handle, so none is sent');
});

test('excerpts already shown are named on one line, and the excerpt after them still says its section', () => {
  // Arrange
  const response = answered();

  // Act
  const lines = formatAnswer('ask', response, 'text', { lean: true, handles: false }).split('\n');
  const second = lines.slice(lines.indexOf('[2] ranked: 1/2 matching files'));

  // Assert
  assert.deepEqual(second.slice(1, 4), ['[2.1] s1:', '  shown in [1]: p.1, p.8', '  p.8 §7 Conclusions: Savings were uncertain in size.'],
    'a line break inside an excerpt cannot start a line of its own');
});

test('a value and its row label stay quoted in a lean answer, so their exact characters survive', () => {
  // Arrange
  const response = answered();

  // Act
  const lean = formatAnswer('ask', response, 'text', { lean: true, handles: false });
  const cited = formatAnswer('ask', response, 'text', { lean: true, handles: true });

  // Assert
  assert.match(lean, /^\[3\] s2 "North division" row 2: Revenue="9\.10"$/m);
  assert.match(cited, /^\[3\] s2 "North division" row 2: Revenue="9\.10" #ADE2V0Q3BV$/m, 'with handles on, each value keeps its own');
  assert.match(cited, /^ {2}p\.1 §Abstract: The library lends "household" tools for a small fee\. #CTZ5760D1X$/m);
});

test('lines read at an earlier revision name both revisions short, and the file text stays fenced as it is', () => {
  // Arrange
  const response = { sources: { s1: { folder: 'Api', path: 'app.py', rev: '83757353ead4', historical: true } },
    answers: [{ n: 1, kind: 'lines', items: [{ src: 's1', h: 'D16826NQ4J', lines: [5, 6], total: 19, text: 'def handle(request):\n    return "ok"',
      historical: true, rev: '83757353ead4', current: '0be35233d4cd' }] }] };

  // Act
  const lean = formatAnswer('ask', response, 'text', { lean: true, handles: false });
  const full = formatAnswer('ask', response);

  // Assert
  assert.equal(lean, 's1 = Api/app.py @83757353 (earlier revision)\n[1] s1 lines 5-6 of 19 (earlier revision @83757353, current @0be35233)\n'
    + '```\ndef handle(request):\n    return "ok"\n```');
  assert.match(full, /^\[1\] #D16826NQ4J s1 lines 5-6 of 19 \(earlier revision @83757353ead4, current @0be35233d4cd\)$/m);
});

test('a value that was cut keeps its handle in a lean answer, since the handle is how the rest is read', () => {
  // Arrange
  const response = { sources: { s1: { folder: 'Finance', path: 'notes.md', rev: 'd2b8ed648c94' } },
    answers: [{ n: 1, kind: 'found', items: [
      { src: 's1', type: 'passage', at: 'line 3', h: 'A9PX5162FG', value: 'The North division revenue figure excludes', trunc: true },
      { src: 's1', type: 'passage', at: 'line 9', h: 'B7QK2M4T8V', value: 'Reviewed in March.' }] }] };

  // Act
  const lines = formatAnswer('ask', response, 'text', { lean: true, handles: false }).split('\n');

  // Assert
  assert.equal(lines[1], '[1.1] #A9PX5162FG s1 passage line 3: "The North division revenue figure excludes" (cut; read #h for all)');
  assert.equal(lines[2], '[1.2] s1 passage line 9: "Reviewed in March."');
});

test('the text REST and scripts ask for is unchanged: handles, whole revisions, quoted excerpts', () => {
  // Arrange
  const response = answered();

  // Act
  const lines = formatAnswer('ask', response).split('\n');

  // Assert
  assert.equal(lines[0], 's1 = Reviews/Pilot evaluation.pdf @f920bb864b23');
  assert.equal(lines[2], '[1] ranked: 3 sentences, 1/4 matching files; no indexed text in the 6 shared files has "popular"; 3 more matched (2 Previous studies 2, 1 Introduction 1); a larger "budget" shows more');
  assert.equal(lines[4], '  p.1 §Abstract: "The library lends \\"household\\" tools for a small fee." #CTZ5760D1X');
  assert.ok(lines.includes('  p.1: (shown in [1])'));
});

test('handles are sent when a tool offered can take them, or when the call asks for them', () => {
  // Arrange, act and assert
  assert.deepEqual(askTextOptions(['lasso']), { lean: true, handles: false });
  assert.deepEqual(askTextOptions(['lasso', 'lasso_search']), { lean: true, handles: false }, 'a search returns handles, it takes none');
  assert.deepEqual(askTextOptions(['lasso', 'lasso_read']), { lean: true, handles: true });
  assert.deepEqual(askTextOptions(['lasso', 'lasso_cite']), { lean: true, handles: true });
  assert.deepEqual(askTextOptions(['lasso'], { ask: ['x'], handles: true }), { lean: true, handles: true });
});
