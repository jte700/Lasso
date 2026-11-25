// Lasso's mascot and wordmark as terminal pixel art. Each character cell
// holds two pixels, one above the other, drawn with half blocks (▀ ▄ █), so
// pixels come out close to square. The mascot is the open-bot-avatar kit's
// figure the website and The Loop use (brand/mascot/open-bot-avatar): a
// rounded body under a pinched cowboy-hat crown, its brim tips raised, two
// pill eyes. During the intro it twirls a rope loop above its hat.

import { PALETTE } from './style.js';

// b body · e eye · r rope · . empty. Sixteen pixels by twelve: six rows of text.
const BODY = [
  '....##....##....',
  '...##########...',
  '##.##########.##',
  '.##############.',
  '..############..',
  '...##########...',
  '...##########...',
  '...##########...',
  '...##########...',
  '...##########...',
  '....########....',
  '......####......',
];

/** Where the eyes are drawn for each expression: [column, row] pixels. */
const EYES = {
  idle: [[6, 6], [6, 7], [9, 6], [9, 7]],
  blink: [[6, 7], [9, 7]],
  left: [[5, 6], [5, 7], [8, 6], [8, 7]],
  right: [[7, 6], [7, 7], [10, 6], [10, 7]],
  up: [[6, 5], [6, 6], [9, 5], [9, 6]],
  happy: [[6, 6], [9, 6]],
};

export const EXPRESSIONS = Object.keys(EYES);

/** The mascot's colours by look, as the 3D mascot's palettes pair body and eyes (LoopMascot3D.swift). */
export const LOOKS = Object.freeze({
  green: { body: PALETTE.green, eye: PALETTE.ink },
  lime: { body: PALETTE.lime, eye: '#20281b' },
  sky: { body: PALETTE.sky, eye: '#0b1a28' },
  terracotta: { body: PALETTE.terracotta, eye: '#201a17' },
  rope: { body: PALETTE.rope, eye: '#30291e' },
  sage: { body: PALETTE.sage, eye: '#20281b' },
});

const ROPE_ROWS = 6;

/**
 * The mascot as a grid of colour keys. With `loop`, six rows of headroom
 * hold a rope loop seen at `loop.phase` (0 to 1 is one turn), tied to the
 * raised brim tip on the right.
 */
export function mascotGrid({ expression = 'idle', loop = null, headroom = Boolean(loop) } = {}) {
  const width = BODY[0].length + 4;
  const top = headroom ? ROPE_ROWS : 0;
  const grid = Array.from({ length: top + BODY.length }, () => new Array(width).fill(null));
  BODY.forEach((row, y) => [...row].forEach((pixel, x) => { if (pixel === '#') grid[top + y][x + 2] = 'b'; }));
  for (const [x, y] of EYES[expression] ?? EYES.idle) grid[top + y][x + 2] = 'e';
  if (loop) drawLoop(grid, loop.phase ?? 0);
  return grid;
}

/** An ellipse turning about its vertical axis: wide, edge-on, wide again. */
function drawLoop(grid, phase) {
  const centreX = 9.5;
  const centreY = 2.4;
  const radiusX = Math.max(0.6, 7.5 * Math.abs(Math.cos(phase * Math.PI * 2)));
  const radiusY = 2;
  const set = (x, y) => {
    const [column, row] = [Math.round(x), Math.round(y)];
    if (row >= 0 && row < ROPE_ROWS && column >= 0 && column < grid[0].length) grid[row][column] = 'r';
  };
  for (let step = 0; step < 96; step += 1) {
    const angle = (step / 96) * Math.PI * 2;
    set(centreX + radiusX * Math.cos(angle), centreY + radiusY * Math.sin(angle));
  }
  // The rope from the loop's side down to the raised brim tip.
  const tipX = 17;
  const tipY = ROPE_ROWS + 2;
  const fromX = centreX + radiusX * 0.7;
  const fromY = centreY + radiusY * 0.7;
  for (let step = 0; step <= 12; step += 1) {
    const t = step / 12;
    set(fromX + (tipX - fromX) * t, fromY + (tipY - 1 - fromY) * t);
  }
}

/**
 * Grid rows as half-block text, two pixel rows per line. Without colour the
 * eyes are left as holes in the body, so the face still reads.
 */
export function halfBlocks(grid, paint, colours = LOOKS.sky) {
  const palette = { b: colours.body, e: colours.eye, r: PALETTE.rope, ...colours };
  const lines = [];
  for (let y = 0; y < grid.length; y += 2) {
    let line = '';
    for (let x = 0; x < grid[y].length; x += 1) {
      let top = grid[y][x];
      let bottom = grid[y + 1]?.[x] ?? null;
      if (!paint.on) {
        if (top === 'e') top = null;
        if (bottom === 'e') bottom = null;
      }
      line += cell(top && palette[top], bottom && palette[bottom], paint);
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines;
}

function cell(top, bottom, paint) {
  if (!top && !bottom) return ' ';
  if (!paint.on) return top && bottom ? '█' : top ? '▀' : '▄';
  if (top && !bottom) return paint.fg(top)('▀');
  if (bottom && !top) return paint.fg(bottom)('▄');
  if (top === bottom) return paint.fg(top)('█');
  return paint.pair(top, bottom)('▀');
}

export function mascotLines(paint, options = {}) {
  return halfBlocks(mascotGrid(options), paint, options.look ?? LOOKS.sky);
}

/** Columns the mascot takes, loop or not. */
export const MASCOT_WIDTH = BODY[0].length + 4;

// ── the wordmark ─────────────────────────────────────────────────────────

const LETTERS = {
  L: ['#...', '#...', '#...', '#...', '#...', '####'],
  A: ['.##.', '#..#', '#..#', '####', '#..#', '#..#'],
  S: ['.###', '#...', '.##.', '...#', '...#', '###.'],
  O: ['.##.', '#..#', '#..#', '#..#', '#..#', '.##.'],
};

/** "LASSO" in pixel letters three rows tall, `scale` columns per pixel, coloured from the site's bright blue to its pale one. */
export function wordmarkLines(paint, { scale = 1, stops = [PALETTE.accentBright, PALETTE.accent, PALETTE.pale] } = {}) {
  const word = 'LASSO';
  const rows = Array.from({ length: 6 }, () => []);
  [...word].forEach((letter, index) => {
    LETTERS[letter].forEach((row, y) => {
      for (const pixel of row) for (let copy = 0; copy < scale; copy += 1) rows[y].push(pixel === '#');
      if (index < word.length - 1) for (let gap = 0; gap < scale; gap += 1) rows[y].push(false);
    });
  });
  const columns = rows[0].length;
  const lines = [];
  for (let y = 0; y < 6; y += 2) {
    let line = '';
    for (let x = 0; x < columns; x += 1) {
      const [top, bottom] = [rows[y][x], rows[y + 1][x]];
      const char = top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
      line += char === ' ' || !paint.on ? char : paint.fg(mixAt(stops, x / Math.max(1, columns - 1)))(char);
    }
    lines.push(line);
  }
  return lines;
}

function mixAt(stops, t) {
  const span = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(span));
  const local = span - index;
  const parse = (hex) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const [a, b] = [parse(stops[index]), parse(stops[index + 1])];
  return `#${a.map((channel, i) => Math.round(channel + (b[i] - channel) * local).toString(16).padStart(2, '0')).join('')}`;
}

/** The spinner: a rope loop going round, in the rope's colour. */
export const SPINNER_FRAMES = ['◜', '◠', '◝', '◞', '◡', '◟'];

/**
 * What the spinner says while a command runs: Lasso's own work, in cowboy
 * words, as Claude Code's spinner has its verbs.
 */
export const SPINNER_WORDS = [
  'Lassoing', 'Wrangling', 'Roping in', 'Herding cells', 'Following hoofprints', 'Reading the brand',
  'Riding the timeline', 'Counting the herd', 'Checking the tally book', 'Tracking', 'Corralling',
];
