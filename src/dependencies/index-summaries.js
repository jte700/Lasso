// Keeping what a later index needs to carry unchanged files forward
// (indexSummary in index-state.js) in the database as well as in memory, so a
// restart does not make the next edit read the whole folder again.

import { indexSummary } from './index-state.js';

// A summary stored as differences resolves through at most this many earlier
// ones; past it, the next is stored whole, which bounds reading one back.
export const MAX_SUMMARY_CHAIN = 200;

const RESOLVE_FILES = `WITH RECURSIVE chain(snapshot_id, base_snapshot_id, depth) AS (
  SELECT snapshot_id, base_snapshot_id, 0 FROM snapshot_index_summaries WHERE snapshot_id = ?
  UNION ALL
  SELECT s.snapshot_id, s.base_snapshot_id, chain.depth + 1 FROM chain
  JOIN snapshot_index_summaries s ON s.snapshot_id = chain.base_snapshot_id
  WHERE chain.depth < ${MAX_SUMMARY_CHAIN + 1}
),
entries AS (SELECT f.path, f.object_count, f.problems_json, chain.depth FROM snapshot_index_files f
  JOIN chain ON chain.snapshot_id = f.snapshot_id)
SELECT path, object_count, problems_json, MIN(depth) AS depth FROM entries GROUP BY path`;

const CHAIN_END = `WITH RECURSIVE chain(snapshot_id, base_snapshot_id, depth) AS (
  SELECT snapshot_id, base_snapshot_id, 0 FROM snapshot_index_summaries WHERE snapshot_id = ?
  UNION ALL
  SELECT s.snapshot_id, s.base_snapshot_id, chain.depth + 1 FROM chain
  JOIN snapshot_index_summaries s ON s.snapshot_id = chain.base_snapshot_id
  WHERE chain.depth < ${MAX_SUMMARY_CHAIN + 1}
) SELECT base_snapshot_id FROM chain ORDER BY depth DESC LIMIT 1`;

const problemsJson = (problems) => (problems?.length ? JSON.stringify(problems) : null);

/** The parts of a dictionary definition applyVariableDefinitions reads. */
const storedDefinition = ({ type, path, label, value, metadata }) => ({ type, path, label, value, metadata });

export const indexSummaryMethods = {
  /**
   * Stores a snapshot's summary inside the caller's transaction. With
   * `known`, the summary of `base`, only the files whose entry differs from
   * it are written; otherwise every file is.
   */
  saveIndexSummary(snapshotId, summary, { base = null, known = null } = {}) {
    const baseDepth = base && known
      ? this.db.prepare('SELECT depth FROM snapshot_index_summaries WHERE snapshot_id = ?').get(base)?.depth : undefined;
    const delta = baseDepth !== undefined && baseDepth + 1 < MAX_SUMMARY_CHAIN;
    this.forgetIndexSummary(snapshotId);
    const definitions = summary.definitions.length ? JSON.stringify(summary.definitions.map(storedDefinition)) : null;
    this.db.prepare(`INSERT INTO snapshot_index_summaries(snapshot_id, base_snapshot_id, depth, definitions_json)
      VALUES (?, ?, ?, ?)`).run(snapshotId, delta ? base : null, delta ? baseDepth + 1 : 0, definitions);
    const insert = this.db.prepare('INSERT INTO snapshot_index_files(snapshot_id, path, object_count, problems_json) VALUES (?, ?, ?, ?)');
    for (const [filePath, count] of summary.counts) {
      const problems = problemsJson(summary.problems.get(filePath));
      if (delta && known.counts.get(filePath) === count && problemsJson(known.problems.get(filePath)) === problems) continue;
      insert.run(snapshotId, filePath, count, problems);
    }
    if (!delta) return;
    for (const filePath of known.counts.keys()) {
      if (!summary.counts.has(filePath)) insert.run(snapshotId, filePath, null, null);
    }
  },

  /** Drops a snapshot's stored summary; summaries built on it stop resolving, and their indexes are read in full. */
  forgetIndexSummary(snapshotId) {
    this.db.prepare('DELETE FROM snapshot_index_files WHERE snapshot_id = ?').run(snapshotId);
    this.db.prepare('DELETE FROM snapshot_index_summaries WHERE snapshot_id = ?').run(snapshotId);
  },

  /**
   * A snapshot's summary read back from the database, or null when it was
   * never stored or an earlier one it was built on is gone.
   */
  loadIndexSummary(snapshotId) {
    const head = this.db.prepare('SELECT definitions_json FROM snapshot_index_summaries WHERE snapshot_id = ?').get(snapshotId);
    if (!head) return null;
    // A chain must end at a summary stored whole; one that ends at a missing
    // summary, or runs past the limit, cannot say which files the folder had.
    const end = this.db.prepare(CHAIN_END).get(snapshotId);
    if (!end || end.base_snapshot_id !== null) return null;
    const counts = new Map();
    const problems = [];
    for (const row of this.db.prepare(RESOLVE_FILES).all(snapshotId)) {
      if (row.object_count === null) continue;
      counts.set(row.path, row.object_count);
      if (row.problems_json) problems.push(...JSON.parse(row.problems_json));
    }
    const definitions = head.definitions_json ? JSON.parse(head.definitions_json) : [];
    return indexSummary(counts, problems, definitions, false);
  },

  /** The summary of an index this process built, or the one stored for it. */
  knownIndexSummary(snapshotId) {
    const cached = this.indexedHere.get(snapshotId);
    if (cached) return cached;
    const loaded = this.loadIndexSummary(snapshotId);
    if (loaded) this.indexedHere.set(snapshotId, loaded);
    return loaded;
  },
};
