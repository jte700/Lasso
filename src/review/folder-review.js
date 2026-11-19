// A folder's review: the files someone edited since it was last approved,
// and the files someone has asked to be changed, as The Ranch's review card
// shows them. Loading a folder puts nothing up for review, and neither does a
// capture of many files at once (a folder copied in or taken away, a sync, a
// checkout): an edit is a save that changed a file that was already there.
// Until a folder has been approved its review starts from when Lasso first
// read it. Once approved at its current version, the review shows what that
// approval covered, as approved, until the next edit starts a new one.
//
// Each file is shown the way its kind reads best: text and code line by line,
// workbooks and CSVs as grids of their changed cells, and the files Lasso
// reads into values (Word files, PDFs, decks) as the passages and values that
// changed. Comments sit beside the line, cell or passage they are pinned to.

import { isCodeType, isTextualType } from '../history/file-types.js';
import { MAX_FILES_PER_EVENT } from '../ranch/history.js';
import { cellAddress, cellValue, sheetDiff, sheetGrids } from './sheet-diff.js';
import { MAX_COMPARED_TEXT, MAX_SHOWN_LINES, findLine, lineDiff, linesOf } from './text-diff.js';
import { valueChanges } from './value-diff.js';

/** Files one review lists; past these the review counts the rest. */
export const MAX_REVIEW_FILES = 60;
/** Rows of a sheet no one edited shown, to ask for a change in. */
const UNEDITED_ROWS = 40;

const VERBS = { ADDED: 'added', DELETED: 'removed', RENAMED: 'renamed', MOVED: 'moved', MODIFIED: 'edited' };

/** How a file's changes are shown: lines, a sheet's grid, values, or the file alone. */
export function viewKind(fileType) {
  if (fileType === 'spreadsheet' || fileType === 'table') return 'sheet';
  if (isTextualType(fileType)) return 'lines';
  if (['document', 'presentation', 'pdf', 'drawing'].includes(fileType)) return 'values';
  return 'file';
}

const CODE_TYPES = new Set(['json', 'yaml', 'notebook']);
const isCode = (fileType) => isCodeType(fileType) || CODE_TYPES.has(fileType);
/** Kinds Lasso writes itself when a suggestion is applied or an AI is asked: text, code, CSV, .xlsx cells and .xls numbers. */
export function writable(file) {
  if (!file) return false;
  if (file.fileType === 'spreadsheet') return /\.xlsx?$/i.test(file.path);
  return viewKind(file.fileType) === 'lines' || file.fileType === 'table';
}

/**
 * The versions a review spans: from `base` (exclusive) to `current`. `approved`
 * is the approval that covers `current`, when there is one.
 */
export function reviewRange(db, records, projectId) {
  const current = db.prepare(`SELECT s.id, s.version, s.created_at FROM projects p JOIN snapshots s ON s.id = p.current_snapshot_id
    WHERE p.id = ?`).get(projectId);
  const first = db.prepare('SELECT id, version, created_at FROM snapshots WHERE project_id = ? ORDER BY version LIMIT 1').get(projectId);
  const approvals = records.approvals(projectId);
  const approved = approvals[0] && approvals[0].version >= current.version ? approvals[0] : null;
  const from = approved ? approvals[1] ?? null : approvals[0] ?? null;
  const base = from ? { id: from.snapshotId, version: from.version, at: from.at, approval: from }
    : { id: first.id, version: first.version, at: first.created_at, approval: null };
  return { base, current: { id: current.id, version: current.version, at: current.created_at }, approved };
}

// A save that edited a file: not a folder's first reading or a re-read, and not a capture of many files at once.
const EDITING_SAVE = `e.source NOT IN ('IMPORT', 'REINDEX')
  AND (SELECT COUNT(*) FROM file_changes g WHERE g.event_id = e.id) <= ?
  AND EXISTS (SELECT 1 FROM file_changes m WHERE m.event_id = e.id AND m.change_type = 'MODIFIED')`;

/** Who saved edits in the range, and how many such saves there were. */
function savers(db, projectId, base, current) {
  const rows = db.prepare(`SELECT e.id, a.id AS actor_id, a.display_name, a.actor_type, i.id AS asker_id, i.display_name AS asker_name
    FROM timeline_events e JOIN snapshots s ON s.id = e.resulting_snapshot_id JOIN actors a ON a.id = e.actor_id
    LEFT JOIN actors i ON i.id = e.initiated_by_actor_id
    WHERE e.project_id = ? AND s.version > ? AND s.version <= ? AND ${EDITING_SAVE}
    ORDER BY s.version`).all(projectId, base.version, current.version, MAX_FILES_PER_EVENT);
  const people = new Map();
  for (const row of rows) {
    people.set(row.actor_id, { id: row.actor_id, name: row.display_name, type: row.actor_type,
      ...(row.asker_id ? { askedBy: { id: row.asker_id, name: row.asker_name } } : {}) });
  }
  return { saves: rows.length, people: [...people.values()] };
}

/** Who edited each file in the range, latest last, by the file's id. */
function editorsByFile(db, projectId, base, current) {
  const byFile = new Map();
  for (const row of db.prepare(`SELECT f.project_file_id, a.id, a.display_name, a.actor_type
      FROM file_changes f JOIN timeline_events e ON e.id = f.event_id JOIN snapshots s ON s.id = e.resulting_snapshot_id
      JOIN actors a ON a.id = e.actor_id
      WHERE e.project_id = ? AND s.version > ? AND s.version <= ? AND f.change_type = 'MODIFIED' AND ${EDITING_SAVE}
      ORDER BY s.version`).all(projectId, base.version, current.version, MAX_FILES_PER_EVENT)) {
    if (!row.project_file_id) continue;
    const list = byFile.get(row.project_file_id) ?? [];
    const editor = { id: row.id, name: row.display_name, type: row.actor_type };
    byFile.set(row.project_file_id, [...list.filter((known) => known.id !== editor.id), editor]);
  }
  return byFile;
}

/**
 * The files saves edited in the range, each with how it read just before its
 * first edit there and how it reads now, in path order. A file edited back to
 * how it was is not among them, and neither is one since removed.
 */
export function editedFiles(db, timeline, projectId, base, current) {
  const first = new Map();
  for (const row of db.prepare(`SELECT f.project_file_id, e.previous_snapshot_id
      FROM file_changes f JOIN timeline_events e ON e.id = f.event_id JOIN snapshots s ON s.id = e.resulting_snapshot_id
      WHERE e.project_id = ? AND s.version > ? AND s.version <= ? AND f.change_type = 'MODIFIED' AND f.project_file_id IS NOT NULL
        AND ${EDITING_SAVE}
      ORDER BY s.version`).all(projectId, base.version, current.version, MAX_FILES_PER_EVENT)) {
    if (!first.has(row.project_file_id)) first.set(row.project_file_id, row);
  }
  const files = [];
  for (const [fileId, row] of first) {
    const after = timeline.snapshotFileById(current.id, fileId);
    const before = row.previous_snapshot_id ? timeline.snapshotFileById(row.previous_snapshot_id, fileId) : null;
    if (!after || !before || after.contentHash === before.contentHash) continue;
    files.push({ change: 'MODIFIED', before, after });
  }
  return files.sort((left, right) => left.after.path.localeCompare(right.after.path));
}

export class FolderReview {
  /** @param {{ db, timeline, records: import('./records.js').ReviewRecords }} context */
  constructor({ db, timeline, records }) {
    this.db = db;
    this.timeline = timeline;
    this.records = records;
  }

  /** A workbook saved again with no cell changed (Excel does on opening one) is not a change to review. */
  meaningful(projectId, range, entry) {
    if (entry.change !== 'MODIFIED' || viewKind(entry.after.fileType) !== 'sheet') return true;
    const read = (file) => this.timeline.blobs.get(file.contentHash);
    try {
      const diff = sheetDiff({ beforeBuffer: read(entry.before), afterBuffer: read(entry.after), fileType: entry.after.fileType, filePath: entry.after.path });
      return diff.counts.cells + diff.counts.rowsAdded + diff.counts.rowsRemoved > 0;
    } catch (error) {
      if (error?.code === 'BLOB_RELEASED') return true;
      throw error;
    }
  }

  /**
   * The files a folder's review lists, with what each needs to draw its tab:
   * those edited, then those someone has asked to be changed and no one has
   * edited, while the request is open.
   */
  files(projectId, range, viewerId) {
    const viewed = this.records.viewed(projectId, viewerId);
    const threads = this.records.threads(projectId);
    const editors = editorsByFile(this.db, projectId, range.base, range.current);
    const edited = editedFiles(this.db, this.timeline, projectId, range.base, range.current)
      .filter((entry) => this.meaningful(projectId, range, entry));
    const listed = new Set(edited.map((entry) => entry.after.path));
    const requested = [...new Set(threads.filter((thread) => !thread.resolved && !thread.applied && !listed.has(thread.path))
      .map((thread) => thread.path))].sort((left, right) => left.localeCompare(right))
      .map((filePath) => this.timeline.snapshotFile(range.current.id, filePath))
      .filter(Boolean).map((file) => ({ change: 'UNCHANGED', before: file, after: file }));
    const all = [...edited, ...requested];
    const context = { viewed, threads, editors };
    return { total: all.length, requests: requested.length, files: all.slice(0, MAX_REVIEW_FILES).map((entry) => this.tab(entry, context)) };
  }

  /** One file as its tab draws it: what happened to it, its comments, whether it was looked at. */
  tab(entry, { viewed, threads, editors }) {
    const file = entry.after ?? entry.before;
    const open = threads.filter((thread) => thread.path === file.path && !thread.resolved && !thread.applied);
    return {
      path: file.path, previousPath: entry.change === 'RENAMED' || (entry.before && entry.before.path !== file.path) ? entry.before.path : null,
      fileId: file.projectFileId, fileType: file.fileType, change: VERBS[entry.change] ?? entry.change.toLowerCase(), kind: viewKind(file.fileType),
      contentHash: entry.after?.contentHash ?? null,
      viewed: entry.after ? viewed.get(file.path) === entry.after.contentHash : viewed.has(file.path),
      comments: threads.filter((thread) => thread.path === file.path).reduce((sum, thread) => sum + thread.comments.length, 0),
      openThreads: open.length,
      editors: editors.get(file.projectFileId) ?? [],
    };
  }

  /**
   * A review asked for by name: its files as the folder's review shows them,
   * those edited since the folder was last approved with their changes and
   * the rest whole, to be looked at ("review"); its title, note and reviewers.
   */
  requestSummary(request, viewerId) {
    const projectId = request.projectId;
    const project = this.timeline.getProject(projectId);
    const range = reviewRange(this.db, this.records, projectId);
    const context = { viewed: this.records.viewed(projectId, viewerId), threads: this.records.threads(projectId),
      editors: editorsByFile(this.db, projectId, range.base, range.current) };
    const edited = new Map(editedFiles(this.db, this.timeline, projectId, range.base, range.current)
      .filter((entry) => this.meaningful(projectId, range, entry)).map((entry) => [entry.after.path, entry]));
    const files = request.paths.flatMap((filePath) => {
      const entry = edited.get(filePath);
      if (entry) return [this.tab(entry, context)];
      const file = this.timeline.snapshotFile(range.current.id, filePath);
      return file ? [this.tab({ change: 'REVIEW', before: file, after: file }, context)] : [];
    });
    const { saves, people } = savers(this.db, projectId, range.base, range.current);
    const pending = context.threads.filter((thread) => request.paths.includes(thread.path)).flatMap((thread) => thread.comments)
      .filter((comment) => comment.pending && comment.author.id === viewerId).length;
    return {
      directoryId: projectId, name: project.name,
      requestId: request.id, number: request.number, title: request.title, note: request.note, reviewers: request.reviewers,
      requestedBy: request.requestedBy, requestedAt: request.at,
      state: request.approved ? 'approved' : 'open',
      base: { version: range.base.version, at: range.base.at, approvedBy: range.base.approval?.by ?? null },
      current: { version: range.current.version, at: range.current.at },
      saves, people, pendingComments: pending, requests: 0,
      approval: request.approved ? { id: request.id, at: request.approved.at, by: request.approved.by, comments: 0 } : null,
      files, moreFiles: 0,
    };
  }

  /** A folder's review: its range, who changed what, its files and its approval. */
  summary(projectId, viewerId) {
    const project = this.timeline.getProject(projectId);
    const range = reviewRange(this.db, this.records, projectId);
    const { files, total, requests } = this.files(projectId, range, viewerId);
    const { saves, people } = savers(this.db, projectId, range.base, range.current);
    // A comment is pending for the person who wrote it, until their approval sends it.
    const pending = this.records.threads(projectId).flatMap((thread) => thread.comments)
      .filter((comment) => comment.pending && comment.author.id === viewerId).length;
    return {
      directoryId: projectId, name: project.name,
      state: range.approved ? 'approved' : files.length ? 'open' : 'empty',
      base: { version: range.base.version, at: range.base.at, approvedBy: range.base.approval?.by ?? null },
      current: { version: range.current.version, at: range.current.at },
      saves, people, pendingComments: pending, requests,
      approval: range.approved ? { id: range.approved.id, at: range.approved.at, by: range.approved.by, comments: range.approved.comments } : null,
      files, moreFiles: Math.max(0, total - files.length),
    };
  }

  /** One file of a folder's review: what changed in it, drawn for its kind, and its comments. */
  file(projectId, filePath, viewerId) {
    const range = reviewRange(this.db, this.records, projectId);
    const entry = editedFiles(this.db, this.timeline, projectId, range.base, range.current)
      .find((candidate) => candidate.after.path === filePath);
    const after = entry ? entry.after : this.timeline.snapshotFile(range.current.id, filePath);
    const before = entry ? entry.before : after;
    const file = after ?? before;
    if (!file) return null;
    const read = (side) => {
      if (!side) return null;
      try { return this.timeline.blobs.get(side.contentHash); } catch (error) {
        if (error?.code === 'BLOB_RELEASED') return null;
        throw error;
      }
    };
    const kind = viewKind(file.fileType);
    const threads = this.records.threads(projectId, filePath);
    const view = {
      path: file.path, previousPath: before && before.path !== file.path ? before.path : null, fileId: file.projectFileId,
      fileType: file.fileType, change: entry ? VERBS[entry.change] : 'unchanged', kind, code: kind === 'lines' && isCode(file.fileType),
      contentHash: after?.contentHash ?? null, writable: writable(after),
      viewed: after ? this.records.viewed(projectId, viewerId).get(file.path) === after.contentHash : false,
      size: { before: before?.size ?? null, after: after?.size ?? null },
      lines: null, sheet: null, values: null, valueCount: 0,
    };
    const placed = [];
    if (kind === 'lines') {
      const [beforeBytes, afterBytes] = [entry ? read(before) : read(after), read(after)];
      if ((beforeBytes?.length ?? 0) <= MAX_COMPARED_TEXT && (afterBytes?.length ?? 0) <= MAX_COMPARED_TEXT) {
        const now = linesOf(afterBytes);
        for (const thread of threads) {
          // A line rewritten by its own suggestion is found by the words it was given.
          const suggested = [...thread.comments].reverse().find((comment) => comment.suggestion)?.suggestion?.after;
          const line = thread.anchor?.kind !== 'line' ? null : findLine(now, thread.anchor)
            ?? (suggested != null ? findLine(now, { line: thread.anchor.line, text: suggested.split('\n')[0] }) : null);
          placed.push({ thread, position: line ? { line } : null, place: line ? `Line ${line}` : thread.anchor?.kind === 'line' ? `Line ${thread.anchor.line}` : null,
            current: line ? now[line - 1] : null });
        }
        // A file no one edited is shown whole, so a line of it can be asked to change.
        const pinned = entry ? new Set(placed.map((item) => item.position?.line).filter(Boolean))
          : new Set(Array.from({ length: Math.min(now.length, MAX_SHOWN_LINES) }, (_, index) => index + 1));
        view.lines = lineDiff(entry ? linesOf(beforeBytes) : now, now, pinned);
      }
    } else if (kind === 'sheet') {
      const [beforeBytes, afterBytes] = [entry ? read(before) : read(after), read(after)];
      const csv = file.fileType === 'table';
      for (const thread of threads) {
        const anchor = thread.anchor;
        const found = anchor?.kind === 'cell' && afterBytes ? cellValue(afterBytes, file.fileType, file.path, anchor) : null;
        placed.push({ thread, position: found !== null && anchor?.kind === 'cell' ? { sheet: anchor.sheet, row: anchor.row, column: anchor.column } : null,
          place: anchor?.kind === 'cell' ? cellAddress(anchor.sheet, anchor.row, anchor.column, csv) : null, current: found });
      }
      const pinned = new Set(placed.filter((item) => item.position).map((item) => `${item.position.sheet}\u0000${item.position.row}`));
      // A sheet no one edited shows its first rows, so a cell of it can be asked to change.
      if (!entry) {
        for (const grid of sheetGrids(afterBytes, file.fileType, file.path)) {
          for (const row of grid.rowNumbers.slice(0, UNEDITED_ROWS)) pinned.add(`${grid.name}\u0000${row}`);
        }
      }
      view.sheet = sheetDiff({ beforeBuffer: beforeBytes, afterBuffer: afterBytes, fileType: file.fileType, filePath: file.path, pinned });
    } else if (kind === 'values' && entry) {
      const { values, count } = valueChanges(this.db, projectId, file.path, range.base.version, range.current.version);
      view.values = values;
      view.valueCount = count;
      for (const thread of threads) {
        const anchor = thread.anchor;
        const match = anchor?.kind === 'value' ? values.find((value) => value.place === anchor.place && value.label === anchor.label) : null;
        placed.push({ thread, position: match ? { place: anchor.place, label: anchor.label } : null, place: anchor?.place ?? null,
          current: match ? match.after : null });
      }
    }
    for (const thread of threads) if (!placed.some((item) => item.thread === thread)) placed.push({ thread, position: null, place: null, current: null });
    view.threads = placed.map(({ thread, position, place, current }) => this.shownThread(thread, position, place, current, viewerId));
    return view;
  }

  /** A thread as the card draws it, with whether its suggestion is in the file now. */
  shownThread(thread, position, place, current, viewerId) {
    const suggestion = [...thread.comments].reverse().find((comment) => comment.suggestion)?.suggestion ?? null;
    // A suggestion counts as applied once the file reads as it suggested, however that came about.
    const inFile = suggestion && current != null && current === suggestion.after;
    const applied = thread.applied ?? (inFile ? { at: null, by: null, saved: true } : null);
    const state = applied ? 'applied' : thread.resolved ? 'resolved' : position || thread.anchor?.kind === 'file' ? 'open' : 'outdated';
    const comments = thread.comments.map((comment) => ({ ...comment, pending: comment.pending && comment.author.id === viewerId }));
    return { ...thread, comments, applied, state, position, place: thread.anchor?.kind === 'file' ? null : place,
      suggestion, pending: comments.some((comment) => comment.pending) };
  }
}
