// Which large tables the table index keeps, and removing the rest after a
// capture, a bounded batch at a time, while the server is otherwise idle.

// A file's most recent versions keep their tables, so undoing an edit or
// comparing with the version before does not read the file again.
export const TABLE_VERSIONS_KEPT = 3;
// How long after a capture old tables start to be removed, so the suggestion
// caches built right after it go first.
export const TABLE_CLEANUP_DELAY_MS = 2_000;

export const tableRetentionMethods = {
  /**
   * Which of these file contents some snapshot still needs: a file of a
   * folder's current snapshot, of a snapshot a share or a linked claim points
   * to, or one of the last few versions of its file. A run of cleanup asks
   * this once per content; a capture starts the answers afresh.
   */
  tableContentToKeep(hashes) {
    this.tableKeepAnswers ??= new Map();
    const unknown = new Set([...hashes].filter((hash) => !this.tableKeepAnswers.has(hash)));
    if (unknown.size) {
      const kept = new Set([...this.pinnedTableContent(unknown), ...this.recentFileVersions(unknown)]);
      for (const hash of unknown) this.tableKeepAnswers.set(hash, kept.has(hash));
    }
    return new Set([...hashes].filter((hash) => this.tableKeepAnswers.get(hash)));
  },

  /**
   * The contents among `hashes` that a pinned snapshot holds. Only the files
   * that ever had one of them are looked up in each snapshot, one file at a
   * time, so no snapshot's whole list of files is read for this.
   */
  pinnedTableContent(hashes) {
    const filesOf = this.db.prepare(`SELECT DISTINCT f.project_file_id, s.project_id FROM snapshot_files f
      JOIN snapshots s ON s.id = f.snapshot_id WHERE f.content_hash = ?`);
    const filesByProject = new Map();
    for (const hash of hashes) {
      for (const row of filesOf.all(hash)) {
        filesByProject.set(row.project_id, new Set([...(filesByProject.get(row.project_id) ?? []), row.project_file_id]));
      }
    }
    const kept = new Set();
    for (const snapshot of this.pinnedTableSnapshots()) {
      for (const fileId of filesByProject.get(snapshot.projectId) ?? []) {
        const file = this.timeline.snapshotFileById(snapshot.id, fileId);
        if (file && hashes.has(file.contentHash)) kept.add(file.contentHash);
      }
    }
    return kept;
  },

  /**
   * Folders' current snapshots, the snapshots unrevoked shares were made at
   * (for a share older than that record, its object version's), and every
   * snapshot a version of a linked claim read its source at.
   */
  pinnedTableSnapshots() {
    const rows = this.db.prepare(`SELECT s.id, s.project_id FROM snapshots s WHERE s.id IN (
      SELECT current_snapshot_id FROM projects WHERE current_snapshot_id IS NOT NULL
      UNION SELECT COALESCE(g.snapshot_id, v.snapshot_id) FROM object_share_grants g
        LEFT JOIN scientific_object_versions v ON v.id = g.object_version_id WHERE g.revoked_at IS NULL
      UNION SELECT source_snapshot_id FROM claim_dependency_versions)`).all();
    return rows.map((row) => ({ id: row.id, projectId: row.project_id }));
  },

  /** The contents among `hashes` that are one of the last few versions of a file that had them. */
  recentFileVersions(hashes) {
    const versionsOf = this.db.prepare(`SELECT f.project_file_id, MAX(s.version) AS version FROM snapshot_files f
      JOIN snapshots s ON s.id = f.snapshot_id WHERE f.content_hash = ? GROUP BY f.project_file_id`);
    const byFile = new Map();
    for (const hash of hashes) {
      for (const row of versionsOf.all(hash)) {
        byFile.set(row.project_file_id, [...(byFile.get(row.project_file_id) ?? []), { hash, version: row.version }]);
      }
    }
    return [...byFile.values()].flatMap((versions) => [...versions].sort((left, right) => right.version - left.version)
      .slice(0, TABLE_VERSIONS_KEPT).map((entry) => entry.hash));
  },

  /** Starts removing old tables a while after a capture, unless that is already waiting. */
  scheduleTableCleanup(delay = this.tableCleanupDelayMs) {
    if (this.tableCleanupTimer || this.tableCleanupStopped) return;
    this.tableCleanupTimer = setTimeout(() => this.runTableCleanup(), delay);
    this.tableCleanupTimer.unref();
  },

  /** A capture changes which snapshots are current, so what to keep is worked out again. */
  tableContentChanged() {
    this.tableKeepAnswers = null;
    this.scheduleTableCleanup();
  },

  /** One bounded batch, then the next on a later turn, until a batch finds nothing to remove. */
  runTableCleanup() {
    this.tableCleanupTimer = null;
    if (this.tableCleanupStopped) return;
    let removed;
    try {
      removed = this.tables.cleanup();
    } catch (error) {
      this.tableKeepAnswers = null;
      console.error('Removing old tables from the table index failed:', error.message);
      return;
    }
    if (removed.tables || removed.parts || removed.chunks || removed.rows) this.scheduleTableCleanup(0);
    else this.tableKeepAnswers = null;
  },

  stopTableCleanup() {
    this.tableCleanupStopped = true;
    clearTimeout(this.tableCleanupTimer);
    this.tableCleanupTimer = null;
  },
};
