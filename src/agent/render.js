// Lasso's answers as compact text, for a model to read. The JSON shape the
// evidence service returns stays the contract (REST answers in it by
// default); this is the same content without the keys, quotes and braces a
// model pays for on every later turn. Literal values stay JSON-quoted, so
// their exact characters survive; file text is fenced exactly as the file
// has it. Nothing is computed here that the service did not return.

const quote = (value) => JSON.stringify(String(value));

/** A fence longer than any run of backticks in the text, so the text cannot close it. */
function fence(text) {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((match) => match[0].length));
  const marks = '`'.repeat(longest + 1);
  return `${marks}\n${text}\n${marks}`;
}

const handle = (value) => (value ? `#${value} ` : '');

function sourceLines(sources = {}) {
  return Object.entries(sources).map(([id, source]) => {
    const notes = [
      source.disk === 'changed' ? 'changed on disk since indexed' : null,
      source.disk === 'missing' ? 'no longer on disk' : null,
      source.disk === 'read' ? 'read from disk now' : null,
      source.historical ? 'earlier revision' : null,
      source.lagging ? 'index behind the files' : null,
    ].filter(Boolean);
    return `${id} = ${source.folder}/${source.path} @${source.rev}${notes.length ? ` (${notes.join(', ')})` : ''}`;
  });
}

const context = (ctx) => (ctx && Object.keys(ctx).length
  ? ` [${Object.entries(ctx).map(([key, value]) => `${key} ${value}`).join('; ')}]` : '');

function candidateLine(candidate) {
  const match = candidate.match ? ` (${candidate.match})` : '';
  if (candidate.type === 'record') {
    const fields = Object.entries(candidate.fields ?? {}).map(([name, field]) => `${name}=${quote(field.value)}${field.trunc ? '…' : ''}`
      + `${field.h ? ` #${field.h}` : ''}${field.at ? ` ${field.at}` : ''}${field.col ? ` (column ${field.col})` : ''}`);
    const missing = candidate.missing?.length ? `; no ${candidate.missing.join(', ')}` : '';
    const more = candidate.more_fields ? `; ${candidate.more_fields} more columns` : '';
    const row = candidate.row != null ? `${quote(candidate.row)} ` : '';
    return `- ${candidate.src} record ${row}${candidate.at}: ${fields.join(', ')}${missing}${more}${context(candidate.ctx)}${match}`;
  }
  const label = candidate.label ? ` ${quote(candidate.label)}` : '';
  const value = candidate.value != null ? `: ${quote(candidate.value)}${candidate.trunc ? ' (cut; read #h for all)' : ''}` : '';
  const lines = candidate.lines_total ? ` ${candidate.lines_total} lines` : '';
  return `- ${handle(candidate.h)}${candidate.src} ${candidate.type}${candidate.at ? ` ${candidate.at}` : ''}${label}${lines}${value}${context(candidate.ctx)}${match}`;
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

function itemLines(item, index) {
  const prefix = `[${index + 1}] `;
  if (item.error) return errorLines(prefix, item.error);
  if (item.folders) {
    return [`${prefix}folders:`, ...item.folders.map((folder) => `  ${folder.name} (${folder.root}; ${folder.unindexed ? 'not indexed'
      : `version ${folder.version}, ${folder.files} files`}${folder.lagging ? `, index behind (current ${folder.current})` : ''}${folder.unavailable ? ', unavailable' : ''})`)];
  }
  const revision = [
    item.historical ? `earlier revision @${item.rev}${item.current ? `, current @${item.current}` : ''}` : null,
    item.disk_rev ? `disk now @${item.disk_rev}${item.unindexed ? ', not indexed' : ''}` : null,
  ].filter(Boolean).join('; ');
  const after = revision ? ` (${revision})` : '';
  if (item.text != null && item.lines) {
    const asked = item.asked ? ` (asked ${item.asked[0]}-${item.asked[1]})` : '';
    const symbol = item.symbol ? ` ${item.symbol}` : '';
    return [`${prefix}${handle(item.h)}${item.src} lines ${item.lines[0]}-${item.lines[1]} of ${item.total}${symbol}${asked}${after}${item.trunc ? ' (block cut)' : ''}`,
      fence(item.text)];
  }
  if (item.outline) {
    return [`${prefix}${handle(item.h)}${item.src} outline, ${item.total} lines${after}: ${item.outline.join('; ')}${item.outline_more ? `; ${item.outline_more} more` : ''}`];
  }
  if (item.versions) {
    return [`${prefix}${handle(item.h)}${item.src} versions, newest first:`,
      ...item.versions.map((version) => `  v${version.v} ${version.at}: ${quote(version.value)}${version.loc ? ` ${version.loc}` : ''}${version.path ? ` (then ${version.path})` : ''}${version.this ? ' <- this handle' : ''}`),
      ...(item.more ? [`  ${item.more} older`] : []), `  ${item.note}`];
  }
  const head = `${prefix}${handle(item.h)}${item.src} ${item.type}${item.at ? ` ${item.at}` : ''}${item.label ? ` ${quote(item.label)}` : ''}`
    + `${item.value != null ? `: ${quote(item.value)}` : ''}${context(item.ctx)}${after}`;
  if (item.table) {
    const cell = (value) => String(value ?? '').replaceAll('|', '\\|');
    return [head, ...(item.table.header ? [`  columns: ${item.table.header.map(cell).join(' | ')}`] : []),
      ...item.table.rows.map(([number, ...cells]) => `${number === item.table.hit ? '> ' : '  '}${number}: ${cells.map(cell).join(' | ')}`)];
  }
  if (item.passages) {
    return [head, ...item.passages.map((passage) => `${passage.hit ? '> ' : '  '}${handle(passage.h)}${passage.at}: ${quote(passage.text)}`)];
  }
  return [head];
}

export function renderInspect(response) {
  return [...sourceLines(response.sources), ...response.items.flatMap(itemLines), ...notes(response.warnings)].join('\n');
}

export function renderBind(response) {
  const lines = [];
  if (response.text != null) lines.push(`text: ${response.text}`);
  lines.push(...response.citations.map((citation) => `[${citation.n}] #${citation.h} ${citation.folder}/${citation.path}${citation.at ? ` ${citation.at}` : ''} @${citation.rev}`));
  lines.push(`fields: ${Object.entries(response.fields).map(([name, field]) => `${name}=${quote(field.value)} [${field.cite}]${field.now === 'same' ? '' : ` now ${field.now}`}`).join(', ')}`);
  return lines.join('\n');
}

const RENDERERS = { suggest: renderSuggest, inspect: renderInspect, bind: renderBind };

/** An operation's answer in the requested format: compact text, or the JSON contract. */
export function formatAnswer(operation, response, format = 'text') {
  return format === 'json' ? JSON.stringify(response) : RENDERERS[operation](response);
}
