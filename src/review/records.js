// What a folder's review has recorded: its approvals, the threads of comments
// pinned to places in its files, and which files were marked as looked at.
// Everything here is written by a person or by an AI a person asked; Lasso
// adds nothing to a review on its own.

import crypto from 'node:crypto';
import { transaction } from '../db.js';
import { HttpError } from '../history/errors.js';

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const parse = (text) => {
  try { return JSON.parse(text ?? 'null'); } catch { return null; }
};

/** Longest comment, in characters; a review comment is a note, not a document. */
export const LONGEST_COMMENT = 8000;
const ANCHOR_KINDS = new Set(['line', 'cell', 'value', 'file']);

function commentBody(text) {
  const body = String(text ?? '').trim();
  if (!body) throw new HttpError(400, 'Write a comment first.');
  if (body.length > LONGEST_COMMENT) throw new HttpError(413, 'This comment is too long.');
  return body;
}

function checkedAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object' || !ANCHOR_KINDS.has(anchor.kind)) {
    throw new HttpError(400, 'Choose a line, cell or passage to comment on.');
  }
  if (anchor.kind === 'line' && !(Number.isInteger(anchor.line) && anchor.line > 0)) throw new HttpError(400, 'Choose a line.');
  if (anchor.kind === 'cell' && !(typeof anchor.sheet === 'string' && Number.isInteger(anchor.row) && Number.isInteger(anchor.column))) {
    throw new HttpError(400, 'Choose a cell.');
  }
  return anchor;
}

function checkedSuggestion(suggestion) {
  if (suggestion == null) return null;
  if (typeof suggestion !== 'object' || typeof suggestion.after !== 'string') throw new HttpError(400, 'A suggested change needs its new text.');
  if (suggestion.after.length > LONGEST_COMMENT) throw new HttpError(413, 'This suggested change is too long.');
  return { before: suggestion.before == null ? null : String(suggestion.before), after: suggestion.after };
}

const actorOf = (row, prefix) => (row[`${prefix}_id`]
  ? { id: row[`${prefix}_id`], name: row[`${prefix}_name`], type: row[`${prefix}_type`] } : null);

export class ReviewRecords {
  /** @param {{ db: import('node:sqlite').DatabaseSync, timeline: object }} context */
  constructor({ db, timeline }) {
    this.db = db;
    this.timeline = timeline;
  }

  actor(input) {
    return this.timeline.upsertActor(input);
  }

  // MARK: Approvals

  /** The approvals of a folder still standing, newest first, with the version each covers. */
  approvals(projectId) {
    return this.db.prepare(`SELECT r.id, r.snapshot_id, r.approved_at, s.version, a.id AS by_id, a.display_name AS by_name,
        a.actor_type AS by_type, (SELECT COUNT(*) FROM review_comments c WHERE c.approval_id = r.id) AS comments
      FROM review_approvals r JOIN snapshots s ON s.id = r.snapshot_id JOIN actors a ON a.id = r.actor_id
      WHERE r.project_id = ? AND r.undone_at IS NULL ORDER BY s.version DESC, r.approved_at DESC`).all(projectId)
      .map((row) => ({ id: row.id, snapshotId: row.snapshot_id, version: row.version, at: row.approved_at,
        by: actorOf(row, 'by'), comments: row.comments }));
  }

  /** Approves the folder up to `snapshotId`, sending this person's comments still pending in it. */
  approve(projectId, snapshotId, actorInput) {
    const actor = this.actor(actorInput);
    const approvalId = id();
    this.db.prepare('INSERT INTO review_approvals(id, project_id, snapshot_id, actor_id, approved_at) VALUES (?, ?, ?, ?, ?)')
      .run(approvalId, projectId, snapshotId, actor.id, now());
    this.db.prepare(`UPDATE review_comments SET approval_id = ? WHERE approval_id IS NULL AND prompt_text IS NULL
      AND agent_execution_id IS NULL AND actor_id = ? AND thread_id IN (SELECT id FROM review_threads WHERE project_id = ?)`)
      .run(approvalId, actor.id, projectId);
    return approvalId;
  }

  /** Takes an approval back; its comments are pending again. */
  undo(projectId, approvalId) {
    const found = this.db.prepare('SELECT id FROM review_approvals WHERE id = ? AND project_id = ? AND undone_at IS NULL').get(approvalId, projectId);
    if (!found) throw new HttpError(404, 'That approval was already taken back.');
    this.db.prepare('UPDATE review_approvals SET undone_at = ? WHERE id = ?').run(now(), approvalId);
    this.db.prepare('UPDATE review_comments SET approval_id = NULL WHERE approval_id = ?').run(approvalId);
  }

  // MARK: Threads

  /** A folder's threads with their comments, oldest first; with `path`, one file's. */
  threads(projectId, path = null) {
    const threads = this.db.prepare(`SELECT t.*, s.version AS snapshot_version,
        c.id AS by_id, c.display_name AS by_name, c.actor_type AS by_type,
        r.id AS resolver_id, r.display_name AS resolver_name, r.actor_type AS resolver_type,
        p.id AS applier_id, p.display_name AS applier_name, p.actor_type AS applier_type
      FROM review_threads t JOIN snapshots s ON s.id = t.snapshot_id JOIN actors c ON c.id = t.created_by_actor_id
      LEFT JOIN actors r ON r.id = t.resolved_by_actor_id LEFT JOIN actors p ON p.id = t.applied_by_actor_id
      WHERE t.project_id = ? AND (? IS NULL OR t.path = ?) ORDER BY t.created_at`).all(projectId, path, path);
    if (!threads.length) return [];
    const comments = new Map();
    for (const row of this.db.prepare(`SELECT m.*, a.id AS author_id, a.display_name AS author_name, a.actor_type AS author_type,
        i.id AS asker_id, i.display_name AS asker_name, i.actor_type AS asker_type
      FROM review_comments m JOIN actors a ON a.id = m.actor_id LEFT JOIN actors i ON i.id = m.initiated_by_actor_id
      WHERE m.thread_id IN (${threads.map(() => '?').join(',')}) ORDER BY m.created_at, m.rowid`).all(...threads.map((thread) => thread.id))) {
      if (!comments.has(row.thread_id)) comments.set(row.thread_id, []);
      comments.get(row.thread_id).push({
        id: row.id, author: actorOf(row, 'author'), initiatedBy: actorOf(row, 'asker'), body: row.body, at: row.created_at,
        pending: !row.approval_id && !row.prompt_text && !row.agent_execution_id,
        ...(row.suggestion_json ? { suggestion: parse(row.suggestion_json) } : {}),
        ...(row.prompt_text ? { prompt: row.prompt_text } : {}),
        ...(row.agent_execution_id ? { executionId: row.agent_execution_id } : {}),
      });
    }
    return threads.map((row) => ({
      id: row.id, projectId: row.project_id, path: row.path, anchor: parse(row.anchor_json), snapshotId: row.snapshot_id, version: row.snapshot_version,
      by: actorOf(row, 'by'), at: row.created_at,
      resolved: row.resolved_at ? { at: row.resolved_at, by: actorOf(row, 'resolver') } : null,
      applied: row.applied_at ? { at: row.applied_at, by: actorOf(row, 'applier') } : null,
      comments: comments.get(row.id) ?? [],
    }));
  }

  thread(threadId) {
    const row = this.db.prepare('SELECT project_id, path FROM review_threads WHERE id = ?').get(threadId);
    if (!row) throw new HttpError(404, 'That conversation is gone.');
    return this.threads(row.project_id, row.path).find((thread) => thread.id === threadId);
  }

  /** A new thread with its first comment. */
  startThread(projectId, { path, anchor, snapshotId, body, suggestion = null, prompt = null }, actorInput) {
    if (typeof path !== 'string' || !path) throw new HttpError(400, 'Choose a file to comment on.');
    const actor = this.actor(actorInput);
    const threadId = id();
    this.db.prepare(`INSERT INTO review_threads(id, project_id, path, anchor_json, snapshot_id, created_by_actor_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(threadId, projectId, path, JSON.stringify(checkedAnchor(anchor)), snapshotId, actor.id, now());
    this.addComment(threadId, { body, suggestion, prompt }, actor);
    return threadId;
  }

  /** A comment added to a thread: a reply, a suggestion, a prompt, or an AI's account of its edit. */
  addComment(threadId, { body, suggestion = null, prompt = null, executionId = null, initiatedBy = null }, actorInput) {
    const actor = this.actor(actorInput);
    const asker = initiatedBy ? this.actor(initiatedBy) : null;
    const commentId = id();
    const suggested = checkedSuggestion(suggestion);
    this.db.prepare(`INSERT INTO review_comments(id, thread_id, actor_id, initiated_by_actor_id, body, suggestion_json, prompt_text,
        agent_execution_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(commentId, threadId, actor.id, asker?.id ?? null, commentBody(body), suggested ? JSON.stringify(suggested) : null,
        prompt ? String(prompt) : null, executionId, now());
    return commentId;
  }

  resolve(threadId, resolved, actorInput) {
    const actor = this.actor(actorInput);
    const changed = resolved
      ? this.db.prepare('UPDATE review_threads SET resolved_at = ?, resolved_by_actor_id = ? WHERE id = ?').run(now(), actor.id, threadId)
      : this.db.prepare('UPDATE review_threads SET resolved_at = NULL, resolved_by_actor_id = NULL WHERE id = ?').run(threadId);
    if (!changed.changes) throw new HttpError(404, 'That conversation is gone.');
  }

  markApplied(threadId, actorInput, at = now()) {
    const actor = this.actor(actorInput);
    this.db.prepare('UPDATE review_threads SET applied_at = ?, applied_by_actor_id = ? WHERE id = ? AND applied_at IS NULL')
      .run(at, actor.id, threadId);
  }

  // MARK: Reviews asked for by name

  /** A review asked for: its title, note, files and reviewers, numbered within its folder. */
  createRequest(projectId, { title, note, paths, reviewers }, actorInput) {
    const actor = this.actor(actorInput);
    const requestId = id();
    transaction(this.db, () => {
      const number = (this.db.prepare('SELECT MAX(number) AS last FROM review_requests WHERE project_id = ?').get(projectId)?.last ?? 0) + 1;
      this.db.prepare(`INSERT INTO review_requests(id, project_id, number, title, note, requested_by_actor_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(requestId, projectId, number, title || `Review ${number}`, note || null, actor.id, now());
      paths.forEach((path, position) => this.db.prepare('INSERT OR IGNORE INTO review_request_files(request_id, path, position) VALUES (?, ?, ?)')
        .run(requestId, path, position));
      reviewers.forEach((reviewer, position) => this.db.prepare(`INSERT OR IGNORE INTO review_request_reviewers(request_id, email, name, position)
        VALUES (?, ?, ?, ?)`).run(requestId, reviewer.email, reviewer.name, position));
    });
    return requestId;
  }

  /** A review asked for by name, with its files and reviewers in the order they were given. */
  request(requestId) {
    const row = this.db.prepare(`SELECT r.*, a.id AS by_id, a.display_name AS by_name, a.actor_type AS by_type,
        p.id AS approver_id, p.display_name AS approver_name, p.actor_type AS approver_type
      FROM review_requests r JOIN actors a ON a.id = r.requested_by_actor_id LEFT JOIN actors p ON p.id = r.approved_by_actor_id
      WHERE r.id = ?`).get(requestId);
    if (!row) throw new HttpError(404, 'That review is gone.');
    return {
      id: row.id, projectId: row.project_id, number: row.number, title: row.title, note: row.note, at: row.created_at,
      requestedBy: actorOf(row, 'by'),
      approved: row.approved_at ? { at: row.approved_at, by: actorOf(row, 'approver') } : null,
      paths: this.db.prepare('SELECT path FROM review_request_files WHERE request_id = ? ORDER BY position').all(requestId).map((file) => file.path),
      reviewers: this.db.prepare('SELECT name, email FROM review_request_reviewers WHERE request_id = ? ORDER BY position').all(requestId)
        .map((reviewer) => ({ name: reviewer.name, email: reviewer.email })),
    };
  }

  /** The reviews asked for in switched-on folders, newest first. */
  requests() {
    return this.db.prepare(`SELECT r.id FROM review_requests r JOIN projects p ON p.id = r.project_id
      WHERE p.workspace_active = 1 ORDER BY r.created_at DESC`).all().map((row) => this.request(row.id));
  }

  setRequestApproved(requestId, actorInput) {
    const actor = actorInput ? this.actor(actorInput) : null;
    this.db.prepare('UPDATE review_requests SET approved_at = ?, approved_by_actor_id = ? WHERE id = ?')
      .run(actor ? now() : null, actor?.id ?? null, requestId);
  }

  // MARK: Looked at

  /** The bytes each file had when this person marked it looked at, by path. */
  viewed(projectId, actorId) {
    return new Map(this.db.prepare('SELECT path, content_hash FROM review_views WHERE project_id = ? AND actor_id = ?')
      .all(projectId, actorId).map((row) => [row.path, row.content_hash]));
  }

  setViewed(projectId, path, contentHash, viewed, actorInput) {
    const actor = this.actor(actorInput);
    if (viewed) {
      this.db.prepare(`INSERT INTO review_views(project_id, path, actor_id, content_hash, viewed_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id, path, actor_id) DO UPDATE SET content_hash = excluded.content_hash, viewed_at = excluded.viewed_at`)
        .run(projectId, path, actor.id, contentHash ?? '', now());
    } else {
      this.db.prepare('DELETE FROM review_views WHERE project_id = ? AND path = ? AND actor_id = ?').run(projectId, path, actor.id);
    }
  }
}
