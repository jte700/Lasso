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
import { AgentError } from './errors.js';
import { estimateTokens } from './metrics.js';

const MAX_QUERIES = 16;
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
    const ids = new Set();
    const queries = listed.map((given, index) => {
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
    let rows = this.rowCells.get(snapshotId);
    if (!rows) {
      rows = { byRow: new Map(), weight: 0 };
      for (const object of this.dependencies.objectsAt(project.id, snapshotId)) {
        const anchor = object.anchor ?? {};
        if (anchor.kind !== 'table-cell' || !Number.isInteger(anchor.rowIndex)) continue;
        const key = `${object.path}|${object.metadata?.sheet ?? anchor.sheet ?? ''}|${anchor.rowIndex}`;
        if (!rows.byRow.has(key)) rows.byRow.set(key, []);
        rows.byRow.get(key).push(object);
        rows.weight += 1;
      }
      this.rowCells.set(snapshotId, rows);
    }
    return rows.byRow.get(rowKey) ?? [];
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
    // "Web/src/app.py": a shared folder's name written as the path's first part.
    const [first, ...rest] = name.split('/');
    if (!ranked.length && item.folder == null && rest.length) {
      const named = projects.filter((project) => project.name.toLowerCase() === first.toLowerCase());
      if (named.length) {
        projects = named;
        name = rest.join('/');
        ranked = this.rankFiles(context, projects, { text: name, kind: 'file' }).units
          .filter((unit) => unit.tier === 0);
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
    return this.symbol(context, project, file, name, around, numbered, line);
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

  status() {
    const context = this.context();
    return { scope: this.scope.describe(), gen: context.generation, folders: this.folders(context) };
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
