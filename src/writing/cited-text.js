// What an AI writer's answer becomes before it is written into the document.
//
// The writer marks the words it took from a numbered source as
// [[3|18,400]]. Its answer arrives a few characters at a time, so a mark may
// be cut anywhere. This reads the stream and gives back whole pieces: plain
// text, and cited words with their source number. The marks themselves never
// reach the document.

// A mark longer than this is not a mark: the brackets are written as they are.
const LONGEST_MARK = 600;
const MARK = /^\s*(\d+)(?:\s*,\s*\d+)*\s*\|([\s\S]*)$/;

export class CitedText {
  constructor() {
    this.buffer = '';
  }

  /** More of the answer. Returns the pieces now complete: { text } or { text, source }. */
  push(delta) {
    this.buffer += String(delta ?? '');
    return this.take(false);
  }

  /** The answer has ended. An unfinished mark is written as its words. */
  end() {
    return this.take(true);
  }

  take(ended) {
    const pieces = [];
    const plain = (text) => {
      if (!text) return;
      const last = pieces.at(-1);
      if (last && last.source === undefined) last.text += text;
      else pieces.push({ text });
    };
    for (;;) {
      const open = this.buffer.indexOf('[[');
      if (open < 0) {
        // A lone "[" at the end may be the first half of a mark still arriving.
        const held = !ended && this.buffer.endsWith('[') ? 1 : 0;
        plain(this.buffer.slice(0, this.buffer.length - held));
        this.buffer = this.buffer.slice(this.buffer.length - held);
        break;
      }
      plain(this.buffer.slice(0, open));
      this.buffer = this.buffer.slice(open);
      const close = this.buffer.indexOf(']]', 2);
      if (close < 0) {
        if (!ended && this.buffer.length <= LONGEST_MARK) break;
        // Never closed: its words stay, its brackets and number go.
        const unfinished = MARK.exec(this.buffer.slice(2));
        plain(unfinished ? unfinished[2] : this.buffer);
        this.buffer = '';
        break;
      }
      const inner = this.buffer.slice(2, close);
      const mark = MARK.exec(inner);
      if (mark && mark[2].trim()) pieces.push({ text: mark[2], source: Number(mark[1]) });
      else if (!mark) plain(this.buffer.slice(0, close + 2));
      this.buffer = this.buffer.slice(close + 2);
    }
    return pieces;
  }
}

/** A whole answer at once, for callers that have it all. */
export function citedPieces(answer) {
  const reader = new CitedText();
  const pieces = [];
  for (const piece of [...reader.push(answer), ...reader.end()]) {
    const last = pieces.at(-1);
    if (last && last.source === undefined && piece.source === undefined) last.text += piece.text;
    else pieces.push(piece);
  }
  return pieces;
}
