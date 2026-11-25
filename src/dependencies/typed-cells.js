// Text cells whose value the words being typed spell from their first word:
// an account name, a status or a reference in a column other than the one
// naming its row ("Income tax payable" in a trial balance filed under 2200).
// Row and column names are matched by `progressiveStudyVariable`; these are
// the values beside them, which only a whole sentence used to reach.

import { typedWordKeys } from './direct-match.js';
import { typeCode } from './search-index.js';
import { normalizedCompletionPhrase } from './workspace-completion.js';
import { writingSourceContext } from './writing-context.js';

/** Words back from the caret a typed cell may begin at. */
const PHRASE_WORDS = 6;

/**
 * The phrases ending at the caret, longest first: each run from one of the
 * last few words of the sentence. A cell may begin with a date or a number
 * ("2026-09-30 statement"), so a phrase may too.
 */
function typedPhrases(text, cursor, after) {
  const source = String(text ?? '');
  if (cursor !== source.length) return [];
  const { sentence, sentenceStart } = writingSourceContext(source, cursor);
  const end = sentenceStart + sentence.trimEnd().length;
  return [...sentence.matchAll(/[\p{L}\p{N}][^\s]*/gu)].slice(-PHRASE_WORDS)
    .map((match) => ({ start: sentenceStart + match.index, end }))
    .filter(({ start }) => start > after)
    .map(({ start }) => ({ text: source.slice(start, end), start, end }));
}

/** Cells offered for one typed phrase, at most one per file and value. */
export const TYPED_CELLS_SHOWN = 8;
/** Objects read from a large folder's index before giving up on a phrase. */
const INDEXED_CELLS_READ = 400;
const TEXT_CELL = 'TABLE';

/** The words of a phrase as cells are compared ("Income  tax" is "income tax"). */
const spelled = (text) => normalizedCompletionPhrase(text);

/**
 * Whether `value` is what was typed: the whole of it for one word ("Overdue",
 * since one everyday word is otherwise not enough to show a card), or begun
 * from its first word for several ("income tax pay").
 */
function spellsCell(typed, value, words) {
  const cell = spelled(value);
  return words > 1 ? cell.startsWith(typed) : cell === typed;
}

export const typedCellsMethods = {
  /**
   * The text cells the phrase at the caret spells, as a partial claim's
   * fragment and candidates; null when it spells none. Tab writes the cell
   * as its file holds it over the words typed.
   */
  typedTextCells(projectId, input, cursor, settledAt = -1) {
    const fragments = typedPhrases(input.text, cursor, settledAt);
    for (const fragment of fragments) {
      const typed = spelled(fragment.text);
      const words = typed.split(' ').filter(Boolean).length;
      if (!typed) continue;
      const cells = this.cellsSpelled(projectId, fragment.text, (object) => spellsCell(typed, object.valueText, words))
        .filter((object) => object.path !== input.documentPath);
      if (cells.length) {
        const context = writingSourceContext(input.text, cursor, input.section);
        return { fragment, candidates: this.typedCellCandidates(projectId, cells, typed), context };
      }
    }
    return null;
  },

  /** Text cells holding every complete typed word whose value `fits`. */
  cellsSpelled(projectId, phrase, fits) {
    const keys = lookupKeys(phrase);
    if (!keys.length) return [];
    const permitted = this.autocompleteFilter(projectId);
    const index = this.searchIndexFor(projectId);
    const objects = index ? this.indexedCellsHolding(index, keys) : this.cellsHolding(projectId, keys);
    return objects.filter((object) => object.objectType === TEXT_CELL && object.valueText && fits(object) && permitted(object));
  },

  /** The retrievable objects of a folder held in memory that have every key. */
  cellsHolding(projectId, keys) {
    const objects = this.workspaceRetrievalObjects(projectId);
    const { places } = this.retrievalIndexOf(objects);
    return holdingAll(keys, (key) => places.get(key) ?? []).map((position) => objects[position]);
  },

  /** The same for a folder too large to hold, from its index. */
  indexedCellsHolding(index, keys) {
    const cell = typeCode(TEXT_CELL);
    const positions = holdingAll(keys, (key) => index.own.get(key))
      .filter((position) => index.typeOf[position] === cell).slice(0, INDEXED_CELLS_READ);
    return this.retrievedAt(index, positions);
  },

  /** Each value once per file, the whole value typed first, then the shortest. */
  typedCellCandidates(projectId, cells, typed) {
    const seen = new Set();
    return [...cells]
      .sort((left, right) => Number(spelled(right.valueText) === typed) - Number(spelled(left.valueText) === typed)
        || left.valueText.length - right.valueText.length || left.path.localeCompare(right.path))
      .filter((object) => {
        const key = `${object.path}|${spelled(object.valueText)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, TYPED_CELLS_SHOWN)
      .map((object) => {
        const exact = spelled(object.valueText) === typed;
        return {
          ...this.enrichObject(projectId, object),
          label: object.valueText,
          completionText: object.valueText,
          score: exact ? 0.95 : 0.82,
          matchTier: exact ? 0 : 1,
          reasons: [exact ? 'Exact cell value' : 'Matching cell value'],
        };
      });
  },
};

/**
 * Which of a name match and a cell match the card offers. The one spelling
 * more of what was typed wins ("Income tax payable" over "payable"). Over the
 * same words both are offered: names that are those very words first, then
 * the cells, then names that only contain them.
 * @param {{ fragment: object | null, candidates: object[], context?: object } | null} names
 * @param {{ fragment: object, candidates: object[] } | null} cells
 */
export function namesOrCells(names, cells) {
  if (!cells) return names;
  if (!names?.fragment || !names.candidates.length) return { ...cells, context: names?.context ?? cells.context };
  const nameLength = names.fragment.end - names.fragment.start;
  const cellLength = cells.fragment.end - cells.fragment.start;
  if (cellLength !== nameLength) return cellLength > nameLength ? cells : names;
  const typed = spelled(names.fragment.text);
  const begins = (candidate) => spelled(candidate.label ?? candidate.variable).startsWith(typed);
  const exact = names.candidates.filter((candidate) => spelled(candidate.label ?? candidate.variable) === typed);
  const beginning = names.candidates.filter((candidate) => begins(candidate) && !exact.includes(candidate));
  const containing = names.candidates.filter((candidate) => !begins(candidate));
  return { ...names, candidates: [...exact, ...beginning, ...cells.candidates, ...containing] };
}

/**
 * The keys a cell must hold: every complete word typed, or the only word
 * when there is one. The word being typed may be unfinished, so it is left
 * to the spelling check.
 */
function lookupKeys(phrase) {
  const complete = String(phrase).trim().split(/\s+/);
  const finished = complete.length > 1 ? typedWordKeys(complete.slice(0, -1).join(' ')) : [];
  return finished.length ? finished : typedWordKeys(phrase);
}

/** Positions in every key's list, read from the shortest list. */
function holdingAll(keys, positionsOf) {
  const lists = keys.map((key) => [...positionsOf(key)]).sort((left, right) => left.length - right.length);
  if (!lists.length || !lists[0].length) return [];
  const rest = lists.slice(1).map((list) => new Set(list));
  return lists[0].filter((position) => rest.every((set) => set.has(position)));
}
