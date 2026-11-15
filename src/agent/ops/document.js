// The document adapter (paper §6.1). It rebuilds a PDF's structure from its
// layout: numbered sections and appendices, paragraphs, sentences, tables and
// their footnotes, explicit cross-references, defined terms with their scope,
// and amending language. Relations read off the format (numbered references,
// definitions introduced by quotation marks, table membership) are labelled
// "format"; pattern matches that need a reader's judgement are "lexical".
// Term uses and references form a graph partitioned by chapter behind the
// exact boundary-reachability interface.

import { BoundaryReachability } from './reachability.js';
import { form, head, OpError, plural, result } from './common.js';
import { extractLines } from './pdf-lines.js';

const CHAPTER_RE = /^(\d{1,2})\.\s+(\S.*)$/;
const APPENDIX_RE = /^(Appendix|Schedule|Annex|Exhibit)\s+([A-Z]|\d{1,2})\b\s*[–—:.-]?\s*(.*)$/;
const SECTION_RE = /^((?:\d{1,2}|[A-Z])(?:\.\d{1,3})+)\.?\s+(\S.*)$/;
const TABLE_RE = /^Table\s+(\d+)\b\s*[–—:.-]?\s*(.*)$/;
const FOOTNOTE_RE = /^[†‡*¹²³⁴⁵⁶]/;
const NUMBER = String.raw`(?:[A-Z]\.)?\d{1,2}(?:\.\d{1,3})*(?:\s*\([a-z0-9]{1,4}\))*`;
const SECTION_REF_RE = new RegExp(String.raw`\b(Sections?|Clauses?|§§?)\s+(${NUMBER}(?:(?:\s*,\s*|\s+and\s+|\s+or\s+|\s*(?:to|through|–|-)\s*)${NUMBER})*)`, 'g');
const APPENDIX_REF_RE = /\b(?:Appendix|Schedule|Annex|Exhibit)\s+([A-Z])\b/g;
const TABLE_REF_RE = /\bTable\s+(\d+)\b/g;
const AMEND_RE = /\b(?:is|are)\s+(?:hereby\s+)?(deleted and replaced|deleted|replaced|amended|superseded)\b/i;
const ABBREVIATION_RE = /\b(?:Ltd|Inc|Co|Corp|No|Nos|e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|St|Art|Sec|cf|approx)\.$/i;
const STOP = new Set('a an and any are as at be by each for from has have if in into is it its may no not of on or other shall such that the their then there these this those to under until upon was were which while who will with within without party parties agreement section sections'.split(' '));

export function splitSentences(text) {
  const parts = [];
  let start = 0;
  const pattern = /[.!?][”"’)]*\s+(?=[“"(A-Z0-9])/g;
  for (const match of text.matchAll(pattern)) {
    const end = match.index + match[0].trimEnd().length;
    const candidate = text.slice(start, end);
    if (ABBREVIATION_RE.test(candidate)) continue;
    parts.push(candidate.trim());
    start = match.index + match[0].length;
  }
  if (start < text.length) parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

const IRREGULAR = { paid: 'pay', payable: 'pay', payment: 'pay', payments: 'pay', paying: 'pay', pays: 'pay', due: 'due' };
export function stem(original) {
  const lower = original.toLowerCase();
  if (IRREGULAR[lower]) return IRREGULAR[lower];
  // A light suffix stripper: plurals first (so "temperatures" and "temperature" meet), then common endings.
  let word = lower;
  if (/(?:sses|[sxz]es|[cs]hes)$/.test(word) && word.length > 4) word = word.slice(0, -2);
  else if (/ies$/.test(word) && word.length > 4) word = `${word.slice(0, -3)}y`;
  else if (/[^su]s$/.test(word) && word.length > 3) word = word.slice(0, -1);
  for (const [suffix, replacement] of [['ments', ''], ['ment', ''], ['ings', ''], ['ing', ''], ['ations', 'ate'], ['ation', 'ate'], ['ed', '']]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length) + replacement;
  }
  return word;
}
const words = (text) => String(text).match(/[\p{L}\p{N}]+(?:[’'][\p{L}]+)?/gu) ?? [];

/** Sorts ids the way a reader expects: 1.2 < 1.10 < 2 < A.1. */
export function compareIds(a, b) {
  const key = (id) => String(id).split('.').map((part) => (/^\d+$/.test(part) ? part.padStart(3, '0') : `~${part}`)).join('.');
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
}

// ── structure from layout ───────────────────────────────────────────────────

function buildModel(lines) {
  const sizes = new Map();
  const fonts = new Map();
  for (const line of lines) {
    sizes.set(line.size, (sizes.get(line.size) ?? 0) + line.text.length);
    fonts.set(line.font, (fonts.get(line.font) ?? 0) + line.text.length);
  }
  const bodySize = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
  const bodyFont = [...fonts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const gaps = new Map();
  for (let index = 1; index < lines.length; index += 1) {
    const gap = Math.round(lines[index - 1].y - lines[index].y);
    if (lines[index].page === lines[index - 1].page && gap > 0 && lines[index].size === bodySize) gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
  }
  const spacing = [...gaps].sort((a, b) => b[1] - a[1])[0]?.[0] ?? bodySize * 1.3;

  const sections = new Map();
  const order = [];
  const tables = [];
  let title = null;
  const preamble = { id: '0', title: 'Preamble', kind: 'preamble', chapter: '0', page: 1, paragraphs: [], parent: null };
  sections.set('0', preamble);
  order.push('0');
  let chapter = preamble;
  let section = preamble;
  let paragraph = null;
  let table = null;
  let previous = null;

  const closeParagraph = () => { paragraph = null; };
  const addSection = (record) => {
    sections.set(record.id, record);
    order.push(record.id);
    return record;
  };
  for (const line of lines) {
    const emphasized = line.size >= bodySize + 0.3 || (line.font !== bodyFont && line.size >= bodySize);
    if (!title && line.size >= bodySize + 4) { title = line.text; previous = line; continue; }
    let match;
    if (emphasized && (match = APPENDIX_RE.exec(line.text))) {
      closeParagraph(); table = null;
      chapter = section = addSection({ id: match[2], title: match[3] || `${match[1]} ${match[2]}`, kind: 'appendix', label: `${match[1]} ${match[2]}`, chapter: match[2], page: line.page, paragraphs: [], parent: null });
    } else if (emphasized && (match = CHAPTER_RE.exec(line.text))) {
      closeParagraph(); table = null;
      chapter = section = addSection({ id: match[1], title: match[2], kind: 'chapter', chapter: match[1], page: line.page, paragraphs: [], parent: null });
    } else if (emphasized && (match = SECTION_RE.exec(line.text))) {
      closeParagraph(); table = null;
      const id = match[1];
      section = addSection({ id, title: match[2], kind: 'section', chapter: id.split('.')[0], page: line.page, paragraphs: [], parent: chapter.id });
    } else if ((match = TABLE_RE.exec(line.text)) && (emphasized || /^Table\s+\d+\s*[–—:.-]/.test(line.text))) {
      closeParagraph();
      table = { id: `Table ${match[1]}`, caption: line.text, section: section.id, page: line.page, header: null, rows: [], footnotes: [] };
      tables.push(table);
      section.paragraphs.push({ table: table.id, page: line.page });
    } else if (table && line.cells.length >= 2) {
      if (!table.header) table.header = line.cells.map((cell) => cell.text);
      else table.rows.push(line.cells.map((cell) => cell.text));
    } else if (FOOTNOTE_RE.test(line.text) || line.size <= bodySize - 1.5) {
      closeParagraph();
      const footnote = { text: line.text, page: line.page };
      const target = table ?? tables.at(-1);
      if (target && target.section === section.id && FOOTNOTE_RE.test(line.text) && !(previous && previous.size <= bodySize - 1.5 && !FOOTNOTE_RE.test(previous.text) && target.footnotes.length)) {
        target.footnotes.push(footnote);
      } else if (target && target.footnotes.length && previous && previous.size <= bodySize - 1.5) {
        target.footnotes.at(-1).text += ` ${line.text}`;
      } else section.paragraphs.push({ text: line.text, page: line.page, footnote: true });
      table = target && target.footnotes.length ? target : table;
    } else {
      table = null;
      const gap = previous && previous.page === line.page ? previous.y - line.y : null;
      const continues = paragraph && ((gap !== null && gap <= spacing * 1.3) || (gap === null && !/[.:”"]$/.test(paragraph.text)));
      if (continues) paragraph.text += (paragraph.text.endsWith('-') ? '' : ' ') + line.text;
      else {
        paragraph = { text: line.text, page: line.page };
        section.paragraphs.push(paragraph);
      }
    }
    previous = line;
  }
  for (const record of tables) {
    // A marker in a cell (Sensors†) points at the footnote that starts with it.
    record.marked = [];
    for (const row of record.rows) {
      for (const cell of row) {
        const marker = /([†‡*¹²³⁴⁵⁶])$/.exec(cell)?.[1];
        if (marker) record.marked.push({ cell, row: row[0], footnote: record.footnotes.find((note) => note.text.startsWith(marker))?.text ?? null });
      }
    }
  }
  const sentences = [];
  for (const id of order) {
    const record = sections.get(id);
    record.sentences = [];
    for (const paragraph of record.paragraphs) {
      if (paragraph.table) continue;
      for (const text of splitSentences(paragraph.text)) {
        const sentence = { id: sentences.length, section: id, page: paragraph.page, text, footnote: Boolean(paragraph.footnote) };
        sentences.push(sentence);
        record.sentences.push(sentence);
      }
    }
  }
  for (const record of tables) {
    for (const note of record.footnotes) {
      const sentence = { id: sentences.length, section: record.section, page: note.page, text: note.text, footnote: true, table: record.id };
      sentences.push(sentence);
      sections.get(record.section).sentences.push(sentence);
    }
  }
  return { title, sections, order, tables, sentences, bodySize };
}

// ── relations ───────────────────────────────────────────────────────────────

function expandList(text) {
  const targets = [];
  const items = text.split(/\s*,\s*|\s+and\s+|\s+or\s+/);
  for (const item of items) {
    const range = /^(.+?)\s*(?:to|through|–|-)\s*(.+)$/.exec(item);
    if (range) targets.push({ id: clean(range[1]), rangeTo: clean(range[2]) });
    else if (item.trim()) targets.push({ id: clean(item) });
  }
  return targets;
}
const clean = (id) => id.replace(/\s*\([a-z0-9]{1,4}\)/g, '').trim();

function extractReferences(model) {
  const references = [];
  for (const sentence of model.sentences) {
    for (const match of sentence.text.matchAll(SECTION_REF_RE)) {
      for (const target of expandList(match[2])) {
        if (target.rangeTo) {
          const [prefixA, lastA] = [target.id.split('.').slice(0, -1).join('.'), Number(target.id.split('.').at(-1))];
          const [prefixB, lastB] = [target.rangeTo.split('.').slice(0, -1).join('.'), Number(target.rangeTo.split('.').at(-1))];
          if (prefixA === prefixB && Number.isFinite(lastA) && Number.isFinite(lastB) && lastB >= lastA && lastB - lastA < 50) {
            for (let value = lastA; value <= lastB; value += 1) references.push({ from: sentence.section, sentence: sentence.id, target: prefixA ? `${prefixA}.${value}` : String(value), text: match[0], kind: 'section' });
            continue;
          }
        }
        references.push({ from: sentence.section, sentence: sentence.id, target: target.id, text: match[0], kind: 'section' });
      }
    }
    for (const match of sentence.text.matchAll(APPENDIX_REF_RE)) references.push({ from: sentence.section, sentence: sentence.id, target: match[1], text: match[0], kind: 'appendix' });
    for (const match of sentence.text.matchAll(TABLE_REF_RE)) references.push({ from: sentence.section, sentence: sentence.id, target: `Table ${match[1]}`, text: match[0], kind: 'table' });
  }
  return references;
}

function extractTerms(model) {
  const definitions = [];
  for (const sentence of model.sentences) {
    const scoped = /^In (?:this|these)\s+(Appendix|Schedule|Annex|Exhibit|Section|Article|Part)\s+([A-Z0-9.]+),/.exec(sentence.text);
    if (scoped) {
      for (const match of sentence.text.matchAll(/[“"]([^”"]{1,60})[”"]\s+(?:means|shall mean|includes)\b/g)) {
        definitions.push({ term: match[1], section: sentence.section, sentence: sentence.id, scope: { kind: scoped[1], id: scoped[2] }, text: sentence.text });
      }
      continue;
    }
    const general = /^[“"]([^”"]{1,60})[”"]\s+(?:means|shall mean|has the meaning|includes|refers to)\b/.exec(sentence.text);
    if (general) definitions.push({ term: general[1], section: sentence.section, sentence: sentence.id, scope: null, text: sentence.text });
    for (const match of sentence.text.matchAll(/\((?:the|each,?\s+an?|an?)\s+[“"]([^”"]{1,40})[”"]\)/g)) {
      definitions.push({ term: match[1], section: sentence.section, sentence: sentence.id, scope: null, text: sentence.text, inline: true });
    }
  }
  return definitions;
}

const inScope = (model, sectionId, scope) => {
  if (!scope) return true;
  if (scope.kind === 'Section' || scope.kind === 'Article' || scope.kind === 'Part') return sectionId === scope.id || sectionId.startsWith(`${scope.id}.`);
  return model.sections.get(sectionId)?.chapter === scope.id;
};

/** Every use of every defined term, resolved to the definition in force where it is used. */
function termUses(model, definitions) {
  const terms = [...new Set(definitions.map((definition) => definition.term))].sort((a, b) => b.length - a.length);
  const patterns = terms.map((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const variants = term.endsWith('s') ? `${escaped}|${escaped.slice(0, -1)}` : `${escaped}(?:s|es)?`;
    return [term, new RegExp(`\\b(?:${variants})\\b`, 'g')];
  });
  const defining = new Set(definitions.map((definition) => `${definition.term}|${definition.sentence}`));
  const uses = [];
  for (const sentence of model.sentences) {
    let masked = sentence.text;
    for (const [term, pattern] of patterns) {
      let count = 0;
      masked = masked.replace(pattern, (whole) => { count += 1; return '\u0000'.repeat(whole.length); });
      if (!count || defining.has(`${term}|${sentence.id}`)) continue;
      const candidates = definitions.filter((definition) => definition.term === term);
      const scoped = candidates.find((definition) => definition.scope && inScope(model, sentence.section, definition.scope));
      const definition = scoped ?? candidates.find((item) => !item.scope);
      if (definition) uses.push({ term, section: sentence.section, sentence: sentence.id, definition, count });
    }
  }
  return uses;
}

// ── the adapter ─────────────────────────────────────────────────────────────

export async function openDocument(buffer, options) {
  return documentFromLines(await extractLines(buffer), options);
}

/**
 * The adapter over a PDF's lines as pdf-lines.js reads them. Apart from the reading of the file, everything here is
 * synchronous, so a caller that cannot wait (the evidence service) has the lines read by a worker and comes here.
 */
export function documentFromLines({ pages, lines }, { path: filePath, revision, hash = revision }) {
  const started = performance.now();
  const model = buildModel(lines);
  const references = extractReferences(model);
  const definitions = extractTerms(model);
  const uses = termUses(model, definitions);
  const amendments = model.sentences.filter((sentence) => AMEND_RE.test(sentence.text)).map((sentence) => ({
    in: sentence.section, sentence: sentence.id, kind: AMEND_RE.exec(sentence.text)[1].toLowerCase(),
    targets: references.filter((reference) => reference.sentence === sentence.id && reference.kind !== 'table').map((reference) => reference.target),
  })).filter((amendment) => amendment.targets.length);
  const sectionIds = new Set(model.order.filter((id) => id !== '0'));
  const tableIds = new Set(model.tables.map((table) => table.id));
  const exists = (ids, reference) => (reference.kind === 'table' ? tableIds.has(reference.target) : ids.has(reference.target));

  // Idf over sentences, for the lexical operator.
  const documentFrequency = new Map();
  for (const sentence of model.sentences) for (const token of new Set(words(sentence.text).map(stem))) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  const idf = (token) => Math.log((model.sentences.length + 1) / ((documentFrequency.get(token) ?? 0) + 1));

  /**
   * The graph of term uses and references behind the boundary interface (regions: chapters). Vertices are the
   * sections as the file numbers them; `ids` is the numbering in force and `renamed` maps a file number to its
   * new one, so a reference written "Section 9.7" reaches whichever section is numbered 9.7 in that revision.
   */
  const graphFor = (ids, renamed = new Map()) => {
    const graph = new BoundaryReachability();
    const regionOf = (id) => model.sections.get(id)?.chapter ?? String(id).split('.')[0];
    const alive = [...sectionIds].filter((original) => ids.has(renamed.get(original) ?? original));
    const originalOf = new Map(alive.map((original) => [renamed.get(original) ?? original, original]));
    for (const original of alive) graph.addVertex(original, regionOf(original));
    for (const definition of definitions) graph.addVertex(`def:${definition.term}@${definition.section}`, regionOf(definition.section));
    for (const use of uses) if (graph.hasVertex(use.section)) graph.addEdge(`def:${use.definition.term}@${use.definition.section}`, use.section);
    for (const reference of references) {
      if (reference.kind === 'table') continue;
      const target = originalOf.get(reference.target);
      if (!target || !graph.hasVertex(reference.from) || target === reference.from) continue;
      graph.addEdge(target, reference.from);
    }
    for (const region of new Set([...graph.members.keys()])) graph.interfaceOf(region);
    return graph;
  };
  const baseGraph = graphFor(sectionIds);
  const indexMs = performance.now() - started;

  const revisionOf = (params, session) => {
    const name = params.rev ?? params.base ?? revision;
    if (name === revision || name === 'r1') return { name: revision, ids: sectionIds, graph: baseGraph, renamed: new Map() };
    const derived = session.revisions.get(name);
    if (!derived) throw new OpError(`unknown revision ${name}; this file is ${revision}`);
    if (derived.file !== hash) throw new OpError(`revision ${name} was derived from an earlier version of this file, which has since changed; redo the what-if`, 'stale');
    return { name, ...derived };
  };
  const label = (id, renamed = new Map()) => {
    const shown = renamed.get(id) ?? id;
    const record = model.sections.get(id);
    return record?.kind === 'appendix' ? `Appendix ${shown}` : shown;
  };
  // References from a deleted section are gone with it; the others resolve by the number they are written with,
  // except a section's references to itself ("this Section 9.4"), which follow it when it is renumbered.
  const brokenIn = (ids, renamed = new Map()) => references.filter((reference) => reference.kind !== 'table' && !exists(ids, reference)
    && reference.target !== reference.from && (reference.from === '0' || ids.has(renamed.get(reference.from) ?? reference.from)))
    .map((reference) => ({ in: renamed.get(reference.from) ?? reference.from, target: reference.target, text: reference.text, sentence: reference.sentence }));

  function chapterSummary() {
    const chapters = model.order.map((id) => model.sections.get(id)).filter((record) => record.kind === 'chapter' || record.kind === 'appendix');
    return chapters.map((record) => {
      const children = model.order.filter((id) => model.sections.get(id).parent === record.id);
      const span = children.length ? ` (${children[0]}–${children.at(-1)})` : '';
      return `${record.kind === 'appendix' ? `Appendix ${record.id}` : record.id} ${record.title}${span}`;
    }).join(' · ');
  }

  function card() {
    const numbered = model.order.filter((id) => model.sections.get(id).kind === 'section').length;
    const chapters = model.order.filter((id) => model.sections.get(id).kind === 'chapter').length;
    const appendices = model.order.filter((id) => model.sections.get(id).kind === 'appendix');
    const general = definitions.filter((definition) => !definition.scope && !definition.inline);
    const inline = definitions.filter((definition) => definition.inline);
    const scoped = definitions.filter((definition) => definition.scope);
    const broken = brokenIn(sectionIds);
    const crossReferences = references.filter((reference) => reference.kind !== 'table' && reference.target !== reference.from);
    const lines = [
      `${filePath} · rev ${revision} · PDF, ${pages} pages, ${plural(model.sentences.length, 'sentence')} in ${numbered} numbered sections (${chapters} chapters${appendices.length ? `, Appendices ${appendices[0]}–${appendices.at(-1)}` : ''})`,
      `outline: ${chapterSummary()}`,
      `defined terms (format): ${general.length} by “Term” means (${general.map((definition) => `${definition.term} ${definition.section}`).join(', ')})${inline.length ? `; inline: ${inline.map((definition) => `${definition.term} (${definition.section === '0' ? 'preamble' : definition.section})`).join(', ')}` : ''}`,
    ];
    if (scoped.length) lines.push(`scoped redefinitions (format): ${scoped.map((definition) => `“${definition.term}” in ${definition.section}, for ${definition.scope.kind} ${definition.scope.id}`).join('; ')}`);
    if (model.tables.length) lines.push(`tables: ${model.tables.map((table) => `${table.caption} (${table.section}; ${plural(table.rows.length, 'row')}${table.footnotes.length ? `; footnote on ${table.marked.map((item) => item.cell).join(', ')}` : ''})`).join(' · ')}`);
    lines.push(`cross-references (format): ${crossReferences.length} explicit to ${new Set(crossReferences.map((reference) => reference.target)).size} targets; ${broken.length ? `${broken.length} point to nothing: ${broken.map((item) => `“${item.text}” in ${label(item.in)}`).join(', ')}` : 'all resolve'}`);
    if (amendments.length) lines.push(`amending language (lexical): ${amendments.map((item) => `${item.in} ${item.kind} → ${item.targets.join(', ')}`).join('; ')}`);
    return lines.join('\n');
  }

  const OPS_HELP = [
    'ops (batch several in one call):',
    ' {op:"outline", under?:"5"} sections with titles and pages',
    ' {op:"read", ids:["5.2","B.3"]} exact text of sections, tables and footnotes',
    ' {op:"find", any:["notwithstanding","except"], all?:[…], regex?:"…", under?:"5"} every sentence that matches (words match by prefix, any case); under names a section, chapter or appendix, omit it for the whole file',
    ' {op:"refs", to?:"5.2", from?:"9.3", broken?:true} explicit cross-references',
    ' {op:"terms", name?:"Site"} definitions with their scope, and the sections that use each',
    ' {op:"affected", term?:"Business Day", definition?:"1.3", section?:"5.2", hops?:2} sections reached through term uses and then references, by depth',
    ' {op:"related", to:"5.2"} sentences elsewhere that share its key words and numbers (lexical: may include unrelated ones, may miss paraphrases)',
    ' {op:"tables", id?:"Table 2"} cells and footnotes',
    ' {op:"whatif", renumber?:{"9.4":"9.7"}, delete?:["6.2"], add?:["Appendix E"], base?:"r2"} re-resolves every reference on an edited copy; new revision for refs/affected',
  ].join('\n');

  const sectionText = (id) => {
    const record = model.sections.get(id);
    const parts = [];
    for (const paragraph of record.paragraphs) {
      if (paragraph.table) {
        const table = model.tables.find((item) => item.id === paragraph.table);
        parts.push(`[${table.caption}]\n${[table.header, ...table.rows].map((row) => row.join(' | ')).join('\n')}${table.footnotes.length ? `\n${table.footnotes.map((note) => note.text).join('\n')}` : ''}`);
      } else parts.push(paragraph.text);
    }
    return parts.join('\n');
  };
  /**
   * A scope names a section, chapter or appendix ("5", "5.2", "B", "Appendix B"); "all", "*" or nothing is the whole file.
   * Anything else is refused: an unknown scope must not come back as an empty, "exact" answer.
   */
  const WHOLE = new Set(['', 'all', '*', 'whole', 'everything', 'file', 'document']);
  const scopeOf = (under) => {
    const wanted = String(under ?? '').trim().replace(/^(?:Section|Chapter|Appendix|Article)\s+/i, '');
    if (WHOLE.has(wanted.toLowerCase())) return null;
    if (model.sections.has(wanted) && wanted !== '0') return wanted;
    const chapters = model.order.filter((id) => ['chapter', 'appendix'].includes(model.sections.get(id).kind));
    throw new OpError(`no section, chapter or appendix "${under}"; use one of ${chapters.join(', ')} (or a section such as 5.2), or "all" for the whole file`);
  };
  const scopeFilter = (under) => {
    const scope = scopeOf(under);
    return (sentence) => !scope || sentence.section === scope || sentence.section.startsWith(`${scope}.`) || model.sections.get(sentence.section)?.chapter === scope;
  };
  const sentenceLine = (sentence) => `${label(sentence.section)}${sentence.footnote ? ' (footnote)' : ''}: ${sentence.text}`;
  // Sentences worded identically but for their own section number are boilerplate: listed once, with every section that has them.
  const grouped = (sentences, suffix = () => '') => {
    const groups = new Map();
    for (const sentence of sentences) {
      const own = sentence.section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const shape = sentence.text.replace(new RegExp(`\\b(Section\\s+)${own}\\b`, 'g'), '$1#');
      if (!groups.has(shape)) groups.set(shape, []);
      groups.get(shape).push(sentence);
    }
    return [...groups.values()].map((members) => (members.length === 1 ? `${sentenceLine(members[0])}${suffix(members[0])}`
      : `${members.map((member) => label(member.section)).join(', ')} (same wording, each naming its own section): ${members[0].text.replace(new RegExp(`\\b(Section\\s+)${members[0].section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), '$1#')}${suffix(members[0])}`));
  };

  const ops = {
    outline(params) {
      const under = scopeOf(params.under);
      const rows = model.order.filter((id) => id !== '0' && (!under || id === under || id.startsWith(`${under}.`) || model.sections.get(id).chapter === under))
        .map((id) => { const record = model.sections.get(id); return `${record.kind === 'section' ? '  ' : ''}${label(id)} ${record.title} (p. ${record.page}, ${plural(record.sentences.length, 'sentence')})`; });
      return result({ provenance: 'format', coverage: { universe: under ? `sections under ${under}` : 'every section', complete: true }, forms: [form('full', rows.join('\n'))] });
    },
    read(params) {
      const ids = (Array.isArray(params.ids) ? params.ids : [params.ids ?? params.id]).filter(Boolean).map((id) => String(id).replace(/^(?:Section|Appendix)\s+/i, ''));
      if (!ids.length) throw new OpError('read needs ids, as in ["5.2"]');
      const missing = ids.filter((id) => !model.sections.has(id));
      const found = ids.filter((id) => model.sections.has(id));
      const blocks = found.map((id) => `§ ${label(id)} ${model.sections.get(id).title} (p. ${model.sections.get(id).page})\n${sectionText(id)}`);
      const text = `${blocks.join('\n\n')}${missing.length ? `\nno such section: ${missing.join(', ')}` : ''}`;
      return result({ status: missing.length && !found.length ? 'error' : 'exact', provenance: 'format', coverage: { universe: `${plural(found.length, 'section')}, whole text`, complete: true },
        forms: [form('full', text), ...(blocks.length > 3 ? [form('head', `${blocks.slice(0, 3).join('\n\n')}\n… ${blocks.length - 3} more sections: ${found.slice(3).join(', ')}; read them separately`, false)] : [])] });
    },
    find(params) {
      const any = (params.any ?? []).map((word) => String(word).toLowerCase());
      const all = (params.all ?? []).map((word) => String(word).toLowerCase());
      let regex = null;
      if (params.regex) {
        try { regex = new RegExp(params.regex, 'i'); } catch (error) { throw new OpError(`invalid regex: ${error.message}`); }
      }
      if (!any.length && !all.length && !regex) throw new OpError('find needs any, all or regex');
      const scope = scopeOf(params.under);
      const universe = model.sentences.filter(scopeFilter(scope));
      const hasWord = (tokens, query) => (query.includes(' ') ? tokens.join(' ').includes(query) : tokens.some((token) => token.startsWith(query)));
      const hits = universe.filter((sentence) => {
        const tokens = words(sentence.text).map((word) => word.toLowerCase());
        return (!any.length || any.some((query) => hasWord(tokens, query))) && all.every((query) => hasWord(tokens, query)) && (!regex || regex.test(sentence.text));
      });
      const listing = grouped(hits);
      const sectionsHit = [...new Set(hits.map((sentence) => label(sentence.section)))];
      return result({ provenance: 'lexical', coverage: { universe: `${plural(universe.length, 'sentence')}${scope ? ` under ${scope}` : ', the whole file'} (footnotes and tables included)`, complete: true },
        guarantee: 'every sentence that matches the words is listed (identical wording in several sections listed once); whether each one is relevant is for the reader',
        forms: [form('full', `${plural(hits.length, 'sentence')} in ${plural(sectionsHit.length, 'section')}\n${listing.join('\n')}`),
          ...(listing.length > 25 ? [form('head', `${plural(hits.length, 'sentence')} in ${plural(sectionsHit.length, 'section')} (${sectionsHit.join(', ')}); first 25 shown:\n${listing.slice(0, 25).join('\n')}\nnarrow with all/under to see the rest`, false)] : [])] });
    },
    refs(params, session) {
      const state = revisionOf(params, session);
      const normalize = (id) => (id ? String(id).replace(/^(?:Section|Appendix)\s+/i, '') : null);
      const to = normalize(params.to);
      const from = normalize(params.from);
      // A number in this revision → the section's number in the file.
      const current = (id) => [...state.renamed].find(([, now]) => now === id)?.[0] ?? id;
      let rows;
      let title;
      if (params.broken) {
        rows = brokenIn(state.ids, state.renamed).map((item) => `${label(item.in)}: “${item.text}” → ${item.target} does not exist`);
        title = `${plural(rows.length, 'reference')} to sections that do not exist (revision ${state.name})`;
      } else if (to) {
        const found = references.filter((reference) => reference.target === to && reference.from !== current(to));
        rows = found.map((reference) => `${label(reference.from, state.renamed)}: ${model.sentences[reference.sentence].text}`);
        title = `${plural(new Set(found.map((reference) => reference.from)).size, 'section')} refer to ${to}${state.ids.has(to) ? '' : ' (no section has that number in this revision)'}`;
      } else if (from) {
        const source = current(from);
        const found = references.filter((reference) => reference.from === source);
        rows = found.map((reference) => `${reference.text} → ${reference.target}${exists(state.ids, reference) ? '' : ' (does not exist)'}`);
        title = `${plural(found.length, 'reference')} in ${from}`;
      } else throw new OpError('refs needs to, from or broken:true');
      return result({ provenance: 'format', revision: state.name, coverage: { universe: `${plural(references.length, 'explicit reference')} in the whole file`, complete: true },
        guarantee: 'explicit numbered references only; a provision can depend on another without naming it',
        forms: [form('full', `${title}\n${rows.join('\n')}`), ...(rows.length > 30 ? [form('head', `${title}\n${rows.slice(0, 30).join('\n')}\n… ${rows.length - 30} more`, false)] : [])] });
    },
    terms(params) {
      if (!params.name) {
        const rows = [...new Set(definitions.map((definition) => definition.term))].sort().map((term) => {
          const own = definitions.filter((definition) => definition.term === term);
          const sectionsUsing = new Set(uses.filter((use) => use.term === term).map((use) => use.section));
          return `${term}: defined in ${own.map((definition) => `${label(definition.section)}${definition.scope ? ` (for ${definition.scope.kind} ${definition.scope.id})` : ''}`).join(', ')}; used in ${plural(sectionsUsing.size, 'section')}`;
        });
        return result({ provenance: 'format', coverage: { universe: 'every sentence', complete: true }, forms: [form('full', rows.join('\n'))] });
      }
      const name = String(params.name).replace(/^[“"]|[”"]$/g, '');
      const own = definitions.filter((definition) => definition.term.toLowerCase() === name.toLowerCase());
      if (!own.length) return result({ status: 'exact', provenance: 'format', coverage: { universe: 'every sentence', complete: true }, forms: [form('full', `no definition of “${name}” in the file`)] });
      const rows = own.map((definition) => {
        const using = [...new Set(uses.filter((use) => use.definition === definition).map((use) => use.section))].sort(compareIds).map((id) => label(id));
        return `“${definition.term}” defined in ${label(definition.section)}${definition.scope ? `, applying in ${definition.scope.kind} ${definition.scope.id} only` : ''}: ${definition.text}\n  used with this meaning in ${plural(using.length, 'section')}: ${using.join(', ') || 'none'}`;
      });
      return result({ provenance: 'format', coverage: { universe: 'every sentence', complete: true },
        guarantee: 'uses are capitalised occurrences of the term, resolved to the definition whose scope covers them', forms: [form('full', rows.join('\n'))] });
    },
    affected(params, session) {
      const state = revisionOf(params, session);
      let starts;
      let what;
      if (params.term) {
        const name = String(params.term).replace(/^[“"]|[”"]$/g, '');
        const own = definitions.filter((definition) => definition.term.toLowerCase() === name.toLowerCase());
        if (!own.length) throw new OpError(`no definition of “${name}”`);
        const chosen = params.definition ? own.filter((definition) => definition.section === String(params.definition).replace(/^Section\s+/i, '')) : own.filter((definition) => !definition.scope);
        if (!chosen.length) throw new OpError(`“${name}” is defined in ${own.map((definition) => definition.section).join(', ')}; name one of them as definition`);
        starts = chosen.map((definition) => `def:${definition.term}@${definition.section}`);
        what = `the definition of “${chosen[0].term}” in ${chosen.map((definition) => definition.section).join(', ')}`;
      } else if (params.section) {
        const id = String(params.section).replace(/^(?:Section|Appendix)\s+/i, '');
        if (!state.ids.has(id)) throw new OpError(`no section ${id} in revision ${state.name}`);
        starts = [[...state.renamed].find(([, now]) => now === id)?.[0] ?? id];
        what = `section ${id}`;
      } else throw new OpError('affected needs term or section');
      const hops = params.hops ? Number(params.hops) : Infinity;
      const graph = state.graph;
      const depth = new Map(starts.map((start) => [start, 0]));
      let frontier = starts;
      for (let level = 1; frontier.length && level <= hops; level += 1) {
        const next = [];
        for (const vertex of frontier) for (const target of graph.out.get(vertex) ?? []) if (!depth.has(target)) { depth.set(target, level); next.push(target); }
        frontier = next;
      }
      // Cross-check the unbounded set against the boundary interface (exact reachability).
      if (hops === Infinity) {
        const closure = new Set(starts.flatMap((start) => [...graph.closure(start, 'out').vertices]));
        if (closure.size !== depth.size) throw new Error('internal: layered search and boundary interface disagree');
      }
      const layers = new Map();
      for (const [vertex, level] of depth) {
        if (level === 0 || vertex.startsWith('def:')) continue;
        if (!layers.has(level)) layers.set(level, []);
        layers.get(level).push(vertex);
      }
      const describe = (level) => (params.term ? (level === 1 ? 'use the term' : `refer to a depth-${level - 1} section`) : (level === 1 ? 'refer to it' : `refer to a depth-${level - 1} section`));
      const rows = [...layers].sort((a, b) => a[0] - b[0]).map(([level, ids]) => `depth ${level} (${describe(level)}): ${ids.sort(compareIds).map((id) => label(id, state.renamed)).join(', ')}`);
      const total = [...layers.values()].reduce((sum, ids) => sum + ids.length, 0);
      return result({ provenance: 'format', revision: state.name, coverage: { universe: `term uses and explicit references across ${plural(state.ids.size, 'section')}`, complete: true },
        guarantee: 'exact over explicit references and capitalised term uses; unstated dependencies are not seen',
        forms: [form('full', `${plural(total, 'section')} reached from ${what}${hops === Infinity ? '' : ` within ${hops} hops`}\n${rows.join('\n')}`)] });
    },
    related(params) {
      const id = String(params.to ?? '').replace(/^(?:Section|Appendix)\s+/i, '');
      const record = model.sections.get(id);
      if (!record) throw new OpError('related needs to, a section id');
      // Key words come from the section's own clause (its first paragraph), not from boilerplate after it.
      const clause = splitSentences(record.paragraphs.find((paragraph) => paragraph.text)?.text ?? '');
      const own = new Map();
      for (const sentence of clause) for (const token of words(sentence).map(stem)) if (!STOP.has(token) && !/^\d+$/.test(token)) own.set(token, idf(token));
      const keys = [...own].sort((a, b) => b[1] - a[1]).slice(0, 12);
      const keySet = new Set(keys.map(([token]) => token));
      const scored = model.sentences.filter((sentence) => sentence.section !== id).map((sentence) => {
        const tokens = new Set(words(sentence.text).map(stem));
        const shared = [...keySet].filter((token) => tokens.has(token));
        const score = shared.reduce((sum, token) => sum + own.get(token), 0) + (/\(\d+\)\s+(?:days|months|weeks|years)|\b\d+\s*%/.test(sentence.text) ? 0.5 : 0);
        return { sentence, shared, score };
      }).filter((item) => item.shared.length >= 2).sort((a, b) => b.score - a.score);
      const best = scored[0]?.score ?? 0;
      const kept = scored.filter((item) => item.score >= best * 0.45).slice(0, 40);
      const referrers = references.filter((reference) => reference.target === id && reference.from !== id).map((reference) => label(reference.from));
      const rows = grouped(kept.map((item) => item.sentence), (sentence) => ` [shares: ${kept.find((item) => item.sentence === sentence).shared.join(', ')}]`);
      return result({ provenance: 'lexical', coverage: { universe: `${plural(model.sentences.length, 'sentence')} scored`, complete: true },
        guarantee: 'candidates by shared key words (stemmed); not a judgement of relevance; paraphrases with other words are missed',
        forms: [form('full', `key words of ${id}: ${keys.map(([token]) => token).join(', ')}\nexplicit references to ${id} from: ${[...new Set(referrers)].join(', ') || 'none'}\n${rows.length} candidate sentences elsewhere:\n${rows.join('\n')}`)] });
    },
    tables(params) {
      const chosen = params.id ? model.tables.filter((table) => table.id.toLowerCase() === String(params.id).toLowerCase()) : model.tables;
      if (params.id && !chosen.length) throw new OpError(`no ${params.id}; tables are ${model.tables.map((table) => table.id).join(', ')}`);
      const text = chosen.map((table) => `${table.caption} (in ${label(table.section)}, p. ${table.page})\n${[table.header, ...table.rows].map((row) => row.join(' | ')).join('\n')}${table.footnotes.length ? `\n${table.footnotes.map((note) => note.text).join('\n')}` : ''}`).join('\n\n');
      return result({ provenance: 'format', coverage: { universe: `${plural(model.tables.length, 'table')}`, complete: true }, forms: [form('full', text)] });
    },
    whatif(params, session) {
      const base = revisionOf({ rev: params.base }, session);
      const ids = new Set(base.ids);
      const renamed = new Map(base.renamed);
      const edits = [];
      const norm = (id) => String(id).replace(/^(?:Section|Appendix)\s+/i, '');
      for (const [from, to] of Object.entries(params.renumber ?? {})) {
        const old = norm(from);
        const now = norm(to);
        if (!ids.has(old)) throw new OpError(`cannot renumber ${old}: no such section in revision ${base.name}`);
        if (ids.has(now)) throw new OpError(`cannot renumber ${old} as ${now}: ${now} already exists`);
        ids.delete(old);
        ids.add(now);
        const original = [...renamed].find(([, value]) => value === old)?.[0] ?? old;
        renamed.set(original, now);
        edits.push(`${old} renumbered ${now}`);
      }
      for (const id of params.delete ?? []) { if (!ids.delete(norm(id))) throw new OpError(`cannot delete ${id}: no such section`); edits.push(`${norm(id)} deleted`); }
      for (const id of params.add ?? []) { ids.add(norm(id)); edits.push(`${norm(id)} added`); }
      if (!edits.length) throw new OpError('whatif needs renumber, delete or add');
      // References name targets by number: a renumbered section answers to its new number only.
      const before = brokenIn(base.ids, base.renamed);
      const after = brokenIn(ids, renamed);
      const key = (item) => `${item.target}|${item.sentence}`;
      const beforeKeys = new Set(before.map(key));
      const afterKeys = new Set(after.map(key));
      const revisionName = `r${session.revisions.size + 2}`;
      session.revisions.set(revisionName, { file: hash, ids, renamed, graph: graphFor(ids, renamed) });
      const lines = [`revision ${revisionName} = ${base.name} with ${edits.join('; ')}`,
        `broken references now (${after.length}): ${after.map((item) => `${label(item.in)} “${item.text}”`).join('; ') || 'none'}`,
        `newly broken: ${after.filter((item) => !beforeKeys.has(key(item))).map((item) => `${label(item.in)} “${item.text}”`).join('; ') || 'none'}`,
        `fixed: ${before.filter((item) => !afterKeys.has(key(item))).map((item) => `${label(item.in)} “${item.text}”`).join('; ') || 'none'}`];
      return result({ provenance: 'format', revision: revisionName, coverage: { universe: `${plural(references.length, 'explicit reference')} re-resolved`, complete: true },
        guarantee: 'numbered references are re-resolved against the edited numbering; text is not rewritten', forms: [form('full', lines.join('\n'))] });
    },
  };

  const fullText = () => {
    const out = [];
    let page = 0;
    for (const line of lines) {
      if (line.page !== page) { page = line.page; out.push(`--- page ${page} ---`); }
      out.push(line.cells.length > 1 ? line.cells.map((cell) => cell.text).join(' | ') : line.text);
    }
    return out.join('\n');
  };

  return { kind: 'document', revision, indexMs, opsHelp: OPS_HELP, card, fullText, ops, model, references, definitions, uses, amendments };
}
