// Lasso writes its AI record into a Word document in a followed folder once a
// save leaves AI-written parts in it (or changes what the record it carries
// says), so the record goes wherever the document is sent. It waits until the
// document is closed (Word holds a document open while it shows it, and
// would save over the record from memory; where it may, it also keeps an
// owner file, "~$name.docx", beside it) and has
// sat a moment since its last save, and only writes over the version Lasso
// last read. The write keeps the file's modified date, and is recorded as
// Lasso's, never as anyone's edit.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hashBuffer } from '../history/blob-store.js';
import { asciiJson, readCarried, recordContent, recordXml, withRecord } from './carried-record.js';

/** The source of the event that records Lasso writing its record into a file. */
export const AI_RECORD_SOURCE = 'AI_RECORD';
const LASSO = Object.freeze({ id: 'system:lasso', displayName: 'Lasso', actorType: 'SYSTEM' });
/** A document still open is looked at again after this long, doubling up to the longest. */
const FIRST_WAIT_MS = 3000;
const LONGEST_WAIT_MS = 30_000;
/** A document too large to be rewritten in a moment is left as it is. */
const LARGEST_STAMPED = 64 * 1024 * 1024;

/** Whether a file is a Word document Lasso can carry a record in. */
export function isWordDocument(filePath) {
  return /\.docx$/i.test(String(filePath ?? '')) && !path.basename(filePath).startsWith('~$');
}

/** Whether an app has the document open: Word's owner file or LibreOffice's lock beside it. */
export function openElsewhere(absolute) {
  const folder = path.dirname(absolute);
  const name = path.basename(absolute);
  let entries;
  try { entries = fs.readdirSync(folder); } catch { return false; }
  return entries.some((entry) => {
    if (entry === `.~lock.${name}#`) return true;
    if (!entry.startsWith('~$')) return false;
    // Word drops the first two letters of a longer name to make room for "~$".
    const rest = entry.slice(2);
    return rest.length >= name.length - 2 && name.endsWith(rest);
  });
}

const LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((candidate) => fs.existsSync(candidate)) ?? null;

/** Whether another program holds the file open, as lsof says; false where lsof cannot say. */
export function heldOpen(absolute) {
  if (!LSOF) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(LSOF, ['-t', '--', absolute], { timeout: 3000 }, (error, stdout) => {
      // lsof exits 1 when nothing holds the file; a check that ran out of time waits for the next.
      if (error && error.code !== 1) { resolve(Boolean(error.killed)); return; }
      resolve(String(stdout ?? '').split(/\s+/).filter(Boolean).some((pid) => Number(pid) !== process.pid));
    });
  });
}

export class RecordStamps {
  constructor({ db, timeline, authorship, settleMs }) {
    this.db = db;
    this.timeline = timeline;
    this.authorship = authorship;
    this.settleMs = settleMs;
    /** Documents waiting for their record, by project file. */
    this.pending = new Map();
  }

  /** A save of `filePath` was attributed: its record may need writing. */
  consider(projectId, projectFileId, filePath) {
    if (isWordDocument(filePath)) this.pending.set(projectFileId, { projectId, projectFileId, path: filePath });
  }

  /** Writes the records that can be written now; documents still open wait for the next tick. */
  async tick(now = Date.now()) {
    for (const [key, entry] of [...this.pending]) {
      if (entry.notBefore && now < entry.notBefore) continue;
      let outcome;
      try {
        outcome = await this.held(entry) ? 'wait' : this.stamp(entry);
      } catch (error) {
        console.warn(`Lasso did not write its AI record into ${entry.path}: ${error.message}`);
        outcome = 'skip';
      }
      if (outcome !== 'wait') {
        this.pending.delete(key);
      } else {
        entry.waits = (entry.waits ?? 0) + 1;
        entry.notBefore = Date.now() + Math.min(LONGEST_WAIT_MS, FIRST_WAIT_MS * 2 ** (entry.waits - 1));
      }
    }
  }

  /** Every waiting document is looked at on the next tick (tests, and a save that may have closed one). */
  soon() {
    for (const entry of this.pending.values()) entry.notBefore = 0;
  }

  /** Whether an app has the document open now. */
  async held({ projectId, path: filePath }) {
    let project;
    try { project = this.timeline.getProject(projectId); } catch { return false; }
    const absolute = this.authorship.absoluteOf(project, filePath);
    return openElsewhere(absolute) || heldOpen(absolute);
  }

  /** 'done', 'skip' (nothing to write) or 'wait' (try again later). */
  stamp({ projectId, projectFileId, path: filePath }) {
    const identity = this.authorship.identity;
    if (!identity.settings().carry) return 'skip';
    let project;
    try { project = this.timeline.getProject(projectId); } catch { return 'skip'; }
    const file = project.currentSnapshotId ? this.timeline.snapshotFile(project.currentSnapshotId, filePath) : null;
    if (!file || file.projectFileId !== projectFileId) return 'skip';
    const absolute = this.authorship.absoluteOf(project, filePath);
    if (openElsewhere(absolute)) return 'wait';
    // A save Lasso is still reading is recorded first.
    if (this.timeline.capturing?.has(projectId) || this.timeline.pendingPaths?.has(projectId)) return 'wait';
    let stat;
    try { stat = fs.statSync(absolute); } catch { return 'skip'; }
    if (stat.size > LARGEST_STAMPED) return 'skip';
    if (Date.now() - stat.mtimeMs < this.settleMs) return 'wait';
    const buffer = fs.readFileSync(absolute);
    if (hashBuffer(buffer) !== file.contentHash) return 'wait';

    const current = readCarried(buffer);
    const payload = this.authorship.recordFor(file, filePath, current);
    if (!payload) return 'skip';
    if (current?.valid && recordContent(current.payload) === recordContent(payload)) return 'skip';
    const payloadText = asciiJson(payload);
    const next = withRecord(buffer, recordXml(payloadText, identity.sign(payloadText)));
    const written = next ? readCarried(next) : null;
    if (!written?.valid) return 'skip';

    const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.lasso-ai-record-${process.pid}.tmp`);
    fs.writeFileSync(temporary, next, { flag: 'wx', mode: stat.mode & 0o777 });
    try {
      fs.utimesSync(temporary, stat.atime, stat.mtime);
      fs.renameSync(temporary, absolute);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
    const at = new Date().toISOString();
    // The record Lasso wrote is its own; it is never read back in as one that arrived.
    this.db.prepare('INSERT OR IGNORE INTO ai_carried_records(project_file_id, payload_hash, applied_at) VALUES (?, ?, ?)')
      .run(projectFileId, written.payloadHash, at);
    this.db.prepare(`INSERT OR REPLACE INTO ai_record_stamps(project_file_id, after_hash, before_hash, payload_hash, written_at)
      VALUES (?, ?, ?, ?, ?)`).run(projectFileId, hashBuffer(next), file.contentHash, written.payloadHash, at);
    this.timeline.capture(projectId, LASSO, { source: AI_RECORD_SOURCE, expectedSnapshotId: project.currentSnapshotId, dirtyPaths: [filePath] });
    return 'done';
  }
}
