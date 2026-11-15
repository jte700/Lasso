// Lasso's answers as compact text, for a model to read. The JSON shape the
// evidence service returns stays the contract (REST answers in it by
// default); this is the same content without the keys, quotes and braces a
// model pays for on every later turn. Literal values stay JSON-quoted, so
// their exact characters survive; file text is fenced exactly as the file
// has it. Nothing is computed here that the service did not return.
//
// An ask's answer has two styles. The default is what REST and scripts get
// when they ask for text. The lean one is what a model reads over MCP
// (mcp.js), where every token of an answer is paid again on each later turn:
// revisions cut to the eight characters an ask can name them by, excerpts as
// the file's words without quotes, excerpts already shown gathered on one
// line, no count of sentences, and handles only when something offered can
// take one. Values and row labels stay quoted in
// both, and both say the same things about what was found and left out.

import { OPERATIONS } from './file-ops.js';

const quote = (value) => JSON.stringify(String(value));

const FULL = { lean: false, handles: true };
// `hinted` holds the tables one answer has already said how to query, so it is said once.
const styleOf = (options = {}) => ({ lean: Boolean(options.lean), handles: options.handles ?? !options.lean, hinted: new Set() });
// Eight characters are the fewest an ask reads as a revision ("@f920bb86").
const revisionShown = (rev, style) => (style.lean ? String(rev).slice(0, 8) : rev);

/** A fence longer than any run of backticks in the text, so the text cannot close it. */
function fence(text) {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((match) => match[0].length));
  const marks = '`'.repeat(longest + 1);
  return `${marks}\n${text}\n${marks}`;
}

const handle = (value, style = FULL) => (value && style.handles ? `#${value} ` : '');

function sourceLines(sources = {}, style = FULL) {
  return Object.entries(sources).map(([id, source]) => {
    const notes = [
      source.disk === 'changed' ? 'changed on disk since indexed' : null,
      source.disk === 'missing' ? 'no longer on disk' : null,
      source.disk === 'read' ? 'read from disk now' : null,
      source.historical ? 'earlier revision' : null,
      source.lagging ? 'index behind the files' : null,
    ].filter(Boolean);
    return `${id} = ${source.folder}/${source.path} @${revisionShown(source.rev, style)}${notes.length ? ` (${notes.join(', ')})` : ''}`;
  });
}

// A title the section already says is not said twice.
const context = (ctx) => {
  const entries = Object.entries(ctx ?? {}).filter(([key, value]) => !(key === 'title' && value === ctx.section));
  return entries.length ? ` [${entries.map(([key, value]) => `${key} ${value}`).join('; ')}]` : '';
};

function candidateLine(candidate, { withMatch = true, style = FULL } = {}) {
  const match = candidate.match && withMatch ? ` (${candidate.match})` : '';
  if (candidate.type === 'record') {
    const fields = Object.entries(candidate.fields ?? {}).map(([name, field]) => `${name}=${quote(field.value)}${field.trunc ? '…' : ''}`
      + `${field.h && (style.handles || field.trunc) ? ` #${field.h}` : ''}${field.at ? ` ${field.at}` : ''}${field.col ? ` (column ${field.col})` : ''}`);
    const missing = candidate.missing?.length ? `; no ${candidate.missing.join(', ')}` : '';
    const more = candidate.more_fields ? `; ${candidate.more_fields} more columns` : '';
    const row = candidate.row != null ? `${quote(candidate.row)} ` : '';
    return `- ${candidate.src} record ${row}${candidate.at}: ${fields.join(', ')}${missing}${more}${context(candidate.ctx)}${match}`;
  }
  const label = candidate.label ? ` ${quote(candidate.label)}` : '';
  const value = candidate.value != null ? `: ${quote(candidate.value)}${candidate.trunc ? ' (cut; read #h for all)' : ''}` : '';
  // A value that was cut keeps its handle in either style: the handle is how the rest of it is read.
  const own = handle(candidate.h, candidate.trunc ? FULL : style);
  const lines = candidate.lines_total ? ` ${candidate.lines_total} lines` : '';
  return `- ${own}${candidate.src} ${candidate.type}${candidate.at ? ` ${candidate.at}` : ''}${label}${lines}${value}${context(candidate.ctx)}${match}`;
}

function coverageLine(result) {
  const coverage = result.coverage;
  const notes = result.notes?.length ? ` (${result.notes.join('; ')})` : '';
  const shown = result.candidates.length;
  const parts = [`${shown} of ${coverage.total}${coverage.capped ? '+' : ''}`, coverage.exact
    ? `${coverage.exact} exact` : 'none matches exactly in any shared folder, only some of its words'];
  if (coverage.more) parts.push(`more: cursor ${quote(coverage.cursor)}`);
  else if (coverage.exhausted) parts.push('nothing else matched');
  if (coverage.budget) parts.push('cut to budget');
  if (coverage.unindexed?.length) parts.push(`not indexed yet: ${coverage.unindexed.join(', ')}`);
  return `${result.id}: ${parts.join('; ')}${notes}`;
}

function errorLines(prefix, error) {
  const lines = [`${prefix}error ${error.code}: ${error.message}`];
  for (const match of error.matches ?? []) {
    lines.push(typeof match === 'string' ? `  - ${match}`
      : `  - ${match.folder}/${match.path}${match.line ? `:${match.line}` : ''}${match.rev ? ` @${match.rev}` : ''}`);
  }
  for (const similar of error.similar ?? []) lines.push(`  ~ ${typeof similar === 'string' ? similar : `${similar.folder}/${similar.path}`}`);
  if (error.total != null) lines.push(`  (${error.total} lines)`);
  if (error.current) lines.push(`  (current revision @${error.current})`);
  if (error.unbound) lines.push(`  unbound: ${error.unbound.join(', ')}`);
  return lines;
}

const notes = (warnings = []) => warnings.map((warning) => `Note: ${warning}`);

export function renderSuggest(response) {
  const lines = sourceLines(response.sources);
  for (const result of response.results) {
    if (result.error) { lines.push(...errorLines(`${result.id}: `, result.error)); continue; }
    lines.push(coverageLine(result), ...result.candidates.map(candidateLine));
  }
  if (response.lagging?.length) lines.push(`Note: the index is behind the files in ${response.lagging.join(', ')}.`);
  return [...lines, ...notes(response.warnings)].join('\n');
}

function itemLines(item, index, style = FULL) {
  const prefix = `[${index + 1}] `;
  if (item.error) return errorLines(prefix, item.error);
  if (item.folders) {
    return [`${prefix}folders:`, ...item.folders.map((folder) => `  ${folder.name} (${folder.root}; ${folder.unindexed ? 'not indexed'
      : `version ${folder.version}, ${folder.files} files`}${folder.lagging ? `, index behind (current ${folder.current})` : ''}${folder.unavailable ? ', unavailable' : ''})`)];
  }
  const revision = [
    item.historical ? `earlier revision @${revisionShown(item.rev, style)}${item.current ? `, current @${revisionShown(item.current, style)}` : ''}` : null,
    item.disk_rev ? `disk now @${revisionShown(item.disk_rev, style)}${item.unindexed ? ', not indexed' : ''}` : null,
  ].filter(Boolean).join('; ');
  const after = revision ? ` (${revision})` : '';
  if (item.text != null && item.lines) {
    const asked = item.asked ? ` (asked ${item.asked[0]}-${item.asked[1]})` : '';
    const symbol = item.symbol ? ` ${item.symbol}${item.only ? ' (defined nowhere else in the shared folders)' : ''}` : '';
    const span = item.lines[0] === item.lines[1] ? `line ${item.lines[0]}` : `lines ${item.lines[0]}-${item.lines[1]}`;
    return [`${prefix}${handle(item.h, style)}${item.src} ${span} of ${item.total}${symbol}${asked}${after}${item.trunc ? ' (block cut)' : ''}`,
      fence(item.text)];
  }
  if (item.outline) {
    return [`${prefix}${handle(item.h, style)}${item.src} outline, ${item.total} lines${after}: ${item.outline.join('; ')}${item.outline_more ? `; ${item.outline_more} more` : ''}`];
  }
  if (item.versions) {
    return [`${prefix}${handle(item.h, style)}${item.src} versions, newest first:`,
      ...item.versions.map((version) => `  v${version.v} ${version.at}: ${quote(version.value)}${version.loc ? ` ${version.loc}` : ''}${version.path ? ` (then ${version.path})` : ''}${version.this ? ' <- this handle' : ''}`),
      ...(item.more ? [`  ${item.more} older`] : []), `  ${item.note}`];
  }
  const head = `${prefix}${handle(item.h, style)}${item.src} ${item.type}${item.at ? ` ${item.at}` : ''}${item.label ? ` ${quote(item.label)}` : ''}`
    + `${item.value != null ? `: ${quote(item.value)}` : ''}${context(item.ctx)}${after}`;
  if (item.table) {
    const cell = (value) => String(value ?? '').replaceAll('|', '\\|');
    return [head, ...(item.table.header ? [`  columns: ${item.table.header.map(cell).join(' | ')}`] : []),
      ...item.table.rows.map(([number, ...cells]) => `${number === item.table.hit ? '> ' : '  '}${number}: ${cells.map(cell).join(' | ')}`)];
  }
  if (item.passages) {
    return [head, ...item.passages.map((passage) => `${passage.hit ? '> ' : '  '}${handle(passage.h, style)}${passage.at}: ${quote(passage.text)}`)];
  }
  return [head];
}

export function renderInspect(response) {
  return [...sourceLines(response.sources), ...response.items.flatMap((item, index) => itemLines(item, index)), ...notes(response.warnings)].join('\n');
}

export function renderBind(response) {
  const lines = [];
  if (response.text != null) lines.push(`text: ${response.text}`);
  lines.push(...response.citations.map((citation) => `[${citation.n}] #${citation.h} ${citation.folder}/${citation.path}${citation.at ? ` ${citation.at}` : ''} @${citation.rev}`));
  lines.push(`fields: ${Object.entries(response.fields).map(([name, field]) => `${name}=${quote(field.value)} [${field.cite}]${field.now === 'same' ? '' : ` now ${field.now}`}`).join(', ')}`);
  return lines.join('\n');
}

function recordLine(item, { handles = true } = {}) {
  const fields = Object.entries(item.fields).map(([name, field]) => {
    const history = field.was ? (field.was.length
      ? ` (v${field.v}; before: ${field.was.map((was) => `${quote(was.value)} v${was.v} ${String(was.at).slice(0, 10)}`).join(', ')})`
      : ' (no earlier value captured)') : '';
    return `${name}=${quote(field.value)}${field.h && handles ? ` #${field.h}` : ''}${history}`;
  });
  return `${item.src} ${quote(item.row)} ${item.at}: ${fields.join(', ')}${item.more_fields ? `; ${item.more_fields} more columns` : ''}`;
}

/** An answer's items under its head; several items are numbered n.1, n.2… */
function answerLines(answer, render) {
  const echo = answer.ask ? ` ${quote(answer.ask)}:` : '';
  if (answer.items.length === 1) return render(answer.items[0], `[${answer.n}]${echo}`);
  return answer.items.flatMap((item, index) => render(item, `[${answer.n}.${index + 1}]${index === 0 ? echo : ''}`));
}

const counted = (number) => Number(number).toLocaleString('en-US');

/** A table as rows: its header, then each row's label and values, separated by " | ". */
function tableLines(item, head) {
  const total = item.rows_total ?? item.rows.length + (item.more_rows ?? 0);
  const shown = total > item.rows.length ? `first ${item.rows.length} of ${total} rows` : `${total} row${total === 1 ? '' : 's'}`;
  return [`${head} ${item.src}${item.sheet ? ` ${item.sheet}` : ''} table, ${shown}:`, `  ${item.header.join(' | ')}`,
    ...item.rows.map((row) => `  ${row.join(' | ')}`)];
}

/**
 * How the tables behind an answer are asked about whole: by a query, under these names, with the rows each has and
 * its columns, so the query can be written right the first time. Said lean only, and once for a set of tables in
 * one response.
 */
function queryHintLines(answer, style) {
  if (!style.lean || !answer.query_tables?.length) return [];
  const key = answer.query_tables.map((table) => table.name).join('\u0000');
  if (style.hinted.has(key)) return [];
  style.hinted.add(key);
  const [first, ...others] = answer.query_tables;
  const name = /^[\p{L}_][\p{L}\p{N}_]*$/u.test(first.name) ? first.name : JSON.stringify(first.name);
  const columns = (table) => (table.columns?.length ? `: ${table.columns.join(', ')}` : '');
  return [`  (a query reads every row: ask "SELECT … FROM ${name}", with WHERE, GROUP BY or JOIN; ${first.name} has ${counted(first.rows)} rows${columns(first)}${
    others.map((table) => `; ${table.name} ${counted(table.rows)}${columns(table)}`).join('')})`];
}

/** The whole-file operations of the files behind an answer, said lean only and once for a file in one response. */
function operationHintLines(answer, style) {
  if (!style.lean) return [];
  return (answer.operations ?? []).filter((offered) => !style.hinted.has(`op:${offered.file}`)).map((offered) => {
    style.hinted.add(`op:${offered.file}`);
    // Written the way a model asks, as a string after the file's name: of 72 asks in a live run one was an object.
    return `  (the whole ${offered.kind}, exactly: ask "${offered.file}: op; op" with op: ${OPERATIONS[offered.kind]})`;
  });
}

/**
 * A query's result: the tables it read and how many rows of each, then its rows under their column names. A result
 * cut short says so, and a query Lasso wrote from plain words is shown, so it can be checked and asked again otherwise.
 */
function queryLines(item, head) {
  const sources = [];
  for (const table of item.tables) {
    const last = sources.at(-1);
    if (last?.src === table.src) last.names.push(table.name); else sources.push({ src: table.src, names: [table.name] });
  }
  const over = item.tables.length === 1 ? (item.tables[0].rows === 1 ? 'over its 1 row' : `over all ${counted(item.tables[0].rows)} rows`)
    : `over ${item.tables.map((table, at) => `all ${counted(table.rows)}${at === 0 ? ' rows' : ''} of ${table.name}`).join(' and ')}`;
  const rows = !item.total ? 'no rows' : item.more_rows ? `first ${counted(item.rows.length)} of ${counted(item.total)} rows`
    : `${counted(item.total)} row${item.total === 1 ? '' : 's'}`;
  const after = `${item.before_limit ? ` (LIMIT; ${counted(item.before_limit)} without it)` : ''}${item.more_rows ? '; LIMIT and OFFSET give the rest' : ''}`;
  const cell = (value) => (value == null ? '' : String(value).replace(/\s+/g, ' ').replaceAll('|', '\\|'));
  return [`${head} ${sources.map((source) => `${source.src} ${source.names.join(', ')}`).join(', ')}: ${rows}, ${over}${after}`,
    ...(item.ran ? [`  ran: ${item.ran}`] : []), ...(item.note ? [`  note: ${item.note}`] : []),
    ...(item.total ? [`  ${item.columns.map(cell).join(' | ')}`, ...item.rows.map((row) => `  ${row.map(cell).join(' | ')}`)] : [])];
}

/** A model: its own summary (parts and instances), then each part's or room's measurements, then where its instances sit. */
function modelLines(item, head) {
  return [`${head} ${item.src} model${item.summary ? `: ${item.summary[0]}` : ':'}`, ...(item.summary ?? []).slice(1).map((line) => `  ${line}`),
    ...item.elements.map((element) => `  ${element.name}: ${element.properties.map(([name, value]) => `${name} ${value}`).join('; ')}${
      element.more ? `; +${element.more} more` : ''}`),
    ...(item.more_elements ? [`  (+${item.more_elements} more parts or rooms; ask about one by name)`] : []),
    ...(item.other_elements ? [`  also: ${Object.entries(item.other_elements).map(([kind, count]) => `${count} ${kind}`).join(', ')} (ask about one by name)`] : []),
    ...(item.instances ? [`  instances: ${item.instances.map((instance) => `${instance.label}${instance.at ? ` at ${vector(instance.at)}${turned(instance.turn)}` : ' (placement not settled)'}`).join('; ')}${
      item.more_instances ? `; +${item.more_instances} more` : ''}`] : [])];
}

const vector = (values) => `[${values.join(', ')}]`;
const turned = (turn) => (turn ? `, turned ${turn.degrees}° about ${Array.isArray(turn.about) ? vector(turn.about) : turn.about}` : '');

/** One instance's placement in its assembly, or how one instance stands to another. */
function geometryLines(item, head) {
  if (item.type === 'placement') {
    return [`${head} ${item.src} ${quote(item.instance)} (${item.part}) at ${vector(item.at)} ${item.unit} in the assembly frame${turned(item.turn)}`];
  }
  const angles = `axes x ${item.angles.x}°, y ${item.angles.y}°, z ${item.angles.z}° apart`;
  if (item.only === 'angles') return [`${head} ${item.src} ${quote(item.b)} and ${quote(item.a)}: ${angles}`];
  return [`${head} ${item.src} ${quote(item.b)} from ${quote(item.a)}: ${item.distance} ${item.unit} apart; in ${quote(item.a)}'s frame at ${vector(item.offset)}${turned(item.turn)}; ${angles}${
    item.a_at && item.b_at ? ` (assembly frame: ${quote(item.a)} at ${vector(item.a_at)}, ${quote(item.b)} at ${vector(item.b_at)})` : ''}`];
}

/** A document's passages in reading order. */
function textLines(item, head) {
  return [`${head} ${item.src} text:`, ...item.passages.map((passage) => `  ${passage.at ? `${passage.at} ` : ''}${passage.text}`),
    ...(item.more ? [`  (+${item.more} more passages; ask about a topic in it)`] : [])];
}

/**
 * Excerpts of one file: each with its page or paragraph, its section where it changes, its text (or a table's rows)
 * and a handle. Lean, an excerpt is the file's words on one line, and excerpts an earlier answer already showed are
 * gathered on one line that names their places.
 */
function excerptLines(item, head, style = FULL) {
  const lines = [`${head} ${item.src}:`];
  let section = null;
  let repeats = null;
  for (const excerpt of item.excerpts) {
    if (excerpt.same && style.lean) {
      if (repeats?.same !== excerpt.same) { repeats = { same: excerpt.same, places: [] }; lines.push(repeats); }
      repeats.places.push(excerpt.at ?? 'an excerpt');
      continue;
    }
    repeats = null;
    const where = [excerpt.at, excerpt.section && excerpt.section !== section ? `§${excerpt.section}` : null].filter(Boolean).join(' ');
    if (excerpt.section) section = excerpt.section;
    if (excerpt.same) { lines.push(`  ${where}: (shown in [${excerpt.same}])`); continue; }
    const handle = excerpt.h && style.handles ? ` #${excerpt.h}` : '';
    if (excerpt.rows) {
      lines.push(`  ${where}: ${excerpt.caption ?? 'table'}${excerpt.header ? ` [${excerpt.header}]` : ''}${handle}`, ...excerpt.rows.map((row) => `    ${row}`));
    } else lines.push(`  ${where}: ${style.lean ? String(excerpt.text).replace(/\s+/g, ' ').trim() : quote(excerpt.text)}${handle}`);
  }
  return lines.map((line) => (typeof line === 'string' ? line : `  shown in [${line.same}]: ${line.places.join(', ')}`));
}

/**
 * A ranked answer's first line: what was shown of what matched, what was
 * left out and where, and what no file has. Ranked answers are a selection,
 * never all there is: the line says so in its first word.
 */
function rankedLine(answer, head, style = FULL) {
  const counts = answer.counts ?? {};
  const shown = counts.sentences != null && !style.lean ? `${counts.sentences} sentence${counts.sentences === 1 ? '' : 's'}, ` : '';
  const parts = [`ranked: ${shown}${counts.files}/${counts.matching_files} matching files`];
  if (answer.absent?.length) parts.push(`no indexed text in ${answer.file ?? `the ${answer.files} shared files`} has ${answer.absent.map(quote).join(' or ')}`);
  if (answer.like) {
    parts.push(answer.like.rows ? `no row is labelled ${quote(answer.like.label)}; rows labelled like it: ${answer.like.rows.map(quote).join(', ')} (${answer.like.src.join(', ')})`
      : `no row is labelled ${quote(answer.like.label)}; ${answer.like.count} rows are labelled like it`);
  }
  if (answer.unmatched?.length) parts.push(`no excerpt has ${answer.unmatched.map(quote).join(', ')}`);
  if (counts.left_out) {
    const where = answer.left_out_in?.length ? ` (${answer.left_out_in.map(([section, count]) => `${section} ${count}`).join(', ')})` : '';
    // How to get what was left out is said in both styles. The lean text dropped it at first; a live run with it
    // back read files as often, so it is kept for what it says, not for a measured effect (12 November 2026).
    parts.push(`${counts.left_out} more matched${where}; a larger "budget" shows more`);
  }
  if (answer.not_searched?.length) parts.push(`not searchable: ${answer.not_searched.map((file) => `${file.path} (${file.reason})`).join(', ')}`);
  return `${head} ${parts.join('; ')}`;
}

/** An operation over a table column: its result, the rows it covers, and the values when few. */
function computedLines(item, head) {
  const name = { sum: 'total', mean: 'mean', max: 'highest', min: 'lowest', count: 'rows' }[item.op] ?? item.op;
  const covered = `${item.rows} of ${item.of} rows${item.period ? ` (${item.period})` : ''}${item.skipped ? `; ${item.skipped} not numbers` : ''}`;
  const values = item.values ? ` [${item.values.map(([label, value]) => `${label} ${value ?? '-'}`).join('; ')}]` : '';
  const where = item.where ? ` where ${Object.entries(item.where).map(([column, value]) => `${column} is ${quote(value)}`).join(' and ')}` : '';
  return [`${head} ${item.src}${item.sheet ? ` ${item.sheet}` : ''} ${quote(item.column)} ${name}${where}: ${item.value}${item.row ? ` (${item.row})` : ''}, over ${covered}${values}`];
}

function evidenceLines(item, head, style = FULL) {
  if (item.type === 'relation' || item.type === 'placement') return geometryLines(item, head);
  if (item.type === 'computed') return computedLines(item, head);
  if (item.type === 'excerpts') return excerptLines(item, head, style);
  if (item.type === 'query') return queryLines(item, head);
  if (item.type === 'cells') {
    // A cell with its column's name and its row's label where it has them, its value, and its formula when it is one.
    const said = (cell) => `${cell.at}${cell.column != null ? ` ${quote(cell.column)} of ${quote(cell.row)}` : ''}: ${quote(cell.value)}${
      cell.formula ? ` ${cell.formula}${cell.stored != null ? ` (the file stores ${quote(cell.stored)})` : ''}` : ''}`;
    return item.cells.length === 1 ? [`${head} ${item.src} ${item.sheet}!${said(item.cells[0])}`] : [`${head} ${item.src} ${item.sheet}, ${item.cells.length} cells:`,
      ...item.cells.map((cell) => `  ${said(cell)}`)];
  }
  if (item.type === 'operation') {
    // An operation over a whole file: what it is, how sure, what it covered, then its result as the operation wrote it.
    const sure = item.certainty ? `${item.certainty}${item.guarantee ? ` (${item.guarantee})` : ''}` : 'exact';
    return [`${head} ${item.src} ${item.op}${item.rev ? ` on ${item.rev}` : ''}: ${sure}${item.over ? `, over ${item.over}` : ''}`,
      ...String(item.text).split('\n').map((line) => `  ${line}`)];
  }
  if (item.type === 'table' && item.rows) return tableLines(item, head);
  if (item.type === 'model' && item.elements) return modelLines(item, head);
  if (item.type === 'text' && item.passages) return textLines(item, head);
  if (item.error) return errorLines(`${head} ${item.symbol ? `${item.symbol}: ` : ''}`, item.error);
  if (item.text != null && item.lines) return itemLines(item, 0, style).map((line, index) => (index === 0 ? line.replace(/^\[1\]/, head) : line));
  if (item.outline || item.versions || item.table || item.passages || item.folders) {
    return itemLines(item, 0, style).map((line, index) => (index === 0 ? line.replace(/^\[1\]/, head) : line));
  }
  return [`${head} ${candidateLine(item, { withMatch: false, style }).replace(/^- /, '')}`];
}

/** One label's rows: a single row, the best-matching with the other sources, or sources that agree or differ. */
function recordGroupLines(answer, head, style = FULL) {
  const shown = { handles: style.handles };
  if (!answer.verdict) return [`${head} ${recordLine(answer.items[0], shown)}`];
  if (answer.verdict === 'best') {
    return [`${head} ${recordLine(answer.items[0], shown)} (matches ${answer.matched.map(quote).join(', ')})`,
      ...answer.items.slice(1).map((item) => `  other source: ${recordLine(item, { handles: false })}`)];
  }
  if (answer.verdict === 'agree') {
    return [`${head} ${recordLine(answer.items[0], shown)} (same in ${answer.items.length} sources: ${answer.items.map((item) => item.src).join(', ')})`];
  }
  return [`${head} ${answer.items.length} sources differ; which is meant is not settled by the files:`, ...answer.items.map((item) => `  - ${recordLine(item, shown)}`)];
}

export function renderAsk(response, options = {}) {
  const style = styleOf(options);
  const evidence = (item, head) => evidenceLines(item, head, style);
  const lines = sourceLines(response.sources, style);
  for (const answer of response.answers) {
    const head = `[${answer.n}]${answer.ask ? ` ${quote(answer.ask)}:` : ''}`;
    const begun = lines.length;
    // The branch that writes this answer leaves the block; what follows it is said after any of them.
    written: {
      if (answer.kind === 'error') { lines.push(...errorLines(`${head} `, answer.error)); break written; }
      if (answer.kind === 'record') { lines.push(...recordGroupLines(answer, head, style)); break written; }
      if (answer.kind === 'records') {
        answer.groups.forEach((group, index) => lines.push(...recordGroupLines(group, `[${answer.n}.${index + 1}]${index === 0 && answer.ask ? ` ${quote(answer.ask)}:` : ''}`, style)));
        break written;
      }
      if (answer.kind === 'none' && answer.named) {
        lines.push(`${head} none of the ${answer.files} shared files is named ${answer.looked_for.map(quote).join(' or ')}.`);
        break written;
      }
      if (answer.kind === 'none') {
        const where = answer.file ? answer.file : `the ${answer.files} shared files`;
        const said = answer.missing?.length
          ? `no indexed text in ${where} has ${answer.missing.map(quote).join(' or ')} (asked: ${quote(answer.looked_for.join(' '))})`
          : `no indexed text in ${where} has ${answer.looked_for.map(quote).join(', ')} together`;
        // "no row is labelled …" goes without saying when no file has the word that sets the label apart.
        const unlabelled = answer.like && !answer.missing?.includes(answer.like.word) ? `; no row is labelled ${quote(answer.like.label)}` : '';
        const like = answer.like?.rows ? `${unlabelled}; rows labelled like it: ${answer.like.rows.map(quote).join(', ')} (${answer.like.src.join(', ')})`
          : answer.like ? `${unlabelled}; ${answer.like.count} rows are labelled like it` : '';
        lines.push(`${head} ${said}${like}${answer.items.length ? '; closest:' : '.'}`,
          ...answer.items.map((item) => `  ${candidateLine(item, { withMatch: false, style })}`),
          ...(answer.sections ? [`  its sections: ${answer.sections.join('; ')}${answer.more_sections ? `; +${answer.more_sections} more` : ''}`] : []));
        break written;
      }
      // A named file without some of the ask's words: that first, then what the file holds.
      if (answer.kind === 'digest' && answer.absent?.length) {
        lines.push(`${head} no indexed text in ${answer.file ?? 'the file'} has ${answer.absent.map(quote).join(' or ')}; what it holds:`);
        answer.items.forEach((item, index) => lines.push(...evidence(item, `[${answer.n}.${index + 1}]`)));
        break written;
      }
      if (answer.kind === 'matches') {
        lines.push(`${head} ${coverageLine({ ...answer, id: 'matches' }).replace(/^matches: /, '')}`, ...answer.candidates.map((candidate) => candidateLine(candidate, { style })));
        break written;
      }
      if (['found', 'computed'].includes(answer.kind) && answer.status === 'ranked') {
        lines.push(rankedLine(answer, head, style));
        answer.items.forEach((item, index) => lines.push(...evidence(item, `[${answer.n}.${index + 1}]`)));
        break written;
      }
      const more = answer.more ? [`  (${answer.more} other, less focused hits have these words too)`] : [];
      // Found for the rest of the ask, the words no file has being said first.
      if (answer.kind === 'found' && answer.missing?.length) {
        const where = answer.file ?? `the ${answer.files} shared files`;
        const absent = answer.absent ?? [];
        const apart = answer.missing.filter((word) => !absent.includes(word));
        lines.push(`${head} ${[absent.length ? `no indexed text in ${where} has ${absent.map(quote).join(' or ')}` : '',
          apart.length ? `nothing in ${where} has ${apart.map(quote).join(', ')} with the rest` : ''].filter(Boolean).join('; ')}; found for the rest:`);
        answer.items.forEach((item, index) => lines.push(...evidence(item, `[${answer.n}.${index + 1}]`)));
        lines.push(...more);
        break written;
      }
      lines.push(...answerLines(answer, evidence), ...more);
    }
    // Said right under an answer's first line when that line is its own ("[1] ranked: …"), ahead of the rows; else after it.
    const hint = [...queryHintLines(answer, style), ...operationHintLines(answer, style)];
    const first = lines[begun] ?? '';
    if (hint.length && lines.length > begun + 1 && answer.kind !== 'operation' && first.startsWith(`[${answer.n}] `) && !/[:,]$/.test(first)) lines.splice(begun + 1, 0, ...hint);
    else lines.push(...hint);
  }
  return [...lines, ...notes(response.warnings)].join('\n');
}

const RENDERERS = { suggest: renderSuggest, inspect: renderInspect, bind: renderBind, ask: renderAsk };

/**
 * An operation's answer in the requested format: compact text, or the JSON contract.
 * `options` are for an ask's text: `lean` writes it as a model reads it over MCP, `handles` says whether handles are sent.
 */
export function formatAnswer(operation, response, format = 'text', options = {}) {
  return format === 'json' ? JSON.stringify(response) : RENDERERS[operation](response, options);
}
