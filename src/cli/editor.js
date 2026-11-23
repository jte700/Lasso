// The prompt's line editor: the typed text, the caret, and history, with the
// editing keys a shell has (word moves, Ctrl+U, Ctrl+W, Ctrl+K). It knows
// nothing of the screen, so it is tested on its own.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HISTORY_FILE = process.env.LASSO_HISTORY_FILE || path.join(os.homedir(), '.lasso_history');
const MAX_HISTORY = 500;

export class LineEditor {
  constructor({ history = [] } = {}) {
    this.chars = [];
    this.cursor = 0;
    this.history = [...history];
    this.historyIndex = this.history.length;
    this.draft = null;
  }

  get text() { return this.chars.join(''); }

  set(text, cursor = null) {
    this.chars = [...String(text ?? '')];
    this.cursor = cursor === null ? this.chars.length : Math.max(0, Math.min(cursor, this.chars.length));
  }

  insert(text) {
    const added = [...String(text ?? '')];
    this.chars.splice(this.cursor, 0, ...added);
    this.cursor += added.length;
  }

  backspace() {
    if (!this.cursor) return;
    this.chars.splice(this.cursor - 1, 1);
    this.cursor -= 1;
  }

  deleteForward() {
    if (this.cursor < this.chars.length) this.chars.splice(this.cursor, 1);
  }

  left() { this.cursor = Math.max(0, this.cursor - 1); }
  right() { this.cursor = Math.min(this.chars.length, this.cursor + 1); }
  home() { this.cursor = 0; }
  end() { this.cursor = this.chars.length; }

  wordLeft() {
    let index = this.cursor;
    while (index > 0 && /\s/.test(this.chars[index - 1])) index -= 1;
    while (index > 0 && !/\s/.test(this.chars[index - 1])) index -= 1;
    this.cursor = index;
  }

  wordRight() {
    let index = this.cursor;
    while (index < this.chars.length && /\s/.test(this.chars[index])) index += 1;
    while (index < this.chars.length && !/\s/.test(this.chars[index])) index += 1;
    this.cursor = index;
  }

  deleteWordBack() {
    const end = this.cursor;
    this.wordLeft();
    this.chars.splice(this.cursor, end - this.cursor);
  }

  killToStart() {
    this.chars.splice(0, this.cursor);
    this.cursor = 0;
  }

  killToEnd() { this.chars.splice(this.cursor); }

  clear() { this.set(''); }

  atEnd() { return this.cursor === this.chars.length; }

  /** The previous history entry; the line being typed is kept to come back to. */
  historyUp() {
    if (!this.historyIndex) return false;
    if (this.historyIndex === this.history.length) this.draft = this.text;
    this.historyIndex -= 1;
    this.set(this.history[this.historyIndex]);
    return true;
  }

  historyDown() {
    if (this.historyIndex >= this.history.length) return false;
    this.historyIndex += 1;
    this.set(this.historyIndex === this.history.length ? this.draft ?? '' : this.history[this.historyIndex]);
    return true;
  }

  /** Takes the line, adds it to history (once, not after itself) and empties the prompt. */
  commit() {
    const line = this.text;
    if (line.trim() && this.history.at(-1) !== line) this.history.push(line);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    this.historyIndex = this.history.length;
    this.draft = null;
    this.clear();
    return line;
  }
}

export function loadHistory(file = HISTORY_FILE) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

export function saveHistory(history, file = HISTORY_FILE) {
  try {
    fs.writeFileSync(file, `${history.slice(-MAX_HISTORY).join('\n')}\n`, { mode: 0o600 });
  } catch {
    // History is a convenience; a read-only home folder only loses it.
  }
}
