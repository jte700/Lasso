// A whole file named while writing: "General-Ledger.cs", "the month end close",
// "Bracket". The label is what Tab inserts. A name typed as the file spells it
// completes to that spelling (with the extension once one is typed); plain
// words complete to the file's readable name. Drawings keep their discovery
// label and aliases ("the floor plan"); other files match their name or title.
import { drawingReferenceMatch, genericTitle, humanStem, normalized, phraseMatch, words } from './drawing-discovery.js';

const UNREADABLE = new Set(['unsupported', 'failed', 'error']);

/** Objects that stand for a whole file rather than a passage, row or value. */
export function isWholeFile(object) {
  return ['DRAWING', 'DATASET', 'PAPER'].includes(object?.objectType)
    || (object?.objectType === 'DOCUMENT' && !object.anchor);
}

const fileName = object => String(object.path ?? '').replaceAll('\\', '/').split('/').pop() ?? '';
/** "General-Led", "Bracket.st": the file's own spelling, not words of a sentence. */
export const typedAsWritten = typed => !/\s/.test(String(typed ?? '').trim()) && /[._-]/.test(String(typed ?? ''));
// A workbook's worksheets are separate sources; the sheet keeps them apart.
const withSheet = (object, name) => object.metadata?.sheet ? `${name} · ${object.metadata.sheet}` : name;
const scoreOf = match => match === 'exact' ? 0.98 : 0.93;

function spelledMatch(object, typed, terms) {
  const filename = fileName(object);
  const match = phraseMatch(filename, terms, { shortLast: true });
  if (!match) return null;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const tail = typed.includes('.') ? typed.slice(typed.lastIndexOf('.') + 1).toLowerCase() : null;
  const extensionTyped = dot > 0 && tail !== null && filename.slice(dot + 1).toLowerCase().startsWith(tail);
  return { label: withSheet(object, extensionTyped ? filename : stem), score: scoreOf(match), matchedBy: 'file-name' };
}

// Plain words must begin a name and follow it word for word. The middle of a
// free-text title ("... blood pressure in adults") is ordinary prose.
function leadingMatch(name, terms) {
  const source = words(name), last = terms.length - 1;
  if (terms.length > source.length) return null;
  const fits = terms.every((term, index) => source[index] === term
    || (index === last && term.length >= 2 && source[index].startsWith(term)));
  if (!fits) return null;
  return terms.length === source.length && source[last] === terms[last] ? 'exact' : 'prefix';
}

function wordedMatch(object, terms) {
  // One plain word is more likely part of the sentence than a file's name.
  if (terms.length < 2) return null;
  const stem = humanStem(fileName(object));
  const sheet = object.metadata?.sheet;
  const title = sheet ? null : [object.metadata?.title, object.label].find(value => typeof value === 'string'
    && !genericTitle(value) && normalized(value) !== normalized(stem) && normalized(value) !== normalized(fileName(object)));
  const names = [stem, sheet, title].filter(Boolean)
    .map(name => ({ name, match: leadingMatch(name, terms) })).filter(item => item.match);
  const chosen = names.find(item => item.match === 'exact') ?? names[0];
  if (!chosen) return null;
  return { label: sheet ? `${stem} · ${sheet}` : chosen.name === title ? title : stem,
    score: scoreOf(chosen.match), matchedBy: 'file-name' };
}

/** Return null, or { label, score } for a whole file the typed text names. */
export function fileReferenceMatch(object, typed) {
  if (!isWholeFile(object)) return null;
  const text = String(typed ?? '').trim();
  const terms = words(text);
  if (!terms.length || terms.length > 12 || terms.join('').length < 3) return null;
  const match = typedAsWritten(text) ? spelledMatch(object, text, terms)
    : object.objectType === 'DRAWING' ? drawingReferenceMatch(object, text) : wordedMatch(object, terms);
  if (!match) return null;
  // A native file kept only as a pointer ranks after the model Lasso could read.
  const unreadable = UNREADABLE.has(String(object.metadata?.extractionStatus ?? '').toLowerCase());
  return { ...match, score: unreadable ? match.score - 0.02 : match.score };
}
