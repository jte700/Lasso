// How the answers about any file are drawn (anywhere.js): where a file came
// from, who wrote what in a file outside Lasso's folders, two files
// compared, and a folder's recent changes read from its files' dates.
// Lasso's own record is drawn first where it has one, as views.js draws it.

import path from 'node:path';
import { PALETTE, padEnd, padStart, truncate, truncateStart, width } from './style.js';
import { ago, bytes, clock, count, dayHeading, how, plural, shortDate, shortHash, stamp, tilde } from './format.js';
import { Answer, HOW_WRITTEN, actorText, agentColour, aiNameColour, renderBlame, renderDiff, renderHunks, renderLog } from './views.js';

const LABEL = 16;

/** Label and value rows under a section, inside the rail. */
function fields(answer, rows, { indent = 2 } = {}) {
  for (const row of rows) {
    if (!row || row[1] === null || row[1] === undefined || row[1] === '') continue;
    answer.row(`${answer.paint.dim(padEnd(row[0], LABEL))}${row[1]}`, { indent });
  }
}

const section = (answer, title, note = null) => answer.row(`${answer.paint.accent(answer.paint.bold(title))}${note ? `  ${answer.paint.dim(note)}` : ''}`);

/** An address without its scheme, its query cut short. */
function shortUrl(url) {
  const text = String(url ?? '').replace(/^[a-z]+:\/\//i, '').replace(/\/$/, '');
  const [base, query] = text.split('?');
  return query ? `${base}?${truncate(query, 24)}` : base;
}

/** "12 s", "4 min 5 s", "1 h 2 min". */
export function duration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (total < 60) return `${total} s`;
  if (total < 3600) return `${Math.floor(total / 60)} min${total % 60 ? ` ${total % 60} s` : ''}`;
  return `${Math.floor(total / 3600)} h${Math.floor((total % 3600) / 60) ? ` ${Math.floor((total % 3600) / 60)} min` : ''}`;
}

/** An encoder as it names itself, with the program behind a library's name. */
const encoderName = (name) => (/^Lavf/.test(name) ? `${name} (FFmpeg)` : name);

const minutes = (value) => (value >= 60 ? duration(value * 60) : `${value} min`);

// ── whence ───────────────────────────────────────────────────────────────

export function renderWhence(data, paint, columns, now = Date.now()) {
  const answer = new Answer(paint, columns);
  const p = paint;
  if (data.matches.length) {
    const current = data.matches.find((match) => match.current);
    answer.head(data.name, { note: current ? 'identical to a recorded version, still current' : 'identical to a recorded version' });
    section(answer, 'In your Lasso library');
    for (const match of data.matches) {
      answer.row(`${p.bold(`${match.folder.name}/${match.path}`)}  ${p.faint(`v${match.version}`)}`, { indent: 2 });
      answer.row(`${p.dim('first recorded')}  ${stamp(match.recordedAt, now)} by ${actorText(match.actor, p)} ${p.dim(`· ${how(match.how)}`)}`, { indent: 4 });
      if (match.request) answer.row(`${p.dim('asked')}           ${p.italic(`"${truncate(match.request, 80)}"`)}`, { indent: 4 });
      if (match.current) answer.row(p.green('✓ still the current content of this file'), { indent: 4 });
      else if (match.replaced) {
        answer.row(`${p.orange('↻ replaced')}      ${stamp(match.replaced.at, now)} by ${actorText(match.replaced.actor, p)} ${p.dim(`· v${match.replaced.version}`)}`, { indent: 4 });
      } else answer.row(p.dim('no longer in the folder'), { indent: 4 });
    }
  } else if (data.tracked) {
    answer.head(data.name, { colour: PALETTE.orange, glyph: '○', note: `in ${data.tracked.folder.name}, changed since Lasso recorded it` });
    answer.row(p.orange(data.tracked.recorded ? 'Its bytes on disk are not a version Lasso recorded; the app records them when it next sees the folder.'
      : 'New since Lasso last read the folder.'));
  } else {
    answer.head(data.name, { colour: PALETTE.accent, note: `${data.library ? 'not in your Lasso folders · ' : ''}read on the spot · ${bytes(data.size)}` });
    answer.row(answer.paint.dim(truncateStart(tilde(data.file), answer.columns - 6)));
    if (data.sameName?.length) {
      section(answer, 'Same name in your Lasso library', 'different bytes');
      for (const file of data.sameName) {
        const when = file.changedAt ? `changed ${ago(file.changedAt, now)} by ${actorText(file.actor, p)}` : '';
        answer.row(`${file.folder}/${file.path}  ${p.dim(bytes(file.size))}  ${p.dim(when)}`, { indent: 2 });
      }
    }
  }
  renderAi(answer, data, now);
  renderThisMac(answer, data, now);
  renderInside(answer, data.embedded, now, data.aiLabels?.madeWithAi ? null : data.aiLabels);
  renderGit(answer, data.git, now);
  renderCopies(answer, data.copies, now);
  if (data.names?.length) {
    section(answer, 'Names like it', 'names only; nothing says one came from the other');
    renderPaths(answer, data.names.map((file) => [file.path, `${bytes(file.size)} · modified ${shortDate(file.modified, now)}`]));
  }
  if (data.others?.length) answer.row(p.dim(`Also named ${data.name}: ${data.others.map((other) => tilde(other)).join(', ')}`));
  answer.row(p.faint(`sha256 ${shortHash(data.hash)}`));
  return answer.done();
}

/**
 * What AIs wrote of the file, from each tool's own record: Lasso's (Claude
 * Code's hooks, its writer, pastes from AI apps), the labels the file
 * carries, and commits that name an AI.
 */
function renderAi(answer, data, now) {
  const p = answer.paint;
  const record = data.ai;
  const labels = data.aiLabels?.madeWithAi ? data.aiLabels : null;
  const aiCommits = (data.git?.commits ?? []).filter((commit) => commit.ai?.length);
  if (!record && !labels && !aiCommits.length) return;
  section(answer, record || aiCommits.length ? 'Written with AI' : 'Made with AI', 'as the tools recorded it; nothing is guessed from the content');
  if (record) {
    for (const entry of record.agents) {
      const colour = p.fg(agentColour(entry.agent));
      const share = entry.share >= 0.995 ? 'all of the text' : entry.share < 0.01 ? 'under 1% of the text' : `${Math.round(entry.share * 100)}% of the text`;
      const ways = entry.kinds.map((kind) => HOW_WRITTEN[kind]).filter(Boolean).join(', ');
      answer.row(`${colour(padEnd(`[${entry.agent.name}]`, LABEL))}${share} ${p.dim(`· ${plural(entry.parts, 'part')} · ${ways}${entry.model ? ` · ${entry.model}` : ''} · ${ago(entry.at, now)}`)}`, { indent: 2 });
      if (entry.prompt) answer.row(`${' '.repeat(LABEL)}${p.italic(p.dim(`asked: "${truncate(entry.prompt.replace(/\s+/g, ' '), Math.max(20, answer.columns - LABEL - 20))}"`))}`, { indent: 2 });
    }
    answer.row(p.dim(`${' '.repeat(LABEL)}${record.current ? '' : 'of the version Lasso recorded, before the file changed · '}/blame lists each part`), { indent: 2 });
  }
  if (labels) labelRows(answer, labels);
  if (aiCommits.length) {
    const names = [...new Set(aiCommits.flatMap((commit) => commit.ai))];
    const of = data.git.commits.length >= 12 ? 'its last 12' : `its ${data.git.commits.length}`;
    fields(answer, [['git', `${names.map((name) => p.fg(aiNameColour(name))(name)).join(', ')} ${p.dim(`named as author or co-author on ${aiCommits.length} of ${of} commits`)}`]]);
  }
}

/** The AI labels a file carries in its own bytes, each as the file says it. */
function labelRows(answer, labels) {
  const p = answer.paint;
  const generation = labels.generation;
  fields(answer, [
    ['source type', labels.sourceType ? `${labels.sourceType.words} ${p.dim('· the IPTC label written in the file')}` : null],
    ['credentials', labels.credentials ? (labels.credentials.tools.length
      ? `${labels.credentials.tools.map((tool) => p.bold(tool)).join(', ')} ${p.dim('· named in its Content Credentials (C2PA)')}`
      : p.dim('carries Content Credentials (C2PA)')) : null],
    ['generated with', generation ? `${generation.by ?? 'settings'} ${p.dim(`in its "${generation.key}" text:`)} ${p.italic(truncate(generation.text, Math.max(20, answer.columns - LABEL - 40)))}` : null],
    ['software', labels.software],
    ['AI record', labels.record ? (labels.record.valid
      ? `${labels.record.agents.map((agent) => `${p.bold(agent.name)} wrote ${plural(agent.parts, 'part')}`).join(', ') || 'no AI-written parts'} ${p.dim(`· recorded by ${labels.record.by}\u2019s Lasso and signed by it`)}`
      : p.dim(`a record naming ${labels.record.by}\u2019s Lasso, changed since it was signed`)) : null],
  ]);
}

function renderThisMac(answer, data, now) {
  const p = answer.paint;
  const system = data.system ?? {};
  const spot = system.spotlight ?? {};
  const added = spot.addedAt && Math.abs(Date.parse(spot.addedAt) - Date.parse(system.created ?? 0)) > 60_000 ? spot.addedAt : null;
  const media = [spot.duration ? duration(spot.duration) : null, spot.pixels, spot.pages ? plural(spot.pages, 'page') : null,
    spot.codecs?.length ? spot.codecs.join(', ') : null].filter(Boolean).join(' · ');
  const rows = [
    ['downloaded from', spot.whereFrom?.[0] ? p.accentBright(shortUrl(spot.whereFrom[0])) : null],
    ['  on the page', spot.whereFrom?.[1] && spot.whereFrom[1] !== spot.whereFrom[0] ? p.dim(shortUrl(spot.whereFrom[1])) : null],
    ['downloaded', spot.downloadedAt ? stamp(spot.downloadedAt, now) : null],
    ['downloaded from', system.zone?.host ? p.accentBright(shortUrl(system.zone.host)) : null],
    ['  on the page', system.zone?.referrer ? p.dim(shortUrl(system.zone.referrer)) : null],
    ['received', spot.received ? [spot.received.via && `by ${spot.received.via}`, spot.received.from && `from ${spot.received.from}`,
      spot.received.at && stamp(spot.received.at, now)].filter(Boolean).join(' · ') : null],
    ['created', system.created ? stamp(system.created, now) : null],
    ['modified', system.modified && system.modified !== system.created ? stamp(system.modified, now) : null],
    ['put here', added ? stamp(added, now) : null],
    ['last opened', spot.lastOpenedAt ? `${stamp(spot.lastOpenedAt, now)}${spot.opens ? p.dim(` · opened ${plural(spot.opens, 'time')}`) : ''}` : null],
    // A PDF's own information says the same, under "Inside the file".
    ['made with', data.embedded?.pdf ? null : spot.creator],
    ['written by', spot.encoders?.length && !data.embedded?.pdf ? spot.encoders.map(encoderName).join(', ') : null],
    ['camera', spot.camera],
    ['location', spot.location ? `${spot.location.latitude.toFixed(4)}, ${spot.location.longitude.toFixed(4)}` : null],
    ['contents', media || null],
    ['authors', spot.authors?.length && !data.embedded?.properties && !data.embedded?.pdf ? spot.authors.join(', ') : null],
    ['macOS mark', system.mark?.app ? `${system.mark.app}${system.mark.at ? p.dim(` · ${shortDate(system.mark.at, now)}`) : ''}` : null],
    ['Finder comment', spot.comment ? p.italic(spot.comment) : null],
  ];
  if (!rows.some((row) => row[1])) return;
  section(answer, 'On this computer');
  fields(answer, rows);
}

function renderInside(answer, embedded, now, labels = null) {
  const p = answer.paint;
  const properties = embedded?.properties;
  const pdf = embedded?.pdf;
  if (!properties && !pdf && !embedded?.tracked && !labels) return;
  section(answer, 'Inside the file', 'what the file says of itself');
  // Content Credentials that name no AI: who made or edited it, as its manifest says.
  if (labels) labelRows(answer, labels);
  if (properties) {
    fields(answer, [
      ['title', properties.title],
      ['created by', properties.createdBy ? `${p.lime(properties.createdBy)}${properties.created ? p.dim(` · ${stamp(properties.created, now)}`) : ''}` : null],
      ['last saved by', properties.lastSavedBy ? `${p.lime(properties.lastSavedBy)}${properties.saved ? p.dim(` · ${stamp(properties.saved, now)}`) : ''}` : null],
      ['app', properties.app],
      ['edited for', properties.editingMinutes ? `${minutes(properties.editingMinutes)}${properties.revision ? p.dim(` · revision ${properties.revision}`) : ''}` : null],
      ['company', properties.company],
      ['last printed', properties.printed ? stamp(properties.printed, now) : null],
    ]);
  }
  if (pdf) {
    fields(answer, [
      ['title', pdf.title], ['author', pdf.author ? p.lime(pdf.author) : null], ['made with', pdf.creator], ['PDF written by', pdf.producer],
      ['created', pdf.created && !Number.isNaN(Date.parse(pdf.created)) ? stamp(pdf.created, now) : pdf.created],
      ['modified', pdf.modified && !Number.isNaN(Date.parse(pdf.modified)) ? stamp(pdf.modified, now) : pdf.modified],
    ]);
  }
  if (embedded?.tracked) {
    const tally = embedded.tracked.authors.map((author) => `${p.lime(author.name)} ${p.dim(String(author.inserted + author.deleted + author.comment))}`).join(p.dim(' · '));
    fields(answer, [['tracked changes', `${tally}  ${p.dim('(/blame lists them)')}`]]);
  }
}

/** " with Claude" after a commit's author, for a commit that names an AI other than its author. */
const withAi = (commit, p) => (commit?.ai?.length ? p.dim(' with ') + commit.ai.map((name) => p.fg(aiNameColour(name))(name)).join(p.dim(', ')) : '');

const GIT_STATES = {
  clean: (p) => p.green('committed as it is'),
  modified: (p) => p.orange('changed since its last commit'),
  untracked: (p) => p.orange('never committed'),
  ignored: (p) => p.dim('ignored by git'),
};

function renderGit(answer, git, now) {
  if (!git) return;
  const p = answer.paint;
  section(answer, 'In git', tilde(git.root));
  const last = git.commits[0];
  fields(answer, [
    ['state', GIT_STATES[git.state]?.(p) ?? git.state],
    ['last commit', last ? `${p.faint(last.short)} ${p.lime(last.author)}${withAi(last, p)} ${p.dim(`· ${ago(last.at, now)}`)}  ${p.italic(truncate(last.subject, 50))}` : null],
    ['these bytes', git.firstWithBytes ? `first committed in ${p.faint(git.firstWithBytes.short)} by ${p.lime(git.firstWithBytes.author)} ${p.dim(`· ${stamp(git.firstWithBytes.at, now)}`)}` : null],
    ['commits', git.commits.length > 1 ? `${git.commits.length >= 12 ? '12 or more' : git.commits.length}  ${p.dim('(/diff shows the last change)')}` : null],
    ['remote', git.remote ? p.dim(git.remote) : null],
  ]);
}

function renderCopies(answer, copies, now) {
  if (!copies?.copies?.length) return;
  section(answer, 'Same bytes elsewhere', plural(copies.copies.length, 'copy', 'copies'));
  renderPaths(answer, copies.copies.map((copy) => [copy.path, [copy.created && `created ${shortDate(copy.created, now)}`,
    copy.addedAt && `put there ${shortDate(copy.addedAt, now)}`, copy.whereFrom?.[0] && `from ${shortUrl(copy.whereFrom[0]).split('/')[0]}`]
    .filter(Boolean).join(' · ')]));
}

/** Paths with a note each: beside them when there is room, else under each. */
function renderPaths(answer, rows) {
  const p = answer.paint;
  const shown = rows.map(([file, note]) => [tilde(file), note]);
  const pathWidth = Math.max(...shown.map(([file]) => width(file)));
  const noteWidth = Math.max(...shown.map(([, note]) => width(note)));
  if (pathWidth + noteWidth + 2 <= answer.columns - 8) {
    for (const [file, note] of shown) answer.row(`${padEnd(file, pathWidth)}  ${p.dim(note)}`, { indent: 2 });
    return;
  }
  for (const [file, note] of shown) {
    answer.row(truncateStart(file, answer.columns - 8), { indent: 2 });
    if (note) answer.row(p.dim(note), { indent: 4 });
  }
}

// ── blame ────────────────────────────────────────────────────────────────

export function renderAnywhereBlame(data, paint, columns, now = Date.now()) {
  if (data.kind === 'library') return renderBlame(data, paint, columns, now);
  const answer = new Answer(paint, columns);
  const p = paint;
  if (data.kind === 'git') {
    answer.head(data.shown, { note: `git blame · ${plural(data.total, 'line')}` });
    answer.row(data.authors.map((author) => `${author.name ? p.lime(author.name) : p.orange('not committed')} ${p.dim(String(author.lines))}`).join(p.dim(' · ')));
    for (const ai of data.ais ?? []) {
      answer.row(`${p.fg(aiNameColour(ai.name))(`▎${ai.name}`)} ${p.dim(`is named as author or co-author on the commits of ${plural(ai.lines, 'line')}`)}`);
    }
    const nameWidth = Math.min(16, Math.max(8, ...data.lines.map((line) => width(line.author ?? 'not committed'))));
    const numberWidth = String(data.lines.at(-1)?.number ?? 1).length;
    let previous = null;
    for (const line of data.lines.slice(0, 200)) {
      const fresh = line.hash !== previous;
      previous = line.hash;
      const who = fresh ? (line.hash ? p.lime(padEnd(truncate(line.author ?? '', nameWidth), nameWidth)) : p.orange(padEnd('not committed', nameWidth))) : ' '.repeat(nameWidth);
      const hash = fresh ? p.faint(padEnd(line.hash ?? '·······', 7)) : ' '.repeat(7);
      const when = fresh && line.at ? p.dim(padEnd(ago(line.at, now).replace(' ago', ''), 10)) : ' '.repeat(10);
      const bar = line.ai?.length ? p.fg(aiNameColour(line.ai[0]))('▎') : ' ';
      answer.row(`${hash} ${who} ${when}${p.faint(padStart(String(line.number), numberWidth))}${bar} ${line.text}`);
    }
    if (data.total > 200) answer.row(p.dim(`… and ${data.total - 200} more lines`));
    return answer.done();
  }
  if (data.kind === 'word') {
    const { tracked } = data;
    answer.head(data.name, { note: `${plural(tracked.total, 'tracked change')} and comments, as Word recorded them` });
    answer.row(tracked.authors.map((author) => `${p.lime(author.name)} ${p.green(`+${author.inserted}`)} ${p.pink(`−${author.deleted}`)}${author.comment ? p.dim(` · ${plural(author.comment, 'comment')}`) : ''}`).join(p.dim('   ')));
    const nameWidth = Math.min(18, Math.max(...tracked.items.map((item) => width(item.author ?? 'Unknown'))));
    for (const item of tracked.items.slice(0, 80)) {
      const mark = item.kind === 'inserted' ? p.green('+') : item.kind === 'deleted' ? p.pink('−') : p.accent('◇');
      const text = truncate(item.text.replace(/\s+/g, ' '), Math.max(20, answer.columns - nameWidth - 26));
      const words = item.kind === 'deleted' ? p.strike(p.pink(text)) : item.kind === 'inserted' ? p.green(text) : p.italic(text);
      answer.row(`${mark} ${p.lime(padEnd(truncate(item.author ?? 'Unknown', nameWidth), nameWidth))}  ${p.dim(padEnd(item.at ? shortDate(item.at, now) : '', 7))}  ${words}`);
    }
    if (tracked.total > 80) answer.row(p.dim(`… and ${tracked.total - 80} more`));
    return answer.done();
  }
  answer.head(data.name, { colour: PALETTE.accent,
    note: data.aiLabels?.record?.valid ? 'an AI record carried in the file' : 'no record of who wrote each part' });
  const where = data.git?.state === 'untracked' ? `It sits in the git repository ${tilde(data.git.root)} but was never committed`
    : data.git?.state === 'ignored' ? `Git ignores it in ${tilde(data.git.root)}`
      : `It is in no ${data.inLibrary ? 'Lasso folder or ' : ''}git repository`;
  const record = data.aiLabels?.record?.valid ? data.aiLabels.record : null;
  answer.para(record ? `${where}, but it carries the AI record ${record.by}\u2019s Lasso wrote into it.`
    : `${where}, and holds no tracked changes, so nothing recorded who wrote each part.`, { style: p.dim });
  const properties = data.properties;
  if (properties || data.pdf) {
    fields(answer, [
      ['created by', properties?.createdBy ? `${p.lime(properties.createdBy)}${properties.created ? p.dim(` · ${stamp(properties.created, now)}`) : ''}` : null],
      ['last saved by', properties?.lastSavedBy ? `${p.lime(properties.lastSavedBy)}${properties.saved ? p.dim(` · ${stamp(properties.saved, now)}`) : ''}` : null],
      ['author', data.pdf?.author ? p.lime(data.pdf.author) : null],
      ['made with', properties?.app ?? data.pdf?.creator ?? null],
    ], { indent: 0 });
  }
  if (data.aiLabels) {
    section(answer, data.aiLabels.madeWithAi ? 'Made with AI' : 'Inside the file', 'what the file says of itself');
    labelRows(answer, data.aiLabels);
  }
  answer.hint(`/whence ${quote(data.shown)} says where it came from.`);
  return answer.done();
}

// ── diff ─────────────────────────────────────────────────────────────────

export function renderAnywhereDiff(data, paint, columns, now = Date.now()) {
  if (data.kind === 'library') return renderDiff(data, paint, columns, now);
  const answer = new Answer(paint, columns);
  const p = paint;
  if (data.kind === 'compare') {
    answer.head(`${data.before.name} → ${data.after.name}`, { note: data.identical ? 'identical bytes' : `compared on the spot` });
    const room = Math.max(20, answer.columns - 34);
    answer.row(`${p.dim('before')}  ${truncateStart(data.before.shown, room)}  ${p.dim(`${bytes(data.before.size)} · ${shortDate(data.before.modified, now)}`)}`);
    answer.row(`${p.dim('after ')}  ${truncateStart(data.after.shown, room)}  ${p.dim(`${bytes(data.after.size)} · ${shortDate(data.after.modified, now)}`)}`);
    if (data.identical) { answer.row(p.green('✓ the same bytes, so nothing changed')); return answer.done(); }
  } else {
    const range = data.newer ? `${data.commit.short} → ${data.newer.short}` : `${data.commit.short} → now`;
    answer.head(data.shown, { note: `${range} · git` });
    const by = data.newer ?? data.commit;
    answer.row(data.newer ? `${p.lime(by.author)}${withAi(by, p)} ${p.dim(`· ${stamp(by.at, now)}`)}  ${p.italic(truncate(by.subject, 60))}`
      : p.orange(`changed on disk since ${data.commit.short} by ${data.commit.author} · ${stamp(data.commit.at, now)}`));
  }
  if (data.sheet) renderSheetChanges(answer, data.sheet, p);
  else if (data.lines) {
    if (!data.lines.hunks.length) answer.row(p.dim(data.kind === 'compare' ? 'The bytes differ, but the text Lasso reads from them is the same.' : 'No change in the text.'));
    else renderHunks(answer, data.lines, p);
  } else {
    answer.row(p.dim(data.note === 'too large to compare here' ? 'Too large to compare here; the bytes differ.'
      : `The bytes differ; Lasso does not read inside ${path.extname(data.after?.name ?? data.name ?? '') || 'these'} files to say how.`));
  }
  return answer.done();
}

/** A workbook's changed cells as "Sheet!B4  row · column  before → after", then rows added and removed. */
function renderSheetChanges(answer, sheet, p) {
  const { counts } = sheet;
  answer.row(p.dim([counts.cells && `${plural(counts.cells, 'cell')} changed`, counts.recalculated && `${counts.recalculated} recalculated`,
    counts.rowsAdded && `${plural(counts.rowsAdded, 'row')} added`, counts.rowsRemoved && `${plural(counts.rowsRemoved, 'row')} removed`]
    .filter(Boolean).join(' · ') || 'Every cell reads the same; the bytes differ only in formatting or the file\'s other parts.'));
  let shown = 0;
  for (const part of sheet.sheets) {
    for (const hunk of part.hunks) {
      for (const row of hunk.rows) {
        if (row.kind === 'same' || shown >= 80) continue;
        shown += 1;
        // A row is named by its leading words (columns A, B, … while they hold words), a column by its heading.
        const leading = [];
        for (let index = 0; index < hunk.columns.length && hunk.columns[index].index === index && leading.length < 2; index += 1) {
          const value = row.cells[index]?.value ?? '';
          if (!value || !Number.isNaN(Number(value.replace(/[,$%]/g, '')))) break;
          leading.push(value);
        }
        const heading = hunk.heading?.cells ?? hunk.rows.find((other) => other.kind === 'same' && other.number < row.number
          && other.cells.filter((cell) => cell.value && Number.isNaN(Number(cell.value.replace(/[,$%]/g, '')))).length >= 2)?.cells.map((cell) => cell.value);
        if (row.kind === 'added' || row.kind === 'removed') {
          const text = truncate(row.cells.map((cell) => cell.value).filter(Boolean).join(' · '), 80);
          answer.row(row.kind === 'added' ? p.green(`+ row ${row.number}  ${text}`) : p.pink(`− row ${row.number}  ${text}`));
          continue;
        }
        hunk.columns.forEach((column, index) => {
          const cell = row.cells[index];
          if (!cell?.changed) return;
          const address = `${sheet.csv ? '' : `${part.name}!`}${column.letter}${row.number}`;
          const label = [...leading.slice(0, index || leading.length), heading?.[index] ?? ''].filter(Boolean).join(' · ');
          const room = Math.max(16, Math.min(48, answer.columns - 54));
          answer.row(`${p.faint(padEnd(truncate(address, 14), 14))} ${p.dim(padEnd(truncate(label, room), room))}  `
            + `${p.strike(p.pink(truncate(cell.before || '—', 24)))} → ${p.green(truncate(cell.value || '—', 24))}${cell.recalculated ? p.dim('  (formula)') : ''}`);
        });
      }
    }
  }
  if (sheet.truncated || shown >= 80) answer.row(p.dim('… more changes than shown here'));
}

// ── a folder's changes ───────────────────────────────────────────────────

export function renderAnywhereLog(data, paint, columns, now = Date.now()) {
  if (data.kind !== 'folder') return renderLog(data, paint, columns, now);
  const p = paint;
  const lines = [];
  const window = data.days ? `in the last ${data.days} days` : `since ${stamp(data.from, now)}`;
  lines.push(`${p.accent('●')} ${p.bold(`Changes in ${data.folder}`)}  ${p.dim(`${plural(data.total, 'file')} ${window} · read from the files' own dates`)}`);
  if (!data.entries.length) lines.push(`  ${p.faint('⎿')} ${p.dim('No file changed in that window.')}`);
  let day = null;
  for (const entry of data.entries) {
    const heading = dayHeading(entry.at, now);
    if (heading !== day) {
      day = heading;
      lines.push(`  ${p.faint('│')}`);
      lines.push(`  ${p.faint('├─')} ${p.bold(heading)}`);
    }
    const glyph = entry.change === 'added' ? p.green('+') : p.accent('●');
    const folder = entry.path.includes('/') ? p.dim(`${entry.path.slice(0, entry.path.lastIndexOf('/') + 1)}`) : '';
    const name = p.bold(entry.path.slice(entry.path.lastIndexOf('/') + 1));
    const saved = entry.savedBy ? `  ${p.dim('saved by')} ${p.lime(entry.savedBy)}` : '';
    lines.push(truncate(`  ${p.faint('│')}  ${glyph} ${p.dim(padStart(clock(entry.at), 8))}  ${entry.change} ${folder}${name}  ${p.dim(bytes(entry.size))}${saved}`, columns));
  }
  if (data.truncated) lines.push(`  ${p.faint('│')}  ${p.dim(`… and ${count(data.total - data.entries.length)} more`)}`);
  if (data.commits?.length) {
    lines.push(`  ${p.faint('│')}`);
    lines.push(`  ${p.faint('├─')} ${p.bold('Commits')}`);
    for (const commit of data.commits) {
      lines.push(truncate(`  ${p.faint('│')}  ${p.faint(commit.short ?? commit.hash)} ${p.lime(commit.author)}${withAi(commit, p)} ${p.dim(padEnd(ago(commit.at, now), 10))} ${commit.subject}`, columns));
    }
  }
  if (!data.complete) lines.push(`  ${p.dim('Stopped after looking at 60,000 files; name a smaller folder for all of them.')}`);
  return lines;
}

const quote = (text) => (/\s/.test(text) ? `"${text}"` : text);
