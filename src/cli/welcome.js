// The welcome: a rounded box in two columns, as Claude Code opens: on the left a greeting,
// the mascot and the library in numbers; on the right tips and the latest
// changes. While the library opens the mascot twirls its rope loop and the
// right column says so.

import { PALETTE, box, center, padEnd, truncate, truncateStart } from './style.js';
import { mascotLines, MASCOT_WIDTH } from './pixels.js';
import { ago, count, plural, tilde } from './format.js';
import { actorText } from './views.js';

const TIPS = [
  ['/whence <file>', 'where any file came from'],
  ['/diff <a> <b>', 'what changed between two files'],
  ['/verify <doc>', 'check a report\'s numbers'],
  ['/blame <file>', 'who wrote what, AI included'],
];

/**
 * @param {object} state
 *   { name, summary, recent, dataDir, version, loading, spinner, frame: { expression, loop } }
 */
export function welcomeLines(paint, columns, state) {
  const total = Math.max(44, columns - 1);
  const inner = total - 4;
  const wide = inner >= 70;
  const leftWidth = wide ? Math.max(MASCOT_WIDTH + 6, Math.floor(inner * 0.46)) : inner;
  const rightWidth = wide ? inner - leftWidth - 3 : inner;

  const greeting = paint.bold(state.name ? `Welcome back, ${state.name}!` : 'Welcome back!');
  // The loop stays over the hat once the library is open: the mascot holding its lasso.
  const art = mascotLines(paint, state.frame ?? { expression: 'idle', loop: { phase: 0 } });
  const left = ['', center(greeting, leftWidth), '', ...art.map((line) => center(padEnd(line, MASCOT_WIDTH), leftWidth)), ''];
  if (state.summary) {
    const { summary } = state;
    left.push(center(paint.dim(`${plural(summary.folders.length, 'folder')} · ${count(summary.files)} files`), leftWidth));
    left.push(center(paint.dim(`${count(summary.versions)} versions recorded`), leftWidth));
  } else if (state.library === false) {
    left.push(center(paint.dim('nothing indexed, nothing kept'), leftWidth));
    left.push(center(paint.dim('every answer read on the spot'), leftWidth));
  } else {
    left.push(center(paint.dim(state.error ? 'library not opened' : 'opening your library…'), leftWidth), '');
  }
  left.push(center(paint.faint(truncateStart(state.library === false ? tilde(state.cwd ?? '') : tilde(state.dataDir ?? ''), leftWidth - 2)), leftWidth));

  const right = [];
  right.push(paint.accent(paint.bold('Tips for getting started')));
  for (const [command, words] of TIPS) right.push(`${paint.accent(padEnd(command, 15))} ${paint.dim(words)}`);
  right.push(paint.dim(state.library === false ? 'or drop in any file to trace it' : 'or drop in a file, or ask a question'));
  right.push(paint.faint('─'.repeat(rightWidth)));
  right.push(paint.accent(paint.bold('Recent activity')));
  if (state.error) right.push(paint.pink(truncate(state.error, rightWidth)));
  else if (state.loading) right.push(`${paint.accent(state.spinner ?? '◜')} ${paint.dim('Roping in your library…')}`);
  else if (state.library === false) {
    right.push(paint.dim('No Lasso library on this computer, so'));
    right.push(paint.dim('nothing is recorded. Commands read your'));
    right.push(paint.dim('files and what the system knows of them.'));
  }
  else if (!state.recent?.entries?.length) right.push(paint.dim(state.summary?.folders.length ? 'No changes in the last two weeks.' : 'No folders yet. Add one with /index add <path>.'));
  else {
    for (const entry of state.recent.entries.slice(0, 4)) {
      const what = entry.change === 'directory-added' ? `added ${entry.folder}` : entry.change === 'many' ? `changed ${entry.fileCount} files`
        : `${entry.change} ${lastPart(entry.path)}`;
      right.push(`${paint.dim(padEnd(ago(entry.at).replace(' ago', ''), 9))}${actorText(entry.actor, paint)} ${what}`);
    }
    right.push(paint.dim('/log for more'));
  }

  const rows = wide ? Math.max(left.length, right.length + 1) : 0;
  let body;
  if (wide) {
    const rightTop = Math.max(1, Math.floor((left.length - right.length) / 2));
    const placed = Array.from({ length: rows }, (_, index) => right[index - rightTop] ?? '');
    body = Array.from({ length: rows }, (_, index) => `${padEnd(truncate(left[index] ?? '', leftWidth), leftWidth)} ${paint.faint('│')} ${truncate(placed[index], rightWidth)}`);
  } else {
    body = [...left, '', ...right.map((line) => truncate(line, inner))];
  }
  const title = `${paint.accent(paint.bold('Lasso'))} ${paint.dim(state.version ? `v${state.version}` : '')}`.trim();
  return box(body, total, { paint, title, border: PALETTE.accent });
}

const lastPart = (filePath) => String(filePath ?? '').split('/').pop();
