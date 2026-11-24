// A small terminal for testing the CLI's interactive shell: it reads what
// the shell writes (text, cursor moves, clears and colours) into a grid of
// cells, so a test can read the screen as a person would see it. Only the
// escape sequences the CLI writes are understood; others are skipped.

export class Screen {
  constructor({ columns = 100 } = {}) {
    this.columns = columns;
    this.rows = [[]];
    this.x = 0;
    this.y = 0;
    this.style = {};
    this.pendingWrap = false;
    this.buffer = '';
  }

  write(chunk) {
    this.buffer += String(chunk);
    let index = 0;
    const text = this.buffer;
    while (index < text.length) {
      const char = text[index];
      if (char === '\u001b') {
        const rest = text.slice(index);
        const csi = rest.match(/^\u001b\[([?]?)([0-9;]*)([ -/]*)([@-~])/);
        if (csi) { this.control(csi[1], csi[2], csi[4]); index += csi[0].length; continue; }
        const osc = rest.match(/^\u001b\][^\u0007]*\u0007/);
        if (osc) { index += osc[0].length; continue; }
        if (rest.length < 3) break;
        index += 2;
        continue;
      }
      if (char === '\n') { this.pendingWrap = false; this.y += 1; this.x = 0; this.ensure(); index += 1; continue; }
      if (char === '\r') { this.pendingWrap = false; this.x = 0; index += 1; continue; }
      const code = text.codePointAt(index);
      const glyph = String.fromCodePoint(code);
      index += glyph.length;
      if (code < 32) continue;
      this.put(glyph);
    }
    this.buffer = text.slice(index);
    return true;
  }

  ensure() {
    while (this.rows.length <= this.y) this.rows.push([]);
  }

  put(glyph) {
    if (this.pendingWrap) { this.pendingWrap = false; this.y += 1; this.x = 0; this.ensure(); }
    const row = this.rows[this.y];
    while (row.length < this.x) row.push({ char: ' ', style: {} });
    row[this.x] = { char: glyph, style: { ...this.style } };
    if (this.x === this.columns - 1) this.pendingWrap = true;
    else this.x += 1;
  }

  control(privateMark, params, final) {
    if (privateMark) return;
    const numbers = params.split(';').filter((part) => part !== '').map(Number);
    const first = numbers[0] ?? 0;
    this.pendingWrap = false;
    switch (final) {
      case 'A': this.y = Math.max(0, this.y - (first || 1)); break;
      case 'B': this.y += first || 1; this.ensure(); break;
      case 'C': this.x = Math.min(this.columns - 1, this.x + (first || 1)); break;
      case 'D': this.x = Math.max(0, this.x - (first || 1)); break;
      case 'G': this.x = Math.max(0, (first || 1) - 1); break;
      case 'H': this.y = Math.max(0, (numbers[0] || 1) - 1); this.x = Math.max(0, (numbers[1] || 1) - 1); this.ensure(); break;
      case 'J':
        if (first === 2 || first === 3) { this.rows = [[]]; this.x = 0; this.y = 0; }
        else { this.rows[this.y] = this.rows[this.y].slice(0, this.x); this.rows.length = this.y + 1; }
        break;
      case 'K':
        if (first === 2) this.rows[this.y] = [];
        else this.rows[this.y] = this.rows[this.y].slice(0, this.x);
        break;
      case 'm': this.sgr(numbers.length ? numbers : [0]); break;
      default: break;
    }
  }

  sgr(codes) {
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index];
      if (code === 0) this.style = {};
      else if (code === 1) this.style.bold = true;
      else if (code === 2) this.style.dim = true;
      else if (code === 22) { delete this.style.bold; delete this.style.dim; }
      else if (code === 3) this.style.italic = true;
      else if (code === 23) delete this.style.italic;
      else if (code === 9) this.style.strike = true;
      else if (code === 29) delete this.style.strike;
      else if (code === 39) delete this.style.fg;
      else if (code === 49) delete this.style.bg;
      else if ((code === 38 || code === 48) && codes[index + 1] === 2) {
        const hex = `#${codes.slice(index + 2, index + 5).map((value) => value.toString(16).padStart(2, '0')).join('')}`;
        this.style[code === 38 ? 'fg' : 'bg'] = hex;
        index += 4;
      } else if ((code === 38 || code === 48) && codes[index + 1] === 5) {
        this.style[code === 38 ? 'fg' : 'bg'] = `ansi${codes[index + 2]}`;
        index += 2;
      }
    }
  }

  /**
   * Narrows the window as Terminal.app does: a row wider than the new width
   * is re-wrapped onto the rows under it, and the caret moves with its text.
   */
  resize(columns) {
    const rows = [];
    let caret = null;
    this.rows.forEach((row, y) => {
      const chunks = Math.max(1, Math.ceil(row.length / columns));
      if (y === this.y) caret = { y: rows.length + Math.floor(this.x / columns), x: this.x % columns };
      for (let index = 0; index < chunks; index += 1) rows.push(row.slice(index * columns, (index + 1) * columns));
    });
    this.rows = rows;
    this.columns = columns;
    this.y = caret.y;
    this.x = caret.x;
    this.pendingWrap = false;
    this.ensure();
  }

  /** The screen as plain text lines, trailing spaces removed. */
  lines() {
    return this.rows.map((row) => row.map((cell) => cell?.char ?? ' ').join('').replace(/\s+$/, ''));
  }

  text() {
    return this.lines().join('\n');
  }

  /** Where the caret is, as { row, column }. */
  caret() {
    return { row: this.y, column: this.x };
  }

  /** The screen as HTML, for looking at a run by eye. */
  html({ background = '#0b0b0a', foreground = '#f1eacb' } = {}) {
    const escape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const body = this.rows.map((row) => `<div>${row.map((cell) => {
      const css = [];
      const style = cell?.style ?? {};
      if (style.fg && style.fg.startsWith('#')) css.push(`color:${style.fg}`);
      if (style.bg && style.bg.startsWith('#')) css.push(`background:${style.bg}`);
      if (style.bold) css.push('font-weight:700');
      if (style.dim) css.push('opacity:.55');
      if (style.italic) css.push('font-style:italic');
      if (style.strike) css.push('text-decoration:line-through');
      return css.length ? `<span style="${css.join(';')}">${escape(cell.char)}</span>` : escape(cell?.char ?? ' ');
    }).join('')}&nbsp;</div>`).join('');
    return `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:18px;background:${background};color:${foreground};`
      + 'font:14px/1.18 "SF Mono",Menlo,monospace;white-space:pre}div{height:1.18em}</style>' + body;
  }
}
