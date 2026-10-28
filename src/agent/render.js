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

// A title the section already says is not said twice.
const context = (ctx) => {
  const entries = Object.entries(ctx ?? {}).filter(([key, value]) => !(key === 'title' && value === ctx.section));
  return entries.length ? ` [${entries.map(([key, value]) => `${key} ${value}`).join('; ')}]` : '';
};

function candidateLine(candidate, { withMatch = true } = {}) {
  const match = candidate.match && withMatch ? ` (${candidate.match})` : '';
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
    const symbol = item.symbol ? ` ${item.symbol}${item.only ? ' (defined nowhere else in the shared folders)' : ''}` : '';
    const span = item.lines[0] === item.lines[1] ? `line ${item.lines[0]}` : `lines ${item.lines[0]}-${item.lines[1]}`;
    return [`${prefix}${handle(item.h)}${item.src} ${span} of ${item.total}${symbol}${asked}${after}${item.trunc ? ' (block cut)' : ''}`,
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

function evidenceLines(item, head) {
  if (item.error) return errorLines(`${head} ${item.symbol ? `${item.symbol}: ` : ''}`, item.error);
  if (item.text != null && item.lines) return itemLines(item, 0).map((line, index) => (index === 0 ? line.replace(/^\[1\]/, head) : line));
  if (item.outline || item.versions || item.table || item.passages || item.folders) {
    return itemLines(item, 0).map((line, index) => (index === 0 ? line.replace(/^\[1\]/, head) : line));
  }
  return [`${head} ${candidateLine(item, { withMatch: false }).replace(/^- /, '')}`];
}

export function renderAsk(response) {
  const lines = sourceLines(response.sources);
  for (const answer of response.answers) {
    const head = `[${answer.n}]${answer.ask ? ` ${quote(answer.ask)}:` : ''}`;
    if (answer.kind === 'error') { lines.push(...errorLines(`${head} `, answer.error)); continue; }
    if (answer.kind === 'record') {
      if (!answer.verdict) { lines.push(`${head} ${recordLine(answer.items[0])}`); continue; }
      if (answer.verdict === 'best') {
        lines.push(`${head} ${recordLine(answer.items[0])} (matches ${answer.matched.map(quote).join(', ')})`,
          ...answer.items.slice(1).map((item) => `  other source: ${recordLine(item, { handles: false })}`));
      } else if (answer.verdict === 'agree') {
        lines.push(`${head} ${recordLine(answer.items[0])} (same in ${answer.items.length} sources: ${answer.items.map((item) => item.src).join(', ')})`);
      } else {
        lines.push(`${head} ${answer.items.length} sources differ; which is meant is not settled by the files:`,
          ...answer.items.map((item) => `  - ${recordLine(item)}`));
      }
      continue;
    }
    if (answer.kind === 'none' && answer.named) {
      lines.push(`${head} none of the ${answer.files} shared files is named ${answer.looked_for.map(quote).join(' or ')}.`);
      continue;
    }
    if (answer.kind === 'none') {
      const where = answer.file ? answer.file : `the ${answer.files} shared files`;
      const said = answer.missing?.length
        ? `no indexed text in ${where} has ${answer.missing.map(quote).join(' or ')} (asked: ${quote(answer.looked_for.join(' '))})`
        : `nothing in ${where} has ${answer.looked_for.map(quote).join(', ')} together`;
      // "no row is labelled …" goes without saying when no file has the word that sets the label apart.
      const unlabelled = answer.like && !answer.missing?.includes(answer.like.word) ? `; no row is labelled ${quote(answer.like.label)}` : '';
      const like = answer.like?.rows ? `${unlabelled}; rows labelled like it: ${answer.like.rows.map(quote).join(', ')} (${answer.like.src.join(', ')})`
        : answer.like ? `${unlabelled}; ${answer.like.count} rows are labelled like it` : '';
      lines.push(`${head} ${said}${like}${answer.items.length ? '; closest:' : '.'}`,
        ...answer.items.map((item) => `  ${candidateLine(item, { withMatch: false })}`));
      continue;
    }
    if (answer.kind === 'matches') { lines.push(`${head} ${coverageLine({ ...answer, id: 'matches' }).replace(/^matches: /, '')}`, ...answer.candidates.map(candidateLine)); continue; }
    const more = answer.more ? [`  (${answer.more} other, less focused hits have these words too)`] : [];
    lines.push(...answerLines(answer, evidenceLines), ...more);
  }
  return [...lines, ...notes(response.warnings)].join('\n');
}

const RENDERERS = { suggest: renderSuggest, inspect: renderInspect, bind: renderBind, ask: renderAsk };

/** An operation's answer in the requested format: compact text, or the JSON contract. */
export function formatAnswer(operation, response, format = 'text') {
  return format === 'json' ? JSON.stringify(response) : RENDERERS[operation](response);
}
