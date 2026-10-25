import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { transaction, json } from '../db.js';
import { normalizeActor } from '../history/service.js';
import { HttpError, VersionConflictError } from '../history/errors.js';
import { csvDelimiter, diffInternals, parseDelimited } from '../history/diff.js';
import {
  MAX_IN_MEMORY_PART_BYTES, extractDocxDocument, extractPdfDocument, extractPdfFullText, extractPdfPassages,
  extractSpreadsheetTables, extractTaggedReferences, isLargeSpreadsheet,
} from './document-extraction.js';
import {
  buildSentenceCorpus, completeFromLinkedSource, completeSentence, indexSentenceCorpus, originalFindingSentence, sourceFindingFragment,
} from './completion.js';
import { renderPdfFigurePage } from './figure-preview.js';
import { columnLetter } from './table-preview.js';
import { markdownBlocks, markdownPassages } from '../sharing/markdown.js';
import { shareExpiry } from '../sharing/expiry.js';
import { RecommendationRanking, directRecommendationMatch } from './ranking.js';
import { correctedDocumentLabel, firstAuthorFamily } from './authors.js';
import { BoundedCache } from '../cache.js';
import { drawingDescriptors, drawingContext, isDesignFile, measurementOrder, measurementRelevance } from './drawing-objects.js';
import { FULL_WRITE_SHARE, storedFields } from '../history/object-versions.js';
import { runSync, workUnits } from '../history/work.js';
import { compareText } from '../history/text-order.js';
import { TextStore } from './text-store.js';
import { IFC_MODEL_VERSION, keepIfcModelsIn } from './ifc-geometry.js';
import { TAIL_ROWS, TableIndex, writeTable } from './table-index.js';
import { Worker } from 'node:worker_threads';
import { canonicalRowReference, normalizedRowSearch, rowSearchAliases } from './row-names.js';
import { dictionaryColumns, humanVariable, normalizedVariable, spreadsheetLayout, tableShape, tabularLayout } from './tabular.js';

export { spreadsheetLayout, tabularLayout };
import { extractDrawingDocument } from './drawing-extraction.js';
import { buildModelPreview } from './model-preview.js';
import { DRAWING_NAME_MIN_LETTERS, drawingDiscovery, drawingReferenceMatch } from './drawing-discovery.js';
import { fileReferenceMatch, isWholeFile, typedAsWritten } from './file-reference.js';
import { fieldCue, recordFields } from './record-fields.js';
import { presentationOutline, presentationPlainText, readPresentation, slideAtLine } from './presentation-extraction.js';
import {
  MAX_CODE_LINES, codeOfLines, codeOnOwnLines, fileLines, fileNameBefore, lineMentionAtEnd, lineMentionBeforeName,
  linesLabel,
} from './code-lines.js';
import { currentFileType, isCodePath, isCodeType } from '../history/file-types.js';

const OBJECT_TYPES = new Set([
  'REFERENCE', 'PAPER', 'RESULT', 'VALUE', 'CODE', 'CODE_BLOCK', 'CODE_LINE',
  'NOTEBOOK_CELL', 'DATASET', 'DATASET_ROW', 'DATASET_VALUE', 'TABLE', 'FIGURE', 'METHOD', 'MODEL',
  'PARAMETER', 'PROTOCOL', 'ANALYSIS_RUN', 'DOCUMENT', 'VARIABLE', 'DRAWING', 'DRAWING_ANNOTATION',
]);
const SELECTION_METHODS = new Set(['AUTOCOMPLETE', 'PREDICTED_ACCEPTED', 'MANUAL', 'SYSTEM_LINKED', 'IMPORTED']);
const STATUS_TYPES = new Set(['PREDICTED', 'LINKED', 'NEEDS_REVIEW', 'STALE', 'BROKEN']);
// Up to this many new objects are looked up one by one; larger batches look
// up only the keys being indexed, not every historical object in the folder.
const INDIVIDUAL_OBJECT_LOOKUPS = 200;
const INDEX_VERSION = 4;
// The object types a whole file can be named as while typing.
const WHOLE_FILE_TYPES = ['DRAWING', 'DATASET', 'DOCUMENT', 'PAPER', 'CODE_BLOCK', 'MODEL'];
const STEP_FILE = /\.(?:step|stp)$/i;
// The reader that turns file bytes into indexed objects. Bumped whenever
// extraction changes what it reads out of unchanged files, so a project indexed
// by an older build can be offered a re-read. A snapshot records the version
// that produced its objects in snapshot_object_indexes.extractor_version; 0
// there means a build that recorded none.
// 2: notes written below a table are read as text, not as rows of the table.
// 3: a row label outside column A is no longer also read as a cell of its
//    own row.
// 4: worksheet cells are anchored at their sheet row, and statements with
//    year columns read their indented labels as rows.
// 5: all eligible files remain indexed in large folders, and ordinary STEP
//    feature groups are no longer discarded by small per-kind limits.
// 6: worksheets and delimited files of any size are read whole into the
//    table index; those past the in-memory limit were skipped or cut short.
const EXTRACTOR_VERSION = 7;
const MAX_TABLE_CELLS = 1_500;
const MAX_INDEXED_TABLE_ROWS = 1_000;
// The last rows of a large table read for the notes written under it.
const TABLE_TAIL_ROWS = TAIL_ROWS;
// How much the table index adds to a suggestion: rows matched per table, rows
// shown among the names offered, and cells offered for an accepted source.
const INDEXED_MATCHES_PER_TABLE = 12;
const INDEXED_ROWS_SHOWN = 8;
const INDEXED_RELATED_OBJECTS = 64;
const EDITABLE_DOCUMENT_TYPES = new Set(['markdown', 'text', 'document', 'pdf']);
// What a code line's key starts with, after its file's id; recorded so later readings keep it.
const CODE_LINES_KEY = 'lines';
const STOP_WORDS = new Set([
  'about', 'after', 'before', 'between', 'from', 'have', 'into', 'levels', 'prior', 'shown',
  'that', 'the', 'their', 'this', 'using', 'with', 'were', 'was', 'and', 'for', 'our', 'has',
]);

function id() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }
function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function posixPath(value) { return String(value).split(path.sep).join('/'); }

function dependencyFilePriority(file) {
  const source = String(file.path ?? '').toLowerCase();
  if (/(^|\/)(results?|outputs?|references?|papers?|literature|readings?|articles?|publications?)(\/|$)/.test(source)) return 5;
  if (/(^|\/)(analysis|models?|figures?|tables?|data|datasets?|runs?)(\/|$)/.test(source)) return 4;
  if (/(^|\/)manuscripts?(\/|$)/.test(source)) return 2;
  return 1;
}

function wordTokens(value) {
  return [...new Set(String(value ?? '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [])]
    .filter((token) => !STOP_WORDS.has(token));
}

function variableTokens(value) {
  return String(value ?? '').toLowerCase().match(/[a-z][a-z0-9]*/g) ?? [];
}

// Where the last sentence before the cursor ended: terminal punctuation, with
// any closing quote or bracket, before a space or the cursor; or a line break.
// A dot inside a name ("Bracket.step") or a number ("4.8") ends nothing, nor
// does an abbreviation's ("e.g. gross") unless a capitalised word follows it.
function sentenceStartBefore(before) {
  const masked = withoutHonorificStops(before).replace(ABBREVIATIONS, (match, offset) =>
    /^(?:\s+\p{Lu}|\s*$)/u.test(before.slice(offset + match.length)) ? match : `${match.slice(0, -1)} `);
  let start = 0;
  for (const end of masked.matchAll(/[.!?]["'”’)\]]*(?=\s|$)|\n/g)) start = end.index + end[0].length;
  return start;
}

function writingSourceContext(text, cursor, section = '') {
  const source = String(text ?? '');
  const before = source.slice(0, cursor);
  const sentenceStart = sentenceStartBefore(before);
  const sentence = before.slice(sentenceStart);
  const words = variableTokens(sentence);
  const literatureIntent = /\b(?:et\s+al|according\s+to|cited\s+by|paper|article|publication|authors?|researchers?|investigators?|prior\s+(?:work|studies)|previous\s+(?:work|studies)|(?:study|work|report)\s+(?:by|from))\b/i.test(sentence);
  const firstPerson = words.some((word) => ['we', 'our', 'ours', 'us'].includes(word));
  const studyNoun = words.some((word) => /^(?:study|analysis|dataset|data|result|results|cohort|experiment|samples?|model)$/.test(word));
  const reportingVerb = words.some((word) => /^(?:find|found|show|showed|observe|observed|detect|detected|identify|identified|report|reported|measure|measured|quantify|quantified|record|recorded|reveal|revealed|indicate|indicated|demonstrate|demonstrated|estimate|estimated|calculate|calculated|analyze|analysed|analyzed|assess|assessed|discover|discovered)$/.test(word));
  const selfStudy = /\b(?:this|current|present)\s+(?:study|analysis|dataset|data|cohort|experiment|work)\b/i.test(sentence);
  const resultsSection = /\b(?:results?|findings?|analysis|outcomes?)\b/i.test(section);
  return {
    sentence,
    sentenceStart,
    literatureIntent,
    projectIntent: !literatureIntent && (firstPerson || studyNoun || reportingVerb
      || selfStudy || resultsSection),
  };
}

function hasSpecificCompletionTail(sentence) {
  const last = variableTokens(sentence).at(-1) ?? '';
  if (last.length < 3 || STOP_WORDS.has(last)) return false;
  return !/^(?:we|us|ours?|study|analysis|dataset|data|result|results|cohort|experiment|samples?|model|find|found|show|showed|shows|observe|observed|observes|detect|detected|identify|identified|report|reported|measure|measured|reveal|revealed|indicate|indicated|indicates|demonstrate|demonstrated|estimate|estimated|include|included|includes)$/.test(last);
}

// A fragment that begins with one of these is part of the sentence, not of a
// source name. Replacing it would delete the word ("cost of office sup"), and
// a lone function word ("is", "of") would match unrelated names.
const FRAGMENT_FUNCTION_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'from', 'with',
  'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'and', 'or', 'but', 'if', 'so', 'than', 'then', 'that',
  'this', 'these', 'those', 'has', 'have', 'had', 'our', 'their', 'we', 'via', 'into', 'onto']);

// Sentence punctuation, optionally inside a closing quote or bracket, then a
// space; or a line break. A decimal point ("4.8") is not followed by a space,
// and common abbreviations ("vs.", "e.g.") are removed before testing.
const SENTENCE_BOUNDARY = /[.!?]["'”’)\]]*\s|\n/;
const ABBREVIATIONS = /\b(?:e\.g|i\.e|vs|etc|approx|cf|fig|figs|no|nos|eq|ref|al|ca)\./gi;
// A title before a name ("Dr. Lavalee") never ends a sentence, capital or not.
const HONORIFICS = /\b(?:Dr|Mr|Mrs|Ms|Mx|Prof|Rev|Hon|Capt|Sgt|Lt)\./gi;

function withoutHonorificStops(text) {
  return String(text ?? '').replace(HONORIFICS, (match) => `${match.slice(0, -1)} `);
}
const CLAUSE_JOINER = /\b(?:and|or|but|while|whereas|versus|vs\.?)\s+/gi;

function endsSentence(text) {
  return SENTENCE_BOUNDARY.test(withoutHonorificStops(text).replace(ABBREVIATIONS, (match) => match.slice(0, -1)));
}

/** Where the clause being written starts: after its sentence's last joining word, if any. */
export function currentClauseStart(text, cursor) {
  const { sentence, sentenceStart } = writingSourceContext(text, cursor);
  const joiner = [...sentence.matchAll(CLAUSE_JOINER)].at(-1);
  return sentenceStart + (joiner ? joiner.index + joiner[0].length : 0);
}

/**
 * Whether a file named in the text is the file of a focus chosen with
 * fn+Right. That focus has no text of its own, so the accepted name it came
 * from ("Bracket.step", then fn+Left and back) names the focus, not a new
 * source to choose. Compared by file name, whichever directory holds it.
 */
export function namesFocusedFile(claim, dependency) {
  if (!dependency?.focused) return false;
  const fileName = (value) => path.posix.basename(String(value ?? '')).toLowerCase();
  const focusedFile = fileName(dependency.source.path);
  return Boolean(focusedFile) && (claim.candidates ?? [])
    .some((candidate) => candidate.fileReference && fileName(candidate.path) === focusedFile);
}

// The values of a focus chosen on the words being typed replace those words
// and anything typed after them ("brac" → "100 mm"). Trailing spaces stay,
// including the no-break space browser editors leave at the caret.
function replacingFocusWords(completions, dependency, text, cursor) {
  if (!dependency?.replacesText) return completions;
  const { start } = dependency.anchor;
  const claimEnd = start + text.slice(start, cursor).replace(/[^\S\r\n]+$/, '').length;
  return completions.map((completion) => ({ ...completion, claimStart: start, claimEnd }));
}

// What can have values below it: a CAD part's measurements, a table row's
// cells or a column's values. Anything else offered is a value itself.
const VALUE_HOLDERS = new Set(['DRAWING', 'DATASET_ROW', 'VARIABLE']);

// Rows keyed by a code ("CO-001", "S014") are found by typing the code's own
// terms elsewhere; as typed names they would bury real names on two letters.
const IDENTIFIER_HEADER = /(?:^|\s)(?:id|code|no|number|ref|reference|sample|subject|participant|patient)$/i;
const IDENTIFIER_VALUE = /^[A-Za-z]{0,6}[-_]?\d[\w-]*$/;

function isIdentifierRow(object) {
  const header = humanVariable(object.metadata.columns?.[0] ?? '');
  return IDENTIFIER_HEADER.test(header) || IDENTIFIER_VALUE.test(String(object.metadata.row ?? object.label).trim());
}

function measuredPartWords(object) {
  return variableTokens(humanVariable(object.metadata?.entityName ?? ''));
}

// "bracket length": a measured part's name leads the words and the rest begin
// words of one of its measurements, so other models' lengths do not qualify.
function namesMeasuredPart(object, queryWords, part = measuredPartWords(object)) {
  if (!part.length || queryWords.length <= part.length || part.some((word, index) => queryWords[index] !== word)) return false;
  return queryWords.slice(part.length).every((word) => object.variableWords.some((candidate) => candidate.startsWith(word)));
}

/** How a variable's name matches what is typed, apart from naming a measured part. */
function variableNameMatch(name, normalizedQuery, queryWords) {
  const exact = name.normalizedVariable === normalizedQuery;
  const prefix = !exact && name.normalizedVariable.startsWith(normalizedQuery);
  // Only a match that starts a word counts; "is" must not match "Revision".
  const contains = !prefix && name.wordSuffixes.some((suffix) => suffix.startsWith(normalizedQuery));
  const tokenPrefix = queryWords.length > 0 && queryWords.every((word) => name.variableWords
    .some((candidateWord) => candidateWord === word || candidateWord.startsWith(word)));
  return { exact, prefix, contains, tokenPrefix };
}

function wordSuffixes(words) {
  return words.map((_, index) => words.slice(index).join(''));
}

/** Name fragments ending at the cursor, longest first. None starts at or before
 * `after`, the end of a value already accepted ("100 mm" is not "mm"). */
function progressiveVariableFragments(text, cursor, after = -1) {
  const source = String(text ?? '');
  if (cursor !== source.length) return [];
  const context = writingSourceContext(source, cursor);
  if (context.literatureIntent) return [];
  const matches = [...context.sentence.matchAll(/[A-Za-z][A-Za-z0-9_./+-]*/g)];
  if (!matches.length) return [];
  const output = [];
  const first = Math.max(0, matches.length - 6);
  for (let index = first; index < matches.length; index += 1) {
    const start = context.sentenceStart + matches[index].index;
    const raw = source.slice(start, cursor);
    const leading = raw.match(/^\s*/)?.[0].length ?? 0;
    const trailing = raw.match(/\s*$/)?.[0].length ?? 0;
    const fragment = raw.slice(leading, raw.length - trailing);
    const firstWord = fragment.match(/^[A-Za-z]+/)?.[0].toLowerCase();
    if (start + leading > after && normalizedVariable(fragment).length >= 2 && !FRAGMENT_FUNCTION_WORDS.has(firstWord)) {
      output.push({ text: fragment, start: start + leading, end: cursor - trailing });
    }
  }
  return output.sort((left, right) => right.text.length - left.text.length);
}

function numericDescriptor(value) {
  const text = String(value ?? '').trim().toLowerCase().replaceAll(',', '');
  const match = text.match(/^(?:(?:p(?:-?value)?|n|fold[_ -]?change)\s*[<=>:]?\s*)?([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(%|percent)?(?:\s*ci|\s*[- ]?fold(?:\s+change)?)?$/i);
  if (!match) return null;
  return { number: Number(match[1]), percent: Boolean(match[2]) };
}

const MEASUREMENT_UNITS = { mm: 'mm', cm: 'cm', m: 'm', km: 'km', 'µm': 'µm', mil: 'mil', in: 'in', ft: 'ft', yd: 'yd',
  'm²': 'm²', m2: 'm²', 'ft²': 'ft²', ft2: 'ft²', 'm³': 'm³', m3: 'm³', 'ft³': 'ft³', ft3: 'ft³', '°': '°', deg: '°' };

// Drawing and CAD values carry physical units. They match a written value only
// within the same unit; other values keep numericDescriptor's plain parsing.
function measurementDescriptor(value) {
  const plain = numericDescriptor(value);
  if (plain) return { ...plain, unit: null };
  const match = String(value ?? '').trim().toLowerCase().replaceAll(',', '')
    .match(/^([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(mm|cm|km|µm|mil|m²|m2|m³|m3|m|in|ft²|ft2|ft³|ft3|ft|yd|°|deg)$/);
  return match ? { number: Number(match[1]), percent: false, unit: MEASUREMENT_UNITS[match[2]] } : null;
}

// Claim values arrive without their unit; read one written right after the
// number. "in" is inches only when no word follows ("8 in diameter" is not).
function claimUnit(claim) {
  const text = String(claim.text ?? '').toLowerCase(), value = String(claim.value ?? '').toLowerCase();
  const at = value ? text.lastIndexOf(value) : -1;
  const match = at < 0 ? null : text.slice(at + value.length)
    .match(/^\s*(mm|cm|km|µm|mil|m²|m2|m³|m3|m|in(?!\s*[a-z])|ft²|ft2|ft³|ft3|ft|yd|°|deg)(?![a-z0-9²³])/);
  return match ? MEASUREMENT_UNITS[match[1]] : null;
}

function valueMatch(claim, candidate, claimNumber = measurementDescriptor(claim.value),
  candidateNumber = measurementDescriptor(candidate.valueText)) {
  if (!claimNumber || !candidateNumber) return { score: 0, displayValue: null };
  const writtenUnit = claimNumber.unit ?? claimUnit(claim);
  if (writtenUnit && candidateNumber.unit && writtenUnit !== candidateNumber.unit) return { score: 0, displayValue: null };
  const direction = /\b(decreas|reduc|lower|declin|drop)/i.test(claim.text) ? -1
    : /\b(increas|rais|higher|grew|rise)/i.test(claim.text) ? 1 : 0;
  const expected = direction ? Math.abs(claimNumber.number) * direction : claimNumber.number;
  const candidateValues = [candidateNumber.number];
  if (candidateNumber.percent) candidateValues.push(candidateNumber.number / 100);
  if (claimNumber.percent) candidateValues.push(candidateNumber.number * 100);
  const signedPercent = claimNumber.percent
    ? `${direction > 0 ? '+' : direction < 0 ? '−' : ''}${Math.abs(claimNumber.number)}%`
    : null;
  if (candidateValues.some((number) => Math.abs(number - expected) < 1e-9)) {
    return { score: 1, displayValue: signedPercent };
  }
  if (claimNumber.percent && !candidateNumber.percent && direction) {
    const expectedFold = direction > 0
      ? 1 + Math.abs(claimNumber.number) / 100
      : 1 - Math.abs(claimNumber.number) / 100;
    if (Math.abs(candidateNumber.number - expectedFold) < 1e-9) {
      return { score: 1, displayValue: signedPercent };
    }
  }
  if (candidateValues.some((number) => Math.abs(Math.abs(number) - Math.abs(expected)) < 1e-9)) {
    return { score: 0.82, displayValue: signedPercent };
  }
  return { score: 0, displayValue: null };
}

function overlapScore(left, right) {
  return tokenOverlap(wordTokens(left), new Set(wordTokens(right)));
}

function tokenOverlap(a, b) {
  if (!a.length) return 0;
  return a.filter((token) => b.has(token)).length / Math.max(2, a.length);
}

function prefixTokenScore(query, candidate) {
  const expected = normalizedName(query);
  if (expected.length < 2) return 0;
  const tokens = String(candidate ?? '').match(/[A-Za-z][A-Za-z0-9'’-]*/g) ?? [];
  let best = 0;
  for (const token of tokens) {
    const actual = normalizedName(token);
    if (actual === expected) return 1;
    if (actual.startsWith(expected)) best = Math.max(best, 0.92);
    else if (expected.startsWith(actual) && actual.length >= 3) best = Math.max(best, 0.82);
  }
  return best;
}

function referenceSimilarity(query, object) {
  const expected = normalizedVariable(query);
  if (expected.length < 2) return 0;
  const fields = [
    object.label,
    object.valueText,
    object.metadata.author,
    object.metadata.title,
    object.metadata.subject,
    object.metadata.fileName,
    object.path,
  ].filter(Boolean).map(String);
  let best = 0;
  for (const field of fields) {
    const normalized = normalizedVariable(field);
    if (normalized === expected) return 1;
    if (normalized.startsWith(expected)) best = Math.max(best, 0.96);
    else if (normalized.includes(expected)) best = Math.max(best, 0.86);
    best = Math.max(best, prefixTokenScore(query, field));
    if (expected.length >= 3) {
      for (const token of field.match(/[A-Za-z0-9][A-Za-z0-9'’_.-]*/g) ?? []) {
        const actual = normalizedVariable(token);
        const compared = actual.slice(0, Math.min(actual.length, expected.length));
        const allowance = Math.max(1, Math.floor(expected.length / 4));
        if (compared && editDistance(expected, compared) <= allowance) best = Math.max(best, 0.74);
      }
    }
  }
  if (variableTokens(query).length > 1) {
    best = Math.max(best, ...fields.map((field) => overlapScore(query, field) * 0.9));
  }
  return best;
}

function parseBibtex(text) {
  const entries = [];
  const pattern = /@(article|book|inproceedings|misc|techreport)\s*\{\s*([^,]+),([\s\S]*?)(?=\n@|$)/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const fields = {};
    for (const field of match[3].matchAll(/(title|author|year|doi|pmid)\s*=\s*[\{"]([^\}"]+)[\}"]/gi)) {
      fields[field[1].toLowerCase()] = field[2].replace(/\s+/g, ' ').trim();
    }
    entries.push({ key: match[2].trim(), ...fields });
  }
  return entries;
}

function normalizedName(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z]/g, '');
}

function rowEditDistance(left, right) {
  const a = normalizedName(left);
  const b = normalizedName(right);
  if (!a || !b) return Number.MAX_SAFE_INTEGER;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

function citedAuthor(text) {
  return String(text ?? '').match(/\b([A-Z][A-Za-z'’-]+)\s+et al\./)?.[1] ?? '';
}

// Weak keys allow these features to disappear as bounded snapshot caches evict
// their immutable objects. Query text is never retained here.
const matchingFeatures = new WeakMap();
function objectMatchingFeatures(object) {
  const cached = matchingFeatures.get(object);
  if (cached) return cached;
  const fields = [object.metadata.variable, object.metadata.column, object.metadata.description,
    object.metadata.definition, object.metadata.inferredMeaning, object.label].filter(Boolean);
  const features = {
    numeric: measurementDescriptor(object.valueText),
    words: new Set(wordTokens(`${object.label} ${object.searchText}`)),
    variables: fields.map(normalizedVariable),
    variableWords: fields.map((field) => new Set(wordTokens(humanVariable(field)))),
    definitionKeys: [object.metadata.variable, object.metadata.column, object.metadata.row,
      String(object.label).split(' · ')[0]].map(normalizedVariable),
  };
  if (Object.isFrozen(object)) matchingFeatures.set(object, features);
  return features;
}

function variableSimilarity(expected, expectedWords, features) {
  if (expected === null) return 0;
  if (features.variables.includes(expected)) return 1;
  return Math.max(0, ...features.variableWords.map((words) => tokenOverlap(expectedWords, words)));
}

function authorSimilarity(claimAuthor, author) {
  const expected = normalizedName(claimAuthor);
  if (!expected) return 0;
  const first = String(author ?? '').split(/\s+(?:and|&)\s+|\s*;\s*/i)[0].trim();
  const fields = [first, firstAuthorFamily(first), ...(first.match(/[A-Za-z'’-]+/g) ?? [])]
    .map(normalizedName).filter(Boolean);
  let best = 0;
  for (const actual of fields) {
    if (expected === actual) return 1;
    if (actual.startsWith(expected)) best = Math.max(best, 0.94);
    else if (expected.startsWith(actual) && actual.length >= 3) best = Math.max(best, 0.86);
    const distance = editDistance(expected, actual);
    const similarity = 1 - distance / Math.max(expected.length, actual.length);
    if (similarity >= 0.7) best = Math.max(best, similarity);
  }
  return best;
}

function narrativeCitationText(object) {
  const author = String(object?.metadata?.author ?? '').trim();
  const family = firstAuthorFamily(author);
  const authors = Array.isArray(object?.metadata?.authors) ? object.metadata.authors : [];
  const multiple = authors.length > 1 || /\s+(?:and|&)\s+|;/.test(author);
  const year = String(object?.metadata?.year ?? '').trim();
  if (family) return `${family}${multiple ? ' et al.' : ''}${year ? ` (${year})` : ''}`;
  const label = String(object?.label ?? '').trim();
  return label.replace(/,\s*((?:19|20)\d{2}[a-z]?)$/i, ' ($1)');
}

function referenceCompletionText(object, query, mode = 'any') {
  if (mode === 'author') {
    return narrativeCitationText(object);
  }
  if (mode === 'any') {
    const author = authorSimilarity(query, object.metadata.author);
    const title = referenceTitleSimilarity(query, object);
    if (author >= 0.7 && author >= title) return narrativeCitationText(object);
  }
  return String(object.metadata.title ?? object.label ?? '').trim();
}

function referenceTitleSimilarity(query, object) {
  const expected = normalizedVariable(query);
  if (expected.length < 2) return 0;
  const fields = [object.metadata.title, object.metadata.subject,
    object.objectType === 'DOCUMENT' ? object.valueText : null].filter(Boolean);
  if (!fields.length) return 0;
  return referenceSimilarity(query, { ...object, label: '', valueText: '', path: '', metadata: {
    author: null, fileName: null, title: fields[0], subject: fields.slice(1).join(' '),
  } });
}

const CONTEXTUAL_INSERTION_CUES = new Set([
  ...STOP_WORDS,
  'a', 'an', 'as', 'at', 'be', 'been', 'being', 'by', 'can', 'could', 'did', 'do', 'does',
  'had', 'in', 'is', 'it', 'may', 'might', 'must', 'of', 'on', 'or', 'should', 'to',
  'will', 'would', 'than', 'through', 'under', 'during', 'across', 'around', 'approximately',
  'roughly', 'we', 'us', 'ours', 'study', 'analysis', 'dataset', 'data', 'result', 'results',
  'cohort', 'experiment', 'sample', 'samples', 'model', 'find', 'found', 'show', 'showed',
  'shows', 'observe', 'observed', 'observes', 'detect', 'detected', 'identify', 'identified',
  'report', 'reported', 'measure', 'measured', 'reveal', 'revealed', 'indicate', 'indicated',
  'indicates', 'demonstrate', 'demonstrated', 'estimate', 'estimated', 'include', 'included',
  'includes', 'increased', 'decreased',
]);

function normalizedCompletionPhrase(value) {
  return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Contextual matches still complete the word being typed, even when that word
 * did not produce the match. Finished cues and explicit table selectors instead
 * introduce the value that follows them. All positions stay in UTF-16 space. */
function contextualCompletionRange(text, cursor, replacementText, options = {}) {
  const source = String(text ?? '');
  const floor = Math.max(0, options.floor ?? 0);
  const before = source.slice(floor, cursor);
  const insertion = { claimStart: cursor, claimEnd: cursor };
  const tokenPattern = /[+\-−]?[\p{L}\p{N}\p{M}]+(?:['’_.\/+\-−][\p{L}\p{N}\p{M}]+)*%?/gu;
  const tokens = [...before.matchAll(tokenPattern)];
  const last = tokens.at(-1);
  // A trailing space, closing quote, or other punctuation ends the typed word.
  // A decimal point after a number is still a partial numeric value.
  const decimalTail = last && /^[-+−]?\d/.test(last[0])
    && last.index + last[0].length === before.length - 1 && before.endsWith('.');
  if (!last || (last.index + last[0].length !== before.length && !decimalTail)) return insertion;

  const suffixes = tokens.slice(-6).map((token) => ({
    start: floor + token.index,
    text: before.slice(token.index),
  }));
  const preserved = new Set((options.preserveSuffixes ?? [])
    .map((value) => normalizedCompletionPhrase(value).replaceAll(' ', '')).filter(Boolean));
  if (suffixes.some((suffix) => preserved.has(normalizedCompletionPhrase(suffix.text).replaceAll(' ', '')))) {
    return insertion;
  }
  const completion = normalizedCompletionPhrase(replacementText);
  // Prefer an entire matching phrase over just its final partial word.
  for (const suffix of suffixes.slice(0, -1)) {
    const phrase = normalizedCompletionPhrase(suffix.text);
    if (phrase && completion.startsWith(phrase)) return { claimStart: suffix.start, claimEnd: cursor };
  }
  if (CONTEXTUAL_INSERTION_CUES.has(last[0].toLowerCase())) return insertion;
  return { claimStart: floor + last.index, claimEnd: cursor };
}

// Sentence and paragraph objects indexed from a source's own prose: PDF pages,
// and Markdown or plain-text files. Each one cites exactly its passage.
const EXCERPT_COMPONENTS = new Set(['PDF_EXCERPT', 'TEXT_EXCERPT']);

export function isPassageExcerpt(object) {
  return EXCERPT_COMPONENTS.has(object?.metadata?.componentType);
}

function workspaceCompletionText(object) {
  const variable = String(object.metadata.variable ?? object.metadata.column ?? '').trim();
  const value = String(object.valueText ?? '').trim();
  if (isPassageExcerpt(object)) return value;
  if (object.objectType === 'DRAWING_ANNOTATION') return `${object.label} is ${value}`;
  if (object.metadata.metric === 'row-count' && value) {
    const dataset = String(object.metadata.dataset ?? object.label).replace(/\s*·\s*included rows$/i, '');
    const sheet = object.metadata.sheet ? ` (${object.metadata.sheet})` : '';
    const count = object.metadata.rows ?? value.replace(/^n\s*=\s*/i, '');
    return `${dataset}${sheet} included ${count} observations`;
  }
  if (object.objectType === 'DATASET_ROW') return object.label;
  if (object.objectType === 'VARIABLE') return variable || object.label;
  if (['RESULT', 'VALUE', 'DATASET_VALUE'].includes(object.objectType) && variable && value) {
    const unit = object.metadata.units ? ` ${object.metadata.units}` : '';
    return `${humanVariable(variable)} was ${value}${unit}`;
  }
  if (['METHOD', 'PARAMETER', 'PROTOCOL'].includes(object.objectType)) return value || object.label;
  return object.label || value;
}

function workspaceSuggestionCategory(object) {
  if (isPassageExcerpt(object)) {
    if (object.metadata.excerptType === 'note') return 'Sheet note';
    const format = object.metadata.componentType === 'PDF_EXCERPT' ? 'PDF'
      : { MARKDOWN: 'Markdown', PPTX: 'Slide' }[object.metadata.format] ?? 'Text';
    return `${format} ${object.metadata.excerptType === 'paragraph' ? 'paragraph' : 'sentence'}`;
  }
  if (object.objectType === 'DRAWING_ANNOTATION') return 'Drawing measurement';
  if (object.objectType === 'DATASET_ROW') return 'Row';
  if (object.objectType === 'VARIABLE') return 'Variable';
  if (['RESULT', 'VALUE', 'DATASET_VALUE'].includes(object.objectType)) return 'Result';
  if (['METHOD', 'PARAMETER', 'PROTOCOL', 'MODEL'].includes(object.objectType)) return 'Method';
  if (['FIGURE', 'TABLE'].includes(object.objectType)) return object.objectType === 'FIGURE' ? 'Figure' : 'Table';
  return 'Workspace';
}

function missingMeasurement(value) {
  return /^(?:n\/?a|na|nd|not detected|<\s*(?:lod|loq)|below (?:the )?(?:lod|loq))$/i.test(String(value ?? '').trim());
}


const rowReferencePrefix = (reference) => reference.replace(/\d+$/, '');

/** A word and number name a row only when the table's own row identifiers use
 * that word: "control 2" or "CON 9" beside CON4, but not "was 48", which is
 * the value being typed. */
function rowReferencesInText(value, rowKeys) {
  const prefixes = new Set(rowKeys.map((rowKey) => rowReferencePrefix(canonicalRowReference(rowKey))).filter(Boolean));
  return new Set([...String(value ?? '').matchAll(/\b[A-Za-z]{1,16}[\s_-]*\d+\b/gi)]
    .map((match) => canonicalRowReference(match[0]))
    .filter((reference) => reference && prefixes.has(rowReferencePrefix(reference))));
}


function dependencyReferencesTableRow(dependency) {
  const source = dependency?.source ?? {};
  const anchor = source.anchor ?? {};
  if (source.objectType === 'DATASET_ROW' || anchor.kind === 'table-row') return true;
  if (anchor.kind !== 'table-cell' || !anchor.rowKey) return false;
  const linkedText = normalizedRowSearch(dependency?.spanText);
  const rowKey = normalizedRowSearch(anchor.rowKey);
  const sourceValue = normalizedRowSearch(source.valueText);
  return Boolean(linkedText && rowKey && linkedText === rowKey && linkedText !== sourceValue);
}

function semanticDependencySource(dependency) {
  const source = dependency?.source ?? {};
  if (!dependencyReferencesTableRow(dependency)) return source;
  const anchor = source.anchor ?? {};
  const rowKey = String(anchor.rowKey ?? source.metadata?.row ?? dependency.spanText ?? '').trim();
  return {
    ...source,
    objectType: 'DATASET_ROW',
    valueText: null,
    anchor: {
      kind: 'table-row',
      rowKey,
      rowIndex: anchor.rowIndex,
      sheet: anchor.sheet,
    },
    metadata: {
      ...source.metadata,
      row: rowKey,
      variable: rowKey || source.metadata?.variable || null,
      column: null,
      referenceKind: 'ROW',
    },
  };
}


function editDistance(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  const previous = Array.from({ length: b.length + 1 }, (_value, index) => index);
  for (let aIndex = 1; aIndex <= a.length; aIndex += 1) {
    const current = [aIndex];
    for (let bIndex = 1; bIndex <= b.length; bIndex += 1) {
      current[bIndex] = Math.min(
        current[bIndex - 1] + 1,
        previous[bIndex] + 1,
        previous[bIndex - 1] + Number(a[aIndex - 1] !== b[bIndex - 1]),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

function rowCompletionFragments(value) {
  const source = String(value ?? '');
  const tokens = [...source.matchAll(/[A-Za-z0-9][A-Za-z0-9_.-]*/g)];
  if (!tokens.length || tokens.at(-1).index + tokens.at(-1)[0].length !== source.length) return [];
  return tokens.slice(-3).map((match, index, suffix) => {
    const first = suffix[index];
    const text = source.slice(first.index);
    return { text, start: first.index, end: source.length, normalized: normalizedRowSearch(text) };
  }).filter((fragment) => fragment.normalized.length >= 2)
    .sort((left, right) => right.normalized.length - left.normalized.length);
}

function rowCompletionScore(fragment, rowKey) {
  const query = fragment.normalized;
  let best = 0;
  for (const alias of rowSearchAliases(rowKey)) {
    if (alias === query) best = Math.max(best, 1);
    else if (alias.startsWith(query)) {
      best = Math.max(best, 0.9 + Math.min(0.08, query.length / Math.max(alias.length, 1) * 0.08));
    } else if (query.length >= 3) {
      const compared = alias.slice(0, Math.min(alias.length, query.length));
      const distance = rowEditDistance(query, compared);
      const allowance = Math.max(1, Math.floor(query.length / 4));
      if (distance <= allowance) best = Math.max(best, 0.78 - distance * 0.08);
    }
  }
  return best;
}

function fieldCompletionFragments(value) {
  const source = String(value ?? '');
  const tokens = [...source.matchAll(/[A-Za-z0-9][A-Za-z0-9_.()/-]*/g)];
  if (!tokens.length || tokens.at(-1).index + tokens.at(-1)[0].length !== source.length) return [];
  return tokens.slice(-4).map((match, index, suffix) => {
    const first = suffix[index];
    const text = source.slice(first.index);
    return { text, start: first.index, end: source.length, normalized: normalizedVariable(text) };
  }).filter((fragment) => fragment.normalized.length >= 1)
    .sort((left, right) => right.normalized.length - left.normalized.length);
}

function fieldCompletionScore(fragment, field) {
  const query = fragment.normalized;
  const candidate = normalizedVariable(field);
  if (!query || !candidate) return 0;
  if (candidate === query) return 1;
  if (candidate.startsWith(query)) return 0.9 + Math.min(0.08, query.length / candidate.length * 0.08);
  const words = variableTokens(humanVariable(field));
  if (words.some((word) => word.startsWith(humanVariable(fragment.text)))) return 0.86;
  if (query.length >= 3 && candidate.includes(query)) return 0.76;
  return 0;
}

function fieldNavigationCue(value) {
  return /(?:^|\s)(?:for|during|in|at|from|under|across|column|field|period|quarter|year|month)(?:\s+the)?\s*$/i
    .test(String(value ?? ''));
}

function mentionedFields(value, fields) {
  const text = ` ${humanVariable(value)} `;
  return new Set(fields.filter((field) => {
    const normalized = humanVariable(field);
    return normalized && text.includes(` ${normalized} `);
  }).map(normalizedVariable));
}

function plainDocumentBlocks(value) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return [{ type: 'paragraph', text: '' }];
  const explicit = text.split(/\n\s*\n+/).map((part) => part.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  if (explicit.length > 1) return explicit.map((part) => ({ type: 'paragraph', text: part }));
  const sentences = text.match(/[^.!?]+[.!?]+(?:[”’"']+)?|[^.!?]+$/g)?.map((part) => part.trim()).filter(Boolean) ?? [text];
  const blocks = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > 900) {
      blocks.push({ type: 'paragraph', text: current });
      current = sentence;
    } else current = `${current}${current ? ' ' : ''}${sentence}`;
  }
  if (current) blocks.push({ type: 'paragraph', text: current });
  return blocks;
}

function contextualStoredValue(object, tail) {
  const raw = String(object.valueText ?? '').trim();
  if (!raw) return null;
  if (/^nd$/i.test(raw)) return 'not detected';
  if (/^<\s*lod$/i.test(raw)) return 'below the limit of detection';
  if (/^<\s*loq$/i.test(raw)) return 'below the limit of quantification';
  const field = humanVariable(object.metadata.column ?? object.metadata.metric ?? object.label);
  const numeric = numericDescriptor(raw);
  const direction = /\b(?:increas|higher|rais|rise|grew)/i.test(tail) ? 1
    : /\b(?:decreas|reduc|lower|declin|drop)/i.test(tail) ? -1 : 0;
  if (numeric && direction && /\bfold(?: change)?\b/.test(field)) {
    const percent = (numeric.number - 1) * 100;
    if ((direction > 0 && percent <= 0) || (direction < 0 && percent >= 0)) return null;
    const magnitude = Math.abs(percent);
    const formatted = Number.isInteger(magnitude) ? String(magnitude)
      : magnitude.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return `${formatted}%`;
  }
  // Units qualify amounts. A word such as a classification ("Income") takes none.
  const units = numeric ? String(object.metadata.units ?? '').trim() : '';
  return `${raw}${units && !raw.toLowerCase().endsWith(units.toLowerCase()) ? ` ${units}` : ''}`;
}

/** Whether a source was accepted as its own value ("100 mm", "485000 CAD",
 * "Income") rather than by a name that leads on to values. */
function acceptedAsValue(dependency, text) {
  const { source, anchor } = dependency;
  if (['PAPER', 'REFERENCE'].includes(source.objectType)) return false;
  // A record's title names it; its fields are what come next.
  if (source.metadata?.recordFields?.length) return false;
  const accepted = normalizedVariable(String(text ?? '').slice(anchor.start, anchor.end));
  if (!accepted) return false;
  return [source.valueText, contextualStoredValue(source, String(text ?? '').slice(0, anchor.start))]
    .some((value) => value && normalizedVariable(value) === accepted);
}

// Cue words that ask for any field rather than one kind.
const OPEN_FIELD_CUES = new Set(['is', 'was', 'are', 'were']);

const comparableNumber = (value) => String(value ?? '').replace(/[\s,]/g, '').replace(/^[^\d.]+/, '');

/** The start of a number being typed at the end of the text ("was 48"), unless
 * that number completes a row reference ("control 4"). */
function typedNumberPrefix(tail, requestedRows) {
  const typed = String(tail ?? '').match(/(?:^|\s)(\d[\d,]*(?:\.\d*)?)$/)?.[1];
  if (!typed) return '';
  const rowReference = String(tail).match(/\b[A-Za-z]{1,16}[\s_-]*\d+$/)?.[0];
  return rowReference && requestedRows.has(canonicalRowReference(rowReference)) ? '' : comparableNumber(typed);
}

/** How many words of a column's name the writer used ("budget" for September Budget CAD). */
function namedFieldWords(tail, field) {
  const written = new Set(variableTokens(tail));
  return variableTokens(humanVariable(field))
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word) && written.has(word)).length;
}

function tabularProvenanceLabel(object) {
  const anchor = object.anchor ?? {};
  const parts = [object.metadata.sheet, anchor.rowKey ?? object.metadata.row, anchor.column ?? object.metadata.column]
    .filter((part, index, values) => part != null && part !== '' && values.indexOf(part) === index);
  return parts.join(' · ');
}

function titleFromFileName(fileName) {
  return String(fileName).replace(/[_-]+/g, ' ').replace(/\b(?:19|20)\d{2}[a-z]?\b/gi, '')
    .replace(/\s+/g, ' ').trim().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// A file name names an author only in citation form: "Johnson_2023" or
// "smith-et-al-2019-title". "Orchard-Services-Agreement" must not become a
// citation written by "Orchard".
const CITATION_FILE_NAME = /^([A-Za-z][A-Za-z'’]+)(?:[_ -]+et[_ -]?al\.?)?[_ -]+(?:19|20)\d{2}(?!\d)/i;

function paperMetadata(fileName) {
  const year = fileName.match(/\b(?:19|20)\d{2}[a-z]?\b/i)?.[0] ?? null;
  const authorToken = fileName.match(CITATION_FILE_NAME)?.[1] ?? '';
  const author = authorToken ? authorToken[0].toUpperCase() + authorToken.slice(1) : '';
  const title = titleFromFileName(fileName) || fileName;
  return {
    author: author || null,
    year,
    title,
    label: author ? `${author} et al.${year ? `, ${year}` : ''}` : title,
  };
}

function referenceLikePath(filePath) {
  return /(^|\/)(references?|papers?|literature|readings?|articles?|publications?)(\/|$)/i.test(filePath);
}

function flattenJson(value, prefix = '$', output = []) {
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) flattenJson(child, `${prefix}.${key}`, output);
  } else if (value != null) output.push({ path: prefix, value: String(value) });
  return output;
}

function anchorForSpan(blockIndex, blockType, blockText, start, end) {
  return {
    kind: 'manuscript-span',
    blockIndex,
    blockType,
    start,
    end,
    prefix: blockText.slice(Math.max(0, start - 32), start),
    suffix: blockText.slice(end, Math.min(blockText.length, end + 32)),
    blockFingerprint: sha(blockText.trim().replace(/\s+/g, ' ')),
  };
}

// How strongly a typed term matches text: a whole word (or its plural), the
// start of a word as it is being typed, or, weakly, a fragment inside a word.
function queryTermMatcher(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const whole = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:s|es)?(?![\\p{L}\\p{N}])`, 'u');
  const start = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}`, 'u');
  return (text) => whole.test(text) ? 1 : start.test(text) ? 0.75 : text.includes(term) ? 0.25 : 0;
}

const isTextPassage = (object) => ['PDF_EXCERPT', 'TEXT_EXCERPT'].includes(object.metadata?.componentType);

// Words a person could search for: strings and numbers, never JSON syntax,
// field names, or the literal "true", "false" and "null" of flags.
function searchableValues(value, output = [], depth = 0) {
  if (typeof value === 'string') output.push(value);
  else if (typeof value === 'number' && Number.isFinite(value)) output.push(String(value));
  else if (value && typeof value === 'object' && depth < 4) {
    for (const item of Array.isArray(value) ? value : Object.values(value)) searchableValues(item, output, depth + 1);
  }
  return output;
}

function objectDescriptor({ key, type, path: filePath, anchor = null, label, value = null, contentHash, metadata = {} }) {
  return {
    key,
    type: OBJECT_TYPES.has(type) ? type : 'RESULT',
    path: filePath,
    anchor,
    label: String(label),
    value: value == null ? null : String(value),
    contentHash,
    metadata,
    searchText: `${label} ${value ?? ''} ${filePath} ${searchableValues(metadata).join(' ')}`.toLowerCase(),
  };
}




function variableProfile(column, values) {
  const present = values.map((value) => String(value ?? '').trim()).filter(Boolean);
  const numeric = present.map((value) => Number(value.replaceAll(',', ''))).filter(Number.isFinite);
  const numericShare = present.length ? numeric.length / present.length : 0;
  const samples = [...new Set(present)].slice(0, 6);
  const dataType = numericShare >= 0.8 ? 'numeric' : new Set(present.map((value) => value.toLowerCase())).size <= 12 ? 'categorical' : 'text';
  const range = dataType === 'numeric' && numeric.length
    ? { min: Math.min(...numeric), max: Math.max(...numeric) } : null;
  const inferredMeaning = `${humanVariable(column)}; inferred ${dataType} variable${range ? `; observed range ${range.min} to ${range.max}` : ''}${samples.length ? `; examples ${samples.join(', ')}` : ''}`;
  return { dataType, range, samples, inferredMeaning };
}



const filledColumns = (row) => [...row.keys()].filter((column) => String(row[column] ?? '').trim());
// A sentence, or a line that introduces one ("Source: ...", "Blue values = inputs").
// Labels such as "Rent" or "Cost of goods sold" read as neither.
const readsAsProse = (text) => /[.!?]["')\]]?$|:\s|\s=\s/.test(text);

/**
 * Notes written under a table ("Source: Budget-vs-Actual.csv", "Blue values =
 * inputs") follow its last row of figures after at least one blank row, one
 * line of text per row, and at least one of those lines is prose. They
 * describe the table rather than belong to it. Returns them by their index in
 * `filled`, or none when anything after that blank row is not such a line.
 * Rows directly under the table, section headings that rows of figures still
 * follow ("Expenses" after a blank row), and line items whose figures are not
 * filled in yet are never notes, so they stay rows of the table.
 *
 * @param {{ row: unknown[], number: number }[]} filled the table's non-blank
 *   rows with the sheet row each came from, so blank rows show as gaps
 */
function trailingTableNotes(filled) {
  const lastTableRow = filled.findLastIndex(({ row }) => filledColumns(row).length > 1);
  if (lastTableRow < 0) return new Map();
  const first = filled.findIndex((entry, index) => index > lastTableRow && entry.number - filled[index - 1].number > 1);
  if (first < 0) return new Map();
  const notes = new Map();
  for (const [index, { row }] of filled.entries()) {
    if (index < first) continue;
    const columns = filledColumns(row);
    const text = String(row[columns[0]] ?? '').trim();
    if (columns.length !== 1 || !/\p{L}/u.test(text)) return new Map();
    notes.set(index, { column: columns[0], text });
  }
  return [...notes.values()].some((note) => readsAsProse(note.text)) ? notes : new Map();
}

function objectsFromTabular(file, fileName, headers, rawRows, options = {}) {
  const objects = [];
  const sheet = options.sheet ?? null;
  const keyPrefix = sheet ? `${file.projectFileId}:xlsx-v2:sheet:${sheet}` : file.projectFileId;
  const labelPrefix = sheet ? `${fileName} · ${sheet}` : fileName;
  const rowOffset = options.rowOffset ?? 1;
  // A worksheet's rows leave its blank rows out, and `rowNumbers` says which
  // sheet row each one is; a delimited file keeps its blank lines as rows.
  const filled = rawRows.flatMap((row, index) => row.some((cell) => String(cell ?? '').trim())
    ? [{ row, index, number: options.rowNumbers?.[index] ?? rowOffset + index + 1 }] : []);
  // A table read from the table index arrives as its first rows (`window`),
  // with how many rows it has and its last few, where notes sit. Its notes
  // are past the rows read here, so they only change the count.
  const notes = options.window ? new Map() : trailingTableNotes(filled);
  // Only the first rows are indexed, but the row count reports the table as
  // it is: inserting "n = 1000" for a larger table would state a false fact.
  const filledRows = filled.map((entry) => entry.row);
  const data = filled.slice(0, MAX_INDEXED_TABLE_ROWS).map((entry) => entry.row);
  const bodyRows = data.filter((_, rowIndex) => !notes.has(rowIndex));
  const rowCount = options.window ? options.window.filledRows - trailingTableNotes(options.window.tail).size
    : filledRows.length - notes.size;
  // Anchors name a worksheet row by its sheet row number, and a delimited
  // file's row by its index among the file's rows, as previews look them up.
  const rowNumber = (rowIndex) => options.rowNumbers?.[filled[rowIndex].index] ?? rowOffset + filled[rowIndex].index;
  const rowLabelFor = row => options.labelColumns
    ? options.labelColumns.map(index => String(row[index] ?? '').trim()).filter(value => /[A-Za-z]/.test(value)).at(-1) ?? ''
    : String(row[0] ?? '').trim();
  objects.push(objectDescriptor({
    key: `${keyPrefix}:dataset`, type: 'DATASET', path: file.path, label: labelPrefix,
    contentHash: file.contentHash, metadata: { format: options.format, sheet },
  }));
  objects.push(objectDescriptor({
    key: `${keyPrefix}:row-count`, type: 'RESULT', path: file.path,
    anchor: { kind: 'table-summary', metric: 'row-count', sheet },
    label: `${labelPrefix} · included rows`, value: `n = ${rowCount}`,
    contentHash: file.contentHash, metadata: { dataset: fileName, sheet, metric: 'row-count', rows: rowCount,
      indexedRows: bodyRows.length },
  }));

  const dictionary = dictionaryColumns(file.path, headers);
  if (dictionary.dictionary && dictionary.variableIndex >= 0 && dictionary.descriptionIndex >= 0) {
    for (const [rowIndex, row] of data.entries()) {
      const variable = String(row[dictionary.variableIndex] ?? '').trim();
      const description = String(row[dictionary.descriptionIndex] ?? '').trim();
      if (!variable || !description || notes.has(rowIndex)) continue;
      const units = dictionary.unitIndex >= 0 ? String(row[dictionary.unitIndex] ?? '').trim() : '';
      objects.push(objectDescriptor({
        key: `${keyPrefix}:variable-definition:${normalizedVariable(variable)}`,
        type: 'VARIABLE', path: file.path,
        anchor: { kind: 'table-cell', rowIndex: rowNumber(rowIndex), rowKey: variable, columnIndex: dictionary.descriptionIndex, column: headers[dictionary.descriptionIndex], sheet },
        label: variable, value: description, contentHash: file.contentHash,
        metadata: { variable, description, units: units || null, dictionary: true, dataset: fileName, sheet },
      }));
    }
  } else if (!options.statement) {
    headers.slice(0, 80).forEach((column, columnIndex) => {
      if (!String(column ?? '').trim()) return;
      const profile = variableProfile(column, bodyRows.map((row) => row[columnIndex]));
      objects.push(objectDescriptor({
        key: `${keyPrefix}:variable:${columnIndex}:${normalizedVariable(column)}`,
        type: 'VARIABLE', path: file.path,
        anchor: { kind: 'table-column', column, columnIndex, sheet },
        label: String(column), value: profile.inferredMeaning, contentHash: file.contentHash,
        metadata: { variable: String(column), column: String(column), dictionary: false, dataset: fileName, sheet, ...profile },
      }));
    });
  }

  const shape = tableShape(headers, data, options);
  const { labelColumn, firstColumnActsAsRowLabels } = shape;
  const rowContext = { file, fileName, keyPrefix, sheet, headers, ...shape, statement: options.statement };
  let indexedCells = 0;
  let section = '';
  // Whether rows or cells were left for the table index to answer.
  let truncated = data.length < filled.length - notes.size || Boolean(options.window);
  tableRows: for (const [rowIndex, row] of data.entries()) {
    if (notes.has(rowIndex)) continue;
    const rowLabel = options.statement ? rowLabelFor(row) : String(row[labelColumn] ?? '').trim();
    if (options.statement && !rowLabel) continue;
    const sectionRow = Boolean(options.statement) && options.labelColumns.includes(row.findIndex(cell => /[A-Za-z]/.test(String(cell ?? ''))))
      && !String(row[options.labelColumns.at(-1)] ?? '').trim()
      && (row === rawRows[0] || !headers.some((header, index) => header && numericDescriptor(row[index])));
    if (sectionRow) section = rowLabel;
    const { rowObject, cells } = tableRowObjects(rowContext, { row, rowIndex, rowNumber: rowNumber(rowIndex), rowLabel, section, sectionRow });
    if (rowObject) objects.push(rowObject);
    for (const cell of cells) {
      objects.push(cell);
      indexedCells += 1;
      if (indexedCells >= MAX_TABLE_CELLS) {
        truncated = true;
        break tableRows;
      }
    }
  }
  // A note is read as a passage of text at its own cell, so it is found by its
  // words without claiming the table's headings or passing for one of its rows.
  for (const [rowIndex, note] of notes) {
    if (rowIndex >= data.length) break;
    const cellId = `${columnLetter(note.column)}${filled[rowIndex].number}`;
    // Its row index is the one its row would have, so previews find it the same way.
    const noteRow = rowNumber(rowIndex);
    objects.push(objectDescriptor({
      key: `${keyPrefix}:note:${noteRow}:${note.column}`, type: 'DOCUMENT',
      path: file.path, contentHash: file.contentHash,
      label: note.text.length > 110 ? `${note.text.slice(0, 107)}…` : note.text,
      value: note.text,
      anchor: { kind: 'sheet-note', sheet, cellId, rowIndex: noteRow, columnIndex: note.column,
        selectedText: note.text },
      metadata: { format: options.format, componentType: 'TEXT_EXCERPT', excerptType: 'note',
        rawText: note.text, textExcerpt: note.text, sheet, cell: cellId,
        parentTitle: labelPrefix, parentAuthor: null, parentYear: null },
    }));
  }
  // The table index answers for the rest of a plain table whose rows are named.
  const searchable = !options.statement && !dictionary.dictionary && firstColumnActsAsRowLabels;
  return Object.defineProperty(objects, 'deep', { value: truncated && searchable });
}

/**
 * One table row's objects: the row itself when its rows are named, and each
 * of its cells. The indexer makes them for a table's first rows; the table
 * index makes the same ones, under the same keys, for any row after those.
 */
function tableRowObjects(context, { row, rowIndex, rowNumber, rowLabel, section = '', sectionRow = false }) {
  const { file, fileName, keyPrefix, sheet, headers, labelColumn, firstColumnActsAsRowLabels, rowDescribesVariable,
    statement } = context;
  const rowKey = firstColumnActsAsRowLabels && rowLabel ? rowLabel : `row:${rowIndex + 1}`;
  const rowIdentity = `${rowNumber}:${normalizedVariable(rowKey) || 'row'}`;
  const rowObject = firstColumnActsAsRowLabels && rowLabel ? objectDescriptor({
    key: `${keyPrefix}:row:${rowIdentity}`,
    type: 'DATASET_ROW', path: file.path,
    anchor: { kind: 'table-row', rowKey, rowIndex: rowNumber, sheet },
    label: rowKey, contentHash: file.contentHash,
    metadata: {
      row: rowKey,
      rowIndex: rowNumber,
      variable: rowDescribesVariable ? rowKey : null,
      columns: headers.slice(0, 80).map((header) => String(header ?? '')).filter(Boolean),
      orientation: 'ROW', section, sectionRow,
      dataset: fileName,
      sheet,
    },
  }) : null;
  const cells = [];
  for (const [columnIndex, column] of headers.slice(0, 80).entries()) {
    if (statement && (!column || sectionRow)) continue;
    // The label names the row; as a cell it would only repeat that name.
    // Column A stays unread as before when the labels sit further right, so
    // a stray mark there does not become a value of its row.
    if (!statement && firstColumnActsAsRowLabels && (columnIndex === labelColumn || columnIndex === 0)) continue;
    const value = String(row[columnIndex] ?? '').trim();
    if (!value || value.length > 180) continue;
    const numeric = numericDescriptor(value);
    const type = numeric ? /(^|\/)results?\//i.test(file.path) ? 'RESULT' : 'DATASET_VALUE' : 'TABLE';
    cells.push(objectDescriptor({
      key: `${keyPrefix}:cell:${rowIdentity}:${column || columnIndex}`,
      type, path: file.path,
      anchor: { kind: 'table-cell', rowKey, rowIndex: rowNumber, column: column || `column:${columnIndex + 1}`, columnIndex, sheet },
      label: `${rowKey} · ${column || `column ${columnIndex + 1}`}`,
      value, contentHash: file.contentHash,
      metadata: {
        row: rowKey,
        rowIndex: rowNumber,
        variable: rowDescribesVariable ? rowKey : column || columnIndex + 1,
        column: column || columnIndex + 1,
        orientation: rowDescribesVariable ? 'ROW' : 'COLUMN', section,
        dataset: fileName,
        sheet,
      },
    }));
  }
  return { rowObject, cells };
}

// Which kinds of file each reader version reads differently from the one
// before it, so a reader upgrade re-reads only those. A version missing here
// changed more than a few kinds, and a folder it is new to is read whole.
const READER_CHANGES = new Map([[6, new Set(['table', 'spreadsheet'])], [7, new Set(['presentation', 'code', 'yaml'])]]);

function kindsChangedSince(version) {
  if (!Number.isInteger(version) || version < 1) return null;
  const kinds = new Set();
  for (let next = version + 1; next <= EXTRACTOR_VERSION; next += 1) {
    const changed = READER_CHANGES.get(next);
    if (!changed) return null;
    for (const kind of changed) kinds.add(kind);
  }
  return kinds.size ? kinds : null;
}

/**
 * Steps reading one file, reported as part of the whole read: `toStep(share)`
 * turns the share of the file read so far into the read's progress.
 */
function* withinFile(steps, toStep) {
  let next = steps.next();
  while (!next.done) {
    const step = next.value ?? {};
    const reported = toStep(step.share ?? 0);
    const reply = yield typeof step.offThread === 'function'
      ? { ...reported, offThread: (report) => step.offThread((share) => report?.(toStep(share))) }
      : reported;
    next = steps.next(reply);
  }
  return next.value;
}

/** Worksheet objects name their rows by sheet row number. */
function worksheetCoordinates(object) {
  object.metadata.spreadsheetExtractionVersion = 2;
  if (object.anchor && Number.isInteger(object.anchor.rowIndex)) object.anchor.rowCoordinate = 'worksheet';
  return object;
}

function isDictionaryVariable(descriptor) {
  return descriptor.type === 'VARIABLE' && Boolean(descriptor.metadata.dictionary);
}

/**
 * Whether an index row needs no upgrade pass. Version two adds page-anchored
 * PDF sentences and paragraphs to existing imports without changing any
 * previously linked object or version. Version three adds the same passages
 * for Markdown and plain-text files. Version four adds STEP CAD models.
 * Spreadsheet version two records worksheet row coordinates under new keys.
 */
function indexIsCurrent(indexed) {
  return Boolean(indexed?.indexed && indexed.drawing_index_version >= INDEX_VERSION && indexed.spreadsheet_index_version >= 2);
}

/** What a later index needs to carry these files' objects forward. */
function indexSummary(counts, problems, definitions, truncated) {
  const problemsByPath = new Map();
  for (const problem of problems) problemsByPath.set(problem.path, [...(problemsByPath.get(problem.path) ?? []), problem]);
  return {
    truncated, counts, definitions, problems: problemsByPath,
    dictionaryPaths: new Set(definitions.map((definition) => definition.path)),
  };
}

/** `sources` are the dictionary variables in index order, from every indexed file. */
function applyVariableDefinitions(descriptors, sources = descriptors) {
  const definitions = new Map();
  for (const descriptor of sources) {
    if (!isDictionaryVariable(descriptor)) continue;
    const key = normalizedVariable(descriptor.metadata.variable);
    if (key && !definitions.has(key)) definitions.set(key, descriptor);
  }
  for (const descriptor of descriptors) {
    if (descriptor.metadata.dictionary) continue;
    const key = normalizedVariable(descriptor.metadata.variable ?? descriptor.metadata.column);
    const definition = definitions.get(key);
    if (!definition) continue;
    descriptor.metadata = {
      ...descriptor.metadata,
      definition: definition.metadata.description,
      units: definition.metadata.units ?? descriptor.metadata.units ?? null,
      dictionaryPath: definition.path,
    };
    descriptor.searchText += ` ${definition.label} ${definition.value ?? ''} ${definition.metadata.units ?? ''}`.toLowerCase();
  }
}

// "Figure 2", "Table S1", "Fig. 3b", "Table A" and "Figure IV" name document
// components. Ordinary prose such as "a figure found only there" does not.
export function isComponentIdentifier(value) {
  const identifier = String(value ?? '');
  return /\d/.test(identifier) || /^[A-Z]$/.test(identifier) || /^[IVXL]{1,6}$/.test(identifier);
}

function documentComponentDescriptors(file, sourceText, parentMetadata, base) {
  const text = String(sourceText ?? '').replace(/\r\n/g, '\n');
  const descriptors = [];
  const seen = new Set();
  for (const match of text.matchAll(/\b(Table|Figure|Fig\.?)\s+([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)/gi)) {
    const type = /^table$/i.test(match[1]) ? 'TABLE' : 'FIGURE';
    const identifier = match[2];
    if (!isComponentIdentifier(identifier)) continue;
    const componentLabel = `${type === 'TABLE' ? 'Table' : 'Figure'} ${identifier}`;
    const key = `${type}:${identifier.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lineEnd = text.indexOf('\n', match.index);
    const afterLabel = match.index + match[0].length;
    const captionSeparator = text.slice(afterLabel).match(/^\s*[.:—-]\s*/)?.[0].length ?? 0;
    const sentenceStart = afterLabel + captionSeparator;
    const sentenceOffset = text.slice(sentenceStart, sentenceStart + 520).search(/[.!?](?:\s|$)/);
    const sentenceEnd = sentenceOffset >= 0 ? sentenceStart + sentenceOffset + 1 : -1;
    const endCandidates = [lineEnd, sentenceEnd]
      .filter((value) => value > match.index);
    const end = Math.min(...(endCandidates.length ? endCandidates : [Math.min(text.length, match.index + 320)]));
    const context = text.slice(match.index, Math.min(end, match.index + 420)).replace(/\s+/g, ' ').trim();
    descriptors.push(objectDescriptor({
      key: `${base}:component:${type.toLowerCase()}:${normalizedVariable(identifier)}`,
      type,
      path: file.path,
      anchor: {
        kind: type === 'TABLE' ? 'document-table' : 'document-figure',
        identifier,
        start: match.index,
        end,
      },
      label: componentLabel,
      value: context || componentLabel,
      contentHash: file.contentHash,
      metadata: {
        componentType: type,
        componentLabel,
        identifier,
        parentTitle: parentMetadata.title ?? parentMetadata.heading ?? null,
        parentAuthor: parentMetadata.author ?? null,
        parentYear: parentMetadata.year ?? null,
        textExcerpt: context || null,
      },
    }));
  }
  return descriptors;
}

function pdfPassageDescriptors(file, buffer, parentMetadata) {
  const repeats = new Map();
  return extractPdfPassages(buffer).map(passage => {
    const fingerprint = sha(`${passage.excerptType}|${passage.selectedText.toLowerCase()}`).slice(0, 24);
    const occurrence = repeats.get(fingerprint) ?? 0;
    repeats.set(fingerprint, occurrence + 1);
    return objectDescriptor({
      key: `${file.projectFileId}:pdf-excerpt:${fingerprint}:${occurrence}`, type: 'DOCUMENT',
      path: file.path, contentHash: file.contentHash,
      label: passage.selectedText.length > 110 ? `${passage.selectedText.slice(0, 107)}…` : passage.selectedText,
      value: passage.selectedText,
      anchor: { kind: 'pdf-excerpt', pageNumber: passage.pageNumber, selectedText: passage.selectedText,
        start: passage.start, end: passage.end, bbox: passage.bbox },
      metadata: { format: 'PDF', componentType: 'PDF_EXCERPT', excerptType: passage.excerptType,
        rawText: passage.selectedText, textExcerpt: passage.selectedText, pageNumber: passage.pageNumber,
        parentTitle: parentMetadata.title ?? null, parentAuthor: parentMetadata.author ?? null,
        parentYear: parentMetadata.year ?? null },
    });
  });
}

/**
 * `outline` is a deck's slide outline, when `text` is one: each passage then
 * also names the slide it is on.
 */
function textPassageDescriptors(file, text, parentMetadata, outline = null) {
  const markdown = file.fileType === 'markdown' || Boolean(outline);
  const repeats = new Map();
  return markdownPassages(text, { plain: !markdown }).map(passage => {
    const slide = outline ? slideAtLine(outline, passage.lineStart) : null;
    const fingerprint = sha(`${passage.excerptType}|${passage.selectedText.toLowerCase()}`).slice(0, 24);
    const occurrence = repeats.get(fingerprint) ?? 0;
    repeats.set(fingerprint, occurrence + 1);
    return objectDescriptor({
      key: `${file.projectFileId}:text-excerpt:${fingerprint}:${occurrence}`, type: 'DOCUMENT',
      path: file.path, contentHash: file.contentHash,
      label: passage.selectedText.length > 110 ? `${passage.selectedText.slice(0, 107)}…` : passage.selectedText,
      value: passage.selectedText,
      anchor: { kind: 'text-excerpt', selectedText: passage.selectedText, start: passage.start, end: passage.end,
        lineStart: passage.lineStart, lineEnd: passage.lineEnd, ...(slide ? { slideNumber: slide.number } : {}) },
      metadata: { format: parentMetadata.format, componentType: 'TEXT_EXCERPT', excerptType: passage.excerptType,
        rawText: passage.selectedText, textExcerpt: passage.selectedText,
        lineStart: passage.lineStart, lineEnd: passage.lineEnd, section: passage.section ?? null,
        ...(slide ? { slideNumber: slide.number, slideTitle: slide.title } : {}),
        parentTitle: parentMetadata.title ?? null, parentAuthor: null, parentYear: null },
    });
  });
}

/**
 * @param {(code: string, reason: string) => void} report receives a problem
 *   that keeps some or all of the file out of suggestions, so it can be shown
 *   in the indexing issues instead of disappearing silently
 */
function objectsFromFile(file, buffer, report = () => {}) {
  const objects = [];
  const base = file.projectFileId;
  const fileName = path.posix.basename(file.path, path.posix.extname(file.path));
  const text = buffer.subarray(0, 5_000_000).toString('utf8').replace(/\r\n/g, '\n');

  if (file.fileType === 'pdf' || isDesignFile(file)) {
    const { drawing, descriptors } = drawingDescriptors(file, buffer);
    if (drawing.isDrawing) return [
      ...descriptors.map(objectDescriptor),
      ...(file.fileType === 'pdf' ? pdfPassageDescriptors(file, buffer, { title: drawing.pages[0]?.title ?? fileName }) : []),
    ];
  }

  // Tables and workbooks are read by tableObjectSteps, which can index them whole.
  if (isCodeType(file.fileType)) {
    objects.push(objectDescriptor({
      key: `${base}:code`, type: /model|analysis/i.test(fileName) ? 'MODEL' : 'CODE_BLOCK', path: file.path,
      label: fileName, contentHash: file.contentHash,
      // The whole file, nameable while writing; its lines follow it.
      metadata: { file: file.path, codeFile: true, lineCount: fileLines(text).length },
    }));
    text.split('\n').slice(0, 4000).forEach((line, index) => {
      const symbol = line.match(/^\s*(?:def|function|class)\s+([A-Za-z_][\w]*)|^\s*([A-Za-z_][\w.]*)\s*(?:=|<-)/);
      const method = line.match(/mixed[- ]effects?|random intercept|sctransform|normaliz(?:e|ed|ation)|regression|cox model/i);
      if (!symbol && !method) return;
      const label = symbol?.[1] ?? symbol?.[2] ?? method[0];
      objects.push(objectDescriptor({
        key: `${base}:line:${index + 1}`,
        type: method ? 'METHOD' : /model|formula/i.test(label) ? 'MODEL' : 'CODE_LINE',
        path: file.path,
        anchor: { kind: 'line', line: index + 1 },
        label,
        value: line.trim(),
        contentHash: file.contentHash,
        metadata: { line: index + 1, symbol: label },
      }));
    });
  } else if (file.fileType === 'notebook') {
    try {
      for (const [index, cell] of diffInternals.notebookCells(text).entries()) {
        objects.push(objectDescriptor({
          key: `${base}:cell:${cell.id}`, type: 'NOTEBOOK_CELL', path: file.path,
          anchor: { kind: 'notebook-cell', cellId: cell.id, cellIndex: index },
          label: `${fileName} · cell ${index + 1}`, value: cell.source.slice(0, 400),
          contentHash: file.contentHash, metadata: { cellId: cell.id, cellType: cell.type },
        }));
      }
    } catch {
      // Malformed notebooks are preserved in history but not indexed.
      report('UNREADABLE_CONTENT', 'This notebook could not be parsed, so its cells are not suggested.');
    }
  } else if (file.fileType === 'image') {
    objects.push(objectDescriptor({
      key: `${base}:figure`, type: 'FIGURE', path: file.path, label: fileName,
      contentHash: file.contentHash, metadata: file.metadata,
    }));
  } else if (file.fileType === 'json') {
    try {
      const dictionaryLike = /(?:data[_ -]?(?:dictionary|dict)|codebook|variable[_ -]?(?:definitions?|labels?)|metadata|schema)/i.test(file.path);
      for (const leaf of flattenJson(JSON.parse(text)).slice(0, 3000)) {
        const variable = leaf.path.split('.').at(-1);
        objects.push(objectDescriptor({
          key: `${base}:json:${leaf.path}`,
          type: dictionaryLike ? 'VARIABLE'
            : numericDescriptor(leaf.value) ? /(^|\/)results?\//i.test(file.path) ? 'RESULT' : 'VALUE' : 'PARAMETER',
          path: file.path, anchor: { kind: 'json-path', path: leaf.path }, label: leaf.path,
          value: leaf.value, contentHash: file.contentHash,
          metadata: {
            jsonPath: leaf.path,
            ...(dictionaryLike ? { variable, description: leaf.value, dictionary: true } : {}),
          },
        }));
      }
    } catch {
      // The line diff remains available in history.
      report('UNREADABLE_CONTENT', 'This JSON file could not be parsed, so its values are not suggested.');
    }
  } else if (file.fileType === 'pdf' || file.fileType === 'document') {
    const fallback = paperMetadata(fileName);
    const extracted = file.fileType === 'pdf' ? extractPdfDocument(buffer) : extractDocxDocument(buffer);
    if (extracted.extraction === 'DOCX_UNREADABLE') {
      report('UNREADABLE_CONTENT', 'This document could not be opened. It may be password-protected or damaged.');
    } else if (extracted.extraction === 'PDF_METADATA') {
      report('UNREADABLE_CONTENT', 'No text could be read from this PDF. It may be a scan without a text layer, password-protected or damaged.');
    }
    const author = extracted.author || fallback.author;
    const family = firstAuthorFamily(author);
    const year = extracted.year || fallback.year;
    const title = extracted.title || fallback.title;
    const referenceLike = file.fileType === 'pdf' || referenceLikePath(file.path) || Boolean(extracted.doi);
    const multipleAuthors = (extracted.authors?.length ?? 0) > 1 || /\s+(?:and|&)\s+|;/.test(author ?? '');
    const label = family ? `${family}${multipleAuthors ? ' et al.' : ''}${year ? `, ${year}` : ''}` : title;
    const parentMetadata = {
      ...extracted, author: author || null, year: year || null, title,
      format: file.fileType.toUpperCase(), fileName: path.posix.basename(file.path),
    };
    objects.push(objectDescriptor({
      key: `${base}:${referenceLike ? 'paper' : 'document'}`,
      type: referenceLike ? 'PAPER' : 'DOCUMENT', path: file.path,
      label, value: title, contentHash: file.contentHash,
      metadata: parentMetadata,
    }));
    objects.push(...documentComponentDescriptors(file, extracted.textExcerpt, parentMetadata, base));
    if (file.fileType === 'pdf') objects.push(...pdfPassageDescriptors(file, buffer, parentMetadata));
  } else if (file.fileType === 'presentation') {
    objects.push(...presentationDescriptors(file, buffer, fileName, report));
  } else if (file.fileType === 'markdown' || (file.fileType === 'text' && path.extname(file.path).toLowerCase() === '.txt')) {
    const referenceLike = referenceLikePath(file.path);
    const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
    // A note written as a record (a title, then labelled fields, as connected
    // apps write mail, events and pages) offers its fields after its title.
    const record = file.fileType === 'markdown' && !referenceLike ? recordFields(text) : null;
    const parentMetadata = { format: file.fileType === 'markdown' ? 'MARKDOWN' : 'TXT',
      heading: heading ?? null, title: heading ?? fileName,
      ...(file.fileType === 'text' ? { textExcerpt: text.slice(0, 20_000) } : {}),
      ...(record ? { recordFields: record.fields.map((field) => field.label) } : {}) };
    objects.push(objectDescriptor({
      key: `${base}:document`, type: referenceLike ? 'PAPER' : 'DOCUMENT', path: file.path,
      label: heading || fileName, value: heading || text.slice(0, 240), contentHash: file.contentHash,
      metadata: parentMetadata,
    }));
    objects.push(...documentComponentDescriptors(file, text, parentMetadata, base));
    // A field's line is that field, not a passage of prose.
    const fieldLines = new Set(record?.fields.map((field) => field.line));
    objects.push(...textPassageDescriptors(file, text, parentMetadata)
      .filter((passage) => !fieldLines.has(passage.anchor.lineStart)));
    const labels = new Map();
    for (const field of record?.fields ?? []) {
      const key = normalizedVariable(field.label);
      const occurrence = labels.get(key) ?? 0;
      labels.set(key, occurrence + 1);
      objects.push(objectDescriptor({
        key: `${base}:record-field:${key}${occurrence ? `:${occurrence}` : ''}`, type: 'VALUE', path: file.path,
        label: `${record.title} · ${field.label}`, value: field.text, contentHash: file.contentHash,
        anchor: { kind: 'text-excerpt', selectedText: field.value, start: field.start, end: field.end,
          lineStart: field.line, lineEnd: field.line },
        metadata: { format: 'MARKDOWN', componentType: 'RECORD_FIELD', field: field.label, role: field.role,
          record: record.title, rawText: field.value, lineStart: field.line, lineEnd: field.line,
          parentTitle: record.title },
      }));
    }
  }

  if (path.extname(file.path).toLowerCase() === '.bib') {
    for (const reference of parseBibtex(text)) {
      const author = firstAuthorFamily(reference.author) || reference.key;
      const label = `${author}${reference.author?.match(/\s+and\s+/i) ? ' et al.' : ''}${reference.year ? `, ${reference.year}` : ''}`;
      objects.push(objectDescriptor({
        key: `${base}:reference:${reference.key}`, type: 'REFERENCE', path: file.path,
        anchor: { kind: 'reference-entry', key: reference.key }, label,
        value: reference.title ?? label, contentHash: file.contentHash,
        metadata: { citationKey: reference.key, ...reference },
      }));
    }
  }

  if (['.ris', '.enw', '.nbib'].includes(path.extname(file.path).toLowerCase())) {
    for (const reference of extractTaggedReferences(text)) {
      const author = firstAuthorFamily(reference.author) || reference.key;
      const label = `${author}${reference.authors?.length > 1 ? ' et al.' : ''}${reference.year ? `, ${reference.year}` : ''}`;
      objects.push(objectDescriptor({
        key: `${base}:reference:${reference.key}`, type: 'REFERENCE', path: file.path,
        anchor: { kind: 'reference-entry', key: reference.key }, label,
        value: reference.title ?? label, contentHash: file.contentHash,
        metadata: { ...reference },
      }));
    }
  }

  if (/run[_-]?\d|analysis[_-]?run/i.test(fileName)) {
    objects.push(objectDescriptor({
      key: `${base}:run`, type: 'ANALYSIS_RUN', path: file.path, label: fileName,
      contentHash: file.contentHash, metadata: { file: file.path },
    }));
  }
  return objects;
}

/**
 * A deck: the whole deck, nameable by its title or file name, and the
 * sentences and paragraphs of its slides, each knowing its slide. They cite
 * lines of the deck's slide outline, which previews and shares read the same way.
 */
function presentationDescriptors(file, buffer, fileName, report) {
  const deck = readPresentation(buffer);
  if (deck.extraction === 'PPTX_UNREADABLE') {
    report('UNREADABLE_CONTENT', 'This presentation could not be opened. It may be password-protected or damaged.');
  }
  const outline = presentationOutline(deck);
  const title = deck.title || deck.slides.find((slide) => slide.title)?.title || titleFromFileName(fileName);
  const parentMetadata = {
    format: 'PPTX', title, author: deck.author, subject: deck.subject, keywords: deck.keywords,
    slideCount: deck.slideCount, fileName: path.posix.basename(file.path), textExcerpt: presentationPlainText(deck),
  };
  const withSlide = (descriptor) => {
    const line = descriptor.anchor?.lineStart ?? (Number.isInteger(descriptor.anchor?.start)
      ? outline.text.slice(0, descriptor.anchor.start).split('\n').length : null);
    const slide = line ? slideAtLine(outline, line) : null;
    return slide ? { ...descriptor, anchor: { ...descriptor.anchor, slideNumber: slide.number },
      metadata: { ...descriptor.metadata, slideNumber: slide.number, slideTitle: slide.title } } : descriptor;
  };
  return [
    objectDescriptor({
      key: `${file.projectFileId}:document`, type: 'DOCUMENT', path: file.path,
      label: title, value: title, contentHash: file.contentHash, metadata: parentMetadata,
    }),
    ...documentComponentDescriptors(file, outline.text, parentMetadata, file.projectFileId).map(withSlide),
    ...textPassageDescriptors(file, outline.text, parentMetadata, outline),
  ];
}

/** Lines `first` through `last` of a code file as an object, or null when the file has no such lines. */
function codeLinesDescriptor(file, lines, first, last) {
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > lines.length) return null;
  const code = codeOfLines(lines, first, last);
  if (!code.trim()) return null;
  return objectDescriptor({
    key: `${file.projectFileId}:${CODE_LINES_KEY}:${first}-${last}`, type: 'CODE_LINE', path: file.path,
    anchor: { kind: 'line-range', lineStart: first, lineEnd: last },
    label: linesLabel(first, last), value: code, contentHash: file.contentHash,
    metadata: { lineStart: first, lineEnd: last, lineReference: true },
  });
}

const isCodeLineReference = (object) => object?.anchor?.kind === 'line-range' && object.metadata?.lineReference === true;

function partialReferenceIntent(source) {
  const nouns = '(paper|study|article|publication|reference|document|report|file|note|memo|proposal|manuscript|protocol|spreadsheet|workbook|presentation|slides?)';
  const query = "([A-Za-z0-9][A-Za-z0-9'’_.()+&/-]*(?:\\s+[A-Za-z0-9][A-Za-z0-9'’_.()+&/-]*){0,11}?)";
  const suffix = '(?:\\s+e(?:t(?:\\s+a(?:l\\.?)?)?)?)?[,]?\\s*$';
  const patterns = [
    { mode: 'title', pattern: new RegExp(`\\b(?:the\\s+)?${nouns}(?:['’]s\\s+|\\s+)title\\s*(?:is|was|:|—|-)\\s*${query}${suffix}`, 'i') },
    { mode: 'title', pattern: new RegExp(`\\btitle\\s+of\\s+(?:the\\s+)?${nouns}\\s*(?:is|was|:|—|-)\\s*${query}${suffix}`, 'i') },
    { mode: 'title', pattern: new RegExp(`\\b(?:the\\s+)?${nouns}\\s+(?:called|titled|named|entitled)\\s+${query}${suffix}`, 'i') },
    { mode: 'author', pattern: new RegExp(`\\b(?:the\\s+)?${nouns}\\s+(?:written\\s+by|authored\\s+by|by)\\s+${query}${suffix}`, 'i') },
    { mode: 'author', pattern: new RegExp(`\\b(?:the\\s+)?(paper|study|article|publication|reference)\\s+from\\s+${query}${suffix}`, 'i') },
    { mode: 'author', pattern: new RegExp(`\\b(according\\s+to)\\s+${query}${suffix}`, 'i'), kind: 'according to' },
    { mode: 'any', pattern: new RegExp(`\\b(?:(?:from|in|within|using|citing|referencing|based\\s+on)\\s+)?(?:the\\s+)?${nouns}\\s+${query}${suffix}`, 'i') },
  ];
  for (const definition of patterns) {
    const match = source.match(definition.pattern);
    if (!match) continue;
    const captured = match.slice(1).filter((value) => value != null);
    const rawQuery = captured.at(-1);
    if (!rawQuery || normalizedVariable(rawQuery).length < 2) continue;
    if (definition.mode === 'any' && /^(?:finds?|found|shows?|showed|observes?|observed|reports?|reported|reveals?|revealed|indicates?|indicated|includes?|included|demonstrates?|demonstrated|suggests?|suggested|contains?|contained)\b/i.test(rawQuery)) continue;
    const referenceKind = definition.kind ?? captured[0].toLowerCase();
    const start = match.index + match[0].lastIndexOf(rawQuery);
    return { query: rawQuery, start, referenceKind, referenceMode: definition.mode };
  }
  return null;
}

export function detectClaimSpans(text) {
  const source = String(text ?? '');
  const claims = [];
  const add = (start, end, type, value = null, details = {}) => {
    if (start < 0 || end <= start) return;
    const claim = { start, end, type, value, text: source.slice(start, end), ...details };
    if (!claims.some((item) => item.start === start && item.end === end && item.type === type)) claims.push(claim);
  };

  const quantity = /(?:\bp(?:-?value)?\s*[<=>]\s*0?\.\d+|\b(?:n\s*=\s*)?\d+(?:\.\d+)?\s*%\s*(?:CI)?|\bn\s*=\s*\d+|\b\d+\s+(?:patients?|samples?|participants?|subjects?)|\b\d+(?:\.\d+)?[- ]?fold(?:\s+change)?)/gi;
  for (const match of source.matchAll(quantity)) {
    let start = match.index;
    const prefix = source.slice(Math.max(0, start - 55), start);
    const phrase = prefix.match(/(?:decreased|reduced|increased|changed|lower|higher|included|excluded|p\s*(?:value)?)[^.!?;]{0,45}$/i);
    if (phrase) start -= phrase[0].length;
    add(start, match.index + match[0].length, /\bpatients?|samples?|participants?|subjects?|n\s*=/i.test(match[0]) ? 'SAMPLE_SIZE' : 'QUANTITATIVE', match[0]);
  }
  for (const match of source.matchAll(/\b(?:Figure|Fig\.?|Table)\s+[A-Za-z0-9.-]+/gi)) {
    add(match.index, match.index + match[0].length, /^Table/i.test(match[0]) ? 'TABLE_REFERENCE' : 'FIGURE', match[0]);
  }
  const partialComponent = source.match(/\b(Tab(?:l(?:e)?)?|Fig(?:u(?:r(?:e)?)?)?)(?:\s+([A-Za-z0-9.-]*))?\s*$/i);
  if (partialComponent && !claims.some((claim) => claim.start <= partialComponent.index && claim.end >= source.trimEnd().length)) {
    const table = /^tab/i.test(partialComponent[1]);
    add(partialComponent.index, source.trimEnd().length, table ? 'TABLE_REFERENCE' : 'FIGURE', partialComponent[0].trim(), {
      partial: true,
    });
  }
  for (const match of source.matchAll(/\b(?:mixed[- ]effects? model|random intercept|SCTransform|Cox model|linear regression|normalized? using [A-Za-z0-9_-]+)/gi)) add(match.index, match.index + match[0].length, 'METHOD', match[0]);
  let explicitReference = false;
  for (const match of source.matchAll(/\b[A-Z][A-Za-z'’-]+(?:\s+(?:and|&)\s+[A-Z][A-Za-z'’-]+)?\s+et al\.(?:,?\s*\(?(?:19|20)\d{2}[a-z]?\)?)?/g)) {
    explicitReference = true;
    add(match.index, match.index + match[0].length, 'LITERATURE', match[0]);
  }
  if (!explicitReference) {
    const partialCitation = partialReferenceIntent(source);
    if (partialCitation) {
      explicitReference = true;
      const trailingComma = source.trimEnd().endsWith(',') ? 1 : 0;
      add(partialCitation.start, source.length - trailingComma, 'LITERATURE', partialCitation.query, {
        partial: true,
        referenceKind: partialCitation.referenceKind,
        referenceMode: partialCitation.referenceMode,
      });
    }
  }
  if (!explicitReference && /\b(?:prior (?:work|studies)|studies have|reported|associated with)\b/i.test(source)) {
    add(0, source.length, 'LITERATURE', null);
  }
  const partialPercent = source.match(/\b(?:increased?|decreased?|reduced?|changed?|higher|lower)\s+(?:by\s+)?([+-]?\d+(?:\.\d*)?)\s*$/i);
  if (partialPercent) {
    add(partialPercent.index, source.length, 'QUANTITATIVE', `${partialPercent[1]}%`, { partial: true, unitHint: 'percent' });
  }
  const partialPValue = source.match(/\bp(?:-?value)?\s*[<=>]\s*(0?\.\d*)\s*$/i);
  if (partialPValue?.[1]) add(partialPValue.index, source.length, 'QUANTITATIVE', partialPValue[1], { partial: true, unitHint: 'p-value' });
  const studyNumber = /[+-]?\d[\d,]*(?:\.\d+)?(?:\s*(?:µ?g|mg|kg|ng|pg|mm|cm|mL|dL|L|mmol\/L|µmol\/L|ng\/mL|years?|months?|days?|hours?))?/gi;
  for (const match of source.matchAll(studyNumber)) {
    const end = match.index + match[0].length;
    if (claims.some((claim) => claim.start < end && claim.end > match.index)) continue;
    const numericText = match[0].match(/[+-]?\d[\d,]*(?:\.\d+)?/)?.[0] ?? '';
    const numericValue = Number(numericText.replaceAll(',', ''));
    if (!Number.isFinite(numericValue) || (numericValue >= 1900 && numericValue <= 2099 && !match[0].includes('.'))) continue;
    const boundary = Math.max(source.lastIndexOf('.', match.index - 1), source.lastIndexOf('!', match.index - 1),
      source.lastIndexOf('?', match.index - 1), source.lastIndexOf(';', match.index - 1), source.lastIndexOf('\n', match.index - 1));
    const prefix = source.slice(boundary + 1, match.index);
    const relation = prefix.match(/([A-Za-z][A-Za-z0-9_()/ -]{1,80}?)\s+(?:was|were|is|are|averaged|measured|reached|equalled?|=)\s*$/i);
    if (!relation) continue;
    let variable = relation[1].trim()
      .replace(/^(?:in\s+(?:our|this)\s+study,?\s*)/i, '')
      .replace(/^(?:we\s+(?:found|observed|showed|identified|measured|detected|recorded|reported|estimated)(?:\s+that)?\s+)/i, '')
      .replace(/^(?:the|our)\s+/i, '')
      .replace(/^(?:adjusted\s+)?(?:mean|median|average)\s+(?:of\s+)?/i, '')
      .replace(/^(?:(?:odds|hazard)\s+ratio|coefficient|estimate|value)\s+(?:of|for)\s+/i, '');
    if (!variable || wordTokens(variable).length > 8) continue;
    const unit = match[0].slice(numericText.length).trim() || null;
    const start = boundary + 1 + relation.index;
    add(start, end, 'QUANTITATIVE', numericText, { variable, unit, studyResult: true });
  }
  for (const match of source.matchAll(/\b(?:[A-Z]{2,}\d*(?:-\d+)+|[A-Z]{2,}\d{1,3})\b/g)) {
    const sentenceStart = Math.max(source.lastIndexOf('.', match.index - 1), source.lastIndexOf('\n', match.index - 1)) + 1;
    const nextPeriod = source.indexOf('.', match.index);
    const nextLine = source.indexOf('\n', match.index);
    const sentenceEnd = Math.min(...[nextPeriod, nextLine, source.length].filter((index) => index >= 0));
    const alreadyRepresented = claims.some((claim) => claim.start < sentenceEnd && claim.end > sentenceStart
      && ['QUANTITATIVE', 'SAMPLE_SIZE', 'METHOD'].includes(claim.type));
    if (!alreadyRepresented && !claims.some((claim) => claim.start <= match.index && claim.end >= match.index + match[0].length)) {
      add(match.index, match.index + match[0].length, 'ENTITY', match[0]);
    }
  }
  for (const match of source.matchAll(/\b[A-Za-z][A-Za-z0-9_-]*(?:dataset|cohort)[A-Za-z0-9_-]*\b/gi)) {
    add(match.index, match.index + match[0].length, 'DATASET_REFERENCE', match[0]);
  }
  const partialEntity = source.match(/\b([A-Z]{2,}[A-Z0-9]*(?:-[A-Z0-9]*)?)$/);
  if (partialEntity && !claims.some((claim) => claim.start <= partialEntity.index && claim.end >= source.length)) {
    add(partialEntity.index, source.length, 'ENTITY', partialEntity[1], { partial: true });
  }
  return claims.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function studyVariableFragment(text, cursor = String(text ?? '').length) {
  return progressiveVariableFragments(text, cursor).at(-1) ?? null;
}

/** `at` is the snapshot the row was read at, when the row does not carry it. */
function mapObjectRow(row, at = { snapshotId: row.snapshot_id, version: row.snapshot_version }) {
  const metadata = json(row.metadata_json, {});
  return {
    id: row.object_id,
    projectId: row.project_id,
    versionId: row.version_id,
    objectKey: row.object_key,
    objectType: row.object_type,
    snapshotId: at.snapshotId,
    snapshotVersion: at.version,
    path: row.path,
    anchor: json(row.anchor_json, null),
    label: correctedDocumentLabel(row.object_type, row.label, metadata),
    valueText: row.value_text,
    contentHash: row.content_hash,
    metadata,
    searchText: row.search_text,
  };
}

/** A row of a large table not yet recorded as an object, shaped as one for scoring. */
function pendingObject(projectId, snapshotId, descriptor) {
  return { id: `indexed:${descriptor.key}`, projectId, versionId: null, objectKey: descriptor.key, objectType: descriptor.type,
    snapshotId, snapshotVersion: null, path: descriptor.path, anchor: descriptor.anchor,
    label: correctedDocumentLabel(descriptor.type, descriptor.label, descriptor.metadata), valueText: descriptor.value,
    contentHash: descriptor.contentHash, metadata: descriptor.metadata, searchText: descriptor.searchText };
}

/** An object with the variable a writer names it by, as study-variable suggestions read it. */
function studyVariable(object) {
  // A row named in a Department or Supplier column ("Facilities") is not
  // a variable, but it is still a name the writer types.
  const namedRow = object.objectType === 'DATASET_ROW' && !object.metadata.variable
    && !isIdentifierRow(object);
  const variable = String(object.metadata.variable ?? object.metadata.column
    ?? (object.objectType === 'VARIABLE' ? object.label : namedRow ? object.metadata.row ?? object.label : '')).trim();
  return {
    ...object,
    namedRow,
    variable,
    normalizedVariable: normalizedVariable(variable),
    variableWords: variableTokens(humanVariable(variable)),
  };
}

function freezeIndexedValue(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeIndexedValue(child);
  return Object.freeze(value);
}

export class PredictiveProvenanceService {
  constructor(timeline, rfi = null) {
    this.timeline = timeline;
    this.db = timeline.db;
    this.rfi = rfi;
    this.ranking = new RecommendationRanking(timeline);
    this.completionCorpusCache = new BoundedCache({ maxEntries: 16, maxWeight: 16 * 1024 * 1024,
      weight: (corpus) => corpus.reduce((bytes, item) => bytes + item.sentence.length * 2 + item.tokens.length * 64, 0) });
    this.studyVariableCache = new BoundedCache({ maxEntries: 16, maxWeight: 100_000, weight: (objects) => objects.length });
    this.workspaceRetrievalCache = new BoundedCache({ maxEntries: 16, maxWeight: 100_000, weight: (objects) => objects.length });
    this.objectCache = new BoundedCache({ maxEntries: 16, maxWeight: 120_000, weight: (objects) => objects.length });
    this.typedObjectCache = new BoundedCache({ maxEntries: 96, maxWeight: 120_000, weight: (objects) => objects.length });
    // Whether an object has values below it, kept with the retrieval objects
    // it was worked out from, so it goes when they are read again.
    this.narrowingCache = new WeakMap();
    // Raw descriptors are cached before dictionary enrichment. Changing a
    // dictionary must still update unchanged source files in the next snapshot.
    this.extractionCache = new BoundedCache({ maxEntries: 256, maxWeight: 24 * 1024 * 1024,
      weight: (entry) => entry.bytes });
    // Extracted file text depends only on the file's bytes, so an unchanged
    // PDF is not parsed again after every capture of its folder.
    // Large tables, whole, by file content (see table-index.js).
    this.tables = new TableIndex(path.join(timeline.config.dataDir, 'derived'));
    this.tableBuilds = new Map();
    this.tableReadings = new BoundedCache({ maxEntries: 256 });
    this.snapshotTableCache = new BoundedCache({ maxEntries: 32 });
    // Rows of large tables already offered at a snapshot, by snapshot and key.
    this.deepObjects = new BoundedCache({ maxEntries: 4_096 });
    this.objectKeySets = new WeakMap();
    this.variableIndexes = new WeakMap();
    this.retrievalIndexes = new WeakMap();
    // PDFs' text outlives the process, so a restart does not read every PDF again.
    this.textStore = new TextStore(path.join(timeline.config.dataDir, 'derived', 'text'), EXTRACTOR_VERSION);
    // So are IFC plans, which can take the geometry engine several seconds each.
    keepIfcModelsIn(new TextStore(path.join(timeline.config.dataDir, 'derived', 'ifc-models'), IFC_MODEL_VERSION));
    // A drawing PDF keeps one entry per page, so the bound is on bytes.
    this.extractedTextCache = new BoundedCache({ maxEntries: 1024, maxWeight: 32 * 1024 * 1024,
      weight: (text) => text.length * 2 });
    this.sourceTextCache = new BoundedCache({ maxEntries: 64, maxWeight: 8 * 1024 * 1024,
      weight: (text) => text.length * 2 });
    this.figurePreviewCache = new BoundedCache({ maxEntries: 12, maxWeight: 24 * 1024 * 1024,
      weight: (preview) => preview.image.length });
    this.reconcilingProjects = new Set();
    // Full indexes built by this process, which later indexes may carry forward from.
    this.indexedHere = new BoundedCache({ maxEntries: 64 });
    this.unsubscribe = timeline.onCapture((capture) => {
      // Snapshot keys are immutable. A change in one directory must leave the
      // other enabled directories warm while releasing the superseded head.
      const previous = capture?.event?.previousSnapshotId;
      if (previous) {
        for (const cache of [this.completionCorpusCache, this.studyVariableCache, this.workspaceRetrievalCache]) {
          cache.delete(previous);
        }
      }
      this.reconcileAfterCapture(capture);
    });
  }

  close() {
    this.unsubscribe?.();
    this.ranking.close();
    for (const cache of [this.completionCorpusCache, this.studyVariableCache, this.workspaceRetrievalCache,
      this.objectCache, this.typedObjectCache, this.extractionCache, this.sourceTextCache, this.figurePreviewCache,
      this.indexedHere, this.tableReadings, this.snapshotTableCache, this.deepObjects]) cache.clear();
    this.tables.close();
  }

  sourceText(source) {
    if (isPassageExcerpt(source)) return source.metadata.rawText ?? source.valueText ?? '';
    const key = `${source.snapshotId}|${source.id}|${source.contentHash}`;
    if (this.sourceTextCache.has(key)) return this.sourceTextCache.get(key);
    const file = this.timeline.snapshotFile(source.snapshotId, source.path);
    const extractedText = file ? this.fileText(file, source.objectType, source.anchor?.pageNumber) : '';
    const text = [extractedText, source.metadata.textExcerpt, source.metadata.subject,
      source.metadata.title, source.valueText].filter(Boolean).join('\n');
    this.sourceTextCache.set(key, text);
    return text;
  }

  /** A file's text: a whole PDF, one page of a PDF drawing, or a document's. */
  fileText(file, objectType, pageNumber) {
    const page = file.fileType === 'pdf' && objectType === 'DRAWING' ? pageNumber ?? '' : '';
    const extractedKey = `${file.contentHash}|${file.fileType}|${objectType === 'DRAWING' ? `page:${page}` : 'all'}`;
    let extractedText = this.extractedTextCache.get(extractedKey);
    if (extractedText !== undefined) return extractedText;
    extractedText = '';
    if (file.fileType === 'pdf' && objectType === 'DRAWING') {
      // One reading has every page, and the next page's object asks next.
      const pages = this.pdfText(file, 'pages', (layout) => layout.pages.map((item) => ({
        pageNumber: item.pageNumber, text: item.text ?? '' })));
      for (const item of pages) this.extractedTextCache.set(`${file.contentHash}|pdf|page:${item.pageNumber}`, item.text);
      extractedText = pages.find(item => item.pageNumber === pageNumber)?.text ?? '';
    } else if (file.fileType === 'pdf') {
      extractedText = this.pdfText(file, 'all', (_layout, buffer) => extractPdfFullText(buffer));
    } else if (file.fileType === 'document') {
      extractedText = extractDocxDocument(this.timeline.blobs.get(file.contentHash)).textExcerpt;
    } else if (file.fileType === 'presentation') {
      extractedText = presentationOutline(readPresentation(this.timeline.blobs.get(file.contentHash))).text;
    } else if (['markdown', 'text'].includes(file.fileType)) {
      extractedText = this.timeline.blobs.get(file.contentHash).toString('utf8');
    }
    this.extractedTextCache.set(extractedKey, extractedText);
    return extractedText;
  }

  /** A PDF's text, from the text store when an earlier reading kept it. */
  pdfText(file, kind, read) {
    const key = `${file.contentHash}|pdf|${kind}`;
    const stored = this.textStore.get(key);
    if (stored !== undefined) return stored;
    const buffer = this.timeline.blobs.get(file.contentHash);
    const layout = extractDrawingDocument(buffer);
    const value = read(layout, buffer);
    // A reading the native reader failed, such as a timeout under load, is not kept.
    if (layout.status !== 'error') this.textStore.set(key, value);
    return value;
  }

  /**
   * Reads the text of a snapshot's PDFs, one file per step, yielding
   * `{ phase: 'warming', done, total }`. Search over a PDF's objects includes
   * its text, and the native reader takes a moment per file, so this is done
   * while a folder starts rather than on the first keystroke after it.
   */
  *pdfTextSteps(projectId, snapshotId) {
    const pdfs = this.timeline.snapshotFiles(snapshotId).filter((file) => file.fileType === 'pdf');
    if (!pdfs.length) return;
    const drawings = new Map();
    for (const row of this.timeline.objectVersions.resolvedTypes(snapshotId, ['DRAWING']).rows) {
      if (row.project_id === projectId && /\.pdf$/i.test(row.path)) drawings.set(row.path, json(row.anchor_json, {})?.pageNumber);
    }
    // PDFs not yet in the text store are read by a worker; a caller that
    // cannot wait for one reads them below, on this thread.
    const unread = pdfs.filter((file) => this.textStore.get(`${file.contentHash}|pdf|all`) === undefined)
      .map((file) => ({ blobPath: this.timeline.blobs.pathFor(file.contentHash), contentHash: file.contentHash,
        pages: drawings.has(file.path) }));
    if (unread.length) {
      yield { phase: 'warming', done: 0, total: 1, offThread: (report) => this.readPdfTexts(unread,
        (share) => report?.({ phase: 'warming', done: share, total: 1 })) };
    }
    const total = pdfs.reduce((sum, file) => sum + workUnits(file.size), 0);
    let done = 0;
    for (const file of pdfs) {
      this.fileText(file, 'PAPER');
      if (drawings.has(file.path)) this.fileText(file, 'DRAWING', drawings.get(file.path));
      done += workUnits(file.size);
      yield { phase: 'warming', done, total };
    }
  }

  ensureIndex(projectId, snapshotId = null) {
    return runSync(this.ensureIndexSteps(projectId, snapshotId));
  }

  /** The snapshot's index row, as `ensureIndex` decides whether it has work to do. */
  indexState(snapshotId) {
    // Do not materialize the entire file manifest on every warm prediction.
    return this.db.prepare(`SELECT s.project_id, i.snapshot_id AS indexed, i.drawing_index_version, i.spreadsheet_index_version
      FROM snapshots s LEFT JOIN snapshot_object_indexes i ON i.snapshot_id = s.id WHERE s.id = ?`)
      .get(snapshotId);
  }

  /** Whether a snapshot's objects can be read without indexing anything first. */
  isIndexed(snapshotId) {
    return indexIsCurrent(snapshotId ? this.indexState(snapshotId) : null);
  }

  /**
   * Reads the files a snapshot's index lacks, yielding
   * `{ phase: 'indexing', done, total }` after each file and
   * `{ phase: 'saving' }` before recording what it read.
   */
  *ensureIndexSteps(projectId, snapshotId = null) {
    const project = this.timeline.getProject(projectId);
    const targetSnapshotId = snapshotId ?? project.currentSnapshotId;
    const indexed = this.indexState(targetSnapshotId);
    if (!indexed) throw new HttpError(404, 'Snapshot not found.');
    if (indexed.project_id !== projectId) throw new HttpError(400, 'Snapshot does not belong to this project.');
    if (indexIsCurrent(indexed)) return;
    const files = this.indexableFiles(this.timeline.getSnapshot(targetSnapshotId), indexed);
    const versions = this.timeline.objectVersions;
    // An index row cleared to force a re-index still leaves the snapshot's
    // records in place; like an upgrade pass, that only adds missing objects.
    const existing = Boolean(indexed.indexed) || versions.hasRecords(targetSnapshotId);
    const carry = existing ? null : yield* this.carryPlanSteps(projectId, targetSnapshotId, files);
    const index = carry ? this.carriedDescriptors(files, carry) : yield* this.indexDescriptorSteps(files);
    // Other requests ran between the slices of a sliced index. If one of them
    // indexed this snapshot meanwhile, what was read here is already recorded,
    // or was decided against an older state; start over from the new one. The
    // files read so far stay in the extraction cache.
    const latest = this.indexState(targetSnapshotId);
    if (latest.indexed !== indexed.indexed || latest.drawing_index_version !== indexed.drawing_index_version
      || latest.spreadsheet_index_version !== indexed.spreadsheet_index_version
      || existing !== (Boolean(latest.indexed) || versions.hasRecords(targetSnapshotId))) {
      return yield* this.ensureIndexSteps(projectId, targetSnapshotId);
    }
    yield { phase: 'saving' };
    try {
      transaction(this.db, () => {
        const recorded = versions.record(projectId, targetSnapshotId, this.indexEntries(projectId, index.descriptors),
          { existing, carriedPaths: carry?.carriedPaths });
        // A full index names the reader that produced it. An upgrade pass adds
        // to an older reading, so the snapshot keeps the reader it had, and a
        // cleared index row over older records cannot vouch for one (0).
        this.db.prepare(`INSERT INTO snapshot_object_indexes(snapshot_id, indexed_at, object_count, drawing_index_version, spreadsheet_index_version, extractor_version)
          VALUES (?, ?, ?, ?, 2, ?)
          ON CONFLICT(snapshot_id) DO UPDATE SET drawing_index_version = excluded.drawing_index_version, spreadsheet_index_version = 2, indexed_at = excluded.indexed_at, object_count = excluded.object_count`)
          .run(targetSnapshotId, now(), recorded ?? versions.count(targetSnapshotId), INDEX_VERSION, existing ? 0 : EXTRACTOR_VERSION);
      });
    } catch (error) {
      // The index was read into memory as it was written; drop it with the rollback.
      versions.forget(targetSnapshotId);
      throw error;
    }
    // An upgrade pass reads only some files and keeps what was there, so later
    // indexes cannot carry objects forward from it without reading them again.
    if (existing) this.indexedHere.delete(targetSnapshotId);
    else this.indexedHere.set(targetSnapshotId, index.summary);
    this.forgetObjects(targetSnapshotId);
    this.completionCorpusCache.delete(targetSnapshotId);
    this.workspaceRetrievalCache.delete(targetSnapshotId);
    this.ranking.invalidateSnapshot(targetSnapshotId);
    // An upgrade pass re-reads only some files, so only a full index of the
    // current version can say which files are now fine.
    if (!indexed.indexed && targetSnapshotId === project.currentSnapshotId) this.onIndexProblems?.(projectId, index.problems);
  }

  /** Every object the current reader reads out of a snapshot's files, recording nothing. */
  extractDescriptors(snapshot) {
    return this.indexDescriptors(this.indexableFiles(snapshot, { indexed: null })).descriptors;
  }

  /**
   * Records descriptors as one snapshot's reading by the current reader, inside
   * the caller's transaction. A snapshot without records stores them like a
   * full index; one that already has records only gains the objects it lacks.
   * Returns the snapshot's object count.
   */
  writeObjectIndex(projectId, snapshotId, descriptors, { carriedPaths = null } = {}) {
    const versions = this.timeline.objectVersions;
    const existing = versions.hasRecords(snapshotId);
    const objectCount = versions.record(projectId, snapshotId, this.indexEntries(projectId, descriptors), { existing, carriedPaths })
      ?? versions.count(snapshotId);
    this.db.prepare(`INSERT INTO snapshot_object_indexes(snapshot_id, indexed_at, object_count, drawing_index_version, spreadsheet_index_version, extractor_version)
      VALUES (?, ?, ?, ?, 2, ?)
      ON CONFLICT(snapshot_id) DO UPDATE SET indexed_at = excluded.indexed_at, object_count = excluded.object_count`)
      .run(snapshotId, now(), objectCount, INDEX_VERSION, existing ? 0 : EXTRACTOR_VERSION);
    this.forgetObjects(snapshotId);
    return objectCount;
  }

  /**
   * Which reader produced the project's current reading, and whether a newer
   * one exists. Nothing acts on this by itself: re-indexing records a snapshot
   * and a timeline event, so it stays something the user asks for.
   */
  indexFreshness(projectId) {
    const project = this.timeline.getProject(projectId);
    const row = this.db.prepare('SELECT extractor_version, indexed_at, object_count FROM snapshot_object_indexes WHERE snapshot_id = ?')
      .get(project.currentSnapshotId);
    // An unindexed snapshot is read by the current reader the moment anything
    // asks it for an object, so it is not behind.
    const indexedWith = row ? (row.extractor_version ?? 0) : null;
    return {
      snapshotId: project.currentSnapshotId,
      extractorVersion: EXTRACTOR_VERSION,
      indexedWith,
      indexedAt: row?.indexed_at ?? null,
      objectCount: row?.object_count ?? null,
      stale: indexedWith !== null && indexedWith < EXTRACTOR_VERSION,
    };
  }

  /** One snapshot's recorded reading, keyed by object, as its version rows store it. */
  recordedReading(snapshotId) {
    const reading = new Map();
    for (const row of this.timeline.objectVersions.resolved(snapshotId, { fresh: true }).rows) {
      reading.set(row.object_key, JSON.stringify([row.object_type, row.path, row.anchor_json, row.label,
        row.value_text ?? null, row.search_text, row.content_hash, row.metadata_json]));
    }
    return reading;
  }

  /** The same shape for a freshly read set of descriptors. */
  static descriptorReading(descriptors) {
    const reading = new Map();
    for (const descriptor of descriptors) {
      // A snapshot keeps the first version of each object key.
      if (reading.has(descriptor.key)) continue;
      reading.set(descriptor.key, JSON.stringify([descriptor.type, ...storedFields(descriptor)]));
    }
    return reading;
  }

  /**
   * Re-reads the project's files with the current reader and records the result
   * as a new snapshot carrying the same files.
   *
   * Earlier snapshots keep the objects the build that indexed them produced:
   * recorded evidence never changes, a share grant pins one of those versions
   * deliberately, and the content-addressed blobs are shared rather than
   * copied. What a re-index adds is a newer reading of the same bytes, stored
   * like any index as the differences from the snapshot before it.
   *
   * Whole-project, because the extractor version is recorded against a snapshot
   * and a half-re-read snapshot could not honestly carry one.
   */
  reindex(projectId, actorInput, options = {}) {
    return runSync(this.reindexSteps(projectId, actorInput, options));
  }

  *reindexSteps(projectId, actorInput, options = {}) {
    const project = this.timeline.getProject(projectId);
    if (options.expectedSnapshotId && options.expectedSnapshotId !== project.currentSnapshotId) {
      throw new VersionConflictError(options.expectedSnapshotId, project.currentSnapshotId);
    }
    const previous = this.timeline.getSnapshot(project.currentSnapshotId);
    // The comparison below is against what is actually recorded, so an
    // unindexed snapshot is read first.
    yield* this.ensureIndexSteps(projectId, previous.id);
    const versions = this.timeline.objectVersions;
    const indexable = this.indexableFiles(previous, { indexed: null });
    // A reader upgrade re-reads only the kinds of file it reads differently,
    // and carries the rest of the recorded reading forward. A data dictionary
    // can describe variables in any file, so a folder with one is read whole,
    // as is one whose index cannot build on its last.
    const kinds = kindsChangedSince(this.indexFreshness(projectId).indexedWith);
    const partial = Boolean(kinds) && versions.canBuildOn(previous.id)
      && !this.objectsAt(projectId, previous.id, ['VARIABLE']).some((object) => object.metadata.dictionary);
    const files = partial ? indexable.filter((file) => kinds.has(file.fileType)) : indexable;
    const reread = new Set(files.map((file) => file.path));
    const carriedPaths = partial ? new Set(previous.files.map((file) => file.path).filter((filePath) => !reread.has(filePath))) : null;
    const index = yield* this.indexDescriptorSteps(files);
    // A file saved while a sliced re-read ran makes a newer version, which
    // this reading does not describe. Read that version instead.
    if (this.timeline.getProject(projectId).currentSnapshotId !== previous.id) {
      return yield* this.reindexSteps(projectId, actorInput, { ...options, expectedSnapshotId: null });
    }
    yield { phase: 'saving' };
    const recordedCount = versions.indexedCount(previous.id);
    // Compare one stored row at a time. Keeping serialized Maps of both
    // readings alongside the descriptors doubled large folders' memory use.
    const identical = (() => {
      const byKey = new Map();
      for (const descriptor of index.descriptors) {
        if (!byKey.has(descriptor.key)) byKey.set(descriptor.key, descriptor);
      }
      let compared = 0;
      for (const row of versions.iterateResolved(previous.id)) {
        if (partial && !reread.has(row.path)) continue;
        compared += 1;
        const descriptor = byKey.get(row.object_key);
        if (!descriptor || row.object_type !== descriptor.type) return false;
        const fields = storedFields(descriptor);
        if (row.path !== fields[0] || row.anchor_json !== fields[1] || row.label !== fields[2]
          || (row.value_text ?? null) !== fields[3] || row.search_text !== fields[4]
          || row.content_hash !== fields[5] || row.metadata_json !== fields[6]) return false;
      }
      return compared === byKey.size;
    })();
    if (identical) {
      // The current reader reads these files exactly as the snapshot already
      // says. Naming the reader that produced an identical reading is
      // bookkeeping about the index, not a change to the evidence, so the
      // project stops being offered a re-read it does not need.
      this.db.prepare('UPDATE snapshot_object_indexes SET extractor_version = ? WHERE snapshot_id = ? AND extractor_version < ?')
        .run(EXTRACTOR_VERSION, previous.id, EXTRACTOR_VERSION);
      if (!partial) this.indexedHere.set(previous.id, index.summary);
      this.onIndexProblems?.(projectId, index.problems, partial ? reread : null);
      return {
        changed: false, reason: 'IDENTICAL_READING', projectId, snapshot: previous, event: null,
        objects: { before: recordedCount, after: recordedCount }, dependenciesNeedingReview: 0,
        freshness: this.indexFreshness(projectId),
      };
    }

    const fileCount = partial ? files.length : previous.files.length;
    const reason = String(options.reason ?? '').trim().slice(0, 120);
    const title = `Re-read ${fileCount} file${fileCount === 1 ? '' : 's'} with the current reader`
      + '; the files did not change' + (reason ? ` (${reason})` : '');
    let objectCount = 0;
    let newSnapshotId = null;
    let result;
    try {
      result = this.cloneTransition(projectId, actorInput, {
        source: 'REINDEX', title, initiatedBy: options.initiatedBy ?? null,
      }, ({ resultingSnapshotId }) => {
        newSnapshotId = resultingSnapshotId;
        objectCount = this.writeObjectIndex(projectId, resultingSnapshotId, index.descriptors, { carriedPaths });
      });
    } catch (error) {
      // The index was read into memory as it was written; drop it with the rollback.
      if (newSnapshotId) versions.forget(newSnapshotId);
      throw error;
    }
    if (!partial) this.indexedHere.set(result.snapshot.id, index.summary);
    for (const cache of [this.completionCorpusCache, this.studyVariableCache, this.workspaceRetrievalCache]) {
      cache.delete(previous.id);
    }
    this.forgetObjects(previous.id);
    this.ranking.invalidateSnapshot(previous.id);
    this.onIndexProblems?.(projectId, index.problems, partial ? reread : null);

    // A better reader can key an object differently (the row-label fix renames
    // every indented line item), so a claim whose source is absent from the new
    // reading needs a person, not a verdict of BROKEN. Its evidence is intact
    // and still pinned in the snapshot it was linked at.
    const reconciled = this.reconcileProject(projectId, result.snapshot.id, {
      missingSource: {
        status: 'NEEDS_REVIEW',
        reason: 'The current reader no longer produces this source object. Its recorded evidence is unchanged; re-point the claim at the new reading.',
      },
    });

    return {
      changed: true,
      projectId,
      snapshot: result.snapshot,
      event: result.event,
      objects: { before: recordedCount, after: objectCount },
      dependenciesNeedingReview: reconciled?.changed
        ? this.currentDependencies(projectId).filter((dependency) => dependency.status === 'NEEDS_REVIEW').length
        : 0,
      freshness: this.indexFreshness(projectId),
    };
  }

  /** The files an index pass reads, in the order their objects are indexed. */
  indexableFiles(snapshot, indexed) {
    // An upgrade pass reads only what its index lacks: PDF and drawing passages
    // (2), Markdown and text passages (3), STEP models (4) and worksheet rows.
    const version = indexed.drawing_index_version ?? 0;
    const upgrades = (file, design, prose) => (version < 2 && (file.fileType === 'pdf' || design))
      || (version < 3 && prose) || (version < 4 && STEP_FILE.test(file.path))
      || (!(indexed.spreadsheet_index_version >= 2) && file.fileType === 'spreadsheet');
    return [...snapshot.files].sort((left, right) => dependencyFilePriority(right) - dependencyFilePriority(left)
      || left.path.localeCompare(right.path)).filter((file) => {
      const design = isDesignFile(file);
      const prose = file.fileType === 'markdown' || (file.fileType === 'text' && path.extname(file.path).toLowerCase() === '.txt');
      if (indexed.indexed && !upgrades(file, design, prose)) return false;
      // Tables of any size are read a batch of rows at a time (table-index.js).
      // A deck's size is mostly its pictures; only its slides' text is read.
      const packaged = ['image', 'pdf', 'document', 'presentation', 'table', 'spreadsheet'].includes(file.fileType);
      if (file.size > 5_000_000 && !design && !packaged) return false;
      if (!design && !['table', 'spreadsheet', 'code', 'yaml', 'notebook', 'image', 'json', 'text', 'markdown', 'pdf',
        'document', 'presentation'].includes(file.fileType)) return false;
      return !(file.fileType === 'text' && !['.txt', '.bib', '.ris', '.enw', '.nbib'].includes(path.extname(file.path).toLowerCase()));
    });
  }

  extractedObjects(file) {
    return runSync(this.extractedObjectSteps(file));
  }

  /** The same as steps: a table too large to hold is read off this thread. */
  *extractedObjectSteps(file) {
    const key = JSON.stringify([file.projectFileId, file.path, file.fileType, file.contentHash]);
    let extracted = this.extractionCache.get(key);
    if (!extracted) {
      let problem = null;
      const report = (code, reason) => { problem ??= { code, reason }; };
      const buffer = this.timeline.blobs.get(file.contentHash);
      const objects = ['table', 'spreadsheet'].includes(file.fileType)
        ? yield* this.tableObjectSteps(file, buffer, report)
        : objectsFromFile(file, buffer, report);
      extracted = { objects, problem, bytes: JSON.stringify(objects).length * 2 };
      this.extractionCache.set(key, extracted);
    }
    return extracted;
  }

  /**
   * A table file's objects. Its first rows are read as they always were. A
   * table with more rows or cells than those is also written to the table
   * index whole, which answers for the rest; one too large to read in memory
   * is read into the index by a worker, and its first rows come from there.
   */
  *tableObjectSteps(file, buffer, report) {
    const fileName = path.posix.basename(file.path, path.posix.extname(file.path));
    const format = path.extname(file.path).slice(1).toUpperCase();
    if (file.fileType === 'table') {
      const tsv = path.extname(file.path).toLowerCase() === '.tsv';
      if (buffer.length <= MAX_IN_MEMORY_PART_BYTES) {
        const rows = parseDelimited(buffer.toString('utf8').replace(/\r\n/g, '\n'), tsv ? '\t' : ',');
        const layout = tabularLayout(rows);
        const objects = objectsFromTabular(file, fileName, layout.headers, layout.rows, {
          format, rowOffset: layout.headerRowIndex + 1,
        });
        if (objects.deep) this.indexTableRows(file.contentHash, { rows, rowNumbers: rows.map((_, index) => index) });
        return objects;
      }
      const head = buffer.subarray(0, MAX_IN_MEMORY_PART_BYTES).toString('utf8').replace(/\r\n/g, '\n');
      const read = yield* this.tableBuildSteps(file, { kind: 'delimited', delimiter: tsv ? '\t' : csvDelimiter(head) });
      const meta = read.readable ? this.tables.table(file.contentHash, '') : null;
      if (!meta) {
        report('UNREADABLE_CONTENT', 'This table could not be read.');
        return [];
      }
      return this.indexedTableObjects(file, fileName, meta, { format });
    }
    const objects = [];
    const base = file.projectFileId;
    let sheets = null;
    let metas = null;
    let readable;
    let skipped;
    if (isLargeSpreadsheet(buffer)) {
      const read = yield* this.tableBuildSteps(file, { kind: 'spreadsheet' });
      metas = this.tables.sheets(file.contentHash);
      readable = read.readable || metas.length > 0;
      skipped = metas[0]?.extras.skipped ?? read.skipped ?? [];
    } else {
      sheets = extractSpreadsheetTables(buffer);
      // A readable workbook lists the sheets it had to skip; a failed one does not.
      readable = Array.isArray(sheets.skipped);
      skipped = sheets.skipped ?? [];
    }
    const count = metas ? metas.length : sheets.length;
    if (skipped.length) {
      report('PARTIALLY_INDEXED', `${skipped.length === 1 ? 'Sheet' : 'Sheets'} ${skipped.map((name) => `“${name}”`).join(', ')} could not be read (damaged). The other sheets are indexed.`);
    }
    if (!count && format === 'ODS') {
      report('UNREADABLE_CONTENT', 'OpenDocument spreadsheets are not indexed yet. Save a copy as .xlsx or .csv to use its values.');
    } else if (!count && (!readable || skipped.length)) {
      report('UNREADABLE_CONTENT', 'This workbook could not be read. It may be password-protected or damaged.');
    }
    if (count) {
      if (metas) {
        for (const meta of metas) objects.push(...this.indexedTableObjects(file, fileName, meta, { format, sheet: meta.sheet }));
      } else {
        for (const [position, sheet] of sheets.entries()) {
          const layout = spreadsheetLayout(sheet);
          const sheetObjects = objectsFromTabular(file, fileName, layout.headers, layout.rows, {
            format, sheet: sheet.name, ...layout, rowOffset: layout.headerRowIndex + 1,
          });
          objects.push(...sheetObjects);
          if (sheetObjects.deep) {
            this.indexTableRows(file.contentHash, { sheet: sheet.name, position, rows: sheet.rows,
              rowNumbers: sheet.rowNumbers, displayRows: sheet.displayRows, merges: sheet.merges });
          }
        }
      }
      for (const object of objects) worksheetCoordinates(object);
    } else {
      objects.push(objectDescriptor({
        key: `${base}:spreadsheet`, type: 'TABLE', path: file.path, label: fileName,
        contentHash: file.contentHash, metadata: { format, binary: true },
      }));
      objects.push(objectDescriptor({
        key: `${base}:spreadsheet-dataset`, type: 'DATASET', path: file.path, label: fileName,
        contentHash: file.contentHash, metadata: { format, binary: true },
      }));
    }
    return objects;
  }

  /**
   * The tables of a file the table index answers for: plain tables whose rows
   * are named, with what their objects' keys and labels are made from.
   */
  indexedTables(file) {
    if (!['table', 'spreadsheet'].includes(file.fileType)) return [];
    const fileName = path.posix.basename(file.path, path.posix.extname(file.path));
    return this.tables.sheets(file.contentHash).filter((meta) => meta.shape?.searchable).map((meta) => {
      const sheet = file.fileType === 'spreadsheet' ? meta.sheet : null;
      const keyPrefix = sheet ? `${file.projectFileId}:xlsx-v2:sheet:${sheet}` : file.projectFileId;
      return { file, meta, sheet, keyPrefix,
        context: { file, fileName, keyPrefix, sheet, headers: meta.shape.headers, labelColumn: meta.shape.labelColumn,
          firstColumnActsAsRowLabels: meta.shape.firstColumnActsAsRowLabels,
          rowDescribesVariable: meta.shape.rowDescribesVariable, statement: false } };
    });
  }

  /** Every indexed table of a snapshot's files. */
  snapshotTables(projectId, snapshotId) {
    if (this.snapshotTableCache.has(snapshotId)) return this.snapshotTableCache.get(snapshotId);
    const tables = this.timeline.snapshotFiles(snapshotId)
      .filter((file) => ['table', 'spreadsheet'].includes(file.fileType))
      .flatMap((file) => this.indexedTables(file));
    this.snapshotTableCache.set(snapshotId, tables);
    return tables;
  }

  /**
   * A stored row's objects, the ones the indexer would have made had it read
   * that far. The lines of notes under a table are not rows of it.
   */
  indexedRowObjects(table, row) {
    const { meta, context, sheet } = table;
    const rowIndex = row.ordinal - meta.shape.dataStart;
    if (rowIndex < 0) return [];
    table.notes ??= new Set([...trailingTableNotes(this.tables.rows(meta.id, Math.max(0, meta.rowCount - TABLE_TAIL_ROWS), meta.rowCount)
      .map((stored) => ({ row: stored.cells, number: stored.rowNumber, ordinal: stored.ordinal })))
      .keys()].map((index) => Math.max(0, meta.rowCount - TABLE_TAIL_ROWS) + index));
    if (table.notes.has(row.ordinal)) return [];
    const rowLabel = String(row.cells[meta.shape.labelColumn] ?? '').trim();
    const { rowObject, cells } = tableRowObjects(context, { row: row.cells, rowIndex, rowNumber: row.rowNumber, rowLabel });
    const objects = rowObject ? [rowObject, ...cells] : cells;
    return sheet != null ? objects.map(worksheetCoordinates) : objects;
  }

  /**
   * The rows and cells of large tables this folder has recorded, read again
   * from this version of their file, so a link to one survives the file
   * being read again. `read` are the objects the indexer read itself.
   */
  recordedTableDescriptors(file, read) {
    const tables = this.indexedTables(file);
    if (!tables.length) return [];
    const readKeys = new Set(read.map((descriptor) => descriptor.key));
    const recorded = this.db.prepare('SELECT object_key FROM table_objects WHERE key_prefix = ?');
    const output = [];
    for (const table of tables) {
      const byRow = new Map();
      for (const { object_key: key } of recorded.all(table.keyPrefix)) {
        if (readKeys.has(key)) continue;
        // Keys name their row by its sheet or file row number: "row:12:ontario".
        const rowNumber = Number(key.slice(table.keyPrefix.length + 1).match(/^(?:row|cell):(\d+):/)?.[1]);
        if (!Number.isInteger(rowNumber)) continue;
        if (!byRow.has(rowNumber)) byRow.set(rowNumber, new Set());
        byRow.get(rowNumber).add(key);
      }
      for (const [rowNumber, keys] of byRow) {
        const row = this.tables.rowNumbered(table.meta.id, rowNumber);
        if (!row) continue;
        output.push(...this.indexedRowObjects(table, row).filter((descriptor) => keys.has(descriptor.key)));
      }
    }
    return output;
  }

  /** What each reading of a file records again besides what its reader finds: table rows and code lines offered before. */
  recordedDescriptors(file, read) {
    return [...this.recordedTableDescriptors(file, read), ...this.recordedLineDescriptors(file, read)];
  }

  /**
   * The code lines this folder has offered from a file, read again from this
   * version of it, so a link to "line 42" keeps following line 42.
   */
  recordedLineDescriptors(file, read) {
    if (!isCodeType(file.fileType)) return [];
    const prefix = `${file.projectFileId}:${CODE_LINES_KEY}`;
    const keys = this.db.prepare('SELECT object_key FROM table_objects WHERE key_prefix = ?').all(prefix)
      .map((row) => row.object_key);
    if (!keys.length) return [];
    const readKeys = new Set(read.map((descriptor) => descriptor.key));
    const lines = fileLines(this.timeline.blobs.get(file.contentHash)?.toString('utf8') ?? '');
    return keys.flatMap((key) => {
      if (readKeys.has(key)) return [];
      const [first, last] = key.slice(prefix.length + 1).split('-').map(Number);
      return codeLinesDescriptor(file, lines, first, last) ?? [];
    });
  }

  /** A snapshot's data dictionary definitions, as the indexer applies them to every variable it reads. */
  dictionaryDefinitions(projectId, snapshotId) {
    return this.objectsAt(projectId, snapshotId, ['VARIABLE']).filter((object) => object.metadata.dictionary)
      .map((object) => ({ type: 'VARIABLE', path: object.path, label: object.label, value: object.valueText, metadata: object.metadata }));
  }

  /**
   * Records rows and cells of a large table as objects of a snapshot, the
   * first time they are offered, and returns them as offered objects. They
   * are the objects a reading of the whole table would have recorded, and
   * each later reading of the file records them again (table_objects).
   */
  indexedObjects(projectId, snapshotId, table, descriptors) {
    const found = new Map();
    const missing = [];
    for (const descriptor of descriptors) {
      const cached = this.deepObjects.get(`${snapshotId}|${descriptor.key}`);
      if (cached) found.set(descriptor.key, cached);
      else if (!missing.some((other) => other.key === descriptor.key)) missing.push({ ...descriptor, metadata: { ...descriptor.metadata } });
    }
    if (missing.length) {
      applyVariableDefinitions(missing, this.dictionaryDefinitions(projectId, snapshotId));
      const versions = this.timeline.objectVersions;
      let entries = [];
      transaction(this.db, () => {
        entries = this.indexEntries(projectId, missing);
        const added = versions.addAt(snapshotId, entries);
        if (added.length) {
          this.db.prepare('UPDATE snapshot_object_indexes SET object_count = object_count + ? WHERE snapshot_id = ?')
            .run(added.length, snapshotId);
        }
        const record = this.db.prepare('INSERT OR IGNORE INTO table_objects(key_prefix, object_key) VALUES (?, ?)');
        for (const descriptor of missing) record.run(table.keyPrefix, descriptor.key);
      });
      for (const { object, descriptor } of entries) {
        const row = versions.at(snapshotId, object.id);
        if (!row) continue;
        const mapped = freezeIndexedValue(mapObjectRow(row));
        this.deepObjects.set(`${snapshotId}|${descriptor.key}`, mapped);
        found.set(descriptor.key, mapped);
      }
      // The ranker offers only objects it knows the snapshot holds.
      this.ranking.noteObjects(snapshotId, [...found.values()]);
    }
    return descriptors.map((descriptor) => found.get(descriptor.key)).filter(Boolean);
  }

  /** Whether a table file is too large to read whole for a preview, so its rows come from the table index. */
  isLargeTable(file, buffer) {
    if (file.fileType === 'table') return file.size > MAX_IN_MEMORY_PART_BYTES;
    return file.fileType === 'spreadsheet' && isLargeSpreadsheet(buffer);
  }

  /**
   * A large table's header rows and the rows around a cited one, from the
   * table index, for a preview; null for a table read whole as before. A
   * delimited file's rows read as worksheet rows here, numbered from 1, so a
   * preview finds the cited row among them as it would on a worksheet.
   */
  tableWindow(file, buffer, anchor = {}, { before = 2, after = 2, sheet = null } = {}) {
    if (!this.isLargeTable(file, buffer)) return null;
    const metas = this.tables.sheets(file.contentHash);
    const wanted = sheet ?? anchor.sheet ?? null;
    const meta = metas.find((candidate) => wanted == null || candidate.sheet === wanted) ?? metas[0];
    if (!meta) return null;
    const delimited = file.fileType === 'table';
    const { dataStart } = meta.shape;
    const target = Number.isInteger(anchor.rowIndex) ? this.tables.rowNumbered(meta.id, anchor.rowIndex) : null;
    const center = Math.max(dataStart, target?.ordinal ?? dataStart);
    const from = Math.max(dataStart, center - before);
    const rows = [...this.tables.rows(meta.id, 0, dataStart), ...this.tables.rows(meta.id, from, center + after + 1)];
    return {
      table: { name: delimited ? null : meta.sheet, rows: rows.map((row) => row.cells),
        rowNumbers: rows.map((row) => (delimited ? row.rowNumber + 1 : row.rowNumber)),
        displayRows: rows.map((row) => row.display ?? []), merges: meta.extras.merges ?? [], tables: [] },
      anchor: delimited && Number.isInteger(anchor.rowIndex) ? { ...anchor, rowIndex: anchor.rowIndex + 1, rowCoordinate: 'worksheet' } : anchor,
      sheets: metas.map((candidate) => candidate.sheet),
      headerRows: dataStart,
      firstRow: from - dataStart,
      totalRows: meta.rowCount - dataStart,
    };
  }

  /** Writes a table read in memory to the table index, once per file content. */
  indexTableRows(contentHash, table) {
    if (this.tables.table(contentHash, table.sheet ?? '')) return;
    writeTable(this.tables.db, contentHash, table);
    this.tables.forget(contentHash);
  }

  /**
   * Has a worker read a large table file into the index, unless it already is.
   * A caller in slices waits for it without holding the thread; one that must
   * have the answer now waits for it here. Either way the reading is the same.
   */
  *tableBuildSteps(file, request) {
    if (this.tables.has(file.contentHash)) return { readable: true };
    const known = this.tableReadings.get(file.contentHash);
    if (known) return known;
    const job = { ...request, contentHash: file.contentHash, blobPath: this.timeline.blobs.pathFor(file.contentHash) };
    let read = yield { share: 0, offThread: (report) => this.buildTable(job, report) };
    if (!read) {
      try { read = this.tables.buildBlocking(job); }
      catch (error) { read = { readable: false, error: error.message, skipped: [] }; }
    }
    this.tableReadings.set(file.contentHash, read);
    return read;
  }

  /** Has a worker read PDFs' text into the text store. Resolves once it has, or has failed. */
  readPdfTexts(items, report) {
    return new Promise((resolve) => {
      const worker = new Worker(new URL('./pdf-text-worker.js', import.meta.url), {
        workerData: { root: this.textStore.root, readerVersion: EXTRACTOR_VERSION, items },
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
      worker.on('message', (message) => {
        if (message.progress != null) report?.(message.progress);
        if (message.done) resolve(true);
      });
      worker.on('error', () => resolve(false));
      worker.on('exit', () => resolve(false));
    });
  }

  /** One worker per file content; a second request waits for the first. */
  buildTable(job, report) {
    let pending = this.tableBuilds.get(job.contentHash);
    if (!pending) {
      pending = this.tables.build(job, report)
        .catch((error) => ({ readable: false, error: error.message, skipped: [] }))
        .finally(() => this.tableBuilds.delete(job.contentHash));
      this.tableBuilds.set(job.contentHash, pending);
    }
    return pending;
  }

  /**
   * A table's objects read from the table index: all its rows when there are
   * few, as the in-memory reader would read them, otherwise its first rows,
   * how many it has, and its last rows for the notes under it.
   */
  indexedTableObjects(file, fileName, meta, { format, sheet = null }) {
    const { dataStart } = meta.shape;
    const limit = dataStart + MAX_INDEXED_TABLE_ROWS;
    const whole = meta.rowCount <= limit + TABLE_TAIL_ROWS;
    const stored = this.tables.rows(meta.id, 0, whole ? meta.rowCount : limit);
    const window = whole ? null : {
      filledRows: meta.rowCount - dataStart,
      tail: this.tables.rows(meta.id, meta.rowCount - TABLE_TAIL_ROWS, meta.rowCount)
        .map((row) => ({ row: row.cells, number: row.rowNumber })),
    };
    if (sheet != null) {
      const layout = spreadsheetLayout({ name: sheet, rows: stored.map((row) => row.cells), rowNumbers: stored.map((row) => row.rowNumber) });
      return objectsFromTabular(file, fileName, layout.headers, layout.rows, {
        format, sheet, ...layout, rowOffset: layout.headerRowIndex + 1, ...(window ? { window } : {}),
      });
    }
    // A delimited file's blank lines are not stored; its rows keep their places.
    const rows = [];
    for (const row of stored) {
      while (rows.length < row.rowNumber) rows.push(['']);
      rows.push(row.cells);
    }
    const layout = tabularLayout(rows);
    return objectsFromTabular(file, fileName, layout.headers, layout.rows, {
      format, rowOffset: layout.headerRowIndex + 1, ...(window ? { window } : {}),
    });
  }

  /**
   * Every object of the files, as a full index records them, with what a
   * later index needs to carry them forward without reading them again.
   */
  indexDescriptors(files) {
    return runSync(this.indexDescriptorSteps(files));
  }

  /** The same, yielding `{ phase: 'indexing', done, total }` in work units after each file. */
  *indexDescriptorSteps(files) {
    const descriptors = [];
    const problems = [];
    const counts = new Map();
    const total = files.reduce((sum, file) => sum + workUnits(file.size), 0);
    let done = 0;
    for (const file of files) {
      const units = workUnits(file.size);
      const extracted = yield* withinFile(this.extractedObjectSteps(file),
        (share) => ({ phase: 'indexing', done: done + share * units, total }));
      const objects = [...extracted.objects, ...this.recordedDescriptors(file, extracted.objects)];
      counts.set(file.path, objects.length);
      if (extracted.problem) problems.push({ path: file.path, ...extracted.problem });
      // Readers bound each file's bytes, rows and geometry. A folder-wide
      // budget must not silently exclude every file after an arbitrary cutoff.
      for (const descriptor of objects) {
        descriptors.push({ ...descriptor, metadata: { ...descriptor.metadata } });
      }
      done += units;
      yield { phase: 'indexing', done, total };
    }
    const definitions = descriptors.filter(isDictionaryVariable);
    applyVariableDefinitions(descriptors, definitions);
    return { descriptors, problems, summary: indexSummary(counts, problems, definitions, false) };
  }

  /**
   * Whether a new index can carry an unchanged file's objects forward from
   * its base instead of rebuilding them. It can when this process indexed the
   * base in full, nothing was cut off by the object limit, and no file that
   * changed defines variables for other files.
   */
  carryPlan(projectId, snapshotId, files) {
    return runSync(this.carryPlanSteps(projectId, snapshotId, files));
  }

  /** The same, yielding `{ phase: 'indexing', done, total }` as it reads the files that changed. */
  *carryPlanSteps(projectId, snapshotId, files) {
    const base = this.timeline.objectVersions.baseFor(projectId, snapshotId);
    const known = base ? this.indexedHere.get(base) : null;
    if (!known || known.truncated) return null;
    const before = this.timeline.files.manifest(base).byPath;
    const unchanged = (file) => {
      const previous = before.get(file.path);
      return previous?.project_file_id === file.projectFileId && previous.content_hash === file.contentHash
        && currentFileType(previous.path, previous.file_type) === file.fileType && known.counts.has(file.path);
    };
    const carriedPaths = new Set(files.filter(unchanged).map((file) => file.path));
    if ([...known.dictionaryPaths].some((filePath) => !carriedPaths.has(filePath))) return null;
    // Carrying a few files forward from a much larger base would record a
    // removal for most of it; such an index is read and written in full.
    const carried = [...carriedPaths].reduce((sum, filePath) => sum + known.counts.get(filePath), 0);
    const based = [...known.counts.values()].reduce((sum, count) => sum + count, 0);
    if (carried * FULL_WRITE_SHARE < based) return null;
    // The files that changed are read here, once; carriedDescriptors then
    // takes them from the extraction cache.
    const changed = files.filter((file) => !carriedPaths.has(file.path));
    const total = changed.reduce((sum, file) => sum + workUnits(file.size), 0);
    let done = 0;
    for (const file of changed) {
      const units = workUnits(file.size);
      const extracted = yield* withinFile(this.extractedObjectSteps(file),
        (share) => ({ phase: 'indexing', done: done + share * units, total }));
      if (extracted.objects.some(isDictionaryVariable)) return null;
      done += units;
      yield { phase: 'indexing', done, total };
    }
    return { base, known, carriedPaths };
  }

  /** The objects of the files that changed since the base; the others are carried forward. */
  carriedDescriptors(files, { known, carriedPaths }) {
    const descriptors = [];
    const problems = [];
    const counts = new Map();
    for (const file of files) {
      if (carriedPaths.has(file.path)) {
        counts.set(file.path, known.counts.get(file.path));
        problems.push(...(known.problems.get(file.path) ?? []));
        continue;
      }
      const extracted = this.extractedObjects(file);
      const objects = [...extracted.objects, ...this.recordedDescriptors(file, extracted.objects)];
      counts.set(file.path, objects.length);
      if (extracted.problem) problems.push({ path: file.path, ...extracted.problem });
      descriptors.push(...objects.map((descriptor) => ({ ...descriptor, metadata: { ...descriptor.metadata } })));
    }
    applyVariableDefinitions(descriptors, known.definitions);
    return { descriptors, problems, summary: indexSummary(counts, problems, known.definitions, false) };
  }

  /** Each descriptor with its object row, creating objects first seen here. */
  indexEntries(projectId, descriptors) {
    const getObject = this.db.prepare(`SELECT rowid, id, object_key, object_type FROM scientific_objects
      WHERE project_id = ? AND object_key = ?`);
    const insertObject = this.db.prepare(`
      INSERT INTO scientific_objects(id, project_id, object_key, object_type, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, object_key) DO NOTHING
    `);
    const objects = new Map();
    if (descriptors.length > INDIVIDUAL_OBJECT_LOOKUPS) {
      const keys = [...new Set(descriptors.map(descriptor => descriptor.key))];
      for (let offset = 0; offset < keys.length; offset += 128) {
        const batch = keys.slice(offset, offset + 128);
        const rows = this.db.prepare(`SELECT rowid, id, object_key, object_type FROM scientific_objects
          WHERE project_id = ? AND object_key IN (${batch.map(() => '?').join(',')})`).all(projectId, ...batch);
        for (const row of rows) objects.set(row.object_key, row);
      }
    }
    const entries = [];
    const seen = new Set();
    for (const descriptor of descriptors) {
      let object = objects.get(descriptor.key) ?? getObject.get(projectId, descriptor.key);
      if (!object) {
        insertObject.run(id(), projectId, descriptor.key, descriptor.type, now());
        object = getObject.get(projectId, descriptor.key);
      }
      objects.set(descriptor.key, object);
      // The first descriptor for an object wins, as INSERT OR IGNORE did.
      if (seen.has(object.id)) continue;
      seen.add(object.id);
      entries.push({ object, descriptor });
    }
    return entries;
  }

  objectsAt(projectId, snapshotId = null, objectTypes = null) {
    const project = this.timeline.getProject(projectId);
    const target = snapshotId ?? project.currentSnapshotId;
    this.ensureIndex(projectId, target);
    const types = new Set([...(objectTypes ?? [])].filter((type) => OBJECT_TYPES.has(type)));
    const complete = this.objectCache.get(target);
    // Each consumer gets its own array. Indexed object values are immutable.
    if (complete) return types.size ? complete.filter((object) => types.has(object.objectType)) : [...complete];
    if (!types.size) {
      const objects = this.mappedObjects(projectId, this.timeline.objectVersions.resolved(target));
      this.objectCache.set(target, objects);
      return [...objects];
    }
    // Nearly every suggestion asks for a few types. They are kept by type, so
    // a later request for an overlapping set maps nothing again; mapping a
    // PDF's objects reads its text, which ran the PDF reader on each keystroke.
    // Full resolution orders rows by type first, so joining the types in that
    // order is the same list the complete snapshot would filter down to.
    const ordered = [...types].sort(compareText);
    const byType = new Map(ordered.map((type) => [type, this.typedObjectCache.get(`${target}|${type}`)]));
    const missing = ordered.filter((type) => !byType.get(type));
    if (missing.length) {
      const mapped = this.mappedObjects(projectId, this.timeline.objectVersions.resolvedTypes(target, missing));
      for (const type of missing) {
        const objects = mapped.filter((object) => object.objectType === type);
        byType.set(type, objects);
        // Partial results never stand in for the complete snapshot.
        this.typedObjectCache.set(`${target}|${type}`, objects);
      }
    }
    return ordered.flatMap((type) => byType.get(type));
  }

  /** Version rows as the objects suggestions and search are offered. */
  mappedObjects(projectId, resolved) {
    return resolved.rows.filter((row) => row.project_id === projectId).map((row) => {
        const object = mapObjectRow(row, resolved);
        // Search existing PDF versions through their preserved bytes as well as
        // the short metadata excerpt. Derived search text stays in memory so
        // immutable object versions and existing links retain their identity.
        if (/\.pdf$/i.test(object.path) && ['PAPER', 'DRAWING', 'DOCUMENT'].includes(object.objectType)
          && !isPassageExcerpt(object)) {
          object.searchText += ` ${this.sourceText(object).toLowerCase()}`;
        }
        return freezeIndexedValue(object);
      // Earlier indexes recorded prose such as "figure found" as a component.
      // Those versions stay resolvable for existing links but are not offered.
      }).filter((object) => !object.metadata.componentType || !['FIGURE', 'TABLE'].includes(object.metadata.componentType)
        || isComponentIdentifier(object.metadata.identifier))
        // Workbook objects from before worksheet coordinates were superseded
        // by xlsx-v2 keys; they stay resolvable for links but are not offered.
        .filter((object) => !/\.xlsx?$/i.test(object.path) || object.metadata.binary || object.metadata.spreadsheetExtractionVersion === 2);
  }

  /** Drops a snapshot's mapped objects, complete and by type, after its index changes. */
  forgetObjects(snapshotId) {
    this.objectCache.delete(snapshotId);
    for (const type of OBJECT_TYPES) this.typedObjectCache.delete(`${snapshotId}|${type}`);
  }

  objectAt(projectId, snapshotId, objectId) {
    this.ensureIndex(projectId, snapshotId);
    const row = this.timeline.objectVersions.at(snapshotId, objectId);
    return row?.project_id === projectId ? mapObjectRow(row) : null;
  }

  /** Resolve a source in its own directory without weakening objectsAt's
   * explicit project/snapshot isolation. Document transitions remain owned by
   * the destination directory even when their sources live elsewhere. */
  sourceVersion(objectId, snapshotId = null, { destinationProjectId = null, newLink = false } = {}) {
    const owner = this.db.prepare('SELECT project_id FROM scientific_objects WHERE id = ?').get(objectId);
    if (!owner) return null;
    const project = this.timeline.getProject(owner.project_id);
    if (newLink && destinationProjectId && destinationProjectId !== project.id && this.workspace
      && (!this.workspace.isActive(destinationProjectId) || !this.workspace.isActive(project.id))) {
      throw new HttpError(409, 'Enable both work directories before linking sources between them.');
    }
    const target = snapshotId ?? project.currentSnapshotId;
    const snapshot = this.db.prepare('SELECT project_id FROM snapshots WHERE id = ?').get(target);
    if (!snapshot || snapshot.project_id !== project.id) return null;
    this.ensureIndex(project.id, target);
    return this.timeline.objectVersions.at(target, objectId);
  }

  sourceProjectId(object) {
    return object.projectId ?? this.db.prepare('SELECT project_id FROM scientific_objects WHERE id = ?')
      .get(object.id)?.project_id ?? null;
  }

  /// Latest indexed version by globally unique object id. Used only by the
  /// local native overlay to migrate pre-source-identity references.
  objectById(objectId) {
    const row = this.timeline.objectVersions.latest(objectId);
    return row ? { ...mapObjectRow(row), projectId: row.project_id } : null;
  }

  warmPredictionCaches(projectId, snapshotId = null) {
    return runSync(this.warmPredictionCacheSteps(projectId, snapshotId));
  }

  /** Builds a snapshot's suggestion caches, reading its PDFs' text first, one file per step. */
  *warmPredictionCacheSteps(projectId, snapshotId = null) {
    const project = this.timeline.getProject(projectId);
    const target = snapshotId ?? project.currentSnapshotId;
    yield* this.pdfTextSteps(projectId, target);
    this.retrievalIndexOf(this.workspaceRetrievalObjects(projectId, target));
    yield;
    // Typing a file's name asks for these on the first keystroke.
    this.objectsAt(projectId, target, WHOLE_FILE_TYPES);
    this.variableIndexOf(this.studyVariables(projectId, target));
    yield;
    // Ranking checks every suggestion is still at the snapshot it came from.
    this.ranking.indexedSnapshot(projectId, target);
    yield;
    indexSentenceCorpus(this.completionCorpus(projectId, target));
  }

  completionCorpus(projectId, snapshotId = null) {
    const project = this.timeline.getProject(projectId);
    const target = snapshotId ?? project.currentSnapshotId;
    if (this.completionCorpusCache.has(target)) return this.completionCorpusCache.get(target);
    const snapshot = this.timeline.getSnapshot(target);
    const sources = [];
    const objects = this.objectsAt(projectId, target, new Set(['PAPER', 'DOCUMENT', 'REFERENCE', 'DRAWING']));
    const objectByPath = new Map();
    // Sentence objects must precede their parent and paragraph objects because
    // the corpus deduplicates the same sentence within one file.
    objects.sort((left, right) => Number(right.metadata.excerptType === 'sentence') - Number(left.metadata.excerptType === 'sentence')
      || Number(isPassageExcerpt(right)) - Number(isPassageExcerpt(left)));
    const excerptPaths = new Set(objects.filter(isPassageExcerpt).map(object => object.path));
    for (const object of objects) {
      if (!isPassageExcerpt(object) && (!objectByPath.has(object.path) || isPassageExcerpt(objectByPath.get(object.path))
        || ['PAPER', 'REFERENCE'].includes(object.objectType))) objectByPath.set(object.path, object);
      if (excerptPaths.has(object.path) && !isPassageExcerpt(object)) continue;
      const text = [['PAPER', 'DRAWING'].includes(object.objectType) && /\.pdf$/i.test(object.path) ? this.sourceText(object) : object.metadata.textExcerpt,
        object.metadata.title, object.metadata.subject, object.valueText]
        .filter(Boolean).join('\n');
      if (text) sources.push({ text, path: object.path, snapshotId: target, dependencyCandidate: object });
    }
    for (const file of snapshot.files) {
      const extension = path.extname(file.path).toLowerCase();
      if (file.fileType !== 'markdown' && !(file.fileType === 'text' && ['.txt', '.tex'].includes(extension))) continue;
      if (file.size > 2_000_000) continue;
      const content = this.timeline.blobs.get(file.contentHash).toString('utf8');
      sources.push({
        // Prose in a passage-indexed file already links to its own sentence or
        // paragraph above; only headings still complete from the file itself.
        text: excerptPaths.has(file.path)
          ? markdownBlocks(content).filter(block => block.type === 'heading').map(block => block.text).join('\n')
          : content,
        path: file.path,
        snapshotId: target,
        dependencyCandidate: objectByPath.get(file.path) ?? null,
      });
    }
    const corpus = buildSentenceCorpus(sources);
    this.completionCorpusCache.set(target, corpus);
    return corpus;
  }

  lineageForObject(projectId, object, limit = 8) {
    // This runs for every suggestion while typing. Most snapshots have no
    // outgoing links: find the ones that do for the object's paths in one
    // query, then keep those where the object was indexed at that path.
    const paths = [...new Set([object.path, ...this.db.prepare(
      'SELECT DISTINCT path FROM scientific_object_versions WHERE object_id = ?').all(object.id).map((row) => row.path)])];
    const versions = this.timeline.objectVersions;
    const queue = this.db.prepare(`SELECT DISTINCT p.from_snapshot_id, p.from_path, s.version FROM provenance_links p
      JOIN snapshots s ON s.id = p.from_snapshot_id
      WHERE p.project_id = ? AND p.relation <> 'DEPENDS_ON' AND p.from_path IN (${paths.map(() => '?').join(', ')})
      ORDER BY s.version DESC`).all(projectId, ...paths)
      .filter((row) => versions.at(row.from_snapshot_id, object.id)?.path === row.from_path)
      .map((row) => ({ snapshotId: row.from_snapshot_id, path: row.from_path, version: row.version, depth: 0 }));
    this.lineageLinks ??= this.db.prepare(`
      SELECT p.*, s.version AS to_version
      FROM provenance_links p LEFT JOIN snapshots s ON s.id = p.to_snapshot_id
      WHERE p.project_id = ? AND p.from_snapshot_id = ? AND p.from_path = ?
      ORDER BY p.created_at DESC
    `);
    const visited = new Set();
    const seenLinks = new Set();
    const lineage = [];
    while (queue.length && lineage.length < limit) {
      const node = queue.shift();
      const key = `${node.snapshotId}|${node.path}`;
      if (visited.has(key) || node.depth > 4) continue;
      visited.add(key);
      const links = this.lineageLinks.all(projectId, node.snapshotId, node.path);
      for (const link of links) {
        if (seenLinks.has(link.id) || link.relation === 'DEPENDS_ON') continue;
        seenLinks.add(link.id);
        const entry = {
          relation: link.relation,
          snapshotId: link.to_snapshot_id,
          version: link.to_version,
          path: link.to_path,
          anchor: json(link.to_anchor_json, null),
          metadata: json(link.metadata_json, {}),
        };
        lineage.push(entry);
        if (entry.snapshotId && entry.path) queue.push({ ...entry, depth: node.depth + 1 });
        if (lineage.length >= limit) break;
      }
    }
    return lineage;
  }

  enrichObject(projectId, object) {
    const ownerId = this.sourceProjectId(object) ?? projectId;
    const lineage = this.lineageForObject(ownerId, object);
    const origin = lineage.find((item) => /\.(?:py|r|ipynb|js|ts|sql)$/i.test(item.path ?? '')
      || ['line', 'code-block', 'notebook-cell'].includes(item.anchor?.kind)) ?? lineage[0] ?? null;
    return { ...object, projectId: ownerId, lineage, origin };
  }

  studyVariables(projectId, snapshotId = null) {
    const project = this.timeline.getProject(projectId);
    const target = snapshotId ?? project.currentSnapshotId;
    if (this.studyVariableCache.has(target)) return this.studyVariableCache.get(target);
    const dataTypes = new Set(['VARIABLE', 'RESULT', 'VALUE', 'DATASET_ROW', 'DATASET_VALUE', 'TABLE', 'DRAWING_ANNOTATION']);
    const workspaceObjects = this.workspaceRetrievalCache.get(target);
    const indexed = (workspaceObjects ?? this.objectsAt(projectId, target, dataTypes))
      .filter((object) => dataTypes.has(object.objectType))
      .map(studyVariable).filter((object) => object.variable && /[A-Za-z]/.test(object.variable));
    this.studyVariableCache.set(target, indexed);
    return indexed;
  }

  /**
   * The names in a list of study variables, kept with the list. Many objects
   * share a name, as every cell of a column does, so what is typed is matched
   * against each name once rather than against every object. Measured parts
   * are found by the first word of the part's name.
   */
  variableIndexOf(objects) {
    let index = this.variableIndexes.get(objects);
    if (index) return index;
    const names = [];
    const byVariable = new Map();
    const nameOf = new Int32Array(objects.length);
    const parts = new Map();
    objects.forEach((object, position) => {
      let name = byVariable.get(object.variable);
      if (name === undefined) {
        name = names.length;
        byVariable.set(object.variable, name);
        names.push({ normalizedVariable: object.normalizedVariable, variableWords: object.variableWords,
          wordSuffixes: wordSuffixes(object.variableWords) });
      }
      nameOf[position] = name;
      const part = measuredPartWords(object);
      if (part.length) {
        if (!parts.has(part[0])) parts.set(part[0], []);
        parts.get(part[0]).push({ position, part });
      }
    });
    index = { names, nameOf, parts };
    this.variableIndexes.set(objects, index);
    return index;
  }

  /** The objects in a list of study variables that what is typed can name, in list order, with how. */
  matchingStudyVariables(objects, normalizedQuery, queryWords) {
    const { names, nameOf, parts } = this.variableIndexOf(objects);
    const matches = names.map((name) => variableNameMatch(name, normalizedQuery, queryWords));
    const measured = new Set((parts.get(queryWords[0]) ?? [])
      .filter(({ position, part }) => namesMeasuredPart(objects[position], queryWords, part))
      .map(({ position }) => position));
    const output = [];
    for (let position = 0; position < objects.length; position += 1) {
      const match = matches[nameOf[position]];
      const partMeasurement = !match.exact && !match.prefix && !match.contains && measured.has(position);
      if (match.exact || match.prefix || match.contains || partMeasurement || match.tokenPrefix) {
        output.push({ object: objects[position], match: { ...match, partMeasurement } });
      }
    }
    return output;
  }

  /** The keys of objects already in a list, kept with the list. */
  keysOf(objects) {
    let keys = this.objectKeySets.get(objects);
    if (!keys) {
      keys = new Set(objects.map((object) => object.objectKey));
      this.objectKeySets.set(objects, keys);
    }
    return keys;
  }

  /**
   * Named rows past the first rows of a snapshot's large tables whose names
   * begin with `query`, or have a word that does: a bounded range scan of the
   * table index, never a pass over the table. They are scored as the
   * indexer's own rows are, and recorded as objects only if they are shown.
   */
  indexedStudyVariables(projectId, snapshotId, query, known) {
    const target = snapshotId ?? this.timeline.getProject(projectId).currentSnapshotId;
    const output = [];
    for (const table of this.snapshotTables(projectId, target)) {
      for (const row of this.tables.search(table.meta.id, query, INDEXED_MATCHES_PER_TABLE)) {
        const descriptor = this.indexedRowObjects(table, row).find((candidate) => candidate.type === 'DATASET_ROW');
        if (!descriptor || known.has(descriptor.key)) continue;
        output.push({ ...studyVariable(pendingObject(projectId, target, descriptor)),
          pendingIndex: { table, descriptor, snapshotId: target } });
      }
    }
    return output;
  }

  /**
   * Rows past the first rows of an accepted source's large table: the source
   * row's own cells, or the rows the words after it begin to name, with the
   * value in the source's column. Found in the table index and recorded as
   * objects to offer.
   */
  indexedRelatedObjects(projectId, source, tail, { variableKey, known }) {
    const ownerId = this.sourceProjectId(source) ?? projectId;
    const sheet = source.metadata.sheet ?? source.anchor?.sheet ?? null;
    const table = this.snapshotTables(ownerId, source.snapshotId)
      .find((candidate) => candidate.file.path === source.path && (candidate.sheet ?? null) === sheet);
    if (!table) return [];
    const rowLabel = String(source.anchor?.rowKey ?? source.metadata.row ?? '').trim();
    // A row, or a cell of a table whose rows are its variables, stands for its row.
    const byRow = source.objectType === 'DATASET_ROW' || (rowLabel && normalizedVariable(rowLabel) === variableKey);
    const descriptors = [];
    if (byRow) {
      const row = Number.isInteger(source.anchor?.rowIndex) ? this.tables.rowNumbered(table.meta.id, source.anchor.rowIndex) : null;
      if (row) descriptors.push(...this.indexedRowObjects(table, row).filter((descriptor) => descriptor.type !== 'DATASET_ROW'));
    } else {
      // The rows the words after the source can name, as the in-memory rows
      // are matched: the name being typed at the end, and a numbered row
      // ("Control 3", "district 45003") written anywhere after it.
      const typed = [...rowCompletionFragments(tail).map((fragment) => fragment.text),
        ...[...String(tail).matchAll(/\b[A-Za-z]{1,16}[\s_-]*\d+\b/g)].map((match) => match[0])];
      for (const text of new Set(typed)) {
        for (const row of this.tables.search(table.meta.id, text, INDEXED_MATCHES_PER_TABLE)) {
          descriptors.push(...this.indexedRowObjects(table, row).filter((descriptor) => descriptor.type !== 'DATASET_ROW'
            && normalizedVariable(descriptor.metadata.variable ?? descriptor.metadata.column) === variableKey));
        }
      }
    }
    const fresh = descriptors.filter((descriptor) => !known.has(descriptor.key)).slice(0, INDEXED_RELATED_OBJECTS);
    return fresh.length ? this.indexedObjects(ownerId, source.snapshotId, table, fresh) : [];
  }

  candidatesForStudyVariable(projectId, fragment, options = {}) {
    const query = String(fragment.text ?? '').trim();
    if (normalizedVariable(query).length < 2) return [];
    const normalizedQuery = normalizedVariable(query);
    const queryWords = variableTokens(humanVariable(query));
    const permitted = this.autocompleteFilter(projectId);
    const known = this.studyVariables(projectId, options.snapshotId);
    const indexed = this.indexedStudyVariables(projectId, options.snapshotId, query, this.keysOf(known));
    // Only names that match can score; an object that matches no way scores under the threshold.
    const matching = [...this.matchingStudyVariables(known, normalizedQuery, queryWords),
      ...indexed.map((object) => {
        const match = variableNameMatch({ ...object, wordSuffixes: wordSuffixes(object.variableWords) }, normalizedQuery, queryWords);
        return { object, match: { ...match, partMeasurement: !match.exact && !match.prefix && !match.contains
          && namesMeasuredPart(object, queryWords) } };
      })];
    const ranked = matching
      .filter(({ object }) => !options.documentPath || object.path !== options.documentPath)
      .filter(({ object }) => permitted(object))
      // A measurement's label starts with its drawing's name ("Bracket overall X
      // extent"), so it waits until the drawing itself can be named and offered first.
      .filter(({ object }) => object.objectType !== 'DRAWING_ANNOTATION'
        || normalizedQuery.length >= DRAWING_NAME_MIN_LETTERS)
      .map(({ object, match }) => {
        const { exact, prefix, contains, tokenPrefix, partMeasurement } = match;
        const variableObject = object.objectType === 'VARIABLE' ? 1 : 0;
        const rowObject = object.objectType === 'DATASET_ROW' && !object.namedRow ? 1 : 0;
        // Named rows rank below variables and line items that match as well.
        const namedRow = object.namedRow ? 1 : 0;
        const dictionary = object.metadata.dictionary ? 1 : 0;
        const dataPath = /(^|\/)(?:data|datasets?|results?|outputs?|tables?|metabolomics)(\/|$)/i.test(object.path) ? 1 : 0;
        const base = exact ? 0.91 : prefix ? 0.82 : contains ? 0.74 : partMeasurement ? 0.72 : tokenPrefix ? 0.68 : 0;
        const profileQuality = object.metadata.range ? 0.025
          : object.metadata.samples?.length ? 0.012 : object.metadata.dictionary ? 0.01 : -0.015;
        const score = Math.min(0.99, base + variableObject * 0.04 + rowObject * 0.065
          + dictionary * 0.03 + dataPath * 0.02 + profileQuality - namedRow * 0.03);
        const reasons = namedRow ? [exact ? 'Exact row name' : 'Matching row name']
          : [exact ? 'Exact variable name' : prefix || tokenPrefix ? 'Matching variable prefix' : 'Matching variable name'];
        if (dictionary) reasons.push('data dictionary definition');
        else if (rowObject || namedRow) reasons.push('named dataset row');
        else if (variableObject) reasons.push('inferred from dataset column');
        return {
          ...object,
          label: object.variable,
          completionText: object.variable,
          score: Number(score.toFixed(3)),
          matchTier: exact ? 0 : 1,
          reasons,
          variableDefinition: object.objectType === 'VARIABLE' ? {
            variable: object.variable,
            description: object.metadata.description ?? object.metadata.inferredMeaning ?? object.valueText,
            units: object.metadata.units ?? null,
            path: object.path,
            inferred: !object.metadata.dictionary,
          } : null,
        };
      }).filter((object) => object.score >= 0.68)
      .sort((left, right) => right.score - left.score
        || Number(right.objectType === 'DATASET_ROW' && !right.namedRow) - Number(left.objectType === 'DATASET_ROW' && !left.namedRow)
        || Number(right.objectType === 'VARIABLE') - Number(left.objectType === 'VARIABLE')
        || left.variable.localeCompare(right.variable)
        || left.path.localeCompare(right.path));
    const seen = new Set();
    const output = [];
    for (const candidate of this.ranking.rank(projectId, this.recordIndexedCandidates(projectId, ranked), {
      query, documentPath: options.documentPath, relatedPaths: options.relatedPaths,
      minimumScore: 0.68, limit: ranked.length, diversify: false,
    })) {
      const key = normalizedVariable(candidate.variable);
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(candidate);
      if (output.length >= (options.limit ?? 40)) break;
    }
    return output;
  }

  /**
   * Scored candidates with the best few rows from the table index recorded as
   * objects, since only recorded objects are offered; the rest are left out.
   */
  recordIndexedCandidates(projectId, scored) {
    const pending = scored.filter((candidate) => candidate.pendingIndex).slice(0, INDEXED_ROWS_SHOWN);
    if (!pending.length) return scored;
    const recorded = new Map();
    for (const candidate of pending) {
      const { table, descriptor, snapshotId } = candidate.pendingIndex;
      const [object] = this.indexedObjects(projectId, snapshotId, table, [descriptor]);
      if (!object) continue;
      const { pendingIndex, ...rest } = candidate;
      recorded.set(candidate, { ...rest, id: object.id, versionId: object.versionId, snapshotId: object.snapshotId,
        snapshotVersion: object.snapshotVersion, metadata: object.metadata, searchText: object.searchText });
    }
    return scored.flatMap((candidate) => !candidate.pendingIndex ? [candidate]
      : recorded.has(candidate) ? [recorded.get(candidate)] : []);
  }

  /** Words after `settledAt`, a value already accepted, are the only ones read. */
  progressiveStudyVariable(projectId, input, cursor, settledAt = -1) {
    if (cursor !== String(input.text ?? '').length) return null;
    const context = writingSourceContext(input.text, cursor, input.section);
    if (context.literatureIntent) return null;
    for (const fragment of progressiveVariableFragments(input.text, cursor, settledAt)) {
      const candidates = this.candidatesForStudyVariable(projectId, fragment, {
        documentPath: input.documentPath,
        relatedPaths: this.relatedSourcePaths(projectId, input),
        limit: 40,
      });
      if (candidates.length) return { fragment, candidates, context };
    }
    return context.projectIntent ? { fragment: null, candidates: [], context } : null;
  }

  /** A whole file (drawing, dataset or worksheet, document, PDF) the words at
   * the cursor name. Its label is the text Tab inserts in place of them. */
  fileReference(projectId, input, cursor, settledAt = -1) {
    const fragments = progressiveVariableFragments(input.text, cursor, settledAt);
    if (!fragments.length) return null;
    const permitted = this.autocompleteFilter(projectId);
    const files = this.objectsAt(projectId, null, WHOLE_FILE_TYPES)
      .filter(object => isWholeFile(object) && object.path !== input.documentPath && permitted(object));
    for (const fragment of fragments) {
      const candidates = files.flatMap(object => {
        const match = fileReferenceMatch(object, fragment.text);
        return match ? [this.enrichObject(projectId, {
          ...object, label: match.label, score: match.score, matchTier: 0, fileReference: true,
          reasons: [object.objectType === 'DRAWING' ? 'Matching drawing reference' : 'Matching file name'],
        })] : [];
      }).sort((left, right) => right.score - left.score);
      if (candidates.length) return { ...fragment, type: 'ENTITY', partial: true,
        value: fragment.text, candidates, asWritten: typedAsWritten(fragment.text) };
    }
    return null;
  }

  workspaceRetrievalObjects(projectId, snapshotId = null) {
    const project = this.timeline.getProject(projectId);
    const target = snapshotId ?? project.currentSnapshotId;
    if (this.workspaceRetrievalCache.has(target)) return this.workspaceRetrievalCache.get(target);
    const retrievableTypes = new Set([
      'VARIABLE', 'RESULT', 'VALUE', 'DATASET_ROW', 'DATASET_VALUE', 'DATASET', 'METHOD', 'MODEL',
      'PARAMETER', 'PROTOCOL', 'ANALYSIS_RUN', 'FIGURE', 'TABLE', 'DOCUMENT',
      'DRAWING_ANNOTATION',
    ]);
    const objects = this.objectsAt(projectId, target, retrievableTypes)
      .filter((object) => retrievableTypes.has(object.objectType))
      .map((object) => ({
        ...object,
        retrievalText: workspaceCompletionText(object),
        retrievalTokens: wordTokens(`${object.searchText} ${workspaceCompletionText(object)}`),
      })).filter((object) => object.retrievalText
        && (object.objectType !== 'VARIABLE' || /[A-Za-z]/.test(object.retrievalText)));
    this.workspaceRetrievalCache.set(target, objects);
    return objects;
  }

  /**
   * Which retrievable objects each word appears in, and what scoring reads of
   * each object besides its words, kept with the list. Every object is scored
   * for a sentence, so this is what keeps a keystroke from reading them all.
   */
  retrievalIndexOf(objects) {
    let index = this.retrievalIndexes.get(objects);
    if (index) return index;
    const places = new Map();
    const features = objects.map((object, position) => {
      for (const token of object.retrievalTokens) {
        if (!places.has(token)) places.set(token, []);
        places.get(token).push(position);
      }
      return {
        resultType: ['VARIABLE', 'RESULT', 'VALUE', 'DATASET_ROW', 'DATASET_VALUE', 'DATASET', 'TABLE'].includes(object.objectType),
        methodType: ['METHOD', 'MODEL', 'PARAMETER', 'PROTOCOL', 'ANALYSIS_RUN'].includes(object.objectType),
        identifier: /^(?:sample|subject|participant|patient)?[_ -]?id$|^(?:group|cohort)$/i.test(object.metadata.variable ?? object.label),
        dataPath: /(^|\/)(?:results?|outputs?|analysis|data|datasets?|tables?)(\/|$)/i.test(object.path),
        priority: dependencyFilePriority({ path: object.path }),
      };
    });
    index = { places, features };
    this.retrievalIndexes.set(objects, index);
    return index;
  }

  /**
   * Sources an `exclude from autocomplete` rule tells the prediction surface to
   * skip. Search is deliberately unaffected: the rule suppresses suggestions,
   * not the index, so an explicitly searched source is still reachable.
   */
  autocompleteFilter(projectId) {
    const prefixes = this.suppressedPathPrefixes?.(projectId) ?? [];
    if (!prefixes.length) return () => true;
    return (object) => !prefixes.some((prefix) => object.path === prefix || object.path.startsWith(`${prefix}/`));
  }

  workspaceSuggestions(projectId, input, cursor, options = {}) {
    const context = writingSourceContext(input.text, cursor, input.section);
    if (!context.projectIntent || context.literatureIntent || cursor !== String(input.text ?? '').length) return [];
    const query = `${context.sentence} ${input.context ?? ''} ${input.section ?? ''}`;
    if (context.sentence.trim().length < 6 || variableTokens(context.sentence).length < 2) return [];
    const resultIntent = /\b(?:data|result|finding|found|show|observe|detect|identify|measure|estimate|increase|decrease|reduction|difference|association|effect|mean|median|fold|significant)\w*\b/i.test(context.sentence)
      || /\b(?:results?|findings?|outcomes?)\b/i.test(input.section);
    const sampleSizeIntent = /\b(?:sample|cohort|participant|subject|patient|observation|row|record|included|enrolled|size|count|how many|n\s*=)\w*\b/i.test(context.sentence);
    const methodIntent = /\b(?:method|protocol|procedure|experiment|model|parameter|dose|assay|analysis|analy[sz]ed|using)\w*\b/i.test(context.sentence)
      || /\bmethods?\b/i.test(input.section);
    const permitted = this.autocompleteFilter(projectId);
    const retrievable = this.workspaceRetrievalObjects(projectId, options.snapshotId);
    const { places, features } = this.retrievalIndexOf(retrievable);
    // How many of the sentence's words each object has, as overlapScore counts them.
    const queryWords = wordTokens(query);
    const shared = new Uint16Array(retrievable.length);
    for (const word of queryWords) for (const position of places.get(word) ?? []) shared[position] += 1;
    const reasons = ['contextual workspace match', resultIntent ? 'study-data context' : methodIntent ? 'methods context' : 'project context'];
    // Ranking keeps only objects that reach its minimum, so the rest are not sorted for it.
    const minimumScore = options.minimumScore ?? 0.54;
    const scored = [];
    retrievable.forEach((object, position) => {
      if (input.documentPath && object.path === input.documentPath) return;
      if (!permitted(object)) return;
      const { resultType, methodType, identifier, dataPath, priority } = features[position];
      const overlap = queryWords.length ? shared[position] / Math.max(2, queryWords.length) : 0;
      let score = 0.18 + overlap * 0.52;
      if (resultIntent && resultType) score += object.objectType === 'RESULT' ? 0.32 : object.objectType === 'VARIABLE' ? 0.28 : 0.16;
      if (methodIntent && methodType) score += 0.36;
      if (!resultIntent && !methodIntent && object.objectType === 'VARIABLE') score += 0.2;
      if (object.metadata.dictionary) score += 0.08;
      if (object.objectType === 'VARIABLE') {
        if (object.metadata.range) score += 0.08;
        else if (object.metadata.samples?.length) score += 0.035;
        else if (!object.metadata.dictionary) score -= 0.06;
      }
      if (dataPath) score += 0.06;
      if (object.metadata.metric === 'row-count' && !sampleSizeIntent) score -= 0.32;
      if (identifier) score *= 0.38;
      score = Number(Math.min(0.98, score).toFixed(3));
      // The reasons go with the object into ranking, which then has no fallback score to work out.
      if (score >= 0.34 && score >= minimumScore) scored.push({ object: { ...object, score, reasons }, priority });
    });
    const objects = scored.sort((left, right) => right.object.score - left.object.score
        || Number(right.object.objectType === 'RESULT') - Number(left.object.objectType === 'RESULT')
        || Number(right.object.objectType === 'VARIABLE') - Number(left.object.objectType === 'VARIABLE')
        || right.priority - left.priority
        || left.object.retrievalText.localeCompare(right.object.retrievalText))
      .map(({ object }) => object);
    const seen = new Set();
    const suggestions = [];
    for (const object of this.ranking.rank(projectId, objects, {
      query, documentPath: input.documentPath, relatedPaths: this.relatedSourcePaths(projectId, input),
      minimumScore, limit: objects.length,
      diversify: false,
    })) {
      const fingerprint = object.retrievalText.toLowerCase().replace(/\W+/g, ' ').trim();
      if (!fingerprint || seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      const candidate = this.enrichObject(projectId, object);
      suggestions.push({
        id: `${object.id}:workspace:${suggestions.length}`,
        replacementText: object.retrievalText,
        category: workspaceSuggestionCategory(object),
        ...contextualCompletionRange(input.text, cursor, object.retrievalText),
        confidence: object.score,
        dependencyCandidate: candidate,
        generated: false,
      });
    }
    return this.rankCompletions(projectId, suggestions, input, { query, limit: options.limit ?? 8 });
  }

  candidatesForClaim(projectId, claim, options = {}) {
    const claimTokens = `${claim.text} ${options.context ?? ''} ${options.section ?? ''}`;
    const claimWords = wordTokens(claimTokens);
    const claimNumber = measurementDescriptor(claim.value);
    const expectedVariable = claim.variable ? normalizedVariable(claim.variable) : null;
    const expectedVariableWords = wordTokens(humanVariable(claim.variable));
    const referenceQuery = claim.type === 'LITERATURE' ? (claim.partial ? claim.value : citedAuthor(claim.text)) : '';
    const referenceYear = String(referenceQuery ?? '').match(/\b((?:19|20)\d{2}[a-z]?)\b/i)?.[1]?.toLowerCase() ?? '';
    const claimAuthor = claim.type === 'LITERATURE'
      ? (citedAuthor(claim.text) || (claim.partial ? claim.value : '')) : '';
    const documentReference = claim.type === 'LITERATURE'
      && /^(?:document|report|file|note|memo|proposal|manuscript|protocol|spreadsheet|workbook|presentation|slides?)$/i.test(claim.referenceKind ?? '');
    const typePreference = claim.type === 'LITERATURE'
      ? new Set(documentReference ? ['REFERENCE', 'PAPER', 'DOCUMENT'] : ['REFERENCE', 'PAPER']) : ({
      QUANTITATIVE: new Set(['RESULT', 'VALUE', 'DATASET_VALUE', 'TABLE', 'PARAMETER', 'VARIABLE', 'DRAWING_ANNOTATION']),
      SAMPLE_SIZE: new Set(['RESULT', 'VALUE', 'DATASET', 'DATASET_VALUE', 'TABLE', 'VARIABLE']),
      // An entity phrase can name a whole spreadsheet row. Keep that semantic
      // object in the result set instead of forcing retrieval down to one of
      // its numeric cells; value claims will still select DATASET_VALUE.
      ENTITY: new Set(['RESULT', 'VALUE', 'DATASET_ROW', 'DATASET_VALUE', 'FIGURE', 'MODEL', 'VARIABLE', 'DRAWING_ANNOTATION']),
      DATASET_REFERENCE: new Set(['DATASET', 'ANALYSIS_RUN']),
      FIGURE: new Set(['FIGURE']), TABLE_REFERENCE: new Set(['TABLE']),
      METHOD: new Set(['METHOD', 'MODEL', 'CODE', 'CODE_BLOCK', 'CODE_LINE', 'NOTEBOOK_CELL', 'PROTOCOL']),
    }[claim.type] ?? new Set());
    const permitted = this.autocompleteFilter(projectId);
    const objects = this.objectsAt(projectId, options.snapshotId, typePreference)
      .filter((object) => (!options.documentPath || object.path !== options.documentPath)
        && (!options.sourcePath || object.path === options.sourcePath)
        && (!typePreference.size || typePreference.has(object.objectType))
        && (options.sourcePath ? true : permitted(object)));
    const variableDefinitions = new Map(objects
      .filter((object) => object.objectType === 'VARIABLE' && object.metadata.dictionary)
      .map((object) => [normalizedVariable(object.metadata.variable), object]));
    const variableProfiles = new Map(objects
      .filter((object) => object.objectType === 'VARIABLE' && !object.metadata.dictionary)
      .map((object) => [normalizedVariable(object.metadata.variable), object]));
    const provenancePaths = new Set(this.db.prepare(`
      SELECT from_path AS path FROM provenance_links WHERE project_id = ?
      UNION SELECT to_path AS path FROM provenance_links WHERE project_id = ? AND to_path IS NOT NULL
    `).all(projectId, projectId).map((row) => row.path));
    const ranked = objects.map((object) => {
      const features = objectMatchingFeatures(object);
      const value = valueMatch(claim, object, claimNumber, features.numeric);
      const entity = Math.max(
        tokenOverlap(claimWords, features.words),
        claim.type === 'ENTITY' ? prefixTokenScore(claim.value ?? claim.text, object.searchText) : 0,
      );
      const directVariable = variableSimilarity(expectedVariable, expectedVariableWords, features);
      const definition = features.definitionKeys.map((key) => variableDefinitions.get(key) ?? variableProfiles.get(key)).find(Boolean);
      const dictionaryVariable = definition
        ? variableSimilarity(expectedVariable, expectedVariableWords, objectMatchingFeatures(definition)) : 0;
      const variable = Math.max(directVariable, dictionaryVariable);
      const type = typePreference.has(object.objectType) ? 1 : 0;
      const author = claim.type === 'LITERATURE' ? authorSimilarity(claimAuthor, object.metadata.author) : 0;
      const titleReference = claim.type === 'LITERATURE' ? referenceTitleSimilarity(referenceQuery, object) : 0;
      const broadReference = claim.type === 'LITERATURE' ? referenceSimilarity(referenceQuery, object) : 0;
      const reference = claim.type !== 'LITERATURE' ? 0
        : claim.referenceMode === 'author' ? author
          : claim.referenceMode === 'title' ? titleReference
            : Math.max(author, titleReference, broadReference);
      const component = ['TABLE_REFERENCE', 'FIGURE'].includes(claim.type)
        ? referenceSimilarity(claim.value ?? claim.text, object) : 0;
      const publicationYear = claim.type === 'LITERATURE' && object.metadata.year
        && String(claim.text).includes(String(object.metadata.year)) ? 1 : 0;
      const graph = provenancePaths.has(object.path) ? 1 : 0;
      let score = Math.min(1, value.score * 0.56 + entity * 0.2 + variable * 0.48 + author * 0.16
        + reference * 0.5 + component * 0.62 + publicationYear * 0.1 + type * 0.09 + graph * 0.03);
      // When the writer is naming an entity, prefer its indexed row over a
      // child cell that happens to repeat the row label. This is schema-driven
      // and applies to every workbook/table, not to any particular row name.
      if (claim.type === 'ENTITY' && object.objectType === 'DATASET_ROW' && entity >= 0.68) {
        score = Math.min(1, score + 0.18);
      }
      const candidateVariable = object.metadata.variable ?? object.metadata.column;
      if (claim.variable && candidateVariable && variable < 0.2) score *= 0.42;
      const reasons = [];
      if (value.score >= 0.8) reasons.push('matching value');
      if (author === 1) reasons.push('matching author');
      else if (author) reasons.push('similar author');
      if (publicationYear) reasons.push('matching publication year');
      if (claim.referenceMode === 'title' && titleReference >= 0.68) reasons.push('matching title');
      else if (claim.referenceMode === 'author' && author >= 0.7 && !reasons.some((reason) => reason.includes('author'))) reasons.push('matching author');
      else if (reference >= 0.9) reasons.push('matching reference prefix');
      else if (reference >= 0.68) reasons.push('similar reference metadata');
      if (component >= 0.9) reasons.push(`matching ${claim.type === 'TABLE_REFERENCE' ? 'table' : 'figure'} identifier`);
      else if (component >= 0.68) reasons.push(`similar ${claim.type === 'TABLE_REFERENCE' ? 'table' : 'figure'} reference`);
      if (variable >= 0.7) reasons.push(object.metadata.dictionary || (definition?.metadata.dictionary && dictionaryVariable >= 0.7)
        ? 'matching data dictionary definition' : 'matching study variable');
      else if (variable > 0) reasons.push('similar study variable');
      if (entity > 0) reasons.push('matching entity');
      if (type) reasons.push(`matching ${object.objectType.toLowerCase()} type`);
      if (graph) reasons.push('connected provenance');
      return {
        ...object,
        displayValue: value.displayValue ?? (numericDescriptor(object.valueText) ? object.valueText : null),
        // A bibliography holds several independently citable works.
        diversityKey: object.objectType === 'REFERENCE' ? object.id : object.path,
        score: Number(score.toFixed(3)),
        reasons,
        matchStrength: Math.max(value.score, entity, variable, reference, component),
        matchTier: (value.score >= 0.8 && (!claim.variable || variable >= 0.7))
          || reference >= 0.9 || author === 1 || component >= 0.9
          || variable >= 0.9 || (['ENTITY', 'METHOD'].includes(claim.type) && entity >= 0.9) ? 0 : 1,
        authorSimilarity: Number(author.toFixed(3)),
        referenceSimilarity: Number(reference.toFixed(3)),
        titleSimilarity: Number(titleReference.toFixed(3)),
        componentSimilarity: Number(component.toFixed(3)),
        referenceRole: claim.referenceMode === 'author' || claim.referenceMode === 'title'
          ? claim.referenceMode : author >= 0.7 && author >= titleReference ? 'author' : 'title',
        variableDefinition: definition ? {
          variable: definition.metadata.variable,
          description: definition.metadata.description ?? definition.metadata.inferredMeaning ?? definition.valueText,
          units: definition.metadata.units ?? null,
          path: definition.path,
          inferred: !definition.metadata.dictionary,
        } : object.metadata.dictionary ? {
          variable: object.metadata.variable,
          description: object.metadata.description ?? object.valueText,
          units: object.metadata.units ?? null,
          path: object.path,
        } : null,
      };
    }).filter((object) => object.score >= (options.minimumScore ?? (claim.type === 'LITERATURE' ? 0.08 : 0.2))
      && (object.matchTier === 0 || object.matchStrength >= (options.minimumMatchStrength ?? 0))
      && (!referenceQuery || object.referenceSimilarity >= 0.68 || object.authorSimilarity >= 0.7)
      && (!referenceYear || !object.metadata.year || String(object.metadata.year).toLowerCase() === referenceYear))
      .sort((a, b) => b.score - a.score
        || (Number.parseInt(b.metadata.year, 10) || 0) - (Number.parseInt(a.metadata.year, 10) || 0)
        || b.snapshotVersion - a.snapshotVersion || a.label.localeCompare(b.label));
    return this.ranking.rank(projectId, ranked, {
      query: claimTokens, documentPath: options.documentPath, relatedPaths: options.relatedPaths,
      limit: options.limit ?? 8, diversify: !options.sourcePath,
    }).map((object) => this.enrichObject(projectId, object));
  }

  relatedSourcePaths(projectId, input) {
    const objectIds = (Array.isArray(input.pendingDependencies) ? input.pendingDependencies.slice(0, 50) : [])
      .map((item) => item.sourceObjectId).filter((value) => typeof value === 'string');
    if (!objectIds.length) return [];
    const project = this.timeline.getProject(projectId);
    this.ensureIndex(projectId, project.currentSnapshotId);
    const current = this.timeline.objectVersions.resolved(project.currentSnapshotId).byObject;
    return [...new Set(objectIds.map((objectId) => current.get(objectId))
      .filter((row) => row?.project_id === projectId).map((row) => row.path))];
  }

  rankCompletions(projectId, completions, input, options = {}) {
    const sourceProjectId = completions.length
      ? this.sourceProjectId(completions[0].dependencyCandidate ?? {}) : null;
    const rankingProjectId = sourceProjectId ?? projectId;
    return this.ranking.rank(rankingProjectId, completions.map((completion) => ({
      ...completion.dependencyCandidate,
      score: completion.confidence ?? completion.dependencyCandidate?.score ?? 0,
      completion,
    })), {
      query: input.text, documentPath: rankingProjectId === projectId ? input.documentPath : null,
      relatedPaths: this.relatedSourcePaths(rankingProjectId, input), ...options,
    }).map(({ completion, ranking }) => ({
      ...completion,
      dependencyCandidate: { ...completion.dependencyCandidate, ranking },
    }));
  }

  sentenceSuggestion(projectId, input) {
    const permitted = this.autocompleteFilter(projectId);
    return completeSentence(this.completionCorpus(projectId), input, {
      include: permitted,
      rank: (completions) => this.rankCompletions(projectId, completions.filter((item) => item.dependencyCandidate?.id).map((item) => ({
        ...item,
        dependencyCandidate: {
          ...item.dependencyCandidate,
          matchTier: item.matchKind === 'PREFIX' ? 0 : 1,
        },
      })), input, { limit: 1, diversify: false, minimumScore: 0.54 }),
    });
  }

  linkedDependencyContext(projectId, input, cursor) {
    const sourceScopeBoundary = Number.isInteger(input.sourceScopeBoundary) ? input.sourceScopeBoundary : -1;
    // A caller editing a project document identifies itself by path and block.
    // A caller writing in another application has neither, and supplies its
    // recently linked sources directly instead.
    const blockIndex = Number.isInteger(input.blockIndex) ? input.blockIndex : 0;
    const hasPending = Array.isArray(input.pendingDependencies) && input.pendingDependencies.length > 0;
    if (!input.documentPath && !hasPending) return null;

    const persisted = this.savedBlockLinks(projectId, input)
      .filter((item) => item.anchor.end <= cursor && item.anchor.end > sourceScopeBoundary
        && !['BROKEN', 'NEEDS_REVIEW'].includes(item.status));
    const pending = (Array.isArray(input.pendingDependencies) ? input.pendingDependencies.slice(0, 50) : [])
      .filter((item) => (Number.isInteger(item.blockIndex) ? item.blockIndex : 0) === blockIndex
        && Number.isInteger(item.end)
        && item.end <= cursor && item.end > sourceScopeBoundary && item.sourceObjectId && item.sourceSnapshotId)
      .map((item) => {
        const row = this.sourceVersion(item.sourceObjectId, item.sourceSnapshotId);
        if (!row || (this.workspace && !this.workspace.isActive(row.project_id))) return null;
        const source = mapObjectRow(row);
        return {
          id: item.id ?? `pending:${item.sourceObjectId}`,
          anchor: {
            blockIndex: Number.isInteger(item.blockIndex) ? item.blockIndex : 0,
            start: item.start,
            end: item.end,
          },
          source,
          status: 'PENDING',
          focused: item.focused === true,
          // A focus chosen on typed words ("brac") is replaced by its values.
          replacesText: item.focused === true && item.replacesText === true,
        };
      }).filter(Boolean);
    const dependency = [...persisted, ...pending]
      .filter((item) => !this.workspace || this.workspace.isActive(this.sourceProjectId(item.source)))
      .sort((left, right) => right.anchor.end - left.anchor.end)[0] ?? null;
    if (!dependency || cursor - dependency.anchor.end > 420) return null;
    return dependency;
  }

  /** Links saved in the project document block being edited; none for other callers. */
  savedBlockLinks(projectId, input) {
    if (!input.documentPath || !Number.isInteger(input.blockIndex)) return [];
    const project = this.timeline.getProject(projectId);
    const file = this.timeline.snapshotFile(project.currentSnapshotId, input.documentPath);
    if (!file) return [];
    return this.currentDependencies(projectId, { projectFileId: file.projectFileId })
      .filter((item) => item.anchor.blockIndex === input.blockIndex);
  }

  /**
   * The values inserted with Tab in the sentence being written, by object id,
   * each with the text it was inserted as. A list such as "2026-08-18,
   * 2026-09-12, " goes on with the values not yet written. Every accepted
   * link counts, not only the newest that scopes the suggestions.
   */
  valuesWrittenInSentence(projectId, input, cursor) {
    const text = String(input.text ?? '');
    const { sentenceStart } = writingSourceContext(text, cursor);
    const accepted = Array.isArray(input.acceptedDependencies) ? input.acceptedDependencies : input.pendingDependencies;
    const spans = [
      ...(Array.isArray(accepted) ? accepted.slice(0, 50) : [])
        .map((item) => ({ id: item?.sourceObjectId, start: item?.start, end: item?.end })),
      ...this.savedBlockLinks(projectId, input)
        .map((item) => ({ id: item.source?.id, start: item.anchor.start, end: item.anchor.end })),
    ];
    const written = new Map();
    for (const { id, start, end } of spans) {
      if (typeof id !== 'string' || !Number.isInteger(start) || !Number.isInteger(end)
        || start < sentenceStart || end > cursor || start >= end) continue;
      if (!written.has(id)) written.set(id, new Set());
      written.get(id).add(text.slice(start, end).trim().toLowerCase());
    }
    return written;
  }

  /**
   * Where the newest accepted source was settled by its own value, or -1. A
   * value is as deep as a source goes: every directory answers the words
   * after it, and nothing is offered again for the text it fills.
   */
  settledValueEnd(input, dependency) {
    if (Number.isInteger(input.settledValueEnd)) return input.settledValueEnd;
    // A record's field just written ("on Tuesday, October 27") leads on to its
    // other fields when the next words ask for one ("at").
    if (dependency?.source.metadata?.componentType === 'RECORD_FIELD'
      && fieldCue(String(input.text ?? '').slice(dependency.anchor.end, input.cursor))) return -1;
    // Code lines just written lead on to more of their file ("and lines 50-52").
    const text = String(input.text ?? '');
    if (isCodeLineReference(dependency?.source)
      && lineMentionAtEnd(text, dependency.anchor.end, Number.isInteger(input.cursor) ? input.cursor : text.length)) return -1;
    // An explicit comma continues a table column's value list. Ordinary words
    // after a completed value still return to every directory.
    const tail = dependency && String(input.text ?? '').slice(dependency.anchor.end, input.cursor);
    if (dependency?.source.anchor?.kind === 'table-cell' && /^\s*,\s*$/.test(tail)) return -1;
    return dependency && acceptedAsValue(dependency, input.text) ? dependency.anchor.end : -1;
  }

  /**
   * An accepted data source describes the rest of its own sentence ("Revenue
   * was ..."). A new sentence, or another source named after a joining word
   * ("Revenue and gross pr"), is a new subject and gets its own suggestions.
   * Papers are exempt: "They found that ..." in a later sentence still cites them.
   */
  projectLinkInScope(projectId, input, cursor, dependency) {
    if (!dependency || ['PAPER', 'REFERENCE'].includes(dependency.source.objectType)) return true;
    const tail = String(input.text ?? '').slice(dependency.anchor.end, cursor);
    if (endsSentence(tail)) return false;
    return !this.namesSubjectAfterJoiner(projectId, input, cursor, dependency);
  }

  /**
   * Whether this directory names something after the last joining word that
   * follows an accepted data source: a variable or row ("and gross pr") or a
   * drawing or model ("and the brack"). Asked of every directory, since the
   * new subject need not live beside the accepted source.
   */
  namesSubjectAfterJoiner(projectId, input, cursor, dependency) {
    if (['PAPER', 'REFERENCE'].includes(dependency.source.objectType)) return false;
    const tail = String(input.text ?? '').slice(dependency.anchor.end, cursor);
    const joiner = [...tail.matchAll(CLAUSE_JOINER)].at(-1);
    if (!joiner) return false;
    const subjectStart = dependency.anchor.end + joiner.index + joiner[0].length;
    const fresh = this.progressiveStudyVariable(projectId, input, cursor);
    if (fresh?.fragment && fresh.candidates.length && fresh.fragment.start >= subjectStart) return true;
    const file = this.fileReference(projectId, input, cursor);
    return Boolean(file && file.start >= subjectStart);
  }

  /**
   * The record the newest link belongs to: the record itself when its title
   * was linked, or the record of a field just written, so "on Tuesday,
   * October 27 at" goes on to the same event's time.
   */
  linkedRecord(projectId, dependency) {
    const source = dependency?.source;
    if (!source) return null;
    if (source.metadata?.recordFields?.length) return dependency;
    if (source.metadata?.componentType !== 'RECORD_FIELD') return null;
    const record = this.objectsAt(this.sourceProjectId(source) ?? projectId, source.snapshotId, ['DOCUMENT'])
      .find((object) => object.path === source.path && object.metadata.recordFields?.length);
    return record ? { ...dependency, source: record } : null;
  }

  /**
   * A linked record's fields, as the word after it asks for them: "on" its
   * date, "at" its time or place, "with" its people, "from" its sender. What
   * has been typed of a value since narrows them; fields already written in
   * the sentence are not offered again.
   */
  fieldsFromLinkedRecord(projectId, input, cursor, dependency) {
    const linked = this.linkedRecord(projectId, dependency);
    if (!linked) return null;
    const text = String(input.text ?? '');
    const tail = text.slice(linked.anchor.end, cursor);
    const cue = endsSentence(tail) ? null : fieldCue(tail);
    if (!cue) return null;
    const source = linked.source;
    const written = this.valuesWrittenInSentence(projectId, input, cursor);
    const typed = normalizedCompletionPhrase(cue.typed);
    const matchesTyped = (value) => {
      const words = normalizedCompletionPhrase(value).split(' ');
      return !typed || words.some((_, index) => words.slice(index).join(' ').startsWith(typed));
    };
    const candidates = this.objectsAt(this.sourceProjectId(source) ?? projectId, source.snapshotId, ['VALUE'])
      .filter((object) => object.path === source.path && object.metadata.componentType === 'RECORD_FIELD'
        && object.valueText && !written.has(object.id) && matchesTyped(object.valueText))
      .map((object) => {
        const role = cue.roles.indexOf(object.metadata.role);
        const rank = normalizedVariable(object.metadata.field) === cue.word ? 0 : role >= 0 ? role + 1 : Infinity;
        // Fields keep the order the record lists them in.
        return { object, order: object.metadata.lineStart ?? 0, rank };
      });
    if (!candidates.length) return null;
    // The fields the cue names come first, and alone when it names any.
    const named = candidates.filter((candidate) => candidate.rank !== Infinity);
    const offered = (named.length ? named : candidates)
      .sort((left, right) => left.rank - right.rank || left.order - right.order).slice(0, 8);
    const completions = offered.map(({ object }, index) => {
      // Spaced wider than a ranking band, so the order chosen here holds.
      const confidence = Number(Math.max(0.3, 0.95 - index * 0.1).toFixed(3));
      return {
        id: `${object.id}:field:${index}`,
        replacementText: object.valueText,
        category: object.metadata.field,
        provenanceLabel: `${source.label} · ${object.metadata.field}`,
        ...contextualCompletionRange(text, cursor, object.valueText, { floor: linked.anchor.end }),
        confidence,
        dependencyCandidate: this.enrichObject(projectId, {
          ...object, score: confidence,
          reasons: [cue.word && !OPEN_FIELD_CUES.has(cue.word) ? `${object.metadata.field}, after “${cue.word}”` : 'field of the linked record'],
        }),
        generated: false,
      };
    });
    return { dependencyId: linked.id, source, variable: source.label, heading: source.label, completions };
  }

  /**
   * The code file and lines the writer names: after a code file they
   * accepted ("server.js line 42", "lines 10 through 20"), just before it
   * ("line 42 of server.js"), after one of its lines ("and line 50"), or
   * after its name written out ("app.py lines 3-9").
   */
  namedCodeLines(projectId, input, cursor, dependency) {
    const text = String(input.text ?? '');
    if (dependency && isCodePath(dependency.source.path)) {
      const after = lineMentionAtEnd(text, dependency.anchor.end, cursor);
      const before = !after && /^\s*:?\s*$/.test(text.slice(dependency.anchor.end, cursor))
        ? lineMentionBeforeName(text, dependency.anchor.start) : null;
      const mention = after ?? before;
      return mention ? { ...mention, path: dependency.source.path, dependency,
        ownerId: this.sourceProjectId(dependency.source) ?? projectId } : null;
    }
    const mention = lineMentionAtEnd(text, 0, cursor);
    const written = mention && fileNameBefore(text, mention.start);
    if (!written) return null;
    const name = written.name.toLowerCase();
    const file = this.objectsAt(projectId, null, ['CODE_BLOCK', 'MODEL'])
      .filter((object) => object.metadata.codeFile && object.path !== input.documentPath)
      .map((object) => object.path)
      .filter((filePath) => filePath.toLowerCase() === name || filePath.toLowerCase().endsWith(`/${name}`))
      .sort((left, right) => left.length - right.length || left.localeCompare(right))[0];
    return file ? { ...mention, path: file, dependency: null, ownerId: projectId } : null;
  }

  /**
   * The lines named while writing, as one suggestion whose Tab inserts their
   * code after the words that named them: one line without its indentation,
   * or the lines on lines of their own.
   */
  linesFromCode(projectId, input, cursor, dependency) {
    const named = this.namedCodeLines(projectId, input, cursor, dependency);
    if (!named) return null;
    const { first, last, ownerId } = named;
    const snapshotId = this.timeline.getProject(ownerId).currentSnapshotId;
    const file = this.timeline.snapshotFile(snapshotId, named.path);
    if (!file || !isCodeType(file.fileType)) return null;
    const fileName = path.posix.basename(file.path);
    const sourceObject = named.dependency?.source ?? this.objectsAt(ownerId, snapshotId, ['CODE_BLOCK', 'MODEL'])
      .find((object) => object.path === file.path && object.metadata.codeFile) ?? null;
    const result = (completions, notice = null) => ({ dependencyId: named.dependency?.id ?? null,
      source: sourceObject ?? completions[0]?.dependencyCandidate ?? null, completions, notice,
      heading: `${linesLabel(first, last ?? first)} of ${fileName}` });
    // "lines 10 through" or "lines 10 through 2" is still being typed: nothing yet, and nothing else either.
    if (named.pending || last < first) return sourceObject ? result([]) : null;
    const lines = fileLines(this.timeline.blobs.get(file.contentHash)?.toString('utf8') ?? '');
    if (last > lines.length) {
      return sourceObject ? result([], `${fileName} has ${lines.length} line${lines.length === 1 ? '' : 's'}.`) : null;
    }
    if (last - first + 1 > MAX_CODE_LINES) {
      return sourceObject ? result([], `Tab inserts up to ${MAX_CODE_LINES} lines at once.`) : null;
    }
    const descriptor = codeLinesDescriptor(file, lines, first, last);
    if (!descriptor) {
      return sourceObject ? result([], `${linesLabel(first, last)} of ${fileName} ${first === last ? 'is' : 'are'} blank.`) : null;
    }
    this.ensureIndex(ownerId, snapshotId);
    const [object] = this.indexedObjects(ownerId, snapshotId, { keyPrefix: `${file.projectFileId}:${CODE_LINES_KEY}` }, [descriptor]);
    if (!object) return null;
    const code = object.valueText;
    const block = first !== last;
    const firstLine = code.split('\n').find((line) => line.trim()) ?? code;
    return result([{
      id: `${object.id}:lines`,
      replacementText: block ? codeOnOwnLines(code, String(input.text ?? '').slice(0, cursor)) : code,
      // Typed key by key, code would meet the host's auto-indent, closing brackets and smart quotes.
      verbatim: true,
      label: block ? `${firstLine.trim()} \u2026` : code,
      detail: block ? `${last - first + 1} lines` : '',
      category: 'Code',
      provenanceLabel: `${fileName} · ${object.label}`,
      claimStart: cursor, claimEnd: cursor,
      confidence: 0.99,
      dependencyCandidate: this.enrichObject(ownerId, { ...object, score: 0.99, matchTier: 0,
        reasons: [`${object.label} of ${fileName}`] }),
      generated: false,
    }]);
  }

  linkedPaperContext(projectId, input, cursor) {
    const dependency = this.linkedDependencyContext(projectId, input, cursor);
    return dependency && ['PAPER', 'REFERENCE'].includes(dependency.source.objectType) ? dependency : null;
  }

  findingsFromLinkedPaper(projectId, input, cursor, dependency = this.linkedPaperContext(projectId, input, cursor)) {
    if (dependency && !['PAPER', 'REFERENCE'].includes(dependency.source.objectType)) return null;
    if (!dependency) return null;
    const fragment = sourceFindingFragment(input.text, cursor, dependency.anchor.end);
    if (!fragment) return null;
    const source = dependency.source;
    const sourceText = /\.pdf$/i.test(source.path) ? this.sourceText(source).replace(/\s*\n\s*/g, ' ') : this.sourceText(source);
    const corpus = buildSentenceCorpus([{
      text: sourceText,
      path: source.path,
      snapshotId: source.snapshotId,
      dependencyCandidate: source,
    }]);
    const passages = this.objectsAt(this.sourceProjectId(source) ?? projectId, source.snapshotId, ['DOCUMENT'])
      .filter(object => object.path === source.path && isPassageExcerpt(object) && object.metadata.excerptType === 'sentence');
    // Markdown sentences are compared without their inline markers.
    const comparable = value => String(value ?? '').toLowerCase().replace(/[\W_]+/g, ' ').trim();
    const completions = completeFromLinkedSource(corpus, input, source, {
      sourceEnd: dependency.anchor.end, limit: 12,
    }).map(completion => {
      const passage = passages.find(object => object.metadata.rawText === completion.sourceSentence)
        ?? passages.find(object => object.metadata.componentType === 'TEXT_EXCERPT'
          && comparable(object.metadata.rawText) === comparable(completion.sourceSentence));
      return passage ? { ...completion, dependencyCandidate: { ...passage,
        score: completion.confidence, reasons: completion.dependencyCandidate.reasons } } : completion;
    });
    return {
      dependencyId: dependency.id,
      source,
      fragment,
      completions,
    };
  }

  /**
   * Whether fn+Right on this suggestion has something narrower to show: a
   * part's measurements, a named row's cells or a column's values. A value is
   * as narrow as a suggestion gets, so fn+Right stops there.
   */
  narrowsTo(projectId, object) {
    if (!VALUE_HOLDERS.has(object?.objectType) || !object.snapshotId) return false;
    const objects = this.workspaceRetrievalObjects(this.sourceProjectId(object) ?? projectId, object.snapshotId);
    if (!this.narrowingCache.has(objects)) this.narrowingCache.set(objects, new Map());
    const known = this.narrowingCache.get(objects);
    if (!known.has(object.id)) {
      const focus = { id: `narrowing:${object.id}`, anchor: { blockIndex: 0, start: 0, end: 0 }, source: object };
      const values = this.valuesFromLinkedProjectObject(projectId, { text: '' }, 0, focus);
      known.set(object.id, Boolean(values?.completions.some((value) => value.dependencyCandidate?.id !== object.id)));
    }
    return known.get(object.id);
  }

  valuesFromLinkedProjectObject(projectId, input, cursor, dependency) {
    if (!dependency || ['PAPER', 'REFERENCE'].includes(dependency.source.objectType)) return null;
    const source = dependency.source;
    const sourceRow = String(source.anchor?.rowKey ?? source.metadata.row ?? '').trim();
    // A named row (a department or supplier, keyed by a name column) has no
    // variable of its own; its cells are its fields, so it stands in for one.
    const namedRow = source.objectType === 'DATASET_ROW' && !source.metadata.variable && !source.metadata.column;
    // A whole drawing or CAD part ("Bracket") is the same: its measurements are its values.
    const wholeDrawing = source.objectType === 'DRAWING';
    const variable = String(source.metadata.variable ?? source.metadata.column
      ?? (source.objectType === 'VARIABLE' || wholeDrawing ? source.label : namedRow ? sourceRow || source.label : '')).trim();
    if (!variable) return null;
    const variableKey = normalizedVariable(variable);
    const tail = String(input.text ?? '').slice(dependency.anchor.end, cursor);
    const changeIntent = /\b(?:increas|decreas|reduc|higher|lower|rais|rise|drop|declin|change|difference|effect)\w*\b/i.test(tail);
    const sourceColumn = String(source.anchor?.column ?? source.metadata.column ?? '').trim();
    const dependencyText = String(input.text ?? '').slice(dependency.anchor.start, dependency.anchor.end);
    const dependencySelectsRow = !source.metadata.sectionRow && sourceRow && normalizedRowSearch(dependencyText) === normalizedRowSearch(sourceRow);
    const dependencySelectsColumn = source.anchor?.kind === 'table-cell' && sourceColumn
      && normalizedVariable(dependencyText) === normalizedVariable(sourceColumn);
    // A measurement accepted by its name ("Bracket Ø8 hole diameter") still
    // has its own value to state, unless that value is the linked text.
    const dependencyNamesMeasurement = source.objectType === 'DRAWING_ANNOTATION'
      && normalizedVariable(dependencyText) !== normalizedVariable(source.valueText);
    const retrieved = this.workspaceRetrievalObjects(this.sourceProjectId(source) ?? projectId, source.snapshotId);
    // A large table's later rows come from the table index, as few as the words typed name.
    const indexedRelated = wholeDrawing ? [] : this.indexedRelatedObjects(projectId, source, tail,
      { variableKey, known: this.keysOf(retrieved) });
    const workspaceObjects = indexedRelated.length ? [...retrieved, ...indexedRelated] : retrieved;
    // A data dictionary's cells describe the variable (its description and
    // units); they are not values of it, unless that file is the linked source.
    // Keyed by sheet: a workbook's data sheets beside its dictionary still count.
    const tableKey = (object) => `${object.path}\u0000${object.metadata.sheet ?? object.anchor?.sheet ?? ''}`;
    const dictionaryTables = new Set(workspaceObjects
      .filter((object) => object.objectType === 'VARIABLE' && object.metadata.dictionary
        && object.anchor?.kind === 'table-cell')
      .map(tableKey));
    const describesVariable = (object) => dictionaryTables.has(tableKey(object))
      && (source.objectType === 'VARIABLE' || tableKey(object) !== tableKey(source));
    const relatesToSource = wholeDrawing
      ? (object) => object.objectType === 'DRAWING_ANNOTATION' && object.path === source.path
        && (object.anchor?.pageNumber ?? null) === (source.anchor?.pageNumber ?? null)
      : namedRow
        ? (object) => tableKey(object) === tableKey(source)
          && normalizedRowSearch(object.anchor?.rowKey ?? object.metadata.row) === normalizedRowSearch(sourceRow)
        : (object) => normalizedVariable(object.metadata.variable ?? object.metadata.column) === variableKey
          || (source.metadata.sectionRow && normalizedVariable(object.metadata.section) === variableKey)
          // A table keyed by row names stores each cell under its row ("Revenue"); its column names the source.
          || (source.anchor?.kind === 'table-column' && normalizedVariable(object.metadata.column) === variableKey);
    const allRelatedObjects = workspaceObjects
      .filter((object) => !describesVariable(object))
      .filter((object) => (object.id !== source.id || dependencySelectsRow || dependencySelectsColumn
        || dependencyNamesMeasurement) && object.objectType !== 'VARIABLE' && relatesToSource(object));
    // A model with nothing measured (a native CAD file) leaves the sentence to other suggestions.
    if (wholeDrawing && !allRelatedObjects.length) return null;
    const sameSourceObjects = source.objectType === 'VARIABLE' ? [] : allRelatedObjects
      .filter((object) => object.path === source.path
        && String(object.metadata.sheet ?? '') === String(source.metadata.sheet ?? ''));
    const relatedObjects = sameSourceObjects.length ? sameSourceObjects : allRelatedObjects;
    const requestedRows = rowReferencesInText(tail,
      relatedObjects.map((object) => object.anchor?.rowKey ?? object.metadata.row));
    const fragments = requestedRows.size || dependencySelectsRow ? [] : rowCompletionFragments(tail);
    const rows = new Map();
    for (const object of relatedObjects) {
      const rowKey = String(object.anchor?.rowKey ?? object.metadata.row ?? '').trim();
      if (!rowKey || /^row:\d+$/i.test(rowKey)) continue;
      let bestFragment = null;
      let bestScore = 0;
      for (const fragment of fragments) {
        const score = rowCompletionScore(fragment, rowKey);
        if (score > bestScore) { bestFragment = fragment; bestScore = score; }
      }
      if (!bestFragment || bestScore < 0.68) continue;
      const key = normalizedRowSearch(rowKey);
      const representativeScore = Number(object.path === source.path) * 2
        + Number((object.metadata.sheet ?? null) === (source.metadata.sheet ?? null))
        + Number(!missingMeasurement(object.valueText)) * 0.1;
      const previous = rows.get(key);
      if (!previous || bestScore > previous.matchScore
        || (bestScore === previous.matchScore && representativeScore > previous.representativeScore)) {
        rows.set(key, { object, rowKey, fragment: bestFragment, matchScore: bestScore, representativeScore });
      }
    }
    const rowSuggestions = [...rows.values()]
      .sort((left, right) => right.matchScore - left.matchScore
        || right.representativeScore - left.representativeScore
        || left.rowKey.localeCompare(right.rowKey, undefined, { numeric: true, sensitivity: 'base' }))
      .slice(0, 8).map(({ object, rowKey, fragment, matchScore }, index) => {
        return {
          id: `${object.id}:row:${index}`,
          replacementText: rowKey,
          category: 'Row',
          provenanceLabel: [object.metadata.sheet, variable].filter(Boolean).join(' · '),
          claimStart: dependency.anchor.end + fragment.start,
          claimEnd: dependency.anchor.end + fragment.end,
          confidence: Number(Math.min(0.99, matchScore).toFixed(3)),
          dependencyCandidate: this.enrichObject(projectId, {
            ...object,
            score: Number(Math.min(0.99, matchScore).toFixed(3)),
            reasons: ['matching row identifier', 'same linked variable'],
          }),
          generated: false,
        };
      });
    if (rowSuggestions.length) {
      return {
        dependencyId: dependency.id,
        source,
        variable,
        changeIntent,
        requestedRows: [],
        heading: `Rows for ${variable}`,
        completions: rowSuggestions,
        notice: null,
      };
    }

    const fieldOrder = new Map();
    for (const object of relatedObjects) {
      const field = String(object.metadata.column ?? object.anchor?.column ?? '').trim();
      if (!field) continue;
      const columnIndex = Number.isInteger(object.anchor?.columnIndex)
        ? object.anchor.columnIndex : Number.MAX_SAFE_INTEGER;
      fieldOrder.set(field, Math.min(fieldOrder.get(field) ?? Number.MAX_SAFE_INTEGER, columnIndex));
    }
    const fields = [...fieldOrder].sort((left, right) => left[1] - right[1]
      || left[0].localeCompare(right[0])).map(([field]) => field);
    const explicitFields = mentionedFields(tail, fields);
    if (dependencySelectsRow && fields.length > 1 && !explicitFields.size) {
      const fragmentsForFields = fieldCompletionFragments(tail);
      const matchingFields = fields.map((field) => {
        let bestFragment = null;
        let bestScore = 0;
        for (const fragment of fragmentsForFields) {
          const score = fieldCompletionScore(fragment, field);
          if (score > bestScore) { bestFragment = fragment; bestScore = score; }
        }
        return { field, fragment: bestFragment, score: bestScore };
      }).filter((match) => match.score >= 0.76);
      const offerAllFields = !matchingFields.length && fieldNavigationCue(tail);
      if (matchingFields.length || offerAllFields) {
        const selectedFields = (matchingFields.length
          ? matchingFields : fields.map((field) => ({ field, fragment: null, score: 0.72 })))
          .sort((left, right) => right.score - left.score
            || fields.indexOf(left.field) - fields.indexOf(right.field));
        const fieldSuggestions = selectedFields.slice(0, 8).map(({ field, fragment, score }, index) => {
          const object = relatedObjects.find((candidate) => String(candidate.metadata.column ?? candidate.anchor?.column) === field);
          return {
            id: `${object.id}:field:${index}`,
            replacementText: field,
            category: 'Column',
            provenanceLabel: [object.metadata.sheet, sourceRow, field].filter(Boolean).join(' · '),
            claimStart: fragment ? dependency.anchor.end + fragment.start : cursor,
            claimEnd: fragment ? dependency.anchor.end + fragment.end : cursor,
            confidence: Number(Math.min(0.99, score).toFixed(3)),
            dependencyCandidate: this.enrichObject(projectId, {
              ...object,
              score: Number(Math.min(0.99, score).toFixed(3)),
              reasons: ['field in the selected row', fragment ? 'matching field prefix' : 'available field'],
            }),
            generated: false,
          };
        });
        return {
          dependencyId: dependency.id,
          source,
          variable,
          changeIntent,
          requestedRows: [],
          heading: `Columns for ${sourceRow || variable}`,
          completions: fieldSuggestions,
          notice: null,
        };
      }
    }
    const rowMatches = requestedRows.size || dependencySelectsRow ? relatedObjects.filter((object) => {
      const row = canonicalRowReference(object.anchor?.rowKey ?? object.metadata.row);
      if (requestedRows.size) return row && requestedRows.has(row);
      return normalizedRowSearch(object.anchor?.rowKey ?? object.metadata.row) === normalizedRowSearch(sourceRow);
    }) : [];
    let scopedObjects = requestedRows.size || dependencySelectsRow ? rowMatches : relatedObjects;
    if (dependencySelectsColumn) {
      scopedObjects = relatedObjects.filter((object) => object.id === source.id
        || (normalizedRowSearch(object.anchor?.rowKey ?? object.metadata.row) === normalizedRowSearch(sourceRow)
          && normalizedVariable(object.metadata.column ?? object.anchor?.column) === normalizedVariable(sourceColumn)));
    } else if (explicitFields.size) {
      scopedObjects = scopedObjects.filter((object) => explicitFields
        .has(normalizedVariable(object.metadata.column ?? object.anchor?.column)));
    }
    // The first digits of a value ("was 48") pick out the values they begin,
    // and a word of a column's name ("budget") breaks ties between its cells.
    const typedNumber = typedNumberPrefix(tail, requestedRows);
    const written = this.valuesWrittenInSentence(projectId, input, cursor);
    const completesTypedNumber = (text) => Boolean(typedNumber) && comparableNumber(text).startsWith(typedNumber);
    const fieldWordsNamed = (object) => namedFieldWords(tail, object.metadata.column ?? object.anchor?.column);
    const objects = scopedObjects
      .map((object) => {
        const field = humanVariable(object.metadata.column ?? object.metadata.metric ?? object.label);
        const numeric = numericDescriptor(object.valueText);
        const resultPath = /(^|\/)(?:results?|outputs?|analysis)(\/|$)/i.test(object.path);
        const derivedField = /\b(?:fold|change|difference|effect|estimate|ratio|percent|reduction|increase|decrease)\b/.test(field);
        const contextualText = contextualStoredValue(object, tail);
        if (!contextualText || written.get(object.id)?.has(contextualText.toLowerCase())) return null;
        let score = object.objectType === 'RESULT' ? 0.52
          : ['VALUE', 'DATASET_VALUE'].includes(object.objectType) ? 0.28 : 0.18;
        if (object.path === source.path) score += 0.18;
        if (resultPath) score += 0.18;
        if (derivedField) score += 0.2;
        if (numeric) score += 0.08;
        // Drawing measurements weigh a value being typed, with its unit, in measurementRelevance.
        if (object.objectType === 'DRAWING_ANNOTATION') score += measurementRelevance(object, tail);
        else if (completesTypedNumber(contextualText)) score += 0.3;
        if (requestedRows.size || dependencySelectsRow) score += 0.5;
        if (missingMeasurement(object.valueText)) score -= 0.16;
        return { ...object, contextualText, score: Number(Math.min(0.99, score).toFixed(3)) };
      }).filter(Boolean)
      .sort((left, right) => right.score - left.score
        || Number(completesTypedNumber(right.contextualText)) - Number(completesTypedNumber(left.contextualText))
        || fieldWordsNamed(right) - fieldWordsNamed(left)
        || Number(right.objectType === 'RESULT') - Number(left.objectType === 'RESULT')
        || measurementOrder(left) - measurementOrder(right)
        || left.path.localeCompare(right.path)
        || String(left.anchor?.rowKey ?? '').localeCompare(String(right.anchor?.rowKey ?? '')));
    const suggestions = [];
    const seen = new Set();
    for (const object of objects) {
      // The card names a CAD measurement's feature ("Ø8 hole depth"), so equal
      // values of different features stay apart; other equal values show once.
      const feature = object.anchor?.kind === 'cad-property' ? object.label : '';
      const fingerprint = `${object.contextualText.toLowerCase()}|${object.path}|${object.metadata.sheet ?? ''}|${feature}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      suggestions.push({
        id: `${object.id}:value:${suggestions.length}`,
        replacementText: object.contextualText,
        category: object.objectType === 'RESULT' ? 'Result' : 'Value',
        provenanceLabel: tabularProvenanceLabel(object),
        ...contextualCompletionRange(input.text, cursor, object.contextualText, {
          floor: dependency.anchor.end,
          preserveSuffixes: [
            ...fields,
            ...scopedObjects.flatMap((candidate) => rowSearchAliases(candidate.anchor?.rowKey ?? candidate.metadata.row)),
          ],
        }),
        confidence: object.score,
        dependencyCandidate: this.enrichObject(projectId, {
          ...object,
          reasons: ['same linked variable', changeIntent ? 'matching change result' : 'matching stored value'],
        }),
        generated: false,
      });
      if (suggestions.length >= 8) break;
    }
    return {
      dependencyId: dependency.id,
      source,
      variable,
      changeIntent,
      requestedRows: [...requestedRows],
      heading: (dependencySelectsColumn || explicitFields.size) && scopedObjects.length
        && new Set(scopedObjects.map((object) => normalizedVariable(object.metadata.column ?? object.anchor?.column))).size === 1
        ? `Value for ${variable} · ${scopedObjects[0].metadata.column ?? scopedObjects[0].anchor?.column}`
        : `Values for ${variable}`,
      completions: suggestions,
      notice: suggestions.length ? null
        : `No source-backed value found for ${variable}${requestedRows.size
          ? ` at ${[...requestedRows].join(', ')}` : dependencySelectsRow ? ` at ${sourceRow}` : ''}`,
    };
  }

  predict(projectId, input) {
    const prediction = this.predictionCandidates(projectId, input);
    const explicitSearch = input.surface === 'search';
    const limit = 12;
    let remaining = limit;
    const take = (items) => {
      const selected = (items ?? []).slice(0, remaining);
      remaining -= selected.length;
      return selected;
    };
    const scoped = Boolean(prediction.sourceContext?.source);
    prediction.sourceCompletions = take(this.rankCompletions(projectId,
      prediction.sourceCompletions, input, { limit, diversify: !scoped }));
    prediction.workspaceCompletions = take(this.rankCompletions(projectId,
      prediction.workspaceCompletions, input, { limit, diversify: !scoped }));
    prediction.claims = prediction.claims.map((claim) => {
      const eligible = claim.candidates.filter((candidate) => explicitSearch || candidate.matchTier === 0
        || (candidate.matchStrength ?? candidate.score) >= (claim.type === 'STUDY_VARIABLE' ? 0.68 : 0.4));
      const rankingProjectId = eligible.length ? this.sourceProjectId(eligible[0]) ?? projectId : projectId;
      return { ...claim, candidates: take(this.ranking.rank(rankingProjectId, eligible, {
        query: claim.text, documentPath: rankingProjectId === projectId ? input.documentPath : null,
        relatedPaths: this.relatedSourcePaths(rankingProjectId, input),
        limit: remaining, diversify: !scoped,
      })) };
    });
    if (prediction.completion && remaining <= 0) prediction.completion = null;
    return prediction;
  }

  /** The whole file the words at the cursor name, once other readings of the
   * same words have had their say. */
  namedFile(projectId, input, cursor, text, settledAt = -1) {
    const named = this.fileReference(projectId, input, cursor, settledAt);
    if (!named) return null;
    // A citation being written ("from the document placental trans") is the
    // literature path's: it matches documents and papers by title and inserts
    // citation text. Datasets and drawings remain named files.
    const citing = detectClaimSpans(text).some((claim) => claim.type === 'LITERATURE'
      && claim.value != null && claim.end > named.start);
    let candidates = citing ? named.candidates.filter((candidate) => !['DOCUMENT', 'PAPER'].includes(candidate.objectType))
      : named.candidates;
    // Plain words may be a variable's name ("systolic blood pressure"); one
    // matched on as many words wins over any file but a drawing.
    if (!named.asWritten && candidates.some((candidate) => candidate.objectType !== 'DRAWING')) {
      const variable = this.progressiveStudyVariable(projectId, input, cursor, settledAt);
      if (variable?.fragment && variable.candidates.length
        && variable.fragment.end - variable.fragment.start >= named.end - named.start) {
        candidates = candidates.filter((candidate) => candidate.objectType === 'DRAWING');
      }
    }
    return candidates.length ? { ...named, candidates } : null;
  }

  predictionCandidates(projectId, input) {
    const text = String(input.text ?? '');
    const cursor = Number.isInteger(input.cursor) ? input.cursor : text.length;
    // An explicit model/file reference starts a new source even after another
    // source was linked. It must not depend on scientific-writing intent.
    // The name just accepted ("The Bracket ") is not a new reference to it,
    // nor is the name of the file a focus chosen with fn+Right sits in.
    const newestDependency = this.linkedDependencyContext(projectId, input, cursor);
    const codeLines = this.linesFromCode(projectId, input, cursor, newestDependency);
    if (codeLines) {
      return {
        claims: [], completion: null, sourceCompletions: [],
        workspaceCompletions: codeLines.completions,
        workspaceHeading: codeLines.heading,
        notice: codeLines.notice,
        sourceContext: {
          dependencyId: codeLines.dependencyId, source: codeLines.source, variable: null,
          kind: 'PROJECT_OBJECT', exclusive: true,
        },
        deterministic: true, generatedText: false,
      };
    }
    const linkedRecord = this.fieldsFromLinkedRecord(projectId, input, cursor, newestDependency);
    if (linkedRecord) {
      return {
        claims: [], completion: null, sourceCompletions: [],
        workspaceCompletions: linkedRecord.completions,
        workspaceHeading: linkedRecord.heading,
        notice: null,
        sourceContext: {
          dependencyId: linkedRecord.dependencyId,
          source: linkedRecord.source,
          variable: linkedRecord.variable,
          kind: 'PROJECT_OBJECT',
          exclusive: true,
        },
        deterministic: true, generatedText: false,
      };
    }
    const settledAt = this.settledValueEnd(input, newestDependency);
    const linkedDependency = newestDependency?.anchor.end > settledAt ? newestDependency : null;
    const file = this.namedFile(projectId, input, cursor, text, settledAt);
    if (file && !(linkedDependency && file.end <= linkedDependency.anchor.end)
      && !namesFocusedFile(file, linkedDependency)) return {
      claims: [file], completion: null, sourceCompletions: [], workspaceCompletions: [],
      sourceContext: null, deterministic: true, generatedText: false,
    };
    const linkedPaper = this.findingsFromLinkedPaper(projectId, input, cursor, linkedDependency);
    if (linkedPaper) {
      return {
        claims: [], completion: null,
        sourceCompletions: linkedPaper.completions,
        workspaceCompletions: [],
        sourceContext: {
          dependencyId: linkedPaper.dependencyId,
          source: linkedPaper.source,
          exclusive: true,
        },
        deterministic: true, generatedText: false,
      };
    }
    const linkedProjectObject = this.projectLinkInScope(projectId, input, cursor, linkedDependency)
      ? this.valuesFromLinkedProjectObject(projectId, input, cursor, linkedDependency) : null;
    if (linkedProjectObject) {
      return {
        claims: [], completion: null, sourceCompletions: [],
        workspaceCompletions: replacingFocusWords(linkedProjectObject.completions, linkedDependency, text, cursor),
        workspaceHeading: linkedProjectObject.heading ?? `Values for ${linkedProjectObject.variable}`,
        notice: linkedProjectObject.notice,
        sourceContext: {
          dependencyId: linkedProjectObject.dependencyId,
          source: linkedProjectObject.source,
          variable: linkedProjectObject.variable,
          kind: 'PROJECT_OBJECT',
          exclusive: true,
        },
        deterministic: true, generatedText: false,
      };
    }
    // A value just accepted already fills its claim ("The Bracket is 100 mm").
    const detected = detectClaimSpans(text).filter((claim) => claim.end > settledAt);
    // An amount or citation in an earlier sentence or clause says nothing about
    // the words being typed now ("Revenue was 485000. Gross pr", "... and gross pr").
    const clauseStart = currentClauseStart(text, cursor);
    const current = detected.filter((claim) => claim.end > clauseStart);
    const hasStudyValue = current.some((claim) => ['QUANTITATIVE', 'SAMPLE_SIZE'].includes(claim.type));
    const hasReferenceIntent = current.some((claim) => ['LITERATURE', 'TABLE_REFERENCE', 'FIGURE', 'METHOD', 'DATASET_REFERENCE']
      .includes(claim.type));
    const studyPrediction = hasStudyValue || hasReferenceIntent
      ? null : this.progressiveStudyVariable(projectId, input, cursor, settledAt);
    if (studyPrediction) {
      const { fragment, candidates } = studyPrediction;
      const hasVariableChoices = Boolean(fragment && candidates.length);
      const preferWorkspace = !hasVariableChoices && !hasSpecificCompletionTail(studyPrediction.context.sentence);
      const resultLimit = input.surface === 'search' ? 12 : 8;
      const initialWorkspaceCompletions = preferWorkspace
        ? this.workspaceSuggestions(projectId, input, cursor, { limit: resultLimit }) : [];
      const exactProjectCompletion = hasVariableChoices || initialWorkspaceCompletions.length
        ? null : this.sentenceSuggestion(projectId, input);
      const completion = exactProjectCompletion?.dependencyCandidate
        && !['PAPER', 'REFERENCE'].includes(exactProjectCompletion.dependencyCandidate.objectType)
        ? exactProjectCompletion : null;
      const workspaceCompletions = hasVariableChoices || completion
        ? [] : initialWorkspaceCompletions.length ? initialWorkspaceCompletions
          : this.workspaceSuggestions(projectId, input, cursor, { limit: resultLimit });
      return {
        claims: fragment && candidates.length ? [{
          ...fragment,
          type: 'STUDY_VARIABLE',
          value: fragment.text,
          partial: true,
          studyResult: true,
          candidates,
        }] : [],
        completion,
        sourceCompletions: [],
        workspaceCompletions,
        sourceContext: { kind: 'PROJECT_DATA', exclusive: true },
        deterministic: true,
        generatedText: false,
      };
    }
    const claims = detected
      .sort((a, b) => {
        const aDistance = a.start <= cursor && cursor <= a.end ? 0 : Math.min(Math.abs(cursor - a.start), Math.abs(cursor - a.end));
        const bDistance = b.start <= cursor && cursor <= b.end ? 0 : Math.min(Math.abs(cursor - b.start), Math.abs(cursor - b.end));
        return aDistance - bDistance;
      })
      .map((claim) => {
        const scopedToLinkedPaper = linkedDependency
          && ['PAPER', 'REFERENCE'].includes(linkedDependency.source.objectType)
          && ['TABLE_REFERENCE', 'FIGURE'].includes(claim.type)
          && claim.start >= linkedDependency.anchor.end;
        const sourceProjectId = scopedToLinkedPaper ? this.sourceProjectId(linkedDependency.source) ?? projectId : projectId;
        let candidates = this.candidatesForClaim(sourceProjectId, claim, {
          context: input.context ?? text,
          section: input.section,
          documentPath: sourceProjectId === projectId ? input.documentPath : null,
          relatedPaths: this.relatedSourcePaths(sourceProjectId, input),
          minimumMatchStrength: input.surface === 'search' ? 0 : 0.4,
          limit: input.surface === 'search' ? 12 : 8,
          sourcePath: scopedToLinkedPaper ? linkedDependency.source.path : null,
          snapshotId: scopedToLinkedPaper ? linkedDependency.source.snapshotId : null,
        });
        if (claim.type === 'LITERATURE' && claim.partial) {
          candidates = candidates.map((candidate) => ({
            ...candidate,
            citationText: referenceCompletionText(candidate, claim.value, candidate.referenceRole ?? claim.referenceMode),
          }));
        } else if (claim.partial && ['TABLE_REFERENCE', 'FIGURE'].includes(claim.type)) {
          candidates = candidates.map((candidate) => ({
            ...candidate,
            componentText: candidate.metadata.componentLabel ?? candidate.label,
          }));
        }
        return { ...claim, candidates, scopedToLinkedPaper };
      });
    const predictedCompletion = claims.some((claim) => claim.candidates.length)
      ? null : this.sentenceSuggestion(projectId, input);
    const completion = predictedCompletion?.dependencyCandidate ? predictedCompletion : null;
    return {
      claims, completion, sourceCompletions: [], workspaceCompletions: [],
      sourceContext: claims.some((claim) => claim.scopedToLinkedPaper)
        ? {
          dependencyId: linkedDependency.id,
          source: linkedDependency.source,
          kind: 'LINKED_SOURCE',
          exclusive: true,
        } : null,
      deterministic: true, generatedText: false,
    };
  }

  search(projectId, query, options = {}) {
    const normalizedQuery = String(query ?? '').toLowerCase().trim();
    const terms = normalizedQuery.match(/[\p{L}\p{N}_.%-]+/gu) ?? [];
    const termMatchers = terms.map(queryTermMatcher);
    const contextTerms = wordTokens(options.context);
    // Terminal aliases are names in this workspace, so the editor's source
    // picker finds a source by an alias the same way the terminal does.
    const aliases = this.aliasesForProject?.(projectId) ?? [];
    const aliasedKeys = new Set(aliases
      .filter((alias) => normalizedQuery && normalizedVariable(alias.name) === normalizedVariable(normalizedQuery))
      .map((alias) => alias.objectKey));
    const aliasContextScores = new Map();
    if (terms.length) {
      for (const alias of aliases) {
        const name = String(alias.name).toLowerCase();
        const score = 0.75 * terms.filter((term) => name.includes(term)).length / terms.length;
        if (score) aliasContextScores.set(alias.objectKey, Math.max(score, aliasContextScores.get(alias.objectKey) ?? 0));
      }
    }
    const objects = this.objectsAt(projectId, options.snapshotId)
      .filter((object) => !options.sourcePath || object.path === options.sourcePath);
    const drawingMatches = new Map(objects.flatMap(object => {
      const match = drawingReferenceMatch(object, normalizedQuery);
      return match ? [[object.id, match]] : [];
    }));
    const drawingPaths = new Set(objects.filter(object => drawingMatches.has(object.id)).map(object => object.path));
    const matches = objects
      .map((object) => {
        const drawing = drawingMatches.get(object.id);
        const match = directRecommendationMatch(object, normalizedQuery);
        const aliasMatch = aliasedKeys.has(object.objectKey);
        const direct = match.direct || aliasMatch;
        const searchable = `${object.searchText} ${object.path}`.toLowerCase();
        // A passage is found by its own words. Its file name matches every
        // passage in the file equally, so it counts for little.
        const passage = isTextPassage(object);
        const content = passage ? String(object.valueText ?? '').toLowerCase() : searchable;
        const filePath = object.path.toLowerCase();
        const termScore = termMatchers.reduce((sum, matches) => sum
          + Math.max(matches(content), passage ? matches(filePath) * 0.3 : 0), 0) / Math.max(1, terms.length);
        const contextScore = contextTerms.length
          ? contextTerms.filter((term) => searchable.includes(term)).length / contextTerms.length : 0;
        const aliasScore = aliasContextScores.get(object.objectKey) ?? 0;
        const score = aliasMatch ? 1 : direct && normalizedQuery ? match.score
          : terms.length ? Math.max(aliasScore, termScore)
            : contextScore ? 0.25 + contextScore * 0.35 : 0.2;
        return {
          ...object,
          diversityKey: object.objectType === 'REFERENCE' ? object.id : object.path,
          ...(drawing ? { label: drawing.label, searchAliases: drawingDiscovery(object).aliases } : {}),
          ...((drawing || direct && normalizedQuery) ? { matchTier: 0 }
            : drawingPaths.has(object.path) ? { matchTier: 1 } : {}),
          ...(!normalizedQuery && contextTerms.length ? { matchTier: contextScore ? 1 : 3 } : {}),
          reasons: aliasMatch ? ['Exact alias match'] : drawing ? ['Matches a drawing name or topic']
            : direct && normalizedQuery ? [match.reason]
              : aliasScore ? ['Matches a source alias'] : contextScore ? ['Matches current context'] : [],
          score: drawing ? Math.max(drawing.score, direct ? score : 0)
            : normalizedQuery && !direct && score > 0 ? Math.min(1, score + contextScore * 0.03) : score,
        };
      })
      .filter((object) => !terms.length || object.score > 0)
      .sort((a, b) => b.score - a.score || b.snapshotVersion - a.snapshotVersion || a.label.localeCompare(b.label));
    const sourcePaths = new Set(matches.filter((object) => normalizedQuery
      && [object.path, path.posix.basename(object.path)].some((value) => value.toLowerCase() === normalizedQuery))
      .map((object) => object.path));
    let ranked = this.ranking.rank(projectId, matches, {
      query: normalizedQuery || options.context, documentPath: options.documentPath,
      limit: options.limit ?? 30,
      diversify: options.diversify !== false && !options.sourcePath && sourcePaths.size !== 1,
    });
    // Naming a file asks for that file first, then what it contains.
    if (sourcePaths.size === 1) {
      const whole = (object) => ['DRAWING', 'PAPER', 'DATASET'].includes(object.objectType)
        || (object.objectType === 'DOCUMENT' && !isTextPassage(object));
      ranked = [...ranked.filter(whole), ...ranked.filter((object) => !whole(object))];
    }
    return options.enrich === false ? ranked : ranked.map((object) => this.enrichObject(projectId, object));
  }

  recordRecommendationUsage(projectId, input, { allowMissingSource = false } = {}) {
    if (!input || !['accept', 'open'].includes(input.kind)) {
      throw new HttpError(400, 'Usage must be an accepted suggestion or deliberate source open.');
    }
    let project = this.timeline.getProject(projectId);
    let objectId = input.objectId;
    for (const key of ['objectId', 'dependencyId']) {
      if (Object.hasOwn(input, key) && (typeof input[key] !== 'string' || !input[key].trim()
        || input[key].length > 128 || /[\u0000-\u001f\u007f]/.test(input[key]))) {
        throw new HttpError(400, 'An indexed source or dependency identity is required.');
      }
    }
    if (Object.hasOwn(input, 'path') && (typeof input.path !== 'string' || !input.path
      || input.path.length > 4096)) throw new HttpError(400, 'An indexed file path is required.');
    const suppliedSource = objectId
      ? this.db.prepare('SELECT project_id FROM scientific_objects WHERE id = ?').get(objectId) : null;
    if (objectId && !suppliedSource) throw new HttpError(404, 'Indexed source not found in this project.');
    if (Object.hasOwn(input, 'dependencyId')) {
      const dependency = this.db.prepare('SELECT project_id FROM claim_dependencies WHERE id = ?').get(input.dependencyId);
      if (!dependency || dependency.project_id !== projectId) throw new HttpError(404, 'Dependency not found in this project.');
      const dependencyObjectId = this.latestVersionRow(input.dependencyId)?.source_object_id;
      // A foreign object is valid through a real dependency in this directory.
      // An unrelated foreign identity must still fail before recording usage.
      if (suppliedSource && suppliedSource.project_id !== projectId && objectId !== dependencyObjectId) {
        throw new HttpError(404, 'Indexed source not found in this project.');
      }
      if (objectId && objectId !== dependencyObjectId) throw new HttpError(400, 'Source and dependency identities do not match.');
      objectId = dependencyObjectId;
      if (!objectId && allowMissingSource) return { recorded: false };
      if (!objectId) throw new HttpError(404, 'Dependency source not found in this project.');
    }
    if (objectId) {
      const source = suppliedSource ?? this.db.prepare('SELECT project_id FROM scientific_objects WHERE id = ?').get(objectId);
      if (!source || (source.project_id !== projectId && !Object.hasOwn(input, 'dependencyId'))) {
        throw new HttpError(404, 'Indexed source not found in this project.');
      }
      project = this.timeline.getProject(source.project_id);
    }
    let sourcePath = input.path;
    if (objectId) {
      if (typeof objectId !== 'string') throw new HttpError(400, 'An indexed source identity is required.');
      // Resolve through file identity so an accepted older object follows a rename.
      const latest = this.timeline.objectVersions.latest(objectId);
      const original = latest?.project_id === project.id
        ? this.timeline.snapshotFile(latest.snapshot_id, latest.path) : null;
      const source = original ? this.timeline.snapshotFileById(project.currentSnapshotId, original.projectFileId) : null;
      if (!source && allowMissingSource) return { recorded: false };
      if (!source) throw new HttpError(404, 'Indexed source not found in this project.');
      sourcePath = source.path;
    }
    return this.ranking.record(project.id, {
      path: sourcePath, kind: input.kind, sessionId: input.sessionId,
      documentPath: project.id === projectId ? input.documentPath : null,
    });
  }

  documentEditLayer(projectId, projectFileId, snapshotId) {
    const maximumVersion = this.timeline.snapshotRecord(snapshotId).version;
    return this.db.prepare(`
      SELECT layer.*, snapshot.version AS snapshot_version
      FROM document_edit_layer_versions layer
      JOIN snapshots snapshot ON snapshot.id = layer.snapshot_id
      WHERE layer.project_id = ? AND layer.project_file_id = ? AND snapshot.version <= ?
      ORDER BY snapshot.version DESC LIMIT 1
    `).get(projectId, projectFileId, maximumVersion) ?? null;
  }

  extractedEditableContent(file, buffer) {
    if (file.fileType === 'markdown' || file.fileType === 'text') return buffer.toString('utf8');
    if (file.fileType === 'document') return extractDocxDocument(buffer).textExcerpt;
    if (file.fileType === 'pdf') return extractPdfDocument(buffer).textExcerpt;
    return '';
  }

  editableDocumentModel(projectId, file, snapshotId) {
    const buffer = this.timeline.blobs.get(file.contentHash ?? file.content_hash);
    const layer = this.documentEditLayer(projectId, file.projectFileId ?? file.project_file_id, snapshotId);
    const original = this.extractedEditableContent(file, buffer);
    const content = layer?.content ?? original;
    const richLayer = Boolean(layer) || file.fileType === 'markdown';
    return {
      content,
      blocks: richLayer ? diffInternals.markdownBlocks(content) : plainDocumentBlocks(content),
      editLayer: layer ? {
        snapshotId: layer.snapshot_id,
        sourceContentHash: layer.source_content_hash,
        updatedAt: layer.created_at,
      } : null,
      editingMode: ['document', 'pdf'].includes(file.fileType) ? 'TEXT_LAYER' : 'NATIVE_TEXT',
      originalPreserved: ['document', 'pdf'].includes(file.fileType),
    };
  }

  listDocuments(projectId) {
    const project = this.timeline.getProject(projectId);
    const snapshot = this.timeline.getSnapshot(project.currentSnapshotId);
    return snapshot.files.filter((file) => EDITABLE_DOCUMENT_TYPES.has(file.fileType)).map((file) => {
      const audit = this.audit(projectId, { projectFileId: file.projectFileId, reconcile: false });
      const layer = this.documentEditLayer(projectId, file.projectFileId, snapshot.id);
      return {
        path: file.path,
        projectFileId: file.projectFileId,
        fileType: file.fileType,
        size: file.size,
        editingMode: ['document', 'pdf'].includes(file.fileType) ? 'TEXT_LAYER' : 'NATIVE_TEXT',
        hasEditLayer: Boolean(layer),
        ...audit.summary,
      };
    });
  }

  getDocument(projectId, filePath) {
    const project = this.timeline.getProject(projectId);
    this.reconcileProject(projectId);
    const current = this.timeline.getProject(projectId);
    const snapshot = this.timeline.getSnapshot(current.currentSnapshotId);
    const file = this.timeline.snapshotFile(snapshot.id, filePath);
    if (!file || !EDITABLE_DOCUMENT_TYPES.has(file.fileType)) throw new HttpError(404, 'Editable document not found.');
    const model = this.editableDocumentModel(projectId, file, snapshot.id);
    return {
      path: file.path,
      projectFileId: file.projectFileId,
      fileType: file.fileType,
      editingMode: model.editingMode,
      originalPreserved: model.originalPreserved,
      editLayer: model.editLayer,
      snapshotId: snapshot.id,
      version: snapshot.version,
      contentHash: file.contentHash,
      content: model.content,
      blocks: model.blocks,
      dependencies: this.currentDependencies(projectId, { projectFileId: file.projectFileId }),
      audit: this.audit(projectId, { projectFileId: file.projectFileId, reconcile: false }),
    };
  }

  /**
   * Whether a document is exactly as it was when the editor opened `openedAt`.
   * Other files in the folder may change meanwhile; that must not block a save.
   */
  documentUnchangedSince(project, openedAt, relativePath) {
    const opened = this.timeline.snapshotFile(openedAt, relativePath);
    const current = this.timeline.snapshotFile(project.currentSnapshotId, relativePath);
    if (!opened || !current || opened.contentHash !== current.contentHash) return false;
    // DOCX and PDF edits live in a layer; a newer layer is a newer document.
    const openedVersion = this.db.prepare('SELECT version FROM snapshots WHERE id = ? AND project_id = ?')
      .get(openedAt, project.id)?.version;
    if (openedVersion == null) return false;
    const newerLayer = this.db.prepare(`SELECT 1 FROM document_edit_layer_versions v JOIN snapshots s ON s.id = v.snapshot_id
      WHERE v.project_file_id = ? AND s.version > ? LIMIT 1`).get(current.projectFileId, openedVersion);
    return !newerLayer;
  }

  saveDocument(projectId, input, actorInput) {
    this.timeline.drives?.assertOnline(projectId);
    const actor = this.timeline.validateActor(actorInput);
    const project = this.timeline.getProject(projectId);
    const relativePath = posixPath(input.path);
    const requestedBase = input.baseSnapshotId ?? project.currentSnapshotId;
    if (requestedBase !== project.currentSnapshotId && !this.documentUnchangedSince(project, requestedBase, relativePath)) {
      throw new VersionConflictError(requestedBase, project.currentSnapshotId);
    }
    const baseSnapshotId = project.currentSnapshotId;
    const existing = this.timeline.snapshotFile(baseSnapshotId, relativePath);
    if (!existing || !EDITABLE_DOCUMENT_TYPES.has(existing.fileType)) throw new HttpError(400, 'This tracked file is not editable here.');
    const destination = this.timeline.assertWorkingFileUnchanged(project, relativePath, existing.contentHash);
    if (['document', 'pdf'].includes(existing.fileType)) {
      const content = String(input.content ?? '');
      return this.cloneTransition(projectId, actor, {
        source: 'DOCUMENT_CHANGE',
        title: `Edited ${relativePath} without changing the original ${existing.fileType.toUpperCase()}`,
      }, ({ resultingSnapshotId, timestamp, actor }) => {
        this.db.prepare(`
          INSERT INTO document_edit_layer_versions(
            id, project_id, project_file_id, snapshot_id, source_content_hash, source_format,
            content, created_by_actor_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id(), projectId, existing.projectFileId, resultingSnapshotId, existing.contentHash,
          existing.fileType, content, actor.id, timestamp,
        );
      });
    }
    const temporary = `${destination}.lasso-document-${id()}.tmp`;
    fs.writeFileSync(temporary, String(input.content ?? ''), { flag: 'wx' });
    fs.renameSync(temporary, destination);
    return this.timeline.capture(projectId, actor, {
      expectedSnapshotId: baseSnapshotId,
      source: 'DOCUMENT_CHANGE',
    });
  }

  validateAnchor(snapshotId, filePath, anchor, expectedSpan = null) {
    const file = this.timeline.snapshotFile(snapshotId, filePath);
    if (!file || !EDITABLE_DOCUMENT_TYPES.has(file.fileType)) throw new HttpError(400, 'Dependency anchors require an editable document version.');
    if (anchor?.kind !== 'manuscript-span' || !Number.isInteger(anchor.blockIndex)) throw new HttpError(400, 'A stable manuscript span anchor is required.');
    const projectId = this.timeline.snapshotRecord(snapshotId).projectId;
    const blocks = this.editableDocumentModel(projectId, file, snapshotId).blocks;
    const block = blocks[anchor.blockIndex];
    if (!block) throw new HttpError(400, 'The anchored paragraph is not present in this document version.');
    const span = block.text.slice(anchor.start, anchor.end);
    if (!span || (expectedSpan != null && span !== expectedSpan)) throw new HttpError(409, 'The selected text no longer matches its document anchor.');
    return { file, block, span, anchor: anchorForSpan(anchor.blockIndex, block.type, block.text, anchor.start, anchor.end) };
  }

  cloneTransition(projectId, actorInput, { source, title, initiatedBy = null }, callback) {
    const project = this.timeline.getProject(projectId);
    const previous = this.timeline.getSnapshot(project.currentSnapshotId);
    const actor = normalizeActor(actorInput, source === 'DEPENDENCY_STALE' ? 'SYSTEM' : 'HUMAN_SELF');
    const resultingSnapshotId = id();
    const eventId = id();
    const timestamp = now();
    this.timeline.files.transaction(resultingSnapshotId, () => {
      const current = this.db.prepare('SELECT current_snapshot_id FROM projects WHERE id = ?').get(projectId);
      if (current.current_snapshot_id !== previous.id) throw new VersionConflictError(previous.id, current.current_snapshot_id);
      this.timeline.upsertActor(actor);
      let initiator = null;
      if (initiatedBy) { initiator = normalizeActor(initiatedBy); this.timeline.upsertActor(initiator); }
      // The files are unchanged, so the new version carries all of them forward.
      const filesBase = this.timeline.files.baseFor(previous.id);
      this.db.prepare(`
        INSERT INTO snapshots(id, project_id, version, parent_snapshot_id, manifest_hash, created_at, files_base_snapshot_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(resultingSnapshotId, projectId, previous.version + 1, previous.id, previous.manifestHash, timestamp, filesBase);
      this.timeline.files.write(resultingSnapshotId, previous.files, filesBase);
      this.db.prepare(`
        INSERT INTO timeline_events(id, project_id, previous_snapshot_id, resulting_snapshot_id, actor_id, initiated_by_actor_id, occurred_at, source, title)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(eventId, projectId, previous.id, resultingSnapshotId, actor.id, initiator?.id ?? null, timestamp, source, title);
      callback({ previous, resultingSnapshotId, eventId, timestamp, actor });
      this.db.prepare('UPDATE projects SET current_snapshot_id = ? WHERE id = ?').run(resultingSnapshotId, projectId);
    });
    return { snapshot: this.timeline.getSnapshot(resultingSnapshotId), event: this.timeline.getEvent(eventId) };
  }

  link(projectId, input, actorInput) {
    const project = this.timeline.getProject(projectId);
    if (input.expectedSnapshotId && input.expectedSnapshotId !== project.currentSnapshotId) {
      throw new VersionConflictError(input.expectedSnapshotId, project.currentSnapshotId);
    }
    this.ensureIndex(projectId, project.currentSnapshotId);
    const anchored = this.validateAnchor(project.currentSnapshotId, input.documentPath, input.anchor, input.spanText);
    const object = this.sourceVersion(input.sourceObjectId, input.sourceSnapshotId, {
      destinationProjectId: projectId, newLink: true,
    });
    if (!object) throw new HttpError(404, 'The selected scientific object does not exist in that project version.');
    const method = SELECTION_METHODS.has(input.selectionMethod) ? input.selectionMethod : 'MANUAL';
    const dependencyId = id();
    const result = this.cloneTransition(projectId, actorInput, {
      source: 'DEPENDENCY_LINKED', title: `Linked “${anchored.span.slice(0, 64)}” to ${object.label}`,
      initiatedBy: input.initiatedBy,
    }, ({ resultingSnapshotId, eventId, timestamp, actor }) => {
      const versionId = id();
      this.db.prepare('INSERT INTO claim_dependencies(id, project_id, document_project_file_id, created_at) VALUES (?, ?, ?, ?)')
        .run(dependencyId, projectId, anchored.file.projectFileId, timestamp);
      this.db.prepare(`
        INSERT INTO claim_dependency_versions(
          id, dependency_id, snapshot_id, document_snapshot_id, document_path, document_anchor_json, span_text,
          source_object_id, source_snapshot_id, source_value_text, selection_method, confidence, status,
          status_details_json, created_by_actor_id, created_at, is_removed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LINKED', '{}', ?, ?, 0)
      `).run(
        versionId, dependencyId, resultingSnapshotId, resultingSnapshotId, input.documentPath,
        JSON.stringify(anchored.anchor), anchored.span, object.object_id, object.snapshot_id, object.value_text,
        method, input.confidence ?? null, actor.id, timestamp,
      );
      this.db.prepare(`
        INSERT INTO dependency_changes(id, event_id, dependency_id, before_version_id, after_version_id, change_type, details_json)
        VALUES (?, ?, ?, NULL, ?, 'DEPENDENCY_LINKED', ?)
      `).run(id(), eventId, dependencyId, versionId, JSON.stringify({ sourceLabel: object.label, sourceType: object.object_type }));
      this.db.prepare(`
        INSERT INTO provenance_links(id, project_id, from_snapshot_id, from_path, from_anchor_json, relation,
          to_snapshot_id, to_path, to_anchor_json, metadata_json, created_by_event_id, created_at)
        VALUES (?, ?, ?, ?, ?, 'DEPENDS_ON', ?, ?, ?, ?, ?, ?)
      `).run(
        id(), projectId, resultingSnapshotId, input.documentPath, JSON.stringify(anchored.anchor),
        object.snapshot_id, object.path, object.anchor_json,
        JSON.stringify({ dependencyId, objectId: object.object_id, objectType: object.object_type, label: object.label, value: object.value_text }),
        eventId, timestamp,
      );
      if (['AUTOCOMPLETE', 'PREDICTED_ACCEPTED', 'MANUAL'].includes(method)
        && ['HUMAN_SELF', 'HUMAN_COLLABORATOR'].includes(actor.actorType)) {
        this.recordRecommendationUsage(object.project_id, {
          objectId: object.object_id, kind: 'accept', sessionId: input.sessionId,
          documentPath: object.project_id === projectId ? input.documentPath : null,
        }, { allowMissingSource: true });
      }
    });
    return { dependency: this.getDependency(dependencyId), ...result };
  }

  linkMany(projectId, input, actorInput) {
    const project = this.timeline.getProject(projectId);
    if (input.expectedSnapshotId && input.expectedSnapshotId !== project.currentSnapshotId) {
      throw new VersionConflictError(input.expectedSnapshotId, project.currentSnapshotId);
    }
    const links = Array.isArray(input.links) ? input.links.slice(0, 50) : [];
    if (!links.length) throw new HttpError(400, 'At least one dependency link is required.');
    this.ensureIndex(projectId, project.currentSnapshotId);
    const prepared = links.map((link) => {
      const anchored = this.validateAnchor(project.currentSnapshotId, link.documentPath, link.anchor, link.spanText);
      const object = this.sourceVersion(link.sourceObjectId, link.sourceSnapshotId, {
        destinationProjectId: projectId, newLink: true,
      });
      if (!object) throw new HttpError(404, 'A selected scientific object does not exist in that project version.');
      return {
        input: link,
        anchored,
        object,
        method: SELECTION_METHODS.has(link.selectionMethod) ? link.selectionMethod : 'MANUAL',
        dependencyId: id(),
      };
    });
    const title = prepared.length === 1
      ? `Linked “${prepared[0].anchored.span.slice(0, 64)}” to ${prepared[0].object.label}`
      : `Linked ${prepared.length} manuscript dependencies`;
    const result = this.cloneTransition(projectId, actorInput, {
      source: 'DEPENDENCY_LINKED', title, initiatedBy: input.initiatedBy,
    }, ({ resultingSnapshotId, eventId, timestamp, actor }) => {
      for (const item of prepared) {
        const versionId = id();
        this.db.prepare('INSERT INTO claim_dependencies(id, project_id, document_project_file_id, created_at) VALUES (?, ?, ?, ?)')
          .run(item.dependencyId, projectId, item.anchored.file.projectFileId, timestamp);
        this.db.prepare(`
          INSERT INTO claim_dependency_versions(
            id, dependency_id, snapshot_id, document_snapshot_id, document_path, document_anchor_json, span_text,
            source_object_id, source_snapshot_id, source_value_text, selection_method, confidence, status,
            status_details_json, created_by_actor_id, created_at, is_removed
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LINKED', '{}', ?, ?, 0)
        `).run(
          versionId, item.dependencyId, resultingSnapshotId, resultingSnapshotId, item.input.documentPath,
          JSON.stringify(item.anchored.anchor), item.anchored.span, item.object.object_id, item.object.snapshot_id,
          item.object.value_text, item.method, item.input.confidence ?? null, actor.id, timestamp,
        );
        this.db.prepare(`
          INSERT INTO dependency_changes(id, event_id, dependency_id, before_version_id, after_version_id, change_type, details_json)
          VALUES (?, ?, ?, NULL, ?, 'DEPENDENCY_LINKED', ?)
        `).run(id(), eventId, item.dependencyId, versionId,
          JSON.stringify({ sourceLabel: item.object.label, sourceType: item.object.object_type }));
        this.db.prepare(`
          INSERT INTO provenance_links(id, project_id, from_snapshot_id, from_path, from_anchor_json, relation,
            to_snapshot_id, to_path, to_anchor_json, metadata_json, created_by_event_id, created_at)
          VALUES (?, ?, ?, ?, ?, 'DEPENDS_ON', ?, ?, ?, ?, ?, ?)
        `).run(
          id(), projectId, resultingSnapshotId, item.input.documentPath, JSON.stringify(item.anchored.anchor),
          item.object.snapshot_id, item.object.path, item.object.anchor_json,
          JSON.stringify({
            dependencyId: item.dependencyId, objectId: item.object.object_id,
            objectType: item.object.object_type, label: item.object.label, value: item.object.value_text,
          }),
          eventId, timestamp,
        );
        if (['AUTOCOMPLETE', 'PREDICTED_ACCEPTED', 'MANUAL'].includes(item.method)
          && ['HUMAN_SELF', 'HUMAN_COLLABORATOR'].includes(actor.actorType)) {
          this.recordRecommendationUsage(item.object.project_id, {
            objectId: item.object.object_id, kind: 'accept', sessionId: input.sessionId,
            documentPath: item.object.project_id === projectId ? item.input.documentPath : null,
          }, { allowMissingSource: true });
        }
      }
    });
    return { dependencies: prepared.map((item) => this.getDependency(item.dependencyId)), ...result };
  }

  latestVersionRow(dependencyId, maximumProjectVersion = null) {
    const versions = this.db.prepare(`
      SELECT v.*, s.version AS project_version, a.display_name AS actor_name, a.actor_type,
        origin_v.created_by_actor_id AS linked_by_actor_id,
        origin_a.display_name AS linked_by_actor_name, origin_a.actor_type AS linked_by_actor_type,
        o.object_type, o.object_key, o.project_id AS source_project_id
      FROM claim_dependency_versions v
      JOIN snapshots s ON s.id = v.snapshot_id
      JOIN actors a ON a.id = v.created_by_actor_id
      JOIN claim_dependency_versions origin_v ON origin_v.id = (
        SELECT first_v.id FROM claim_dependency_versions first_v
        WHERE first_v.dependency_id = v.dependency_id
        ORDER BY first_v.created_at, first_v.rowid LIMIT 1
      )
      JOIN actors origin_a ON origin_a.id = origin_v.created_by_actor_id
      JOIN scientific_objects o ON o.id = v.source_object_id
      WHERE v.dependency_id = ? AND (? IS NULL OR s.version <= ?)
      ORDER BY s.version DESC
    `).iterate(dependencyId, maximumProjectVersion, maximumProjectVersion);
    // The newest version whose source resolves at the snapshot it was linked from.
    for (const row of versions) {
      const source = this.timeline.objectVersions.at(row.source_snapshot_id, row.source_object_id);
      if (!source) continue;
      return {
        ...row, source_path: source.path, source_anchor_json: source.anchor_json, source_label: source.label,
        source_metadata_json: source.metadata_json, source_content_hash: source.content_hash,
      };
    }
    return null;
  }

  mapDependency(row) {
    if (!row) return null;
    return {
      id: row.dependency_id,
      versionId: row.id,
      projectVersion: row.project_version,
      snapshotId: row.snapshot_id,
      documentSnapshotId: row.document_snapshot_id,
      documentPath: row.document_path,
      anchor: json(row.document_anchor_json, {}),
      spanText: row.span_text,
      selectionMethod: row.selection_method,
      confidence: row.confidence,
      status: row.status,
      statusDetails: json(row.status_details_json, {}),
      removed: Boolean(row.is_removed),
      createdAt: row.created_at,
      createdBy: { id: row.created_by_actor_id, displayName: row.actor_name, actorType: row.actor_type },
      linkedBy: {
        id: row.linked_by_actor_id,
        displayName: row.linked_by_actor_name,
        actorType: row.linked_by_actor_type,
      },
      source: {
        id: row.source_object_id,
        projectId: row.source_project_id,
        objectKey: row.object_key,
        objectType: row.object_type,
        snapshotId: row.source_snapshot_id,
        path: row.source_path,
        anchor: json(row.source_anchor_json, null),
        label: row.source_label,
        valueText: row.source_value_text,
        contentHash: row.source_content_hash,
        metadata: json(row.source_metadata_json, {}),
      },
    };
  }

  getDependency(dependencyId, maximumProjectVersion = null) {
    const row = this.latestVersionRow(dependencyId, maximumProjectVersion);
    if (!row) throw new HttpError(404, 'Claim dependency not found.');
    const dependency = this.mapDependency(row);
    const projectId = this.db.prepare('SELECT project_id FROM claim_dependencies WHERE id = ?').get(dependencyId).project_id;
    dependency.source = this.enrichObject(projectId, dependency.source);
    return dependency;
  }

  activeShareGrants(dependencyId) {
    return this.db.prepare(`
      SELECT grant_row.*, actor.display_name AS created_by_name
      FROM dependency_share_grants grant_row
      JOIN actors actor ON actor.id = grant_row.created_by_actor_id
      WHERE grant_row.dependency_id = ? AND grant_row.revoked_at IS NULL
        AND (grant_row.expires_at IS NULL OR grant_row.expires_at > ?)
      ORDER BY grant_row.created_at DESC
    `).all(dependencyId, now()).map((row) => ({
      id: row.id,
      token: row.token,
      scope: row.access_scope,
      recipientLabel: row.recipient_label,
      contextRadius: row.context_radius,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      createdBy: row.created_by_name,
      url: `/?share=${encodeURIComponent(row.token)}`,
    }));
  }

  dependencyShareSettings(dependencyId) {
    const dependency = this.getDependency(dependencyId);
    const source = semanticDependencySource(dependency);
    return {
      dependency: {
        id: dependency.id,
        spanText: dependency.spanText,
        source,
      },
      recommendedScope: 'CONTEXT',
      grants: this.activeShareGrants(dependencyId),
    };
  }

  configureDependencyShare(dependencyId, input, actorInput) {
    this.getDependency(dependencyId);
    const actor = normalizeActor(actorInput);
    this.timeline.upsertActor(actor);
    const scope = String(input.scope ?? 'CONTEXT').toUpperCase();
    if (scope === 'PRIVATE') {
      this.db.prepare('UPDATE dependency_share_grants SET revoked_at = ? WHERE dependency_id = ? AND revoked_at IS NULL')
        .run(now(), dependencyId);
      return this.dependencyShareSettings(dependencyId);
    }
    if (!['CONTEXT', 'FULL'].includes(scope)) throw new HttpError(400, 'Share scope must be private, cited context, or full source.');
    if (isCodePath(semanticDependencySource(this.getDependency(dependencyId)).path)) {
      throw new HttpError(422, 'Lasso doesn’t make share links for code files. Send a copy of the file instead.');
    }
    const timestamp = now();
    const token = crypto.randomBytes(24).toString('base64url');
    const parsedRadius = Number(input.contextRadius);
    const contextRadius = Number.isFinite(parsedRadius)
      ? Math.max(0, Math.min(5, parsedRadius))
      : 1;
    const expiresAt = shareExpiry(input.expiresAt, new Date(timestamp));
    this.db.prepare(`
      INSERT INTO dependency_share_grants(
        id, dependency_id, token, access_scope, recipient_label, context_radius,
        created_by_actor_id, created_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      id(), dependencyId, token, scope, String(input.recipientLabel ?? '').trim() || null,
      contextRadius, actor.id, timestamp, expiresAt,
    );
    return this.dependencyShareSettings(dependencyId);
  }

  revokeDependencyShare(token) {
    const result = this.db.prepare('UPDATE dependency_share_grants SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL')
      .run(now(), token);
    if (!result.changes) throw new HttpError(404, 'Share grant not found.');
    return { revoked: true };
  }

  tabularShareContent(file, buffer, anchor, scope, radius) {
    // A large table's share reads its first rows or the rows around the cited one.
    const window = this.tableWindow(file, buffer, anchor ?? {}, scope === 'FULL'
      ? { before: 0, after: 1_000 } : { before: Math.max(radius, 2), after: Math.max(radius, 2) });
    if (window) anchor = window.anchor;
    const table = window ? window.table : file.fileType === 'spreadsheet'
      ? extractSpreadsheetTables(buffer).find((sheet) => !anchor?.sheet || sheet.name === anchor.sheet)
      : {
        name: null,
        rows: parseDelimited(buffer.toString('utf8'), path.extname(file.path).toLowerCase() === '.tsv' ? '\t' : ','),
      };
    if (!table?.rows?.length) return null;
    const layout = file.fileType === 'spreadsheet' || window ? spreadsheetLayout(table) : tabularLayout(table.rows);
    const headers = layout.headers;
    const data = layout.rows;
    const rowReference = anchor?.kind === 'table-row';
    const selectedColumn = rowReference ? -1 : Number.isInteger(anchor?.columnIndex) ? anchor.columnIndex
      : Math.max(0, headers.findIndex((header) => String(header) === String(anchor?.column)));
    let selectedRow = Number.isInteger(anchor?.rowIndex)
      ? (layout.rowNumbers && anchor.rowCoordinate === 'worksheet' ? layout.rowNumbers.indexOf(anchor.rowIndex) : anchor.rowIndex - layout.headerRowIndex - 1) : -1;
    if (selectedRow < 0 || selectedRow >= data.length) {
      selectedRow = data.findIndex((row) => String(row[0] ?? '') === String(anchor?.rowKey ?? ''));
    }
    if (scope === 'FULL') {
      return {
        kind: 'table',
        sheet: table.name,
        headers,
        rows: data.slice(0, 1000),
        selectedRow,
        selectedColumn,
        truncated: data.length > 1000,
      };
    }
    if (rowReference) {
      const row = selectedRow >= 0 && selectedRow < data.length ? data[selectedRow] : null;
      return {
        kind: 'table-context',
        sheet: table.name,
        headers,
        rows: row ? [row] : [],
        selectedRow: row ? 0 : -1,
        selectedColumn: -1,
        contextRadius: radius,
        referenceKind: 'ROW',
      };
    }
    const groupColumns = headers.map((header, index) => /^(?:group|cohort|condition|arm|treatment)$/i.test(String(header)) ? index : -1)
      .filter((index) => index >= 0);
    const columnIndexes = [...new Set([0, ...groupColumns, selectedColumn].filter((index) => index >= 0 && index < headers.length))];
    const start = Math.max(0, selectedRow - radius);
    const end = Math.min(data.length, selectedRow + radius + 1);
    return {
      kind: 'table-context',
      sheet: table.name,
      headers: columnIndexes.map((index) => headers[index]),
      rows: data.slice(start, end).map((row) => columnIndexes.map((index) => row[index] ?? '')),
      selectedRow: selectedRow - start,
      selectedColumn: columnIndexes.indexOf(selectedColumn),
      contextRadius: radius,
    };
  }

  sharedSourceContent(dependency, scope, radius) {
    const source = semanticDependencySource(dependency);
    const file = this.timeline.snapshotFile(source.snapshotId, source.path);
    if (!file) throw new HttpError(404, 'The shared source version is no longer available.');
    if (source.metadata?.drawing && scope !== 'FULL') return drawingContext(source);
    const buffer = this.timeline.blobs.get(file.contentHash);
    if (['table', 'spreadsheet'].includes(file.fileType)) {
      return this.tabularShareContent(file, buffer, source.anchor ?? {}, scope, radius)
        ?? { kind: 'text', text: source.valueText ?? dependency.spanText };
    }
    let text = '';
    if (['markdown', 'text', 'code', 'yaml', 'json'].includes(file.fileType)) text = buffer.toString('utf8');
    else if (file.fileType === 'document') text = extractDocxDocument(buffer).textExcerpt;
    else if (file.fileType === 'presentation') text = this.fileText(file, source.objectType);
    else if (file.fileType === 'pdf') text = extractPdfFullText(buffer);
    else text = [source.metadata.title, source.metadata.subject, source.valueText]
      .filter(Boolean).join('\n');
    if (scope === 'FULL') return { kind: 'text', text: text.slice(0, 100_000), truncated: text.length > 100_000 };
    if (file.fileType === 'pdf' && source.metadata.componentType === 'PDF_EXCERPT') {
      const selectedText = source.anchor?.selectedText ?? source.metadata.rawText ?? source.valueText ?? '';
      const sourceSentence = originalFindingSentence(selectedText, dependency.spanText);
      return { kind: 'text-context', text: selectedText, citedText: dependency.spanText,
        pageNumber: source.anchor?.pageNumber ?? source.metadata.pageNumber,
        bbox: source.anchor?.bbox ?? null, contextRadius: radius,
        ...(sourceSentence ? { sourceSentence } : {}) };
    }
    // A Markdown or text passage is located by its own recorded offsets.
    if (source.metadata.componentType === 'TEXT_EXCERPT') text = text.replace(/\r\n?/g, '\n');
    const excerptStart = source.metadata.componentType === 'TEXT_EXCERPT' && Number.isInteger(source.anchor?.start)
      && Number.isInteger(source.anchor?.end) && source.anchor.end <= text.length ? source.anchor.start : -1;
    const lower = text.toLowerCase();
    const locate = (value) => {
      const needle = String(value ?? '').trim();
      const index = needle ? lower.indexOf(needle.toLowerCase()) : -1;
      if (index >= 0) return { needle, index };
      if (file.fileType !== 'pdf' || !needle) return null;
      const pattern = needle.split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
      const match = text.match(new RegExp(pattern, 'iu'));
      return match ? { needle: match[0], index: match.index } : null;
    };
    let found = locate(dependency.spanText);
    if (excerptStart >= 0 && (!found || found.index < excerptStart || found.index >= source.anchor.end)) {
      found = { needle: text.slice(excerptStart, source.anchor.end), index: excerptStart };
    }
    let sourceSentence = null;
    if (!found && file.fileType === 'pdf' && (['PAPER', 'REFERENCE'].includes(source.objectType)
      || source.metadata.componentType === 'PDF_EXCERPT')) {
      const sentence = originalFindingSentence(text.replace(/\s*\n\s*/g, ' '), dependency.spanText);
      const original = locate(sentence);
      if (original) { sourceSentence = sentence; found = original; }
    }
    found ??= locate(source.valueText) ?? locate(source.metadata.title);
    const center = found ? found.index + Math.floor(found.needle.length / 2) : 0;
    const contextSize = 420 + radius * 180;
    const start = Math.max(0, center - contextSize);
    const end = Math.min(text.length, center + contextSize);
    return {
      kind: 'text-context',
      text: `${start ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`,
      citedText: dependency.spanText,
      ...(sourceSentence ? { sourceSentence } : {}),
      contextRadius: radius,
    };
  }

  figurePreviewImage(dependencyId) {
    const dependency = this.getDependency(dependencyId);
    const source = semanticDependencySource(dependency);
    const file = this.timeline.snapshotFile(source.snapshotId, source.path);
    if (source.objectType !== 'FIGURE' || file?.fileType !== 'pdf') {
      throw new HttpError(400, 'This dependency is not a figure inside a PDF.');
    }
    const identifier = source.metadata.identifier ?? source.anchor?.identifier
      ?? String(source.label).match(/\b(?:Figure|Fig\.?)\s+([A-Za-z0-9.-]+)/i)?.[1];
    if (!identifier) throw new HttpError(422, 'The cited figure number is unavailable.');
    const cacheKey = `${file.contentHash}:${normalizedVariable(identifier)}`;
    if (!this.figurePreviewCache.has(cacheKey)) {
      const buffer = this.timeline.blobs.get(file.contentHash);
      try {
        const preview = renderPdfFigurePage(buffer, identifier);
        this.figurePreviewCache.set(cacheKey, preview);
        return preview;
      } catch (error) {
        throw new HttpError(422, error.message);
      }
    }
    return this.figurePreviewCache.get(cacheKey);
  }

  dependencySourceFile(dependencyId) {
    const dependency = this.getDependency(dependencyId);
    const source = semanticDependencySource(dependency);
    const file = this.timeline.snapshotFile(source.snapshotId, source.path);
    if (!file) throw new HttpError(404, 'The indexed source version is no longer available.');
    const extension = path.extname(file.path).toLowerCase();
    const mimeTypes = {
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.txt': 'text/plain; charset=utf-8',
      '.md': 'text/markdown; charset=utf-8',
      '.csv': 'text/csv; charset=utf-8',
      '.tsv': 'text/tab-separated-values; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.xls': 'application/vnd.ms-excel',
    };
    return {
      content: this.timeline.blobs.get(file.contentHash),
      contentType: mimeTypes[extension] ?? 'application/octet-stream',
      filename: path.posix.basename(file.path),
    };
  }

  async sourceModelPreview(source) {
    if (!/\.(?:ifc|dxf|step|stp)$/i.test(source?.path ?? '')) return null;
    const file = this.timeline.snapshotFile(source.snapshotId, source.path);
    if (!file) return { kind: 'model-unavailable', reason: 'The indexed source version is no longer available.' };
    return buildModelPreview({ path: file.path, content: this.timeline.blobs.get(file.contentHash) }, source);
  }

  dependencyModelPreview(dependencyId) {
    return this.sourceModelPreview(semanticDependencySource(this.getDependency(dependencyId)));
  }

  dependencySourceViewer(dependencyId, options = {}) {
    const dependency = this.getDependency(dependencyId);
    const source = semanticDependencySource(dependency);
    const file = this.timeline.snapshotFile(source.snapshotId, source.path);
    if (!file) throw new HttpError(404, 'The indexed source version is no longer available.');
    const buffer = this.timeline.blobs.get(file.contentHash);
    const fileUrl = `/api/dependencies/${encodeURIComponent(dependencyId)}/source-file`;
    const base = {
      dependencyId,
      source,
      path: file.path,
      fileType: file.fileType,
      version: this.timeline.snapshotRecord(source.snapshotId)?.version ?? null,
      fileUrl,
    };

    if (source.metadata?.drawing && file.fileType !== 'pdf') {
      const text = drawingContext(source).text;
      const selectedText = source.metadata.rawText ?? source.valueText ?? '';
      return { ...base, kind: 'document', text,
        selectedText, selectedStart: selectedText ? text.indexOf(selectedText) : -1,
        locationLabel: [source.metadata.elementId, source.metadata.propertySet, source.metadata.propertyName].filter(Boolean).join(' · ') };
    }

    if (file.fileType === 'pdf') {
      let pageNumber = Number(source.anchor?.pageNumber) || 1;
      if (source.objectType === 'FIGURE') {
        try { pageNumber = this.figurePreviewImage(dependencyId).pageNumber || pageNumber; } catch { /* open at page one */ }
      }
      return {
        ...base,
        kind: 'pdf',
        pageNumber,
        selectedText: source.anchor?.selectedText ?? source.metadata.rawText ?? '',
        locationLabel: `${source.metadata.componentLabel ?? source.label}${pageNumber ? ` · page ${pageNumber}` : ''}`,
      };
    }

    if (['table', 'spreadsheet'].includes(file.fileType)) {
      // A large table shows the rows around the cited one, from the table index.
      const window = this.tableWindow(file, buffer, source.anchor ?? {}, {
        before: 2_500, after: 2_500, sheet: String(options.sheet ?? '').trim() || null });
      const anchor = window?.anchor ?? source.anchor;
      const tables = window ? [window.table] : file.fileType === 'spreadsheet'
        ? extractSpreadsheetTables(buffer)
        : [{
          name: path.posix.basename(file.path),
          rows: parseDelimited(buffer.toString('utf8'), path.extname(file.path).toLowerCase() === '.tsv' ? '\t' : ','),
        }];
      if (!tables.length) return { ...base, kind: 'binary', locationLabel: source.label };
      const requestedSheet = String(options.sheet ?? '').trim();
      const table = tables.find((candidate) => candidate.name === requestedSheet)
        ?? tables.find((candidate) => candidate.name === source.anchor?.sheet)
        ?? tables[0];
      const layout = file.fileType === 'spreadsheet' || window ? spreadsheetLayout(table) : tabularLayout(table.rows);
      const rowReference = anchor?.kind === 'table-row';
      const selectedColumn = rowReference ? -1
        : Number.isInteger(anchor?.columnIndex) ? anchor.columnIndex
          : layout.headers.findIndex((header) => String(header) === String(anchor?.column));
      let selectedRow = Number.isInteger(anchor?.rowIndex)
        ? (layout.rowNumbers && anchor.rowCoordinate === 'worksheet' ? layout.rowNumbers.indexOf(anchor.rowIndex) : anchor.rowIndex - layout.headerRowIndex - 1) : -1;
      if (selectedRow < 0 || selectedRow >= layout.rows.length) {
        selectedRow = layout.rows.findIndex((row) => String(row[0] ?? '') === String(anchor?.rowKey ?? ''));
      }
      const isIndexedSheet = !anchor?.sheet || table.name === anchor.sheet;
      // Show numbers as the sheet does ($129,950); rows were matched on stored values above.
      const rows = layout.rows.slice(0, 5000).map((row, index) => {
        const shown = table.displayRows?.[layout.headerRowIndex + 1 + index];
        return shown?.length ? row.map((cell, column) => shown[column] ?? cell) : row;
      });
      return {
        ...base,
        kind: 'table',
        sheet: table.name,
        sheets: window?.sheets ?? tables.map((candidate) => candidate.name),
        headers: layout.headers,
        rows,
        selectedRow: isIndexedSheet ? selectedRow : -1,
        selectedColumn: isIndexedSheet ? selectedColumn : -1,
        truncated: window ? window.totalRows > rows.length : layout.rows.length > rows.length,
        totalRows: window?.totalRows ?? layout.rows.length,
        ...(window ? { firstRow: window.firstRow } : {}),
        locationLabel: [source.anchor?.sheet, source.anchor?.rowKey, rowReference ? null : source.anchor?.column]
          .filter(Boolean).join(' · ') || source.label,
      };
    }

    if (file.fileType === 'image') {
      return { ...base, kind: 'image', locationLabel: source.label };
    }

    let text;
    if (file.fileType === 'document') text = extractDocxDocument(buffer).textExcerpt;
    else if (file.fileType === 'presentation') text = this.fileText(file, source.objectType);
    else if (['markdown', 'text', 'code', 'yaml', 'json', 'notebook'].includes(file.fileType)) text = buffer.toString('utf8');
    if (text != null) {
      const selectedText = String(source.valueText ?? dependency.spanText ?? source.label ?? '').trim();
      const selectedStart = selectedText ? text.toLowerCase().indexOf(selectedText.toLowerCase()) : -1;
      return {
        ...base,
        kind: 'document',
        text: text.slice(0, 250_000),
        truncated: text.length > 250_000,
        selectedText,
        selectedStart,
        locationLabel: source.label,
      };
    }

    return { ...base, kind: 'binary', locationLabel: source.label };
  }

  dependencyPreview(dependencyId, options = {}) {
    const dependency = this.getDependency(dependencyId);
    const source = semanticDependencySource(dependency);
    const parsedRadius = Number(options.contextRadius);
    const contextRadius = Number.isFinite(parsedRadius)
      ? Math.max(0, Math.min(5, parsedRadius)) : 1;
    let content;
    if (source.objectType === 'FIGURE' && /\.pdf$/i.test(source.path)) {
      try {
        const rendered = this.figurePreviewImage(dependencyId);
        const rawCaption = String(source.valueText ?? source.metadata.textExcerpt ?? '').trim();
        const caption = wordTokens(rawCaption).length >= 3 ? rawCaption : '';
        content = {
          kind: 'pdf-figure',
          imageUrl: `/api/dependencies/${encodeURIComponent(dependencyId)}/figure-image`,
          label: source.metadata.componentLabel ?? source.label,
          caption,
          pageNumber: rendered.pageNumber,
          located: rendered.located,
        };
      } catch {
        content = this.sharedSourceContent(dependency, 'CONTEXT', contextRadius);
      }
    } else content = this.sharedSourceContent(dependency, 'CONTEXT', contextRadius);
    return {
      claim: dependency.spanText,
      source,
      accessScope: 'CONTEXT',
      content,
    };
  }

  sharedDependency(token) {
    const grant = this.db.prepare(`
      SELECT * FROM dependency_share_grants
      WHERE token = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
    `).get(token, now());
    if (!grant) throw new HttpError(404, 'This source-sharing link is unavailable or has expired.');
    const dependency = this.getDependency(grant.dependency_id);
    if (dependency.removed) throw new HttpError(404, 'This source-sharing link is unavailable or has expired.');
    const source = semanticDependencySource(dependency);
    // Like object shares, publish file names only. Folder names can identify
    // a client or matter, and the owner's manuscript path is private.
    return {
      claim: dependency.spanText,
      source: {
        label: source.label,
        path: path.posix.basename(source.path),
        objectType: source.objectType,
        valueText: source.valueText,
        metadata: {
          title: source.metadata.title ?? null,
          author: source.metadata.author ?? null,
          year: source.metadata.year ?? null,
          variable: source.metadata.variable ?? source.metadata.column ?? null,
          row: source.metadata.row ?? source.anchor?.rowKey ?? null,
          column: source.metadata.column ?? source.anchor?.column ?? null,
        },
      },
      access: {
        scope: grant.access_scope,
        recipientLabel: grant.recipient_label,
        expiresAt: grant.expires_at,
      },
      content: this.sharedSourceContent(dependency, grant.access_scope, grant.context_radius),
    };
  }

  currentDependencies(projectId, options = {}) {
    const project = this.timeline.getProject(projectId);
    const snapshot = this.db.prepare('SELECT version, project_id FROM snapshots WHERE id = ?')
      .get(options.snapshotId ?? project.currentSnapshotId);
    if (!snapshot) throw new HttpError(404, 'Snapshot not found.');
    if (snapshot.project_id !== projectId) throw new HttpError(400, 'Snapshot does not belong to this project.');
    const maximum = snapshot.version;
    const ids = this.db.prepare(`
      SELECT d.id FROM claim_dependencies d
      WHERE d.project_id = ? AND (? IS NULL OR d.document_project_file_id = ?)
      ORDER BY d.created_at
    `).all(projectId, options.projectFileId ?? null, options.projectFileId ?? null);
    return ids.map(({ id: dependencyId }) => this.mapDependency(this.latestVersionRow(dependencyId, maximum)))
      .filter((dependency) => dependency && !dependency.removed);
  }

  findForSelection(projectId, { projectFileId, snapshotId, anchor }) {
    const dependencies = this.currentDependencies(projectId, { projectFileId, snapshotId });
    return dependencies.find((dependency) => {
      if (dependency.anchor.blockIndex !== anchor.blockIndex) return false;
      const selection = anchor.selection ?? { start: anchor.start, end: anchor.end };
      const start = selection?.start ?? 0;
      const end = selection?.end ?? Number.MAX_SAFE_INTEGER;
      return dependency.anchor.start < end && dependency.anchor.end > start;
    }) ?? null;
  }

  revise(dependencyId, actorInput, input) {
    const currentDependency = this.getDependency(dependencyId);
    const project = this.timeline.getProject(this.db.prepare('SELECT project_id FROM claim_dependencies WHERE id = ?').get(dependencyId).project_id);
    if (input.expectedSnapshotId && input.expectedSnapshotId !== project.currentSnapshotId) {
      throw new VersionConflictError(input.expectedSnapshotId, project.currentSnapshotId);
    }
    let nextSource = currentDependency.source;
    if (input.sourceObjectId) {
      const row = this.sourceVersion(input.sourceObjectId, input.sourceSnapshotId, {
        destinationProjectId: project.id, newLink: input.sourceObjectId !== currentDependency.source.id,
      });
      if (!row) throw new HttpError(404, 'Replacement scientific object not found.');
      nextSource = {
        id: row.object_id, projectId: row.project_id, objectKey: row.object_key, objectType: row.object_type, snapshotId: row.snapshot_id,
        path: row.path, anchor: json(row.anchor_json, null), label: row.label, valueText: row.value_text,
        contentHash: row.content_hash, metadata: json(row.metadata_json, {}),
      };
    }
    const removed = input.action === 'REMOVE';
    // A revision may carry the document text the claim now reads, when the
    // caller rewrote it in the same action. The anchor is recomputed from the
    // current document rather than trusted from the caller.
    let nextSpanText = currentDependency.spanText;
    let nextAnchor = currentDependency.anchor;
    if (typeof input.spanText === 'string' && input.spanText && input.spanText !== currentDependency.spanText) {
      const file = this.timeline.snapshotFile(project.currentSnapshotId, currentDependency.documentPath);
      if (!file) throw new HttpError(409, 'The document holding this claim is no longer present.');
      const blocks = this.editableDocumentModel(project.id, file, project.currentSnapshotId).blocks;
      const blockIndex = blocks.findIndex((block, index) => (index === currentDependency.anchor.blockIndex
        && block.text.includes(input.spanText)));
      const resolvedIndex = blockIndex >= 0 ? blockIndex : blocks.findIndex((block) => block.text.includes(input.spanText));
      if (resolvedIndex < 0) throw new HttpError(409, 'The revised claim text is not present in the document.');
      const block = blocks[resolvedIndex];
      const start = block.text.indexOf(input.spanText);
      nextSpanText = input.spanText;
      nextAnchor = anchorForSpan(resolvedIndex, block.type, block.text, start, start + input.spanText.length);
    }
    const nextStatus = removed ? currentDependency.status
      : input.action === 'KEEP_HISTORICAL' ? 'LINKED'
      : STATUS_TYPES.has(input.status) ? input.status : 'LINKED';
    const changeType = removed ? 'DEPENDENCY_REMOVED'
      : input.action === 'KEEP_HISTORICAL' ? 'DEPENDENCY_REVIEWED' : 'DEPENDENCY_CHANGED';
    const result = this.cloneTransition(project.id, actorInput, {
      source: changeType, title: removed ? `Removed dependency from “${currentDependency.spanText.slice(0, 64)}”`
        : `Updated dependency for “${currentDependency.spanText.slice(0, 64)}”`,
    }, ({ resultingSnapshotId, eventId, timestamp, actor }) => {
      const versionId = id();
      const statusDetails = input.action === 'KEEP_HISTORICAL' ? { pinnedHistoricalVersion: true } : {};
      this.db.prepare(`
        INSERT INTO claim_dependency_versions(
          id, dependency_id, snapshot_id, document_snapshot_id, document_path, document_anchor_json, span_text,
          source_object_id, source_snapshot_id, source_value_text, selection_method, confidence, status,
          status_details_json, created_by_actor_id, created_at, is_removed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        versionId, dependencyId, resultingSnapshotId, resultingSnapshotId, currentDependency.documentPath,
        JSON.stringify(nextAnchor), nextSpanText, nextSource.id, nextSource.snapshotId,
        nextSource.valueText, input.sourceObjectId ? 'MANUAL' : currentDependency.selectionMethod,
        input.confidence ?? currentDependency.confidence, nextStatus, JSON.stringify(statusDetails), actor.id, timestamp, removed ? 1 : 0,
      );
      this.db.prepare(`
        INSERT INTO dependency_changes(id, event_id, dependency_id, before_version_id, after_version_id, change_type, details_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id(), eventId, dependencyId, currentDependency.versionId, versionId, changeType, JSON.stringify({ previousSource: currentDependency.source.label, source: nextSource.label }));
      // A removed claim no longer appears in the share tools, so its links
      // must close with it rather than stay public with no way to revoke them.
      if (removed) {
        this.db.prepare('UPDATE dependency_share_grants SET revoked_at = ? WHERE dependency_id = ? AND revoked_at IS NULL')
          .run(timestamp, dependencyId);
      }
      if (!removed) {
        this.db.prepare(`
          INSERT INTO provenance_links(id, project_id, from_snapshot_id, from_path, from_anchor_json, relation,
            to_snapshot_id, to_path, to_anchor_json, metadata_json, created_by_event_id, created_at)
          VALUES (?, ?, ?, ?, ?, 'DEPENDS_ON', ?, ?, ?, ?, ?, ?)
        `).run(id(), project.id, resultingSnapshotId, currentDependency.documentPath, JSON.stringify(nextAnchor),
          nextSource.snapshotId, nextSource.path, nextSource.anchor ? JSON.stringify(nextSource.anchor) : null,
          JSON.stringify({ dependencyId, objectId: nextSource.id, objectType: nextSource.objectType, label: nextSource.label, value: nextSource.valueText }), eventId, timestamp);
      }
    });
    return { dependency: removed ? null : this.getDependency(dependencyId), ...result };
  }

  /**
   * Locates each block of a document inside its own content, so an edit can be
   * spliced at an exact offset. Blocks are contiguous and in order, so a
   * forward scan is exact even when two paragraphs read identically.
   */
  locatedBlocks(content, blocks) {
    let cursor = 0;
    return blocks.map((block) => {
      const start = content.indexOf(block.text, cursor);
      if (start < 0) return { ...block, start: -1, end: -1 };
      cursor = start + block.text.length;
      return { ...block, start, end: start + block.text.length };
    });
  }

  /**
   * The exact document edits that would bring every reference to one source
   * back in line with it. Returns a plan; nothing is written.
   *
   * A reference whose text does not literally contain the value it was linked
   * to is reported as needing a person, never rewritten on a guess.
   */
  planSourceValueUpdate(projectId, objectId, options = {}) {
    const project = this.timeline.getProject(projectId);
    const source = this.sourceVersion(objectId);
    const current = source ? mapObjectRow(source) : null;
    if (!current) throw new HttpError(404, 'That source is no longer present in the current version.');
    const wanted = options.dependencyIds ? new Set(options.dependencyIds) : null;
    const dependencies = this.currentDependencies(projectId)
      .filter((dependency) => dependency.source.id === objectId)
      .filter((dependency) => !wanted || wanted.has(dependency.id));
    if (current.projectId !== projectId && !dependencies.length) {
      throw new HttpError(404, 'That source is not referenced in this work directory.');
    }

    const documents = new Map();
    const edits = [];
    for (const dependency of dependencies) {
      const linkedValue = dependency.source.valueText ?? null;
      const base = {
        dependencyId: dependency.id,
        documentPath: dependency.documentPath,
        blockIndex: dependency.anchor?.blockIndex ?? null,
        spanText: dependency.spanText,
        linkedValue,
        currentValue: current.valueText ?? null,
        status: dependency.status,
      };
      if (linkedValue != null && current.valueText != null && linkedValue === current.valueText
        && dependency.status === 'LINKED') {
        edits.push({ ...base, action: 'ALREADY_CURRENT' });
        continue;
      }
      if (!documents.has(dependency.documentPath)) {
        const file = this.timeline.snapshotFile(project.currentSnapshotId, dependency.documentPath);
        if (!file) {
          edits.push({ ...base, action: 'MANUAL', reason: 'The document is no longer present.' });
          continue;
        }
        const model = this.editableDocumentModel(projectId, file, project.currentSnapshotId);
        documents.set(dependency.documentPath, {
          file,
          content: model.content,
          blocks: this.locatedBlocks(model.content, model.blocks),
        });
      }
      const document_ = documents.get(dependency.documentPath);
      const block = document_.blocks[dependency.anchor?.blockIndex];
      if (!block || block.start < 0) {
        edits.push({ ...base, action: 'MANUAL', reason: 'The anchored paragraph no longer resolves.' });
        continue;
      }
      const span = block.text.slice(dependency.anchor.start, dependency.anchor.end);
      if (span !== dependency.spanText) {
        edits.push({ ...base, action: 'MANUAL', reason: 'The claim text has moved since it was linked.' });
        continue;
      }
      if (linkedValue == null || current.valueText == null || !span.includes(linkedValue)) {
        edits.push({
          ...base,
          action: 'RELINK',
          reason: linkedValue == null || current.valueText == null
            ? 'This source has no recorded value to substitute.'
            : `The claim does not repeat the linked value ${linkedValue}.`,
        });
        continue;
      }
      const replaced = span.replace(linkedValue, current.valueText);
      edits.push({
        ...base,
        action: 'REWRITE',
        nextSpanText: replaced,
        offset: block.start + dependency.anchor.start,
        length: span.length,
      });
    }

    return {
      object: {
        id: current.id,
        projectId: current.projectId,
        snapshotId: current.snapshotId,
        objectKey: current.objectKey,
        path: current.path,
        label: current.label,
        value: current.valueText ?? null,
      },
      documents: [...documents.keys()],
      edits,
      rewrites: edits.filter((edit) => edit.action === 'REWRITE').length,
      relinks: edits.filter((edit) => edit.action === 'RELINK').length,
      manual: edits.filter((edit) => edit.action === 'MANUAL').length,
      alreadyCurrent: edits.filter((edit) => edit.action === 'ALREADY_CURRENT').length,
    };
  }

  validateSourceValueUpdate(projectId, plan, actorInput) {
    const actor = this.timeline.validateActor(actorInput);
    const changes = plan.edits.filter((edit) => ['REWRITE', 'RELINK'].includes(edit.action));
    if (!changes.length) return actor;
    // Watcher capture is debounced. Check all reviewed files before the first
    // write, since saving one document also captures the rest of its directory.
    const project = this.timeline.getProject(projectId);
    const sourceProject = this.timeline.getProject(plan.object.projectId);
    const sourceFile = this.timeline.snapshotFile(plan.object.snapshotId, plan.object.path);
    this.timeline.assertWorkingFileUnchanged(sourceProject, plan.object.path, sourceFile.contentHash);
    for (const documentPath of new Set(changes.map((edit) => edit.documentPath))) {
      const file = this.timeline.snapshotFile(project.currentSnapshotId, documentPath);
      this.timeline.assertWorkingFileUnchanged(project, documentPath, file.contentHash);
    }
    return actor;
  }

  /**
   * Applies a plan: rewrites the documents, then re-points each dependency at
   * the current source version. Documents are only ever written from an
   * explicit call to this method.
   */
  applySourceValueUpdate(projectId, objectId, actorInput, options = {}) {
    const plan = this.planSourceValueUpdate(projectId, objectId, options);
    const actor = this.validateSourceValueUpdate(projectId, plan, actorInput);
    const rewrites = plan.edits.filter((edit) => edit.action === 'REWRITE');
    const relinks = plan.edits.filter((edit) => edit.action === 'RELINK');
    if (!rewrites.length && !relinks.length) return { ...plan, applied: [], captures: [] };

    const byDocument = new Map();
    for (const edit of rewrites) {
      const list = byDocument.get(edit.documentPath) ?? [];
      list.push(edit);
      byDocument.set(edit.documentPath, list);
    }

    const captures = [];
    for (const [documentPath, documentEdits] of byDocument) {
      const project = this.timeline.getProject(projectId);
      const file = this.timeline.snapshotFile(project.currentSnapshotId, documentPath);
      const model = this.editableDocumentModel(projectId, file, project.currentSnapshotId);
      let content = model.content;
      for (const edit of [...documentEdits].sort((left, right) => right.offset - left.offset)) {
        content = content.slice(0, edit.offset) + edit.nextSpanText + content.slice(edit.offset + edit.length);
      }
      captures.push(this.saveDocument(projectId, {
        path: documentPath,
        content,
        baseSnapshotId: project.currentSnapshotId,
      }, actor));
    }

    const applied = [];
    for (const edit of [...rewrites, ...relinks]) {
      const revision = this.revise(edit.dependencyId, actor, {
        sourceObjectId: objectId,
        sourceSnapshotId: plan.object.snapshotId,
        status: 'LINKED',
        ...(edit.action === 'REWRITE' ? { spanText: edit.nextSpanText } : {}),
      });
      applied.push({
        dependencyId: edit.dependencyId,
        documentPath: edit.documentPath,
        action: edit.action,
        previousSpanText: edit.spanText,
        spanText: edit.action === 'REWRITE' ? edit.nextSpanText : edit.spanText,
        version: revision.resultingVersion ?? null,
      });
    }
    return { ...plan, applied, captures };
  }

  /** Records a decision to leave a reference on the value it was linked to. */
  /**
   * Claims whose text the document no longer holds. These keep their last
   * known anchor so they can be reviewed, but they point at nothing, so the
   * editor cannot reach them — the terminal retires them instead.
   */
  unresolvedDependencies(projectId) {
    return this.currentDependencies(projectId)
      .filter((dependency) => Boolean(dependency.statusDetails?.anchorIssue));
  }

  /**
   * Retires references. Removal is a recorded revision, not a deletion: the
   * dependency's history stays intact and the claim simply stops being linked.
   */
  removeReferences(projectId, { objectId = null, dependencyIds = null, unresolvedOnly = false }, actorInput) {
    const actor = normalizeActor(actorInput);
    const wanted = dependencyIds ? new Set(dependencyIds) : null;
    const targets = this.currentDependencies(projectId)
      .filter((dependency) => !objectId || dependency.source.id === objectId)
      .filter((dependency) => !wanted || wanted.has(dependency.id))
      .filter((dependency) => !unresolvedOnly || Boolean(dependency.statusDetails?.anchorIssue));
    const removed = [];
    for (const dependency of targets) {
      this.revise(dependency.id, actor, { action: 'REMOVE' });
      removed.push({
        dependencyId: dependency.id,
        documentPath: dependency.documentPath,
        spanText: dependency.spanText,
        status: dependency.status,
        reason: dependency.statusDetails?.anchorIssue ?? null,
      });
    }
    return { removed };
  }

  keepCurrentValue(projectId, objectId, actorInput, options = {}) {
    const actor = normalizeActor(actorInput);
    const wanted = options.dependencyIds ? new Set(options.dependencyIds) : null;
    const dependencies = this.currentDependencies(projectId)
      .filter((dependency) => dependency.source.id === objectId)
      .filter((dependency) => !wanted || wanted.has(dependency.id))
      .filter((dependency) => dependency.status !== 'LINKED');
    const kept = [];
    for (const dependency of dependencies) {
      this.revise(dependency.id, actor, { action: 'KEEP_HISTORICAL' });
      kept.push({ dependencyId: dependency.id, documentPath: dependency.documentPath, spanText: dependency.spanText });
    }
    return { kept };
  }

  /**
   * How much of a recorded neighbour survived, 0..1.
   *
   * The prefix is compared from its end and the suffix from its start, since
   * those are the characters nearest the claim and the last to be disturbed by
   * an edit elsewhere in the paragraph.
   */
  static contextOverlap(recorded, actual, side) {
    const expected = String(recorded ?? '');
    if (!expected) return 1;               // nothing recorded to contradict
    const found = String(actual ?? '');
    let shared = 0;
    const limit = Math.min(expected.length, found.length);
    while (shared < limit) {
      const left = side === 'prefix' ? expected[expected.length - 1 - shared] : expected[shared];
      const right = side === 'prefix' ? found[found.length - 1 - shared] : found[shared];
      if (left !== right) break;
      shared += 1;
    }
    return shared / expected.length;
  }

  /**
   * Where a claim now sits in a document, or nothing.
   *
   * The span text alone is not enough to identify a claim: a document that
   * once said "the supplies cost 400" and now says "i looked at supplies"
   * contains the word but not the claim. Every candidate occurrence is
   * corroborated against the text recorded either side of it, so an edited
   * paragraph still resolves while a deleted one does not quietly reattach to
   * whatever the user types next.
   */
  relocateSpan(dependency, blocks) {
    const anchor = dependency.anchor ?? {};
    const { spanText } = dependency;
    if (!spanText) return null;
    const fingerprint = (text) => sha(String(text).trim().replace(/\s+/g, ' '));

    const candidates = [];
    for (const [index, block] of blocks.entries()) {
      let from = 0;
      for (;;) {
        const start = block.text.indexOf(spanText, from);
        if (start < 0) break;
        from = start + Math.max(1, spanText.length);
        const end = start + spanText.length;
        const before = block.text.slice(Math.max(0, start - 32), start);
        const after = block.text.slice(end, end + 32);
        const prefix = PredictiveProvenanceService.contextOverlap(anchor.prefix, before, 'prefix');
        const suffix = PredictiveProvenanceService.contextOverlap(anchor.suffix, after, 'suffix');
        candidates.push({
          index,
          block,
          start,
          end,
          context: (prefix + suffix) / 2,
          // The paragraph being untouched is the strongest corroboration there
          // is, and it covers a claim that fills its block entirely.
          sameBlock: anchor.blockFingerprint === fingerprint(block.text),
          samePosition: index === anchor.blockIndex && start === anchor.start,
        });
      }
    }
    if (!candidates.length) return null;

    candidates.sort((left, right) => Number(right.sameBlock) - Number(left.sameBlock)
      || right.context - left.context
      || Number(right.samePosition) - Number(left.samePosition)
      || Math.abs(left.index - (anchor.blockIndex ?? 0)) - Math.abs(right.index - (anchor.blockIndex ?? 0)));

    const best = candidates[0];
    // Half the recorded neighbourhood, averaged across both sides, is enough
    // to call it the same claim in an edited paragraph. Less than that and the
    // text around it is somebody else's sentence.
    if (!best.sameBlock && best.context < 0.5) return null;
    // Two equally corroborated occurrences are not one claim.
    const rivals = candidates.filter((candidate) => candidate !== best
      && candidate.sameBlock === best.sameBlock && candidate.context === best.context);
    if (rivals.length && !best.samePosition) return null;
    return best;
  }

  migrateAnchor(dependency, snapshotId) {
    const file = this.timeline.snapshotFileRow(snapshotId,
      this.db.prepare('SELECT document_project_file_id FROM claim_dependencies WHERE id = ?').get(dependency.id).document_project_file_id);
    if (!file) return { status: 'NEEDS_REVIEW', anchor: dependency.anchor, reason: 'Document no longer exists.' };
    // Already evaluated against this document version: nothing new can be
    // learned, so whatever was recorded then still stands. Returning no reason
    // here would erase it on the next pass.
    if (dependency.documentSnapshotId === snapshotId) {
      return {
        status: dependency.status,
        anchor: dependency.anchor,
        reason: dependency.statusDetails?.anchorIssue ?? null,
      };
    }
    const projectId = this.db.prepare('SELECT project_id FROM claim_dependencies WHERE id = ?').get(dependency.id).project_id;
    const blocks = this.editableDocumentModel(projectId, {
      ...file,
      projectFileId: file.project_file_id,
      contentHash: file.content_hash,
      fileType: file.file_type,
    }, snapshotId).blocks;

    const located = this.relocateSpan(dependency, blocks);
    if (!located) {
      return {
        status: 'NEEDS_REVIEW',
        anchor: dependency.anchor,
        reason: blocks.some((block) => block.text.includes(dependency.spanText))
          ? 'The claim text appears in the document, but not in the wording it was linked to.'
          : 'The claim is no longer in the document.',
      };
    }
    return {
      status: dependency.status,
      anchor: anchorForSpan(located.index, located.block.type, located.block.text, located.start, located.end),
    };
  }

  reconcileAfterCapture(capture) {
    if (!capture?.changed || !capture.projectId) return;
    const destinations = this.db.prepare(`
      SELECT DISTINCT d.project_id FROM claim_dependencies d
      LEFT JOIN claim_dependency_versions v ON v.dependency_id = d.id
      LEFT JOIN scientific_objects o ON o.id = v.source_object_id
      WHERE d.project_id = ? OR o.project_id = ?
    `).all(capture.projectId, capture.projectId);
    for (const destination of destinations) {
      if (this.reconcilingProjects.has(destination.project_id)) continue;
      this.reconcilingProjects.add(destination.project_id);
      try {
        this.reconcileProject(destination.project_id,
          destination.project_id === capture.projectId ? capture.snapshot.id : null);
      } finally {
        this.reconcilingProjects.delete(destination.project_id);
      }
    }
  }

  reconcileProject(projectId, sourceSnapshotId = null, options = {}) {
    const project = this.timeline.getProject(projectId);
    const targetSnapshotId = sourceSnapshotId ?? project.currentSnapshotId;
    const dependencies = this.currentDependencies(projectId, { snapshotId: targetSnapshotId });
    if (!dependencies.length) return { changed: false };
    this.ensureIndex(projectId, targetSnapshotId);
    const changes = [];
    for (const dependency of dependencies) {
      const migration = this.migrateAnchor(dependency, targetSnapshotId);
      let status = migration.status;
      let details = migration.reason ? { anchorIssue: migration.reason } : {};
      const ownerId = this.sourceProjectId(dependency.source);
      const currentSource = this.sourceVersion(dependency.source.id,
        ownerId === projectId ? targetSnapshotId : null);
      if (!currentSource) {
        // A re-index passes its own verdict here: the source object is absent
        // from the new reading, not gone from the record.
        status = options.missingSource?.status ?? 'BROKEN';
        details = {
          ...details,
          sourceIssue: options.missingSource?.reason ?? 'The linked scientific object no longer resolves.',
        };
      } else if (!dependency.statusDetails.pinnedHistoricalVersion
        && (currentSource.content_hash !== dependency.source.contentHash || currentSource.value_text !== dependency.source.valueText)) {
        // A claim whose location is unknown stays under review: there is
        // nowhere to apply a new value, so reporting it as merely stale would
        // offer an update that cannot be made.
        if (!migration.reason) status = 'STALE';
        details = {
          ...details,
          linkedSourceValue: dependency.source.valueText,
          currentSourceValue: currentSource.value_text,
          currentSourceContentHash: currentSource.content_hash,
        };
      }
      // A claim the document no longer holds is retired rather than left as a
      // permanent warning: the user deleted the text, so the link to it is
      // gone. The version chain keeps the record, so nothing is lost.
      const retired = Boolean(migration.reason) && migration.reason !== 'Document no longer exists.';
      if (retired) details = { ...details, retiredReason: migration.reason };
      const anchorChanged = JSON.stringify(migration.anchor) !== JSON.stringify(dependency.anchor);
      const detailsChanged = JSON.stringify(details) !== JSON.stringify(dependency.statusDetails);
      if (retired || status !== dependency.status || anchorChanged
        || (['STALE', 'BROKEN', 'NEEDS_REVIEW'].includes(status) && detailsChanged)) {
        changes.push({ dependency, status, details, anchor: migration.anchor, retired });
      }
    }
    if (!changes.length) return { changed: false };
    const system = { id: 'system:lasso', displayName: 'Lasso', actorType: 'SYSTEM' };
    const source = changes.some((change) => change.status === 'STALE') ? 'DEPENDENCY_STALE'
      : changes.some((change) => change.status === 'NEEDS_REVIEW') ? 'DEPENDENCY_CHANGED' : 'DEPENDENCY_CHANGED';
    const title = changes.length === 1
      ? changes[0].retired ? `Dependency retired: “${changes[0].dependency.spanText.slice(0, 56)}”`
        : changes[0].status === 'STALE' ? `Dependency marked stale: “${changes[0].dependency.spanText.slice(0, 56)}”`
        : changes[0].status === 'BROKEN' ? `Dependency broken: “${changes[0].dependency.spanText.slice(0, 56)}”`
        : `Dependency needs review: “${changes[0].dependency.spanText.slice(0, 56)}”`
      : `${changes.length} manuscript dependencies updated`;
    const result = this.cloneTransition(projectId, system, { source, title }, ({ resultingSnapshotId, eventId, timestamp, actor }) => {
      for (const change of changes) {
        const versionId = id();
        this.db.prepare(`
          INSERT INTO claim_dependency_versions(
            id, dependency_id, snapshot_id, document_snapshot_id, document_path, document_anchor_json, span_text,
            source_object_id, source_snapshot_id, source_value_text, selection_method, confidence, status,
            status_details_json, created_by_actor_id, created_at, is_removed
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          versionId, change.dependency.id, resultingSnapshotId, resultingSnapshotId, change.dependency.documentPath,
          JSON.stringify(change.anchor), change.dependency.spanText, change.dependency.source.id,
          change.dependency.source.snapshotId, change.dependency.source.valueText, change.dependency.selectionMethod,
          change.dependency.confidence, change.status, JSON.stringify(change.details), actor.id, timestamp,
          change.retired ? 1 : 0,
        );
        const changeType = change.retired ? 'DEPENDENCY_REMOVED'
          : change.status === 'STALE' ? 'DEPENDENCY_STALE' : 'DEPENDENCY_CHANGED';
        this.db.prepare(`
          INSERT INTO dependency_changes(id, event_id, dependency_id, before_version_id, after_version_id, change_type, details_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id(), eventId, change.dependency.id, change.dependency.versionId, versionId, changeType, JSON.stringify(change.details));
        if (change.retired) continue;
        this.db.prepare(`
          INSERT INTO provenance_links(id, project_id, from_snapshot_id, from_path, from_anchor_json, relation,
            to_snapshot_id, to_path, to_anchor_json, metadata_json, created_by_event_id, created_at)
          VALUES (?, ?, ?, ?, ?, 'DEPENDS_ON', ?, ?, ?, ?, ?, ?)
        `).run(
          id(), projectId, resultingSnapshotId, change.dependency.documentPath, JSON.stringify(change.anchor),
          change.dependency.source.snapshotId, change.dependency.source.path,
          change.dependency.source.anchor ? JSON.stringify(change.dependency.source.anchor) : null,
          JSON.stringify({
            dependencyId: change.dependency.id,
            objectId: change.dependency.source.id,
            objectType: change.dependency.source.objectType,
            label: change.dependency.source.label,
            value: change.dependency.source.valueText,
          }),
          eventId, timestamp,
        );
      }
    });
    return { changed: true, ...result };
  }

  audit(projectId, options = {}) {
    if (options.reconcile !== false) this.reconcileProject(projectId);
    const dependencies = this.currentDependencies(projectId, { projectFileId: options.projectFileId });
    const byStatus = Object.fromEntries(['LINKED', 'STALE', 'NEEDS_REVIEW', 'BROKEN'].map((status) => [status, dependencies.filter((item) => item.status === status).length]));
    const detectedClaims = [];
    if (options.projectFileId) {
      const project = this.timeline.getProject(projectId);
      const file = this.timeline.snapshotFileRow(project.currentSnapshotId, options.projectFileId);
      if (file) {
        const blocks = this.editableDocumentModel(projectId, {
          ...file,
          projectFileId: file.project_file_id,
          contentHash: file.content_hash,
          fileType: file.file_type,
        }, project.currentSnapshotId).blocks;
        blocks.forEach((block, blockIndex) => {
          for (const claim of detectClaimSpans(block.text)) {
            const linked = dependencies.some((dependency) => dependency.anchor.blockIndex === blockIndex
              && dependency.anchor.start < claim.end && dependency.anchor.end > claim.start);
            detectedClaims.push({ ...claim, blockIndex, linked });
          }
        });
      }
    }
    return {
      summary: {
        detected: detectedClaims.length || dependencies.length,
        linked: byStatus.LINKED,
        stale: byStatus.STALE,
        needsReview: byStatus.NEEDS_REVIEW,
        broken: byStatus.BROKEN,
        unlinked: detectedClaims.filter((claim) => !claim.linked).length,
      },
      dependencies,
      detectedClaims,
    };
  }

  predictAgentDependencies(projectId, input) {
    if (!/\.(md|mdx|qmd|rmd)$/i.test(input.path ?? '')) return [];
    const proposals = [];
    for (const [blockIndex, block] of diffInternals.markdownBlocks(String(input.content ?? '')).entries()) {
      for (const claim of detectClaimSpans(block.text)) {
        const candidates = this.candidatesForClaim(projectId, claim, { context: block.text, limit: 3 });
        proposals.push({ blockIndex, blockType: block.type, claim, candidates, verified: candidates.length > 0 });
      }
    }
    return proposals;
  }

  acceptAgentDependencies(execution, capture) {
    const proposals = execution.proposal.dependencyProposals ?? [];
    const accepted = [];
    for (const proposal of proposals.filter((item) => item.candidates?.length)) {
      const project = this.timeline.getProject(execution.projectId);
      const document = this.timeline.snapshotFile(project.currentSnapshotId, execution.proposal.path);
      if (!document) continue;
      const text = this.timeline.blobs.get(document.contentHash).toString('utf8');
      const block = diffInternals.markdownBlocks(text)[proposal.blockIndex];
      if (!block) continue;
      const anchor = anchorForSpan(proposal.blockIndex, block.type, block.text, proposal.claim.start, proposal.claim.end);
      accepted.push(this.link(execution.projectId, {
        documentPath: execution.proposal.path,
        anchor,
        spanText: proposal.claim.text,
        sourceObjectId: proposal.candidates[0].id,
        sourceSnapshotId: proposal.candidates[0].snapshotId,
        selectionMethod: 'SYSTEM_LINKED',
        confidence: proposal.candidates[0].score,
        initiatedBy: execution.initiatedBy,
        expectedSnapshotId: project.currentSnapshotId,
      }, execution.agent));
    }
    return accepted;
  }
}

export { anchorForSpan, OBJECT_TYPES, EXTRACTOR_VERSION };
