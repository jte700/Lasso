// The evidence service AI agents reach Lasso through, over MCP or the local
// REST API alike. It owns no index of its own: it reads the same snapshots,
// object versions and search graph the editor and terminal read, and adds
// what an agent needs that a person at a popup does not.
//
//  - suggest: candidates for several requests at once, with the evidence to
//    tell them apart, shared source details sent once per response, explicit
//    coverage (how many matched, whether more remain, which folders lag), and
//    a short handle per candidate. Lasso never picks a candidate.
//  - inspect: exact lines of a file revision, a symbol's block, the context
//    around a handle, or its history, without searching again.
//  - bind: records which evidence the agent chose for which field, checks
//    explicit consistency constraints, and inserts the recorded literals into
//    a template so a value is never copied by hand.
//
// Every answer comes from a pinned, indexed snapshot of each folder. A handle
// names one immutable version; later captures never move it. Disk state is
// reported, never silently substituted.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BoundedCache } from '../cache.js';
import { transaction } from '../db.js';
import { hashBuffer } from '../history/blob-store.js';
import { isCodeType, isTextualType } from '../history/file-types.js';
import { fileLines } from '../dependencies/code-lines.js';
import { isWholeFile } from '../dependencies/file-reference.js';
import { isPassage } from '../terminal/graph.js';
import { sourceLocator } from '../terminal/names.js';
import { distinctRanked } from '../workspace.js';
import { normalizedRowSearch } from '../dependencies/row-names.js';
import { AgentError } from './errors.js';
import { alternativesOf, ANSWER_WORDS, fold as foldAsk, MONTH_NAMES, namesHeader, parseAsk, periodMonths, periodsOf, splitAsk, stemOf, STOPWORDS, words as askWords } from './ask.js';
import { estimateTokens } from './metrics.js';
import { TextIndex } from './text-index.js';
import { hasWord, readingOrder, selectEvidence } from './select.js';
import { extractDocxHeadings, extractPdfPassages } from '../dependencies/document-extraction.js';
import { readStepModel } from '../dependencies/step-model.js';
import { instancesOf, namedInstances, relationOf } from './geometry.js';
import { StructuralAdapterError } from './structural/adapters.js';

const MAX_QUERIES = 16;
const MAX_ASKS = 16;
// Passages and values shown whole in an answer, up to this many characters.
const ANSWER_CHARS = 1200;
// A small text file named in an ask with nothing else matched is shown whole, up to this size.
const WHOLE_FILE_CHARS = 6000;
// The opening lines of a large file that is not code: a table's header and first rows.
const HEAD_LINES = 12;
// Row labels listed beside an absence ("North division" for "West division"), before only their number is given.
const MAX_LABELS = 12;
// What one answer shows of a file that is its subject: a table's first rows, a document's passages
// or a model's parts, in about this many characters, the rest counted.
const DIGEST_ROWS = 60;
// A matched row is shown whole when its table has at most this many columns.
const WHOLE_ROW_COLUMNS = 8;
const DIGEST_CHARS = 3000;
// The tokens of evidence one ask returns by default; `budget` asks for more or less.
const ASK_BUDGET = 700;
// How long one ask may spend bringing the full-text index up to date before the plain scan answers instead.
const SYNC_BUDGET_MS = 1500;
// Matching rows of one table shown in a search answer, the rest counted.
const SEARCH_TABLE_ROWS = 12;
// A search reads files scoring at least this share of the best file's score, and shows sentences scoring at least this
// share of the best sentence's: below them, matches are counted as left out rather than shown.
const FILE_SHARE = 0.6;
const SENTENCE_SHARE = 0.2;
const ELEMENT_PROPERTIES = 6;
// How many matching files one found-answer shows, and passages of each.
const FOUND_FILES = 4;
const PASSAGES_PER_FILE = 3;
// A model's measurements in the order people ask for them: a room's floor area before its ceiling
// finish, a part's overall size and holes before each edge.
const PROPERTY_ORDER = [/net floor area/i, /gross floor area/i, /floor area/i, /\barea\b/i, /volume/i, /\bheight\b/i,
  /overall .*extent/i, /diameter/i, /depth/i, /radius/i, /width/i, /length/i];
const propertyRank = (label) => {
  const index = PROPERTY_ORDER.findIndex((pattern) => pattern.test(label));
  return index < 0 ? PROPERTY_ORDER.length : index;
};
// Objects that stand for a whole file: they say a file matched, not where in it.
const isWholeFileObject = (object) => !object?.anchor?.kind || ['cad-model', 'table-summary', 'table-column'].includes(object.anchor.kind);
// What makes an object ask an explicit search rather than a question.
const SEARCH_KEYS = ['fields', 'kind', 'under', 'ext', 'cursor', 'limit'];
// A file-only ask about where a file is, rather than what is in it.
const LOCATE = /\b(?:where|which|locate|located|location|path|paths|exists?|list|named|called)\b/i;
const STEP_FILE = /\.(?:step|stp)$/i;
// An instance named the way assemblies name them: "Pin:2", "Pin #2", "pin 2".
const INSTANCE_LIKE = /\p{L}[\p{L}\p{N}_.-]*\s*[:#]?\s*\d+\b/u;
// Words after which the instance named is the one the other is seen from: "Pin:2 relative to Pin:1".
const SEEN_FROM = /\b(?:relative to|with respect to|from|seen from|in the frame of|wrt)\b/;
const GEOMETRY_OPS = { pose: 'pose', relative_transform: 'pose', relation: 'pose', angle: 'angle', axis_angle: 'angle' };
// How many instances an assembly's digest places; the rest are counted.
const DIGEST_INSTANCES = 12;
// An assembly larger than this is read only when the ask names its file.
const UNNAMED_STEP_BYTES = 8 * 1024 * 1024;
// Five candidates cost about 30% fewer tokens than eight where more match; coverage reports the rest.
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;
// Matches ranked per query before paging. Past this a query reports itself capped.
const SEARCH_CAP = 400;
const DEFAULT_BUDGET = 4000;
const DEFAULT_VALUE_CHARS = 400;
const MAX_ITEMS = 24;
const MAX_LINES = 1500;
const MAX_FIELDS = 16;
const MAX_BINDINGS = 64;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const OUTLINE_LIMIT = 200;
// Rows read from each large table's own row index per query.
const LARGE_TABLE_ROWS = 25;
// Columns shown for a large-table row when the query named no fields.
const ROW_PREVIEW_COLUMNS = 12;
const BLOCK_LIMIT = 400;
const HANDLE_LIFETIME_DAYS = 180;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const HANDLE = /^[0-9A-HJKMNP-TV-Z]{10}$/;
const FIELD_NAME = /^[A-Za-z0-9_.-]{1,80}$/;
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]{1,80})\s*\}\}/g;
const KINDS = new Set(['any', 'file', 'code', 'value', 'passage']);

const sha = (value) => crypto.createHash('sha256').update(String(value)).digest();
const rev = (contentHash) => String(contentHash ?? '').slice(0, 12);
const now = () => new Date().toISOString();
const fold = (value) => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function base32(bytes, length) {
  let bits = 0, value = 0, output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < length) {
      output += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (output.length >= length) break;
  }
  return output;
}

/** A short, deterministic handle: the same evidence gets the same handle in every call. */
function handleOf(ref) {
  const identity = ref.objectId ? `o|${ref.objectId}|${ref.versionId}`
    : ref.cell ? `c|${ref.projectFileId}|${ref.contentHash}|${ref.cell.sheet ?? ''}|${ref.cell.row}|${ref.cell.column}`
      : `l|${ref.projectFileId}|${ref.contentHash}|${ref.lineStart ?? ''}-${ref.lineEnd ?? ''}`;
  return base32(sha(identity), 10);
}

// ── request validation ─────────────────────────────────────────────────────

function invalid(message, details) { return new AgentError('invalid_request', message, details); }

function text(value, name, { max = 500, optional = true } = {}) {
  if (value == null || value === '') {
    if (optional) return null;
    throw invalid(`${name} is required.`);
  }
  if (typeof value !== 'string') throw invalid(`${name} must be a string.`);
  if (value.length > max || /[\u0000]/.test(value)) throw invalid(`${name} must be at most ${max} characters.`);
  const trimmed = value.trim();
  if (!trimmed && !optional) throw invalid(`${name} is required.`);
  return trimmed || null;
}

/**
 * A tuning number (a limit, a budget, lines of context). One out of range is
 * brought into it rather than refused: live runs showed a refused budget
 * costs the agent a whole turn and sends it back to grep, and no answer is
 * wrong for having been given 200 tokens instead of 150.
 */
function count(value, name, { min = 1, max, fallback }) {
  if (value == null) return fallback;
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) throw invalid(`${name} must be a number.`);
  return Math.min(max, Math.max(min, Math.round(number)));
}

function names(value, name, max) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 120)) {
    throw invalid(`${name} must be a list of up to ${max} names.`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

/** "5-12", "5", "5:12", [5, 12] or { start, end } as [first, last], both included. */
export function parseLineRange(value) {
  let first, last;
  if (Array.isArray(value)) [first, last = value[0]] = value;
  else if (value && typeof value === 'object') ({ start: first, end: last = value.start } = value);
  else if (typeof value === 'number') first = last = value;
  else if (typeof value === 'string') {
    const match = value.trim().match(/^(?:lines?\s*)?(\d{1,7})(?:\s*(?:-|–|—|:|\.\.|to|through)\s*(\d{1,7}))?$/i);
    if (!match) throw invalid('lines must look like "5-12" or "42".');
    first = Number(match[1]);
    last = match[2] == null ? first : Number(match[2]);
  } else throw invalid('lines must look like "5-12" or "42".');
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first) {
    throw invalid('lines must name a range whose first line is at least 1 and not after its last.');
  }
  return [first, last];
}

/** A folder-relative path an agent typed, or null when it reaches outside every folder. */
function relativeName(value) {
  const name = String(value).replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (!name || name.split('/').includes('..') || /[\u0000]/.test(name)) return null;
  return name;
}

// ── projection ─────────────────────────────────────────────────────────────

function evidenceType(object) {
  if (isPassage(object)) return 'passage';
  const kind = object.anchor?.kind;
  if (kind === 'line-range' || kind === 'line' || ['CODE_LINE', 'METHOD'].includes(object.objectType)) return 'code';
  if (isWholeFile(object)) return 'file';
  if (kind === 'table-cell') return 'cell';
  if (kind === 'table-row') return 'row';
  if (kind === 'table-column') return 'column';
  return String(object.objectType ?? 'object').toLowerCase();
}

function locatorOf(object) {
  const anchor = object.anchor ?? {};
  if (anchor.kind === 'pdf-excerpt') return Number.isInteger(anchor.pageNumber) ? `p.${anchor.pageNumber}` : '';
  // A Word document's passages are cited on its text a paragraph per line, with a blank line between.
  if (anchor.kind === 'text-excerpt' && Number.isInteger(anchor.lineStart) && object.metadata?.format === 'DOCUMENT') {
    const [first, last] = [anchor.lineStart, anchor.lineEnd].map((line) => (line + 1) / 2);
    return first === last ? `para ${first}` : `paras ${first}-${last}`;
  }
  if (anchor.kind === 'text-excerpt' && Number.isInteger(anchor.lineStart)) {
    return anchor.lineStart === anchor.lineEnd ? `line ${anchor.lineStart}` : `lines ${anchor.lineStart}-${anchor.lineEnd}`;
  }
  if (anchor.kind === 'line-range') return `lines ${anchor.lineStart}-${anchor.lineEnd}`;
  if (anchor.kind === 'line') return `line ${anchor.line}`;
  return sourceLocator(object);
}

/** Labels that tell same-valued candidates apart: sheet, row, column, section, unit, title. */
function qualifiers(object, label = null) {
  const metadata = object.metadata ?? {};
  const anchor = object.anchor ?? {};
  const row = anchor.rowKey ?? metadata.row;
  const context = {
    sheet: metadata.sheet ?? anchor.sheet ?? null,
    row: row != null && !/^row:\d+$/.test(String(row)) ? String(row) : null,
    col: anchor.column ?? metadata.column ?? null,
    section: metadata.section ?? metadata.slideTitle ?? null,
    unit: metadata.units ?? metadata.unit ?? null,
    title: metadata.parentTitle ?? null,
  };
  // What the label already says is not sent twice.
  const said = String(label ?? '');
  return Object.fromEntries(Object.entries(context).filter(([, value]) => value != null && value !== ''
    && !said.includes(String(value))));
}

function clipped(value, maxChars) {
  if (value == null) return { value: null };
  const literal = String(value);
  return literal.length > maxChars ? { value: `${literal.slice(0, maxChars)}…`, trunc: true } : { value: literal };
}

const MATCHES = { exact: 'exact name', value: 'exact value', identifier: 'exact identifier', sourceName: 'exact name',
  source: 'in named file', prefix: 'name prefix', contains: 'name contains', relevance: 'terms', context: 'context', all: 'listing' };

// ── code structure, without a parser per language ───────────────────────────

const DEFINITION = new RegExp(String.raw`^(\s*)(?:(?:export|default|public|private|protected|internal|static|async|abstract|final|override|pub(?:\([^)]*\))?|unsafe|extern|inline|virtual|open|sealed|suspend|partial)\s+)*`
  + String.raw`(?:def|class|function\*?|func(?:\s*\([^)]*\))?|fn|interface|struct|enum|trait|impl|type|module|protocol|record|sub|proc|macro)\s+([A-Za-z_$][\w$]*)`);
const BOUND_FUNCTION = /^(\s*)(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/;
const METHOD = /^(\s+)(?:(?:public|private|protected|static|async|get|set|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/;
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'function', 'else']);

/** Definitions in a file's lines: [{ line, name, indent }]. */
export function definitions(lines) {
  const found = [];
  lines.forEach((line, index) => {
    if (line.length > 400) return;
    const match = line.match(DEFINITION) ?? line.match(BOUND_FUNCTION);
    const method = !match && line.match(METHOD);
    const hit = match ?? (method && !NOT_METHODS.has(method[2]) ? method : null);
    if (hit) found.push({ line: index + 1, name: hit[2], indent: hit[1].replace(/\t/g, '    ').length });
  });
  return found;
}

const indentOf = (line) => line.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;

/** The lines of the block a definition opens: braces where it uses them, indentation otherwise. */
export function blockRange(lines, definition) {
  let start = definition.line;
  while (start > 1 && /^\s*@/.test(lines[start - 2])) start -= 1;
  const first = definition.line - 1;
  const opener = lines.slice(first, first + 4).findIndex((line) => /\{/.test(line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '')));
  const colon = /:\s*(?:#.*)?$/.test(lines[first]);
  let end = first;
  if (opener >= 0 && !colon) {
    let depth = 0;
    let opened = false;
    for (let index = first; index < lines.length && index < first + BLOCK_LIMIT; index += 1) {
      const code = lines[index].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '').replace(/\/\/.*$/, '');
      for (const character of code) {
        if (character === '{') { depth += 1; opened = true; }
        else if (character === '}') depth -= 1;
      }
      end = index;
      if (opened && depth <= 0) break;
    }
  } else {
    for (let index = first + 1; index < lines.length && index < first + BLOCK_LIMIT; index += 1) {
      if (!lines[index].trim()) continue;
      if (indentOf(lines[index]) <= definition.indent) {
        // A closing `end` (Ruby, Lua) belongs to the block it closes.
        if (/^\s*end\b/.test(lines[index])) end = index;
        break;
      }
      end = index;
    }
  }
  return { start, end: end + 1, truncated: end + 1 - first >= BLOCK_LIMIT };
}

// ── the service ────────────────────────────────────────────────────────────

export class EvidenceService {
  constructor({ timeline, dependencies, graph, scope, metrics = null }) {
    this.timeline = timeline;
    this.dependencies = dependencies;
    this.graph = graph;
    this.scope = scope;
    this.metrics = metrics;
    this.db = timeline.db;
    // Handles this process issued that could not be recorded (the store was
    // busy). They resolve here; another process cannot see them.
    this.unrecorded = new Map();
    // Ranked matches by index generation and query; pages read from these.
    this.retrievals = new BoundedCache({ maxEntries: 32, maxWeight: 12_000, weight: (list) => list.units.length + 1 });
    // Definitions in a code file, by its content hash: the bytes never change.
    this.fileDefinitions = new BoundedCache({ maxEntries: 20_000, maxWeight: 2_000_000, weight: (found) => found.length + 1 });
    // A snapshot's table cells by row, for bundling a record's fields.
    this.rowCells = new BoundedCache({ maxEntries: 8, maxWeight: 400_000, weight: (rows) => rows.weight });
    this.fileObjectCache = new BoundedCache({ maxEntries: 8, maxWeight: 400_000, weight: (byPath) => byPath.weight });
    // Each file revision's headings and table rows, read once from its bytes.
    this.structures = new BoundedCache({ maxEntries: 256 });
    // STEP assemblies' parsed models, by content hash, for their instances' placements.
    this.stepModels = new BoundedCache({ maxEntries: 16 });
    this.pruneHandles();
  }

  pruneHandles() {
    try {
      const cutoff = new Date(Date.now() - HANDLE_LIFETIME_DAYS * 86_400_000).toISOString();
      this.db.prepare(`DELETE FROM agent_evidence WHERE last_used_at < ?
        AND handle NOT IN (SELECT handle FROM agent_bindings)`).run(cutoff);
    } catch { /* the app may hold the write lock; old handles wait for another start */ }
  }

  /** The scope's folders and their pinned snapshots, as every operation starts from. */
  context() {
    const projects = this.scope.projects();
    const generation = base32(sha(`${this.scope.describe().join('\u0000')}|${projects.map((project) =>
      `${project.id}:${project.snapshotId}:${this.scope.suppressed(project.id).join(',')}`).join('|')}`), 8);
    return { projects, byId: new Map(projects.map((project) => [project.id, project])), generation,
      filters: new Map(), disk: new Map(), files: new Map(), sources: new Map(), handles: [] };
  }

  allowed(context, projectId, relativePath) {
    const project = context.byId.get(projectId);
    if (!project?.snapshotId) return false;
    if (!context.filters.has(projectId)) context.filters.set(projectId, this.scope.pathFilter(projectId));
    return context.filters.get(projectId)(relativePath);
  }

  foldersNamed(context, folder) {
    if (folder == null) return context.projects;
    const wanted = String(folder).trim().replace(/^\.\/+/, '').replace(/\/+$/, '');
    // "." or "/" is every shared folder, as a path written from the workspace root would mean.
    if (!wanted || wanted === '.' || wanted === '/') return context.projects;
    const matches = context.projects.filter((project) => project.id === wanted
      || project.name.toLowerCase() === wanted.toLowerCase()
      || (path.isAbsolute(wanted) && path.resolve(wanted) === path.resolve(project.rootPath)));
    if (!matches.length) {
      throw new AgentError('not_found', `No shared folder is named ${wanted}.`,
        { folders: context.projects.map((project) => project.name) });
    }
    return matches;
  }

  snapshotFile(context, project, relativePath) {
    const key = `${project.snapshotId}|${relativePath}`;
    if (!context.files.has(key)) context.files.set(key, this.timeline.snapshotFile(project.snapshotId, relativePath));
    return context.files.get(key);
  }

  /** Whether the file on disk still has the indexed bytes: 'same', 'changed' or 'missing'. */
  diskState(context, project, file) {
    const key = `${project.id}|${file.path}|${file.contentHash}`;
    if (context.disk.has(key)) return context.disk.get(key);
    let state = 'missing';
    try {
      const absolute = path.join(project.rootPath, ...file.path.split('/'));
      const stat = fs.statSync(absolute);
      if (stat.size === file.size && Math.abs(stat.mtimeMs - file.mtimeMs) < 1) state = 'same';
      else if (stat.size === file.size && stat.size <= MAX_TEXT_BYTES) {
        state = hashBuffer(fs.readFileSync(absolute)) === file.contentHash ? 'same' : 'changed';
      } else state = 'changed';
    } catch { /* missing or unreadable */ }
    context.disk.set(key, state);
    return state;
  }

  /** The shared description of a file revision, sent once per response and named s1, s2… */
  source(context, project, file) {
    const key = `${project.id}|${file.path}|${file.contentHash}`;
    let entry = context.sources.get(key);
    if (!entry) {
      const disk = this.diskState(context, project, file);
      entry = { id: `s${context.sources.size + 1}`, body: { folder: project.name, path: file.path, rev: rev(file.contentHash),
        ...(disk === 'same' ? {} : { disk }), ...(project.lagging ? { lagging: true } : {}) } };
      context.sources.set(key, entry);
    }
    return entry.id;
  }

  sourcesOf(context) {
    return Object.fromEntries([...context.sources.values()].map((entry) => [entry.id, entry.body]));
  }

  /**
   * Indexed evidence from a file that has since changed on disk is easy to
   * quote as current by mistake, so it is said in words, once per file.
   */
  diskWarnings(context) {
    return [...context.sources.values()].flatMap(({ body }) => body.disk === 'changed'
      ? [`${body.folder}/${body.path} changed on disk after Lasso indexed it, so these results show revision ${body.rev}, not the file as it is now. Inspect it with version "disk" for the current text.`]
      : body.disk === 'missing' ? [`${body.folder}/${body.path} is no longer on disk; these results show revision ${body.rev}.`] : []);
  }

  issue(context, ref) {
    const handle = handleOf(ref);
    context.handles.push({ handle, ref });
    return handle;
  }

  /** Records the handles a response hands out, so they resolve in any later call or process. */
  recordHandles(context) {
    if (!context.handles.length) return [];
    const at = now();
    try {
      const insert = this.db.prepare(`INSERT INTO agent_evidence(handle, project_id, snapshot_id, project_file_id, path,
        content_hash, object_id, version_id, line_start, line_end, cell_json, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(handle) DO NOTHING`);
      transaction(this.db, () => {
        for (const { handle, ref } of context.handles) {
          insert.run(handle, ref.projectId, ref.snapshotId, ref.projectFileId, ref.path, ref.contentHash,
            ref.objectId ?? null, ref.versionId ?? null, ref.lineStart ?? null, ref.lineEnd ?? null,
            ref.cell ? JSON.stringify(ref.cell) : null, at, at);
        }
      });
      return [];
    } catch (error) {
      for (const { handle, ref } of context.handles) this.unrecorded.set(handle, ref);
      this.metrics?.note('handlesUnrecorded', context.handles.length);
      return [`Handles in this response could not be recorded (${error.message}); they work only until this Lasso process exits.`];
    }
  }

  /** A handle's evidence, re-authorized now. */
  resolveHandle(context, given) {
    // Answers show handles as "#ID"; one copied with its mark is the same handle.
    const handle = typeof given === 'string' ? given.trim().replace(/^#/, '').toUpperCase() : given;
    if (typeof handle === 'string' && /^S\d+$/.test(handle)) {
      throw invalid(`${given} names a source within one answer, not evidence; pass that source's path as file.`);
    }
    if (typeof handle !== 'string' || !HANDLE.test(handle)) throw invalid(`${given} is not a Lasso evidence handle.`);
    let ref = this.unrecorded.get(handle);
    if (!ref) {
      const row = this.db.prepare('SELECT * FROM agent_evidence WHERE handle = ?').get(handle);
      if (!row) throw new AgentError('expired_handle', `Handle ${handle} is unknown or expired. Run suggest again.`);
      ref = { projectId: row.project_id, snapshotId: row.snapshot_id, projectFileId: row.project_file_id, path: row.path,
        contentHash: row.content_hash, objectId: row.object_id, versionId: row.version_id,
        lineStart: row.line_start, lineEnd: row.line_end, cell: row.cell_json ? JSON.parse(row.cell_json) : null };
    }
    if (!this.allowed(context, ref.projectId, ref.path)) {
      throw new AgentError('unauthorized', `Handle ${handle} points outside the folders shared with this agent.`);
    }
    const project = context.byId.get(ref.projectId);
    return { handle, ...ref, project, kind: ref.objectId ? 'object' : ref.cell ? 'cell' : ref.lineStart != null ? 'lines' : 'file' };
  }

  fileRef(project, file, lines = null) {
    return { projectId: project.id, snapshotId: file.snapshotId ?? project.snapshotId, projectFileId: file.projectFileId,
      path: file.path, contentHash: file.contentHash, lineStart: lines?.[0] ?? null, lineEnd: lines?.[1] ?? null };
  }

  objectRef(context, project, object) {
    const file = this.snapshotFile(context, project, object.path);
    if (!file) return null;
    // A large table's cell is named by where it is in that file revision.
    if (object.cell) return { projectId: project.id, snapshotId: project.snapshotId, projectFileId: file.projectFileId,
      path: object.path, contentHash: file.contentHash, cell: object.cell };
    if (!object.versionId || String(object.id).startsWith('indexed:')) return null;
    return { projectId: project.id, snapshotId: object.snapshotId ?? project.snapshotId, projectFileId: file.projectFileId,
      path: object.path, contentHash: object.contentHash ?? file.contentHash, objectId: object.id, versionId: object.versionId };
  }

  // ── suggest ──────────────────────────────────────────────────────────────

  suggest(request = {}) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw invalid('The request must be an object.');
    const listed = Array.isArray(request.queries) ? request.queries : request.text != null ? [request] : null;
    if (!listed?.length || listed.length > MAX_QUERIES) throw invalid(`queries must list 1 to ${MAX_QUERIES} requests.`);
    const limit = count(request.limit, 'limit', { max: MAX_LIMIT, fallback: DEFAULT_LIMIT });
    const budget = count(request.budget, 'budget', { min: 200, max: 100_000, fallback: DEFAULT_BUDGET });
    const maxChars = count(request.max_chars, 'max_chars', { min: 20, max: 20_000, fallback: DEFAULT_VALUE_CHARS });
    const queries = this.normalizeQueries(listed, limit);

    const context = this.context();
    const results = queries.map((query) => {
      try {
        return this.page(context, query, maxChars);
      } catch (error) {
        if (error instanceof AgentError) return { id: query.id, error: error.toJSON() };
        throw error;
      }
    });
    this.fitBudget(context, results, budget);
    const warnings = [...this.diskWarnings(context), ...this.recordHandles(context)];
    const lagging = context.projects.filter((project) => project.lagging).map((project) => project.name);
    return { sources: this.sourcesOf(context), results: results.map(({ units, ...result }) => result),
      ...(lagging.length ? { lagging } : {}), ...(warnings.length ? { warnings } : {}) };
  }

  /** Queries as strings or objects, checked and given their defaults. */
  normalizeQueries(listed, limit) {
    const ids = new Set();
    return listed.map((given, index) => {
      // A bare string is a query of that text, so batching costs nothing to write.
      const query = typeof given === 'string' ? { text: given } : given;
      if (!query || typeof query !== 'object') throw invalid('Each query must be a string or an object.');
      const id = text(query.id, 'id', { max: 80 }) ?? `q${index + 1}`;
      if (ids.has(id)) throw invalid(`Two queries share the id ${id}.`);
      ids.add(id);
      let kind = query.kind ?? 'any';
      if (!KINDS.has(kind)) throw invalid(`kind must be one of ${[...KINDS].join(', ')}.`);
      const fields = names(query.fields, 'fields', MAX_FIELDS);
      const notes = [];
      // Fields are columns of table rows; a file or passage has none to give.
      if (fields?.length && ['file', 'passage', 'code'].includes(kind)) {
        notes.push(`kind ${kind} has no fields; searched table rows`);
        kind = 'any';
      }
      // "Finance/Approved" as a folder is the Finance folder under its Approved directory.
      let folder = text(query.folder, 'folder', { max: 4096 });
      let under = text(query.under, 'under', { max: 1024 });
      if (folder && !path.isAbsolute(folder) && folder.replace(/^\.\/+/, '').replace(/\/+$/, '').includes('/')) {
        const [first, ...rest] = folder.replace(/^\.\/+/, '').replace(/\/+$/, '').split('/');
        folder = first;
        under = [rest.join('/'), under].filter(Boolean).join('/');
      }
      return { id, text: matchText(text(query.text, 'text', { optional: false }), fields), kind, notes,
        fields, folder, under, ext: text(query.ext, 'ext', { max: 16 }),
        limit: count(query.limit, 'limit', { max: MAX_LIMIT, fallback: limit }),
        cursor: text(query.cursor, 'cursor', { max: 120 }) };
    });
  }

  /** One page of a query's ranked matches, read from the generation's cached ranking. */
  page(context, query, maxChars) {
    const projects = this.foldersNamed(context, query.folder);
    const key = JSON.stringify([context.generation, query.text, query.kind, query.fields, projects.map((p) => p.id),
      query.under, query.ext]);
    const fingerprint = base32(sha(key), 6);
    let offset = 0;
    if (query.cursor) {
      const [generation, mark, at] = query.cursor.split('.');
      if (generation !== context.generation || mark !== fingerprint || !/^\d+$/.test(at ?? '')) {
        throw new AgentError('stale_cursor', 'The folders changed since that page, or the cursor belongs to another query. Ask again without the cursor.');
      }
      offset = Number(at);
    }
    let ranked = this.retrievals.get(key);
    if (ranked) this.metrics?.note('retrievalCacheHits');
    else {
      ranked = this.rank(context, projects, query);
      this.retrievals.set(key, ranked);
    }
    const end = Math.min(ranked.units.length, offset + query.limit);
    const units = ranked.units.slice(offset, end);
    const candidates = units.map((unit) => this.project(context, unit, query, maxChars));
    const more = end < ranked.units.length;
    const pending = projects.filter((project) => !project.snapshotId).map((project) => project.name);
    return {
      id: query.id,
      candidates,
      coverage: {
        // Exact and name-prefix matches rank first; when none exist, everything returned matched only some terms.
        total: ranked.units.length, exact: ranked.exact, ...(offset ? { offset } : {}),
        ...(more ? { more: true, cursor: `${context.generation}.${fingerprint}.${end}` } : {}),
        ...(ranked.capped ? { capped: true } : {}),
        // Nothing else in the shared, indexed folders matched these terms.
        exhausted: !more && !ranked.capped && !pending.length,
        ...(pending.length ? { unindexed: pending } : {}),
      },
      ...(query.notes?.length ? { notes: query.notes } : {}),
      units: { offset, fingerprint, size: candidates.length },
    };
  }

  /** Drops the lowest-ranked candidates until the response fits the evidence budget. */
  fitBudget(context, results, budget) {
    let size = estimateTokens(JSON.stringify({ sources: this.sourcesOf(context), results }));
    while (size > budget) {
      const largest = results.filter((result) => result.candidates?.length > 1)
        .sort((left, right) => right.candidates.length - left.candidates.length)[0];
      if (!largest) break;
      size -= estimateTokens(JSON.stringify(largest.candidates.pop()));
      largest.units.size -= 1;
      const next = largest.units.offset + largest.units.size;
      largest.coverage.more = true;
      largest.coverage.cursor = `${context.generation}.${largest.units.fingerprint}.${next}`;
      largest.coverage.exhausted = false;
      largest.coverage.budget = true;
    }
    // Sources no remaining candidate refers to are dropped with them.
    const used = new Set(results.flatMap((result) => (result.candidates ?? []).map((candidate) => candidate.src)));
    for (const [key, entry] of context.sources) if (!used.has(entry.id)) context.sources.delete(key);
    const kept = new Set(results.flatMap((result) => (result.candidates ?? [])
      .flatMap((candidate) => [candidate.h, ...Object.values(candidate.fields ?? {}).map((field) => field?.h)])));
    context.handles = context.handles.filter(({ handle }) => kept.has(handle));
  }

  /** Every authorized match of a query, ranked across folders, as units to page through. */
  rank(context, projects, query) {
    if (query.kind === 'file') return this.rankFiles(context, projects, query);
    // A file name as written ("app.py") asks for that file, not everything in it.
    if (query.kind === 'any' && !query.fields && /^[^\s]+\.[A-Za-z0-9]{1,10}$/.test(query.text)) {
      const files = this.rankFiles(context, projects, query);
      if (files.units.length) return files;
    }
    const items = [];
    let capped = false;
    for (const project of projects) {
      if (!project.snapshotId) continue;
      const found = this.graph.search(project.id, query.text, {
        snapshotId: project.snapshotId, directory: query.under, sourceType: query.ext,
        limit: SEARCH_CAP, diversify: false,
      });
      capped ||= found.length >= SEARCH_CAP;
      for (const item of found) items.push({ ...item, projectId: project.id });
    }
    const large = ['any', 'value'].includes(query.kind) ? projects.flatMap((project) => this.largeTableUnits(context, project, query)) : [];
    const matches = distinctRanked(items, SEARCH_CAP * projects.length)
      .filter((item) => this.allowed(context, item.projectId, item.path))
      .filter((item) => this.kindMatches(item.object, query.kind));
    // A large table's row may already be recorded as objects (offered once
    // before, by the popup or another agent) and so found by search as well.
    // The row index's record carries the whole row; search's copy goes.
    const largeRows = new Set(large.map((unit) => rowKeyOf(unit.project.id, unit.object)));
    let units = matches.map((item) => ({ project: context.byId.get(item.projectId), object: item.object,
      match: item.matchKind, why: item.reasons?.[0] ?? null, ranking: item.ranking }))
      .filter((unit) => !largeRows.has(rowKeyOf(unit.project.id, unit.object)));
    if (query.fields?.length) units = this.records(context, units, query.fields);
    if (large.length) {
      // A stable sort on standing alone keeps search's order within each
      // standing and places the large tables' rows at the end of theirs.
      const standing = (unit) => [unit.ranking?.tier ?? 1, -(unit.ranking?.directSpecificity ?? 0)];
      units = [...units, ...large].sort((left, right) => {
        const [a, b] = [standing(left), standing(right)];
        return a[0] - b[0] || a[1] - b[1];
      });
    }
    return { units: interleaveByFile(units).slice(0, SEARCH_CAP), capped: capped || units.length > SEARCH_CAP,
      exact: units.filter((unit) => unit.ranking?.tier === 0).length };
  }

  /**
   * Rows of tables too large to hold as objects, found through each table's
   * own row-name index. Each row comes back as a record of its fields (or of
   * its first columns). Nothing is recorded: a cell's handle names its place
   * in the file revision, read back from the same index, so another process
   * recording rows into the snapshot cannot leave this one's caches stale.
   */
  largeTableUnits(context, project, query) {
    if (!project.snapshotId) return [];
    const units = [];
    const wanted = fold(query.text).replace(/ /g, '');
    for (const table of this.dependencies.snapshotTables(project.id, project.snapshotId)) {
      const filePath = table.file.path;
      if (!this.allowed(context, project.id, filePath)) continue;
      if (query.under && !`${filePath}/`.toLowerCase().startsWith(`${query.under.replace(/\/+$/, '').toLowerCase()}/`)) continue;
      if (query.ext && !filePath.toLowerCase().endsWith(`.${query.ext.replace(/^\./, '').toLowerCase()}`)) continue;
      for (const row of this.dependencies.tables.search(table.meta.id, query.text, LARGE_TABLE_ROWS)) {
        const objects = this.dependencies.indexedRowObjects(table, row).map((descriptor) => cellObject(descriptor, project, table));
        const cells = objects.filter((object) => object.anchor?.kind === 'table-cell');
        const first = objects.find((object) => object.anchor?.kind === 'table-row') ?? cells[0];
        if (!first) continue;
        const label = String(first.anchor?.rowKey ?? first.metadata?.row ?? '');
        const exact = fold(label).replace(/ /g, '') === wanted;
        const fields = query.fields?.length ? query.fields.map((field) => [field, matchField(cells, field)])
          : cells.slice(0, ROW_PREVIEW_COLUMNS).map((cell) => [String(cell.anchor?.column ?? cell.metadata?.column), cell]);
        units.push({ project, object: first, match: exact ? 'exact' : 'prefix', why: 'Row name in a large table',
          ranking: { tier: 0, directSpecificity: exact ? 2 : 1 },
          record: { key: rowKeyOf(project.id, first),
            row: label, sheet: table.sheet ?? null, rowIndex: first.anchor?.rowIndex, fields,
            ...(!query.fields?.length && cells.length > ROW_PREVIEW_COLUMNS ? { more: cells.length - ROW_PREVIEW_COLUMNS } : {}) } });
      }
    }
    return units;
  }

  kindMatches(object, kind) {
    if (kind === 'any') return true;
    const type = evidenceType(object);
    if (kind === 'code') return type === 'code' || (type === 'file' && object.metadata?.codeFile === true);
    if (kind === 'passage') return type === 'passage';
    if (kind === 'value') return ['cell', 'row', 'column', 'variable', 'dataset_value', 'result', 'table'].includes(type);
    return true;
  }

  /**
   * Files named by a query, from each folder's manifest: an exact path first,
   * then a path ending in it, then the same file name, then the same name
   * without its extension. Every match is returned; a name two folders share
   * is never settled here.
   */
  rankFiles(context, projects, query) {
    const wanted = relativeName(query.text);
    if (!wanted) throw invalid('That file name reaches outside the folder.');
    const lower = wanted.toLowerCase();
    const stem = (name) => name.replace(/\.[^./]+$/, '');
    const units = [];
    for (const project of projects) {
      if (!project.snapshotId) continue;
      for (const file of this.timeline.snapshotFiles(project.snapshotId)) {
        const filePath = file.path.toLowerCase();
        const base = filePath.slice(filePath.lastIndexOf('/') + 1);
        const tier = filePath === lower ? 0 : filePath.endsWith(`/${lower}`) ? 1 : base === lower ? 2
          : !lower.includes('.') && stem(base) === lower ? 3 : null;
        if (tier == null) continue;
        if (query.under && !`${file.path}/`.toLowerCase().startsWith(`${query.under.replace(/\/+$/, '').toLowerCase()}/`)) continue;
        if (query.ext && !filePath.endsWith(`.${query.ext.replace(/^\./, '').toLowerCase()}`)) continue;
        if (!this.allowed(context, project.id, file.path)) continue;
        units.push({ project, file, tier, match: ['exact path', 'path suffix', 'file name', 'file stem'][tier] });
      }
    }
    units.sort((left, right) => left.tier - right.tier || left.file.path.length - right.file.path.length
      || left.file.path.localeCompare(right.file.path) || left.project.name.localeCompare(right.project.name));
    return { units: units.slice(0, SEARCH_CAP), capped: units.length > SEARCH_CAP, exact: units.filter((unit) => unit.tier <= 2).length };
  }

  /**
   * Table matches bundled by record: each row once, with the fields the
   * query asked for read from that same row. The shared context (file, row)
   * is sent once instead of once per field.
   */
  records(context, units, fields) {
    const grouped = [];
    const byRow = new Map();
    for (const unit of units) {
      const { object, project } = unit;
      const anchor = object.anchor ?? {};
      if (!['table-cell', 'table-row'].includes(anchor.kind) || !Number.isInteger(anchor.rowIndex)) {
        grouped.push(unit);
        continue;
      }
      const sheet = object.metadata?.sheet ?? anchor.sheet ?? '';
      const key = `${project.id}|${object.snapshotId}|${object.path}|${sheet}|${anchor.rowIndex}`;
      if (byRow.has(key)) continue;
      const cells = this.cellsOfRow(project, object.snapshotId, `${object.path}|${sheet}|${anchor.rowIndex}`);
      const record = { ...unit, record: { key, row: anchor.rowKey ?? object.metadata?.row ?? null, sheet: sheet || null,
        rowIndex: anchor.rowIndex, fields: fields.map((field) => [field, matchField(cells, field)]) } };
      byRow.set(key, record);
      grouped.push(record);
    }
    return grouped;
  }

  cellsOfRow(project, snapshotId, rowKey) {
    return this.rowTable(project, snapshotId).byRow.get(rowKey) ?? [];
  }

  /** A snapshot's table cells by row, and its labelled rows by their folded label, read once per snapshot. */
  rowTable(project, snapshotId) {
    let rows = this.rowCells.get(snapshotId);
    if (!rows) {
      rows = { byRow: new Map(), byLabel: new Map(), weight: 0 };
      for (const object of this.dependencies.objectsAt(project.id, snapshotId)) {
        const anchor = object.anchor ?? {};
        if (anchor.kind !== 'table-cell' || !Number.isInteger(anchor.rowIndex)) continue;
        const key = `${object.path}|${object.metadata?.sheet ?? anchor.sheet ?? ''}|${anchor.rowIndex}`;
        if (!rows.byRow.has(key)) {
          rows.byRow.set(key, []);
          const label = String(anchor.rowKey ?? object.metadata?.row ?? '');
          if (label && !/^row:\d+$/.test(label)) {
            const folded = foldAsk(label);
            if (!rows.byLabel.has(folded)) rows.byLabel.set(folded, []);
            rows.byLabel.get(folded).push(key);
          }
        }
        rows.byRow.get(key).push(object);
        rows.weight += 1;
      }
      this.rowCells.set(snapshotId, rows);
    }
    return rows;
  }

  /** A ranked unit as the compact candidate an agent reads. */
  project(context, unit, query, maxChars) {
    const { project } = unit;
    if (unit.file) {
      const src = this.source(context, project, unit.file);
      return { h: this.issue(context, this.fileRef(project, unit.file)), src, type: 'file', match: unit.match };
    }
    const object = unit.object;
    const file = this.snapshotFile(context, project, object.path);
    const src = file ? this.source(context, project, file) : null;
    const ref = this.objectRef(context, project, object);
    const type = evidenceType(object);
    if (unit.record) {
      const fields = {};
      const missing = [];
      const rowAt = locatorOf({ ...object, anchor: { ...object.anchor, kind: 'table-row' } });
      for (const [name, cell] of unit.record.fields) {
        if (!cell) { missing.push(name); continue; }
        const cellRef = this.objectRef(context, project, cell);
        const column = cell.anchor?.column ?? cell.metadata?.column;
        const at = locatorOf(cell);
        // "row 3 · Revenue" says nothing the record's row and the field's name do not.
        fields[name] = { ...(cellRef ? { h: this.issue(context, cellRef) } : {}), ...clipped(cell.valueText, maxChars),
          ...(at && at !== `${rowAt} · ${column}` ? { at } : {}), ...(column && fold(column) !== fold(name) ? { col: column } : {}) };
      }
      const { row, col, ...shared } = qualifiers(object);
      return { src, type: 'record', ...(unit.record.row != null ? { row: String(unit.record.row) } : {}),
        at: rowAt, fields,
        ...(missing.length ? { missing } : {}), ...(unit.record.more ? { more_fields: unit.record.more } : {}),
        ...(Object.keys(shared).length ? { ctx: shared } : {}),
        match: MATCHES[unit.match] ?? unit.match };
    }
    const value = type === 'file' ? { value: null } : clipped(object.valueText, maxChars);
    const label = object.label && object.label !== object.valueText && type !== 'passage' ? object.label : null;
    const extra = qualifiers(object, `${label ?? ''} ${object.path}`);
    const candidate = {
      ...(ref ? { h: this.issue(context, ref) } : {}),
      src, type,
      ...(label ? { label } : {}),
      ...(value.value != null ? value : {}),
      ...(locatorOf(object) ? { at: locatorOf(object) } : {}),
      ...(Object.keys(extra).length ? { ctx: extra } : {}),
      match: MATCHES[unit.match] ?? unit.match,
    };
    if (type === 'file' && object.metadata?.lineCount) candidate.lines_total = object.metadata.lineCount;
    return candidate;
  }

  // ── inspect ──────────────────────────────────────────────────────────────

  inspect(request = {}) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw invalid('The request must be an object.');
    if (request.items !== undefined && !Array.isArray(request.items)) throw invalid('items must be a list.');
    const items = request.items ?? [request];
    if (!items.length || items.length > MAX_ITEMS) throw invalid(`items must list 1 to ${MAX_ITEMS} requests.`);
    const context = this.context();
    const results = items.map((item) => {
      try {
        if (!item || typeof item !== 'object') throw invalid('Each item must be an object.');
        return this.inspectItem(context, item);
      } catch (error) {
        if (error instanceof AgentError) return { error: error.toJSON() };
        throw error;
      }
    });
    const warnings = [...this.diskWarnings(context), ...this.recordHandles(context)];
    return { sources: this.sourcesOf(context), items: results, ...(warnings.length ? { warnings } : {}) };
  }

  inspectItem(context, item) {
    if (item.folders) return { folders: this.folders(context) };
    const around = count(item.context, 'context', { min: 0, max: 200, fallback: null });
    const numbered = item.numbered === true;
    if (item.h != null) {
      const ref = this.resolveHandle(context, item.h);
      if (item.rev != null && ['object', 'cell'].includes(ref.kind)) {
        throw invalid('rev applies to file and line handles. For an earlier value, inspect the handle with history: true.');
      }
      if (ref.kind === 'cell') {
        if (item.history) throw new AgentError('unsupported', 'History is kept for recorded values; this cell of a large table has none. Inspect it at another rev instead.');
        return this.expandCell(context, ref, around ?? 3);
      }
      if (ref.kind === 'object' && item.symbol != null) return this.definitionAt(context, ref, item.symbol, around ?? 0, numbered);
      if (ref.kind === 'object') return item.history ? this.history(context, ref, item) : this.expand(context, ref, around ?? 3, numbered);
      // A revision asked for alongside a handle is read, never replaced by the handle's own.
      const asked = item.rev == null ? null : text(item.rev, 'rev', { max: 64 }).toLowerCase();
      if (asked != null && !/^[0-9a-f]{8,64}$/.test(asked)) throw invalid('rev must be at least 8 hex characters of a revision.');
      const file = this.revisionFile(ref.project, ref.path, asked ?? ref.contentHash, ref.projectFileId);
      const lines = item.lines != null ? parseLineRange(item.lines) : ref.kind === 'lines' ? [ref.lineStart, ref.lineEnd] : null;
      if (item.symbol != null) return this.symbol(context, ref.project, file, text(item.symbol, 'symbol', { max: 200 }), around ?? 0, numbered);
      if (lines) return this.lines(context, ref.project, file, lines, around ?? 0, numbered);
      return this.outline(context, ref.project, file);
    }
    if (item.file == null && typeof item.symbol === 'string') return this.symbolAnywhere(context, item, around ?? 0, numbered);
    if (item.file == null) throw invalid('Each item needs h (a handle), file, symbol, or folders: true.');
    const { project, file } = this.resolveFile(context, item);
    if (item.symbol != null) return this.symbol(context, project, file, text(item.symbol, 'symbol', { max: 200 }), around ?? 0, numbered);
    if (item.lines != null) return this.lines(context, project, file, parseLineRange(item.lines), around ?? 0, numbered);
    return this.outline(context, project, file);
  }

  folders(context) {
    return context.projects.map((project) => ({ name: project.name, root: project.rootPath,
      ...(project.snapshotId ? { version: project.version, indexed: project.indexedAt } : { unindexed: true }),
      ...(project.lagging && project.snapshotId ? { lagging: true, current: project.currentVersion } : {}),
      ...(project.available ? {} : { unavailable: true }),
      files: project.snapshotId ? this.timeline.files.count(project.snapshotId) : 0 }));
  }

  /**
   * The one file an item names: by folder and path, by a path or file name
   * unique across the shared folders, at the indexed revision, a pinned
   * revision (`rev`), or as it is on disk now (`version: "disk"`).
   */
  resolveFile(context, item) {
    const typed = text(item.file, 'file', { max: 4096, optional: false });
    let projects = this.foldersNamed(context, item.folder);
    let wanted = typed.replaceAll('\\', '/');
    if (path.isAbsolute(typed)) {
      const owner = projects.find((project) => typed === project.rootPath || typed.startsWith(`${project.rootPath}${path.sep}`));
      if (!owner) throw new AgentError('not_found', `${typed} is not inside a shared folder.`);
      projects = [owner];
      wanted = path.relative(owner.rootPath, typed).split(path.sep).join('/');
    }
    let name = relativeName(wanted);
    if (!name) throw invalid('That file name reaches outside the folder.');
    let ranked = this.rankFiles(context, projects, { text: name, kind: 'file' }).units;
    // "Web/src/app.py", "Web/app.py": a shared folder's name written as the path's first part.
    const [first, ...rest] = name.split('/');
    if (!ranked.some((unit) => unit.tier <= 2) && item.folder == null && rest.length) {
      const named = projects.filter((project) => project.name.toLowerCase() === first.toLowerCase());
      if (named.length) {
        projects = named;
        name = rest.join('/');
        ranked = this.rankFiles(context, projects, { text: name, kind: 'file' }).units;
        item = { ...item, folder: first };
      }
    }
    // A full folder-relative path, in a named folder or with directories in
    // it, is that file. A bare name is every file of that name: a root app.py
    // and another folder's src/app.py are both "app.py", and neither wins.
    const exact = ranked.filter((unit) => unit.tier === 0);
    const best = exact.length === 1 && (item.folder != null || name.includes('/')) ? exact
      : ranked.filter((unit) => unit.tier <= 2);
    if (!best.length) {
      throw new AgentError('not_found', `No shared, indexed file is named ${typed}.`,
        ranked.length ? { similar: ranked.slice(0, 8).map((unit) => ({ folder: unit.project.name, path: unit.file.path })) } : undefined);
    }
    if (best.length > 1) {
      throw new AgentError('ambiguous', `${best.length} shared files match ${typed}. Name the folder or a longer path.`,
        { matches: best.slice(0, 20).map((unit) => ({ folder: unit.project.name, path: unit.file.path, rev: rev(unit.file.contentHash) })) });
    }
    const { project, file } = best[0];
    const version = item.version ?? 'indexed';
    if (!['indexed', 'disk'].includes(version)) throw invalid('version must be "indexed" or "disk".');
    if (version === 'disk') return { project, file: this.diskFile(project, file) };
    if (item.rev != null) {
      const pinned = text(item.rev, 'rev', { max: 64 }).toLowerCase();
      if (!/^[0-9a-f]{8,64}$/.test(pinned)) throw invalid('rev must be at least 8 hex characters of a revision.');
      if (file.contentHash.startsWith(pinned)) return { project, file };
      return { project, file: this.revisionFile(project, file.path, pinned, file.projectFileId, file) };
    }
    return { project, file };
  }

  /**
   * A file at one recorded revision. A pinned revision that is not the
   * indexed one is read from history and marked so; one Lasso never recorded
   * is an error, never the current file in its place.
   */
  revisionFile(project, filePath, hashOrPrefix, projectFileId, current = null) {
    const indexed = current ?? this.timeline.snapshotFileById(project.snapshotId, projectFileId);
    if (indexed?.contentHash.startsWith(hashOrPrefix)) return indexed;
    const rows = this.db.prepare(`SELECT DISTINCT content_hash, path, file_type, size FROM snapshot_files
      WHERE project_file_id = ? AND content_hash LIKE ? LIMIT 2`).all(projectFileId, `${hashOrPrefix}%`);
    if (!rows.length) {
      throw new AgentError('revision_not_found', `Lasso never recorded revision ${hashOrPrefix.slice(0, 12)} of ${filePath}.`,
        indexed ? { current: rev(indexed.contentHash) } : undefined);
    }
    if (rows.length > 1) throw invalid(`Revision ${hashOrPrefix} is ambiguous; give more of it.`);
    return { projectFileId, path: rows[0].path, contentHash: rows[0].content_hash, fileType: rows[0].file_type,
      size: rows[0].size, mtimeMs: null, historical: true, current: indexed ? rev(indexed.contentHash) : null };
  }

  /** The file as it is on disk now, if it still resolves inside its folder. Never indexed, so marked. */
  diskFile(project, file) {
    let root, real;
    try {
      root = fs.realpathSync(project.rootPath);
      real = fs.realpathSync(path.join(root, ...file.path.split('/')));
    } catch {
      throw new AgentError('not_found', `${file.path} is no longer on disk.`);
    }
    if (!real.startsWith(`${root}${path.sep}`)) throw new AgentError('unauthorized', `${file.path} resolves outside its folder.`);
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) throw new AgentError('too_large', `${file.path} is too large to read here.`);
    const buffer = fs.readFileSync(real);
    const contentHash = hashBuffer(buffer);
    return { ...file, contentHash, size: stat.size, mtimeMs: stat.mtimeMs, disk: true, buffer,
      indexedRev: rev(file.contentHash) };
  }

  textOf(file) {
    if (!isTextualType(file.fileType)) {
      throw new AgentError('unsupported', `${file.path} is not a text file; inspect its passages or values by handle instead.`);
    }
    const buffer = file.buffer ?? this.timeline.blobs.get(file.contentHash);
    if (buffer.length > MAX_TEXT_BYTES) throw new AgentError('too_large', `${file.path} is too large to read by line.`);
    return buffer.toString('utf8');
  }

  /** What a response says about the revision lines were read from. */
  revisionNote(context, project, file) {
    if (file.disk) return { disk_rev: rev(file.contentHash), ...(rev(file.contentHash) === file.indexedRev ? {} : { unindexed: true }) };
    if (file.historical) return { rev: rev(file.contentHash), historical: true, ...(file.current ? { current: file.current } : {}) };
    return {};
  }

  sourceFor(context, project, file) {
    if (file.disk) {
      const id = `s${context.sources.size + 1}`;
      context.sources.set(`${project.id}|${file.path}|disk:${file.contentHash}`, { id,
        body: { folder: project.name, path: file.path, rev: rev(file.contentHash), disk: 'read' } });
      return id;
    }
    if (file.historical) {
      const key = `${project.id}|${file.path}|${file.contentHash}`;
      if (!context.sources.has(key)) {
        context.sources.set(key, { id: `s${context.sources.size + 1}`, body: { folder: project.name, path: file.path,
          rev: rev(file.contentHash), historical: true } });
      }
      return context.sources.get(key).id;
    }
    return this.source(context, project, file);
  }

  /** Exactly lines `first` through `last`, as the file has them, numbered from 1. */
  lines(context, project, file, [first, last], around, numbered, { issue = true } = {}) {
    const all = fileLines(this.textOf(file));
    if (first > all.length) {
      throw new AgentError('out_of_range', `${file.path} has ${all.length} line${all.length === 1 ? '' : 's'}.`, { total: all.length });
    }
    if (last > all.length) {
      throw new AgentError('out_of_range', `${file.path} has ${all.length} lines; lines ${first}-${last} run past its end.`, { total: all.length });
    }
    const start = Math.max(1, first - around);
    const end = Math.min(all.length, last + around);
    if (end - start + 1 > MAX_LINES) {
      throw new AgentError('too_large', `Ask for at most ${MAX_LINES} lines at once.`, { total: all.length });
    }
    const src = this.sourceFor(context, project, file);
    const handle = file.disk || !issue ? null : this.issue(context, this.fileRef(project, file, [first, last]));
    return { src, ...(handle ? { h: handle } : {}), lines: [start, end], total: all.length,
      ...(start !== first || end !== last ? { asked: [first, last] } : {}),
      text: render(all, start, end, numbered), ...this.revisionNote(context, project, file) };
  }

  /** Every definition in a code file, with its line, so the agent can ask for exactly the lines it needs. */
  outline(context, project, file) {
    const all = fileLines(this.textOf(file));
    const found = definitions(all);
    const src = this.sourceFor(context, project, file);
    return { src, ...(file.disk ? {} : { h: this.issue(context, this.fileRef(project, file)) }), total: all.length,
      outline: found.slice(0, OUTLINE_LIMIT).map((definition) => `${definition.line} ${definition.name}`),
      ...(found.length > OUTLINE_LIMIT ? { outline_more: found.length - OUTLINE_LIMIT } : {}),
      ...this.revisionNote(context, project, file) };
  }

  /** The block a named definition opens; several definitions of one name are listed, not chosen between. */
  symbol(context, project, file, name, around, numbered, at = null) {
    const all = fileLines(this.textOf(file));
    const found = definitions(all).filter((definition) => definition.name === name && (at == null || definition.line === at));
    if (!found.length) {
      throw new AgentError('not_found', `No definition of ${name} in ${file.path}.`,
        { similar: definitions(all).filter((definition) => definition.name.toLowerCase().includes(name.toLowerCase()))
          .slice(0, 8).map((definition) => `${definition.line} ${definition.name}`) });
    }
    if (found.length > 1) {
      throw new AgentError('ambiguous', `${name} is defined ${found.length} times in ${file.path}. Ask for lines instead.`,
        { matches: found.map((definition) => `${definition.line} ${definition.name}`) });
    }
    const block = blockRange(all, found[0]);
    const result = this.lines(context, project, file, [block.start, block.end], around, numbered);
    return { ...result, symbol: name, ...(block.truncated ? { trunc: true } : {}) };
  }

  /**
   * A definition in the file of a handle found by search: `symbol: true` is
   * the one starting on the handle's line, a name is that name in its file.
   */
  definitionAt(context, ref, symbol, around, numbered) {
    const file = this.revisionFile(ref.project, ref.path, ref.contentHash, ref.projectFileId);
    if (symbol !== true) return this.symbol(context, ref.project, file, text(symbol, 'symbol', { max: 200 }), around, numbered);
    const object = this.dependencies.objectAt(ref.projectId, ref.snapshotId, ref.objectId);
    const line = object?.anchor?.kind === 'line' ? object.anchor.line : null;
    const found = line == null ? null : definitions(fileLines(this.textOf(file))).find((definition) => definition.line === line);
    if (!found) throw new AgentError('not_found', `Handle ${ref.handle} does not point at a definition; pass its name as symbol.`);
    return this.symbol(context, ref.project, file, found.name, around, numbered, found.line);
  }

  /**
   * A definition named without its file, found through the index of code
   * symbols and read from its file. Several definitions of the name, in one
   * file or many, are listed for the agent to choose from.
   */
  symbolAnywhere(context, item, around, numbered) {
    const name = text(item.symbol, 'symbol', { max: 200, optional: false });
    const found = [];
    for (const project of this.foldersNamed(context, item.folder)) {
      if (!project.snapshotId) continue;
      for (const file of this.timeline.snapshotFiles(project.snapshotId)) {
        if (!isCodeType(file.fileType) || file.size > MAX_TEXT_BYTES || !this.allowed(context, project.id, file.path)) continue;
        if (item.under && !`${file.path}/`.toLowerCase().startsWith(`${String(item.under).replace(/\/+$/, '').toLowerCase()}/`)) continue;
        for (const definition of this.definitionsOf(file)) {
          if (definition.name === name) found.push({ project, file, line: definition.line });
        }
      }
    }
    if (!found.length) throw new AgentError('not_found', `No shared code file defines ${name}.`);
    if (found.length > 1) {
      throw new AgentError('ambiguous', `${name} is defined in ${found.length} places.`,
        { matches: found.slice(0, 20).map((entry) => ({ folder: entry.project.name, path: entry.file.path, line: entry.line })) });
    }
    const [{ project, file, line }] = found;
    // Said, so an agent need not search again to learn there is no other.
    return { ...this.symbol(context, project, file, name, around, numbered, line), only: true };
  }

  /** A code revision's definitions, read once per content hash. */
  definitionsOf(file) {
    let found = this.fileDefinitions.get(file.contentHash);
    if (!found) {
      try {
        found = definitions(fileLines(this.timeline.blobs.get(file.contentHash).toString('utf8')))
          .map(({ line, name }) => ({ line, name }));
      } catch {
        found = [];
      }
      this.fileDefinitions.set(file.contentHash, found);
    }
    return found;
  }

  /** The surroundings of a handle's object: neighbouring rows, lines or passages. */
  expand(context, ref, around, numbered) {
    const { project } = ref;
    const object = this.dependencies.objectAt(project.id, ref.snapshotId, ref.objectId);
    if (!object || object.versionId !== ref.versionId) {
      throw new AgentError('expired_handle', `The version handle ${ref.handle} named is no longer recorded.`);
    }
    const file = this.revisionFile(project, object.path, ref.contentHash, ref.projectFileId);
    const src = this.sourceFor(context, project, file);
    const anchor = object.anchor ?? {};
    const base = { src, h: ref.handle, type: evidenceType(object), at: locatorOf(object) };
    const lineSpan = anchor.kind === 'text-excerpt' && Number.isInteger(anchor.lineStart) ? [anchor.lineStart, anchor.lineEnd]
      : anchor.kind === 'line' ? [anchor.line, anchor.line] : anchor.kind === 'line-range' ? [anchor.lineStart, anchor.lineEnd] : null;
    if (lineSpan && isTextualType(file.fileType)) {
      return { ...base, ...this.lines(context, project, file, lineSpan, around, numbered, { issue: false }) };
    }
    if (['table-cell', 'table-row', 'table-column'].includes(anchor.kind)) {
      const preview = this.graph.preview(project.id, { ...object, snapshotId: ref.snapshotId }, { radius: around });
      if (preview.kind === 'table') {
        return { ...base, value: object.valueText, ...(Object.keys(qualifiers(object)).length ? { ctx: qualifiers(object) } : {}),
          table: { header: preview.headerRow, rows: preview.rows.map((row) => [row.rowNumber, ...row.cells]),
            hit: preview.rows.find((row) => row.highlighted)?.rowNumber ?? null,
            ...(Number.isInteger(preview.highlightColumn) && preview.highlightColumn >= 0 ? { col: preview.highlightColumn } : {}) } };
      }
    }
    if (anchor.kind === 'pdf-excerpt') {
      const passages = this.dependencies.objectsAt(project.id, ref.snapshotId, ['DOCUMENT'])
        .filter((candidate) => candidate.path === object.path && candidate.anchor?.kind === 'pdf-excerpt')
        .sort((left, right) => (left.anchor.pageNumber - right.anchor.pageNumber) || ((left.anchor.start ?? 0) - (right.anchor.start ?? 0)));
      const index = passages.findIndex((candidate) => candidate.id === object.id);
      const nearby = passages.slice(Math.max(0, index - around), index + around + 1);
      return { ...base, value: object.valueText, ...(Object.keys(qualifiers(object)).length ? { ctx: qualifiers(object) } : {}),
        passages: nearby.map((passage) => {
          const passageRef = this.objectRef(context, project, passage);
          return { ...(passageRef ? { h: this.issue(context, passageRef) } : {}), at: locatorOf(passage), text: passage.valueText,
            ...(passage.id === object.id ? { hit: true } : {}) };
        }) };
    }
    return { ...base, ...(object.label && object.label !== object.valueText ? { label: object.label } : {}),
      value: object.valueText, ...(Object.keys(qualifiers(object)).length ? { ctx: qualifiers(object) } : {}) };
  }

  /** A large table's cell read back from the row index of its file revision, with the rows around it. */
  cellValue(ref) {
    const metas = this.dependencies.tables.sheets(ref.contentHash);
    const meta = metas.find((candidate) => (candidate.sheet || null) === (ref.cell.sheet || null)) ?? (metas.length === 1 ? metas[0] : null);
    const row = meta ? this.dependencies.tables.rowNumbered(meta.id, ref.cell.row) : null;
    if (!row) throw new AgentError('expired_handle', `The table index no longer holds that row of ${ref.path}.`);
    return { meta, row, value: String(row.cells[ref.cell.column] ?? '').trim() };
  }

  expandCell(context, ref, around) {
    const file = this.revisionFile(ref.project, ref.path, ref.contentHash, ref.projectFileId);
    const { meta, value } = this.cellValue(ref);
    const tables = this.dependencies.tables;
    const before = tables.rowsBefore(meta.id, ref.cell.row - 1, around).reverse();
    const after = [];
    for (let next = ref.cell.row + 1; after.length < around && next <= ref.cell.row + around * 4; next += 1) {
      const row = tables.rowNumbered(meta.id, next);
      if (row) after.push(row);
    }
    const hit = tables.rowNumbered(meta.id, ref.cell.row);
    return { src: this.sourceFor(context, ref.project, file), h: ref.handle, type: 'cell', at: `row ${ref.cell.row + 1} · ${ref.cell.columnName}`,
      value, ...(ref.cell.rowKey ? { ctx: { row: ref.cell.rowKey } } : {}),
      table: { header: meta.shape?.headers ?? null, rows: [...before, hit, ...after].filter(Boolean).map((row) => [row.rowNumber + 1, ...row.cells]),
        hit: ref.cell.row + 1, col: ref.cell.column } };
  }

  /** Recorded versions of a handle's object, newest first, with how each differs. */
  history(context, ref, item) {
    const limit = count(item.limit, 'limit', { max: 200, fallback: 20 });
    const versions = this.graph.history(ref.projectId, ref.objectId);
    return { h: ref.handle, src: this.sourceFor(context, ref.project, this.revisionFile(ref.project, ref.path, ref.contentHash, ref.projectFileId)),
      versions: versions.slice(0, limit).map((version) => ({ v: version.projectVersion, at: version.recordedAt,
        value: version.value, ...(version.path !== ref.path ? { path: version.path } : {}), loc: version.locator,
        ...(version.versionId === ref.versionId ? { this: true } : {}) })),
      ...(versions.length > limit ? { more: versions.length - limit } : {}),
      note: 'Only versions Lasso captured are listed; edits between captures are not known.' };
  }

  // ── bind ─────────────────────────────────────────────────────────────────

  /**
   * Records the evidence an agent chose for each named field of its task,
   * and inserts the recorded literals into `template`. Every handle is
   * checked before anything is recorded; a constraint the choices break, or
   * a placeholder nothing is bound to, rejects the whole request.
   */
  bind(request = {}, actor) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw invalid('The request must be an object.');
    if (actor?.actorType !== 'AI_AGENT' || typeof actor.id !== 'string') {
      throw new AgentError('unauthorized', 'Bindings are recorded only for an agent identified by its connection.');
    }
    const task = text(request.task, 'task', { max: 160, optional: false });
    const chosen = request.bind ?? {};
    if (typeof chosen !== 'object' || Array.isArray(chosen) || Object.keys(chosen).length > MAX_BINDINGS) {
      throw invalid(`bind must map up to ${MAX_BINDINGS} field names to handles.`);
    }
    const template = text(request.template, 'template', { max: 100_000 });
    // Any citation style but "none" gets numbered citations, the one style there is.
    const cite = request.cite === 'none' || request.cite === false ? 'none' : 'numbers';
    for (const field of Object.keys(chosen)) {
      if (!FIELD_NAME.test(field)) throw invalid(`${field} is not a valid field name (letters, digits, _ . -).`);
    }
    const context = this.context();
    const fresh = Object.entries(chosen).map(([field, handle]) => [field, this.evidenceFor(context, this.resolveHandle(context, handle))]);
    const recorded = this.recordedBindings(context, task);
    const all = new Map([...recorded, ...fresh]);
    for (const [constraint, check] of [['same_record', sameRecord], ['same_source', sameSource]]) {
      const groups = request[constraint];
      if (groups == null) continue;
      if (!Array.isArray(groups) || groups.some((group) => !Array.isArray(group) || group.length < 2)) {
        throw invalid(`${constraint} must list groups of at least two field names.`);
      }
      for (const group of groups) {
        const missing = group.filter((field) => !all.has(field));
        if (missing.length) throw new AgentError('unbound', `${constraint} names unbound fields: ${missing.join(', ')}.`, { unbound: missing });
        const evidence = group.map((field) => all.get(field));
        if (!check(evidence)) {
          throw new AgentError('inconsistent', `${group.join(', ')} do not come from the same ${constraint === 'same_record' ? 'row' : 'file revision'}.`,
            { fields: Object.fromEntries(group.map((field) => [field, { path: all.get(field).path, at: all.get(field).at }])) });
        }
      }
    }
    const placeholders = template ? [...template.matchAll(PLACEHOLDER)].map((match) => match[1]) : [];
    const unbound = [...new Set(placeholders.filter((field) => !all.has(field)))];
    if (unbound.length) throw new AgentError('unbound', `The template uses fields nothing is bound to: ${unbound.join(', ')}.`, { unbound });

    if (fresh.length) {
      this.timeline.upsertActor(actor);
      const insert = this.db.prepare(`INSERT INTO agent_bindings(task_id, field, handle, actor_id, project_id, snapshot_id,
        object_id, path, content_hash, line_start, line_end, cell_json, value_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const at = now();
      transaction(this.db, () => {
        for (const [field, evidence] of fresh) {
          insert.run(task, field, evidence.handle, actor.id, evidence.projectId, evidence.snapshotId, evidence.objectId ?? null,
            evidence.path, evidence.contentHash, evidence.lineStart ?? null, evidence.lineEnd ?? null,
            evidence.cell ? JSON.stringify(evidence.cell) : null, evidence.value, at);
        }
        this.db.prepare(`UPDATE agent_evidence SET last_used_at = ? WHERE handle IN (${fresh.map(() => '?').join(',')})`)
          .run(at, ...fresh.map(([, evidence]) => evidence.handle));
      });
    }

    const citations = [];
    const numberOf = new Map();
    const citationFor = (evidence) => {
      if (!numberOf.has(evidence.handle)) {
        numberOf.set(evidence.handle, citations.length + 1);
        citations.push({ n: citations.length + 1, h: evidence.handle, folder: evidence.folder, path: evidence.path,
          ...(evidence.at ? { at: evidence.at } : {}), rev: rev(evidence.contentHash) });
      }
      return numberOf.get(evidence.handle);
    };
    const fields = Object.fromEntries([...all].map(([field, evidence]) => [field, { value: evidence.value,
      cite: citationFor(evidence), now: this.currentState(context, evidence) }]));
    const rendered = template == null ? null : template.replace(PLACEHOLDER, (_, field) => {
      const evidence = all.get(field);
      return cite === 'none' ? evidence.value : `${evidence.value} [${citationFor(evidence)}]`;
    });
    return { task, fields, citations, ...(rendered != null ? { text: rendered } : {}) };
  }

  /** The literal a handle stands for, exactly as recorded, with what checks need to compare. */
  evidenceFor(context, ref) {
    const folder = ref.project.name;
    if (ref.kind === 'object') {
      const object = this.dependencies.objectAt(ref.projectId, ref.snapshotId, ref.objectId);
      if (!object || object.versionId !== ref.versionId) throw new AgentError('expired_handle', `The version handle ${ref.handle} named is no longer recorded.`);
      const anchor = object.anchor ?? {};
      return { ...ref, folder, value: object.valueText ?? object.label, at: locatorOf(object),
        row: ['table-cell', 'table-row'].includes(anchor.kind) && Number.isInteger(anchor.rowIndex)
          ? `${object.path}|${object.metadata?.sheet ?? anchor.sheet ?? ''}|${anchor.rowIndex}|${ref.contentHash}` : null };
    }
    if (ref.kind === 'cell') {
      return { ...ref, folder, value: this.cellValue(ref).value, at: `row ${ref.cell.row + 1} · ${ref.cell.columnName}`,
        row: `${ref.path}|${ref.cell.sheet ?? ''}|${ref.cell.row}|${ref.contentHash}` };
    }
    if (ref.kind === 'lines') {
      const file = this.revisionFile(ref.project, ref.path, ref.contentHash, ref.projectFileId);
      const all = fileLines(this.textOf(file));
      return { ...ref, folder, value: all.slice(ref.lineStart - 1, ref.lineEnd).join('\n'),
        at: ref.lineStart === ref.lineEnd ? `line ${ref.lineStart}` : `lines ${ref.lineStart}-${ref.lineEnd}`, row: null };
    }
    throw new AgentError('unsupported', `Handle ${ref.handle} names a whole file; bind a value or a line range from it.`);
  }

  /** The task's earlier bindings, latest per field, re-authorized. */
  recordedBindings(context, task) {
    const rows = this.db.prepare(`SELECT b.* FROM agent_bindings b WHERE b.task_id = ?
      AND b.id = (SELECT MAX(id) FROM agent_bindings WHERE task_id = b.task_id AND field = b.field)`).all(task);
    return rows.flatMap((row) => {
      if (!this.allowed(context, row.project_id, row.path)) return [];
      const project = context.byId.get(row.project_id);
      const evidence = { handle: row.handle, projectId: row.project_id, snapshotId: row.snapshot_id, objectId: row.object_id,
        path: row.path, contentHash: row.content_hash, lineStart: row.line_start, lineEnd: row.line_end, folder: project.name,
        value: row.value_text, project, kind: row.object_id ? 'object' : row.cell_json ? 'cell' : 'lines',
        cell: row.cell_json ? JSON.parse(row.cell_json) : null };
      if (evidence.cell) {
        evidence.at = `row ${evidence.cell.row + 1} · ${evidence.cell.columnName}`;
        evidence.row = `${row.path}|${evidence.cell.sheet ?? ''}|${evidence.cell.row}|${row.content_hash}`;
      } else if (row.object_id) {
        const object = this.dependencies.objectAt(row.project_id, row.snapshot_id, row.object_id);
        const anchor = object?.anchor ?? {};
        evidence.at = object ? locatorOf(object) : null;
        evidence.versionId = object?.versionId ?? null;
        evidence.row = object && Number.isInteger(anchor.rowIndex)
          ? `${object.path}|${object.metadata?.sheet ?? anchor.sheet ?? ''}|${anchor.rowIndex}|${row.content_hash}` : null;
      } else {
        evidence.at = row.line_start === row.line_end ? `line ${row.line_start}` : `lines ${row.line_start}-${row.line_end}`;
        evidence.row = null;
      }
      return [[row.field, evidence]];
    });
  }

  /** Whether a bound value still reads the same at its folder's newest indexed snapshot. Never rebinds. */
  currentState(context, evidence) {
    const project = evidence.project ?? context.byId.get(evidence.projectId);
    if (!project?.snapshotId) return 'unknown';
    if (evidence.objectId) {
      const current = this.dependencies.objectAt(project.id, project.snapshotId, evidence.objectId);
      if (!current) return 'removed';
      return current.versionId === evidence.versionId || current.valueText === evidence.value ? 'same' : 'changed';
    }
    const file = this.timeline.snapshotFile(project.snapshotId, evidence.path);
    if (!file) return 'removed';
    if (file.contentHash === evidence.contentHash) return 'same';
    if (evidence.cell) {
      // Compared by position: a sorted or edited table can put another row there.
      try {
        return this.cellValue({ ...evidence, contentHash: file.contentHash }).value === evidence.value ? 'same (file changed)' : 'changed';
      } catch { return 'changed'; }
    }
    const lines = isTextualType(file.fileType) ? fileLines(this.timeline.blobs.get(file.contentHash).toString('utf8')) : [];
    return lines.slice(evidence.lineStart - 1, evidence.lineEnd).join('\n') === evidence.value ? 'same (file changed)' : 'changed';
  }

  // ── ask ──────────────────────────────────────────────────────────────────

  /**
   * Plain-language asks, each resolved here to the evidence that answers it:
   * exact lines, a whole definition, the named fields of a table row, a
   * passage, a file, earlier values. Finding and reading happen in this one
   * call, so an agent spends one round where search-then-read spent two or
   * three, and every later call re-reads one answer instead of several.
   * Nothing is chosen between sources that disagree: they come back
   * together, with what tells them apart.
   */
  ask(request = {}) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw invalid('The request must be an object.');
    const given = request.ask ?? request.asks ?? request.questions ?? request.queries ?? request.items ?? request.text;
    const listed = Array.isArray(given) ? given : given != null ? [given] : [];
    const asks = listed.flatMap((item) => (typeof item === 'string'
      ? splitAsk(item).map((part, index, parts) => ({ text: part, split: parts.length > 1 }))
      : [{ item }]));
    if (!asks.length || asks.length > MAX_ASKS) throw invalid(`ask must list 1 to ${MAX_ASKS} questions.`);
    const context = this.context();
    // A budget under 100 reads as a number of results ("budget": 5), not tokens of evidence: the default is used.
    context.budget = request.budget == null || Number(request.budget) < 100 ? null : count(request.budget, 'budget', { min: 100, max: 8000, fallback: ASK_BUDGET });
    const answers = asks.map((entry, index) => {
      // An ask split out of a longer one is echoed, so its answer can be told apart.
      const head = { n: index + 1, ...(entry.split ? { ask: entry.text } : {}) };
      try {
        return withStatus({ ...head, ...(entry.item ? this.askItem(context, entry.item) : this.resolveAsk(context, entry.text)) });
      } catch (error) {
        if (error instanceof AgentError) return { ...head, kind: 'error', status: error.code === 'ambiguous' ? 'ambiguous' : error.code === 'not_found' ? 'not_found' : 'error', error: error.toJSON() };
        throw error;
      }
    });
    dedupeAnswers(answers);
    const warnings = [...this.diskWarnings(context), ...this.recordHandles(context)];
    return { sources: this.sourcesOf(context), answers, ...(warnings.length ? { warnings } : {}) };
  }

  /** A structured follow-up: a handle, file or definition to read, or an explicit search. */
  askItem(context, item) {
    if (!item || typeof item !== 'object') throw invalid('Each ask is a string or an object.');
    if (item.op != null && GEOMETRY_OPS[String(item.op).toLowerCase()]) return this.askGeometryItem(context, item);
    if (item.op != null) {
      if (typeof item.column !== 'string' || !item.column.trim()) throw invalid('An operation names the column it works on: {op, column, file?}.');
      const answer = this.askAggregate(context, this.foldersNamed(context, item.folder), { original: '', words: [] }, item);
      if (!answer) throw new AgentError('not_found', `No shared table has a column named ${item.column}${item.file ? ` in ${item.file}` : ''} with values to ${item.op}.`);
      return answer;
    }
    const phrased = item.ask ?? item.question ?? item.q ?? item.query ?? item.text;
    if (typeof phrased === 'string' && item.h == null && item.file == null && item.symbol == null) {
      // An explicit search names what a search takes; anything else is an ask written as an object.
      if (typeof item.text === 'string' && SEARCH_KEYS.some((key) => item[key] != null)) {
        const [query] = this.normalizeQueries([item], DEFAULT_LIMIT);
        const { units, ...result } = this.page(context, query, DEFAULT_VALUE_CHARS);
        return { kind: 'matches', ...result };
      }
      return this.resolveAsk(context, phrased, item.folder);
    }
    try {
      return { kind: 'read', items: [this.inspectItem(context, item)] };
    } catch (error) {
      // {symbol: "MAX_RETRIES"}: a name only assigned a value is read from the line the index records.
      if (!(error instanceof AgentError) || error.code !== 'not_found' || typeof item.symbol !== 'string' || item.h != null || item.file != null) throw error;
      const assigned = this.namedLines(context, this.foldersNamed(context, item.folder), item.symbol, null);
      if (!assigned.length) throw error;
      return { kind: 'definition', items: assigned };
    }
  }

  resolveAsk(context, value, folder = null) {
    const parsed = parseAsk(text(value, 'ask', { max: 2000, optional: false }), context.projects.map((project) => project.name));
    if (folder != null && parsed.folder == null) parsed.folder = String(folder);
    const projects = this.foldersNamed(context, parsed.folder);
    if (parsed.ranges.length) return this.askLines(context, parsed);
    let asked = parsed;
    if (parsed.symbols.length) {
      const found = this.askDefinitions(context, projects, parsed);
      if (found) return found;
      // A code-shaped name defined nowhere is still a name to find ("API_TOKEN", "max_pool_size").
      asked = { ...parsed, content: [...parsed.content, ...parsed.symbols] };
    }
    if (asked.fileOnly) return this.askFiles(context, projects, asked);
    const placed = this.askGeometry(context, projects, asked);
    if (placed) return placed;
    const record = this.askRecord(context, projects, asked);
    if (record) return record;
    // A column's total answers that part of the ask exactly; the search answers the rest ("and how it compares with Q3"),
    // without the same table again, and says what it is (ranked, what it left out, words no file has).
    const computed = this.askAggregate(context, projects, asked);
    if (computed) {
      const search = this.askSearch(context, projects, asked);
      const sources = new Set(computed.items.map((item) => item.src));
      const more = (search?.items ?? []).filter((item) => !(item.type === 'table' && sources.has(item.src)));
      return more.length ? { ...search, kind: 'computed', items: [...computed.items, ...more] } : computed;
    }
    return this.askSearch(context, projects, asked) ?? this.askFind(context, projects, asked);
  }

  /**
   * The one file a mention names, as resolveFile settles it. A name written
   * unquoted with spaces ("Operating budget.xlsx") is tried with the words
   * before it when the bare name is not found.
   */
  resolveMention(context, mention, parsed) {
    const found = this.mentionedFile(context, mention, parsed);
    // A file asked for without a revision is the file as it is now: one changed since
    // indexing is read from disk, and its source says so ("read from disk now, not indexed").
    if (!parsed.revision && !parsed.disk && !found.file.disk && !found.file.historical && isTextualType(found.file.fileType)
      && this.diskState(context, found.project, found.file) === 'changed') {
      try {
        return { project: found.project, file: this.diskFile(found.project, found.file) };
      } catch (error) {
        if (!(error instanceof AgentError)) throw error;
      }
    }
    return found;
  }

  mentionedFile(context, mention, parsed) {
    const item = { folder: parsed.folder, ...(parsed.revision ? { rev: parsed.revision } : {}), ...(parsed.disk ? { version: 'disk' } : {}) };
    try {
      return this.resolveFile(context, { ...item, file: mention.name });
    } catch (error) {
      if (!(error instanceof AgentError)) throw error;
      if (error.code === 'ambiguous') {
        // "Admin app.py", "the worker app.py": a word of the ask names one candidate's folder or directory.
        const said = new Set(askWords(parsed.original).map((word) => word.toLowerCase()));
        for (const part of askWords(mention.name)) said.delete(part.toLowerCase());
        const scored = (error.details?.matches ?? []).map((match) => ({ match,
          hits: [match.folder, ...match.path.split('/').slice(0, -1)].filter((part) => said.has(part.toLowerCase())).length }));
        const most = Math.max(0, ...scored.map((entry) => entry.hits));
        const named = scored.filter((entry) => entry.hits === most);
        if (most > 0 && named.length === 1) {
          return this.resolveFile(context, { ...item, folder: named[0].match.folder, file: named[0].match.path });
        }
        throw error;
      }
      if (error.code !== 'not_found') throw error;
      for (let count = 1; count <= mention.before.length; count += 1) {
        try { return this.resolveFile(context, { ...item, file: `${mention.before.slice(-count).join(' ')} ${mention.name}` }); }
        catch (inner) { if (!(inner instanceof AgentError) || inner.code !== 'not_found') throw inner; }
      }
      throw error;
    }
  }

  askLines(context, parsed) {
    if (!parsed.files.length) throw invalid('Name the file the lines are in, as in "app.py lines 5-12".');
    const withRanges = parsed.files.filter((mention) => mention.ranges.length);
    const mentions = withRanges.length ? withRanges : [{ ...parsed.files[0], ranges: parsed.ranges }];
    const items = [];
    for (const mention of mentions) {
      const { project, file } = this.resolveMention(context, mention, parsed);
      for (const range of mention.ranges) {
        try {
          items.push(this.lines(context, project, file, range, 0, false));
        } catch (error) {
          if (!(error instanceof AgentError)) throw error;
          items.push({ error: error.toJSON() });
        }
      }
    }
    return { kind: 'lines', items };
  }

  /** Definitions by name; a name only assigned a value ("MAX_RETRIES = 7") is read from the line the index records. */
  askDefinitions(context, projects, parsed) {
    const scoped = parsed.files.length ? this.tryMention(context, parsed.files[0], parsed) : null;
    const items = [];
    let found = 0;
    for (const name of parsed.symbols) {
      try {
        items.push(scoped ? this.symbol(context, scoped.project, scoped.file, name, 0, false)
          : this.symbolAnywhere(context, { symbol: name, folder: parsed.folder }, 0, false));
        found += 1;
      } catch (error) {
        if (!(error instanceof AgentError)) throw error;
        if (error.code === 'ambiguous') { items.push({ symbol: name, error: error.toJSON() }); found += 1; continue; }
        const assigned = this.namedLines(context, projects, name, scoped);
        if (assigned.length) { items.push(...assigned); found += 1; } else items.push({ symbol: name, error: error.toJSON() });
      }
    }
    return found ? { kind: 'definition', items } : null;
  }

  /** A STEP file revision's parsed model, or null when it cannot be read as one. */
  stepModel(file) {
    if (!this.stepModels.has(file.contentHash)) {
      let model = null;
      try { model = readStepModel(file.buffer ?? this.timeline.blobs.get(file.contentHash)); } catch { model = null; }
      this.stepModels.set(file.contentHash, model);
    }
    return this.stepModels.get(file.contentHash);
  }

  /**
   * Part instances of an assembly the ask names ("Pin:2 relative to Pin:1 in fixture assembly.step", "where is
   * Pin:2"): two, how the second stands to the first; one, where it sits in the assembly. The assembly is the
   * file the ask names, or the shared STEP files that have the instances. Null when the ask names no instance.
   */
  askGeometry(context, projects, parsed) {
    if (!INSTANCE_LIKE.test(parsed.original)) return null;
    const named = parsed.files.length ? this.tryMention(context, parsed.files[0], parsed) : null;
    if (named && !STEP_FILE.test(named.file.path)) return null;
    const candidates = named ? [named] : projects.flatMap((project) => (project.snapshotId ? this.timeline.snapshotFiles(project.snapshotId) : [])
      .filter((file) => STEP_FILE.test(file.path) && file.size <= UNNAMED_STEP_BYTES && this.allowed(context, project.id, file.path))
      .map((file) => ({ project, file: this.snapshotFile(context, project, file.path) })).filter((entry) => entry.file)).slice(0, 10);
    const found = [];
    for (const candidate of candidates) {
      const model = this.stepModel(candidate.file);
      if (!model) continue;
      const instances = instancesOf(model);
      const { named: mentioned, ambiguous } = namedInstances(instances, parsed.original);
      if (ambiguous.length) {
        throw new AgentError('ambiguous', `${ambiguous.map((entry) => `"${entry.label}" names ${entry.paths.length} instances in ${candidate.file.path}: ${entry.paths.join(', ')}`).join('; ')}. Name one by its path.`);
      }
      if (mentioned.length) found.push({ ...candidate, model, instances, mentioned });
    }
    if (!found.length) return null;
    if (found.length > 1) {
      throw new AgentError('ambiguous', `Instances named so are in several assemblies: ${found.map((entry) => entry.file.path).join(', ')}. Name the file.`);
    }
    const [{ project, file, model, mentioned }] = found;
    if (mentioned.length === 1) return { kind: 'geometry', status: 'complete', items: [this.placementItem(context, project, file, model, mentioned[0])] };
    // The instance right after "relative to" or "from" is the one the other is seen from; otherwise, the first named.
    const folded = foldAsk(parsed.original);
    const reference = folded.search(SEEN_FROM);
    const [first, second] = mentioned;
    const after = (instance) => folded.indexOf(foldAsk(instance.label), reference) > reference;
    const [a, b] = reference >= 0 && after(second) && folded.indexOf(foldAsk(first.label)) < reference ? [second, first] : [first, second];
    return { kind: 'geometry', status: 'complete', items: [this.relationItem(context, project, file, model, a, b)] };
  }

  /** {op: "pose"|"angle", file, a, b}: two instances of the assembly in file, by label or path. */
  askGeometryItem(context, item) {
    if (typeof item.file !== 'string' || !item.file.trim() || typeof item.a !== 'string' || typeof item.b !== 'string') {
      throw invalid('A placement operation names the assembly and two instances: {op: "pose", file, a, b}.');
    }
    const resolved = this.resolveMention(context, { name: item.file.trim() }, { original: item.file, folder: item.folder ?? null });
    if (!STEP_FILE.test(resolved.file.path)) throw new AgentError('unsupported', `${resolved.file.path} is not a STEP assembly.`);
    const model = this.stepModel(resolved.file);
    if (!model) throw new AgentError('unsupported', `${resolved.file.path} could not be read as a STEP model.`);
    const instances = instancesOf(model);
    const pick = (name) => {
      const wanted = foldAsk(name);
      const matches = instances.filter((instance) => foldAsk(instance.label) === wanted || foldAsk(instance.path) === wanted
        || foldAsk(instance.path.split('/').slice(1).join('/')) === wanted);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) throw new AgentError('ambiguous', `"${name}" names ${matches.length} instances: ${matches.map((match) => match.path).join(', ')}.`);
      throw new AgentError('not_found', `No instance "${name}" in ${resolved.file.path}; it has ${instances.slice(0, DIGEST_INSTANCES).map((instance) => instance.label).join(', ')}${instances.length > DIGEST_INSTANCES ? ', …' : ''}.`);
    };
    const relation = this.relationItem(context, resolved.project, resolved.file, model, pick(item.a), pick(item.b));
    return { kind: 'geometry', status: 'complete', items: [GEOMETRY_OPS[String(item.op).toLowerCase()] === 'angle' ? { ...relation, only: 'angles' } : relation] };
  }

  /** Where one instance sits in its assembly, as the parser placed it; refused when a placement is in doubt. */
  placementItem(context, project, file, model, instance) {
    if (!instance.placement) {
      throw new AgentError('unsupported', `The placement of "${instance.label}" in ${file.path} is not settled (${(model.warnings ?? []).join('; ') || 'not a rotation and a translation'}).`);
    }
    return { src: this.sourceFor(context, project, file), type: 'placement', instance: instance.label, path: instance.path, part: instance.part,
      unit: model.unit.convertedToMm ? 'mm' : model.unit.label, at: instance.placement.at, ...(instance.placement.turn ? { turn: instance.placement.turn } : {}) };
  }

  /** How instance b stands to instance a, computed by the structural geometry operators over their placements. */
  relationItem(context, project, file, model, a, b) {
    let relation;
    try {
      relation = relationOf(model, a, b, { id: `${project.id}:${file.path}`, revision: file.contentHash });
    } catch (error) {
      if (error instanceof StructuralAdapterError) throw new AgentError('unsupported', `${file.path}: ${error.message}`);
      throw error;
    }
    return { src: this.sourceFor(context, project, file), type: 'relation', a: a.label, b: b.label, unit: relation.unit, offset: relation.offset,
      distance: relation.distance, ...(relation.turn ? { turn: relation.turn } : {}), angles: relation.angles,
      ...(a.placement ? { a_at: a.placement.at } : {}), ...(b.placement ? { b_at: b.placement.at } : {}) };
  }

  tryMention(context, mention, parsed) {
    try { return this.resolveMention(context, mention, parsed); } catch (error) {
      if (error instanceof AgentError) return null;
      throw error;
    }
  }

  namedLines(context, projects, name, scoped) {
    const items = [];
    for (const project of scoped ? [scoped.project] : projects) {
      if (!project.snapshotId) continue;
      for (const match of this.graph.search(project.id, name, { snapshotId: project.snapshotId, limit: 20, diversify: false })) {
        const object = match.object;
        if (object.anchor?.kind !== 'line' || (object.metadata?.symbol ?? object.label) !== name) continue;
        if ((scoped && object.path !== scoped.file.path) || !this.allowed(context, project.id, object.path)) continue;
        const file = this.snapshotFile(context, project, object.path);
        if (file) items.push({ ...this.lines(context, project, file, [object.anchor.line, object.anchor.line], 0, false), symbol: name });
      }
    }
    return items.slice(0, 5);
  }

  askFiles(context, projects, parsed) {
    // One file named, not asked where it is: its text when small, else its outline.
    if (parsed.files.length === 1 && !LOCATE.test(parsed.original)) {
      try {
        return this.askWholeFile(context, this.resolveMention(context, parsed.files[0], parsed));
      } catch (error) {
        if (!(error instanceof AgentError) || error.code !== 'not_found') throw error;
      }
    }
    const items = [];
    for (const mention of parsed.files) {
      const ranked = this.rankFiles(context, projects, { text: mention.name, kind: 'file' }).units;
      const named = ranked.filter((unit) => unit.tier <= 2);
      for (const unit of (named.length ? named : ranked).slice(0, 10)) items.push(this.project(context, unit, {}, DEFAULT_VALUE_CHARS));
    }
    return items.length ? { kind: 'files', items }
      : { kind: 'none', looked_for: parsed.files.map((mention) => mention.name), named: true, files: this.sharedFileCount(context, projects), items: [] };
  }

  /**
   * Rows the ask names by their label: every span of its words, longest
   * first, looked up among labelled table rows (and large tables' row
   * index). Only the longest spans that name a row are kept.
   */
  askEntities(context, projects, parsed) {
    const tokens = parsed.words;
    const spans = [];
    for (let length = Math.min(6, tokens.length); length >= 1; length -= 1) {
      for (let start = 0; start + length <= tokens.length; start += 1) {
        const span = tokens.slice(start, start + length);
        if (span.every((word) => STOPWORDS.has(word.toLowerCase()))) continue;
        if (length === 1 && (span[0].length < 2 || STOPWORDS.has(span[0].toLowerCase()))) continue;
        spans.push({ length, text: span.join(' ') });
      }
    }
    const found = new Map();
    const add = (entity) => {
      const key = `${entity.project.id}|${entity.path}|${entity.sheet ?? ''}|${entity.rowIndex}`;
      if (!found.has(key) || found.get(key).span.length < entity.span.length) found.set(key, entity);
    };
    for (const project of projects) {
      if (!project.snapshotId) continue;
      const table = this.rowTable(project, project.snapshotId);
      // Names that share their last words ("North and South division") are each that name: "North division" too.
      const shared = [];
      for (const span of spans) {
        if (span.length < 2 || !table.byLabel.has(foldAsk(span.text))) continue;
        const parts = span.text.split(' ');
        for (let index = tokens.indexOf(parts[0]) - 1, listed = 0; index >= 0 && listed < 4; index -= 1) {
          if (/^(?:and|or|&)$/i.test(tokens[index])) continue;
          if (STOPWORDS.has(tokens[index].toLowerCase())) break;
          shared.push({ length: span.length, text: [tokens[index], ...parts.slice(1)].join(' ') });
          listed += 1;
        }
      }
      for (const span of [...spans, ...shared]) {
        for (const key of table.byLabel.get(foldAsk(span.text)) ?? []) {
          const cells = table.byRow.get(key);
          const first = cells[0];
          if (!this.allowed(context, project.id, first.path)) continue;
          add({ project, span, cells, path: first.path, sheet: first.metadata?.sheet ?? first.anchor?.sheet ?? null,
            rowIndex: first.anchor.rowIndex, label: String(first.anchor.rowKey ?? first.metadata?.row) });
        }
      }
      for (const large of this.dependencies.snapshotTables(project.id, project.snapshotId)) {
        if (!this.allowed(context, project.id, large.file.path)) continue;
        for (const span of spans) {
          const wanted = normalizedRowSearch(span.text);
          if (wanted.length < 3) continue;
          for (const row of this.dependencies.tables.search(large.meta.id, span.text, 5)) {
            const label = String(row.cells[large.meta.shape.labelColumn] ?? '').trim();
            if (normalizedRowSearch(label) !== wanted) continue;
            const cells = this.dependencies.indexedRowObjects(large, row).map((descriptor) => cellObject(descriptor, project, large))
              .filter((object) => object.anchor?.kind === 'table-cell');
            if (cells.length) add({ project, span, cells, path: large.file.path, sheet: large.sheet ?? null, rowIndex: cells[0].anchor.rowIndex, label });
          }
        }
      }
    }
    const all = [...found.values()];
    const longest = Math.max(0, ...all.map((entity) => entity.span.length));
    return all.filter((entity) => entity.span.length === longest);
  }

  /**
   * A table row the ask names, with the columns it names ("balance of
   * Account 104233"), or the whole row when it names none. Other words are
   * qualifiers: a row whose file or values match more of them ("approved
   * budget") is put first, the others are still shown, and rows that match
   * equally but disagree are said to disagree. Lasso never picks among them.
   */
  askRecord(context, projects, parsed) {
    const entities = this.askEntities(context, projects, parsed);
    if (!entities.length) return null;
    const asked = foldAsk(parsed.words.join(' '));
    const content = [...new Set(parsed.content.map(foldAsk).flatMap((word) => word.split(' ')).filter(Boolean))];
    const rows = entities.map((entity) => {
      const label = foldAsk(entity.span.text);
      const rest = ` ${asked} `.replace(` ${label} `, ' ').trim();
      const columns = [...new Set(entity.cells.map((cell) => String(cell.anchor?.column ?? cell.metadata?.column ?? '')).filter(Boolean))];
      const fields = columns.filter((column) => namesHeader(rest, column))
        .sort((left, right) => rest.indexOf(foldAsk(left)) - rest.indexOf(foldAsk(right)));
      const used = new Set([...label.split(' '), ...fields.flatMap((field) => foldAsk(field).split(' '))]);
      const qualifiers = content.filter((word) => !used.has(word) && !used.has(word.replace(/s$/, '')) && !ANSWER_WORDS.has(word));
      const haystack = ` ${foldAsk([entity.path, entity.sheet ?? '', ...entity.cells.map((cell) => cell.valueText ?? '')].join(' '))} `;
      const matched = qualifiers.filter((word) => haystack.includes(` ${word} `));
      return { ...entity, fields, matched, unmatched: qualifiers.length - matched.length };
    });
    // A row named by a word the rest of the ask has little to do with ("West region sales", "supplier performance
    // review November 2025") is not what was asked about: no column named, and more words left over than found in it.
    const strong = rows.filter((row) => row.fields.length || row.unmatched <= 1 || row.matched.length >= row.unmatched);
    if (!strong.length) return null;
    const named = strong.filter((row) => row.fields.length);
    // Rows with different labels ("October, November and December") are each asked for; only rows with the
    // same label in different sources can disagree.
    const groups = new Map();
    for (const row of named.length ? named : strong) {
      const label = foldAsk(row.label);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(row);
    }
    const answers = [...groups.entries()].sort(([left], [right]) => asked.indexOf(left) - asked.indexOf(right))
      .slice(0, MAX_LABELS).map(([, group]) => this.recordGroup(context, group, parsed));
    return answers.length === 1 ? { kind: 'record', ...answers[0] } : { kind: 'records', groups: answers };
  }

  /** One label's rows: one row, or the sources that have it, the best-matching first, with whether they agree. */
  recordGroup(context, group, parsed) {
    const pool = group.sort((left, right) => right.matched.length - left.matched.length || right.fields.length - left.fields.length
      || left.path.localeCompare(right.path) || left.rowIndex - right.rowIndex).slice(0, 6);
    const items = pool.map((row) => this.recordItem(context, row, parsed));
    if (items.length === 1) return { items };
    const tied = pool.filter((row) => row.matched.length === pool[0].matched.length).length;
    const valuesOf = (item) => JSON.stringify(Object.values(item.fields).map((field) => field.value));
    const verdict = tied === 1 ? 'best'
      : new Set(items.slice(0, tied).map(valuesOf)).size === 1 ? 'agree' : 'differ';
    return { verdict, ...(verdict === 'best' ? { matched: pool[0].matched } : {}), items };
  }

  recordItem(context, row, parsed) {
    const { project } = row;
    const file = this.snapshotFile(context, project, row.path);
    const src = file ? this.source(context, project, file) : null;
    const chosen = row.fields.length ? row.fields.map((name) => [name, matchField(row.cells, name)])
      : row.cells.slice(0, ROW_PREVIEW_COLUMNS).map((cell) => [String(cell.anchor?.column ?? cell.metadata?.column), cell]);
    const fields = {};
    for (const [name, cell] of chosen) {
      if (!cell) continue;
      const ref = this.objectRef(context, project, cell);
      const entry = { ...(ref ? { h: this.issue(context, ref) } : {}), value: cell.valueText };
      // Asked what it was before: the captured versions, newest first, from this one.
      if (parsed.history && cell.id && !cell.cell) {
        const versions = this.graph.history(project.id, cell.id);
        if (versions.length) entry.v = versions[0].projectVersion;
        if (versions.length > 1) entry.was = versions.slice(1, 4).map((version) => ({ v: version.projectVersion, at: version.recordedAt, value: version.value }));
        else entry.was = [];
      }
      fields[name] = entry;
    }
    const first = row.cells[0];
    return { src, type: 'record', row: row.label, at: locatorOf({ ...first, anchor: { ...first.anchor, kind: 'table-row' } }), fields,
      ...(!row.fields.length && row.cells.length > ROW_PREVIEW_COLUMNS ? { more_fields: row.cells.length - ROW_PREVIEW_COLUMNS } : {}) };
  }

  /**
   * Everything else: the words to find, scoped to a file the ask names.
   * An answer is a hit that contains every word that says what to find
   * (not words such as "date" that say what kind of answer is wanted), in
   * any of its forms ("diameters", "Q4" as the fourth quarter or its months).
   * An ask every word of which a file's name or title has is about that file
   * and is answered with what it holds. Hits are shown by file: a table's
   * matching cells as rows, a model's measurements by part or room, a
   * document's passages. When no hit has every word, the answer says which
   * words no shared file has, answers the rest if it can, and otherwise
   * shows the closest hits; partial matches are never passed off as the
   * thing asked about.
   */
  askFind(context, projects, parsed) {
    let scope = projects;
    let under = null;
    const named = parsed.files.length ? this.tryMention(context, parsed.files[0], parsed) : null;
    if (named) { scope = [named.project]; under = named.file.path; }
    const content = parsed.content;
    if (!content.length) {
      if (named) return this.askWholeFile(context, named);
      throw invalid('Say what to look for: a name, a value, a passage, lines of a file or a definition.');
    }
    const words = [...new Set(content.map(foldAsk).flatMap((word) => word.split(' ')).filter(Boolean))];
    const needed = words.filter((word) => !ANSWER_WORDS.has(word));
    const required = needed.length ? needed : words;
    const forms = new Map(required.map((word) => [word, alternativesOf(word)]));
    const stems = new Map(required.map((word) => [word, stemOf(word)]));
    const covered = (haystack, word, rowLabel = null) => forms.get(word).some((form) => (MONTH_NAMES.has(form) && form !== word
      ? rowLabel === form : haystack.includes(` ${form} `))) || (stems.get(word) != null && haystack.includes(` ${stems.get(word)}`));
    // Every word of the ask in a file's name or title, the named one if one is named: the ask is about that file.
    const subjects = named ? this.subjectFiles(context, [named.project], required, covered, named.file.path) : this.subjectFiles(context, scope, required, covered);
    if (subjects.length) return { kind: 'digest', items: subjects.flatMap((subject) => this.digestItems(context, subject)) };
    const query = [...content, ...required.flatMap((word) => forms.get(word).slice(1))].join(' ');
    const ranked = this.rank(context, scope, { text: query, kind: 'any', under, ext: null, fields: null });
    // A table cell also answers to its table's label column ("Department", "Month"); a building model's element to its type ("space").
    const labelColumns = new Map();
    const labelColumnOf = (project, object) => {
      const key = `${project.id}|${object.path}|${object.anchor.sheet ?? ''}`;
      if (!labelColumns.has(key)) {
        labelColumns.set(key, this.objectsOfFile(project, object.path).filter((column) => column.anchor?.kind === 'table-column'
          && (column.anchor.sheet ?? '') === (object.anchor.sheet ?? '')).sort((left, right) => left.anchor.columnIndex - right.anchor.columnIndex)[0]?.anchor.column ?? '');
      }
      return labelColumns.get(key);
    };
    const haystackOf = (object, project) => ` ${foldAsk(`${object.searchText ?? ''} ${object.valueText ?? ''} ${object.label ?? ''} ${object.path ?? ''} ${
      String(object.metadata?.entityType ?? '').replace(/^ifc/i, '')} ${object.anchor?.kind === 'table-cell' && project ? labelColumnOf(project, object) : ''}`)} `;
    const rowLabelOf = (object) => (['table-cell', 'table-row'].includes(object.anchor?.kind) ? foldAsk(String(object.anchor.rowKey ?? '')) : null);
    const has = (unit, word) => unit.object != null && covered(haystackOf(unit.object, unit.project), word, rowLabelOf(unit.object));
    const coverOf = (unit, wanted) => wanted.filter((word) => has(unit, word));
    const scored = ranked.units.filter((unit) => unit.object && !isWholeFileObject(unit.object)).slice(0, 400)
      .map((unit) => ({ unit, hits: coverOf(unit, required) }));
    const found = (wanted) => {
      const full = scored.filter((entry) => wanted.every((word) => entry.hits.includes(word)) || coverOf(entry.unit, wanted).length === wanted.length);
      return full.length ? this.foundAnswer(context, full, wanted) : null;
    };
    const answer = found(required);
    if (answer) return answer;
    if (named) {
      const whole = this.askWholeFile(context, named, true) ?? (isTextualType(named.file.fileType) ? null : this.fileDigest(context, named.project, named.file));
      if (whole) return whole;
    }
    // Which words no shared file has at all is checked word by word, so "none has" is said of the
    // folders searched, not of the closest hit: a file with "west wing" but nothing else asked for has "west".
    const seen = new Set(scored.flatMap((entry) => entry.hits));
    const missing = required.filter((word) => !seen.has(word)
      && !this.rank(context, scope, { text: forms.get(word).join(' '), kind: 'any', under, ext: null, fields: null }).units.slice(0, 80)
        .some((unit) => has(unit, word)));
    const searched = under ? { file: `${named.project.name}/${under}` } : { files: this.sharedFileCount(context, scope) };
    // A row asked for by a label no row has ("West division"): the rows labelled like it, which is what a reader checks next.
    const like = this.labelsLike(context, scope, under, parsed.words);
    // Otherwise the most of the ask that hits have together is answered, and what they lack is said first:
    // words no shared file has, or words no hit has with the rest ("rooms" and "floor areas", not "house").
    if (!like) {
      const subsets = new Map();
      for (const entry of scored) {
        if (entry.hits.length < Math.max(1, required.length - 1 - missing.length) || !entry.hits.length) continue;
        const key = entry.hits.join(' ');
        subsets.set(key, (subsets.get(key) ?? 0) + 1);
      }
      // Of subsets as large, the one whose words are rarest among the hits says the most: "region" over "sales"
      // when "sales" is in every cell of a "Cost of sales" column.
      const frequency = new Map();
      for (const entry of scored) for (const word of entry.hits) frequency.set(word, (frequency.get(word) ?? 0) + 1);
      const weight = (key) => key.split(' ').reduce((total, word) => total + Math.log(1 + scored.length / (frequency.get(word) ?? 1)), 0);
      const [subset] = [...subsets.entries()].sort(([left, leftCount], [right, rightCount]) => right.split(' ').length - left.split(' ').length
        || weight(right) - weight(left) || rightCount - leftCount)[0] ?? [];
      const rest = subset ? subset.split(' ') : [];
      const usable = rest.length && (rest.length >= 2 || rest.length === required.length - missing.length);
      // What the hits have in common may be a file's name or title ("the operations meeting on 4 December"): that file, whole.
      const subjects = usable ? (named ? this.subjectFiles(context, [named.project], rest, covered, named.file.path) : this.subjectFiles(context, scope, rest, covered)) : [];
      const partial = subjects.length ? { kind: 'digest', items: subjects.flatMap((subject) => this.digestItems(context, subject)) }
        : usable ? found(rest) : null;
      if (partial) return { ...partial, missing: required.filter((word) => !rest.includes(word)), absent: missing, ...searched };
    }
    // Beside rows labelled like the one asked for, a closest hit is shown only if it has the word that sets that label apart.
    const listed = new Set(like?.rows?.map(foldAsk) ?? []);
    const pool = like?.rows ? scored.filter((entry) => !listed.has(rowLabelOf(entry.unit.object)) && has(entry.unit, like.word)) : scored;
    const best = Math.max(0, ...pool.map((entry) => entry.hits.length));
    const closest = best ? pool.filter((entry) => entry.hits.length === best).slice(0, 3) : [];
    return { kind: 'none', looked_for: required, ...(missing.length ? { missing } : {}), ...searched, ...(like ? { like } : {}),
      items: closest.map(({ unit }) => this.project(context, unit, {}, ANSWER_CHARS)) };
  }

  /**
   * Hits that have every word, by file: the files with the best hits first,
   * at most FOUND_FILES. In each, a table's cells come back as its matching
   * rows, a model's measurements by part or room, and up to PASSAGES_PER_FILE
   * passages or lines, words asked together first, then those that state a
   * figure or date, then the most focused.
   */
  foundAnswer(context, full, wanted) {
    const pairs = wanted.slice(1).map((word, index) => ` ${wanted[index]} ${word} `);
    const textOf = (unit) => foldAsk(`${unit.object?.valueText ?? ''} ${unit.object?.label ?? ''}`);
    const together = (unit) => pairs.filter((pair) => ` ${textOf(unit)} `.includes(pair)).length;
    const focus = (unit) => wanted.length / Math.max(wanted.length, foldAsk(unit.object?.valueText ?? unit.object?.label ?? '').split(' ').length);
    const states = (unit) => (/\d/.test(unit.object?.valueText ?? '') ? 1 : 0);
    const ranked = full.map((entry) => ({ ...entry, together: together(entry.unit), focus: focus(entry.unit), states: states(entry.unit) }))
      .sort((left, right) => right.together - left.together || right.states - left.states || right.focus - left.focus);
    const files = new Map();
    for (const entry of ranked) {
      const key = `${entry.unit.project.id}|${entry.unit.object.path}`;
      if (!files.has(key)) files.set(key, []);
      files.get(key).push(entry);
    }
    const items = [];
    let shown = 0;
    for (const entries of [...files.values()].slice(0, FOUND_FILES)) {
      const { project } = entries[0].unit;
      const file = this.snapshotFile(context, project, entries[0].unit.object.path);
      // A row that matched stands for its cells.
      const cells = entries.filter((entry) => ['table-cell', 'table-row'].includes(entry.unit.object.anchor?.kind));
      const properties = entries.filter((entry) => entry.unit.object.anchor?.kind === 'cad-property');
      const others = entries.filter((entry) => !cells.includes(entry) && !properties.includes(entry));
      if (file && cells.length > 1) items.push(...this.tableItems(context, project, file, this.wholeRows(project, cells.map((entry) => entry.unit.object))));
      else others.unshift(...cells);
      if (file && properties.length) items.push(this.modelItem(context, project, file, this.wholeElements(project, file, properties.map((entry) => entry.unit.object))));
      const passages = others.filter((entry) => entry.focus >= (others[0]?.focus ?? 0) / 2).slice(0, PASSAGES_PER_FILE);
      items.push(...passages.map(({ unit }) => this.project(context, unit, {}, ANSWER_CHARS)));
      shown += (file && cells.length > 1 ? cells.length : 0) + (file ? properties.length : 0) + passages.length;
    }
    return { kind: 'found', items, ...(ranked.length > shown ? { more: ranked.length - shown } : {}) };
  }

  /**
   * Files every word of the ask names, by their path or title ("the supplier
   * review", "Revenue 2025"): one or two of them; more say too little to
   * read any one whole.
   */
  subjectFiles(context, projects, required, covered, only = null) {
    const subjects = [];
    for (const project of projects) {
      if (!project.snapshotId) continue;
      for (const file of only ? [this.snapshotFile(context, project, only)].filter(Boolean) : this.timeline.snapshotFiles(project.snapshotId)) {
        if (!this.allowed(context, project.id, file.path)) continue;
        const named = ` ${foldAsk(`${project.name} ${file.path.replace(/\.[^./]+$/, '')}`)} `;
        const title = () => ` ${foldAsk(this.titleOf(project, file.path))} `;
        if (required.every((word) => covered(named, word)) || required.every((word) => covered(named, word) || covered(title(), word))) {
          subjects.push({ project, file });
          if (subjects.length > 2) return [];
        }
      }
    }
    return subjects;
  }

  /** A file's title as its index records it: a document's or model's name. */
  titleOf(project, filePath) {
    const whole = this.objectsOfFile(project, filePath).find((object) => isWholeFileObject(object) && object.anchor?.kind !== 'table-column');
    return [whole?.metadata?.title, whole?.valueText, whole?.label].filter((value) => typeof value === 'string').join(' ');
  }

  /** A snapshot's indexed objects of one file, read once per snapshot. */
  objectsOfFile(project, filePath) {
    return this.snapshotObjects(project).get(filePath) ?? [];
  }

  /** A snapshot's indexed objects by file path, with `versions`: each object by its version id. */
  snapshotObjects(project) {
    let byPath = this.fileObjectCache.get(project.snapshotId);
    if (!byPath) {
      byPath = new Map();
      byPath.versions = new Map();
      for (const object of this.dependencies.objectsAt(project.id, project.snapshotId)) {
        if (!byPath.has(object.path)) byPath.set(object.path, []);
        byPath.get(object.path).push(object);
        if (object.versionId) byPath.versions.set(object.versionId, object);
      }
      byPath.weight = byPath.versions.size || [...byPath.values()].reduce((total, objects) => total + objects.length, 0);
      this.fileObjectCache.set(project.snapshotId, byPath);
    }
    return byPath;
  }

  /** The library's full-text index (text-index.js), opened on first use; null when it cannot be. */
  get textIndex() {
    if (this.index === undefined) {
      try {
        this.index = new TextIndex(this.dependencies.db, this.timeline.config.dataDir,
          (contentHash, filePath) => readStructure(this.timeline.blobs.get(contentHash), filePath));
      } catch { this.index = null; }
    }
    return this.index;
  }

  close() {
    this.index?.close();
  }

  /**
   * A file revision's structure, read once from its bytes: a PDF's or Word
   * document's headings (each `{ at, text }`, `at` as readingOrder orders
   * passages) and a PDF's table rows as passage-like units with their caption
   * and header. Other files have none.
   */
  structureOf(file) {
    if (!this.structures.has(file.contentHash)) {
      let parts = null;
      try {
        parts = this.textIndex?.partsOf(file.contentHash) ?? null;
        if (!parts) {
          const read = readStructure(this.timeline.blobs.get(file.contentHash), file.path);
          parts = [...read.headings.map((heading) => ({ ...heading, kind: 'heading', body: heading.text })), ...read.rows.map((row) => ({ ...row, kind: 'row', body: row.text }))];
        }
      } catch { parts = []; /* no structure can be read: passages stand without headings */ }
      this.structures.set(file.contentHash, {
        headings: parts.filter((part) => part.kind === 'heading').map((part) => ({ at: [part.page ?? 0, part.line ?? 0, part.start ?? 0], text: part.body })),
        rows: parts.filter((part) => part.kind === 'row').map((part) => ({
          id: `row:${file.contentHash}:${part.page}:${part.start}`, valueText: part.body, path: file.path,
          anchor: { kind: 'pdf-excerpt', pageNumber: part.page, start: part.start },
          metadata: { excerptType: 'table-row', caption: part.caption, header: part.header } })),
      });
    }
    return this.structures.get(file.contentHash);
  }

  /** Shared files Lasso recorded it could not read (damaged, password-protected, a scan without text, too large): at most five. */
  notSearched(context, projects, under = null) {
    const found = [];
    for (const project of projects) {
      let rows = [];
      try {
        rows = this.dependencies.db.prepare('SELECT path, reason FROM index_failures WHERE project_id = ? AND resolved_at IS NULL ORDER BY path').all(project.id);
      } catch { /* a library without the table has recorded none */ }
      for (const row of rows) {
        if (!this.allowed(context, project.id, row.path) || (under && row.path !== under)) continue;
        found.push({ path: `${project.name}/${row.path}`, reason: String(row.reason ?? 'not readable').split(/[.;]/)[0].slice(0, 60) });
      }
    }
    return found.slice(0, 5);
  }

  /**
   * A total, mean, maximum, minimum or count over a table column, worked out
   * from every row: complete for that table, with the rows it covers and,
   * for a small table, each row's value, so it can be checked. Each table
   * with such a column is answered; none is chosen. `explicit` is
   * `{ op, column, file?, where? }`; otherwise the operation and column are
   * read from the ask ("total adverse events", "average revenue in Q4").
   */
  askAggregate(context, projects, parsed, explicit = null) {
    const op = explicit?.op ? String(explicit.op).toLowerCase() : operationOf(parsed.original);
    if (!['sum', 'mean', 'max', 'min', 'count'].includes(op)) return null;
    const asked = foldAsk(explicit?.column ?? parsed.words.join(' '));
    const months = periodMonths(parsed.original);
    const named = (filePath) => !explicit?.file || `/${filePath}`.toLowerCase().endsWith(`/${String(explicit.file).toLowerCase().replace(/^\/+/, '')}`);
    const tables = new Map();
    for (const project of projects) {
      if (!project.snapshotId) continue;
      for (const [key, cells] of this.rowTable(project, project.snapshotId).byRow) {
        const first = cells[0];
        if (!this.allowed(context, project.id, first.path) || !named(first.path)) continue;
        const table = `${project.id}|${first.path}|${first.anchor?.sheet ?? ''}`;
        if (!tables.has(table)) tables.set(table, { project, path: first.path, sheet: first.anchor?.sheet ?? null, rows: [] });
        tables.get(table).rows.push({ key, label: String(first.anchor?.rowKey ?? ''), cells });
      }
      // The index holds only a table's first rows as cells; the table index holds every row. A table with more rows
      // there than cells here is read from it, so an operation covers the whole table and not its first rows.
      for (const indexed of this.dependencies.snapshotTables(project.id, project.snapshotId)) {
        if (!this.allowed(context, project.id, indexed.file.path) || !named(indexed.file.path)) continue;
        const table = `${project.id}|${indexed.file.path}|${indexed.sheet ?? ''}`;
        const dataRows = indexed.meta.rowCount - (indexed.meta.shape?.dataStart ?? 0);
        if ((tables.get(table)?.rows.length ?? 0) < dataRows) tables.set(table, { project, path: indexed.file.path, sheet: indexed.sheet ?? null, rows: this.indexedRows(indexed) });
      }
    }
    const items = [];
    for (const table of tables.values()) {
      const columns = [...new Set(table.rows.flatMap((row) => row.cells.map((cell) => String(cell.anchor?.column ?? ''))))].filter(Boolean);
      const cellOf = (row, name) => row.cells.find((cell) => cell.anchor?.column === name)?.valueText ?? null;
      // A column the operation can work on: one with figures, unless it only counts rows.
      const figures = (name) => op === 'count' || table.rows.some((row) => numberOf(cellOf(row, name)) != null);
      const column = explicit?.column ? columns.find((name) => foldAsk(name) === asked)
        : columns.filter((name) => namesHeader(asked, name) && figures(name)).sort((left, right) => right.length - left.length)[0];
      if (!column) continue;
      let rows = table.rows;
      if (months && rows.some((row) => MONTH_NAMES.has(foldAsk(row.label)))) rows = rows.filter((row) => months.has(foldAsk(row.label)));
      // "the total Amount for the West region": the ask names another column and one of its values, and only those rows
      // count, as {where: {Region: "West"}} asks. Both the column and the value must be named; nothing is guessed.
      const where = { ...(explicit?.where ?? {}) };
      if (!explicit) {
        const said = ` ${asked} `;
        for (const name of columns.filter((other) => other !== column && namesHeader(asked, other) && !figures(other))) {
          const values = [...new Set(table.rows.map((row) => cellOf(row, name)).filter(Boolean))];
          const named = values.filter((value) => foldAsk(value) && said.includes(` ${foldAsk(value)} `));
          if (named.length === 1) where[name] = named[0];
        }
      }
      // {where: {Region: "North"}}: rows whose cell in that column (or whose label, for the label column) is that value.
      for (const [name, wanted] of Object.entries(where)) {
        rows = rows.filter((row) => {
          const cell = row.cells.find((candidate) => foldAsk(String(candidate.anchor?.column ?? '')) === foldAsk(name));
          return foldAsk(String(cell ? cell.valueText : row.label)) === foldAsk(String(wanted));
        });
      }
      const values = rows.map((row) => ({ label: row.label, text: row.cells.find((cell) => cell.anchor?.column === column)?.valueText ?? null }))
        .map((entry) => ({ ...entry, number: numberOf(entry.text) }));
      const numeric = values.filter((entry) => entry.number != null);
      if (op !== 'count' && !numeric.length) continue;
      const decimals = Math.max(0, ...numeric.map((entry) => (String(entry.text).split('.')[1]?.replace(/\D.*$/, '').length ?? 0)));
      const round = (value) => Number(value.toFixed(Math.min(6, decimals + (op === 'mean' ? 2 : 0))));
      const extreme = op === 'max' ? numeric.reduce((best, entry) => (entry.number > best.number ? entry : best), numeric[0])
        : op === 'min' ? numeric.reduce((best, entry) => (entry.number < best.number ? entry : best), numeric[0]) : null;
      const value = op === 'count' ? values.length : op === 'sum' ? round(numeric.reduce((total, entry) => total + entry.number, 0))
        : op === 'mean' ? round(numeric.reduce((total, entry) => total + entry.number, 0) / numeric.length) : extreme.number;
      const file = this.snapshotFile(context, table.project, table.path);
      items.push({ src: file ? this.source(context, table.project, file) : null, type: 'computed', op, column, ...(table.sheet ? { sheet: table.sheet } : {}),
        ...(Object.keys(where).length ? { where } : {}),
        value, rows: op === 'count' ? values.length : numeric.length, of: table.rows.length, ...(extreme ? { row: extreme.label } : {}),
        ...(months ? { period: [...months].join(', ') } : {}),
        ...(values.length - numeric.length && op !== 'count' ? { skipped: values.length - numeric.length } : {}),
        ...(values.length <= 15 ? { values: values.map((entry) => [entry.label, entry.text]) } : {}) });
      if (items.length >= 3) break;
    }
    return items.length ? { kind: 'computed', status: 'complete', items } : null;
  }

  /**
   * Every data row of a table in the table index, shaped as askAggregate reads rows: its label (the label
   * column's cell) and its other cells, each with its column's name.
   */
  indexedRows({ meta }) {
    const headers = meta.shape?.headers ?? [];
    const labelColumn = meta.shape?.labelColumn ?? 0;
    const rows = [];
    for (let from = meta.shape?.dataStart ?? 0; from < meta.rowCount; from += 10_000) {
      for (const row of this.dependencies.tables.rows(meta.id, from, Math.min(meta.rowCount, from + 10_000))) {
        if (!row.cells.some((cell) => String(cell ?? '').trim())) continue;
        rows.push({ key: `${meta.id}:${row.ordinal}`, label: String(row.cells[labelColumn] ?? ''),
          cells: row.cells.map((cell, index) => ({ valueText: String(cell ?? ''), anchor: { column: String(headers[index] ?? '') } }))
            .filter((_, index) => index !== labelColumn && headers[index]) });
      }
    }
    return rows;
  }

  /** The files of the folders' current snapshots by content hash, for placing a revision's parts. */
  filesByHash(project) {
    const snapshot = this.snapshotObjects(project);
    if (!snapshot.byHash) {
      snapshot.byHash = new Map();
      for (const file of this.timeline.snapshotFiles(project.snapshotId)) {
        if (!snapshot.byHash.has(file.contentHash)) snapshot.byHash.set(file.contentHash, []);
        snapshot.byHash.get(file.contentHash).push(file);
      }
    }
    return snapshot.byHash;
  }

  /**
   * Plain-language search over the full-text index. Candidates are versions
   * of the shared folders' current snapshots that BM25 ranks for the ask's
   * words, no word required; each word counts by how rare it is. The best
   * files (at most FOUND_FILES) are read in order, and from them the fewest
   * sentences and table rows that cover the ask are chosen within the budget,
   * each with the context it needs (select.js); a table's matching rows and a
   * model's matching measurements come back whole. The answer is ranked, not
   * exhaustive, and says how much it left out and which words no shared file
   * has. Null when the index cannot be used, and the plain scan answers.
   */
  askSearch(context, projects, parsed) {
    const index = this.textIndex;
    if (!index || !parsed.content.length) return null;
    if (!index.sync(SYNC_BUDGET_MS)) return null;
    let scope = projects;
    let under = null;
    const named = parsed.files.length ? this.tryMention(context, parsed.files[0], parsed) : null;
    if (named) { scope = [named.project]; under = named.file.path; }
    const terms = [...new Set(parsed.content.map(foldAsk).flatMap((word) => word.split(' ')).filter((word) => word.length > 1 || /\d/.test(word)))];
    if (!terms.length) return null;
    const coveredBy = hasWord;
    const inScope = (versionId) => {
      for (const project of scope) {
        if (!project.snapshotId) continue;
        const object = this.snapshotObjects(project).versions.get(versionId);
        if (object && this.allowed(context, project.id, object.path) && (!under || object.path === under)) return { project, object };
      }
      return null;
    };
    // A heading's or table row's file revision, placed in the folders searched.
    const partInScope = (part) => {
      for (const project of scope) {
        if (!project.snapshotId) continue;
        const file = (this.filesByHash(project).get(part.contentHash) ?? [])
          .find((candidate) => this.allowed(context, project.id, candidate.path) && (!under || candidate.path === under));
        if (file) return { project, file };
      }
      return null;
    };
    const phrases = terms.slice(1).map((term, at) => `${terms[at]} ${term}`);
    // A period the ask names is looked for both ways reports write it ("Q4", "fourth quarter"), and read as the months
    // it covers. Its words, and words that say what form the answer takes ("total", "summary"), are not what the ask
    // is about: never said to be missing, nor needed for a passage to have every word of the ask.
    const periods = periodsOf(parsed.original);
    const unsought = new Set([...periods.flatMap((named) => named.forms).flatMap((form) => form.split(' ')), ...terms.filter((term) => ANSWER_WORDS.has(term))]);
    const forms = [...new Set(periods.flatMap((named) => named.forms))].filter((form) => !terms.includes(form) && !phrases.includes(form));
    let hits = index.search([...terms, ...phrases, ...forms], 4000).flatMap((hit) => {
      const found = inScope(hit.versionId);
      return found ? [{ ...found, score: hit.score }] : [];
    });
    let partHits = index.searchParts([...terms, ...phrases, ...forms], 400).flatMap((part) => {
      const found = partInScope(part);
      return found ? [{ project: found.project, object: { path: found.file.path, anchor: null }, score: part.score, part }] : [];
    });
    // A word no version or part in scope has is said, and the ask is answered for the rest.
    const absent = terms.filter((term) => !unsought.has(term) && !index.search([term], 400).some((hit) => inScope(hit.versionId))
      && !index.searchParts([term], 400).some((part) => partInScope(part)));
    // Every other word of the ask in a file's name or title ("vendor memo.docx", "parts in the fixture assembly", "bill of
    // materials for the fixture assembly"): the ask is about that file, answered with what it holds, within the digest's
    // size. Words that say what form the answer takes ("parts", "summary") and words no file has are not looked for in names.
    const naming = terms.filter((term) => !ANSWER_WORDS.has(term) && !absent.includes(term));
    // An ask for what one document found that names it ("the main results of the School Streets pilot evaluation") is
    // answered from that document, and the words that name it pick the document rather than rank its sentences.
    const asked = sectionsAskedAbout(parsed.original);
    const focus = asked.findings ? this.focusDocument(context, [...hits, ...partHits], naming, coveredBy) : null;
    if (focus) {
      hits = hits.filter((hit) => hit.project.id === focus.project.id && hit.object.path === focus.file.path);
      partHits = partHits.filter((hit) => hit.project.id === focus.project.id && hit.object.path === focus.file.path);
    }
    const searched = under ? { file: `${named.project.name}/${under}` } : { files: this.sharedFileCount(context, scope) };
    // What a named file lacks of the ask: its absent words, less those of its folder and path, which say where to look.
    // When the file has none of what the ask is about ("the annual review … carbon emissions"), that is the answer.
    const placeWords = named ? new Set(foldAsk(`${named.project.name} ${named.file.path}`).split(' ')) : new Set();
    const lacking = absent.filter((term) => !placeWords.has(term));
    const topic = terms.filter((term) => !unsought.has(term) && !placeWords.has(term));
    const noneOfTopic = lacking.length > 0 && topic.every((term) => lacking.includes(term));
    if (naming.length) {
      const subjects = named ? this.subjectFiles(context, [named.project], naming, coveredBy, named.file.path) : this.subjectFiles(context, scope, naming, coveredBy);
      if (subjects.length === 1 && noneOfTopic) return this.namedWithout(context, subjects[0], terms, lacking);
      if (subjects.length && !focus) {
        return { kind: 'digest', items: subjects.flatMap((subject) => this.digestItems(context, subject)),
          ...(lacking.length ? { missing: lacking, absent: lacking, file: subjects.length === 1 ? `${subjects[0].project.name}/${subjects[0].file.path}` : `the ${subjects.length} files` } : {}) };
      }
    }
    if (named && lacking.length && !hits.length && !partHits.length) return this.namedWithout(context, named, terms, lacking);
    // Nothing in the index: the plain scan, which also reads large tables' row index, answers (and says what is missing).
    if (!hits.length && !partHits.length) return null;
    const size = Math.max(1, index.size());
    const weights = new Map([...terms.filter((term) => !absent.includes(term) && !focus?.words.has(term)), ...forms]
      .map((term) => [term, Math.log(1 + size / Math.max(1, index.frequency(term)))]));
    // Files by their three best hits; a whole-file object (a title, a file name) counts toward its file without being evidence.
    const files = new Map();
    for (const hit of [...hits, ...partHits]) {
      const key = `${hit.project.id}|${hit.object.path}`;
      if (!files.has(key)) files.set(key, { project: hit.project, path: hit.object.path, hits: [] });
      files.get(key).hits.push(hit);
    }
    // A file ranks by its best hit, then a little for the next two: one passage with the ask's rarest word
    // outranks a table whose many cells share a common one.
    const ranked = [...files.values()].map((entry) => {
      const scores = entry.hits.map((hit) => hit.score).sort((left, right) => right - left);
      return { ...entry, score: scores[0] + 0.3 * ((scores[1] ?? 0) + (scores[2] ?? 0)) };
    }).sort((left, right) => right.score - left.score);
    // Files whose best passage has every word of the ask are never cut by the relative score: a short note's one exact
    // sentence is kept beside a long report whose sentences repeat some of the words.
    const textOf = (object) => ` ${foldAsk(`${object?.label ?? ''} ${object?.valueText ?? ''}`)} `;
    const coversAll = (hit) => terms.filter((term) => !absent.includes(term) && !unsought.has(term))
      .every((term) => hasWord(textOf(hit.object), term));
    const complete = new Set(ranked.filter((entry) => entry.hits.some(coversAll)));
    const chosen = [...ranked.filter((entry) => complete.has(entry)), ...ranked.filter((entry) => !complete.has(entry) && entry.score >= ranked[0].score * FILE_SHARE)]
      .slice(0, FOUND_FILES).sort((left, right) => right.score - left.score);
    // A search for something mostly not here (half or more of the words it seeks in no file) answers briefly. A question
    // in plain words always has some words no file uses ("went", "instead"), and those are no reason to show less.
    const sought = terms.filter((term) => !unsought.has(term));
    const mostlyAbsent = sought.length > 0 && absent.length * 2 >= sought.length;
    const budget = mostlyAbsent ? Math.min(150, context.budget ?? ASK_BUDGET) : context.budget ?? ASK_BUDGET;
    const textFiles = [];
    const items = [];
    for (const entry of chosen) {
      const file = this.snapshotFile(context, entry.project, entry.path);
      if (!file) continue;
      const objects = this.objectsOfFile(entry.project, entry.path);
      // A cell, row or measurement is evidence when its own words match, not only its file's name.
      const matchesIn = (text) => {
        const words = ` ${foldAsk(text)} `;
        return [...weights.keys()].some((term) => hasWord(words, term));
      };
      const own = (object) => matchesIn(`${object.label ?? ''} ${object.valueText ?? ''} ${object.anchor?.column ?? ''} ${object.metadata?.entityName ?? ''}`);
      const evidence = entry.hits.map((hit) => hit.object).filter((object) => object.anchor && !isWholeFileObject(object) && own(object));
      const structure = ['pdf', 'document'].includes(file.fileType) ? this.structureOf(file) : { headings: [], rows: [] };
      // A passage that repeats a heading, or that the reader made of a table's rows run together, is read as those instead.
      const headingTexts = new Set(structure.headings.map((heading) => foldAsk(heading.text)));
      const passages = objects.filter((object) => ['pdf-excerpt', 'text-excerpt'].includes(object.anchor?.kind) && isPassage(object)
        && !headingTexts.has(foldAsk(object.valueText)) && !structure.rows.some((row) => String(object.valueText ?? '').includes(row.valueText)));
      if (passages.length || structure.rows.length) {
        textFiles.push({ key: `${entry.project.id}|${entry.path}`, entry, file, sentences: readingOrder([...passages, ...structure.rows], structure.headings) });
      } else if (evidence.some((object) => ['table-cell', 'table-row'].includes(object.anchor?.kind))) {
        const cells = evidence.filter((object) => ['table-cell', 'table-row'].includes(object.anchor?.kind));
        // Rows the ask names (by a label or value) come back whole; a match on column names alone is those columns.
        const labelled = cells.some((object) => matchesIn(`${object.anchor?.rowKey ?? ''} ${object.valueText ?? ''}`));
        let rows = labelled ? this.wholeRows(entry.project, cells) : cells.filter((object) => object.anchor?.kind === 'table-cell');
        // A period the ask names ("Q4") keeps a month-labelled table's rows to its months.
        const months = periodMonths(parsed.original);
        const label = (object) => foldAsk(String(object.anchor?.rowKey ?? ''));
        if (months && rows.some((object) => MONTH_NAMES.has(label(object)))) rows = rows.filter((object) => months.has(label(object)));
        items.push(...this.tableItems(context, entry.project, file, rows).map((table) => ({ ...table,
          ...(table.rows.length > SEARCH_TABLE_ROWS ? { rows: table.rows.slice(0, SEARCH_TABLE_ROWS), more_rows: table.rows.length - SEARCH_TABLE_ROWS + (table.more_rows ?? 0) } : {}) })));
      } else if (evidence.some((object) => object.anchor?.kind === 'cad-property')) {
        items.push(this.modelItem(context, entry.project, file, this.wholeElements(entry.project, file, evidence.filter((object) => object.anchor?.kind === 'cad-property'))));
      } else if (evidence.length) {
        items.push(...evidence.slice(0, PASSAGES_PER_FILE).map((object) => this.project(context, { project: entry.project, object }, {}, ANSWER_CHARS)));
      }
    }
    let selection = null;
    if (textFiles.length) {
      selection = selectEvidence(textFiles, weights, { budget, minShare: SENTENCE_SHARE, sectionsAsked: asked });
      for (const { key, excerpts } of selection.files) {
        const { entry, file } = textFiles.find((candidate) => candidate.key === key);
        const src = this.sourceFor(context, entry.project, file);
        const real = (object) => !String(object.id).startsWith('row:');
        items.push({ src, type: 'excerpts', excerpts: excerpts.map((excerpt) => {
          const first = excerpt.objects.find(real);
          const ref = first ? this.objectRef(context, entry.project, first) : null;
          return { at: locatorOf(excerpt.objects[0]) || null, ...(excerpt.heading ? { section: excerpt.heading } : {}),
            ...(excerpt.rows ? { caption: excerpt.caption, header: excerpt.header, rows: excerpt.rows } : { text: excerpt.text }),
            ...(ref ? { h: this.issue(context, ref) } : {}) };
        }) });
      }
    }
    // A row asked for by a label no row has ("West division"): the rows labelled like it, which is what a reader checks next.
    const like = this.labelsLike(context, scope, under, parsed.words);
    // What a search cannot have seen: files in scope Lasso could not read.
    const unreadable = this.notSearched(context, scope, under);
    const blind = unreadable.length ? { not_searched: unreadable } : {};
    if (!items.length) return null;
    // A row asked for by a label no table has, that no excerpt names and no indexed passage in scope has every word of:
    // that absence is the answer, and rows or sentences about other labels are not evidence for it.
    const shownText = ` ${foldAsk(JSON.stringify(items))} `;
    if (like && !shownText.includes(` ${like.label} `) && !index.search(terms, 400, { all: true }).some((hit) => inScope(hit.versionId))
      && !index.searchParts(terms, 400, { all: true }).some((part) => partInScope(part))) {
      return { kind: 'none', status: 'not_found', looked_for: terms, ...(absent.length ? { missing: absent } : {}), ...searched, like, ...blind, items: [] };
    }
    // An asked-for word that only names a file shown is not missing from its excerpts.
    const fileNames = ` ${foldAsk(chosen.map((entry) => entry.path).join(' '))} `;
    const unmatched = (selection?.missingTerms ?? []).filter((term) => !absent.includes(term) && !unsought.has(term) && !forms.includes(term)
      && !hasWord(fileNames, term));
    return { kind: 'found', status: 'ranked', items, ...searched, ...(like ? { like } : {}), ...blind,
      counts: { files: chosen.length, matching_files: ranked.length, ...(selection ? { sentences: selection.shownSentences, left_out: selection.leftOut } : {}) },
      ...(selection?.leftOutSections?.length ? { left_out_in: selection.leftOutSections } : {}),
      ...(absent.length ? { missing: absent, absent } : {}), ...(unmatched.length ? { unmatched } : {}) };
  }

  /**
   * A file the ask names, without some of its words ("what does the annual review say about carbon emissions"):
   * that is said first. A document then shows its sections, which say what it does cover, rather than its text;
   * a model or table shows its digest, which may answer in its own terms (an IFC model's rooms are its spaces).
   */
  namedWithout(context, { project, file }, terms, absent) {
    const where = `${project.name}/${file.path}`;
    if (['pdf', 'document', 'presentation', 'markdown', 'text'].includes(file.fileType)) {
      const headings = ['pdf', 'document'].includes(file.fileType) ? this.structureOf(file).headings.map((heading) => heading.text) : [];
      this.sourceFor(context, project, file);
      return { kind: 'none', status: 'not_found', looked_for: terms, missing: absent, file: where, ...(headings.length ? { sections: headings.slice(0, 40) } : {}),
        ...(headings.length > 40 ? { more_sections: headings.length - 40 } : {}), items: [] };
    }
    return { kind: 'digest', status: 'partial', items: this.digestItems(context, { project, file }), missing: absent, absent, file: where };
  }

  /**
   * The one document an ask names among those a search hit: the one whose name or title has two or more of the ask's
   * words, more than any other. With the words of its file name, which pick it rather than rank its sentences.
   */
  focusDocument(context, hits, naming, coveredBy) {
    const files = new Map();
    for (const hit of hits) {
      const key = `${hit.project.id}|${hit.object.path}`;
      if (!files.has(key)) files.set(key, { project: hit.project, path: hit.object.path });
    }
    const scored = [...files.values()].flatMap(({ project, path: filePath }) => {
      const file = this.snapshotFile(context, project, filePath);
      if (!file || !['pdf', 'document', 'presentation', 'markdown', 'text'].includes(file.fileType)) return [];
      // Its name and title pick it; only the words of its file name are dropped from ranking its sentences, since a
      // title often says what the document is about ("WALK-ON: walking and knee pain").
      const titled = ` ${foldAsk(`${filePath.replace(/\.[^./]+$/, '')} ${this.titleOf(project, filePath)}`)} `;
      const fileName = ` ${foldAsk(filePath.replace(/\.[^./]+$/, ''))} `;
      return [{ project, file, picked: naming.filter((word) => coveredBy(titled, word)).length, words: new Set(naming.filter((word) => coveredBy(fileName, word))) }];
    }).sort((left, right) => right.picked - left.picked);
    const [best, next] = scored;
    return best && best.picked >= 2 && best.picked > (next?.picked ?? 0) ? best : null;
  }

  /** What a subject file holds: a text file's text (or outline), any other file's digest. */
  digestItems(context, { project, file }) {
    const answer = isTextualType(file.fileType) ? this.askWholeFile(context, { project, file }) : this.fileDigest(context, project, file);
    return answer?.items ?? [{ src: this.sourceFor(context, project, file), type: 'file' }];
  }

  /**
   * A file that is not text, as its index has it: a workbook's tables, a
   * document's passages in order, a CAD or building model's parts or rooms
   * and their measurements.
   */
  fileDigest(context, project, file) {
    const objects = this.objectsOfFile(project, file.path);
    const large = this.dependencies.snapshotTables(project.id, project.snapshotId).filter((table) => table.file.path === file.path);
    const cells = objects.filter((object) => object.anchor?.kind === 'table-cell');
    if (large.length || cells.length) {
      return { kind: 'digest', items: [...this.tableItems(context, project, file, cells.filter((cell) => !large.some((table) => (table.sheet ?? '') === (cell.anchor.sheet ?? '')))),
        ...large.map((table) => this.largeTableItem(context, project, file, table))] };
    }
    const properties = objects.filter((object) => object.anchor?.kind === 'cad-property');
    const model = objects.find((object) => object.anchor?.kind === 'cad-model');
    if (model || properties.length) {
      const item = this.modelItem(context, project, file, properties, model);
      // An assembly's instances, where each sits: what a relation between two of them is asked by.
      const assembly = STEP_FILE.test(file.path) ? this.stepModel(file) : null;
      if (assembly?.occurrences?.length > 1) {
        const instances = instancesOf(assembly);
        item.instances = instances.slice(0, DIGEST_INSTANCES).map((instance) => ({ label: instance.label,
          ...(instance.placement ? { at: instance.placement.at, ...(instance.placement.turn ? { turn: instance.placement.turn } : {}) } : {}) }));
        if (instances.length > DIGEST_INSTANCES) item.more_instances = instances.length - DIGEST_INSTANCES;
      }
      return { kind: 'digest', items: [item] };
    }
    const passages = objects.filter((object) => ['pdf-excerpt', 'text-excerpt'].includes(object.anchor?.kind));
    if (passages.length) return { kind: 'digest', items: [this.textItem(context, project, file, passages)] };
    return null;
  }

  /**
   * The rows hit cells and rows are in, whole when the table is narrow: a draft that gives a month's margin
   * also gives its revenue, at a few tokens a row. A wide table keeps only the columns that matched.
   */
  wholeRows(project, objects) {
    const table = this.rowTable(project, project.snapshotId);
    const cells = new Map();
    for (const object of objects) {
      const key = `${object.path}|${object.metadata?.sheet ?? object.anchor?.sheet ?? ''}|${object.anchor?.rowIndex}`;
      const row = table.byRow.get(key) ?? [];
      const narrow = new Set(row.map((cell) => cell.anchor?.columnIndex)).size <= WHOLE_ROW_COLUMNS;
      for (const cell of narrow ? row : object.anchor?.kind === 'table-cell' ? [object] : row.slice(0, WHOLE_ROW_COLUMNS)) {
        if (cell.anchor?.kind === 'table-cell') cells.set(`${key}|${cell.anchor.columnIndex}`, cell);
      }
    }
    return [...cells.values()];
  }

  /**
   * The matched measurements of each part or room, then its others in the order people ask for them, up to
   * ELEMENT_PROPERTIES in all: "the bracket's size and holes" gets its extents beside its holes.
   */
  wholeElements(project, file, matched) {
    const names = new Set(matched.map((property) => property.metadata?.entityName));
    const others = this.objectsOfFile(project, file.path).filter((object) => object.anchor?.kind === 'cad-property'
      && names.has(object.metadata?.entityName) && !matched.includes(object))
      .sort((left, right) => propertyRank(String(left.label)) - propertyRank(String(right.label)));
    const chosen = [...matched];
    for (const name of names) {
      const count = matched.filter((property) => property.metadata?.entityName === name).length;
      chosen.push(...others.filter((object) => object.metadata?.entityName === name).slice(0, Math.max(0, ELEMENT_PROPERTIES - count)));
    }
    return chosen;
  }

  /** Table cells as the rows they are in, one table per sheet: the row's label, then the cells' columns in order. */
  tableItems(context, project, file, cells) {
    const src = this.sourceFor(context, project, file);
    const sheets = new Map();
    for (const cell of cells) {
      const sheet = cell.anchor.sheet ?? '';
      if (!sheets.has(sheet)) sheets.set(sheet, []);
      sheets.get(sheet).push(cell);
    }
    const columnsOf = this.objectsOfFile(project, file.path).filter((object) => object.anchor?.kind === 'table-column');
    return [...sheets.entries()].map(([sheet, group]) => {
      const columns = [...new Map(group.map((cell) => [cell.anchor.columnIndex, cell.anchor.column])).entries()].sort(([left], [right]) => left - right);
      const known = new Set(columns.map(([index]) => index));
      const label = columnsOf.filter((column) => (column.anchor.sheet ?? '') === sheet && !known.has(column.anchor.columnIndex))
        .sort((left, right) => left.anchor.columnIndex - right.anchor.columnIndex)[0]?.anchor.column ?? '';
      const rows = new Map();
      for (const cell of group) {
        if (!rows.has(cell.anchor.rowIndex)) rows.set(cell.anchor.rowIndex, { label: String(cell.anchor.rowKey ?? ''), values: new Map() });
        rows.get(cell.anchor.rowIndex).values.set(cell.anchor.columnIndex, cell.valueText ?? '');
      }
      const ordered = [...rows.entries()].sort(([left], [right]) => left - right)
        .map(([, row]) => [row.label, ...columns.map(([index]) => row.values.get(index) ?? '')]);
      return { src, type: 'table', ...(sheet ? { sheet } : {}), header: [label, ...columns.map(([, name]) => name)],
        rows: ordered.slice(0, DIGEST_ROWS), ...(ordered.length > DIGEST_ROWS ? { more_rows: ordered.length - DIGEST_ROWS } : {}) };
    });
  }

  /** A large table's first rows from its row index, with how many it has. */
  largeTableItem(context, project, file, table) {
    const rows = this.dependencies.tables.rows(table.meta.id, 0, DIGEST_ROWS - 1).map((row) => row.cells.map((cell) => String(cell ?? '')));
    return { src: this.sourceFor(context, project, file), type: 'table', ...(table.sheet ? { sheet: table.sheet } : {}),
      header: (table.meta.shape?.headers ?? []).map(String), rows, rows_total: table.meta.rowCount };
  }

  /** A model's parts or rooms and their measurements, rooms first and the measurements people ask for first. */
  modelItem(context, project, file, properties, model = null, keepOrder = !model) {
    const elements = new Map();
    for (const property of properties) {
      const name = String(property.metadata?.entityName ?? '');
      const type = String(property.metadata?.entityType ?? '');
      if (!elements.has(name)) elements.set(name, { name, type, room: type === 'IFCSPACE', properties: [] });
      const label = String(property.label ?? '');
      elements.get(name).properties.push([label.startsWith(`${name} `) ? label.slice(name.length + 1) : label, property.valueText ?? '']);
    }
    // A building model is described by its rooms and storeys; its walls, windows and slabs are counted.
    const all = [...elements.values()];
    const rooms = all.some((element) => element.room);
    const described = rooms ? all.filter((element) => ['IFCSPACE', 'IFCBUILDINGSTOREY'].includes(element.type)) : all;
    const counted = {};
    for (const element of all) {
      if (described.includes(element)) continue;
      const kind = element.type.replace(/^IFC/i, '').toLowerCase() || 'other';
      counted[kind] = (counted[kind] ?? 0) + 1;
    }
    const ordered = described.sort((left, right) => Number(right.room) - Number(left.room));
    const shown = [];
    let size = 0;
    for (const element of ordered) {
      const sorted = element.properties.map((property, index) => [property, index]).sort(([[left], leftIndex], [[right], rightIndex]) =>
        (keepOrder ? leftIndex - rightIndex : propertyRank(left) - propertyRank(right) || leftIndex - rightIndex)).map(([property]) => property);
      const entry = { name: element.name === '@assembly' ? 'assembly' : element.name, properties: sorted.slice(0, ELEMENT_PROPERTIES),
        ...(sorted.length > ELEMENT_PROPERTIES ? { more: sorted.length - ELEMENT_PROPERTIES } : {}) };
      size += JSON.stringify(entry).length;
      if (size > DIGEST_CHARS && shown.length) break;
      shown.push(entry);
    }
    const summary = String(model?.metadata?.textExcerpt ?? '').split('\n').filter(Boolean).slice(0, 12);
    return { src: this.sourceFor(context, project, file), type: 'model', ...(summary.length ? { summary } : {}), elements: shown,
      ...(ordered.length > shown.length ? { more_elements: ordered.length - shown.length } : {}),
      ...(Object.keys(counted).length ? { other_elements: counted } : {}) };
  }

  /** A document's passages in reading order: paragraphs, and sentences no paragraph already holds. */
  textItem(context, project, file, passages) {
    const paragraphs = passages.filter((passage) => passage.metadata?.excerptType === 'paragraph');
    const kept = passages.filter((passage) => passage.metadata?.excerptType === 'paragraph' || !paragraphs.some((paragraph) =>
      paragraph.anchor.pageNumber === passage.anchor.pageNumber && String(paragraph.valueText ?? '').includes(String(passage.valueText ?? ''))));
    const position = (passage) => [passage.anchor.pageNumber ?? 0, passage.anchor.lineStart ?? 0, passage.anchor.start ?? 0];
    kept.sort((left, right) => {
      const [a, b] = [position(left), position(right)];
      return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    });
    const shown = [];
    let size = 0;
    for (const passage of kept) {
      size += String(passage.valueText ?? '').length;
      if (size > DIGEST_CHARS && shown.length) break;
      shown.push({ at: locatorOf(passage), text: passage.valueText ?? '' });
    }
    return { src: this.sourceFor(context, project, file), type: 'text', passages: shown,
      ...(kept.length > shown.length ? { more: kept.length - shown.length } : {}) };
  }

  /** How many shared, indexed files a search covered. */
  sharedFileCount(context, projects) {
    let total = 0;
    for (const project of projects) {
      if (!project.snapshotId) continue;
      for (const file of this.timeline.snapshotFiles(project.snapshotId)) if (this.allowed(context, project.id, file.path)) total += 1;
    }
    return total;
  }

  /**
   * Row labels one word away from a span of the ask: "North division" and
   * "South division" for "West division". The word that differs must not
   * name one of the row's columns ("division revenue" is a row and a field,
   * not a label). The longest such span is kept: up to MAX_LABELS labels with
   * their sources, or how many there are.
   */
  labelsLike(context, projects, under, askWords) {
    const folded = askWords.flatMap((word) => foldAsk(word).split(' ')).filter(Boolean);
    const spans = [];
    for (let length = Math.min(4, folded.length); length >= 2; length -= 1) {
      for (let start = 0; start + length <= folded.length; start += 1) {
        const span = folded.slice(start, start + length);
        if (span.filter((word) => !STOPWORDS.has(word)).length >= 2) spans.push(span);
      }
    }
    if (!spans.length) return null;
    const bySpan = new Map();
    for (const project of projects) {
      if (!project.snapshotId) continue;
      const table = this.rowTable(project, project.snapshotId);
      for (const [label, keys] of table.byLabel) {
        const parts = label.split(' ');
        for (const span of spans) {
          if (span.length !== parts.length) continue;
          const differs = span.filter((word, index) => word !== parts[index]);
          if (differs.length !== 1 || STOPWORDS.has(differs[0])) continue;
          const word = differs[0];
          for (const key of keys) {
            const cells = table.byRow.get(key);
            const first = cells[0];
            if (!this.allowed(context, project.id, first.path) || (under && first.path !== under)) continue;
            if (cells.some((cell) => namesHeader(word, String(cell.anchor?.column ?? cell.metadata?.column ?? '')))) continue;
            const name = span.join(' ');
            if (!bySpan.has(name)) bySpan.set(name, { span, word, labels: new Map(), files: new Map() });
            const entry = bySpan.get(name);
            if (!entry.labels.has(label)) entry.labels.set(label, String(first.anchor.rowKey ?? first.metadata?.row));
            entry.files.set(`${project.id}|${first.path}`, { project, path: first.path });
          }
        }
      }
    }
    const best = [...bySpan.values()].sort((left, right) => right.span.length - left.span.length || right.labels.size - left.labels.size)[0];
    if (!best) return null;
    const label = best.span.join(' ');
    if (best.labels.size > MAX_LABELS) return { label, word: best.word, count: best.labels.size };
    const src = [...best.files.values()].flatMap(({ project, path: filePath }) => {
      const file = this.snapshotFile(context, project, filePath);
      return file ? [this.source(context, project, file)] : [];
    });
    return { label, word: best.word, rows: [...best.labels.values()], src: [...new Set(src)] };
  }

  /** A small text file named in an ask, whole; otherwise a code file's outline, or the opening lines (a table's header) of any other. */
  askWholeFile(context, named, onlyIfSmall = false) {
    const { project, file } = named;
    if (!isTextualType(file.fileType)) {
      return onlyIfSmall ? null : this.fileDigest(context, project, file) ?? { kind: 'files', items: [{ src: this.sourceFor(context, project, file), type: 'file' }] };
    }
    const all = fileLines(this.textOf(file));
    if (all.join('\n').length <= WHOLE_FILE_CHARS) return { kind: 'lines', items: [this.lines(context, project, file, [1, Math.max(1, all.length)], 0, false)] };
    if (onlyIfSmall) return null;
    return isCodeType(file.fileType) ? { kind: 'outline', items: [this.outline(context, project, file)] }
      : { kind: 'lines', items: [this.lines(context, project, file, [1, Math.min(HEAD_LINES, all.length)], 0, false)] };
  }

  status() {
    const context = this.context();
    return { scope: this.scope.describe(), gen: context.generation, folders: this.folders(context) };
  }
}

/**
 * Every answer says what it is: `complete` (an exact lookup, or an operation
 * over every row of a table), `ranked` (a search's selection, never all there
 * is), `partial` (shown in part: a cut digest, a word no file has),
 * `ambiguous` (sources or candidates the files do not settle between),
 * `not_found` (this search found nothing, which is not proof of absence).
 */
function withStatus(answer) {
  if (answer.status) return answer;
  const ambiguous = (answer.kind === 'record' && answer.verdict === 'differ') || (answer.kind === 'records' && answer.groups.some((group) => group.verdict === 'differ'))
    || (answer.items ?? []).some((item) => item.error?.code === 'ambiguous');
  const partial = (answer.items ?? []).some((item) => item.more || item.more_rows || item.more_elements || item.trunc) || answer.missing?.length;
  const status = ambiguous ? 'ambiguous' : answer.kind === 'none' ? 'not_found' : ['found', 'matches'].includes(answer.kind) ? 'ranked' : partial ? 'partial' : 'complete';
  return { ...answer, status };
}

/** "total", "average", "highest" … in an ask: the operation it asks of a column, or null. */
function operationOf(text) {
  const folded = String(text ?? '').toLowerCase();
  if (/\b(?:total|sum|altogether|in all|overall number)\b/.test(folded) || /\bhow many\b/.test(folded)) return 'sum';
  if (/\b(?:average|mean)\b/.test(folded)) return 'mean';
  if (/\b(?:highest|largest|maximum|max|most|biggest|top)\b/.test(folded)) return 'max';
  if (/\b(?:lowest|smallest|minimum|min|least|fewest)\b/.test(folded)) return 'min';
  return null;
}

/** A cell's number as written ("1,234", "12%", "-3.4", "$1.2"), or null. */
function numberOf(text) {
  const match = String(text ?? '').replace(/,/g, '').match(/^[\s$€£]*(-?\d+(?:\.\d+)?)\s*%?\s*$/);
  return match ? Number(match[1]) : null;
}

/**
 * Which kinds of report section the ask is about: other work, a report's apparatus, or what it found as a whole
 * ("the main results of the pilot", "what did the evaluation find", "Halden monitoring findings").
 */
function sectionsAskedAbout(text) {
  const asked = String(text ?? '');
  return { background: /\b(?:previous|prior|earlier|other|existing) (?:stud|research|work|trial|evidence|review)|\bliterature\b|\bbackground\b|\bintroduction\b/i.test(asked),
    apparatus: /\b(?:reference|bibliograph|acknowledg|fund|ethic|conflicts? of interest|competing interest|data availab|citation)/i.test(asked),
    findings: /\b(?:main|key|overall|headline|principal|top) (?:results?|findings?|outcomes?)\b|\bresults of (?:the|this|their|its)\b|\bfindings\b|\bwhat (?:did|does|do) (?:it|they|the [\w-]+(?: [\w-]+){0,3}) (?:find|show|conclude)\b|\bsummar(?:ise|ize)\b|\bsummary of\b|\b(?:a|the|brief|short|quick) summary\b(?! (?:row|table|statistic|line|sheet|column))|\bconclusions?\b|\bkey points\b/i.test(asked) };
}

/**
 * A PDF's or Word document's headings and a PDF's table rows, read from its
 * bytes with the app's own extraction: `{ headings, rows }`, positioned as
 * its passages are (a PDF by page and offset, a Word document by line).
 */
function readStructure(buffer, filePath) {
  if (/\.pdf$/i.test(filePath)) {
    const parts = extractPdfPassages(buffer, { structure: true });
    return {
      headings: parts.filter((part) => part.excerptType === 'heading').map((part) => ({ page: part.pageNumber, start: part.start, line: 0, text: part.selectedText })),
      rows: parts.filter((part) => part.excerptType === 'table-row').map((part) => ({ page: part.pageNumber, start: part.start, text: part.selectedText,
        caption: part.caption, header: part.header })),
    };
  }
  if (/\.docx$/i.test(filePath)) return { headings: extractDocxHeadings(buffer).map((heading) => ({ page: 0, start: -1, line: heading.line, text: heading.text })), rows: [] };
  return { headings: [], rows: [] };
}

/**
 * Within one response, an excerpt already shown for an earlier ask is not
 * sent again: it becomes a pointer to where it was shown.
 */
function dedupeAnswers(answers) {
  const shown = new Map();
  for (const answer of answers) {
    for (const [index, item] of (answer.items ?? []).entries()) {
      if (item.type !== 'excerpts') continue;
      const label = answer.items.length > 1 ? `${answer.n}.${index + 1}` : `${answer.n}`;
      item.excerpts = item.excerpts.map((excerpt) => {
        const key = `${item.src}|${excerpt.text ?? excerpt.rows?.join('\n')}`;
        if (shown.has(key)) return { at: excerpt.at, same: shown.get(key) };
        shown.set(key, label);
        return excerpt;
      });
    }
  }
}

function render(all, start, end, numbered) {
  const selected = all.slice(start - 1, end);
  return numbered ? selected.map((line, offset) => `${start + offset}\t${line}`).join('\n') : selected.join('\n');
}

/**
 * The words that name the row, when a query also names the fields it wants:
 * "South division revenue headcount" with fields Revenue and Headcount looks
 * for "South division". Text that is nothing but field names is kept whole.
 */
function matchText(value, fields) {
  if (!fields?.length) return value;
  let rest = ` ${value} `;
  for (const field of [...fields].sort((left, right) => right.length - left.length)) {
    const escaped = field.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    rest = rest.replace(new RegExp(`(^|[\\s,;:])${escaped}(?=[\\s,;:]|$)`, 'gi'), '$1');
  }
  rest = rest.replace(/\s+/g, ' ').trim();
  return rest || value;
}

/** A large table's row or cell, shaped as an object: what search would offer, plus its place. */
function cellObject(descriptor, project, table) {
  const anchor = descriptor.anchor ?? {};
  return { id: null, projectId: project.id, objectType: descriptor.type, snapshotId: project.snapshotId, path: descriptor.path,
    anchor, label: descriptor.label, valueText: descriptor.value, contentHash: descriptor.contentHash, metadata: descriptor.metadata,
    cell: anchor.kind === 'table-cell' ? { sheet: table.sheet ?? null, row: anchor.rowIndex, column: anchor.columnIndex,
      columnName: String(anchor.column ?? ''), rowKey: anchor.rowKey ?? null } : null };
}

/** Which table row an object belongs to, or null for anything that is not a row or cell. */
function rowKeyOf(projectId, object) {
  const anchor = object?.anchor ?? {};
  if (!['table-cell', 'table-row'].includes(anchor.kind) || !Number.isInteger(anchor.rowIndex)) return null;
  return `${projectId}|${object.path}|${object.metadata?.sheet ?? anchor.sheet ?? ''}|${anchor.rowIndex}`;
}

function matchField(cells, field) {
  const wanted = fold(field);
  if (!wanted) return null;
  return cells.find((cell) => fold(cell.anchor?.column ?? cell.metadata?.column) === wanted)
    ?? cells.find((cell) => fold(cell.anchor?.column ?? cell.metadata?.column).startsWith(wanted))
    ?? null;
}

function sameRecord(evidence) {
  return evidence.every((item) => item.row && item.row === evidence[0].row && item.projectId === evidence[0].projectId);
}

function sameSource(evidence) {
  return evidence.every((item) => item.projectId === evidence[0].projectId && item.path === evidence[0].path
    && item.contentHash === evidence[0].contentHash);
}

/**
 * Candidates of equal standing (same tier, specificity and relevance band)
 * take turns by file, so one large file cannot fill a page while another
 * equally good file waits. Nothing is dropped: every match keeps a place.
 */
function interleaveByFile(units) {
  const output = [];
  let index = 0;
  while (index < units.length) {
    const band = (unit) => {
      const ranking = unit.ranking ?? {};
      return `${ranking.tier ?? ''}:${ranking.directSpecificity ?? ''}:${ranking.relevanceBand ?? ''}`;
    };
    const key = band(units[index]);
    let end = index;
    while (end < units.length && band(units[end]) === key) end += 1;
    const queues = new Map();
    for (const unit of units.slice(index, end)) {
      const file = `${unit.project.id}|${unit.object?.path ?? unit.file?.path}`;
      if (!queues.has(file)) queues.set(file, []);
      queues.get(file).push(unit);
    }
    while (queues.size) {
      for (const [file, queue] of queues) {
        output.push(queue.shift());
        if (!queue.length) queues.delete(file);
      }
    }
    index = end;
  }
  return output;
}
