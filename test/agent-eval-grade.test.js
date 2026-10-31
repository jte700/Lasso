import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gradeAnswer, gradeEvidence, responseUnits, validateSpec } from '../scripts/agent-eval/grade.mjs';
import { plainText } from '../scripts/agent-eval/build.mjs';

const spec = JSON.parse(fs.readFileSync(new URL('../scripts/agent-eval/dev/spec.json', import.meta.url), 'utf8'));
const task = (id) => spec.tasks.find((item) => item.id === id);
const documents = spec.documents.map(plainText).join('\n');

test('the development set is valid: every fact is stated in one sentence or table row of a document', () => {
  assert.deepEqual(validateSpec(spec), []);
});

test('a compact correct answer passes without the rows it was worked out from', () => {
  // Arrange
  const answer = 'Ashford had the highest completion: 68 of its 72 participants (94%) were assessed at 12 weeks.';

  // Act
  const graded = gradeAnswer(task('brisk-best-site'), answer, documents);

  // Assert
  assert.equal(graded.correct, true, JSON.stringify(graded));
  assert.deepEqual(graded.derived, ['94%'], 'a percentage worked out from two stated numbers is not invented');
});

test('an answer is wrong when it leaves out a qualification, a conflict or a material fact, or states a number the evidence lacks', () => {
  // Arrange
  const unqualified = 'Older participants (70 and over) benefited less, with a difference of 0.6 points.';
  const oneSide = 'Pain improved by 2.1 points more with the programme than with usual care.';
  const incomplete = 'At 12 weeks pain improved 1.7 points more with exercise, above the minimal clinically important difference.';
  const invented = 'BRISK enrolled 412 adults and pain improved 1.7 points, with 27 adverse events.';

  // Act
  const older = gradeAnswer(task('brisk-older'), unqualified, documents);
  const conflict = gradeAnswer(task('brisk-conflict'), oneSide, documents);
  const summary = gradeAnswer(task('brisk-summary'), incomplete, documents);
  const numbers = gradeAnswer(task('brisk-size'), invented, documents);

  // Assert
  assert.deepEqual(older.unqualified, ['q3']);
  assert.deepEqual(conflict.unreconciled, ['f1/f6'], 'one side of a disagreement, unacknowledged');
  assert.deepEqual(summary.missing, ['f3', 'f4'], 'function and the 24-week result were left out');
  assert.deepEqual(numbers.unsupported, ['27']);
  assert.ok([older, conflict, summary, numbers].every((graded) => !graded.correct));
});

test('an answer about something the documents lack must say so', () => {
  // Arrange, act and assert
  assert.equal(gradeAnswer(task('brisk-depression'), 'The BRISK report does not mention depression or mood.', documents).correct, true);
  assert.equal(gradeAnswer(task('brisk-depression'), 'Depression scores improved slightly with exercise.', documents).correct, false);
});

test('evidence counts a table value only with its own row, read with the header', () => {
  // Arrange
  const rows = 's1 Sites table, 2 rows:\n  Site | Randomised | Completed 12 weeks\n  Ashford | 72 | 68\n  Bexley | 65 | 58';
  const scrambled = 's1 Sites table, 2 rows:\n  Site | Randomised | Completed 12 weeks\n  Ashford | 65 | 58\n  Bexley | 72 | 68';
  const sites = { ...task('brisk-best-site'), facts: task('brisk-best-site').facts.slice(0, 2), computed: [] };

  // Act
  const units = responseUnits(rows);
  const right = gradeEvidence(sites, rows);
  const wrong = gradeEvidence(sites, scrambled);

  // Assert
  assert.ok(units.includes('s1 Sites table, 2 rows:\n  Site | Randomised | Completed 12 weeks\n  Ashford | 72 | 68'));
  assert.equal(right.facts, '2/2');
  assert.equal(wrong.facts, '0/2', 'Ashford beside Bexley\'s numbers is not Ashford\'s row');
});
