// Whether what was typed is enough to put a card in front of the writer.
// A card costs attention each time it appears, so a couple of letters at the
// start of a word ("Ha" of "Happy") or one everyday word shared with a
// passage ("week") summons nothing. Something the writer is plainly naming
// does: a name's opening letters, several of its words, its own spelling.

import { matchKey } from './direct-match.js';
import { EVERYDAY_WORDS } from './everyday-words.js';

/** Letters of one plain word that begin a name before the name is offered. */
export const NAME_PREFIX_LETTERS = 3;
/** Letters before one plain word is read as a later word of a name ("wage" in "Salaries and wages"). */
export const INNER_WORD_LETTERS = 4;
/** Everyday words a passage shares before they alone offer it; one word of the work itself is enough. */
export const EVERYDAY_WORDS_FOR_PASSAGE = 3;

// "running" and "stopped" are "run" and "stop": every common form of an everyday word is everyday.
const forms = (word) => [word, `${word}s`, `${word}ed`, `${word}ing`, `${word}${word.at(-1)}ed`, `${word}${word.at(-1)}ing`];
const everydayKeys = new Set([...EVERYDAY_WORDS].flatMap(forms).map(matchKey));
const nameWords = (text) => String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * A fragment of one plain word, in lower case; null for several words or for
 * a spelling no sentence word has ("rates.p", "Q3", "gal-3"), which the
 * writer is typing as the source writes it.
 * @param {string} fragment
 * @returns {string|null}
 */
function plainWord(fragment) {
  const text = String(fragment ?? '').trim();
  return /^\p{L}+$/u.test(text) ? text.toLowerCase() : null;
}

/**
 * Whether a name being typed has enough letters to be offered. Several words,
 * or the name spelled out in full, always are.
 * @param {string} fragment the words typed, as the claim holds them
 * @param {{ label?: string, name?: string, metadata?: { variable?: string } }} candidate
 * @param {{ wholeFile?: boolean }} [options] `wholeFile` for a file named by its name
 * @returns {boolean}
 */
export function nameFragmentEarnsCard(fragment, candidate, { wholeFile = false } = {}) {
  const word = plainWord(fragment);
  if (!word) return true;
  const names = [candidate?.label, candidate?.name, candidate?.metadata?.variable].map(nameWords).filter((list) => list.length);
  if (names.some((list) => list.length === 1 && list[0] === word)) return true;
  // An everyday word typed whole is that word ("form", "move"), not the start of a longer name.
  if (EVERYDAY_WORDS.has(word)) return false;
  // A file is matched by its own rules (its stem, its title, what kind of drawing it is).
  if (wholeFile) return word.length >= NAME_PREFIX_LETTERS;
  if (names.some((list) => list[0].startsWith(word))) return word.length >= NAME_PREFIX_LETTERS;
  return word.length >= INNER_WORD_LETTERS && names.some((list) => list.some((part) => part.startsWith(word)));
}

/**
 * Whether the typed words a passage or object shares are enough to offer it:
 * one word that is not an everyday one, or its whole name, or several
 * everyday words together.
 * @param {string[]} sharedKeys match keys of the typed words the object has
 * @param {string[]} labelKeys match keys of the object's own name
 * @returns {boolean}
 */
export function sharedWordsEarnCard(sharedKeys, labelKeys = []) {
  if (!sharedKeys.length) return false;
  if (sharedKeys.some((key) => !everydayKeys.has(key))) return true;
  if (sharedKeys.length >= EVERYDAY_WORDS_FOR_PASSAGE) return true;
  const shared = new Set(sharedKeys);
  return labelKeys.length > 0 && labelKeys.every((key) => shared.has(key));
}
