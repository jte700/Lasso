// Reviews in The Ranch: a folder's changes since it was last approved, the
// comments and suggested changes people leave on them, suggestions applied to
// the file, changes an AI makes when a person asks it with a backslash, which
// files were looked at, and the approval itself.
//
// Lasso writes a file only when a person applies a suggestion or asks an AI
// to make a change, and only text, code, CSV and .xlsx files. A person's edit
// is recorded as theirs; an AI's as the AI's, with who asked and what.

import fs from 'node:fs';
import { HttpError } from '../history/errors.js';
import { FolderReview, writable } from './folder-review.js';
import { EDIT_INSTRUCTIONS, cellEdits, editRequest, lineEdits, parseAnswer, suggestedText } from './ai-edit.js';
import { replaceLines, setDelimitedCell, setWorkbookCells } from './file-edits.js';
import { ReviewRecords } from './records.js';
import { cellAddress, cellValue } from './sheet-diff.js';
import { findLine, linesOf } from './text-diff.js';

/** The AI writer as history names it. */
export const CHATGPT = Object.freeze({ id: 'agent:chatgpt', displayName: 'ChatGPT', actorType: 'AI_AGENT' });
export const LONGEST_PROMPT = 4000;

export class ReviewService {
  /** @param {{ timeline: object, writing?: object }} context */
  constructor({ timeline, writing = null }) {
    this.timeline = timeline;
    this.db = timeline.db;
    this.writing = writing;
    this.records = new ReviewRecords({ db: this.db, timeline });
    this.reviews = new FolderReview({ db: this.db, timeline, records: this.records });
  }

  /** The switched-on folders, each with how much is waiting in its review. */
  folders(viewerId) {
    return this.db.prepare(`SELECT id FROM projects WHERE workspace_active = 1 AND current_snapshot_id IS NOT NULL ORDER BY name COLLATE NOCASE`)
      .all().map(({ id }) => {
        const summary = this.reviews.summary(id, viewerId);
        return { directoryId: id, name: summary.name, state: summary.state, files: summary.files.length + summary.moreFiles,
          openThreads: summary.files.reduce((sum, file) => sum + file.openThreads, 0), pendingComments: summary.pendingComments,
          people: summary.people, at: summary.current.at };
      });
  }

  summary(projectId, viewerId) {
    return this.reviews.summary(projectId, viewerId);
  }

  file(projectId, filePath, viewerId) {
    const view = this.reviews.file(projectId, filePath, viewerId);
    if (!view) throw new HttpError(404, 'That file is not in this folder.');
    return view;
  }

  // MARK: Comments

  comment(projectId, { path: filePath, anchor, body, suggestion = null }, actorInput) {
    const project = this.timeline.getProject(projectId);
    if (!this.timeline.snapshotFile(project.currentSnapshotId, filePath)) throw new HttpError(404, 'That file is not in this folder.');
    const actor = this.records.actor(actorInput);
    const threadId = this.records.startThread(projectId, { path: filePath, anchor, snapshotId: project.currentSnapshotId, body, suggestion }, actor);
    return { threadId, file: this.file(projectId, filePath, actor.id) };
  }

  reply(threadId, { body, suggestion = null }, actorInput) {
    const actor = this.records.actor(actorInput);
    const thread = this.records.thread(threadId);
    this.records.addComment(threadId, { body, suggestion }, actor);
    return { file: this.file(thread.projectId, thread.path, actor.id) };
  }

  resolve(threadId, resolved, actorInput) {
    const actor = this.records.actor(actorInput);
    const thread = this.records.thread(threadId);
    this.records.resolve(threadId, resolved !== false, actor);
    return { file: this.file(thread.projectId, thread.path, actor.id) };
  }

  // MARK: Writing the file

  /** Writes `bytes` over the file as Lasso last read it, and records the change. */
  write(projectId, file, bytes, actor) {
    const project = this.timeline.getProject(projectId);
    const destination = this.timeline.assertWorkingFileUnchanged(project, file.path, file.contentHash);
    const temporary = `${destination}.lasso-review-${process.pid}-${Date.now()}.tmp`;
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    fs.renameSync(temporary, destination);
    return this.timeline.capture(projectId, actor, { expectedSnapshotId: project.currentSnapshotId, source: 'DOCUMENT_CHANGE' });
  }

  /** The file with `after` written at a thread's place: a line, a CSV cell, or an .xlsx cell. */
  edited(file, bytes, position, after) {
    if (position.line) return Buffer.from(replaceLines(bytes.toString('utf8'), [{ from: position.line, to: position.line, lines: after.split('\n') }]), 'utf8');
    if (file.fileType === 'table') return Buffer.from(setDelimitedCell(bytes.toString('utf8'), { ...position, value: after }, file.path), 'utf8');
    return setWorkbookCells(bytes, [{ ...position, value: after }]);
  }

  /** Applies a thread's suggested change to the file, as the person's own edit. */
  apply(threadId, actorInput) {
    const actor = this.records.actor(actorInput);
    const thread = this.records.thread(threadId);
    const view = this.file(thread.projectId, thread.path, actor.id);
    const shown = view.threads.find((candidate) => candidate.id === threadId);
    if (!shown?.suggestion) throw new HttpError(400, 'This conversation has no suggested change.');
    if (shown.state === 'applied') return { file: view };
    const project = this.timeline.getProject(thread.projectId);
    const file = this.timeline.snapshotFile(project.currentSnapshotId, thread.path);
    if (!writable(file)) {
      throw new HttpError(409, 'Lasso can’t write this kind of file. Make the change in its own app; once it is saved, the suggestion shows as applied.');
    }
    if (!shown.position) throw new HttpError(409, 'The place this was suggested for has changed since. Look at it again before applying.');
    const bytes = this.timeline.blobs.get(file.contentHash);
    const current = shown.position.line ? linesOf(bytes)[shown.position.line - 1] : cellValue(bytes, file.fileType, file.path, shown.position);
    if (shown.suggestion.before != null && current !== shown.suggestion.before) {
      throw new HttpError(409, `${shown.place ?? 'That place'} has changed since this was suggested. Look at it again before applying.`);
    }
    this.write(thread.projectId, file, this.edited(file, bytes, shown.position, shown.suggestion.after), actor);
    this.records.markApplied(threadId, actor);
    return { file: this.file(thread.projectId, thread.path, actor.id) };
  }

  // MARK: Asking an AI

  /**
   * A backslash prompt: the AI writer makes the change at `anchor` (or the
   * thread's place), recorded as its edit, asked for by this person. For a
   * file Lasso cannot write, its change is left as a suggestion.
   */
  async ask(projectId, { path: filePath, anchor = null, prompt, threadId = null }, actorInput, signal) {
    const actor = this.records.actor(actorInput);
    const asked = String(prompt ?? '').replace(/^\s*\\\s*/, '').trim();
    if (!asked) throw new HttpError(400, 'Write what ChatGPT should do after the backslash.');
    if (asked.length > LONGEST_PROMPT) throw new HttpError(400, 'That prompt is too long.');
    if (!this.writing) throw new HttpError(503, 'No AI writer is set up on this Mac.');
    const project = this.timeline.getProject(projectId);
    const thread = threadId ? this.records.thread(threadId) : null;
    const target = thread?.path ?? filePath;
    const file = this.timeline.snapshotFile(project.currentSnapshotId, target);
    if (!file) throw new HttpError(404, 'That file is not in this folder.');
    const bytes = this.timeline.blobs.get(file.contentHash);
    const place = thread?.anchor ?? anchor ?? { kind: 'file' };
    // A line is asked about where it sits now.
    const here = place.kind === 'line' ? { ...place, line: findLine(linesOf(bytes), place) ?? place.line } : place;
    const canWrite = writable(file);
    const request = editRequest({ file, bytes, anchor: here, prompt: asked, writable: canWrite,
      conversation: (thread?.comments ?? []).map((comment) => ({ author: comment.author?.name ?? 'Someone', body: comment.body })) });
    const answer = parseAnswer(await this.writing.complete({ instructions: EDIT_INSTRUCTIONS, prompt: request.prompt, onlyProjectId: projectId, signal }));

    let suggestion;
    let summary;
    let changed = null;
    if (request.format === 'lines') {
      const result = lineEdits(answer, request.context.lines);
      const [first] = [...result.edits].sort((left, right) => left.from - right.from);
      suggestion = { before: request.context.lines.slice(first.from - 1, first.to).join('\n'), after: first.lines.join('\n') };
      summary = result.summary;
      changed = Buffer.from(replaceLines(bytes.toString('utf8'), result.edits), 'utf8');
    } else if (request.format === 'cells') {
      const result = cellEdits(answer, request.context);
      const [first] = result.edits;
      const before = cellValue(bytes, file.fileType, file.path, { sheet: first.sheet ?? request.context.grid.name, row: first.row, column: first.column });
      suggestion = { before, after: first.value, cell: cellAddress(first.sheet, first.row, first.column, request.context.csv) };
      summary = result.summary;
      changed = file.fileType === 'table'
        ? result.edits.reduce((text, edit) => setDelimitedCell(text, edit, file.path), bytes.toString('utf8'))
        : setWorkbookCells(bytes, result.edits);
      if (typeof changed === 'string') changed = Buffer.from(changed, 'utf8');
    } else {
      const result = suggestedText(answer);
      suggestion = { before: place.value ?? null, after: result.text };
      summary = result.summary;
    }

    let executionId = null;
    if (changed) {
      // Proposed and applied at once: the person asked for it, and history keeps the version before.
      const execution = this.timeline.proposeAgentEdit(projectId, { agent: CHATGPT, initiatedBy: actor, path: target, bytes: changed,
        request: asked, baseSnapshotId: project.currentSnapshotId });
      this.timeline.approveAgentEdit(execution.id);
      executionId = execution.id;
    }
    const id = thread?.id ?? this.records.startThread(projectId, { path: target, anchor: place, snapshotId: project.currentSnapshotId,
      body: asked, prompt: asked }, actor);
    if (thread) this.records.addComment(id, { body: asked, prompt: asked }, actor);
    this.records.addComment(id, { body: summary, suggestion: { before: suggestion.before, after: suggestion.after },
      executionId, initiatedBy: actor }, CHATGPT);
    if (changed) this.records.markApplied(id, CHATGPT);
    return { threadId: id, file: this.file(projectId, target, actor.id) };
  }

  // MARK: Looked at, approved

  viewed(projectId, filePath, viewed, actorInput) {
    const actor = this.records.actor(actorInput);
    const project = this.timeline.getProject(projectId);
    const file = this.timeline.snapshotFile(project.currentSnapshotId, filePath);
    this.records.setViewed(projectId, filePath, file?.contentHash ?? null, viewed !== false, actor);
    return { review: this.summary(projectId, actor.id) };
  }

  approve(projectId, actorInput) {
    const actor = this.records.actor(actorInput);
    const project = this.timeline.getProject(projectId);
    this.records.approve(projectId, project.currentSnapshotId, actor);
    return { review: this.summary(projectId, actor.id) };
  }

  undo(projectId, approvalId, actorInput) {
    const actor = this.records.actor(actorInput);
    this.records.undo(projectId, approvalId);
    return { review: this.summary(projectId, actor.id) };
  }
}
