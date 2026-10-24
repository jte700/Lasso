// Lines of a programming file named while writing: "server.js line 42",
// "lines 10 through 20", "line 10 to line 20", "line 7 of config.yaml". Tab
// inserts the code itself after the words that named it, every line from the
// first through the last.

/** The most lines one Tab inserts. */
export const MAX_CODE_LINES = 500;

const NUMBER = String.raw`(\d{1,7})`;
const RANGE = String.raw`(?:\s*(?:-|–|—|to|through|thru|till|until)\s*(?:lines?\s+)?${NUMBER})?`;
// Ends where the writer stopped: after the number, a colon or a space.
const MENTION_AT_END = new RegExp(String.raw`\b(?:lines?|ln\.?)\s*#?${NUMBER}${RANGE}\s*:?\s*$`, 'i');
// "line 42 of " just before a file name the writer then accepted.
const MENTION_BEFORE_NAME = new RegExp(String.raw`\b(?:lines?|ln\.?)\s*#?${NUMBER}${RANGE}\s+(?:of|in|from)(?:\s+the)?\s*$`, 'i');
// A file name written just before the lines it names: "server.js line 42", "src/app.py, lines 3-9".
const NAME_BEFORE_MENTION = /(?:^|[\s("'“‘])([\w@+-][\w@.+/-]*\.[A-Za-z0-9]{1,10}|[Dd]ockerfile|[Mm]akefile)[,:]?\s+(?:(?:at|on|in)\s+)?$/;

function lines(match, offset) {
  const first = Number(match[1]);
  const last = match[2] == null ? first : Number(match[2]);
  return { first, last, start: offset + match.index, end: offset + match.index + match[0].length };
}

/**
 * The lines named at the end of `text` (before `cursor`), counted from
 * `from`: { first, last, start, end }, or null. A range typed up to its
 * joining word ("lines 10 through") names nothing until its last number.
 */
export function lineMentionAtEnd(text, from, cursor) {
  const before = String(text ?? '').slice(Math.max(0, from), cursor);
  const match = before.match(MENTION_AT_END);
  return match ? lines(match, Math.max(0, from)) : null;
}

/** "line 42 of " ending at `at`, the start of the file name written after it. */
export function lineMentionBeforeName(text, at) {
  const before = String(text ?? '').slice(0, at);
  const match = before.match(MENTION_BEFORE_NAME);
  return match ? lines(match, 0) : null;
}

/** The file name written just before a mention starting at `at`, with where it starts. */
export function fileNameBefore(text, at) {
  const match = String(text ?? '').slice(0, at).match(NAME_BEFORE_MENTION);
  return match ? { name: match[1], start: at - match[0].length + match[0].indexOf(match[1]) } : null;
}

/**
 * The code of lines `first` through `last` (1-based, both included) as Tab
 * inserts it: one line without its indentation, or the lines on lines of
 * their own, indented as they are relative to each other.
 */
export function codeOfLines(fileLines, first, last) {
  const selected = fileLines.slice(first - 1, last).map((line) => line.replace(/\s+$/, ''));
  if (first === last) return selected[0]?.trim() ?? '';
  const indents = selected.filter((line) => line.trim()).map((line) => line.match(/^[ \t]*/)[0]);
  const shared = indents.reduce((common, indent) => {
    let length = 0;
    while (length < common.length && length < indent.length && common[length] === indent[length]) length += 1;
    return common.slice(0, length);
  }, indents[0] ?? '');
  return selected.map((line) => (line.startsWith(shared) ? line.slice(shared.length) : line.trimStart())).join('\n');
}

/** "Line 42" or "Lines 10–20". */
export function linesLabel(first, last) {
  return first === last ? `Line ${first}` : `Lines ${first}–${last}`;
}

/** The text of a file split into its lines, as editors number them. */
export function fileLines(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  // A final line break ends the last line; it does not start another.
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}
