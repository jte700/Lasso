// The AuthorshipService's side of records carried in Word documents: a
// record read from a document (from Lasso's own copy of a version, or from a
// file no folder holds), a record that arrived with a document laid into
// that document's spans, who edited inside what an AI wrote, and the record
// this Lasso writes into a document. Installed on AuthorshipService.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { agentActor, editorsOf } from './marks.js';
import { RECORD_FORMAT, locateSpans, readCarried } from './carried-record.js';
import { LONGEST_DOCUMENT, readableText } from './readable-text.js';
import { isWordDocument } from './record-stamps.js';
import { CONTEXT, keptByMark, shapeSpans } from './span-shapes.js';

const CACHED_RECORDS = 16;
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function parsedList(json) {
  try { return JSON.parse(json ?? '[]'); } catch { return []; }
}

export const recordMethods = {
  remember(key, value) {
    this.carriedCache.set(key, value);
    if (this.carriedCache.size > CACHED_RECORDS) this.carriedCache.delete(this.carriedCache.keys().next().value);
    return value;
  },

  /** The record a version of a Word document carries, read from Lasso's copy of it, or null. */
  carriedIn(hash, filePath) {
    if (!hash || !isWordDocument(filePath)) return null;
    const key = `hash:${hash}`;
    if (this.carriedCache.has(key)) return this.carriedCache.get(key);
    let found = null;
    try { found = readCarried(this.timeline.blobs.get(hash)); } catch { /* a version no longer kept */ }
    return this.remember(key, found);
  },

  /** A Word document outside every folder, answered from the record it carries; null when it carries none. */
  carriedForPath(absolute) {
    if (!isWordDocument(absolute)) return null;
    let stat;
    try { stat = fs.statSync(absolute); } catch { return null; }
    if (!stat.isFile() || stat.size > LONGEST_DOCUMENT) return null;
    const key = `path:${absolute}:${stat.size}:${stat.mtimeMs}`;
    let read = this.carriedCache.get(key);
    if (read === undefined) {
      let buffer;
      try { buffer = fs.readFileSync(absolute); } catch { return null; }
      const carried = readCarried(buffer);
      read = this.remember(key, carried ? { carried, text: readableText(buffer, absolute) } : null);
    }
    if (!read) return null;
    return this.carriedView(read.carried, read.text, { projectId: null, path: absolute, kind: 'document', spans: [], marks: [], total: 0 });
  },

  /**
   * What a carried record says of the document as it is now: its spans found
   * in the text, and its marks as the Mac app reads Lasso's own, with who
   * recorded them. A record whose signature fails shows nothing.
   */
  carriedView(carried, text, base) {
    const own = this.identity.ownKey()?.fingerprint ?? null;
    const valid = Boolean(carried.valid && text != null);
    const summary = {
      by: carried.signer.name, key: carried.signer.key, you: carried.signer.key === own, valid,
      writtenAt: typeof carried.payload.writtenAt === 'string' ? carried.payload.writtenAt : null,
      // Whether the document's words are still the ones the record was written over.
      unchanged: valid && carried.payload.text?.sha256 === sha256(text),
    };
    if (!valid) return { ...base, carried: summary };
    const located = locateSpans(text, carried.payload.spans);
    const kept = keptByMark(located, text);
    const marks = (carried.payload.marks ?? []).filter((mark) => kept.has(mark.id)).map((mark) => {
      const entry = kept.get(mark.id);
      const recordedBy = mark.recordedBy?.key ? mark.recordedBy : carried.signer;
      const you = recordedBy.key === own;
      let agent;
      try { agent = agentActor(mark.agent || 'AI'); } catch { agent = { id: 'agent:ai', displayName: 'AI' }; }
      return {
        id: mark.id, kind: mark.kind, agent: { id: agent.id, name: agent.displayName },
        model: mark.model ?? null, tool: mark.tool ?? null, prompt: mark.prompt ?? null, hostApp: mark.hostApp ?? null,
        command: mark.command ?? null, initiatedBy: null,
        at: mark.at ?? null, recordedAt: summary.writtenAt,
        written: Number.isInteger(mark.written) ? mark.written : entry.kept, kept: entry.kept, editedInside: entry.editedInside,
        askedBy: { name: recordedBy.name, you },
        recordedBy: { name: recordedBy.name, key: recordedBy.key, you },
        editors: editorsOf(mark.editors).map((editor) => ({ name: editor.name, you: Boolean(own && editor.key === own), at: editor.at ?? null })),
      };
    });
    return { ...base, spans: shapeSpans(text, located), marks, total: located.length, carried: summary };
  },

  /** A valid record this version of a document brought that is not yet read into its spans, or null. */
  arrivedRecord(projectFileId, hash, filePath) {
    const carried = this.carriedIn(hash, filePath);
    if (!carried?.valid) return null;
    const applied = this.db.prepare('SELECT 1 FROM ai_carried_records WHERE project_file_id = ? AND payload_hash = ?')
      .get(projectFileId, carried.payloadHash);
    return applied ? null : carried;
  },

  /**
   * Lays a record that arrived with a document over its characters: the
   * record's spans, found in the text, become its marks' where this Lasso
   * knows of no AI's writing. Its marks are kept, with who recorded them.
   */
  layRecord(carried, projectFileId, text, owners, indexOf) {
    const marks = new Map((carried.payload.marks ?? []).map((mark) => [mark.id, mark]));
    const adopted = new Map();
    for (const mark of marks.values()) adopted.set(mark.id, this.marks.adopt(mark, carried.signer));
    for (const span of locateSpans(text, carried.payload.spans)) {
      const markId = adopted.get(span.m);
      if (!markId) continue;
      const owner = indexOf(markId);
      for (let index = span.s; index < span.e; index += 1) if (owners[index] < 0) owners[index] = owner;
    }
    this.db.prepare('INSERT OR IGNORE INTO ai_carried_records(project_file_id, payload_hash, applied_at) VALUES (?, ?, ?)')
      .run(projectFileId, carried.payloadHash, new Date().toISOString());
  },

  /** Each mark this save left fewer letters of is noted as edited by whoever made the save. */
  noteEditors(prior, ids, counts, event) {
    const before = new Map();
    for (const span of prior) before.set(span.m, (before.get(span.m) ?? 0) + span.e - span.s);
    let editor = null;
    for (const [markId, had] of before) {
      const left = counts.get(ids.indexOf(markId)) ?? 0;
      if (left >= had) continue;
      editor ??= event?.actor?.actorType === 'AI_AGENT'
        ? { name: event.actor.displayName }
        : { name: this.identity.settings().name, key: this.identity.signingKey().fingerprint };
      this.marks.addEditors(markId, [{ ...editor, at: event?.occurredAt ?? new Date().toISOString() }]);
    }
  },

  /**
   * The record this Lasso writes into a version of a document: its AI-written
   * spans and the marks they name. Prompts and commands of this Lasso's own
   * marks go in only when included; another Mac's marks keep what they came
   * with. Null when the document has nothing to record and carries no record.
   */
  recordFor(file, filePath, current = null) {
    const stored = this.storedSpans(file.projectFileId, file.contentHash) ?? [];
    if (!stored.length && !current) return null;
    const text = this.readable(file.contentHash, filePath);
    if (text == null) return null;
    const settings = this.identity.settings();
    const signer = this.identity.signer();
    const read = this.db.prepare(`SELECT m.*, a.display_name AS agent_name FROM ai_marks m
      JOIN actors a ON a.id = m.agent_actor_id WHERE m.id = ?`);
    const rows = new Map();
    for (const span of stored) if (!rows.has(span.m)) rows.set(span.m, read.get(span.m));
    const marks = [...rows.values()].filter(Boolean).map((row) => {
      const own = !row.recorded_by_key;
      const mark = {
        id: row.id, kind: row.kind, agent: row.agent_name, model: row.model ?? null, tool: row.tool ?? null,
        hostApp: row.host_app ?? null, at: row.ended_at ?? row.started_at, written: row.written_chars ?? null,
        recordedBy: own ? signer : { name: row.recorded_by_name, key: row.recorded_by_key },
        editors: editorsOf(parsedList(row.editors_json)),
      };
      if (!own || settings.includePrompts) {
        if (row.prompt) mark.prompt = row.prompt;
        if (row.command) mark.command = row.command.slice(0, 200);
      }
      return mark;
    });
    const spans = stored.filter((span) => rows.get(span.m)).map((span) => ({
      mark: span.m, start: span.s, end: span.e, text: text.slice(span.s, span.e),
      prefix: text.slice(Math.max(0, span.s - CONTEXT), span.s), suffix: text.slice(span.e, span.e + CONTEXT),
    }));
    return {
      format: RECORD_FORMAT, version: 1, signer, writtenAt: new Date().toISOString(),
      text: { sha256: sha256(text), length: text.length }, marks, spans,
    };
  },
};
