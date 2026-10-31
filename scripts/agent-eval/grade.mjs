// Grading for the evaluation sets (scripts/agent-eval/SPEC.md).
//
// A fact counts only where all of its patterns match inside one unit: one
// sentence or passage, one record line, or one table row read with its
// header. That checks that a value belongs to its entity, period and unit,
// not merely that the number appears somewhere in the response.
//
// gradeEvidence grades what Lasso returned: could a careful reader answer the
// task from it alone? gradeAnswer grades a model's final answer: does it
// state the material facts, with their qualifications and conflicts, and does
// every number in it come from the evidence?

import { plainText } from './build.mjs';
import { estimateTokens } from '../../src/agent/metrics.js';

const matcher = (patterns) => patterns.map((pattern) => new RegExp(pattern, 'i'));
const matchesAll = (unit, patterns) => patterns.every((pattern) => pattern.test(unit));

/** Sentences of prose, and table rows each read with the table's caption and header. */
export function documentUnits(document) {
  if (document.type === 'xlsx') {
    return document.sheets.flatMap((sheet) => sheet.rows.map((row) => `${sheet.header.join(' | ')}\n${row.join(' | ')}`));
  }
  const blocks = document.type === 'pdf' ? document.pages.flat() : document.blocks ?? [];
  return blocks.flatMap((block) => {
    if (block.table) {
      const head = `${block.table.caption ?? ''}\n${block.table.header.join(' | ')}`;
      return block.table.rows.map((row) => `${head}\n${row.join(' | ')}`);
    }
    return sentences(block.heading ?? block.paragraph ?? '');
  });
}

export function sentences(text) {
  return String(text).split(/(?<=[.!?])\s+(?=[A-Z0-9("“])/).map((sentence) => sentence.trim()).filter(Boolean);
}

/** Every fact and qualification must be stated in one unit of some document; ids must exist; computed values must be stated. */
export function validateSpec(spec) {
  const problems = [];
  const units = spec.documents.flatMap((document) => documentUnits(document).map((unit) => ({ unit, path: document.path })));
  for (const task of spec.tasks) {
    const ids = new Set((task.facts ?? []).map((fact) => fact.id));
    for (const item of [...(task.facts ?? []), ...(task.qualifications ?? [])]) {
      const patterns = matcher(item.all);
      if (!units.some(({ unit }) => matchesAll(unit, patterns))) problems.push(`${task.id}/${item.id}: no single sentence or row states ${JSON.stringify(item.all)}`);
    }
    for (const qualification of task.qualifications ?? []) if (!ids.has(qualification.for)) problems.push(`${task.id}/${qualification.id}: unknown fact ${qualification.for}`);
    for (const conflict of task.conflicts ?? []) for (const id of conflict.between) if (!ids.has(id)) problems.push(`${task.id}: conflict names unknown ${id}`);
    for (const computed of task.computed ?? []) for (const id of computed.from) if (!ids.has(id)) problems.push(`${task.id}/${computed.id}: unknown fact ${id}`);
    for (const set of task.absence ?? []) {
      if (!task.absent) problems.push(`${task.id}: absence given for a task that is not absent`);
      if (!units.some(({ unit }) => matchesAll(unit, matcher(set)))) problems.push(`${task.id}/absence: no single sentence states ${JSON.stringify(set)}`);
    }
  }
  return problems;
}

/**
 * The units of a rendered Lasso response: each line, except that a table's
 * rows are read with its header line, as a person reads a table.
 */
export function responseUnits(text) {
  const lines = String(text).split('\n');
  const units = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    units.push(line);
    // "… table, 12 rows:" then a header line, then rows, each "a | b | c".
    if (/ table, .*rows?:\s*$/.test(line) && /\|/.test(lines[index + 1] ?? '')) {
      const header = lines[index + 1];
      for (let row = index + 2; row < lines.length && /\|/.test(lines[row]) && /^\s/.test(lines[row]); row += 1) units.push(`${line}\n${header}\n${lines[row]}`);
    }
  }
  return units.filter((unit) => unit.trim());
}

const NOT_FOUND = /\b(?:no indexed text|nothing in|none of the|not found|no match|no exact match|not (?:in|mentioned|reported)|absent)\b/i;

/** Whether a response alone lets a careful reader complete the task, and how much of it is about the task. */
export function gradeEvidence(task, text) {
  const units = responseUnits(text);
  const facts = task.facts ?? [];
  const supported = new Set(facts.filter((fact) => units.some((unit) => matchesAll(unit, matcher(fact.all)))).map((fact) => fact.id));
  const qualifications = (task.qualifications ?? []).filter((qualification) => supported.has(qualification.for));
  const qualified = qualifications.filter((qualification) => units.some((unit) => matchesAll(unit, matcher(qualification.all))));
  const conflicts = task.conflicts ?? [];
  const conflictsShown = conflicts.filter((conflict) => conflict.between.every((id) => supported.has(id)));
  const computed = task.computed ?? [];
  const computedOk = computed.filter((item) => units.some((unit) => new RegExp(`\\b${item.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(unit))
    || item.from.every((id) => supported.has(id)));
  const material = facts.filter((fact) => fact.material);
  const materialFound = material.filter((fact) => supported.has(fact.id));
  // Absence is shown by a search that says it found nothing, or by a document's own sentence saying so.
  const absentOk = !task.absent || NOT_FOUND.test(text) || (task.absence ?? []).some((set) => units.some((unit) => matchesAll(unit, matcher(set))));
  const sufficient = materialFound.length === material.length && qualified.length === qualifications.length
    && conflictsShown.length === conflicts.length && computedOk.length === computed.length && absentOk;
  // The share of the response in lines that state some fact or qualification of the task.
  const patterns = [...facts, ...(task.qualifications ?? [])].map((item) => matcher(item.all));
  const lines = String(text).split('\n');
  const relevant = lines.filter((line) => patterns.some((set) => matchesAll(line, set)));
  const tokens = estimateTokens(text);
  return {
    sufficient, tokens, relevantShare: tokens ? Math.round((estimateTokens(relevant.join('\n')) / tokens) * 100) / 100 : 0,
    material: `${materialFound.length}/${material.length}`, facts: `${supported.size}/${facts.length}`,
    missing: material.filter((fact) => !supported.has(fact.id)).map((fact) => fact.id),
    qualifications: `${qualified.length}/${qualifications.length}`, conflicts: `${conflictsShown.length}/${conflicts.length}`,
    computed: `${computedOk.length}/${computed.length}`, ...(task.absent ? { absentSaid: absentOk } : {}),
  };
}

const NUMBER = /(?<![\w.])-?\d[\d,]*(?:\.\d+)?%?/g;
const normalizeNumber = (value) => value.replace(/,/g, '').replace(/%$/, '').replace(/^-/, '');

/**
 * The numbers an answer states, sorted into those the evidence (or the prompt,
 * or a computed value) states; those worked out, at the answer's precision,
 * from two numbers the answer itself states and the evidence supports ("68 of
 * its 72 participants (94%)"); and the rest, unsupported. Operands must be in
 * the answer: with dozens of numbers in the evidence, almost any number is the
 * sum or ratio of some two of them.
 */
export function numbersOf(answer, evidence, task) {
  const known = new Set([...String(evidence).matchAll(NUMBER), ...String(task.prompt).matchAll(NUMBER)].map((match) => normalizeNumber(match[0])));
  for (const item of task.computed ?? []) known.add(normalizeNumber(item.value));
  const result = { stated: [], derived: [], unsupported: [] };
  const pending = [];
  for (const raw of [...String(answer).matchAll(NUMBER)].map((match) => match[0])) {
    const number = normalizeNumber(raw);
    // A rounding of a stated figure (1.69 for 1,694,950; 64 for 64.2).
    const rounding = [...known].some((other) => other.length > number.length && (other.startsWith(number)
      || (Number(other) && Math.abs(Number(other) - Number(number)) / Math.abs(Number(other)) < 0.005)));
    if (known.has(number) || rounding) result.stated.push(raw); else pending.push(raw);
  }
  const operands = result.stated.map((raw) => Number(normalizeNumber(raw))).filter((value) => Number.isFinite(value) && value !== 0);
  for (const raw of pending) {
    const number = normalizeNumber(raw);
    const value = Number(number);
    const precision = number.includes('.') ? 10 ** -(number.split('.')[1].length) / 2 : 0.5;
    const derived = operands.some((left) => operands.some((right) => [left / right * 100, left / right, left + right, left - right]
      .some((candidate) => Math.abs(candidate - value) <= precision)));
    (derived ? result.derived : result.unsupported).push(raw);
  }
  return result;
}

export function unsupportedNumbers(answer, evidence, task) {
  return numbersOf(answer, evidence, task).unsupported;
}

const CONFLICT_SAID = /\b(?:differ|differs|different|disagree|inconsisten|discrepan|conflict|whereas|while the|but the (?:memo|report|abstract))/i;
const ABSENT_SAID = /\b(?:not (?:mention|report|measure|assess|include|contain|found|available|analy[sz]e)|no (?:data|information|mention|record|results?|figure)|(?:does|did|do)n['’]?t|(?:does|did|do) not)\b/i;

/** Whether a model's final answer is correct, complete and supported by the evidence it was given. */
export function gradeAnswer(task, answer, evidence) {
  const parts = sentences(answer);
  const stated = new Set((task.facts ?? []).filter((fact) => parts.some((part) => matchesAll(part, matcher(fact.all)))).map((fact) => fact.id));
  const material = (task.facts ?? []).filter((fact) => fact.material);
  const missing = material.filter((fact) => !stated.has(fact.id)).map((fact) => fact.id);
  const unqualified = (task.qualifications ?? []).filter((qualification) => stated.has(qualification.for)
    && !parts.some((part) => matchesAll(part, matcher(qualification.all)))).map((qualification) => qualification.id);
  const unreconciled = (task.conflicts ?? []).filter((conflict) => !(conflict.between.every((id) => stated.has(id))
    || (conflict.between.some((id) => stated.has(id)) && CONFLICT_SAID.test(answer)))).map((conflict) => conflict.between.join('/'));
  const computedMissing = (task.computed ?? []).filter((item) => !new RegExp(`\\b${item.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(answer)
    && !item.from.every((id) => stated.has(id))).map((item) => item.id);
  const numbers = numbersOf(answer, evidence, task);
  const invented = numbers.unsupported;
  const absentWrong = Boolean(task.absent) && !ABSENT_SAID.test(answer);
  return { correct: !missing.length && !unqualified.length && !unreconciled.length && !computedMissing.length && !invented.length && !absentWrong,
    missing, unqualified, unreconciled, computedMissing, unsupported: invented, derived: numbers.derived, ...(task.absent ? { absentSaid: !absentWrong } : {}) };
}

export { plainText };
