// What an ask means as operations over a whole workbook, document or
// assembly (file-ops.js runs them). Two readings, both of the ask's own
// words and nothing else:
//
// `operationsWritten`: operations written loosely. A model shown the
// operations in an answer writes them back its own way (live run, 13
// November 2026: 1 ask in 72 was the `{file, op}` object it had been shown):
// after the file's name as `whatif move:{…}; clash all; distance A B`, as one
// `op` holding several, as a list. Each is read as the operation it names.
//
// `operationsAsked`: plain words that say an operation outright. "How far
// would Roller assembly:15 have to be raised to clear Cross member:4" is a
// clearance, "if B3 were 25%, what would B13 be" a recalculation, "sections
// that refer by number to Section 3.3" the references to it. A question
// that needs judgement names no operation and is left to the search.
//
// `names` is what the file itself calls things, read only when the words
// need it: `{ occurrences: [path…] }` for an assembly, `{ sheets: [name…],
// cell(sheet, address) }` for a workbook.

const SECTION = String.raw`(?:[A-Z]\.)?\d{1,2}(?:\.\d{1,3})*|[A-Z](?![a-z])`;
const PLACE = String.raw`(?:sections?|clauses?|appendix|appendices|§§?)`;
const signed = (text) => Number(String(text).replace(/[−–]/g, '-').replace(/^\+/, ''));
const distinct = (list) => [...new Set(list)];
// A section's number as written: a lone lower-case letter is a word ("a section"), not Appendix A.
const sectionId = (raw) => (raw == null || /^[a-z]$/.test(raw) ? null : raw);

/** The parameters each operation takes, by the kind of file. */
const PARAMETERS = {
  workbook: { cells: ['range', 'rev'], deps: ['cell', 'dir', 'rev'], whatif: ['set', 'formulas', 'show', 'base'], formulas: [], sql: ['q', 'rev'] },
  document: { outline: ['under'], read: ['ids', 'id'], find: ['any', 'all', 'regex', 'under'], refs: ['to', 'from', 'broken', 'rev'], terms: ['name'],
    affected: ['term', 'section', 'definition', 'hops', 'rev'], related: ['to'], tables: ['id'], whatif: ['renumber', 'delete', 'add', 'base'] },
  assembly: { count: ['under', 'rev'], tree: ['under', 'depth', 'rev'], find: ['name', 'def', 'under', 'where', 'rev'], bounds: ['of', 'rev'], clash: ['under', 'with', 'rev'],
    distance: ['a', 'b', 'rev'], clearance: ['move', 'from', 'dir', 'rev'], pose: ['a', 'b', 'rev'], whatif: ['move', 'base'] },
};
// What an operation cannot be run without: one of these, or (a list) all of them.
const NEEDED = {
  workbook: { cells: ['range'], deps: ['cell'], whatif: [['set', 'formulas']], sql: ['q'] },
  document: { read: [['ids', 'id']], find: [['any', 'all', 'regex']], refs: [['to', 'from', 'broken']], affected: [['term', 'section']], related: ['to'], whatif: [['renumber', 'delete', 'add']] },
  assembly: { find: [['name', 'def', 'under', 'where']], distance: ['a', 'b'], clearance: ['move', 'from'], pose: ['a', 'b'], whatif: ['move'] },
};
const NUMERIC = new Set(['hops', 'depth']);
const complete = (kind, operation) => (NEEDED[kind][operation.op] ?? []).every((need) => (Array.isArray(need) ? need.some((key) => operation[key] != null) : operation[need] != null));
const operationName = (kind, word) => {
  const name = String(word ?? '').toLowerCase().replace(/^what[- ]?if$/, 'whatif');
  return Object.hasOwn(PARAMETERS[kind], name) ? name : null;
};

// ── What the file calls things ──

/**
 * Where a text names an assembly's occurrences: by path ("Drive unit:1/Motor:1"), by a tail of it that only one
 * occurrence has ("Motor:1"), or by a name without its number when only one occurrence has that name ("the Drive
 * unit"). In the order written, the longest name winning where two overlap.
 */
function occurrencesNamed(text, paths) {
  const labels = new Map();
  const add = (label, path, bare) => {
    const key = bare ? `=${label}` : label.toLowerCase();
    if (!labels.has(key)) labels.set(key, { label, bare, paths: new Set() });
    labels.get(key).paths.add(path);
  };
  for (const path of paths ?? []) {
    const parts = path.split('/');
    for (let from = 0; from < parts.length; from += 1) add(parts.slice(from).join('/'), path, false);
    if (/:\d+$/.test(parts.at(-1))) add(parts.at(-1).replace(/:\d+$/, ''), path, true);
  }
  const usable = [...labels.values()].filter((entry) => entry.paths.size === 1).sort((a, b) => b.label.length - a.label.length);
  const lower = text.toLowerCase();
  const found = [];
  for (const entry of usable) {
    // A name written with its number is read in any case; a bare name only as the file writes it, so "frame" stays a word.
    const needle = entry.bare ? entry.label : entry.label.toLowerCase();
    const hay = entry.bare ? text : lower;
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if (/[\p{L}\p{N}]/u.test(text[at - 1] ?? '') || /[\p{L}\p{N}]/u.test(text[end] ?? '')) continue;
      if (entry.bare && /^:\d/.test(text.slice(end))) continue;
      if (found.some((other) => at < other.end && end > other.start)) continue;
      found.push({ path: [...entry.paths][0], start: at, end });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

const AXIS = { x: 0, y: 1, z: 2 };
/** A direction said in words: "along +z", "in −x", "raised", "lowered". Up when none is said. */
function directionSaid(text) {
  const along = /(?:along|in|toward\w*)\s+(?:the\s+)?([-+−–]?)\s*([xyz])\b/i.exec(text) ?? /([-+−–])\s*([xyz])\b/i.exec(text);
  if (along) return [0, 0, 0].map((_, index) => (index === AXIS[along[2].toLowerCase()] ? (/[-−–]/.test(along[1]) ? -1 : 1) : 0));
  return /\b(?:lower\w*|drop\w*|down\w*)\b/i.test(text) ? [0, 0, -1] : [0, 0, 1];
}

/** How far a text says something is moved: "by dz:10 mm", "20 mm in −x", "raised by 10 mm". `before` is what leads up to its name. */
function displacement(after, before) {
  const delta = {};
  for (const match of after.matchAll(/\bd([xyz])\s*[:=]?\s*([-+−–]?\d+(?:\.\d+)?)/gi)) delta[`d${match[1].toLowerCase()}`] = signed(match[2]);
  if (Object.keys(delta).length) return delta;
  const unit = String.raw`(?:mm|millimet(?:re|er)s?)`;
  const along = new RegExp(String.raw`(\d+(?:\.\d+)?)\s*${unit}?\s+(?:in|along|toward\w*)\s+(?:the\s+)?([-+−–]?)\s*([xyz])\b`, 'i').exec(after);
  if (along) return { [`d${along[3].toLowerCase()}`]: (/[-−–]/.test(along[2]) ? -1 : 1) * Number(along[1]) };
  const then = new RegExp(String.raw`(?:in|along|toward\w*)\s+(?:the\s+)?([-+−–]?)\s*([xyz])\b[^.;?]{0,12}?\bby\s+(\d+(?:\.\d+)?)\s*${unit}?`, 'i').exec(after);
  if (then) return { [`d${then[2].toLowerCase()}`]: (/[-−–]/.test(then[1]) ? -1 : 1) * Number(then[3]) };
  const amount = new RegExp(String.raw`(\d+(?:\.\d+)?)\s*${unit}\b`, 'i').exec(after);
  if (!amount) return null;
  const words = `${before} ${after}`;
  if (/\b(?:rais\w*|lift\w*|up(?:ward\w*)?|higher)\b/i.test(words)) return { dz: Number(amount[1]) };
  if (/\b(?:lower\w*|drop\w*|down(?:ward\w*)?)\b/i.test(words)) return { dz: -Number(amount[1]) };
  return null;
}

const MOVING = /\b(?:mov\w*|rais\w*|lift\w*|lower\w*|shift\w*|translat\w*|displac\w*|offset\w*|nudg\w*|slid\w*|what[- ]?if)\b/i;
/** The moves a text says, by the occurrence moved: each name with the displacement that follows it. */
function movesSaid(text, mentions) {
  const moves = {};
  if (!MOVING.test(text)) return moves;
  mentions.forEach((mention, index) => {
    const after = text.slice(mention.end, mentions[index + 1]?.start ?? text.length).split(/[;?!](?:\s|$)|\.(?:\s|$)/)[0];
    const before = text.slice(Math.max(mentions[index - 1]?.end ?? 0, mention.start - 40), mention.start);
    const delta = displacement(after, before);
    if (delta && !moves[mention.path]) moves[mention.path] = delta;
  });
  return moves;
}

// ── A document's edits, said in words ──

function documentEdits(text) {
  const renumber = {};
  const ids = (pattern) => [...text.matchAll(new RegExp(pattern, 'gi'))];
  for (const match of [...ids(String.raw`\b${PLACE}\s*(${SECTION})\s+(?:(?:were|was|is|are|be|being|gets?|got)\s+)?(?:(?:also|then)\s+)?renumbered\s+(?:as|to)\s+(?:${PLACE}\s*)?(${SECTION})`),
    ...ids(String.raw`\brenumber(?:ing|s|ed)?\s+${PLACE}\s*(${SECTION})\s+(?:as|to)\s+(?:${PLACE}\s*)?(${SECTION})`)]) {
    if (sectionId(match[1]) && sectionId(match[2])) renumber[match[1]] = match[2];
  }
  const listed = (...patterns) => distinct(patterns.flatMap((pattern) => ids(pattern).map((match) => sectionId(match[1]))).filter(Boolean));
  const was = String.raw`(?:(?:were|was|is|are|be|being|gets?|got)\s+)?(?:(?:also|then)\s+)?`;
  const add = listed(String.raw`\b(?:add(?:ing|ed|s)?|insert(?:ing|ed|s)?|creat(?:ing|ed|es?))\s+(?:an?\s+|a new\s+|new\s+)?${PLACE}\s*(${SECTION})`, String.raw`\b${PLACE}\s*(${SECTION})\s+${was}(?:added|inserted|created)\b`);
  const remove = listed(String.raw`\b(?:delet(?:ing|ed|es?)|remov(?:ing|ed|es?)|strik(?:ing|es?)|struck)\s+${PLACE}\s*(${SECTION})`, String.raw`\b${PLACE}\s*(${SECTION})\s+${was}(?:deleted|removed|struck)\b`);
  return { ...(Object.keys(renumber).length ? { renumber } : {}), ...(remove.length ? { delete: remove } : {}), ...(add.length ? { add } : {}) };
}

// ── A workbook's cells, changed in words ──

const CHANGED = String.raw`changed|set|corrected|replaced|updated|rewritten|raised|lowered|increased|decreased|reduced|fixed|amended|edited|overwritten|switched`;
/** A formula as written in a sentence, from its "=": to where its brackets close and no operator carries it on. */
function formulaAt(text) {
  let depth = 0;
  let quoted = false;
  let end = text.length;
  for (let at = 1; at < text.length; at += 1) {
    const character = text[at];
    if (character === '"') quoted = !quoted;
    if (quoted) continue;
    if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    if (depth > 0) continue;
    if (depth < 0 || /[?;]/.test(character) || (/[.,]/.test(character) && /^\s|^$/.test(text.slice(at + 1, at + 2)))) { end = at; break; }
    if (/\s/.test(character)) {
      const next = text.slice(at).trimStart()[0] ?? '';
      const last = text.slice(0, at).trimEnd().at(-1) ?? '';
      if (!/[-+*/^&=<>,(]/.test(last) && !/[-+*/^&=<>)]/.test(next)) { end = at; break; }
    }
  }
  return text.slice(0, end).trim();
}

/**
 * The cells a text sets and the cells it asks about: "with Roll-up!B11 corrected to =SUM(Shifts!H2:H1801) and
 * Roll-up!B3 changed to 0.25, what would Roll-up!B13 be". A cell written without its sheet takes the sheet named
 * beside it, or the one sheet where the cells it sets exist and the cells it asks about are formulas.
 */
function cellChanges(text, names) {
  const pattern = /(?<![\p{L}\p{N}_$.:!'])(?:(?:'([^']+)'|([\p{L}_][\p{L}\p{N}_.-]*))!)?\$?([A-Z]{1,3})\$?(\d{1,7})(?![\p{L}\p{N}_!(])/gu;
  const cells = [];
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const cell = { sheet: match[1] ?? match[2] ?? null, address: `${match[3]}${match[4]}`, start: match.index };
    const after = text.slice(match.index + match[0].length);
    if (/^:\$?[A-Z]{1,3}\$?\d/.test(after)) continue;
    const lead = new RegExp(String.raw`^\s*(?:(were|was|is|are|be|being|gets?|got|has been|had been)\s+)?(?:(?:also|then|instead|now)\s+)*(?:(${CHANGED}|becomes?|became|equals?)\s*)?(?:from\s+\S+\s+)?(?:(to|as|with|at)\s+|(:=|=>|->|→|=(?!=))\s*)?`, 'i').exec(after);
    const rest = after.slice(lead[0].length);
    const formula = /^=\s*(?:[A-Za-z_(]|'[^']+'!)/.test(rest) ? formulaAt(rest) : lead[4] === '=' && /^\s*(?:[A-Za-z_]+\(|'[^']+'!)/.test(rest) ? `=${formulaAt(`=${rest}`).slice(1)}` : null;
    const number = formula ? null : /^[$€£]?\s*(-?\d[\d,]*(?:\.\d+)?)\s*(%|percent\b|per cent\b)?/i.exec(rest);
    const string = formula || number ? null : /^["“]([^"”]+)["”]/.exec(rest);
    // A change is said by its verb, by "=", by "were", or by "to" after a verb that leads up to the cell ("changing B3 to 25%").
    const led = new RegExp(String.raw`\b(?:${CHANGED}|chang\w*|sett?\w*|correct\w*|replac\w*|updat\w*|mak\w*|put\w*|with)\b[^.;?]{0,30}$`, 'i').test(text.slice(0, match.index));
    const said = Boolean(lead[2]) || Boolean(lead[4]) || /^were$/i.test(lead[1] ?? '') || (Boolean(lead[3]) && led);
    if (said && (formula || number || string)) {
      cell.change = formula ? { formula } : number ? { number: Number(number[1].replace(/,/g, '')), percent: Boolean(number[2]) } : { value: string[1] };
      pattern.lastIndex = match.index + match[0].length + lead[0].length + (formula ?? number?.[0] ?? string[0]).length;
    }
    cells.push(cell);
  }
  if (!cells.some((cell) => cell.change)) return null;
  // The sheet of a cell written without one.
  const qualified = cells.filter((cell) => cell.sheet);
  const bare = cells.filter((cell) => !cell.sheet);
  if (bare.length) {
    let sheet = qualified[0]?.sheet ?? null;
    const sheets = sheet ? [] : names?.sheets ?? [];
    if (!sheet) {
      const said = sheets.filter((name) => new RegExp(String.raw`(?<![\p{L}\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\p{L}\p{N}])`, 'iu').test(text));
      const fits = (name) => bare.every((cell) => { const facts = names.cell(name, cell.address); return facts && (cell.change ? true : Boolean(facts.formula)); });
      const candidates = (said.length ? said : sheets).filter(fits);
      sheet = candidates.length === 1 ? candidates[0] : null;
    }
    // Without the sheet, a letter and a number ("Q3", "A4") is not known to be a cell: left to be read as words.
    if (!sheet) { if (bare.some((cell) => cell.change)) return null; }
    for (const cell of bare) cell.sheet = sheet;
  }
  const named = cells.filter((cell) => cell.sheet);
  const reference = (cell) => `${/^[\p{L}_][\p{L}\p{N}_.-]*$/u.test(cell.sheet) ? cell.sheet : `'${cell.sheet}'`}!${cell.address}`;
  const set = {};
  const formulas = {};
  for (const cell of named.filter((entry) => entry.change)) {
    if (cell.change.formula) formulas[reference(cell)] = cell.change.formula;
    else if (cell.change.value != null) set[reference(cell)] = cell.change.value;
    else {
      // "25%" is 0.25 where the cell holds a fraction, and 25 where it holds whole percentages.
      const held = cell.change.percent ? names?.cell?.(cell.sheet, cell.address)?.value : null;
      set[reference(cell)] = cell.change.percent && !(typeof held === 'number' && Math.abs(held) > 1) ? Number((cell.change.number / 100).toPrecision(12)) : cell.change.number;
    }
  }
  const changed = new Set([...Object.keys(set), ...Object.keys(formulas)]);
  const show = distinct(named.filter((cell) => !cell.change).map(reference)).filter((cell) => !changed.has(cell));
  if (!changed.size) return null;
  const base = /\b(?:rev(?:ision)?|base|on|from|keeping|using)\s*[:=]?\s*(r[2-9]\d?)\b/.exec(text)?.[1];
  return { op: 'whatif', ...(Object.keys(set).length ? { set } : {}), ...(Object.keys(formulas).length ? { formulas } : {}), ...(show.length ? { show } : {}), ...(base ? { base } : {}) };
}

// ── Plain words ──

const REFERRING = String.raw`(?:references?|refer(?:s|red|ring)?|cross[- ]?refer\w*|cit(?:es?|ed|ing)|point(?:s|ed|ing)?|mention(?:s|ed|ing)?)`;
const AFFECTING = /\b(?:affect\w*|impact\w*|knock[- ]on|consequen\w*|depend\w*\s+on|rel(?:y|ies|ying)\s+on|reach\w*)\b/i;
const USING_TERM = /\buses?\s+(?:the\s+)?(?:defined\s+)?(?:term|definition)\b|\b(?:sections?|provisions?|clauses?)\s+(?:that|which)\s+uses?\b/i;
const ASSEMBLY_NAMES = /\b(?:mov\w*|rais\w*|lift\w*|lower\w*|shift\w*|gap|distance|clear\w*|bounds?|bounding|extents?|spacing|separation|how far|how close|what[- ]?if|d[xyz])\b/i;
const CLEARING = /\b(?:clear\w*|no longer|none of|not|stop\w*|free of|without|avoid\w*)\b[^.?]*\b(?:overlap\w*|interfer\w*|clash\w*|collid\w*|interpenetrat\w*|touch\w*|hit\w*)\b|\bto clear\b|\bclears\b/i;
const HOW_FAR = /\bhow (?:far|much|high)\b|\bby how much\b|\b(?:least|minimum|smallest|shortest)\b[^.?]*\b(?:travel|mov\w*|rais\w*|lift\w*|shift\w*)\b/i;
const SUPPOSING = /\b(?:if|suppos\w*|assum\w*|were|would|what[- ]?if|corrected|instead|chang\w*|set(?:ting)?|after|with|when|once)\b/i;
const APART = /\b(?:gap|distance|clearance|spacing|separation|how far apart|how close)\b/i;

/**
 * The operations an ask's plain words mean on a file of this kind, as `[{ op, …params }]`, or none. Only what the
 * words say outright: a question that needs judgement is left to the search, which then names the operations.
 */
export function operationsAsked(kind, text, names = null) {
  const asked = [];
  if (kind === 'document') {
    // "If Section 9.4 were renumbered 9.7 and an Appendix E added": the document as it would then be, its broken references listed.
    const edits = documentEdits(text);
    if (Object.keys(edits).length) return [{ op: 'whatif', ...edits }];
    if (/\bbroken\b[^.?]*\breferences?\b|\breferences?\b[^.?]*\b(?:do(?:es)? not|doesn't|don't|no longer) exist\b|\bdangling references?\b/i.test(text)) asked.push({ op: 'refs', broken: true });
    else {
      const to = new RegExp(String.raw`\b${REFERRING}\s+(?:by number\s+)?(?:to\s+)?["“'‘]?${PLACE}\s*(${SECTION})`, 'i').exec(text);
      const from = new RegExp(String.raw`\b(?:section|clause|appendix|§)\s*(${SECTION})\s+(?:refers?|cites?|points?)\s+to\b`, 'i').exec(text);
      if (to && sectionId(to[1])) {
        // "refer to Section 3.3, 4.2 or 5.5": each of them.
        const targets = [to[1]];
        let rest = text.slice(to.index + to[0].length);
        for (let more = new RegExp(String.raw`^["”'’]?\s*(?:,\s*(?:and|or)?|and|or|&)\s*["“'‘]?(?:${PLACE}\s*)?(${SECTION})(?![\p{L}\p{N}])`, 'iu').exec(rest); more && targets.length < 8;
          more = new RegExp(String.raw`^["”'’]?\s*(?:,\s*(?:and|or)?|and|or|&)\s*["“'‘]?(?:${PLACE}\s*)?(${SECTION})(?![\p{L}\p{N}])`, 'iu').exec(rest)) {
          if (!sectionId(more[1])) break;
          targets.push(more[1]);
          rest = rest.slice(more[0].length);
        }
        for (const target of distinct(targets)) asked.push({ op: 'refs', to: target });
      } else if (from) asked.push({ op: 'refs', from: from[1] });
    }
    if (/\b(?:outline|table of contents|list of (?:its |the )?sections|section headings)\b/i.test(text)) asked.push({ op: 'outline' });
    const term = /\b(?:definition of|meaning of|how is|what does)\s+(?:the term\s+)?["“']?([A-Z][\p{L}\p{N}-]*(?:\s+[A-Z][\p{L}\p{N}-]*){0,3})["”']?(?:\s+(?:defined|mean))?/u.exec(text);
    // "If the definition of “Business Day” were changed, which sections would be affected": what the term's uses and the references to them reach.
    const quoted = [...text.matchAll(/["“'‘]([A-Z][^"”'’]{1,40})["”'’]/g)].find((match) => !new RegExp(`^${PLACE}\\b`, 'i').test(match[1]));
    const subject = quoted?.[1] ?? term?.[1] ?? null;
    const twoSteps = USING_TERM.test(text) && /\brefer\w*\b/i.test(text);
    if (subject && (AFFECTING.test(text) || twoSteps)) {
      const where = quoted ? new RegExp(String.raw`^["”'’]?\s+(?:as\s+)?(?:defined\s+|given\s+|set out\s+)?(?:in|of|at|under)\s+${PLACE}\s*(${SECTION})`, 'i').exec(text.slice(quoted.index + quoted[0].length - 1)) : null;
      // "Uses the term, or refers by number to a section that does" is two steps; "through a chain" is every step.
      const hops = /\brefer\w*\s+(?:by number\s+)?to\s+(?:a|any|another|one)\s+(?:section|provision|clause)?\s*that\s+(?:does|uses?)\b/i.test(text) && !/\b(?:chain|transitiv\w*|indirect\w*)\b/i.test(text) ? 2 : null;
      asked.push({ op: 'affected', term: subject, ...(where && sectionId(where[1]) ? { definition: where[1] } : {}), ...(hops ? { hops } : {}) });
    } else if (AFFECTING.test(text) && /\b(?:if|were|chang\w*|amend\w*|delet\w*|remov\w*)\b/i.test(text)) {
      const section = new RegExp(String.raw`\b(?:section|clause)\s*(${SECTION})`, 'i').exec(text);
      if (section && sectionId(section[1])) asked.push({ op: 'affected', section: section[1] });
    }
    if (!asked.some((operation) => operation.op === 'affected')) {
      if (/\bdefin(?:ed|ition|itions)\b|\bmeaning of\b/i.test(text) && term) asked.push({ op: 'terms', name: term[1] });
      else if (/\b(?:defined terms|list of definitions|every definition|all definitions)\b/i.test(text)) asked.push({ op: 'terms' });
    }
    // "the text of Section 5.2", "what does Section 9.3 say": the sections themselves, named outright.
    if (!asked.length && /\b(?:text|read|says?|wording|full|exact|quote|show)\b/i.test(text)) {
      const ids = [...text.matchAll(new RegExp(String.raw`\b(?:sections?|clauses?|appendix|§§?)\s*(${SECTION})`, 'gi'))].map((match) => match[1]);
      if (ids.length) asked.push({ op: 'read', ids: [...new Set(ids)] });
    }
  } else if (kind === 'assembly') {
    const mentions = ASSEMBLY_NAMES.test(text) ? occurrencesNamed(text, names?.occurrences) : [];
    const parts = distinct(mentions.map((mention) => mention.path));
    // "If the Drive unit is moved 20 mm in −x": a copy with it moved, its interferences checked again, and any gap asked measured on that copy.
    const moves = movesSaid(text, mentions);
    const gap = APART.exec(text);
    const between = () => {
      const after = distinct(mentions.filter((mention) => mention.start > gap.index).map((mention) => mention.path));
      const still = parts.filter((part) => !moves[part]);
      return after.length >= 2 ? after.slice(0, 2) : still.length === 2 ? still : parts.length === 2 ? parts : null;
    };
    if (Object.keys(moves).length) {
      const pair = gap ? between() : null;
      return [{ op: 'whatif', move: moves }, ...(pair ? [{ op: 'distance', a: pair[0], b: pair[1] }] : [])];
    }
    // "How far would A have to be raised so that it no longer overlaps B": the least travel that clears it.
    // Asked as a question, or by the operation's own name once an answer has shown it ("the clearance move needed to raise A so that none of it overlaps B").
    const clearing = parts.length >= 2 && MOVING.test(text) && ((HOW_FAR.test(text) && CLEARING.test(text)) || /\bclearance\b/i.test(text) || (/\b(?:needed|required|necessary|enough)\b/i.test(text) && CLEARING.test(text)));
    if (clearing) {
      // The part to clear is the one named after "from" or "overlaps"; the other is the one moved.
      const stays = mentions.find((mention) => /\b(?:from|overlap\w*|clear(?:s|ing)?(?: of)?|against|hit\w*|touch\w*)\s+(?:the\s+)?$/i.test(text.slice(Math.max(0, mention.start - 24), mention.start)))?.path ?? parts[1];
      return [{ op: 'clearance', move: parts.find((part) => part !== stays), from: stays, dir: directionSaid(text) }];
    }
    if (/\b(?:overlap\w*|interpenetrat\w*|interfer\w*|clash\w*|collid\w*|collisions?)\b/i.test(text)) asked.push({ op: 'clash' });
    if (gap && between()) asked.push({ op: 'distance', a: between()[0], b: between()[1] });
    if (parts.length && /\bbounds?\b|\bbounding box\b|\bextents?\b|\b(?:size|dimensions?)\s+of\b/i.test(text)) asked.push(...parts.slice(0, 3).map((part) => ({ op: 'bounds', of: part })));
    else if (/\bbounding box\b|\boverall (?:size|dimensions?|length|width|height|extent)\b|\b(?:length|width)\b[^.?]*\bheight\b/i.test(text)) asked.push({ op: 'bounds' });
    // A bound written as the operations write it ("zmax > 910", "where zmax > 910 and xmin < 100"), or as a height in words.
    const bound = String.raw`[xyz]m(?:in|ax)\s*(?:<=|>=|<|>|=)\s*-?\d+(?:\.\d+)?`;
    const where = new RegExp(String.raw`\b${bound}(?:\s*(?:mm)?\s+(?:and|or)\s+${bound})*`, 'i').exec(text);
    const above = /\b(?:above|higher than|over|beyond|exceed\w*|greater than)\s+z\s*=?\s*(-?\d+(?:\.\d+)?)|\bz\s*(?:>|above|greater than)\s*(-?\d+(?:\.\d+)?)/i.exec(text)
      ?? (/\bz\b/i.test(text) ? /\b(?:above|higher than|over|beyond|exceed\w*|greater than|more than)\s+(-?\d+(?:\.\d+)?)\s*(?:mm\b|millimet)/i.exec(text) : null);
    if (where) asked.push({ op: 'find', where: where[0].replace(/\s*mm\b/gi, '').replace(/\s+/g, ' ') });
    else if (above) asked.push({ op: 'find', where: `zmax > ${above[1] ?? above[2]}` });
    if (/\bhow many\b|\bcounts?\b|\bnumber of\b|\bbill of materials\b|\bparts list\b|\bmost[- ]used\b|\bused (?:the )?most\b/i.test(text)) asked.push({ op: 'count' });
    if (/\b(?:tree|hierarchy|deepest|levels?)\b/i.test(text)) asked.push({ op: 'tree' });
  } else if (kind === 'workbook') {
    // "If B3 were 25%, what would B13 be": the workbook recalculated with the cell changed.
    const changed = SUPPOSING.test(text) ? cellChanges(text, names) : null;
    if (changed) return [changed];
    if (/\bformulas?\b/i.test(text)) asked.push({ op: 'formulas' });
  }
  return asked;
}

// ── Operations written loosely ──

/** A value as a model writes one after a parameter's name: JSON, JSON with bare keys, a quoted string, a bare word. */
function looseValue(key, raw) {
  const text = raw.trim().replace(/[,;]+\s*$/, '').trim();
  if (/^[[{]/.test(text)) {
    let depth = 0;
    let quoted = false;
    let end = text.length;
    for (let at = 0; at < text.length; at += 1) {
      if (text[at] === '"') quoted = !quoted;
      if (quoted) continue;
      if (/[[{]/.test(text[at])) depth += 1;
      else if (/[\]}]/.test(text[at])) { depth -= 1; if (depth === 0) { end = at + 1; break; } }
    }
    const body = text.slice(0, end);
    for (const candidate of [body, body.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":'), body.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":').replace(/'/g, '"')]) {
      try { return JSON.parse(candidate); } catch { /* the next way of writing it */ }
    }
  }
  const quoted = /^["“']([^"”']*)["”']$/.exec(text);
  if (quoted) return quoted[1];
  if (key === 'broken') return !/^(?:false|no|0)$/i.test(text);
  if (NUMERIC.has(key) && /^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text;
}

/** Where a text, outside brackets and quotes, has each of these words at the start of a word: `[{ word, at }]`. */
function topLevelWords(text, words) {
  const found = [];
  const pattern = new RegExp(`^(?:${words.join('|')})(?![\\p{L}\\p{N}_-])`, 'iu');
  let depth = 0;
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at];
    if (character === '"' || character === '“' || character === '”') quoted = character === '“' ? true : character === '”' ? false : !quoted;
    if (quoted) continue;
    if (/[[{(]/.test(character)) depth += 1;
    else if (/[\]})]/.test(character)) depth = Math.max(0, depth - 1);
    if (depth || (at > 0 && !/[\s,;]/.test(text[at - 1]))) continue;
    const match = pattern.exec(text.slice(at));
    if (match) found.push({ word: match[0], at });
  }
  return found;
}

/** One operation from its name and what was written after it: named parameters, then what the words in front of them say. */
function operationsOf(kind, name, body, names) {
  const mentions = kind === 'assembly' ? occurrencesNamed(body, names?.occurrences) : [];
  const inName = (at) => mentions.some((mention) => at >= mention.start && at < mention.end);
  const keys = topLevelWords(body, PARAMETERS[kind][name].length ? PARAMETERS[kind][name] : ['\\b\\B'])
    .map((key) => ({ ...key, value: /^\s*[:=]\s*/.exec(body.slice(key.at + key.word.length)) }))
    .filter((key) => key.value && key.word === key.word.toLowerCase() && !inName(key.at));
  const operation = { op: name };
  keys.forEach((key, index) => {
    const from = key.at + key.word.length + key.value[0].length;
    operation[key.word] = looseValue(key.word, body.slice(from, keys[index + 1]?.at ?? body.length));
  });
  const lead = body.slice(0, keys[0]?.at ?? body.length).trim();
  const paths = distinct(occurrencesNamed(lead, names?.occurrences).map((mention) => mention.path));
  const fill = (values) => { for (const [key, value] of Object.entries(values)) if (operation[key] == null && value != null) operation[key] = value; };
  if (kind === 'assembly') {
    if (name === 'distance' || name === 'pose') fill({ a: paths[0], b: paths[1] });
    else if (name === 'clearance') fill({ move: paths[0], from: paths[1], ...(paths.length >= 2 || operation.move ? { dir: directionSaid(lead) } : {}) });
    else if (name === 'bounds' && operation.of == null && paths.length > 1) return paths.map((of) => ({ ...operation, of }));
    else if (name === 'bounds') fill({ of: paths[0] });
    else if (name === 'clash') fill(/\b(?:under|inside|within)\b/i.test(lead) ? { under: paths[0] } : { with: paths[0] });
    else if (name === 'count' || name === 'tree') fill({ under: paths[0] });
    else if (name === 'find') fill({ where: /\b[xyz]m(?:in|ax)\s*(?:<=|>=|<|>|=)\s*-?\d+(?:\.\d+)?(?:\s+(?:and|or)\s+[xyz]m(?:in|ax)\s*(?:<=|>=|<|>|=)\s*-?\d+(?:\.\d+)?)*/i.exec(lead)?.[0] });
    else if (name === 'whatif' && operation.move == null) {
      const moves = movesSaid(`move ${lead}`, occurrencesNamed(`move ${lead}`, names?.occurrences));
      if (Object.keys(moves).length) operation.move = moves;
    }
  } else if (kind === 'document') {
    const ids = [...lead.matchAll(new RegExp(String.raw`(?<![\p{L}\p{N}.])(?:${PLACE}\s*)?(${SECTION})(?![\p{L}\p{N}])`, 'gu'))].map((match) => match[1]);
    const quoted = /["“']([^"”']+)["”']/.exec(lead)?.[1];
    if (name === 'refs') fill(/\bbroken\b/i.test(lead) ? { broken: true } : /\bfrom\b/i.test(lead) ? { from: ids[0] } : { to: ids[0] });
    else if (name === 'read') fill({ ids: ids.length ? distinct(ids) : null });
    else if (name === 'terms') fill({ name: quoted ?? (lead.replace(/^(?:of|for|name)\s+/i, '') || null) });
    else if (name === 'affected') fill(quoted ? { term: quoted } : { section: ids[0] });
    else if (name === 'outline') fill({ under: ids[0] });
    else if (name === 'related') fill({ to: ids[0] });
    else if (name === 'whatif') fill(documentEdits(`${lead}`));
  } else if (kind === 'workbook') {
    const reference = /(?:'[^']+'|[\p{L}_][\p{L}\p{N}_.-]*)!\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?/u.exec(lead)?.[0];
    if (name === 'cells') fill({ range: reference });
    else if (name === 'deps') fill({ cell: reference, ...(/\b(?:precedents?|reads?|inputs?)\b/i.test(lead) ? { dir: 'precedents' } : {}) });
    else if (name === 'sql') fill({ q: /^select\b/i.test(lead) ? lead : null });
    else if (name === 'whatif' && operation.set == null && operation.formulas == null) {
      const changed = cellChanges(lead, names);
      if (changed) return [{ ...changed, ...operation }];
    }
  }
  return [operation];
}

/** A string's operations: split at ";" and where one operation's writing ends and the next begins. Null when it is not written as operations. */
function written(kind, text, names) {
  const rest = String(text).trim().replace(/^[\s:,\-–—]+/, '');
  const operations = Object.keys(PARAMETERS[kind]);
  const starts = topLevelWords(rest, [...operations, 'what[- ]if']);
  if (starts[0]?.at !== 0) return null;
  // An operation's name begins a new operation after a closed value, or where one of its own parameters follows it.
  const cuts = starts.filter(({ word, at }) => {
    const name = operationName(kind, word);
    const after = rest.slice(at + word.length);
    if (/^\s*[:=]/.test(after)) return false;
    if (at === 0) return true;
    const last = rest.slice(0, at).trimEnd().at(-1);
    return /[}\]"”;]/.test(last) || (PARAMETERS[kind][name].length > 0 && new RegExp(`^\\s+(?:${PARAMETERS[kind][name].join('|')})\\s*[:=]`).test(after));
  });
  const pieces = cuts.flatMap((cut, index) => rest.slice(cut.at, cuts[index + 1]?.at ?? rest.length).split(/;|\n/).map((piece) => piece.trim()).filter(Boolean));
  const list = [];
  let keyed = false;
  let terse = true;
  for (const piece of pieces) {
    const head = /^(what[- ]if|[a-z]+)\b/i.exec(piece);
    const name = head ? operationName(kind, head[1]) : null;
    if (!name) return null;
    const body = piece.slice(head[0].length).trim();
    const found = operationsOf(kind, name, body, names);
    if (!found.every((operation) => complete(kind, operation))) return null;
    keyed ||= found.some((operation) => Object.keys(operation).some((key) => key !== 'op' && new RegExp(`\\b${key}\\s*[:=]`).test(body)));
    // "clash all", "bounds of Drive unit:1": a name and a word or two. A sentence that starts with an operation's name is not one.
    let words = body;
    for (const mention of occurrencesNamed(body, names?.occurrences).reverse()) words = `${words.slice(0, mention.start)}part${words.slice(mention.end)}`;
    terse &&= words.split(/\s+/).filter(Boolean).length <= 3 && !/[?]/.test(body);
    list.push(...found);
  }
  return list.length && (keyed || terse) ? list : null;
}

/**
 * Operations written loosely, as `[{ op, …params }]`, or null when what was sent is not that: a string after a
 * file's name ("whatif move:{…}; clash all; distance A B"), or an object's `op` or `ops` holding several
 * (`{op: {"whatif move": {…}, clash: "all"}}`, `{ops: [{op: "count"}, "bounds of Motor:1"]}`).
 */
export function operationsWritten(kind, sent, names = null) {
  if (!PARAMETERS[kind]) return null;
  if (typeof sent === 'string') return written(kind, sent, names);
  if (!sent || typeof sent !== 'object') return null;
  const { op, ops } = sent;
  const list = [];
  const entry = (value) => {
    if (typeof value === 'string') return written(kind, value, names);
    const name = value && typeof value === 'object' ? operationName(kind, value.op) : null;
    return name ? [{ ...value, op: name }] : null;
  };
  const several = Array.isArray(ops) ? ops : Array.isArray(op) ? op : null;
  if (several) {
    for (const value of several) { const found = entry(value); if (!found) return null; list.push(...found); }
  } else if (op && typeof op === 'object') {
    // {"whatif move": {…}, clash: "all", distance: [a, b]}: each key an operation, with a parameter's name after it or its value under it.
    for (const [key, value] of Object.entries(op)) {
      const [first, parameter] = key.trim().replace(/^what[- ]if\b/i, 'whatif').split(/\s+/);
      const name = operationName(kind, first);
      if (!name) return null;
      if (parameter) list.push({ op: name, [parameter]: value });
      else if (Array.isArray(value)) {
        const [a, b] = value.map(String);
        const shaped = ['distance', 'pose'].includes(name) ? [{ op: name, a, b }] : name === 'clearance' ? [{ op: name, move: a, from: b }] : name === 'read' ? [{ op: name, ids: value.map(String) }]
          : name === 'bounds' ? value.map((of) => ({ op: name, of: String(of) })) : null;
        if (!shaped) return null;
        list.push(...shaped);
      } else if (value && typeof value === 'object') list.push({ op: name, ...value });
      else list.push(...operationsOf(kind, name, typeof value === 'string' ? value : '', names));
    }
  } else if (typeof op === 'string' && !operationName(kind, op.trim())) {
    // {op: "whatif move:{…}; clash"}: the operations written into the one field.
    const found = written(kind, op, names);
    if (!found) return null;
    list.push(...found);
  } else return null;
  return list.length && list.every((operation) => complete(kind, operation)) ? list : null;
}
