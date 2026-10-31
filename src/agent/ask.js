// What a plain-language ask says, read deterministically: the files, line
// ranges, definitions, revision, disk state, history and folder it names,
// and the words left over to find. An agent can then ask Lasso the way it
// would ask a person ("billing.py lines 300-310 and 900-910", "the
// apply_discount function", "balance of Account 104233", "North division
// revenue before the last change") and get the evidence in one call.
//
// Why one call matters: a task of M model calls costs
//   T = M·F + Σ_{r<M} (M − r)·e_r + O
// for a fixed per-call input F (host prompt, tool definitions, request) and
// the evidence e_r added in round r. Every round Lasso saves removes F and a
// re-reading of everything said so far, so asks are resolved here, not by
// the agent searching, then reading, then asking again.

// Words that shape a question but name nothing to find.
export const STOPWORDS = new Set(`a about above according after again all also am an and any are as at be been before being below
between both but by can could did do does doing done each either every few find for from get give gives given got had has have having
he her here hers him his how i if in into is it its itself just let lets list look many may me might more most much must my need no nor
not now of off on once only or other our out over own please quote same see shall she should show shown so some such tell than that the vs versus
their them then there these they this those through to too under until up us very via was we were what when where which while who whom
why will with within would you your exact exactly value values called named name entire full whole text read give find lookup look
display print say says said mention mentions mentioned state states stated describe describes described explain explains explained talk
talks regarding concerning re according anything something everything currently`.split(/\s+/).filter(Boolean));

// A file name: a path, or a name of two or more characters with an extension
// that starts with a letter ("e.g." and "12.4" are not files).
const FILE = /(?:^|[\s"'`(<[])((?:[\w@+-]+[\\/])*(?:[\w@+-][\w.@+-]*[\w@+-]|[\w@+-]{2,})\.[A-Za-z][A-Za-z0-9]{0,9})(?::(\d{1,7})(?:-(\d{1,7}))?|#L(\d{1,7})(?:-L?(\d{1,7}))?)?(?=$|[\s"'`),;:?!.>\]])/g;
const RANGE_START = /\b(?:lines?|ln|L)\s*#?\s*(?=\d)/gi;
const RANGE = /^\s*(?:,|;|&|\band\b|\bthen\b)?\s*(?:lines?\s*|L)?(\d{1,7})(?:\s*(?:-|–|—|to|through|thru|until|\.\.)\s*(?:lines?\s*|L)?(\d{1,7}))?/i;
const REVISION = /(?:@|\b(?:rev(?:ision)?|commit|hash|version)\s*[:#]?\s*)([0-9a-f]{8,64})\b/i;
const DISK = /\bas (?:it|they|the file|that file|this file|the files) (?:is|are|stands?|reads?|looks?) now\b|\bon disk\b|\bjust (?:been )?(?:edited|changed|modified|saved|rewritten)\b|\bworking copy\b|\bright now\b|\bunsaved\b|\bcurrent (?:file|contents|text) on disk\b/i;
const HISTORY = /\bbefore (?:the |its |that )?(?:last|latest|most recent|recent|previous) (?:change|edit|update|revision|version)\b|\bbefore (?:the |its |it was |that )?(?:change|changed|edit|edited|update|updated)\b|\bhistory\b|\b(?:previous|prior|earlier|old|older|original|former) (?:value|figure|number|version|amount)s?\b|\bused to be\b|\bchanged from\b|\bhistory of\b|\bover time\b|\bwhat (?:was|were) (?:it|they) before\b/i;
const SYMBOL_BEFORE = /\b(?:function|method|class|def|func|fn|struct|interface|enum|trait|procedure|routine|constructor|module|type)\s+[`'"]?([A-Za-z_$][\w$]*)/gi;
const SYMBOL_AFTER = /[`'"]?\b([A-Za-z_$][\w$]*)[`'"]?\s+(?:function|method|class|definition|def|routine|procedure|implementation|constructor)\b/gi;
const CALLED = /\b([A-Za-z_$][\w$]*)\(\)/g;
// "where is start defined", "definition of start": the name is code, however it is spelled.
const DEFINED = /\b(?:where|how) (?:is|are|was) [`'"]?([A-Za-z_$][\w$]*)[`'"]? (?:defined|declared|implemented|written)\b|\b(?:definition|declaration|implementation|source|body) of (?:the )?[`'"]?([A-Za-z_$][\w$]*)/gi;
/** snake_case, camelCase, PascalCase with an inner capital, CONSTANT_CASE: a word only code would spell so. */
export function isIdentifier(word) {
  const value = String(word ?? '');
  if (value.length < 3 || !/^[A-Za-z_$][\w$]*$/.test(value) || !/[A-Za-z]/.test(value)) return false;
  return (/_/.test(value) && /[A-Za-z\d]_[A-Za-z\d]|^_+[A-Za-z]/.test(value))
    || /^[a-z][a-z\d]*[A-Z]/.test(value) || /^[A-Z][a-z\d]+[A-Z]/.test(value);
}
// Words that say what kind of answer is wanted rather than what the source says.
export const ANSWER_WORDS = new Set(['date', 'dates', 'time', 'day', 'when', 'figure', 'figures', 'number', 'amount', 'count', 'value',
  'details', 'info', 'information', 'contents', 'content', 'line', 'lines', 'row', 'entry', 'record', 'field', 'fields', 'data',
  // What a draft is made of, asked for while writing: "the action items of the meeting", "the bracket's dimensions".
  'summary', 'summarise', 'summarize', 'overview', 'points', 'bullet', 'bullets', 'items', 'action', 'actions', 'minutes', 'decisions',
  'highlights', 'takeaways', 'key', 'main', 'email', 'draft', 'write', 'brochure', 'newsletter', 'dimensions', 'dimension', 'size',
  'sizes', 'measurements', 'measurement', 'specs', 'spec', 'specification', 'properties', 'parts', 'components',
  // Sums, rankings and comparisons a model works out from the rows: "total revenue", "the highest months".
  'total', 'totals', 'sum', 'average', 'mean', 'highest', 'lowest', 'top', 'largest', 'smallest', 'biggest', 'most', 'least',
  'best', 'worst', 'strongest', 'weakest', 'full', 'whole', 'entire',
  // How a question points at text rather than what it is about: "find the relevant passage", "the section about".
  'passage', 'passages', 'sentence', 'sentences', 'section', 'sections', 'excerpt', 'excerpts', 'relevant', 'discuss', 'discusses',
  'discussed', 'regarding', 'concerning']);
// Words that say what to do with the evidence ("show the function", "quote the lines you cited earlier").
const INSTRUCTION_WORDS = new Set(['function', 'functions', 'method', 'methods', 'class', 'classes', 'definition', 'definitions', 'defined',
  'declared', 'implementation', 'implemented', 'code', 'source', 'cited', 'cite', 'earlier', 'edited', 'changed', 'line', 'lines', 'file',
  'files', 'folder', 'directory', 'quote', 'exactly', 'show', 'open', 'print', 'output', 'reproduce', 'copy', 'paste', 'snippet', 'block',
  // The kind of file, which says where to look rather than what to find.
  'model', 'models', 'document', 'documents', 'spreadsheet', 'spreadsheets', 'workbook', 'sheet', 'sheets', 'pdf', 'deck', 'presentation']);
const DEFINITION_WORDS = /\b(?:functions?|methods?|class(?:es)?|definitions?|defined|def|implementations?|declared|declarations?|source code|code for|body|signature)\b/i;
const FILE_ONLY_WORDS = new Set(['where', 'file', 'files', 'path', 'paths', 'located', 'location', 'locate', 'which', 'named', 'called',
  'open', 'find', 'show', 'list', 'is', 'are', 'the', 'a', 'an', 'of', 'for', 'there', 'any', 'does', 'exist', 'exists', 'outline',
  'structure', 'contents', 'in']);

const fold = (value) => String(value ?? '').toLowerCase().replace(/[’']s\b/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const QUARTER_MONTHS = { q1: ['january', 'february', 'march'], q2: ['april', 'may', 'june'], q3: ['july', 'august', 'september'],
  q4: ['october', 'november', 'december'] };
// Words that name the same thing in the files people keep: periods as reports and monthly sheets
// write them, and a building model's rooms, which IFC calls spaces. Kept small; each is checked
// against what Lasso indexes, and a hit still needs every other word of the ask.
const SYNONYMS = {
  q1: ['first quarter', ...QUARTER_MONTHS.q1], q2: ['second quarter', ...QUARTER_MONTHS.q2],
  q3: ['third quarter', ...QUARTER_MONTHS.q3], q4: ['fourth quarter', ...QUARTER_MONTHS.q4],
  h1: ['first half', ...QUARTER_MONTHS.q1, ...QUARTER_MONTHS.q2], h2: ['second half', ...QUARTER_MONTHS.q3, ...QUARTER_MONTHS.q4],
  // A quarter's figures are in a monthly sheet's rows: "each quarter of 2025" is answered by its months.
  quarter: ['quarterly', ...Object.values(QUARTER_MONTHS).flat()], quarterly: ['quarter', ...Object.values(QUARTER_MONTHS).flat()],
  // So is a year's: "full year 2025 revenue" in the months of a 2025 sheet.
  year: ['annual', 'yearly', ...Object.values(QUARTER_MONTHS).flat()], annual: ['year', 'yearly', ...Object.values(QUARTER_MONTHS).flat()],
  monthly: ['month'], month: ['monthly'], yearly: ['annual', 'year'],
  room: ['space'], outlook: ['expect', 'guidance', 'forecast'], guidance: ['outlook', 'expect', 'forecast'],
  forecast: ['outlook', 'expect', 'guidance'], headcount: ['employees', 'staff'], employees: ['headcount', 'staff'],
};

/** Month names, folded: the row labels of a monthly sheet. */
export const MONTH_NAMES = new Set(Object.values(QUARTER_MONTHS).flat());

const ORDINALS = { first: 0, second: 1, third: 2, fourth: 3 };
const ORDINAL_WORDS = Object.keys(ORDINALS);
// "Q4", "the fourth quarter", "the last quarter of 2025"; "H1", "the first half".
const QUARTER_NAMED = /\bq([1-4])\b|\b(first|second|third|fourth) quarter\b|\b(?:last|final) quarter of (?:the year|\d{4})\b/g;
const HALF_NAMED = /\bh([12])\b|\b(first|second) half\b|\b(?:last|final) half of (?:the year|\d{4})\b/g;

/**
 * The periods the ask names, each as `{ forms, months }`: both ways reports
 * write it ("q4" and "fourth quarter") and the months it covers. Calendar
 * facts, not synonyms: a board report's "fourth-quarter revenue" is the ask's
 * "Q4 revenue", and a monthly sheet's October to December rows are its Q4.
 */
export function periodsOf(text) {
  const folded = fold(text);
  const quarters = [...folded.matchAll(QUARTER_NAMED)].map((match) => (match[1] ? Number(match[1]) - 1 : match[2] ? ORDINALS[match[2]] : 3));
  const halves = [...folded.matchAll(HALF_NAMED)].map((match) => (match[1] ? Number(match[1]) - 1 : match[2] ? ORDINALS[match[2]] : 1));
  return [...quarters.map((quarter) => ({ forms: [`q${quarter + 1}`, `${ORDINAL_WORDS[quarter]} quarter`], months: Object.values(QUARTER_MONTHS)[quarter] })),
    ...halves.map((half) => ({ forms: [`h${half + 1}`, `${ORDINAL_WORDS[half]} half`], months: Object.values(QUARTER_MONTHS).slice(half * 2, half * 2 + 2).flat() }))];
}

/** The months the periods the ask names cover, applied to a table whose rows are months; null when it names none. */
export function periodMonths(text) {
  const months = periodsOf(text).flatMap((period) => period.months);
  return months.length ? new Set(months) : null;
}

/**
 * A longer word's stem, matched as the start of a word: "delivery" and
 * "delivered" share "deliver", "agreed" and "agreement" share "agre". Words
 * under six letters are matched whole, so "rate" never finds "rated".
 */
export function stemOf(word) {
  if (word.length < 6 || /\d/.test(word)) return null;
  const stem = word.replace(/(?:ations?|ments?|ings?|ies|ied|ers?|ed|es|ery|ly|y|s)$/, '');
  return stem.length >= 4 && stem !== word ? stem : null;
}

/** The forms of a folded word that count as it in the plain scan: its singular or plural, and its synonyms. */
export function alternativesOf(word) {
  const forms = new Set([word]);
  if (/ies$/.test(word)) forms.add(`${word.slice(0, -3)}y`);
  else if (/(?:ses|xes|ches|shes)$/.test(word)) forms.add(word.slice(0, -2));
  else if (/[^s]s$/.test(word) && word.length > 3) forms.add(word.slice(0, -1));
  for (const form of [...forms]) for (const synonym of SYNONYMS[form] ?? []) forms.add(synonym);
  return [...forms];
}

/** The words of a text, possessives dropped: "division's" is "division". */
export function words(value) {
  return [...String(value ?? '').matchAll(/[\p{L}\p{N}]+(?:[-_.'’][\p{L}\p{N}]+)*/gu)]
    .map((match) => match[0].replace(/[’']s$/i, '')).filter(Boolean);
}

/**
 * One ask, or several when the text enumerates them: "Give: (a) X, (b) Y"
 * or "1. X 2. Y". Anything else stays one ask.
 */
export function splitAsk(value) {
  const textValue = String(value ?? '').trim();
  const marks = [...textValue.matchAll(/(?:^|[\s:;,])\(?([a-z]|\d{1,2})[).]\s+/gi)];
  const letters = marks.filter((mark) => /^[a-z]$/i.test(mark[1]));
  const numbers = marks.filter((mark) => /^\d+$/.test(mark[1]));
  const sequence = (list, first) => list.length >= 2 && list.every((mark, index) =>
    (/^\d+$/.test(first) ? Number(mark[1]) === index + 1 : mark[1].toLowerCase().charCodeAt(0) === 97 + index));
  const enumerated = sequence(letters, 'a') ? letters : sequence(numbers, '1') ? numbers : null;
  if (!enumerated) return [textValue];
  const lead = textValue.slice(0, enumerated[0].index).replace(/[\s:;,-]+$/, '');
  const parts = enumerated.map((mark, index) => {
    const start = mark.index + mark[0].length;
    const end = index + 1 < enumerated.length ? enumerated[index + 1].index : textValue.length;
    return textValue.slice(start, end).replace(/^[\s,;:]+|[\s,;.]+$/g, '').replace(/\s*,?\s*(?:and|&)$/i, '');
  }).filter((part) => words(part).length);
  // "Give: (a) …" keeps no lead; "For the South division: (a) revenue, (b) headcount" carries its subject into each part.
  const carried = lead && !/^(?:give|show|find|list|get|tell me|what (?:are|is)|return|provide)\b[\s:]*$/i.test(lead) ? `${lead} ` : '';
  return parts.length >= 2 ? parts.map((part) => `${carried}${part}`.trim()) : [textValue];
}

function rangesAfter(textValue, from) {
  const ranges = [];
  let rest = textValue.slice(from);
  let consumed = from;
  for (;;) {
    const match = rest.match(RANGE);
    if (!match) break;
    const first = Number(match[1]);
    const last = match[2] == null ? first : Number(match[2]);
    if (first >= 1 && last >= first) ranges.push([first, last]);
    rest = rest.slice(match[0].length);
    consumed += match[0].length;
    // A range list stops at anything but a separator and another number.
    if (!/^\s*(?:,|;|&|\band\b|\bthen\b)\s*(?:lines?\s*)?\d/i.test(rest)) break;
  }
  return { ranges, end: consumed };
}

/**
 * The structure of one ask. `folders` are the shared folders' names, so
 * "in the Admin folder" can be read as one.
 */
export function parseAsk(value, folders = []) {
  const original = String(value ?? '').trim();
  let rest = original;
  const take = (pattern) => {
    const match = rest.match(pattern);
    if (match) rest = `${rest.slice(0, match.index)} ${rest.slice(match.index + match[0].length)}`;
    return match;
  };

  const revision = take(REVISION)?.[1]?.toLowerCase() ?? null;
  const disk = Boolean(take(DISK));
  const history = Boolean(take(HISTORY));

  let folder = null;
  for (const name of [...folders].sort((left, right) => right.length - left.length)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b(?:in|from|under|within|inside)\\s+(?:the\\s+)?${escaped}(?:\\s+(?:folder|directory|project|repo|repository|workspace))?\\b|\\b${escaped}\\s+(?:folder|directory|project|repo|repository)\\b`, 'i');
    if (take(pattern)) { folder = name; break; }
  }

  const files = [];
  const ranges = [];
  // Quoted names may hold spaces: "Operating budget.xlsx".
  for (const match of rest.matchAll(/["'`“‘]([^"'`”’\n]{1,200}\.[A-Za-z][A-Za-z0-9]{0,9})["'`”’]/g)) {
    if (/\s/.test(match[1])) files.push({ name: match[1].trim(), before: [], ranges: [] });
  }
  const listed = [];
  for (const match of rest.matchAll(FILE)) {
    const name = match[1].replaceAll('\\', '/');
    if (files.some((file) => file.name.endsWith(name))) continue;
    const first = match[2] ?? match[4];
    const last = match[3] ?? match[5];
    // The words just before a name, for a name with spaces written unquoted ("Operating budget.xlsx").
    const before = words(rest.slice(Math.max(0, match.index - 60), match.index + (match[0].length - match[0].trimStart().length))).slice(-3);
    const fileRanges = first ? [[Number(first), Number(last ?? first)]] : [];
    // "billing.py:300-310,900-910": the ranges listed after the first.
    const after = match.index + match[0].length;
    if (first && /^\s*(?:,|;|&|\band\b)\s*(?:lines?\s*|L)?\d/i.test(rest.slice(after))) {
      const { ranges: more, end } = rangesAfter(rest, after);
      fileRanges.push(...more);
      listed.push([after, end]);
    }
    files.push({ name, before, ranges: fileRanges });
  }
  for (const [from, to] of listed.reverse()) rest = `${rest.slice(0, from)}${' '.repeat(to - from)}${rest.slice(to)}`;
  for (const file of files) rest = rest.replace(new RegExp(`["'\`“‘]?${file.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?::\\d+(?:-\\d+)?|#L\\d+(?:-L?\\d+)?)?["'\`”’]?`, 'g'), ' ');

  let consumed = 0;
  for (const start of [...rest.matchAll(RANGE_START)]) {
    // "L12-L30" is one range; its second "L" does not start another.
    if (start.index < consumed) continue;
    const { ranges: found, end } = rangesAfter(rest, start.index + start[0].length);
    ranges.push(...found);
    consumed = end;
  }
  if (ranges.length) {
    rest = rest.replace(/\b(?:lines?|ln|L)\s*#?\s*\d{1,7}(?:\s*(?:-|–|—|to|through|thru|until|\.\.)\s*(?:lines?\s*)?\d{1,7})?(?:\s*(?:,|;|&|\band\b|\bthen\b)\s*(?:lines?\s*)?\d{1,7}(?:\s*(?:-|–|—|to|through|thru|until|\.\.)\s*\d{1,7})?)*/gi, ' ');
  }

  const symbols = new Set();
  for (const pattern of [SYMBOL_BEFORE, SYMBOL_AFTER, CALLED, DEFINED]) {
    for (const match of rest.matchAll(pattern)) {
      const name = match[1] ?? match[2];
      if (name && !STOPWORDS.has(name.toLowerCase()) && name.length >= 2 && !/^\d/.test(name)) symbols.add(name);
    }
  }
  const identifiers = [...new Set(words(rest).filter(isIdentifier))];
  // Code-shaped names asked about as definitions ("show normalize_sku, retry_payment and registerRoutes"),
  // or an ask that is nothing but such names.
  if (identifiers.length && (DEFINITION_WORDS.test(rest)
    || words(rest).every((word) => isIdentifier(word) || STOPWORDS.has(word.toLowerCase())))) {
    for (const name of identifiers) symbols.add(name);
  }

  const remaining = words(rest);
  const content = remaining.filter((word) => !STOPWORDS.has(word.toLowerCase()) && !INSTRUCTION_WORDS.has(word.toLowerCase())
    && !symbols.has(word));
  // Free ranges ("lines 5-12 of app.py") belong to the one file named, if one is.
  if (ranges.length && files.length === 1) files[0].ranges = dedupe([...files[0].ranges, ...ranges]);
  const allRanges = dedupe([...ranges, ...files.flatMap((file) => file.ranges)]);
  const fileOnly = files.length > 0 && !allRanges.length && !symbols.size
    && remaining.every((word) => FILE_ONLY_WORDS.has(word.toLowerCase()) || STOPWORDS.has(word.toLowerCase()));
  return { original, files, ranges: allRanges, symbols: [...symbols], identifiers, revision, disk, history, folder, words: remaining,
    content, fileOnly };
}

function dedupe(ranges) {
  const seen = new Set();
  return ranges.filter(([first, last]) => !seen.has(`${first}-${last}`) && seen.add(`${first}-${last}`));
}

/** Whether a header (a column name) is named in the ask's words, as a phrase. */
export function namesHeader(askFolded, header) {
  const wanted = fold(header);
  if (!wanted || wanted.length < 2) return false;
  const pattern = new RegExp(`(?:^| )${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?(?= |$)`);
  return pattern.test(askFolded);
}

export { fold };
