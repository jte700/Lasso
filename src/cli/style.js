// How the CLI paints text: Lasso's colours in 24-bit where the terminal has
// them, the nearest of 256 where it does not, and none at all when output is
// piped, NO_COLOR is set or --no-color was passed. Also the widths, padding,
// wrapping and rounded boxes every view is drawn with.

const ESC = '\u001b[';

/** The website's and The Loop's colours (website/index.html, LoopLook.swift). */
export const PALETTE = Object.freeze({
  // The site's blue (mylasso.ca's --pop) is the CLI's own colour: the wordmark, the box, the prompt and the mascot.
  accent: '#8ec5f4',
  accentBright: '#5aa2ff',
  accentDeep: '#2a6db0',
  pale: '#e3edf5',
  // Green stays for what was added or agrees: a diff's added lines, a number that matches.
  green: '#29cc57',
  greenDeep: '#1f9d55',
  lime: '#d4f75c',
  rope: '#d7bd85',
  sky: '#8ec5f4',
  terracotta: '#c96749',
  sage: '#91a984',
  forest: '#2f4322',
  cream: '#f1eacb',
  ink: '#141413',
  orange: '#ff8a4c',
  pink: '#e5487a',
  blue: '#7b9dff',
  yellow: '#f6c445',
  grey: '#8a877f',
  faint: '#5c5a55',
});

/** none | 256 | truecolor, from the environment and the stream. */
export function colorLevel({ stream = process.stdout, env = process.env, force = null } = {}) {
  if (force === false) return 'none';
  if ('NO_COLOR' in env && env.NO_COLOR !== '') return 'none';
  if (env.FORCE_COLOR === '0') return 'none';
  const forced = force === true || (env.FORCE_COLOR && env.FORCE_COLOR !== '0');
  if (!forced && !stream?.isTTY) return 'none';
  if (env.TERM === 'dumb' && !forced) return 'none';
  if (/truecolor|24bit/i.test(env.COLORTERM ?? '') || env.FORCE_COLOR === '3') return 'truecolor';
  if (['iTerm.app', 'WezTerm', 'vscode', 'ghostty', 'Hyper', 'Tabby', 'WarpTerminal'].includes(env.TERM_PROGRAM)) return 'truecolor';
  if (env.TERM_PROGRAM === 'Apple_Terminal') return '256';
  return /256|kitty|alacritty|direct/.test(env.TERM ?? '') ? (/direct|kitty|alacritty/.test(env.TERM) ? 'truecolor' : '256') : '256';
}

const hexToRgb = (hex) => {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** The xterm 256-colour index nearest an RGB colour. */
function to256([r, g, b]) {
  const cube = (value) => (value < 48 ? 0 : value < 115 ? 1 : Math.floor((value - 35) / 40));
  const [cr, cg, cb] = [cube(r), cube(g), cube(b)];
  const levels = [0, 95, 135, 175, 215, 255];
  const cubeDistance = (levels[cr] - r) ** 2 + (levels[cg] - g) ** 2 + (levels[cb] - b) ** 2;
  const grey = Math.round((r + g + b) / 3);
  const greyIndex = grey > 238 ? 23 : Math.max(0, Math.round((grey - 8) / 10));
  const greyLevel = 8 + greyIndex * 10;
  const greyDistance = (greyLevel - r) ** 2 + (greyLevel - g) ** 2 + (greyLevel - b) ** 2;
  return greyDistance < cubeDistance ? 232 + greyIndex : 16 + 36 * cr + 6 * cg + cb;
}

/**
 * A painter bound to one colour level. Every method returns plain text when
 * the level is 'none', so views never need to ask.
 */
export function createPainter(level = 'truecolor') {
  const on = level !== 'none';
  const sgr = (open, close) => (text) => (on ? `${ESC}${open}m${text}${ESC}${close}m` : String(text));
  const colourCode = (hex, background = false) => {
    const rgb = hexToRgb(hex);
    if (level === 'truecolor') return `${background ? 48 : 38};2;${rgb.join(';')}`;
    return `${background ? 48 : 38};5;${to256(rgb)}`;
  };
  const fg = (hex) => (text) => (on ? `${ESC}${colourCode(hex)}m${text}${ESC}39m` : String(text));
  const bg = (hex) => (text) => (on ? `${ESC}${colourCode(hex, true)}m${text}${ESC}49m` : String(text));
  const paint = {
    level,
    on,
    fg,
    bg,
    /** Foreground and background together, for pixel art. */
    pair: (fore, back) => (text) => {
      if (!on) return String(text);
      const codes = [fore && colourCode(fore), back && colourCode(back, true)].filter(Boolean).join(';');
      return codes ? `${ESC}${codes}m${text}${ESC}0m` : String(text);
    },
    bold: sgr(1, 22),
    dim: sgr(2, 22),
    italic: sgr(3, 23),
    underline: sgr(4, 24),
    inverse: sgr(7, 27),
    strike: sgr(9, 29),
    /** A colour per column, from one colour to the next, as the Gemini and Antigravity banners do. */
    gradient(text, stops) {
      if (!on) return String(text);
      const chars = [...String(text)];
      const visible = chars.filter((char) => char !== ' ').length || 1;
      let seen = 0;
      return chars.map((char) => {
        if (char === ' ') return char;
        const colour = mix(stops, seen / Math.max(1, visible - 1));
        seen += 1;
        return fg(colour)(char);
      }).join('');
    },
  };
  for (const [name, hex] of Object.entries(PALETTE)) paint[name] = fg(hex);
  return paint;
}

/** The colour `t` (0 to 1) of the way along a list of colours. */
export function mix(stops, t) {
  if (stops.length === 1) return stops[0];
  const clamped = Math.min(1, Math.max(0, t));
  const span = clamped * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(span));
  const local = span - index;
  const [a, b] = [hexToRgb(stops[index]), hexToRgb(stops[index + 1])];
  const rgb = a.map((channel, i) => Math.round(channel + (b[i] - channel) * local));
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

// ── widths ────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export const strip = (text) => String(text ?? '').replace(ANSI, '');

/** Whether a code point takes two columns: CJK, Hangul, full-width forms and most emoji. */
function wide(code) {
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f64f) || (code >= 0x1f900 && code <= 0x1f9ff) || (code >= 0x20000 && code <= 0x3fffd);
}

const zeroWidth = (code) => (code >= 0x300 && code <= 0x36f) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f);

/** Columns a string takes on screen, ignoring colour codes. */
export function width(text) {
  let columns = 0;
  for (const char of strip(text)) {
    const code = char.codePointAt(0);
    if (code < 32 || zeroWidth(code)) continue;
    columns += wide(code) ? 2 : 1;
  }
  return columns;
}

/** Splits painted text into its visible characters, each with the codes that come before it. */
function tokens(text) {
  const out = [];
  let pending = '';
  let index = 0;
  const source = String(text ?? '');
  ANSI.lastIndex = 0;
  for (const match of source.matchAll(ANSI)) {
    for (const char of source.slice(index, match.index)) {
      out.push({ codes: pending, char });
      pending = '';
    }
    pending += match[0];
    index = match.index + match[0].length;
  }
  for (const char of source.slice(index)) {
    out.push({ codes: pending, char });
    pending = '';
  }
  return { out, trailing: pending };
}

/** Cuts painted text to `columns`, ending with an ellipsis when anything was cut. */
export function truncate(text, columns, ellipsis = '…') {
  if (columns <= 0) return '';
  if (width(text) <= columns) return String(text ?? '');
  const room = columns - width(ellipsis);
  const { out } = tokens(text);
  let used = 0;
  let result = '';
  for (const { codes, char } of out) {
    const charWidth = width(char);
    if (used + charWidth > room) break;
    result += codes + char;
    used += charWidth;
  }
  return `${result}${strip(result) === result ? '' : '\u001b[0m'}${ellipsis}`;
}

/** Cuts from the left, for paths: "…/Finance/Q3/model.csv". */
export function truncateStart(text, columns, ellipsis = '…') {
  const plain = strip(text);
  if (width(plain) <= columns) return plain;
  const chars = [...plain];
  let result = '';
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    if (width(chars[index] + result) > columns - width(ellipsis)) break;
    result = chars[index] + result;
  }
  return ellipsis + result;
}

export const padEnd = (text, columns) => `${text}${' '.repeat(Math.max(0, columns - width(text)))}`;
export const padStart = (text, columns) => `${' '.repeat(Math.max(0, columns - width(text)))}${text}`;
export function center(text, columns) {
  const room = Math.max(0, columns - width(text));
  return `${' '.repeat(Math.floor(room / 2))}${text}${' '.repeat(Math.ceil(room / 2))}`;
}

/** Wraps plain text to `columns`, breaking at spaces and inside words only when a word is longer than a line. */
export function wrap(text, columns) {
  const limit = Math.max(8, columns);
  const lines = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      if (!word) continue;
      if (width(line) + width(word) <= limit) { line += word; continue; }
      if (line.trim()) lines.push(line.trimEnd());
      line = /^\s+$/.test(word) ? '' : word;
      while (width(line) > limit) {
        const chars = [...line];
        lines.push(chars.slice(0, limit).join(''));
        line = chars.slice(limit).join('');
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/**
 * A rounded box around `lines`, `columns` wide, with an optional title set
 * into its top edge as Claude Code's welcome box has.
 */
export function box(lines, columns, { paint, title = null, border = PALETTE.accent, padding = 1 } = {}) {
  const edge = paint ? paint.fg(border) : (text) => text;
  const inner = columns - 2;
  const titleText = title ? ` ${title} ` : '';
  const top = title
    ? `${edge('╭───')}${titleText}${edge('─'.repeat(Math.max(0, inner - 3 - width(titleText))))}${edge('╮')}`
    : edge(`╭${'─'.repeat(inner)}╮`);
  const space = ' '.repeat(padding);
  const body = lines.map((line) => `${edge('│')}${space}${padEnd(truncate(line, inner - padding * 2), inner - padding * 2)}${space}${edge('│')}`);
  return [top, ...body, edge(`╰${'─'.repeat(inner)}╯`)];
}

/** Places two columns of lines side by side. */
export function columns(left, right, leftWidth, gap = '') {
  const rows = Math.max(left.length, right.length);
  return Array.from({ length: rows }, (_, index) => `${padEnd(left[index] ?? '', leftWidth)}${gap}${right[index] ?? ''}`);
}

export const cursor = {
  hide: '\u001b[?25l',
  show: '\u001b[?25h',
  up: (rows) => (rows > 0 ? `${ESC}${rows}A` : ''),
  down: (rows) => (rows > 0 ? `${ESC}${rows}B` : ''),
  column: (column) => `${ESC}${column + 1}G`,
  clearDown: `${ESC}0J`,
  clearLine: `${ESC}2K`,
  clearScreen: `${ESC}2J${ESC}3J${ESC}H`,
};
