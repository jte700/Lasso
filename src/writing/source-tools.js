// What an AI writer looks things up with: Lasso's own search over the
// switched-on folders (or the one chosen with ⌥Tab), and a file's rows or
// passages. Every value and passage it is shown gets a number, and the
// writer cites what it uses by that number, so each cited phrase can be
// linked to the indexed object it came from. Nothing here reads a file from
// disk or asks a model: it is the index, worded for a reader.

import { isTextPassage } from '../dependencies/object-descriptors.js';
import { wordTokens } from '../dependencies/text-similarity.js';
import { distinctRanked, tag } from '../workspace-ranking.js';

// Questions answered in one call, and matches read for each.
const QUERIES_PER_CALL = 4;
const HITS_PER_QUERY = 24;
// Numbered lines one search may add, and one opened file.
const LINES_PER_SEARCH = 80;
const LINES_PER_FILE = 60;
const LINES_PER_OPEN = 160;
// A whole document found by its name shows this many of its passages.
const PASSAGES_PER_DOCUMENT = 12;
// Objects read back for one file of a folder kept as a search index.
const OBJECTS_PER_INDEXED_FILE = 4000;
const LONGEST_PASSAGE = 600;
const LONGEST_VALUE = 240;
// Words of a prompt that say what to do, not what it is about.
const REQUEST_WORDS = new Set(['write', 'draft', 'compose', 'message', 'email', 'mail', 'letter', 'note', 'reply', 'respond', 'paragraph',
  'sentence', 'sentences', 'summary', 'summarize', 'summarise', 'summarizing', 'summarising', 'detailing', 'detail', 'details', 'describe',
  'describing', 'explain', 'explaining', 'short', 'brief', 'quick', 'please', 'give', 'make', 'create', 'list', 'bullet', 'bullets', 'points',
  'tell', 'what', 'which', 'how', 'when', 'where', 'who', 'why', 'one', 'two', 'three', 'all', 'everything', 'overview', 'update']);

const isCell = (object) => object.anchor?.kind === 'table-cell';
const isRow = (object) => object.objectType === 'DATASET_ROW';
const isColumn = (object) => object.anchor?.kind === 'table-column';
const isWholeTable = (object) => object.objectType === 'DATASET';
const isWholeDocument = (object) => ['DOCUMENT', 'PAPER'].includes(object.objectType) && !isTextPassage(object);
// What a writer can cite: something with words or a value of its own. A
// table's row count is Lasso's own summary, not something the file says.
const isEvidence = (object) => isCell(object) || isTextPassage(object)
  || (!isRow(object) && !isColumn(object) && !isWholeTable(object) && !isWholeDocument(object)
    && object.anchor?.kind !== 'table-summary' && String(object.valueText ?? '').trim() !== '');

const clip = (value, length) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
};

const place = (object) => {
  const anchor = object.anchor ?? {};
  const metadata = object.metadata ?? {};
  return [anchor.sheet ?? metadata.sheet ?? '', anchor.pageNumber ?? metadata.pageNumber ?? 0, anchor.slideNumber ?? 0,
    anchor.rowIndex ?? 0, anchor.columnIndex ?? 0, anchor.start ?? anchor.lineStart ?? 0];
};

// A file's objects in reading order: sheet, page, slide, row, column, then where the words start.
function inReadingOrder(objects) {
  return objects.map((object) => ({ object, at: place(object) })).sort((left, right) => {
    for (let index = 0; index < left.at.length; index += 1) {
      const a = left.at[index];
      const b = right.at[index];
      if (a !== b) return typeof a === 'string' || typeof b === 'string' ? String(a).localeCompare(String(b)) : a - b;
    }
    return 0;
  }).map(({ object }) => object);
}

function line(number, object) {
  if (isCell(object)) return `[${number}] ${clip(object.label, 120)}: ${clip(object.valueText, LONGEST_VALUE)}`;
  if (isTextPassage(object)) {
    const page = object.anchor?.pageNumber ?? object.metadata?.pageNumber;
    return `[${number}] ${page ? `(p. ${page}) ` : ''}${clip(object.valueText ?? object.label, LONGEST_PASSAGE)}`;
  }
  const value = clip(object.valueText, LONGEST_VALUE);
  const label = clip(object.label, 120);
  return `[${number}] ${label && label !== value ? `${label}: ` : ''}${value}`;
}

/** The sources of one piece of writing: what the writer was shown, by number. */
export class WritingSources {
  /** `onlyProjectId` is the folder chosen with ⌥Tab, or null for every switched-on folder. */
  constructor({ workspace, dependencies, onlyProjectId = null }) {
    this.workspace = workspace;
    this.dependencies = dependencies;
    this.projects = workspace.activeProjects().filter((project) => !onlyProjectId || project.id === onlyProjectId);
    this.numbered = [];
    this.numbers = new Map();
    this.files = new Map();
  }

  /** The object the writer was shown as `number`, as the apps link a cited phrase to it; null for a number never shown. */
  source(number) {
    const object = this.numbered[number - 1];
    if (!object) return null;
    const { sheet, pageNumber, rowKey, entityName } = object.metadata ?? {};
    return { id: object.id, projectId: object.projectId, projectName: object.projectName, versionId: object.versionId,
      snapshotId: object.snapshotId, path: object.path, label: object.label, valueText: object.valueText ?? null,
      objectType: object.objectType, anchor: object.anchor ?? null, metadata: { sheet, pageNumber, rowKey, entityName } };
  }

  numberOf(object) {
    let number = this.numbers.get(object.id);
    if (!number) {
      this.numbered.push(object);
      number = this.numbered.length;
      this.numbers.set(object.id, number);
    }
    return number;
  }

  /** Everything indexed of one file, in reading order. */
  fileObjects(projectId, filePath) {
    const key = `${projectId}\n${filePath}`;
    let objects = this.files.get(key);
    if (!objects) {
      const project = this.projects.find((candidate) => candidate.id === projectId);
      const index = this.dependencies.searchIndexFor(projectId);
      let found;
      if (index) {
        const pathId = index.pathIds.get(filePath);
        const positions = [];
        for (let position = 0; position < index.count && positions.length < OBJECTS_PER_INDEXED_FILE; position += 1) {
          if (index.pathOf[position] === pathId) positions.push(position);
        }
        found = this.dependencies.indexedObjectsAt(index, positions);
      } else {
        found = this.dependencies.objectsAt(projectId).filter((object) => object.path === filePath);
      }
      objects = inReadingOrder(found.map((object) => tag(object, project)));
      this.files.set(key, objects);
    }
    return objects;
  }

  /** A folder's objects that share the query's words, best first. */
  matches(project, query) {
    const index = this.dependencies.searchIndexFor(project.id);
    if (!index) {
      return this.dependencies.search(project.id, query, { limit: HITS_PER_QUERY, diversify: false, enrich: false });
    }
    // A folder too large to hold is searched in its index, and only what it finds is read.
    const words = wordTokens(query);
    if (!words.length) return [];
    const shared = new Uint8Array(index.count);
    for (const word of words) for (const position of index.text.get(word)) shared[position] += 1;
    // A file's name is kept once, with its path, and counts for everything in the file.
    const named = new Map();
    index.pathWords.forEach((pathWords, pathId) => {
      const count = words.filter((word) => pathWords.includes(word)).length;
      if (count) named.set(pathId, count);
    });
    const found = [];
    for (let position = 0; position < index.count; position += 1) {
      const count = shared[position] + (named.get(index.pathOf[position]) ?? 0);
      if (count) found.push([position, count]);
    }
    found.sort((left, right) => right[1] - left[1] || left[0] - right[0]);
    const best = found.slice(0, HITS_PER_QUERY);
    return this.dependencies.indexedObjectsAt(index, best.map(([position]) => position))
      .map((object, at) => ({ ...object, score: Math.min(1, best[at][1] / words.length) }));
  }

  /** What a match stands for as evidence: itself, its row's or column's cells, or its file's first rows or passages. */
  evidenceOf(hit) {
    if (isEvidence(hit)) return [hit];
    const inFile = this.fileObjects(hit.projectId, hit.path);
    const sheet = hit.anchor?.sheet ?? hit.metadata?.sheet ?? null;
    const sameSheet = (object) => (object.anchor?.sheet ?? null) === sheet;
    if (isRow(hit)) return inFile.filter((object) => isCell(object) && sameSheet(object) && object.anchor.rowIndex === hit.anchor?.rowIndex);
    if (isColumn(hit)) return inFile.filter((object) => isCell(object) && sameSheet(object) && object.anchor.columnIndex === hit.anchor?.columnIndex);
    if (isWholeTable(hit)) return inFile.filter((object) => isCell(object) && (sheet === null || sameSheet(object)));
    if (isWholeDocument(hit)) return inFile.filter(isTextPassage).slice(0, PASSAGES_PER_DOCUMENT);
    return [];
  }

  /** The numbered lines of `objects`, under the name of each file they are in. */
  render(objects) {
    const byFile = new Map();
    for (const object of objects) {
      const key = `${object.projectId}\n${object.path}`;
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key).push(object);
    }
    const severalFolders = this.projects.length > 1;
    return [...byFile.values()].map((inFile) => {
      const first = inFile[0];
      const heading = `${first.path}${severalFolders ? ` (in ${first.projectName})` : ''}`;
      return [heading, ...inFile.map((object) => line(this.numberOf(object), object))].join('\n');
    }).join('\n\n');
  }

  /** One query's matching values and passages, numbered: the text the writer reads, and how many lines it has. */
  searchOne(query) {
    const hits = distinctRanked(this.projects.flatMap((project) => this.matches(project, query)
      .map((object) => tag(object, project))), HITS_PER_QUERY);
    const chosen = [];
    const seen = new Set();
    const perFile = new Map();
    let left = 0;
    for (const hit of hits) {
      for (const object of this.evidenceOf(hit)) {
        if (seen.has(object.id)) continue;
        const key = `${object.projectId}\n${object.path}`;
        if (chosen.length >= LINES_PER_SEARCH || (perFile.get(key) ?? 0) >= LINES_PER_FILE) { left += 1; continue; }
        seen.add(object.id);
        perFile.set(key, (perFile.get(key) ?? 0) + 1);
        chosen.push(object);
      }
    }
    if (!chosen.length) return { found: 0, text: `"${query}": nothing found. Try other words, or fewer.` };
    // A file's lines read in its own order, whichever of them matched first.
    const ordered = [...new Set(chosen.map((object) => `${object.projectId}\n${object.path}`))]
      .flatMap((key) => inReadingOrder(chosen.filter((object) => `${object.projectId}\n${object.path}` === key)));
    const more = left ? `\n\n${left} more not shown: open a file by one of its numbers, or search with more exact words.` : '';
    return { found: chosen.length, text: `"${query}":\n\n${this.render(ordered)}${more}` };
  }

  /** Answers the writer's search: for each query, the matching values and passages, numbered. */
  search(queries) {
    const asked = (Array.isArray(queries) ? queries : [queries]).map((query) => String(query ?? '').trim())
      .filter(Boolean).slice(0, QUERIES_PER_CALL);
    if (!asked.length) return 'Give one or more queries: a few plain words each.';
    if (!this.projects.length) return 'No folder is switched on in Lasso, so there is nothing to search.';
    return asked.map((query) => this.searchOne(query).text).join('\n\n———\n\n');
  }

  /**
   * What Lasso finds for the prompt's own words, before the writer has asked
   * for anything: the subject of "Write a message detailing the budget" is
   * "budget". With this in hand the writer often needs no search of its own,
   * which saves a round with the model. Null when the prompt names nothing found.
   */
  firstSearch(prompt) {
    const words = wordTokens(prompt).filter((word) => !REQUEST_WORDS.has(word)).slice(0, 6);
    if (!words.length || !this.projects.length) return null;
    const query = words.join(' ');
    const answer = this.searchOne(query);
    return answer.found ? { query, text: answer.text } : null;
  }

  /** The file a numbered source is in, as rows of values or passages in order. */
  open(number) {
    const known = this.numbered[Number(number) - 1];
    if (!known) return `No source [${number}] has been shown. Search first.`;
    const evidence = this.fileObjects(known.projectId, known.path).filter(isEvidence);
    const shown = evidence.slice(0, LINES_PER_OPEN);
    const more = evidence.length > shown.length
      ? `\n\n${evidence.length - shown.length} more not shown: search for a row, column or phrase to find them.` : '';
    return `${this.render(shown)}${more}`;
  }
}

/** The tools a writer is given, as an AI host declares them. */
export const WRITING_TOOLS = [
  {
    name: 'lasso_search',
    description: 'Search the user\'s own files (spreadsheets, documents, PDFs, slides, code) through Lasso. Give one to four queries of a few '
      + 'plain words each, such as "budget", "travel costs" or "steering group". Returns matching values and passages, each with a number '
      + 'to cite it by. A file found by its name comes back with its rows or first passages.',
    inputSchema: { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } }, required: ['queries'],
      additionalProperties: false },
  },
  {
    name: 'lasso_open',
    description: 'Read more of the file a numbered source is in: a table\'s rows of values, or a document\'s passages in order.',
    inputSchema: { type: 'object', properties: { source: { type: 'integer' } }, required: ['source'], additionalProperties: false },
  },
];
