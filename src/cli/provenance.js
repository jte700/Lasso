// The CLI's own provenance questions, answered from the recorded history
// every folder already keeps (snapshots, file changes, object versions and
// timeline events). It returns data only; views.js draws it.
//
//   whence  where a file's exact bytes were recorded, by whom, and since
//   log     who changed what across folders, newest first
//   blame   who last set each value or passage in a file
//   diff    what one recorded change of a file changed
//   verify  every number in a document checked against the sources that hold it
//   events  timeline events recorded after a cursor, for `watch`

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../history/errors.js';
import { isWholeFile } from '../dependencies/file-reference.js';
import { numericDescriptor } from '../dependencies/value-match.js';
import { EVERYDAY_WORDS } from '../dependencies/everyday-words.js';
import { extractDocxFullText, extractPdfFullText } from '../dependencies/document-extraction.js';
import { changeDetail, compareOrder, placeOf } from '../loop/change-detail.js';
import { recentHistory, HISTORY_DAYS } from '../loop/history.js';
import { parseSince } from '../terminal/parser.js';
import { untilde } from './format.js';
import { sha256File } from './disk-facts.js';
import { readPresentation } from '../dependencies/presentation-extraction.js';
import { AuthorshipService } from '../provenance/authorship.js';
import { readableKind } from '../provenance/readable-text.js';

export { sha256File };

const EVENT_AT_SNAPSHOT = `
  SELECT e.id, e.occurred_at, e.source, e.title, a.display_name AS actor_name, a.actor_type,
    i.display_name AS initiator_name, i.actor_type AS initiator_type, x.request_text
  FROM timeline_events e
  JOIN actors a ON a.id = e.actor_id
  LEFT JOIN actors i ON i.id = e.initiated_by_actor_id
  LEFT JOIN agent_executions x ON x.id = e.agent_execution_id
  WHERE e.resulting_snapshot_id = ?`;

// The most recent change to an object that a person or agent made, not a re-read by a newer reader.
const LAST_OBJECT_CHANGE = `
  SELECT c.kind, c.snapshot_id, s.version, s.created_at, b.value_text AS before_value,
    e.source, a.display_name AS actor_name, a.actor_type
  FROM object_changes c
  JOIN snapshots s ON s.id = c.snapshot_id
  LEFT JOIN scientific_object_versions b ON b.id = c.before_version_id
  LEFT JOIN timeline_events e ON e.resulting_snapshot_id = c.snapshot_id
  LEFT JOIN actors a ON a.id = e.actor_id
  WHERE c.object_id = ? AND c.kind <> 'removed' AND COALESCE(e.source, '') <> 'REINDEX'
  ORDER BY s.version DESC LIMIT 1`;

const FIRST_OBJECT_VERSION = `
  SELECT v.snapshot_id, s.version, s.created_at, e.source, a.display_name AS actor_name, a.actor_type
  FROM scientific_object_versions v
  JOIN snapshots s ON s.id = v.snapshot_id
  LEFT JOIN timeline_events e ON e.resulting_snapshot_id = v.snapshot_id
  LEFT JOIN actors a ON a.id = e.actor_id
  WHERE v.object_id = ? ORDER BY s.version LIMIT 1`;

// Every value change of an object, oldest first, with who made it.
const OBJECT_VALUE_CHANGES = `
  SELECT c.snapshot_id, s.version, s.created_at, b.value_text AS before_value, a.value_text AS after_value,
    e.source, ac.display_name AS actor_name, ac.actor_type
  FROM object_changes c
  JOIN snapshots s ON s.id = c.snapshot_id
  JOIN scientific_object_versions b ON b.id = c.before_version_id
  JOIN scientific_object_versions a ON a.id = c.after_version_id
  LEFT JOIN timeline_events e ON e.resulting_snapshot_id = c.snapshot_id
  LEFT JOIN actors ac ON ac.id = e.actor_id
  WHERE c.object_id = ? AND c.kind = 'modified' ORDER BY s.version`;

const SUMMARY_TYPES = new Set(['DATASET', 'DATASET_ROW', 'TABLE', 'VARIABLE']);
/** The kinds of object that hold a single value a document can quote: a cell, a stated value, a result, a parameter, a dimension. */
const VALUE_TYPES = ['DATASET_VALUE', 'VALUE', 'RESULT', 'PARAMETER', 'DRAWING_ANNOTATION'];

/** Most objects a blame lists. */
export const MAX_BLAME_ROWS = 400;
/** Most numbers one verify checks. */
export const MAX_VERIFY_NUMBERS = 300;
/** Characters of a document verify reads. */
const MAX_VERIFY_TEXT = 2_000_000;
const TEXT_TYPES = /\.(md|markdown|txt|text|csv|tsv|html?|rtf|tex|json|ya?ml|org|rst)$/i;

const actorOf = (row) => (row?.actor_name ? { name: row.actor_name, type: row.actor_type } : null);
const parseJson = (text, fallback = null) => { try { return JSON.parse(text ?? 'null') ?? fallback; } catch { return fallback; } };

export class Provenance {
  /**
   * @param {{ db: import('node:sqlite').DatabaseSync, timeline: object, dependencies: object, workspace: object }} engine
   */
  constructor({ db, timeline, dependencies, workspace }, { now = () => Date.now() } = {}) {
    this.db = db;
    this.timeline = timeline;
    this.dependencies = dependencies;
    this.workspace = workspace;
    this.now = now;
  }

  folders() {
    return this.workspace.activeProjects();
  }

  // ── the library at a glance ────────────────────────────────────────────

  summary() {
    const folders = this.folders().map((folder) => {
      const stats = this.db.prepare(`SELECT COUNT(*) AS events, MIN(occurred_at) AS first, MAX(occurred_at) AS last
        FROM timeline_events WHERE project_id = ? AND source NOT IN ('REINDEX', 'AI_RECORD')`).get(folder.id);
      return { id: folder.id, name: folder.name, rootPath: folder.rootPath, version: folder.currentVersion,
        files: folder.currentSnapshotId ? this.timeline.files.count(folder.currentSnapshotId) : 0,
        events: stats.events, firstAt: stats.first, lastAt: stats.last };
    });
    const ids = folders.map((folder) => folder.id);
    const marks = ids.map(() => '?').join(',');
    const objects = ids.length ? this.db.prepare(`SELECT COUNT(*) AS count FROM object_changes c
      JOIN snapshots s ON s.id = c.snapshot_id WHERE s.project_id IN (${marks})`).get(...ids).count : 0;
    const people = ids.length ? this.db.prepare(`SELECT a.display_name AS name, a.actor_type AS type, COUNT(*) AS events,
        MAX(e.occurred_at) AS last FROM timeline_events e JOIN actors a ON a.id = e.actor_id
      WHERE e.project_id IN (${marks}) AND e.source NOT IN ('REINDEX', 'IMPORT', 'AI_RECORD') GROUP BY a.id ORDER BY events DESC`).all(...ids) : [];
    const failures = this.db.prepare('SELECT COUNT(*) AS count FROM index_failures WHERE resolved_at IS NULL').get().count;
    return {
      folders,
      files: folders.reduce((sum, folder) => sum + folder.files, 0),
      versions: folders.reduce((sum, folder) => sum + (folder.version ?? 0), 0),
      valueChanges: objects,
      since: folders.map((folder) => folder.firstAt).filter(Boolean).sort()[0] ?? null,
      people,
      failures,
      activity: this.activity(ids),
      ai: this.aiWrites(),
    };
  }

  /** Recorded changes per day for the last two weeks, oldest first, for a sparkline. */
  activity(ids = this.folders().map((folder) => folder.id), days = 14) {
    if (!ids.length) return new Array(days).fill(0);
    const start = new Date(this.now());
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    const counts = new Array(days).fill(0);
    const rows = this.db.prepare(`SELECT e.occurred_at FROM timeline_events e
      WHERE e.project_id IN (${ids.map(() => '?').join(',')}) AND e.occurred_at >= ? AND e.source NOT IN ('REINDEX', 'IMPORT', 'AI_RECORD')`)
      .all(...ids, start.toISOString());
    for (const row of rows) {
      const day = Math.floor((Date.parse(row.occurred_at) - start.getTime()) / 86_400_000);
      if (day >= 0 && day < days) counts[day] += 1;
    }
    return counts;
  }

  // ── finding a file ─────────────────────────────────────────────────────

  /**
   * The library file a person means: a path on disk inside a folder, a
   * path inside a folder, or the end of one ("Q3/model.csv", "model.csv").
   */
  resolveFile(query, { cwd = process.cwd() } = {}) {
    const raw = String(query ?? '').trim();
    if (!raw) throw new HttpError(400, 'Name a file.');
    const folders = this.folders();
    const absolute = path.resolve(cwd, untilde(raw));
    for (const folder of folders) {
      const relative = path.relative(folder.rootPath, absolute);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        const file = this.timeline.snapshotFile(folder.currentSnapshotId, relative.split(path.sep).join('/'));
        if (file) return { folder, file, absolute, others: [] };
      }
    }
    const wanted = raw.replace(/^\.\//, '').toLowerCase();
    const candidates = [];
    for (const folder of folders) {
      if (!folder.currentSnapshotId) continue;
      const exact = this.timeline.snapshotFile(folder.currentSnapshotId, raw);
      if (exact) candidates.push({ folder, file: exact, rank: 0 });
      else {
        for (const file of this.timeline.snapshotFiles(folder.currentSnapshotId)) {
          const lower = file.path.toLowerCase();
          const rank = lower === wanted ? 0 : lower.endsWith(`/${wanted}`) ? 1
            : path.posix.basename(lower) === path.posix.basename(wanted) ? 2 : null;
          if (rank !== null) candidates.push({ folder, file, rank });
        }
      }
    }
    candidates.sort((a, b) => a.rank - b.rank || a.file.path.length - b.file.path.length || a.file.path.localeCompare(b.file.path));
    if (!candidates.length) throw new HttpError(404, `No file named ${raw} in your Lasso folders.`);
    const [best, ...others] = candidates;
    return { folder: best.folder, file: best.file, absolute: path.join(best.folder.rootPath, best.file.path),
      others: others.slice(0, 5).map((other) => ({ folder: other.folder.name, path: other.file.path })) };
  }

  // ── whence ─────────────────────────────────────────────────────────────

  /**
   * Where a file's exact bytes came from: each library file that held them,
   * when they were first recorded there and by whom, and whether they are
   * still that file's current content. Works for any file on disk, such as
   * an attachment saved from an email.
   */
  whence(target, { cwd = process.cwd(), hash: known = null } = {}) {
    const absolute = path.resolve(cwd, untilde(target));
    let stats;
    try { stats = fs.statSync(absolute); } catch { throw new HttpError(404, `There is no file at ${target}.`); }
    if (!stats.isFile()) throw new HttpError(400, `${target} is a folder; whence reads one file.`);
    const hash = known ?? sha256File(absolute);
    const rows = this.db.prepare(`SELECT sf.path, sf.project_file_id, s.id AS snapshot_id, s.version, s.created_at,
        p.id AS project_id, p.name AS folder_name, p.root_path, p.current_snapshot_id
      FROM snapshot_files sf JOIN snapshots s ON s.id = sf.snapshot_id JOIN projects p ON p.id = s.project_id
      WHERE sf.content_hash = ? AND p.workspace_removed = 0 ORDER BY s.created_at, s.version LIMIT 2000`).all(hash);
    const firsts = new Map();
    for (const row of rows) {
      const key = `${row.project_id}|${row.project_file_id}`;
      if (!firsts.has(key)) firsts.set(key, row);
    }
    const matches = [...firsts.values()].map((row) => {
      const event = this.db.prepare(EVENT_AT_SNAPSHOT).get(row.snapshot_id);
      const current = row.current_snapshot_id ? this.timeline.snapshotFileById(row.current_snapshot_id, row.project_file_id) : null;
      const replaced = current?.contentHash === hash ? null : this.db.prepare(`SELECT fc.change_type, s.version, e.occurred_at,
          e.source, a.display_name AS actor_name, a.actor_type, fc.path_after
        FROM file_changes fc JOIN timeline_events e ON e.id = fc.event_id JOIN snapshots s ON s.id = e.resulting_snapshot_id
        JOIN actors a ON a.id = e.actor_id
        WHERE fc.project_file_id = ? AND fc.content_hash_before = ? AND s.version > ? ORDER BY s.version LIMIT 1`)
        .get(row.project_file_id, hash, row.version);
      return {
        folder: { id: row.project_id, name: row.folder_name, rootPath: row.root_path },
        path: row.path,
        version: row.version,
        recordedAt: event?.occurred_at ?? row.created_at,
        how: event?.source ?? null,
        actor: actorOf(event),
        request: event?.request_text ?? null,
        current: current?.contentHash === hash,
        currentPath: current?.path ?? null,
        replaced: replaced ? { at: replaced.occurred_at, version: replaced.version, actor: actorOf(replaced),
          how: replaced.source, change: replaced.change_type } : null,
      };
    });
    const tracked = this.trackedAt(absolute);
    const sameName = matches.length ? [] : this.sameNamed(path.basename(absolute));
    return { file: absolute, name: path.basename(absolute), size: stats.size, modifiedAt: stats.mtime.toISOString(),
      hash, matches, tracked, sameName };
  }

  /** The folder file at a path on disk, and whether its bytes there are the ones Lasso recorded last. */
  trackedAt(absolute) {
    for (const folder of this.folders()) {
      const relative = path.relative(folder.rootPath, absolute);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const file = this.timeline.snapshotFile(folder.currentSnapshotId, relative.split(path.sep).join('/'));
      return { folder: { id: folder.id, name: folder.name }, path: relative.split(path.sep).join('/'),
        recorded: Boolean(file), recordedHash: file?.contentHash ?? null, version: folder.currentVersion };
    }
    return null;
  }

  /** Library files with this name, newest first, when no recorded version has the same bytes. */
  sameNamed(name) {
    const out = [];
    for (const folder of this.folders()) {
      if (!folder.currentSnapshotId) continue;
      for (const file of this.timeline.snapshotFiles(folder.currentSnapshotId)) {
        if (path.posix.basename(file.path).toLowerCase() !== name.toLowerCase()) continue;
        const last = this.db.prepare(`SELECT e.occurred_at, a.display_name AS actor_name, a.actor_type FROM file_changes fc
          JOIN timeline_events e ON e.id = fc.event_id JOIN actors a ON a.id = e.actor_id
          WHERE fc.project_file_id = ? ORDER BY e.occurred_at DESC LIMIT 1`).get(file.projectFileId);
        out.push({ folder: folder.name, path: file.path, size: file.size, changedAt: last?.occurred_at ?? null, actor: actorOf(last) });
      }
    }
    return out.sort((a, b) => String(b.changedAt).localeCompare(String(a.changedAt))).slice(0, 8);
  }

  // ── log ────────────────────────────────────────────────────────────────

  /**
   * Recorded changes across folders, newest first: The Loop's Recent
   * Changes (two weeks), narrowed by folder, file, person or time.
   */
  log({ folder = null, file = null, by = null, since = null, limit = 40 } = {}) {
    const folders = this.folders().filter((entry) => !folder
      || entry.name.toLowerCase().includes(String(folder).toLowerCase()));
    if (folder && !folders.length) throw new HttpError(404, `No folder named ${folder}.`);
    const names = new Map(folders.map((entry) => [entry.id, entry.name]));
    const { entries, truncated } = recentHistory(this.db, folders.map((entry) => entry.id), this.now());
    const from = since ? parseSince(since, this.now()) : null;
    if (since && from === null) throw new HttpError(400, `Lasso cannot read "${since}" as a time. Try 2h, 3d, 1w, today or yesterday.`);
    const person = by ? String(by).toLowerCase() : null;
    const fileText = file ? String(file).toLowerCase() : null;
    const kept = entries.filter((entry) => (!from || Date.parse(entry.at) >= from)
      && (!fileText || String(entry.path ?? '').toLowerCase().includes(fileText))
      && (!person || matchesPerson(entry.actor, person)));
    const requests = new Map();
    for (const entry of kept.slice(0, limit)) {
      const ai = this.aiInSave(entry.id);
      if (ai.length) requests.set(entry.id, { ai });
      if (entry.source === 'AGENT_EDIT' || entry.actor?.type === 'AI_AGENT') {
        const event = this.db.prepare(`SELECT x.request_text, i.display_name AS initiator_name, i.actor_type AS initiator_type FROM file_changes fc
          JOIN timeline_events e ON e.id = fc.event_id LEFT JOIN agent_executions x ON x.id = e.agent_execution_id
          LEFT JOIN actors i ON i.id = e.initiated_by_actor_id WHERE fc.id = ?`).get(entry.id);
        if (event) {
          // A save Lasso credited to Claude Code carries the prompt its hook heard, not an agent request of Lasso's own.
          requests.set(entry.id, { ai: ai.length ? ai : undefined, request: event.request_text ?? ai.find((write) => write.prompt)?.prompt ?? null,
            initiator: event.initiator_name ? { name: event.initiator_name, type: event.initiator_type } : null });
        }
      }
    }
    return {
      days: HISTORY_DAYS,
      total: kept.length,
      truncated: truncated || kept.length > limit,
      entries: kept.slice(0, limit).map((entry) => ({ ...entry, folder: names.get(entry.directoryId) ?? null,
        ...(requests.get(entry.id) ?? {}) })),
    };
  }

  // ── blame ──────────────────────────────────────────────────────────────

  /** Who last set each value or passage in a file, and when, in the file's reading order. */
  blame(query, { cwd = process.cwd(), limit = MAX_BLAME_ROWS } = {}) {
    const { folder, file, others } = this.resolveFile(query, { cwd });
    const inFile = this.dependencies.objectsAt(folder.id)
      .filter((object) => object.path === file.path && !isWholeFile(object));
    // A table's rows and its columns' summaries hold no value of their own; its cells do.
    const held = inFile.filter((object) => !SUMMARY_TYPES.has(object.objectType) && !/:row-count$/.test(object.objectKey ?? '')
      && String(object.valueText ?? '').trim());
    const objects = held.length ? held : inFile;
    objects.sort((a, b) => compareOrder(a.anchor ?? null, b.anchor ?? null) || String(a.label).localeCompare(String(b.label)));
    const rows = objects.slice(0, limit).map((object) => {
      const change = this.db.prepare(LAST_OBJECT_CHANGE).get(object.id);
      const first = change ? null : this.db.prepare(FIRST_OBJECT_VERSION).get(object.id);
      const from = change ?? first;
      return {
        objectId: object.id,
        label: object.label,
        type: object.objectType,
        value: object.valueText ?? null,
        place: placeOf(object.anchor ?? null, object.metadata ?? {}, object.path),
        version: from?.version ?? null,
        at: from?.created_at ?? null,
        actor: actorOf(from),
        how: from?.source ?? null,
        kind: change?.kind ?? 'added',
        before: change?.kind === 'modified' ? change.before_value : null,
      };
    });
    const people = new Map();
    for (const row of rows) {
      const name = row.actor?.name ?? 'unknown';
      people.set(name, { actor: row.actor, rows: (people.get(name)?.rows ?? 0) + 1 });
    }
    return { folder: { id: folder.id, name: folder.name }, path: file.path, fileType: file.fileType, size: file.size,
      total: objects.length, rows, people: [...people.values()].sort((a, b) => b.rows - a.rows), others,
      ai: this.aiWritten(folder.id, file.path) };
  }

  /** The parts of a file an AI wrote, as recorded when it wrote them; null when there are none. */
  aiWritten(folderId, filePath) {
    try {
      const found = this.authorshipService().forFile(folderId, filePath);
      return found.spans.length ? found : null;
    } catch {
      return null;
    }
  }

  authorshipService() {
    this.authorship ??= new AuthorshipService({ db: this.db, timeline: this.timeline, config: { dataDir: this.dataDir ?? '', watchProjects: false } });
    return this.authorship;
  }

  /**
   * How much of a file's current text each AI wrote, for whence: { letters,
   * agents: [{ agent, parts, letters, share, kinds, tool, model, at, prompt }] },
   * letters counted without spaces; null when no AI wrote any of it.
   */
  aiShare(folderId, filePath) {
    const found = this.aiWritten(folderId, filePath);
    if (!found) return null;
    try {
      const folder = this.timeline.getProject(folderId);
      const file = this.timeline.snapshotFile(folder.currentSnapshotId, filePath);
      const text = file ? this.authorshipService().readable(file.contentHash, filePath) : null;
      const letters = (value) => String(value ?? '').replace(/\s+/g, '').length;
      const total = letters(text);
      const marks = new Map(found.marks.map((mark) => [mark.id, mark]));
      const byAgent = new Map();
      for (const span of found.spans) {
        const mark = marks.get(span.markId);
        if (!mark) continue;
        const entry = byAgent.get(mark.agent.id) ?? { agent: mark.agent, parts: 0, letters: 0, kinds: new Set(), latest: null };
        entry.parts += 1;
        entry.letters += letters(span.text);
        entry.kinds.add(mark.kind);
        if (!entry.latest || String(mark.at) > String(entry.latest.at)) entry.latest = mark;
        byAgent.set(mark.agent.id, entry);
      }
      const agents = [...byAgent.values()].sort((a, b) => b.letters - a.letters).map((entry) => ({
        agent: entry.agent, parts: entry.parts, letters: entry.letters, share: total ? Math.min(1, entry.letters / total) : 0,
        kinds: [...entry.kinds], tool: entry.latest.tool, model: entry.latest.model, at: entry.latest.at, prompt: entry.latest.prompt,
      }));
      return { folder: { id: folderId, name: folder.name }, path: filePath, letters: total, kind: found.kind, agents, total: found.total };
    } catch {
      return null;
    }
  }

  /** One recorded change's file version and the save that wrote it. */
  changeVersion(changeId) {
    return this.db.prepare(`SELECT fc.project_file_id, fc.content_hash_after, fc.path_after, e.resulting_snapshot_id
      FROM file_changes fc JOIN timeline_events e ON e.id = fc.event_id WHERE fc.id = ?`).get(changeId) ?? null;
  }

  /** Who of the AIs wrote characters in one recorded change of a file: [{ agent, kind, tool, model, prompt, characters }]. */
  aiInSave(changeId) {
    try {
      const change = this.changeVersion(changeId);
      if (!change?.content_hash_after) return [];
      const spans = this.authorshipService().storedSpans(change.project_file_id, change.content_hash_after);
      if (!spans?.length) return [];
      const characters = new Map();
      for (const span of spans) characters.set(span.m, (characters.get(span.m) ?? 0) + (span.e - span.s));
      const ids = [...characters.keys()];
      return this.db.prepare(`SELECT m.id, m.kind, m.tool, m.model, m.prompt, m.agent_actor_id, a.display_name AS agent_name
        FROM ai_marks m JOIN actors a ON a.id = m.agent_actor_id
        WHERE m.matched_snapshot_id = ? AND m.id IN (${ids.map(() => '?').join(',')}) ORDER BY m.started_at`)
        .all(change.resulting_snapshot_id, ...ids)
        .map((mark) => ({ agent: { id: mark.agent_actor_id, name: mark.agent_name }, kind: mark.kind, tool: mark.tool,
          model: mark.model, prompt: mark.prompt, characters: characters.get(mark.id) }));
    } catch {
      return [];
    }
  }

  /**
   * The lines of a recorded change's new version that hold an AI's
   * characters, for marking a diff: { lines: { [line]: markId }, marks,
   * written (the marks written in this save) }. Only text files, whose
   * lines are the file's own.
   */
  aiInChange(changeId) {
    try {
      const change = this.changeVersion(changeId);
      if (!change?.content_hash_after || readableKind(change.path_after) !== 'text') return null;
      const authorship = this.authorshipService();
      const spans = authorship.storedSpans(change.project_file_id, change.content_hash_after);
      if (!spans?.length) return null;
      const text = authorship.readable(change.content_hash_after, change.path_after);
      if (text == null) return null;
      const starts = [0];
      for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) starts.push(index + 1);
      const lineAt = (offset) => {
        let line = 0;
        while (line + 1 < starts.length && starts[line + 1] <= offset) line += 1;
        return line + 1;
      };
      const lines = {};
      for (const span of spans) {
        for (let line = lineAt(span.s); line <= lineAt(Math.max(span.s, span.e - 1)); line += 1) lines[line] ??= span.m;
      }
      const written = this.db.prepare(`SELECT id FROM ai_marks WHERE matched_snapshot_id = ?`).all(change.resulting_snapshot_id).map((row) => row.id);
      return { lines, marks: authorship.describe(spans, text), written };
    } catch {
      return null;
    }
  }

  /** Writes Lasso has recorded each AI making, by how: [{ agent, kind, count, last }]. */
  aiWrites() {
    try {
      return this.db.prepare(`SELECT m.agent_actor_id AS id, a.display_name AS name, m.kind, COUNT(*) AS count, MAX(m.matched_at) AS last
        FROM ai_marks m JOIN actors a ON a.id = m.agent_actor_id WHERE m.matched_at IS NOT NULL
        GROUP BY m.agent_actor_id, m.kind ORDER BY count DESC`).all()
        .map((row) => ({ agent: { id: row.id, name: row.name }, kind: row.kind, count: row.count, last: row.last }));
    } catch {
      return [];
    }
  }

  // ── diff ───────────────────────────────────────────────────────────────

  /** The recorded changes of a file, newest first, and the detail of one (the latest unless `version` names one). */
  diff(query, { cwd = process.cwd(), version = null } = {}) {
    const { folder, file, absolute, others } = this.resolveFile(query, { cwd });
    const changes = this.db.prepare(`SELECT fc.id, fc.change_type, s.version, e.occurred_at, e.source,
        a.display_name AS actor_name, a.actor_type
      FROM file_changes fc JOIN timeline_events e ON e.id = fc.event_id JOIN snapshots s ON s.id = e.resulting_snapshot_id
      JOIN actors a ON a.id = e.actor_id WHERE fc.project_file_id = ? ORDER BY s.version DESC LIMIT 60`).all(file.projectFileId)
      .map((row) => ({ id: row.id, change: row.change_type, version: row.version, at: row.occurred_at, how: row.source, actor: actorOf(row) }));
    const wanted = version === null || version === undefined ? null : Number(String(version).replace(/^v/i, ''));
    if (wanted !== null && !Number.isInteger(wanted)) throw new HttpError(400, `"${version}" is not a version number.`);
    const chosen = wanted === null ? changes[0] : changes.find((change) => change.version === wanted);
    if (!chosen) {
      throw new HttpError(404, wanted === null ? `Lasso has no recorded change of ${file.path}.`
        : `${file.path} did not change in version ${wanted}. Its changes: ${changes.slice(0, 8).map((c) => `v${c.version}`).join(', ')}.`);
    }
    const detail = changeDetail({ db: this.db, timeline: this.timeline }, chosen.id);
    let onDisk = null;
    try { onDisk = sha256File(absolute) === file.contentHash ? 'recorded' : 'changed'; } catch { onDisk = 'missing'; }
    return { folder: { id: folder.id, name: folder.name }, path: file.path, changes, chosen, detail, onDisk, others,
      ai: detail.lines ? this.aiInChange(chosen.id) : null };
  }

  // ── verify ─────────────────────────────────────────────────────────────

  /**
   * Every number written in a document, checked against the values Lasso has
   * indexed: current (a source holds it now), stale (a source held it once
   * and now holds another), or unsourced. A match must share a word with
   * its sentence, as a suggestion must (docs/lasso-ranking-algorithm.pdf).
   */
  verify(target, { cwd = process.cwd() } = {}) {
    const absolute = path.resolve(cwd, untilde(target));
    let text;
    try { text = readDocumentText(absolute); } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(404, `Lasso cannot read ${target}: ${error.message}`);
    }
    const claims = numbersIn(text).slice(0, MAX_VERIFY_NUMBERS);
    const ownPath = this.trackedAt(absolute);
    const index = this.valueIndex(new Set(claims.map((claim) => claim.key)), ownPath);
    const results = claims.map((claim) => this.judge(claim, index));
    const tally = { current: 0, stale: 0, ambiguous: 0, unsourced: 0 };
    for (const result of results) tally[result.status] += 1;
    return { file: absolute, name: path.basename(absolute), numbers: claims.length, tally, results };
  }

  /**
   * Indexed values equal to any of `keys`, in active folders, as
   * { key: [{ objectId, folder, path, label, value, current, place }] }.
   * A value held only in an earlier version is still listed, with what the
   * object holds now, so a stale number can say what replaced it.
   */
  valueIndex(keys, own = null) {
    const byKey = new Map();
    const folders = this.folders();
    if (!keys.size || !folders.length) return byKey;
    const add = (key, entry) => {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(entry);
    };
    // The document's own numbers are not a source for themselves.
    const isOwn = (folderId, filePath) => own && own.folder.id === folderId && own.path === filePath;
    // What each value-holding object holds now: read from the folders' current objects, as suggestions are.
    const now = new Map();
    const present = new Set();
    for (const folder of folders) {
      for (const object of this.dependencies.objectsAt(folder.id, null, VALUE_TYPES)) {
        if (/:row-count$/.test(object.objectKey ?? '')) continue;
        now.set(object.id, { folder, object });
        present.add(`${folder.id}|${object.path}|${object.label}`);
        const key = numberKey(object.valueText);
        if (!key || !keys.has(key) || isOwn(folder.id, object.path)) continue;
        add(key, { objectId: object.id, folder: folder.name, path: object.path, label: object.label, value: object.valueText,
          currentValue: object.valueText, removed: false, current: true,
          place: placeOf(object.anchor ?? null, object.metadata ?? {}, object.path) });
      }
    }
    // What they held once: every value a recorded change replaced or removed. Far fewer rows than every version.
    const names = new Map(folders.map((folder) => [folder.id, folder]));
    const seen = new Set();
    const rows = this.db.prepare(`SELECT c.object_id, b.value_text, b.label, b.path, b.anchor_json, b.metadata_json, s.project_id
      FROM object_changes c
      JOIN snapshots s ON s.id = c.snapshot_id
      JOIN scientific_objects o ON o.id = c.object_id
      JOIN scientific_object_versions b ON b.id = c.before_version_id
      WHERE s.project_id IN (${folders.map(() => '?').join(',')}) AND c.kind IN ('modified', 'removed')
        AND o.object_type IN (${VALUE_TYPES.map(() => '?').join(',')})`).all(...folders.map((folder) => folder.id), ...VALUE_TYPES);
    for (const row of rows) {
      const key = numberKey(row.value_text);
      if (!key || !keys.has(key) || seen.has(`${key}|${row.object_id}`)) continue;
      seen.add(`${key}|${row.object_id}`);
      const current = now.get(row.object_id)?.object ?? null;
      if (current && numberKey(current.valueText) === key) continue;
      const folder = names.get(row.project_id);
      if (isOwn(folder.id, current?.path ?? row.path)) continue;
      // A newer reader can name a file's cells anew, recording the old names as removed. The cell is still there.
      if (!current && present.has(`${folder.id}|${row.path}|${row.label}`)) continue;
      add(key, { objectId: row.object_id, folder: folder.name, path: current?.path ?? row.path, label: current?.label ?? row.label,
        value: row.value_text, currentValue: current?.valueText ?? null, removed: !current, current: false,
        place: current ? placeOf(current.anchor ?? null, current.metadata ?? {}, current.path)
          : placeOf(parseJson(row.anchor_json), parseJson(row.metadata_json, {}), row.path) });
    }
    return byKey;
  }

  /**
   * The source a number most likely came from: the one whose own name
   * shares most words with the number's sentence (its file's name counts
   * for less), a current source winning a tie with a stale one.
   */
  judge(claim, index) {
    return judgeClaim(claim, index, (objectId, key) => this.changeAway(objectId, key));
  }

  /** The change that took an object's value away from `key`, with who made it. */
  changeAway(objectId, key) {
    const changes = this.db.prepare(OBJECT_VALUE_CHANGES).all(objectId);
    const away = [...changes].reverse().find((change) => numberKey(change.before_value) === key
      && numberKey(change.after_value) !== key);
    return away ? { at: away.created_at, version: away.version, before: away.before_value, after: away.after_value,
      actor: actorOf(away), how: away.source } : null;
  }

  // ── watch ──────────────────────────────────────────────────────────────

  /** The newest event's position, to watch from. */
  cursor() {
    return this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS cursor FROM timeline_events').get().cursor;
  }

  /** Events recorded after `cursor` in active folders, oldest first, each with the files it changed. */
  events(cursor) {
    const folders = new Map(this.folders().map((folder) => [folder.id, folder.name]));
    const rows = this.db.prepare(`SELECT e.rowid AS position, e.id, e.project_id, e.occurred_at, e.source, e.title,
        a.display_name AS actor_name, a.actor_type
      FROM timeline_events e JOIN actors a ON a.id = e.actor_id WHERE e.rowid > ? ORDER BY e.rowid LIMIT 200`).all(cursor);
    const events = rows.filter((row) => folders.has(row.project_id) && row.source !== 'REINDEX' && row.source !== 'AI_RECORD').map((row) => ({
      id: row.id, folder: folders.get(row.project_id), at: row.occurred_at, how: row.source, title: row.title, actor: actorOf(row),
      files: this.db.prepare(`SELECT change_type, COALESCE(path_after, path_before) AS path FROM file_changes
        WHERE event_id = ? ORDER BY rowid LIMIT 6`).all(row.id).map((file) => ({ change: file.change_type, path: file.path })),
      fileCount: this.db.prepare('SELECT COUNT(*) AS count FROM file_changes WHERE event_id = ?').get(row.id).count,
      // Values the save changed, once the folder's index has read it (the app reads it right after recording).
      values: this.db.prepare(`SELECT b.label, b.value_text AS before, a.value_text AS after FROM timeline_events e
        JOIN object_changes c ON c.snapshot_id = e.resulting_snapshot_id
        JOIN scientific_objects o ON o.id = c.object_id
        JOIN scientific_object_versions b ON b.id = c.before_version_id
        JOIN scientific_object_versions a ON a.id = c.after_version_id
        WHERE e.id = ? AND c.kind = 'modified' AND b.value_text IS NOT a.value_text
          AND o.object_type IN (${VALUE_TYPES.map(() => '?').join(',')}) LIMIT 4`).all(row.id, ...VALUE_TYPES),
    }));
    return { cursor: rows.at(-1)?.position ?? cursor, events };
  }
}

function matchesPerson(actor, wanted) {
  if (!actor) return false;
  if (['ai', 'agent', 'agents', 'bot'].includes(wanted)) return actor.type === 'AI_AGENT';
  if (['me', 'you', 'self'].includes(wanted)) return actor.type === 'HUMAN_SELF';
  return String(actor.name ?? '').toLowerCase().includes(wanted);
}

const strip = ({ score: _score, ...source }) => source;


/** A document's text as verify reads it: Word, PDF, or any text format. */
/**
 * One number's verdict from the sources that hold its value: the source
 * whose label shares most words with the number's sentence (its file's
 * name counting for less), current before stale. `changeAway` says how a
 * stale source's value changed, when the sources have history.
 */
export function judgeClaim(claim, index, changeAway = () => null) {
  const words = wordsOf(claim.sentence);
  const scored = (index.get(claim.key) ?? []).map((source) => ({ ...source,
    score: 2 * overlap(words, wordsOf(source.label))
      + overlap(words, wordsOf(path.posix.basename(source.path).replace(/\.[^.]+$/, ''))) }))
    .sort((a, b) => b.score - a.score || Number(b.current) - Number(a.current) || Number(a.removed) - Number(b.removed));
  const best = scored[0];
  const base = { line: claim.line, number: claim.raw, sentence: claim.sentence, candidates: scored.length };
  if (!best) return { ...base, status: 'unsourced', source: null };
  if (best.score < 2) return { ...base, status: 'ambiguous', source: strip(best) };
  if (best.current) return { ...base, status: 'current', source: strip(best) };
  return { ...base, status: 'stale', source: strip(best), change: changeAway(best.objectId, claim.key) };
}

export function readDocumentText(file) {
  const stats = fs.statSync(file);
  if (!stats.isFile()) throw new HttpError(400, `${path.basename(file)} is not a file.`);
  const buffer = fs.readFileSync(file);
  if (/\.docx$/i.test(file)) return extractDocxFullText(buffer);
  if (/\.pdf$/i.test(file)) return extractPdfFullText(buffer);
  if (/\.pptx$/i.test(file)) return deckText(buffer);
  if (TEXT_TYPES.test(file) || !buffer.subarray(0, 4096).includes(0)) {
    const text = buffer.toString('utf8').slice(0, MAX_VERIFY_TEXT);
    return /\.html?$/i.test(file) ? text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ') : text;
  }
  throw new HttpError(415, `Lasso can verify Word, PDF, PowerPoint and text documents; ${path.basename(file)} is none of those.`);
}

/** A deck's words, a line per piece of text, each slide headed by its number and title. */
export function deckText(buffer) {
  const deck = readPresentation(buffer);
  return (deck.slides ?? []).flatMap((slide) => [`Slide ${slide.number}${slide.title ? ` · ${slide.title}` : ''}`,
    ...(slide.blocks ?? []).filter((block) => block.type !== 'title').map((block) => (block.type === 'table'
      ? (block.rows ?? []).map((row) => row.join(' · ')).join('\n') : String(block.text ?? '').trim())).filter(Boolean)]).join('\n');
}

const MONTH_BEFORE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*$/i;
const NUMBER = /(?<![\p{L}\p{N}_.\-/:])[-−]?[$€£¥]?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|(?<![\p{L}\p{N}_.\-/:])[-−]?[$€£¥]?\d+(?:\.\d+)?%?(?![\p{L}\d/:])/gu;

/** One number's comparable form, or null for anything that is not just a number. */
export function numberKey(value) {
  const text = String(value ?? '').trim().replace(/^[$€£¥]/, '').replace(/−/g, '-');
  const descriptor = numericDescriptor(text);
  if (!descriptor || !Number.isFinite(descriptor.number)) return null;
  return String(Number(descriptor.number.toPrecision(12)));
}

/**
 * The numbers a document states, with the sentence each sits in and its
 * line. Years, dates, list numbers and single digits are left out: they
 * name no value.
 */
export function numbersIn(text) {
  const out = [];
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, lineIndex) => {
    for (const match of line.matchAll(NUMBER)) {
      const raw = match[0];
      const digits = raw.replace(/\D/g, '');
      const before = line.slice(0, match.index);
      if (digits.replace(/^0+/, '').length < 2) continue;
      if (/^\s*$/.test(before) && /^\d+[.)]\s/.test(line.slice(match.index))) continue;
      if (/^(1[89]|20)\d\d$/.test(raw) || MONTH_BEFORE.test(before) || /^\d{4}-\d\d/.test(line.slice(match.index))) continue;
      const key = numberKey(raw.replace(/%$/, ''));
      if (!key) continue;
      out.push({ raw, key, line: lineIndex + 1, sentence: sentenceAround(line, match.index, raw.length) });
    }
  });
  return out;
}

function sentenceAround(line, at, length) {
  const start = Math.max(line.lastIndexOf('. ', at), line.lastIndexOf('! ', at), line.lastIndexOf('? ', at));
  const endMatch = line.slice(at + length).search(/[.!?](\s|$)/);
  const end = endMatch < 0 ? line.length : at + length + endMatch + 1;
  return line.slice(start < 0 ? 0 : start + 2, end).trim().replace(/\s+/g, ' ').slice(0, 240);
}

const STOP = new Set(['the', 'and', 'for', 'was', 'were', 'are', 'with', 'that', 'this', 'from', 'into', 'per', 'its', 'our',
  'their', 'has', 'have', 'had', 'not', 'but', 'than', 'then', 'also', 'which', 'value', 'values', 'total', 'current', 'period']);

export function wordsOf(text) {
  return new Set(String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !/^\d+$/.test(word) && !STOP.has(word) && !EVERYDAY_WORDS.has(word)));
}

/** Words two texts share, a word counting when one is the start of the other and both are five letters or more. */
export function overlap(left, right) {
  let shared = 0;
  for (const word of left) {
    if (right.has(word)) { shared += 1; continue; }
    if (word.length >= 5) for (const other of right) if (other.length >= 5 && (other.startsWith(word) || word.startsWith(other))) { shared += 1; break; }
  }
  return shared;
}
