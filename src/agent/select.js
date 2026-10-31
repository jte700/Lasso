// Choosing evidence from passages: the fewest sentences that answer a
// question, with the context each needs to be read correctly, within a token
// budget. Pure functions over a file's passages in reading order.
//
// A sentence is scored by the question's words it has, each weighted by how
// rare it is in the library (inverse document frequency), with words of its
// section heading counting for a little. Sentences are taken best first;
// one that repeats what is already taken is skipped, one that adds none of
// the question's words and states nothing (no figure, date or finding)
// outside a section about the question is taken only a few times a file, and
// a section already used counts against a sentence so
// that evidence spread over sections is found rather than five sentences of
// one paragraph. Each taken sentence brings what it cannot be read without:
// the sentence before it when it begins by pointing back ("This difference",
// "However"), the sentence after it when that one qualifies it ("was not
// statistically significant", "was not pre-specified") or goes on about the
// same result ("This difference exceeded …"), and its heading.
// Neighbouring sentences of one paragraph are joined into one excerpt.

import { estimateTokens } from './metrics.js';
import { findingSignal } from '../dependencies/completion.js';

// Openings that point back to the sentence before.
const POINTS_BACK = /^(?:this|these|that|those|it|its|they|their|such|the (?:difference|effect|increase|decrease|change|result|finding|benefit|reduction|association|figure)s?|however|but|yet|nevertheless|nonetheless|in contrast|by contrast|conversely|similarly|likewise|also|moreover|furthermore|in addition|consequently|therefore|thus|as a result|despite this|even so|still|instead|otherwise|here)\b/i;
// A sentence that goes on about the result before it ("This difference exceeded the minimal clinically important difference").
const ELABORATES = /^(?:this|these|that|the|such) (?:difference|effect|finding|result|association|increase|decrease|change|benefit|reduction|improvement|gain|loss|trend|pattern)s?\b/i;
// What a report's sections are for, from their headings. References, acknowledgements and the like are never evidence
// of what it found; background sections (introduction, previous studies) report other work in the same words, so they
// count for less; results and findings sections, and the abstract or summary, hold what it found. A numbered section
// ("4.1 Nitrate") is what its top-level section ("4 Results") is; "3.4 Outcomes and analysis" under "3 Methods" is not
// a result.
const APPARATUS = /\b(?:references|bibliography|acknowledge?ments?|funding|conflicts? of interest|competing interests?|data availability|ethics)\b/i;
const BACKGROUND = /\b(?:introduction|background|previous (?:studies|research|work|trials)|prior (?:studies|research|work)|literature(?: review)?|related work|existing evidence)\b/i;
const FINDINGS = /\b(?:results?|findings?|outcomes?|what (?:the \w+ |we )?found|conclusions?)\b/i;
const SUMMARY = /^(?:abstract|summary|executive summary|key points|at a glance)$/i;

/** Each heading's role: "apparatus", "background", "findings", "summary" or null, from it and its numbered top-level section. */
function headingRoles(ordered) {
  const roles = new Map();
  let top = null;
  for (const heading of ordered) {
    const text = String(heading.text ?? '').trim();
    const number = text.match(/^(\d+)(\.\d+)*\.?\s/);
    if (number && !number[2]) top = text;
    const own = text.replace(/^\d+(?:\.\d+)*\.?\s*/, '');
    const parent = number?.[2] && top?.startsWith(`${number[1]} `) || number?.[2] && top?.startsWith(`${number[1]}.`) ? top.replace(/^\d+(?:\.\d+)*\.?\s*/, '') : own;
    roles.set(heading, APPARATUS.test(own) ? 'apparatus' : SUMMARY.test(own) ? 'summary' : FINDINGS.test(parent) ? 'findings'
      : BACKGROUND.test(parent) ? 'background' : null);
  }
  return roles;
}

// A sentence that limits or conditions the one before it.
const QUALIFIES = /\b(?:however|but|although|though|not (?:statistically )?significant|no longer|did not reach|not pre-?specified|post hoc|exploratory|confidence interval included|included zero|limitation|limited to|caution|should be interpreted|may (?:have )?(?:exaggerat|overestimat|underestimat|bias)|small (?:sample|numbers)|underpowered|not powered|unadjusted|after adjustment|disappeared)\b/i;

const fold = (value) => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Light stemming for matching a question's words to a sentence's, close to
 * what the full-text index's Porter stemmer treats as one word: "completion"
 * and "completed", "measures" and "measured".
 */
export function stem(word) {
  const stemmed = word.replace(/(?:ational|ations?|ions?|ments?|ings?|ies|ied|ers?|ed|es|ly|s|e)$/, '');
  return stemmed.length >= 3 ? stemmed : word;
}

// Stems of the words seen: one ask compares its words with those of thousands of sentences.
const seenStems = new Map();
const stemmed = (word) => {
  let value = seenStems.get(word);
  if (value === undefined) {
    if (seenStems.size >= 50_000) seenStems.clear();
    value = stem(word);
    seenStems.set(word, value);
  }
  return value;
};

/**
 * Whether folded text has a word as the full-text index matches it: the word, a word with the same stem ("savings"
 * and "saved" for "save", "homes" for "home"), or a word beginning with its stem when that has four letters or more
 * ("completed" for "completion"). A shorter stem is not matched as a beginning, which would find other words ("savvy").
 */
export function hasWord(text, word) {
  if (` ${text} `.includes(` ${word} `)) return true;
  const own = stemmed(word);
  return text.split(' ').some((other) => stemmed(other) === own || (own.length >= 4 && other.startsWith(own)));
}

/**
 * Sentences of one file in reading order, from its passages: each sentence
 * with the paragraph (block) it belongs to and the heading above it.
 * `passages` are the file's indexed sentences and paragraphs; `headings`
 * its headings, each `{ at: [page, offset], text }`.
 */
export function readingOrder(passages, headings = []) {
  const position = (object) => [object.anchor?.pageNumber ?? 0, object.anchor?.lineStart ?? 0, object.anchor?.start ?? 0];
  const before = (left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  const sentences = passages.filter((object) => object.metadata?.excerptType !== 'paragraph')
    .sort((left, right) => before(position(left), position(right)));
  const paragraphs = passages.filter((object) => object.metadata?.excerptType === 'paragraph');
  const ordered = [...headings].sort((left, right) => before(left.at, right.at));
  const roles = headingRoles(ordered);
  return sentences.map((object, index) => {
    const at = position(object);
    const block = paragraphs.find((paragraph) => (paragraph.anchor?.pageNumber ?? 0) === at[0] && String(paragraph.valueText ?? '').includes(String(object.valueText ?? '')));
    const under = ordered.filter((item) => before(item.at, at) <= 0).at(-1);
    const heading = under?.text ?? object.metadata?.section ?? object.metadata?.slideTitle ?? null;
    const role = under ? roles.get(under) : heading ? headingRoles([{ text: heading }]).values().next().value : null;
    // A table row is read with its caption and header, and the rows of one table are one block.
    const row = object.metadata?.excerptType === 'table-row';
    return { index, object, text: String(object.valueText ?? ''), heading, role, row,
      block: row ? `table:${at[0]}:${object.metadata.caption}` : block?.id ?? `sentence:${object.id}`,
      context: row ? `${object.metadata.caption ?? ''} ${object.metadata.header ?? ''}` : '' };
  });
}

/**
 * The evidence to show from ranked files' sentences.
 * `files` are `{ key, sentences }` from readingOrder; `weights` maps each
 * question word (folded) to its weight; `budget` is in tokens.
 * Returns the excerpts per file and what was left out.
 */
export function selectEvidence(files, weights, { budget = 600, minShare = 0.2, sectionsAsked = {} } = {}) {
  const terms = [...weights.keys()];
  // How much a sentence's section counts toward the ask: none for a report's apparatus, half for background.
  const roleOf = (sentence) => (sentence.role === 'apparatus' ? (sectionsAsked.apparatus ? 1 : 0)
    : sentence.role === 'background' ? (sectionsAsked.background ? 1 : 0.5) : 1);
  // An ask for what a report found ("the main results of the pilot") is answered by the stating sentences of its
  // findings sections and its summary, which seldom repeat the ask's words: each counts as half the ask's rarest word.
  const found = sectionsAsked.findings ? 0.5 * (Math.max(0, ...weights.values()) || 1) : 0;
  const scoreOf = (sentence) => {
    const own = fold(sentence.text);
    const heading = fold(`${sentence.heading ?? ''} ${sentence.context ?? ''}`);
    const role = roleOf(sentence);
    if (!role) return { score: 0, covered: [] };
    if (found && !sentence.row && ['findings', 'summary'].includes(sentence.role) && states(sentence)) {
      const lexical = scoreOf.lexical(sentence, own, heading);
      // A candidate by where it is, not by its words: the share of the best score that weeds out weak matches does not apply.
      return lexical.score >= found ? lexical : { score: found * (1 + 0.35 * findingSignal(sentence.text)), covered: lexical.covered, structural: true };
    }
    return scoreOf.lexical(sentence, own, heading, role);
  };
  scoreOf.lexical = (sentence, own, heading, role = 1) => {
    let score = 0;
    const covered = [];
    for (const term of terms) {
      if (hasWord(own, term)) { score += weights.get(term); covered.push(term); } else if (heading && hasWord(heading, term)) { score += weights.get(term) * 0.8; covered.push(term); }
    }
    // A sentence that states a fact about the asked-for words reads that way: a figure right beside one of them
    // ("412 participants", "0.6 points"), or the wording of a finding (a comparison, a change, an effect).
    if (score) {
      const words = own.split(' ');
      const beside = words.some((word, at) => /^\d/.test(word) && words.slice(Math.max(0, at - 3), at + 4)
        .some((near) => covered.some((term) => hasWord(near, term))));
      score *= (1 + 0.35 * findingSignal(sentence.text) + (beside ? 0.35 : /\d/.test(sentence.text) ? 0.05 : 0)) * role;
    }
    return { score, covered };
  };
  // A sentence states something when it has a figure or a date, or reads as a finding; a table row always does.
  const states = (sentence) => sentence.row || /\d/.test(sentence.text) || findingSignal(sentence.text) > 0;
  // A section whose heading is mostly the ask's words ("Limitations" for "the trial's limitations") is about what is asked.
  const about = (heading) => {
    const words = fold(heading).split(' ').filter((word) => word.length > 2 && !SMALL_WORDS.has(word));
    return words.length > 0 && words.filter((word) => terms.some((term) => hasWord(word, term))).length / words.length >= 0.5;
  };
  const pool = files.flatMap((file) => file.sentences.map((sentence) => ({ file, sentence, ...scoreOf(sentence) }))).filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
  const best = pool[0]?.score ?? 0;
  const chosen = new Map();
  const taken = [];
  const usedSections = new Map();
  const coveredTerms = new Set();
  let spent = 0;
  let skipped = 0;
  const repeats = new Map();
  const repeatLimit = Math.max(3, Math.floor(budget / 200));
  for (const entry of pool) {
    if (entry.score < best * minShare && !entry.structural) { skipped += 1; continue; }
    const key = `${entry.file.key}|${entry.sentence.index}`;
    if (chosen.has(key)) continue;
    const section = `${entry.file.key}|${entry.sentence.heading ?? ''}`;
    // A sentence that mostly repeats one already taken adds nothing (maximal marginal relevance, on its own words,
    // not the ask's: sentences about one topic share the ask's words and still state different facts).
    const words = contentWords(entry.sentence.text);
    const overlap = Math.max(0, ...taken.map((other) => similarity(words, other)));
    if (overlap > 0.6) { skipped += 1; continue; }
    // A sentence that adds none of the ask's words to those already shown, states nothing and is outside a section about
    // what is asked may be another fact ("The warranty reserve policy is reviewed by the board") or only the same words
    // again, which a long file has in many places: a few a file are shown, more with a larger budget.
    const repeat = !entry.covered.some((term) => !coveredTerms.has(term)) && !states(entry.sentence) && !about(entry.sentence.heading);
    if (repeat && (repeats.get(entry.file.key) ?? 0) >= repeatLimit) { skipped += 1; continue; }
    // Each sentence already taken from its section, and likeness to what was taken, cost it a share of its score.
    const adjusted = entry.score * (0.8 ** (usedSections.get(section) ?? 0)) * (1 - overlap);
    if (adjusted < best * minShare && !entry.structural) { skipped += 1; continue; }
    const context = withContext(entry.file.sentences, entry.sentence.index);
    const cost = context.filter((index) => !chosen.has(`${entry.file.key}|${index}`))
      .reduce((total, index) => total + estimateTokens(entry.file.sentences[index].text) + 2, 0);
    if (spent + cost > budget && chosen.size) { skipped += 1; continue; }
    for (const index of context) chosen.set(`${entry.file.key}|${index}`, { file: entry.file, index, matched: index === entry.sentence.index });
    taken.push(words);
    usedSections.set(section, (usedSections.get(section) ?? 0) + 1);
    for (const term of entry.covered) coveredTerms.add(term);
    if (repeat) repeats.set(entry.file.key, (repeats.get(entry.file.key) ?? 0) + 1);
    spent += cost;
  }
  const excerpts = new Map();
  for (const { file, index } of [...chosen.values()].sort((left, right) => left.file.key.localeCompare(right.file.key) || left.index - right.index)) {
    if (!excerpts.has(file.key)) excerpts.set(file.key, []);
    const list = excerpts.get(file.key);
    const sentence = file.sentences[index];
    const previous = list.at(-1);
    // Neighbouring sentences of one block read as one excerpt; rows of one table, as one table.
    if (previous && previous.block === sentence.block && (sentence.row || previous.last === index - 1)) {
      if (sentence.row) previous.rows.push(sentence.text); else previous.text = `${previous.text} ${sentence.text}`;
      previous.last = index;
      previous.objects.push(sentence.object);
    } else {
      list.push({ first: index, last: index, block: sentence.block, heading: sentence.heading, objects: [sentence.object],
        ...(sentence.row ? { rows: [sentence.text], caption: sentence.object.metadata.caption, header: sentence.object.metadata.header } : { text: sentence.text }) });
    }
  }
  // Sentences that matched well enough to be candidates but were not shown, by section, for asking again with a larger budget.
  const sections = new Map();
  for (const entry of pool) {
    if (entry.score < best * minShare || chosen.has(`${entry.file.key}|${entry.sentence.index}`)) continue;
    const name = entry.sentence.heading ?? '(no heading)';
    sections.set(name, (sections.get(name) ?? 0) + 1);
  }
  const leftOut = [...sections.values()].reduce((total, value) => total + value, 0);
  return { files: [...excerpts.entries()].map(([key, list]) => ({ key, excerpts: list })), shownSentences: chosen.size,
    candidates: pool.length, leftOut, leftOutSections: [...sections.entries()].sort((left, right) => right[1] - left[1]).slice(0, 4),
    coveredTerms: [...coveredTerms], missingTerms: terms.filter((term) => !coveredTerms.has(term)), tokens: spent };
}

const SMALL_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'was', 'were', 'is', 'are', 'be', 'that', 'this', 'it', 'as', 'from']);
const contentWords = (text) => new Set(fold(text).split(' ').filter((word) => word.length > 2 && !SMALL_WORDS.has(word)).map(stem));
/**
 * How alike two sentences' content is: words shared over words in either
 * (Jaccard). Not over the shorter one's words, or a short table row that
 * names the topic would make every sentence about the topic a repeat.
 */
function similarity(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** A sentence and what it cannot be read without: the one before when it points back, the one after when that qualifies it. */
export function withContext(sentences, index) {
  const sentence = sentences[index];
  const indexes = [index];
  const sameBlock = (other) => other && other.block === sentence.block;
  if (POINTS_BACK.test(sentence.text) && sameBlock(sentences[index - 1])) {
    indexes.unshift(index - 1);
    // "This difference …" after "However, …": one step further back is still part of the point.
    if (POINTS_BACK.test(sentences[index - 1].text) && sameBlock(sentences[index - 2])) indexes.unshift(index - 2);
  }
  // A table row stands on its own: its caption and header are shown with it.
  if (sentence.row) return indexes;
  for (const next of [index + 1, index + 2]) {
    if (!sameBlock(sentences[next])) break;
    if (QUALIFIES.test(sentences[next].text) || (next === index + 1 && ELABORATES.test(sentences[next].text))) {
      for (let between = index + 1; between <= next; between += 1) indexes.push(between);
      break;
    }
  }
  return [...new Set(indexes)];
}
