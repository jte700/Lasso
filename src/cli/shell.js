// The interactive shell: the welcome, then a prompt in a rounded box with a
// slash-command menu under it, ghost completions after the caret (Tab
// accepts, as it does everywhere in Lasso), a spinner while Lasso answers,
// and answers printed above the prompt into the scrollback, the way Claude
// Code's and Antigravity's terminals work.
//
// Only the "live area" (spinner, prompt box, menu, footer) is redrawn; it is
// drawn at the bottom and everything above it is ordinary scrollback.

import readline from 'node:readline';
import { PALETTE, box, cursor as move, padEnd, truncate, width } from './style.js';
import { SPINNER_FRAMES, SPINNER_WORDS } from './pixels.js';
import { welcomeLines } from './welcome.js';
import { COMMANDS, commandMatches, commandNamed, complete, execute } from './commands.js';
import { HISTORY_FILE, LineEditor, loadHistory, saveHistory } from './editor.js';
import { renderEvent } from './views.js';
import { count, plural } from './format.js';
import { startBackendWorker } from './backend.js';

const FRAME_MS = 80;
const MENU_ROWS = 7;
const MIN_INTRO_MS = 1300;

const PLACEHOLDERS = [
  'Where did a number come from? Try /trace, or type / for commands',
  'Try /whence ~/Downloads/some-attachment.xlsx',
  'Try /verify on a report before you send it',
  'Try /log --by ai to see what AI agents changed',
  'Type a question, or / for commands',
  'Drop in any file to see where it came from',
  'Try /diff with two versions of a file',
];
// Without a library there is nothing to ask questions of; every file still answers.
const ON_THE_SPOT = [
  'Drop in any file to see where it came from',
  'Try /diff with two versions of a file',
  'Try /whence ~/Downloads/some-attachment.xlsx',
  'Try /verify report.docx --against the spreadsheet it quotes',
  'Try /log ~/Desktop to see what changed there lately',
];

export async function runShell({ dataDir = null, cwd = process.cwd(), paint, version = null, intro = true,
  input = process.stdin, output = process.stdout, historyFile = HISTORY_FILE } = {}) {
  const shell = new Shell({ dataDir, cwd, paint, version, intro, input, output, historyFile });
  return shell.start();
}

class Shell {
  constructor({ dataDir, cwd, paint, version, intro, input, output, historyFile }) {
    Object.assign(this, { dataDir, cwd, paint, version, intro, input, output, historyFile });
    this.editor = new LineEditor({ history: loadHistory(historyFile) });
    this.live = { rows: 0, cursorRow: 0 };
    this.menu = { items: [], index: 0, hiddenFor: null, line: null };
    this.busy = null;
    this.watching = null;
    this.note = null;
    this.frame = 0;
    this.summary = null;
    this.name = null;
    this.exitArmedAt = 0;
    this.pasting = false;
    this.placeholder = PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)];
    this.completionToken = 0;
  }

  get columns() { return Math.max(40, this.output.columns || 80); }

  context() {
    return { call: (method, ...args) => this.backend.call(method, ...args), paint: this.paint, columns: this.columns - 1,
      cwd: this.cwd, dataDir: this.resolvedDataDir };
  }

  // ── start and stop ─────────────────────────────────────────────────────

  async start() {
    this.output.write(`${move.hide}\u001b[?2004h`);
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    const restore = () => this.output.write(`${move.show}\u001b[?2004l`);
    process.once('exit', restore);
    this.output.on('resize', () => this.render());

    this.output.write('\n');
    this.backend = startBackendWorker({ dataDir: this.dataDir, cwd: this.cwd });
    const opened = this.openLibrary();
    await this.playIntro(opened);
    const hello = await opened;
    if (hello.error) {
      this.commit(this.welcome({ error: hello.error }));
      this.output.write(`\n  ${this.paint.dim('Open the Lasso app and add a folder, or point the CLI at a library with --data-dir.')}\n\n`);
      await this.backend.close().catch(() => {});
      restore();
      return 1;
    }
    this.commit([...this.welcome({ hello }), '']);
    this.ready = true;
    this.listen();
    this.ticker = setInterval(() => this.tick(), FRAME_MS);
    this.render();
    return this.exitPromise;
  }

  async openLibrary() {
    try {
      const ready = await this.backend.ready;
      this.resolvedDataDir = ready.dataDir;
      const hello = await this.backend.call('hello');
      this.summary = hello.summary;
      this.name = hello.name;
      if (hello.library === false) this.placeholder = ON_THE_SPOT[Math.floor(Math.random() * ON_THE_SPOT.length)];
      return hello;
    } catch (error) {
      return { error: error.message };
    }
  }

  /** The mascot twirls its loop while the library opens: at least a beat, at most until it has. */
  async playIntro(opened) {
    const started = Date.now();
    let done = false;
    let hello = null;
    opened.then((answer) => { done = true; hello = answer.error ? null : answer; });
    let phase = 0;
    let step = 0;
    const animate = this.intro && this.paint.on;
    const draw = (loading) => {
      const blink = step % 28 >= 25;
      const expression = blink ? 'blink' : step % 40 > 30 ? 'up' : 'idle';
      this.draw(this.welcome({ hello, loading, frame: { expression, loop: { phase } } }), null);
    };
    if (!animate) {
      draw(true);
      await opened;
      return;
    }
    while (!done || Date.now() - started < MIN_INTRO_MS) {
      draw(!done);
      phase = (phase + 0.045) % 1;
      step += 1;
      await sleep(FRAME_MS);
    }
    // Let the loop come round to face us before settling.
    while (Math.abs(Math.cos(phase * Math.PI * 2)) < 0.985) {
      phase = (phase + 0.045) % 1;
      step += 1;
      draw(false);
      await sleep(FRAME_MS);
    }
  }

  welcome({ hello = null, loading = false, error = null, frame = undefined } = {}) {
    return welcomeLines(this.paint, this.columns, {
      name: hello?.name ?? this.name, summary: hello?.summary ?? null, recent: hello?.recent ?? null,
      library: hello ? hello.library !== false : null, cwd: this.cwd,
      dataDir: hello?.dataDir ?? this.resolvedDataDir ?? this.dataDir, version: this.version,
      loading, error, frame, spinner: SPINNER_FRAMES[this.frame++ % SPINNER_FRAMES.length],
    });
  }

  async exit(code = 0) {
    if (this.closed) return;
    clearInterval(this.ticker);
    this.stopWatching(false);
    this.clearLive();
    this.closed = true;
    const name = this.name ? `, ${this.name}` : '';
    this.output.write(`${this.paint.accent('◠')} ${this.paint.dim(`Happy trails${name}.`)}\n${move.show}\u001b[?2004l`);
    saveHistory(this.editor.history, this.historyFile);
    if (this.input.isTTY) this.input.setRawMode(false);
    this.input.pause();
    await this.backend.close().catch(() => {});
    this.resolveExit(code);
  }

  // ── drawing ────────────────────────────────────────────────────────────

  /** Replaces the live area with `lines`, leaving the caret at `caret` ({ row, column }) or hidden. */
  draw(lines, caret) {
    const columns = this.columns;
    const safe = lines.map((line) => truncate(line, columns - 1));
    let out = '\u001b[?2026h' + move.hide;
    out += move.up(this.rowsAboveCaret()) + '\r' + move.clearDown;
    out += safe.join('\n');
    const last = safe.length - 1;
    if (caret) {
      out += move.up(last - caret.row) + move.column(caret.column) + move.show;
      this.live.cursorRow = caret.row;
      this.live.caretColumn = caret.column;
    } else {
      this.live.cursorRow = last;
      this.live.caretColumn = 0;
    }
    out += '\u001b[?2026l';
    this.live.rows = safe.length;
    this.live.widths = safe.map((line) => width(line));
    this.output.write(out);
  }

  /**
   * How many screen rows the caret sits below the live area's first line.
   * A narrowed window re-wraps the lines already drawn, so a line drawn
   * wider than the window now takes more than one row; counting only the
   * lines drawn would leave the top of the old prompt box behind.
   */
  rowsAboveCaret() {
    const { cursorRow, widths = [], caretColumn = 0 } = this.live;
    const columns = this.columns;
    let rows = 0;
    for (let index = 0; index < cursorRow; index += 1) rows += Math.max(1, Math.ceil((widths[index] ?? 0) / columns));
    return rows + Math.floor(caretColumn / columns);
  }

  clearLive() {
    this.output.write(move.up(this.rowsAboveCaret()) + '\r' + move.clearDown);
    this.live = { rows: 0, cursorRow: 0 };
  }

  /** Prints lines into the scrollback above the live area, then draws the live area again. */
  print(lines) {
    this.clearLive();
    if (lines.length) this.output.write(`${lines.join('\n')}\n`);
    this.render();
  }

  /** Writes the live area's last state into the scrollback and starts a fresh one under it. */
  commit(lines) {
    this.clearLive();
    this.output.write(`${lines.join('\n')}\n`);
  }

  tick() {
    this.frame += 1;
    if (this.note && Date.now() > this.note.until) this.note = null;
    if (this.busy || this.watching || this.note) this.render();
  }

  render() {
    if (!this.ready || this.closed) return;
    const p = this.paint;
    const columns = this.columns - 1;
    const lines = [];
    if (this.busy) {
      const elapsed = ((Date.now() - this.busy.started) / 1000).toFixed(1);
      const glyph = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
      const word = shimmer(`${this.busy.word}…`, this.frame, p);
      lines.push(`${p.accent(glyph)} ${word} ${p.dim(`(${elapsed}s · esc to interrupt)`)}`);
      lines.push('');
    } else if (this.watching) {
      const pulse = ['◉', '◎', '○', '◎'][Math.floor(this.frame / 4) % 4];
      lines.push(`${p.accent(pulse)} ${p.bold('Watching your folders')} ${p.dim(`· ${plural(this.watching.seen, 'change')} so far · esc to stop`)}`);
      lines.push('');
    }
    const prompt = this.promptBox(columns);
    const top = lines.length;
    lines.push(...prompt.lines);
    lines.push(...this.menuLines(columns));
    this.draw(lines, { row: top + prompt.caret.row, column: prompt.caret.column });
  }

  promptBox(columns) {
    const p = this.paint;
    const inner = columns - 4;
    const avail = inner - 2;
    const text = this.editor.chars;
    const ghost = this.ghost();
    const rows = [[]];
    let row = 0;
    let column = 0;
    let caret = null;
    const place = (char, kind) => {
      const charWidth = width(char) || 1;
      if (column + charWidth > avail) { row += 1; column = 0; rows.push([]); }
      rows[row].push({ char, kind });
      column += charWidth;
    };
    text.forEach((char, index) => {
      if (index === this.editor.cursor) caret = { row, column };
      place(char, 'text');
    });
    if (!caret) {
      if (column >= avail) { row += 1; column = 0; rows.push([]); }
      caret = { row, column };
    }
    for (const char of ghost) place(char, 'ghost');
    const empty = !text.length;
    const body = rows.map((cells, index) => {
      const lead = index === 0 ? `${this.busy ? p.faint('›') : p.accent('›')} ` : '  ';
      if (empty && index === 0) return `${lead}${p.faint(truncate(this.busy ? '' : this.placeholder, avail))}`;
      return lead + cells.map((cell) => (cell.kind === 'ghost' ? p.faint(cell.char) : cell.char)).join('');
    });
    const border = this.busy ? PALETTE.faint : this.watching ? PALETTE.sage : PALETTE.grey;
    return { lines: box(body, columns, { paint: p, border }), caret: { row: 1 + caret.row, column: 2 + 2 + caret.column } };
  }

  menuLines(columns) {
    const p = this.paint;
    const items = this.menuItems();
    if (!items.length) return [this.footer(columns)];
    const start = Math.max(0, Math.min(this.menu.index - Math.floor(MENU_ROWS / 2), items.length - MENU_ROWS));
    const shown = items.slice(start, start + MENU_ROWS);
    const labelWidth = Math.min(30, Math.max(...shown.map((item) => width(item.label))) + 2);
    const lines = shown.map((item, offset) => {
      const selected = start + offset === this.menu.index;
      const label = padEnd(truncate(item.label, labelWidth), labelWidth);
      const detail = truncate(item.detail ?? '', columns - labelWidth - 6);
      return selected ? `  ${p.accent('›')} ${p.accent(p.bold(label))} ${p.dim(detail)}` : `    ${label} ${p.faint(detail)}`;
    });
    const more = items.length > MENU_ROWS ? p.faint(`  ${start + 1}–${start + shown.length} of ${items.length} · ↑↓ choose · tab complete`) : p.faint('  ↑↓ choose · tab complete · esc close');
    return [...lines, more];
  }

  footer(columns) {
    const p = this.paint;
    const left = this.note ? p.accent(this.note.text)
      : this.busy ? p.dim('  type ahead · esc to interrupt')
        : p.dim(`  ${p.accent('/')}${p.dim(' for commands · tab completes · ↑ history')}`);
    const library = this.summary
      ? `${p.accent('●')} ${p.dim(`${plural(this.summary.folders.length, 'folder')} · ${count(this.summary.files)} files`)}`
      : this.ready ? `${p.accent('○')} ${p.dim('on the spot · nothing indexed')}` : p.dim('○ opening');
    const room = columns - width(left) - width(library) - 1;
    return room > 1 ? `${left}${' '.repeat(room)}${library}` : left;
  }

  // ── completion ─────────────────────────────────────────────────────────

  menuItems() {
    if (this.watching) return [];
    const text = this.editor.text;
    if (this.menu.hiddenFor === text) return [];
    if (/^\/\S*$/.test(text)) return commandMatches(text);
    return this.menu.line === text ? this.menu.items : [];
  }

  /** The rest of the chosen completion, shown dim after the caret. */
  ghost() {
    if (!this.editor.atEnd()) return [];
    const text = this.editor.text;
    const items = this.menuItems();
    const chosen = items[this.menu.index] ?? items[0];
    if (!chosen || !text) return [];
    const insert = chosen.insert.replace(/\s+$/, '');
    return insert.toLowerCase().startsWith(text.toLowerCase()) && insert.length > text.length ? [...insert.slice(text.length)] : [];
  }

  /** Asks for argument completions once typing pauses; an answer for an older line is dropped. */
  refreshCompletions() {
    const text = this.editor.text;
    if (this.menu.line !== text) this.menu.index = 0;
    if (/^\/\S*$/.test(text) || !/^\/?\S+\s/.test(text)) { this.menu.line = null; this.menu.items = []; return; }
    const command = commandNamed(text.replace(/^\//, '').split(/\s+/)[0]);
    if (!command?.complete) return;
    const token = ++this.completionToken;
    clearTimeout(this.completionTimer);
    this.completionTimer = setTimeout(async () => {
      try {
        const items = await complete(text, this.context());
        if (token !== this.completionToken || this.editor.text !== text) return;
        this.menu = { ...this.menu, items: items.filter((item) => item.insert !== text), line: text, index: 0 };
        this.render();
      } catch {
        // A completion that fails only shows no menu.
      }
    }, 70);
  }

  /** Tab pressed before the menu arrived: asks now and takes the first answer, if the line has not changed meanwhile. */
  async completeNow() {
    const text = this.editor.text;
    const command = /^\/?\S+\s/.test(text) ? commandNamed(text.replace(/^\//, '').split(/\s+/)[0]) : null;
    const nothing = () => { this.note = { text: '  nothing to complete', until: Date.now() + 900 }; this.render(); };
    if (!command?.complete) return nothing();
    clearTimeout(this.completionTimer);
    const token = ++this.completionToken;
    let items = [];
    try { items = (await complete(text, this.context())).filter((item) => item.insert !== text); } catch { items = []; }
    if (token !== this.completionToken || this.editor.text !== text) return undefined;
    if (!items.length) return nothing();
    this.menu = { ...this.menu, items, line: text, index: 0, hiddenFor: null };
    this.accept();
    return this.render();
  }

  accept() {
    const items = this.menuItems();
    const chosen = items[this.menu.index] ?? items[0];
    if (!chosen) return false;
    this.editor.set(chosen.insert);
    this.menu.index = 0;
    this.refreshCompletions();
    return true;
  }

  // ── keys ───────────────────────────────────────────────────────────────

  listen() {
    readline.emitKeypressEvents(this.input);
    if (this.input.isTTY) this.input.setRawMode(true);
    this.input.resume();
    this.input.on('keypress', (sequence, key = {}) => {
      try {
        this.key(sequence, key);
      } catch (error) {
        this.print([this.paint.pink(`✗ ${error.message}`)]);
      }
    });
  }

  key(sequence, key) {
    if (key.name === 'paste-start') { this.pasting = true; return; }
    if (key.name === 'paste-end') { this.pasting = false; this.changed(); return; }
    if (this.pasting) {
      this.editor.insert(String(sequence ?? '').replace(/[\r\n]+/g, ' '));
      return;
    }
    const editor = this.editor;
    if (key.ctrl && key.name === 'c') return this.interrupt();
    if (key.ctrl && key.name === 'd') {
      if (!editor.text) return this.exit(0);
      editor.deleteForward();
      return this.changed();
    }
    if (key.name === 'escape') {
      if (this.busy || this.watching) return this.interrupt();
      if (this.menuItems().length) { this.menu.hiddenFor = editor.text; return this.render(); }
      editor.clear();
      return this.changed();
    }
    if (key.ctrl && key.name === 'l') {
      this.output.write(move.clearScreen);
      this.live = { rows: 0, cursorRow: 0 };
      return this.render();
    }
    if (key.name === 'return' || key.name === 'enter') return this.enter();
    if (key.name === 'tab') {
      if (this.accept()) return this.render();
      return this.completeNow();
    }
    if (key.name === 'up' || key.name === 'down') {
      const items = this.menuItems();
      if (items.length) {
        this.menu.index = (this.menu.index + (key.name === 'up' ? -1 : 1) + items.length) % items.length;
        return this.render();
      }
      if (key.name === 'up' ? editor.historyUp() : editor.historyDown()) return this.changed();
      return undefined;
    }
    if (key.name === 'left') { if (key.meta || key.ctrl) editor.wordLeft(); else editor.left(); return this.render(); }
    if (key.name === 'right') {
      if (editor.atEnd() && this.ghost().length) { this.accept(); return this.render(); }
      if (key.meta || key.ctrl) editor.wordRight(); else editor.right();
      return this.render();
    }
    if (key.name === 'home' || (key.ctrl && key.name === 'a')) { editor.home(); return this.render(); }
    if (key.name === 'end' || (key.ctrl && key.name === 'e')) { editor.end(); return this.render(); }
    if (key.name === 'backspace') { if (key.meta) editor.deleteWordBack(); else editor.backspace(); return this.changed(); }
    if (key.name === 'delete') { editor.deleteForward(); return this.changed(); }
    if (key.ctrl && key.name === 'u') { editor.killToStart(); return this.changed(); }
    if (key.ctrl && key.name === 'k') { editor.killToEnd(); return this.changed(); }
    if (key.ctrl && key.name === 'w') { editor.deleteWordBack(); return this.changed(); }
    if (key.meta && key.name === 'b') { editor.wordLeft(); return this.render(); }
    if (key.meta && key.name === 'f') { editor.wordRight(); return this.render(); }
    if (sequence && !key.ctrl && !key.meta && sequence >= ' ' && !sequence.startsWith('\u001b')) {
      editor.insert(sequence);
      return this.changed();
    }
    return undefined;
  }

  changed() {
    this.exitArmedAt = 0;
    if (this.menu.hiddenFor !== this.editor.text) this.menu.hiddenFor = null;
    this.refreshCompletions();
    this.render();
  }

  interrupt() {
    if (this.busy) {
      this.busy.cancelled = true;
      this.busy.cancel();
      return;
    }
    if (this.watching) { this.stopWatching(true); return; }
    if (this.editor.text) { this.editor.clear(); this.changed(); return; }
    if (Date.now() - this.exitArmedAt < 2000) { this.exit(0); return; }
    this.exitArmedAt = Date.now();
    this.note = { text: '  press Ctrl+C again to leave', until: Date.now() + 2000 };
    this.render();
  }

  enter() {
    if (this.busy) {
      this.note = { text: '  still answering; esc interrupts', until: Date.now() + 1200 };
      return this.render();
    }
    const text = this.editor.text;
    // Enter on the slash menu picks the command; one that needs nothing more runs straight away.
    if (/^\/\S*$/.test(text) && this.menuItems().length) {
      const chosen = this.menuItems()[this.menu.index] ?? this.menuItems()[0];
      const command = commandNamed(chosen.value.slice(1));
      if (chosen.value !== text.trim() && command?.args?.startsWith('<')) {
        this.editor.set(chosen.insert);
        return this.changed();
      }
      this.editor.set(chosen.value);
    }
    if (!this.editor.text.trim()) return this.render();
    if (this.watching) this.stopWatching(true);
    return this.submit(this.editor.commit());
  }

  // ── running ────────────────────────────────────────────────────────────

  async submit(line) {
    const p = this.paint;
    this.menu = { items: [], index: 0, hiddenFor: null, line: null };
    this.print([`${p.accent('›')} ${p.bold(line)}`]);
    let cancel;
    const cancelled = new Promise((resolve) => { cancel = () => resolve({ cancelled: true }); });
    this.busy = { started: Date.now(), word: SPINNER_WORDS[Math.floor(Math.random() * SPINNER_WORDS.length)], cancel };
    this.render();
    const outcome = await Promise.race([execute(line, this.context()), cancelled]);
    this.busy = null;
    if (outcome.cancelled) {
      this.print([`  ${p.faint('⎿')} ${p.dim('Interrupted. Lasso stops drawing it; the answer is dropped when it arrives.')}`, '']);
      return;
    }
    if (outcome.exit) return this.exit(0);
    if (outcome.clear) {
      this.output.write(move.clearScreen);
      this.live = { rows: 0, cursorRow: 0 };
      this.render();
      return;
    }
    if (outcome.watch) return this.startWatching();
    this.print([...(outcome.lines ?? []), '']);
    if (/^\/?(index|status)\b/.test(line)) this.backend.call('summary').then((summary) => { this.summary = summary; this.render(); }).catch(() => {});
  }

  async startWatching() {
    const cursor = await this.backend.call('cursor');
    this.watching = { cursor, seen: 0 };
    this.print([`  ${this.paint.faint('⎿')} ${this.paint.dim('New changes appear here as Lasso records them. The Mac app records saves while it runs.')}`]);
    const poll = async () => {
      if (!this.watching) return;
      try {
        const { cursor: next, events } = await this.backend.call('events', this.watching.cursor);
        if (!this.watching) return;
        this.watching.cursor = next;
        if (events.length) {
          this.watching.seen += events.length;
          this.print(events.flatMap((event) => renderEvent(event, this.paint, this.columns - 1).map((line) => `  ${line}`)));
        }
      } catch (error) {
        this.print([this.paint.pink(`  ✗ ${error.message}`)]);
      }
      if (this.watching) this.watching.timer = setTimeout(poll, 1500);
    };
    this.watching.timer = setTimeout(poll, 1500);
    this.render();
  }

  stopWatching(announce) {
    if (!this.watching) return;
    clearTimeout(this.watching.timer);
    const { seen } = this.watching;
    this.watching = null;
    if (announce) this.print([`  ${this.paint.faint('⎿')} ${this.paint.dim(`Stopped watching · ${plural(seen, 'change')} seen`)}`, '']);
  }
}

/** A word drawn with a brighter band sweeping across it, as Claude Code's spinner text glints. */
function shimmer(text, frame, paint) {
  if (!paint.on) return text;
  const chars = [...text];
  const at = frame % (chars.length + 8);
  return chars.map((char, index) => (Math.abs(index - at) <= 1 ? paint.fg(PALETTE.pale)(char) : paint.accent(char))).join('');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export { COMMANDS };
