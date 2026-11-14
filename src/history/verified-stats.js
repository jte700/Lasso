// The stat values each file's bytes were last confirmed under, kept across
// restarts (migration 032).
//
// A snapshot's file records are immutable, and a file read again and found to
// hold its recorded bytes writes no new record. Its record therefore keeps the
// stat values it was first seen with: a file that was only touched, or one
// recorded before change times were kept, would be read whole at every
// launch. A scan that confirms such a file's bytes notes the stat values it
// read them under here, and the next launch trusts those like recorded ones.

import { transaction } from '../db.js';
import { sameRecordedStat } from './scanner.js';

export class VerifiedFileStats {
  constructor(db) {
    this.db = db;
    // Each project's entries, path to { contentHash, fingerprint }, once read.
    this.byProject = new Map();
  }

  entries(projectId) {
    let entries = this.byProject.get(projectId);
    if (!entries) {
      entries = new Map(this.db.prepare('SELECT path, content_hash, fingerprint FROM verified_file_stats WHERE project_id = ?')
        .all(projectId).map((row) => [row.path, { contentHash: row.content_hash, fingerprint: row.fingerprint }]));
      this.byProject.set(projectId, entries);
    }
    return entries;
  }

  /** The fingerprint a recorded file's bytes were last confirmed under, or null. */
  fingerprintFor(projectId, file) {
    const entry = this.entries(projectId).get(file.path);
    return entry?.contentHash === file.contentHash ? entry.fingerprint : null;
  }

  /**
   * Takes a finished scan's cache, path to `{ fingerprint, file }`. Notes each
   * file that holds its recorded bytes under stat values its record does not
   * carry, and drops what is noted for files that are gone or hold other
   * bytes now: those get a record of their own, with their own stat values.
   */
  record(projectId, recordedFiles, scanned) {
    const entries = this.entries(projectId);
    const noted = [];
    for (const recorded of recordedFiles) {
      const found = scanned.get(recorded.path);
      if (!found || found.file.contentHash !== recorded.contentHash || sameRecordedStat(recorded, found.file)) continue;
      const known = entries.get(recorded.path);
      if (known?.contentHash === recorded.contentHash && known.fingerprint === found.fingerprint) continue;
      noted.push({ path: recorded.path, contentHash: recorded.contentHash, fingerprint: found.fingerprint });
    }
    const dropped = [...entries].filter(([filePath, entry]) => scanned.get(filePath)?.file.contentHash !== entry.contentHash)
      .map(([filePath]) => filePath);
    if (!noted.length && !dropped.length) return;
    const write = () => {
      const upsert = this.db.prepare(`INSERT INTO verified_file_stats(project_id, path, content_hash, fingerprint) VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id, path) DO UPDATE SET content_hash = excluded.content_hash, fingerprint = excluded.fingerprint`);
      const remove = this.db.prepare('DELETE FROM verified_file_stats WHERE project_id = ? AND path = ?');
      for (const filePath of dropped) remove.run(projectId, filePath);
      for (const entry of noted) upsert.run(projectId, entry.path, entry.contentHash, entry.fingerprint);
    };
    if (this.db.isTransaction) write();
    else transaction(this.db, write);
    // Memory follows the store only once the write holds.
    const next = new Map(entries);
    for (const filePath of dropped) next.delete(filePath);
    for (const entry of noted) next.set(entry.path, { contentHash: entry.contentHash, fingerprint: entry.fingerprint });
    this.byProject.set(projectId, next);
  }

  /** Stops trusting what was noted for files holding `contentHash`, so the next scan reads them. */
  forgetBytes(projectId, contentHash) {
    const entries = this.entries(projectId);
    const kept = new Map([...entries].filter(([, entry]) => entry.contentHash !== contentHash));
    if (kept.size === entries.size) return;
    this.db.prepare('DELETE FROM verified_file_stats WHERE project_id = ? AND content_hash = ?').run(projectId, contentHash);
    this.byProject.set(projectId, kept);
  }

  clear() {
    this.byProject.clear();
  }
}
