// How an AI-written span of a file is described to the Mac app and to a
// record: its words with the words either side (to find it again in an app
// showing the file), its lines, and for each mark how much of it is still as
// written.

/** The most spans one file's answer lists. */
export const MOST_SPANS = 400;
/** Characters of context either side of a span. */
export const CONTEXT = 48;

/** For each mark the spans name: letters it holds, and letters inside its reach someone else has written since. */
export function keptByMark(spans, text) {
  const byMark = new Map();
  for (const span of spans) {
    const entry = byMark.get(span.m) ?? { kept: 0, first: span.s, last: span.e, visible: 0 };
    entry.kept += span.e - span.s;
    entry.visible += text.slice(span.s, span.e).replace(/\s+/g, '').length;
    entry.first = Math.min(entry.first, span.s);
    entry.last = Math.max(entry.last, span.e);
    byMark.set(span.m, entry);
  }
  for (const entry of byMark.values()) {
    entry.editedInside = Math.max(0, text.slice(entry.first, entry.last).replace(/\s+/g, '').length - entry.visible);
  }
  return byMark;
}

/** Spans as the Mac app finds them in an app showing the file: words, the words either side, lines, and pieces per line. */
export function shapeSpans(text, spans) {
  const lineAt = lineNumbers(text);
  return spans.slice(0, MOST_SPANS).map((span) => ({
    markId: span.m, start: span.s, end: span.e,
    lineStart: lineAt(span.s), lineEnd: lineAt(Math.max(span.s, span.e - 1)),
    text: text.slice(span.s, span.e),
    prefix: text.slice(Math.max(0, span.s - CONTEXT), span.s),
    suffix: text.slice(span.e, span.e + CONTEXT),
    pieces: piecesOf(text, span),
  }));
}

/** A function from a character offset to its 1-based line. */
export function lineNumbers(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) starts.push(index + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

/** A span's lines, each trimmed, with the text either side of it. */
export function piecesOf(text, span) {
  const pieces = [];
  let start = span.s;
  while (start < span.e) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 || newline >= span.e ? span.e : newline;
    let from = start;
    let to = end;
    while (from < to && /\s/.test(text[from])) from += 1;
    while (to > from && /\s/.test(text[to - 1])) to -= 1;
    if (from < to) {
      pieces.push({ text: text.slice(from, to), prefix: text.slice(Math.max(0, from - CONTEXT), from),
        suffix: text.slice(to, to + CONTEXT) });
    }
    start = end + 1;
  }
  return pieces.slice(0, 200);
}
