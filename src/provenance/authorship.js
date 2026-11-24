// Which characters of a file an AI wrote, kept as each save is recorded. A
// save is compared with the version before it: characters it kept keep the
// mark they had, and characters it wrote are credited to whichever AI's
// record explains them (Claude Code's edit of that file, a command it ran
// while the file was written, an AI's own save) or, where a person saved,
// to the words the writer typed or a paste brought in, found word for word
// among what the save added. Everything else is a person's.

import fs from 'node:fs';
import path from 'node:path';
import { AiMarks, PERSON, editorsOf } from './marks.js';
import { FRESH, carryForward, claimText, ownersOf, settle, spansOf } from './text-runs.js';
import { readableKind, readableText } from './readable-text.js';
import { RecordIdentity } from './record-identity.js';
import { AI_RECORD_SOURCE, RecordStamps, isWordDocument } from './record-stamps.js';
import { keptByMark, shapeSpans } from './span-shapes.js';
import { recordMethods } from './record-views.js';

/** How often the hook spool is read while nothing else asks for it. */
const SPOOL_POLL_MS = 3000;
const CACHED_TEXTS = 8;

export class AuthorshipService {
  constructor({ db, timeline, config }) {
    this.db = db;
    this.timeline = timeline;
    this.marks = new AiMarks({ db, timeline, config });
    this.identity = new RecordIdentity({ dataDir: config.dataDir });
    this.stamps = new RecordStamps({ db, timeline, authorship: this, settleMs: config.aiRecordSettleMs ?? 3000 });
    this.texts = new Map();
    /** Records read from documents, by content hash, and from files outside the folders, by path. */
    this.carriedCache = new Map();
    /** Edits whose finish was read while a save was being recorded, attributed after that save. */
    this.lateEdits = [];
    this.queue = Promise.resolve();
    this.closed = false;
    this.unsubscribe = timeline.onCapture((result) => this.enqueue(() => this.afterCapture(result)));
    this.timer = null;
    if (config.watchProjects) {
      this.timer = setInterval(() => this.enqueue(() => {
        this.ingest();
        return this.stamps.tick();
      }), SPOOL_POLL_MS);
      this.timer.unref?.();
    }
  }

  /** Writes the AI records waiting for their documents to close. */
  stampPending() {
    return this.enqueue(() => {
      this.stamps.soon();
      return this.stamps.tick();
    });
  }

  close() {
    this.closed = true;
    this.unsubscribe?.();
    clearInterval(this.timer);
  }

  /** Work runs one piece at a time, after the capture that asked for it has returned. */
  enqueue(work) {
    this.queue = this.queue.then(() => {
      if (this.closed) return null;
      return work();
    }).catch((error) => console.warn(`AI authorship was not recorded: ${error.message}`));
    return this.queue;
  }

  /** Waits for every save heard so far to be attributed. */
  settled() {
    return this.enqueue(() => null);
  }

  /** Reads the hook spool; edits finished after their save was recorded are attributed now. */
  ingest() {
    for (const edit of [...this.lateEdits.splice(0), ...this.marks.ingest()]) this.attributeLate(edit);
  }

  record(input) {
    return this.marks.record(input);
  }

  // ── a save ───────────────────────────────────────────────────────────

  afterCapture(result) {
    if (!result?.changed || !result.event) return;
    const late = [...this.lateEdits.splice(0), ...this.marks.ingest()];
    const event = result.event;
    const project = this.timeline.getProject(result.projectId);
    const changes = this.db.prepare(`SELECT * FROM file_changes WHERE event_id = ?`).all(event.id);
    for (const change of changes) {
      if (!change.path_after || !change.content_hash_after) continue;
      const after = this.timeline.snapshotFile(result.snapshot.id, change.path_after);
      this.attribute({
        project, snapshotId: result.snapshot.id, event,
        projectFileId: change.project_file_id, path: change.path_after,
        beforeHash: change.content_hash_before, afterHash: change.content_hash_after,
        modifiedMs: after?.mtimeMs ?? null,
      });
      // A document with AI-written parts (or a record already in it) carries its record; Lasso's own write of one asks for none.
      if (event.source !== AI_RECORD_SOURCE && event.source !== 'IMPORT' && isWordDocument(change.path_after)
        && (this.storedSpans(change.project_file_id, change.content_hash_after)?.length
          || this.storedSpans(change.project_file_id, change.content_hash_before)?.length
          || this.db.prepare('SELECT 1 FROM ai_carried_records WHERE project_file_id = ? LIMIT 1').get(change.project_file_id))) {
        this.stamps.consider(project.id, change.project_file_id, change.path_after);
      }
    }
    // Edits this save did not hold finished after an earlier one did.
    for (const edit of late) this.attributeLate(edit);
  }

  /**
   * The AI a save is recorded as, when its own records explain every change
   * in it whole: Claude Code's edits of a file from the version Lasso holds
   * to the one saved, or a command it was running when each file was
   * written. Asked while the save is recorded, before its event is written.
   */
  creditFor(projectId, changes) {
    try {
      // Hook events waiting in the spool are read now; edits they finish are attributed after this save.
      this.lateEdits.push(...this.marks.ingest());
    } catch (error) {
      console.warn(`AI hook events were not read: ${error.message}`);
      return null;
    }
    if (!changes?.length) return null;
    const project = this.timeline.getProject(projectId);
    let agent = null;
    for (const change of changes) {
      // A removal says nothing of who removed it.
      if (!change.after) return null;
      const edits = this.marks.edits(projectId, change.after.path);
      let by = null;
      if (edits.length) {
        const oneAgent = new Set(edits.map((edit) => edit.agent_actor_id)).size === 1;
        const fromStart = (edits[0].before_hash ?? null) === (change.before?.contentHash ?? null);
        const toEnd = edits.at(-1).after_hash === change.after.contentHash;
        if (oneAgent && fromStart && toEnd) by = edits[0].agent_actor_id;
      } else {
        by = this.marks.commandFor(absoluteOf(project, change.after.path), change.after.mtimeMs)?.agent_actor_id ?? null;
      }
      if (!by || (agent && agent !== by)) return null;
      agent = by;
    }
    if (!agent) return null;
    const row = this.db.prepare('SELECT id, display_name, actor_type FROM actors WHERE id = ?').get(agent);
    return row ? { id: row.id, displayName: row.display_name, actorType: row.actor_type } : null;
  }

  /** An edit whose finish arrived after the save that holds it: that save's change is attributed again. */
  attributeLate(edit) {
    if (!edit?.project_id || !edit.after_hash || this.marks.mark(edit.id)?.matched_at) return;
    let project;
    try { project = this.timeline.getProject(edit.project_id); } catch { return; }
    const current = this.timeline.snapshotFile(project.currentSnapshotId, edit.path);
    if (!current || current.contentHash !== edit.after_hash) return;
    const change = this.db.prepare(`SELECT fc.*, e.id AS event_id, e.resulting_snapshot_id FROM file_changes fc
      JOIN timeline_events e ON e.id = fc.event_id
      WHERE fc.project_file_id = ? AND fc.content_hash_after = ? ORDER BY e.occurred_at DESC LIMIT 1`)
      .get(current.projectFileId, edit.after_hash);
    if (!change) return;
    // The save's event was written before this was known and stays as written; its characters are Claude's.
    this.attribute({
      project, snapshotId: change.resulting_snapshot_id, event: this.timeline.getEvent(change.event_id),
      projectFileId: change.project_file_id, path: change.path_after,
      beforeHash: change.content_hash_before, afterHash: change.content_hash_after, modifiedMs: current.mtimeMs ?? null,
    });
  }

  readable(hash, filePath) {
    if (!hash) return '';
    const key = `${hash}:${readableKind(filePath)}`;
    if (this.texts.has(key)) return this.texts.get(key);
    let buffer = null;
    try { buffer = this.timeline.blobs.get(hash); } catch { return null; }
    const text = readableText(buffer, filePath);
    this.texts.set(key, text);
    if (this.texts.size > CACHED_TEXTS) this.texts.delete(this.texts.keys().next().value);
    return text;
  }

  storedSpans(projectFileId, contentHash) {
    if (!projectFileId || !contentHash) return null;
    const row = this.db.prepare('SELECT spans_json FROM ai_spans WHERE project_file_id = ? AND content_hash = ?')
      .get(projectFileId, contentHash);
    if (!row) return null;
    try { return JSON.parse(row.spans_json); } catch { return null; }
  }

  /**
   * One file's change in a save: the spans of its new version, kept for it.
   * Returns { spans }, or null when nothing in it could be an AI's.
   */
  attribute({ project, snapshotId, event, projectFileId, path: filePath, beforeHash, afterHash, modifiedMs }) {
    const kind = readableKind(filePath);
    if (!kind) return null;
    const absolute = absoluteOf(project, filePath);
    const prior = this.storedSpans(projectFileId, beforeHash);
    const edits = kind === 'text' ? this.marks.edits(project.id, filePath) : [];
    const command = edits.length ? null : this.marks.commandFor(absolute, modifiedMs);
    const agentSave = event?.actor?.actorType === 'AI_AGENT';
    const typed = this.marks.typed(absolute);
    // A record the document brought from another Mac (a folder's first reading leaves it to the overlay).
    const arrived = event?.source === 'IMPORT' ? null : this.arrivedRecord(projectFileId, afterHash, filePath);
    if (!prior?.length && !edits.length && !command && !agentSave && !typed.length && !arrived) return null;
    const before = this.readable(beforeHash, filePath);
    const after = this.readable(afterHash, filePath);
    if (before == null || after == null) return null;

    const ids = [];
    const indexOf = (markId) => {
      const found = ids.indexOf(markId);
      if (found !== -1) return found;
      ids.push(markId);
      return ids.length - 1;
    };
    let owners = prior?.length ? ownersOf(prior, before.length, indexOf) : null;
    const used = [];
    if (edits.length) {
      let current = before;
      for (const edit of edits) {
        const start = edit.before_text ?? current;
        const finish = edit.after_text ?? start;
        owners = carryForward(current, start, owners, FRESH);
        owners = carryForward(start, finish, owners, indexOf(edit.id));
        current = finish;
        used.push(edit);
      }
      owners = carryForward(current, after, owners, FRESH);
    } else if (command) {
      owners = carryForward(before, after, owners, indexOf(command.id));
      used.push(command);
    } else if (agentSave) {
      const mark = this.marks.forAgentEvent(event);
      owners = carryForward(before, after, owners, indexOf(mark.id));
      used.push(mark);
    } else {
      owners = carryForward(before, after, owners, FRESH);
    }
    if (arrived) this.layRecord(arrived, projectFileId, after, owners, indexOf);
    for (const mark of typed) {
      if (claimText(after, owners, mark.text ?? '', indexOf(mark.id))) used.push(mark);
    }
    settle(owners);

    const counts = new Map();
    for (const owner of owners) if (owner >= 0) counts.set(owner, (counts.get(owner) ?? 0) + 1);
    for (const mark of used) this.marks.matched(mark.id, snapshotId, counts.get(ids.indexOf(mark.id)) ?? 0);
    // Whoever made this save edited inside what an AI wrote, unless the words came in with a record.
    if (prior?.length && !arrived && event?.source !== AI_RECORD_SOURCE) this.noteEditors(prior, ids, counts, event);
    const spans = spansOf(owners, after, (index) => ids[index]);
    if (spans.length) {
      this.db.prepare(`INSERT INTO ai_spans(project_file_id, content_hash, spans_json) VALUES (?, ?, ?)
        ON CONFLICT(project_file_id, content_hash) DO UPDATE SET spans_json = excluded.spans_json`)
        .run(projectFileId, afterHash, JSON.stringify(spans));
    } else {
      this.db.prepare('DELETE FROM ai_spans WHERE project_file_id = ? AND content_hash = ?').run(projectFileId, afterHash);
    }
    return { spans };
  }

  // ── what is asked ────────────────────────────────────────────────────

  /**
   * The AI-written parts of a file named by its absolute path. A file no
   * folder holds answers from the record it carries, if any; else null.
   */
  forPath(absolute) {
    const located = this.marks.locate(absolute);
    if (!located) return this.carriedForPath(absolute);
    return this.forFile(located.project.id, located.path);
  }

  absoluteOf(project, filePath) {
    return absoluteOf(project, filePath);
  }

  /**
   * The AI-written parts of a file's current version: { projectId, path,
   * kind, spans: [{ markId, start, end, lineStart, lineEnd, text, prefix,
   * suffix, pieces }], marks: [...] }. Each piece is one line of a span with
   * the words either side, for finding it in an app that shows the file.
   */
  forFile(projectId, filePath) {
    const project = this.timeline.getProject(projectId);
    const file = project.currentSnapshotId ? this.timeline.snapshotFile(project.currentSnapshotId, filePath) : null;
    const empty = { projectId, path: filePath, kind: readableKind(filePath), spans: [], marks: [], total: 0 };
    if (!file) return empty;
    const stored = this.storedSpans(file.projectFileId, file.contentHash);
    if (!stored?.length) {
      // A document whose record Lasso has not read into its history yet (a folder's first reading) answers from the record.
      const carried = isWordDocument(filePath) ? this.carriedIn(file.contentHash, filePath) : null;
      return carried ? this.carriedView(carried, this.readable(file.contentHash, filePath), empty) : empty;
    }
    const text = this.readable(file.contentHash, filePath);
    if (text == null) return empty;
    return { ...empty, spans: shapeSpans(text, stored), marks: this.describe(stored, text), total: stored.length };
  }

  /** Each mark the spans name: who, what, when, who recorded it, who has edited it, and how much is still as written. */
  describe(spans, text) {
    const read = this.db.prepare(`SELECT m.*, a.display_name AS agent_name, i.display_name AS initiator_name, i.actor_type AS initiator_type
      FROM ai_marks m JOIN actors a ON a.id = m.agent_actor_id LEFT JOIN actors i ON i.id = m.initiated_by_actor_id WHERE m.id = ?`);
    const own = this.identity.ownKey()?.fingerprint ?? null;
    const name = this.identity.settings().name;
    return [...keptByMark(spans, text)].map(([markId, entry]) => {
      const mark = read.get(markId);
      if (!mark) return null;
      const recordedBy = mark.recorded_by_key
        ? { name: mark.recorded_by_name, key: mark.recorded_by_key, you: mark.recorded_by_key === own }
        : { name, key: own, you: true };
      const askedBy = mark.recorded_by_key ? { name: recordedBy.name, you: recordedBy.you }
        : mark.initiator_type === 'HUMAN_SELF' ? { name, you: true }
          : mark.initiator_name ? { name: mark.initiator_name, you: false } : null;
      return {
        id: markId,
        kind: mark.kind,
        agent: { id: mark.agent_actor_id, name: mark.agent_name },
        model: mark.model,
        tool: mark.tool,
        prompt: mark.prompt,
        hostApp: mark.host_app,
        command: mark.command ? mark.command.slice(0, 200) : null,
        initiatedBy: mark.initiated_by_actor_id
          ? { id: mark.initiated_by_actor_id, name: mark.initiator_name, type: mark.initiator_type } : null,
        at: mark.ended_at ?? mark.started_at,
        recordedAt: mark.matched_at,
        written: mark.written_chars ?? entry.kept,
        kept: entry.kept,
        // Letters inside what it wrote that someone else has written since.
        editedInside: entry.editedInside,
        askedBy,
        recordedBy,
        editors: editorsOf(parsedList(mark.editors_json)).map((editor) => ({ name: editor.name, you: Boolean(own && editor.key === own), at: editor.at ?? null })),
      };
    }).filter(Boolean);
  }

  /** The person who asks, as recorded on marks the Mac app reports. */
  static get person() { return PERSON; }
}

function parsedList(json) {
  try { return JSON.parse(json ?? '[]'); } catch { return []; }
}

function absoluteOf(project, filePath) {
  let root = path.resolve(project.rootPath);
  try { root = fs.realpathSync(root); } catch { /* a drive away */ }
  return path.join(root, ...filePath.split('/'));
}

// Records carried in Word documents: read, laid into a file's spans, written.
Object.assign(AuthorshipService.prototype, recordMethods);
