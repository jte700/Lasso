// How each answer is drawn: a coloured dot and a title, then the answer
// hung under a ⎿ rail, as Claude Code draws a tool's result. Every view
// takes plain data and returns lines; the shell prints them, one-shot
// commands print them, tests read them with colour off.

import path from 'node:path';
import { PALETTE, padEnd, padStart, truncate, truncateStart, width, wrap } from './style.js';
import { ago, bytes, clock, count, dayHeading, how, plural, shortHash, stamp, tilde, who } from './format.js';

/** Lines under construction for one answer. */
export class Answer {
  constructor(paint, columns) {
    this.paint = paint;
    this.columns = Math.max(40, columns);
    this.lines = [];
    this.railed = false;
  }

  /** The answer's first line: a dot in its colour, a bold title and a dim note. */
  head(title, { colour = PALETTE.accent, glyph = '●', note = null } = {}) {
    const p = this.paint;
    const noteText = note ? `  ${p.dim(note)}` : '';
    this.lines.push(truncate(`${p.fg(colour)(glyph)} ${p.bold(title)}${noteText}`, this.columns));
    this.railed = false;
    return this;
  }

  /** A line under the rail; the first gets the ⎿. */
  row(text = '', { indent = 0 } = {}) {
    const lead = this.railed ? '    ' : `  ${this.paint.faint('⎿')} `;
    this.railed = true;
    this.lines.push(truncate(`${lead}${' '.repeat(indent)}${text}`, this.columns));
    return this;
  }

  /** Text wrapped to the rail's width. */
  para(text, { indent = 0, style = (value) => value } = {}) {
    for (const line of wrap(text, this.columns - 4 - indent)) this.row(style(line), { indent });
    return this;
  }

  blank() {
    this.lines.push('');
    return this;
  }

  /** Label and value columns. */
  fields(rows, { labelWidth = null } = {}) {
    const kept = rows.filter((row) => row && row[1] !== undefined && row[1] !== null && row[1] !== '');
    const room = labelWidth ?? Math.min(18, Math.max(...kept.map(([label]) => width(label)), 4) + 2);
    for (const [label, value] of kept) this.row(`${this.paint.dim(padEnd(label, room))}${value}`);
    return this;
  }

  hint(text) {
    this.lines.push(`  ${this.paint.dim(styleCommands(text, this.paint))}`);
    return this;
  }

  done() {
    return this.lines;
  }
}

/** Commands written in backticks or after a slash, picked out in the CLI's blue. */
function styleCommands(text, paint) {
  return String(text).replace(/`([^`]+)`/g, (_, command) => paint.accent(command))
    .replace(/(^|\s)(\/[a-z]+)/g, (_, space, command) => `${space}${paint.accent(command)}`);
}

/** A person, agent or Lasso, coloured by which. */
export function actorText(actor, paint) {
  const person = who(actor);
  if (person.kind === 'agent') return paint.pink(`◆ ${person.name}`);
  if (person.kind === 'system') return paint.dim(person.name);
  if (person.kind === 'self') return paint.accent(person.name);
  return paint.lime(person.name);
}

const sparkTicks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
export function sparkline(values, paint) {
  const most = Math.max(1, ...values);
  return values.map((value) => (value === 0 ? paint.faint('·') : paint.accent(sparkTicks[Math.min(7, Math.floor((value / most) * 7.99))]))).join('');
}

// ── the terminal layer's results (find, trace, history, …) ───────────────

export function renderResult(result, paint, columns) {
  const answer = new Answer(paint, columns);
  const colour = result.ok ? PALETTE.accent : PALETTE.pink;
  answer.head(result.headline ?? result.command, { colour, note: result.subhead });
  for (const block of result.blocks ?? []) renderBlock(answer, block, paint);
  const results = result.results ?? [];
  const tabled = (result.blocks ?? []).some((block) => block.kind === 'table');
  if (results.length && !tabled) {
    const shown = results.slice(0, 12);
    const valueWidth = Math.min(18, Math.max(0, ...shown.map((item) => width(item.value ?? ''))));
    for (const item of shown) {
      const tone = item.tone === 'warn' ? paint.orange : paint.bold;
      const value = item.value ? paint.lime(padStart(truncate(String(item.value), valueWidth), valueWidth)) : ' '.repeat(valueWidth);
      const badge = item.badge ? `  ${paint.faint(item.badge)}` : '';
      answer.row(`${value}${valueWidth ? '  ' : ''}${tone(item.title)}${badge}`);
      const detail = (item.lines ?? []).filter((line) => line !== item.title).join(' · ');
      if (detail) answer.row(paint.dim(detail), { indent: valueWidth ? valueWidth + 2 : 2 });
    }
    if (results.length > shown.length) answer.row(paint.dim(`… and ${results.length - shown.length} more`));
  }
  if (!answer.railed && !(result.blocks ?? []).length && !results.length && result.ok) answer.row(paint.dim('Nothing to show.'));
  for (const hint of result.hints ?? []) answer.hint(hint);
  return answer.done();
}

function renderBlock(answer, block, paint) {
  switch (block.kind) {
    case 'blank':
      break;
    case 'text': {
      const style = block.tone === 'dim' ? paint.dim : block.tone === 'warn' ? paint.orange : (value) => value;
      if (block.text.trim()) answer.para(block.text, { style });
      break;
    }
    case 'fields':
      answer.fields(block.rows.map((row) => [row.label, row.tone === 'warn' ? paint.orange(row.value) : row.value]));
      break;
    case 'group': {
      const note = block.note ? `  ${paint.dim(block.note)}` : '';
      answer.row(`${paint.bold(block.label.trim())}${note}`);
      for (const row of block.rows ?? []) {
        const style = row.tone === 'dim' ? paint.dim : row.tone === 'warn' ? paint.orange : (value) => value;
        answer.row(style(row.text ?? ''), { indent: 2 });
      }
      break;
    }
    case 'table':
      renderTable(answer, block.columns, block.rows, paint);
      break;
    default:
      break;
  }
}

function renderTable(answer, columns, rows, paint) {
  const room = answer.columns - 6;
  const widths = columns.map((column, index) => Math.max(width(column), ...rows.map((row) => width(String(row[index] ?? '')))));
  // The widest column gives way first.
  while (widths.reduce((sum, value) => sum + value + 2, 0) > room) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= 8) break;
    widths[widest] -= 1;
  }
  const line = (cells, style = (value) => value) => cells
    .map((cell, index) => padEnd(truncate(String(cell ?? ''), widths[index]), widths[index])).map(style).join('  ');
  answer.row(line(columns, paint.dim));
  for (const row of rows.slice(0, 60)) answer.row(line(row));
  if (rows.length > 60) answer.row(paint.dim(`… and ${rows.length - 60} more rows`));
}

// ── whence ───────────────────────────────────────────────────────────────

// ── log ──────────────────────────────────────────────────────────────────

const CHANGE_GLYPHS = { added: '+', removed: '−', renamed: '→', moved: '→', edited: '●', 'directory-added': '◇', many: '◆' };

export function renderLog(data, paint, columns, now = Date.now()) {
  const lines = [];
  const p = paint;
  lines.push(`${p.accent('●')} ${p.bold('Recent changes')}  ${p.dim(`${plural(data.total, 'change')} in the last ${data.days} days`)}`);
  if (!data.entries.length) {
    lines.push(`  ${p.faint('⎿')} ${p.dim('Nothing recorded in that window.')}`);
    return lines;
  }
  let day = null;
  for (const entry of data.entries) {
    const heading = dayHeading(entry.at, now);
    if (heading !== day) {
      day = heading;
      lines.push(`  ${p.faint('│')}`);
      lines.push(`  ${p.faint('├─')} ${p.bold(heading)}`);
    }
    const glyph = p.fg(entry.actor?.type === 'AI_AGENT' ? PALETTE.pink : changeColour(entry.change))(CHANGE_GLYPHS[entry.change] ?? '●');
    const folder = entry.folder ? p.dim(`${entry.folder}/`) : '';
    const subject = entry.change === 'directory-added' ? `added folder ${p.bold(entry.folder ?? '')} ${p.dim(`· ${plural(entry.fileCount, 'file')}`)}`
      : entry.change === 'many' ? `changed ${plural(entry.fileCount, 'file')} in ${p.bold(entry.folder ?? '')}`
        : `${entry.change} ${folder}${p.bold(entry.path)}${entry.previousPath ? p.dim(` (was ${entry.previousPath})`) : ''}`;
    const head = `  ${p.faint('│')}  ${glyph} ${p.dim(padStart(clock(entry.at), 8))}  ${actorText(entry.actor, p)} ${subject}`;
    lines.push(truncate(head, columns));
    const details = [];
    if (entry.valueChanges?.first) {
      const { label, before, after } = entry.valueChanges.first;
      const more = entry.valueChanges.count > 1 ? p.dim(` and ${entry.valueChanges.count - 1} more`) : '';
      details.push(`${label}  ${p.strike(p.dim(before ?? '—'))} → ${p.lime(after ?? '—')}${more}`);
    }
    if (entry.textChanges) {
      details.push(`${p.green(`+${entry.textChanges.added}`)} ${p.pink(`−${entry.textChanges.removed}`)} ${p.dim(`${entry.textChanges.unit}s`)}`);
    }
    // What each AI wrote in this save, from its own record: Claude's edit in a save credited to it, ChatGPT's answer pasted in a person's.
    for (const write of entry.ai ?? []) {
      const amount = plural(write.characters, 'character');
      const said = write.kind === 'paste' ? `${amount} of its answer pasted in` : `wrote ${amount} ${HOW_WRITTEN[write.kind] ?? ''}`;
      details.push(`${p.fg(agentColour(write.agent))(`[${write.agent.name}]`)} ${p.dim(`${said.trim()}${write.model ? ` · ${write.model}` : ''}`)}`);
    }
    if (entry.request) details.push(p.italic(`"${entry.request}"`) + (entry.initiator ? p.dim(' · asked by ') + actorText(entry.initiator, p) : ''));
    for (const detail of details) lines.push(truncate(`  ${p.faint('│')}  ${p.faint('┆')} ${' '.repeat(9)} ${detail}`, columns));
  }
  lines.push(`  ${p.faint('╵')}`);
  if (data.truncated) lines.push(`  ${p.dim(`Showing ${data.entries.length} of ${data.total}. Narrow it: /log --file name, --by name, --since 2d.`)}`);
  return lines;
}

const changeColour = (change) => ({ added: PALETTE.green, removed: PALETTE.pink, renamed: PALETTE.accent, moved: PALETTE.accent,
  'directory-added': PALETTE.accent, many: PALETTE.accent }[change] ?? PALETTE.lime);

// ── blame ────────────────────────────────────────────────────────────────

export function renderBlame(data, paint, columns, now = Date.now()) {
  const answer = new Answer(paint, columns);
  const people = data.people.map((person) => `${actorText(person.actor, paint)} ${paint.dim(String(person.rows))}`).join(paint.dim(' · '));
  answer.head(`${data.folder.name}/${data.path}`, { note: `${plural(data.total, 'value')} · ${bytes(data.size)}` });
  if (people) answer.row(people);
  if (data.ai) renderAiWritten(answer, data.ai, paint, now);
  if (!data.rows.length) {
    answer.row(paint.dim('Lasso has indexed nothing inside this file yet.'));
    return answer.done();
  }
  // A value is named by its label ("Revenue · Q3"); a passage, whose label is its own words, by its place ("Paragraph 6").
  const named = (row) => (row.label && width(row.label) <= 40 && row.label !== row.value ? row.label : row.place ?? row.label ?? '');
  const placeWidth = Math.min(34, Math.max(...data.rows.map((row) => width(named(row)))));
  const nameWidth = Math.min(16, Math.max(...data.rows.map((row) => width(who(row.actor).name))) + (data.rows.some((row) => row.actor?.type === 'AI_AGENT') ? 2 : 0));
  const valueRoom = Math.max(12, answer.columns - 4 - 5 - 9 - nameWidth - placeWidth - 8);
  for (const row of data.rows) {
    const version = paint.faint(padEnd(`v${row.version ?? '?'}`, 5));
    const when = paint.dim(padEnd(row.at ? ago(row.at, now).replace(' ago', '') : '', 9));
    const actor = padEnd(actorText(row.actor, paint), nameWidth);
    const place = paint.dim(padEnd(truncate(named(row), placeWidth), placeWidth));
    const value = String(row.value ?? '').replace(/\s+/g, ' ');
    const was = row.before && row.kind === 'modified' && String(row.before).length < 30 ? paint.dim(`  was ${row.before}`) : '';
    answer.row(`${version}${when}${actor}  ${place}  ${truncate(value, valueRoom)}${was}`);
  }
  if (data.total > data.rows.length) answer.row(paint.dim(`… and ${data.total - data.rows.length} more`));
  if (data.others?.length) answer.hint(`Also named that: ${data.others.map((other) => `${other.folder}/${other.path}`).join(', ')}`);
  return answer.done();
}

/** Each AI's colour, as the Mac app's brackets draw it. */
export const AGENT_COLOURS = Object.freeze({ claude: '#d97757', chatgpt: '#10a37f', gemini: '#5b8def', copilot: '#3ba7e5', perplexity: '#20b8cd' });
export const agentColour = (agent) => AGENT_COLOURS[String(agent?.id ?? '').replace(/^agent:/, '')] ?? '#a78bfa';

const HOW_WRITTEN = { edit: 'with its edit tool', command: 'by a command it ran', writer: 'through Lasso\'s writer', paste: 'pasted', agent: 'from a review' };

/** The parts of a file an AI wrote: who, where, when, and what asked for it. */
function renderAiWritten(answer, ai, paint, now) {
  const marks = new Map(ai.marks.map((mark) => [mark.id, mark]));
  const byAgent = new Map();
  for (const span of ai.spans) {
    const agent = marks.get(span.markId)?.agent;
    if (agent) byAgent.set(agent.name, { agent, parts: (byAgent.get(agent.name)?.parts ?? 0) + 1 });
  }
  answer.row(`${paint.dim('Written by AI:')} ${[...byAgent.values()].map(({ agent, parts }) => `${paint.fg(agentColour(agent))(`[${agent.name}]`)} ${paint.dim(plural(parts, 'part'))}`).join(paint.dim(' · '))}`);
  for (const span of ai.spans.slice(0, 12)) {
    const mark = marks.get(span.markId);
    if (!mark) continue;
    const colour = paint.fg(agentColour(mark.agent));
    const lines = span.lineStart === span.lineEnd ? `line ${span.lineStart}` : `lines ${span.lineStart}–${span.lineEnd}`;
    const edited = mark.editedInside ? paint.dim(` · ${mark.editedInside} letters since changed`) : '';
    answer.row(`  ${colour('[')}${paint.dim(padEnd(lines, 12))} ${colour(mark.agent.name)} ${paint.dim(`${HOW_WRITTEN[mark.kind] ?? ''}${mark.model ? ` · ${mark.model}` : ''} · ${ago(mark.at, now)}`)}${edited}`);
    answer.row(`   ${truncate(span.text.replace(/\s+/g, ' '), Math.max(20, answer.columns - 8))}${colour(']')}`);
    if (mark.prompt) answer.row(`   ${paint.italic(paint.dim(`asked: "${truncate(mark.prompt.replace(/\s+/g, ' '), Math.max(20, answer.columns - 16))}"`))}`);
  }
  if (ai.spans.length > 12) answer.row(paint.dim(`  … and ${ai.spans.length - 12} more AI-written parts`));
}

/** Above a diff: how many of the lines it added each AI wrote in this save, and how. */
function renderAiInDiff(answer, lines, ai, paint) {
  const marks = new Map(ai.marks.map((mark) => [mark.id, mark]));
  const written = new Set(ai.written);
  const added = lines.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.kind === 'add' && line.after);
  const byAgent = new Map();
  for (const line of added) {
    const mark = marks.get(ai.lines[line.after]);
    if (!mark || !written.has(mark.id)) continue;
    const entry = byAgent.get(mark.agent.id) ?? { mark, lines: 0 };
    entry.lines += 1;
    byAgent.set(mark.agent.id, entry);
  }
  for (const { mark, lines: count } of byAgent.values()) {
    const prompt = mark.prompt ? `  ${paint.italic(paint.dim(`asked: "${truncate(mark.prompt.replace(/\s+/g, ' '), 60)}"`))}` : '';
    const which = count === added.length ? (count === 1 ? 'the added line' : `all ${count} added lines`) : `${count} of the ${added.length} added lines`;
    const said = mark.kind === 'paste' ? `'s answer was pasted into ${which}` : ` wrote ${which} ${HOW_WRITTEN[mark.kind] ?? ''}`;
    answer.row(`${paint.fg(agentColour(mark.agent))(`▎${mark.agent.name}`)}${paint.dim(`${said.trimEnd()}${mark.model ? ` · ${mark.model}` : ''}`)}${prompt}`);
  }
  if (!byAgent.size && Object.keys(ai.lines).length) answer.row(paint.dim('▎ marks lines an AI wrote in an earlier save'));
}

/** The colour of an AI named only by its name, as git and file labels name them. */
export const aiNameColour = (name) => agentColour({ id: `agent:${String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}` });

export { HOW_WRITTEN };

// ── diff ─────────────────────────────────────────────────────────────────

export function renderDiff(data, paint, columns, now = Date.now()) {
  const answer = new Answer(paint, columns);
  const { detail, chosen } = data;
  const versions = detail.version.before ? `v${detail.version.before} → v${detail.version.after}` : `v${detail.version.after}`;
  answer.head(`${data.folder.name}/${data.path}`, { note: `${versions} · ${stamp(chosen.at, now)}` });
  answer.row(`${actorText(chosen.actor, paint)} ${paint.dim(how(chosen.how))}${detail.request ? `  ${paint.italic(`"${truncate(detail.request, 70)}"`)}` : ''}`);
  if (detail.lines && data.ai) renderAiInDiff(answer, detail.lines, data.ai, paint);
  if (detail.lines) renderHunks(answer, detail.lines, paint, data.ai);
  else if (detail.table) renderTableDiff(answer, detail.table, paint);
  else if (detail.fields?.length) {
    for (const field of detail.fields) answer.row(`${paint.dim(field.path)}  ${paint.strike(paint.pink(field.before ?? '—'))} → ${paint.green(field.after ?? '—')}`);
  } else if (detail.values?.length) {
    const labelWidth = Math.min(36, Math.max(...detail.values.map((value) => width(value.label ?? value.place ?? ''))));
    for (const value of detail.values.slice(0, 80)) {
      const label = padEnd(truncate(value.label ?? value.place ?? '', labelWidth), labelWidth);
      const before = value.before == null ? paint.faint('(new)') : paint.strike(paint.pink(truncate(String(value.before), 40)));
      const after = value.after == null ? paint.faint('(removed)') : paint.green(truncate(String(value.after), 40));
      answer.row(`${paint.dim(label)}  ${before} → ${after}`);
    }
    if (detail.valueCount > 80) answer.row(paint.dim(`… and ${detail.valueCount - 80} more values`));
  } else if (detail.bytesReleased) answer.row(paint.dim('The bytes of this version were released to save space; only its record remains.'));
  else answer.row(paint.dim(`${detail.change} · ${bytes(detail.file?.before?.size)} → ${bytes(detail.file?.after?.size)}`));
  if (data.onDisk === 'changed') answer.row(paint.orange('The file on disk has changed since this was recorded.'));
  const earlier = data.changes.filter((change) => change.id !== chosen.id).slice(0, 6);
  if (earlier.length) answer.hint(`Other versions: ${earlier.map((change) => `v${change.version} ${ago(change.at, now)}`).join(' · ')}  (/diff ${path.posix.basename(data.path)} v${earlier[0].version})`);
  return answer.done();
}

/**
 * A diff's lines. With `ai` (which lines of the new version hold an AI's
 * characters), those lines carry a bar in that AI's colour, as the Mac app
 * brackets them.
 */
export function renderHunks(answer, lines, paint, ai = null) {
  answer.row(`${paint.green(`+${lines.added}`)} ${paint.pink(`−${lines.removed}`)}`);
  const numberWidth = Math.max(3, ...lines.hunks.flatMap((hunk) => hunk.lines.map((line) => String(line.after ?? line.before ?? '').length)));
  const agents = new Map((ai?.marks ?? []).map((mark) => [mark.id, mark.agent]));
  const bar = (line) => {
    if (!ai) return '';
    const agent = line.kind !== 'remove' && line.after ? agents.get(ai.lines[line.after]) : null;
    return agent ? paint.fg(agentColour(agent))('▎') : ' ';
  };
  lines.hunks.forEach((hunk, index) => {
    if (index) answer.row(paint.faint('┈'.repeat(12)));
    for (const line of hunk.lines) {
      const number = paint.faint(padStart(String(line.after ?? line.before ?? ''), numberWidth));
      if (line.kind === 'add') answer.row(`${number}${bar(line)} ${paint.pair(PALETTE.cream, '#173a22')(`+ ${line.text}`)}`);
      else if (line.kind === 'remove') answer.row(`${number}${bar(line)} ${paint.pair(PALETTE.cream, '#4a1d27')(`- ${line.text}`)}`);
      else answer.row(`${number}${bar(line)} ${paint.dim(`  ${line.text}`)}`);
    }
  });
  if (lines.truncated) answer.row(paint.dim('… the rest of the change is longer than shown here'));
}

function renderTableDiff(answer, table, paint) {
  const { counts } = table;
  answer.row(paint.dim([counts.cellsChanged && plural(counts.cellsChanged, 'cell') + ' changed',
    counts.rowsAdded && plural(counts.rowsAdded, 'row') + ' added', counts.rowsRemoved && plural(counts.rowsRemoved, 'row') + ' removed']
    .filter(Boolean).join(' · ') || 'no cells changed'));
  const rowWidth = Math.min(28, Math.max(4, ...table.cells.map((cell) => width(String(cell.row ?? '')))));
  const columnWidth = Math.min(22, Math.max(4, ...table.cells.map((cell) => width(String(cell.column ?? '')))));
  for (const cell of table.cells.slice(0, 80)) {
    answer.row(`${padEnd(truncate(String(cell.row ?? ''), rowWidth), rowWidth)}  ${paint.dim(padEnd(truncate(String(cell.column ?? ''), columnWidth), columnWidth))}  `
      + `${paint.strike(paint.pink(cell.before ?? '—'))} → ${paint.green(cell.after ?? '—')}`);
  }
  for (const row of table.rowsAdded.slice(0, 20)) answer.row(paint.green(`+ ${rowText(row)}`));
  for (const row of table.rowsRemoved.slice(0, 20)) answer.row(paint.pink(`− ${rowText(row)}`));
}

const rowText = (row) => (typeof row === 'string' ? row : row?.key ?? Object.values(row ?? {}).join(', '));

// ── verify ───────────────────────────────────────────────────────────────

const VERDICT = {
  current: { glyph: '✓', colour: PALETTE.green, word: 'matches' },
  stale: { glyph: '⚠', colour: PALETTE.orange, word: 'stale' },
  ambiguous: { glyph: '?', colour: PALETTE.yellow, word: 'unclear' },
  unsourced: { glyph: '·', colour: PALETTE.grey, word: 'no source' },
};

export function renderVerify(data, paint, columns, now = Date.now(), { all = false } = {}) {
  const answer = new Answer(paint, columns);
  const { tally } = data;
  const colour = tally.stale ? PALETTE.orange : PALETTE.green;
  const against = data.mode !== 'files' ? '' : data.against ? ` against ${data.against}`
    : ` against ${plural(data.sources.length, 'spreadsheet')} beside it`;
  answer.head(`Verified ${data.name}`, { colour, note: `${plural(data.numbers, 'number')} checked${against}` });
  answer.row([
    paint.green(`✓ ${tally.current} match`),
    tally.stale ? paint.orange(`⚠ ${tally.stale} stale`) : paint.dim('⚠ 0 stale'),
    paint.yellow(`? ${tally.ambiguous} unclear`),
    paint.dim(`· ${tally.unsourced} without a source`),
  ].join('   '));
  const order = { stale: 0, ambiguous: 1, current: 2, unsourced: 3 };
  const shown = data.results.filter((result) => all || result.status !== 'unsourced')
    .sort((a, b) => order[a.status] - order[b.status] || a.line - b.line);
  for (const result of shown) {
    const verdict = VERDICT[result.status];
    const sentence = highlightNumber(result.sentence, result.number, paint, verdict.colour);
    answer.row('');
    answer.row(`${paint.fg(verdict.colour)(verdict.glyph)} ${paint.faint(padEnd(`line ${result.line}`, 9))} ${sentence}`);
    const source = result.source;
    if (result.status === 'current') {
      answer.row(paint.dim(`${source.label} · ${placeOfSource(source)}${source.place ? ` · ${source.place}` : ''}`), { indent: 12 });
    } else if (result.status === 'stale') {
      answer.row(source.removed ? `${paint.dim(source.label)} ${paint.orange('is no longer in')} ${paint.dim(placeOfSource(source))}`
        : `${paint.dim(source.label)} is now ${paint.lime(source.currentValue)} ${paint.dim(`in ${placeOfSource(source)}`)}`, { indent: 12 });
      if (result.change) {
        answer.row(paint.dim(`changed ${stamp(result.change.at, now)} by `) + actorText(result.change.actor, paint)
          + paint.dim(` · ${result.change.before} → ${result.change.after} · v${result.change.version}`), { indent: 12 });
      }
    } else if (result.status === 'ambiguous') {
      answer.row(paint.dim(truncate(`${plural(result.candidates, 'value')} equal ${result.number}, none named in the sentence; e.g. ${source.label} in ${source.path}`, answer.columns - 18)), { indent: 12 });
    } else answer.row(paint.dim(data.mode === 'files' ? 'none of the files checked holds this number' : 'no indexed value says this'), { indent: 12 });
  }
  if (data.mode === 'files') {
    if (!data.sources.length) {
      answer.row('');
      answer.para(data.against ? `Lasso found no spreadsheet, CSV or document to read at ${data.against}.`
        : `There is no spreadsheet or CSV beside it in ${data.beside}. Name what to check against with --against <file or folder>.`, { style: paint.orange });
    } else {
      answer.row('');
      answer.row(paint.dim(`read ${data.sources.map((source) => `${path.basename(source.path)} (${plural(source.values, 'number')})`).join(', ')}`));
    }
  }
  if (!all && tally.unsourced) answer.hint(`${plural(tally.unsourced, 'number')} with no source hidden; /verify ${/\s/.test(data.name) ? `"${data.name}"` : data.name} --all lists them.`);
  return answer.done();
}

const placeOfSource = (source) => (source.folder ? `${source.folder}/${source.path}` : source.path);

function highlightNumber(sentence, number, paint, colour) {
  const text = truncate(sentence, 110);
  const at = text.indexOf(number);
  if (at < 0) return text;
  return `${text.slice(0, at)}${paint.bold(paint.fg(colour)(number))}${text.slice(at + number.length)}`;
}

// ── status ───────────────────────────────────────────────────────────────

export function renderStatus(summary, paint, columns, { dataDir = null, now = Date.now() } = {}) {
  const answer = new Answer(paint, columns);
  answer.head('Library', { note: dataDir ? tilde(dataDir) : null });
  answer.fields([
    ['folders', `${summary.folders.length}`],
    ['files', count(summary.files)],
    ['versions', `${count(summary.versions)} recorded${summary.since ? ` since ${stamp(summary.since, now).split(',')[0]}` : ''}`],
    ['value changes', count(summary.valueChanges)],
    ['last 14 days', `${sparkline(summary.activity, paint)}  ${paint.dim(plural(summary.activity.reduce((a, b) => a + b, 0), 'change'))}`],
    summary.failures ? ['needs attention', paint.orange(plural(summary.failures, 'file') + ' Lasso could not read')] : null,
    summary.ai?.length ? ['written by AI', aiWritesText(summary.ai, paint)] : null,
    summary.claudeHook ? ['Claude Code', summary.claudeHook.installed && summary.claudeHook.scriptFound ? `${paint.green('●')} ${paint.dim('what Claude writes is recorded')}`
      : `${paint.dim('○ not recorded')}  ${paint.dim('(')}${paint.accent('/hooks install')}${paint.dim(')')}`] : null,
  ]);
  if (summary.folders.length) {
    answer.row('');
    const nameWidth = Math.min(24, Math.max(...summary.folders.map((folder) => width(folder.name))));
    for (const folder of summary.folders) {
      answer.row(`${paint.accent('■')} ${padEnd(truncate(folder.name, nameWidth), nameWidth)}  ${paint.dim(padStart(count(folder.files), 7))} files  `
        + `${paint.faint(padStart(`v${folder.version ?? 0}`, 6))}  ${paint.dim(folder.lastAt ? `changed ${ago(folder.lastAt, now)}` : '')}  `
        + paint.faint(truncateStart(tilde(folder.rootPath), 40)));
    }
  }
  // Lasso records under more than one name of its own; each person is listed once, as the CLI names them.
  const people = new Map();
  for (const person of summary.people) {
    const actor = { name: person.name, type: person.type };
    const key = who(actor).name;
    people.set(key, { actor, events: (people.get(key)?.events ?? 0) + person.events });
  }
  if (people.size) {
    answer.row('');
    const ranked = [...people.values()].sort((a, b) => b.events - a.events).slice(0, 6);
    answer.row(`${paint.dim('who changed things')}  ${ranked.map((person) => `${actorText(person.actor, paint)} ${paint.dim(String(person.events))}`).join(paint.dim(' · '))}`);
  }
  return answer.done();
}

const WRITE_WORDS = { edit: ['edit', 'edits'], command: ['command', 'commands'], writer: ['answer', 'answers'], paste: ['paste', 'pastes'], agent: ['review edit', 'review edits'] };

/** "[Claude] 12 edits, 2 commands · [ChatGPT] 3 pastes". */
function aiWritesText(writes, paint) {
  const byAgent = new Map();
  for (const write of writes) {
    const entry = byAgent.get(write.agent.id) ?? { agent: write.agent, kinds: [] };
    const [one, many] = WRITE_WORDS[write.kind] ?? ['write', 'writes'];
    entry.kinds.push(`${write.count} ${write.count === 1 ? one : many}`);
    byAgent.set(write.agent.id, entry);
  }
  return [...byAgent.values()].map(({ agent, kinds }) => `${paint.fg(agentColour(agent))(`[${agent.name}]`)} ${paint.dim(kinds.join(', '))}`).join(paint.dim(' · '));
}

// ── hooks ────────────────────────────────────────────────────────────────

/** What `/hooks` did or found, from runHooksCommand's { code, text }. */
export function renderHooks(outcome, paint, columns, { library = true } = {}) {
  const answer = new Answer(paint, columns);
  const [first, ...rest] = String(outcome.text ?? '').split('\n');
  const good = outcome.code === 0;
  answer.head('Claude Code', { colour: good ? PALETTE.accent : PALETTE.orange, glyph: good ? '●' : '○', note: 'Lasso\'s hook in its settings' });
  answer.para(first.replace(/^Claude Code: /, ''), { style: (line) => styleCommands(line, paint) });
  for (const line of rest) answer.para(line, { style: paint.dim });
  if (!library) answer.para('There is no Lasso library on this computer, so the hook writes nothing until the Lasso app has one.', { style: paint.dim });
  return answer.done();
}

// ── watch ────────────────────────────────────────────────────────────────

export function renderEvent(event, paint, columns) {
  const p = paint;
  const glyph = event.actor?.type === 'AI_AGENT' ? p.pink('◆') : event.how?.startsWith('DEPENDENCY') ? p.lime('⇢') : p.accent('●');
  const files = event.files.map((file) => `${p.dim(file.change.toLowerCase())} ${file.path}`).join(p.dim(', '));
  const more = event.fileCount > event.files.length ? p.dim(` +${event.fileCount - event.files.length}`) : '';
  const lines = [truncate(`${glyph} ${p.dim(clock(event.at))}  ${p.faint(event.folder)}  ${actorText(event.actor, p)} ${p.dim(how(event.how))}  ${files || p.dim(event.title)}${more}`, columns)];
  for (const value of event.values ?? []) {
    lines.push(truncate(`  ${p.faint('┆')} ${' '.repeat(7)}${p.dim(value.label)}  ${p.strike(p.dim(value.before ?? '—'))} → ${p.lime(value.after ?? '—')}`, columns));
  }
  return lines;
}

// ── errors and help ──────────────────────────────────────────────────────

export function renderError(message, paint, columns) {
  const answer = new Answer(paint, columns);
  answer.head(message, { colour: PALETTE.pink, glyph: '✗' });
  return answer.done();
}

export function renderHelp(commands, paint, columns) {
  const lines = [`${paint.accent('●')} ${paint.bold('Lasso CLI')}  ${paint.dim('every answer comes from what your folders recorded; no model involved')}`];
  const groups = new Map();
  for (const command of commands) {
    if (command.hidden) continue;
    if (!groups.has(command.group)) groups.set(command.group, []);
    groups.get(command.group).push(command);
  }
  const nameWidth = Math.max(...commands.map((command) => width(`/${command.name}`))) + 1;
  const argsWidth = Math.min(24, Math.max(...commands.map((command) => width(command.args ?? ''))));
  for (const [group, list] of groups) {
    lines.push('');
    lines.push(`  ${paint.accent(paint.bold(group))}`);
    for (const command of list) {
      const args = padEnd(truncate(command.args ?? '', argsWidth), argsWidth);
      lines.push(truncate(`    ${paint.accent(padEnd(`/${command.name}`, nameWidth))} ${paint.dim(args)}  ${command.summary}`, columns));
    }
  }
  lines.push('');
  lines.push(`  ${paint.dim('Type a question or a name without a slash to search. Tab completes, ↑ ↓ walk history, Esc clears, Ctrl+C twice quits.')}`);
  return lines;
}
