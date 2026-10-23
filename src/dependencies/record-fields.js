// A note written as a record: a title, then a list of labelled fields
// ("- **Date:** Tuesday, October 27"). Connected apps write every message,
// event and page this way, and many meeting notes look the same. Once the
// record is linked by its title, the word written after it picks a field:
// "on" its date, "at" its time or place, "with" its people.

const FIELD_LINE = /^[-*][ \t]+\*\*([^*\n]{1,40}?):\*\*[ \t]+(\S.*?)[ \t]*$/;
const MINIMUM_FIELDS = 2;

// Tested in order, so "Start date" is a date and "End time" an end.
const ROLES = [
  ['date', /\b(?:date|day|when|due|deadline|received|sent|created|edited|updated|modified|published)\b/i],
  ['end', /\b(?:ends?|until|finish(?:es)?)\b/i],
  ['time', /\b(?:time|starts?)\b/i],
  ['place', /\b(?:location|where|place|room|venue|address|site|city)\b/i],
  ['people', /\b(?:organi[sz]ers?|attendees?|participants?|guests?|with|from|to|cc|bcc|owners?|assignees?|people|authors?|hosts?|by|senders?|recipients?|reviewers?)\b/i],
];

/** What kind of value a field holds, from its label. */
export function fieldRole(label) {
  return ROLES.find(([, pattern]) => pattern.test(String(label ?? '')))?.[0] ?? 'other';
}

// The words that lead on to a field, with the kinds of field they name, most likely first.
const CUES = new Map([
  ['on', ['date', 'place']],
  ['at', ['time', 'place']],
  ['in', ['place', 'date']],
  ['from', ['people', 'time']],
  ['to', ['people', 'end']],
  ['with', ['people']],
  ['by', ['people', 'date']],
  ['until', ['end', 'date']],
  ['till', ['end', 'date']],
]);
// Words that ask for any field ("Meeting with Dr. Lavalee is ...").
const OPEN_CUES = new Set(['is', 'was', 'are', 'were']);
// A field value is a few words; more after the cue is a sentence moving on.
const MAXIMUM_TYPED_WORDS = 4;

/**
 * The cue before the caret in the words after a linked record, with what has
 * been typed of the value since. Null when those words are not reaching for
 * a field ("and Dr. Smith", or a sentence that went on) or name no cue yet.
 */
export function fieldCue(tail) {
  const text = String(tail ?? '');
  const tokens = [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’.]*/gu)];
  for (let index = tokens.length - 1; index >= 0; index--) {
    const word = tokens[index][0].toLowerCase().replace(/[.’']+$/, '');
    if (!CUES.has(word) && !OPEN_CUES.has(word)) continue;
    const typed = text.slice(tokens[index].index + tokens[index][0].length).trim();
    if (typed.split(/\s+/).filter(Boolean).length > MAXIMUM_TYPED_WORDS) return null;
    return { word, roles: CUES.get(word) ?? [], typed };
  }
  // Until a cue is written, the record's fields wait rather than crowd the card.
  return null;
}

/** "Dana Lee <dana@example.com>" reads as "Dana Lee"; a bare address stays. */
export function spokenValue(value) {
  return String(value ?? '').split(/,\s*/).map((part) => {
    const named = part.match(/^(.+?)\s*<[^<>\s]+@[^<>\s]+>$/);
    return named ? named[1].trim() : part.replace(/^<([^<>\s]+@[^<>\s]+)>$/, '$1').trim();
  }).filter(Boolean).join(', ');
}

/**
 * The record a Markdown note holds, or null: its title (the first line, a
 * level-one heading) and the labelled fields listed right under it, each
 * with its offsets and line in the text.
 */
export function recordFields(text) {
  const source = String(text ?? '');
  const lines = source.split('\n');
  let offset = 0;
  let index = 0;
  const advance = () => { offset += lines[index].length + 1; index++; };
  while (index < lines.length && !lines[index].trim()) advance();
  const heading = lines[index]?.match(/^#[ \t]+(.+?)[ \t#]*$/);
  if (!heading) return null;
  const title = heading[1].trim();
  advance();
  while (index < lines.length && !lines[index].trim()) advance();
  const fields = [];
  for (; index < lines.length; advance()) {
    const match = lines[index].match(FIELD_LINE);
    if (!match) break;
    const label = match[1].trim();
    const start = offset + match.index + match[0].lastIndexOf(match[2]);
    fields.push({ label, value: match[2], text: spokenValue(match[2]), role: fieldRole(label),
      start, end: start + match[2].length, line: index + 1 });
  }
  return fields.length >= MINIMUM_FIELDS ? { title, fields } : null;
}
