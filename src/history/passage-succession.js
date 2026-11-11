// Which removed passage an added one rewords. Passages (sentences and
// paragraphs of text, Markdown, Word, slides and PDFs) are keyed by their own
// words, so an edit to a sentence records a new passage and removes the old.
// Pairing them lets the new one's history reach back through the old wording.
//
// Two passages pair when they are in the same file, of the same kind
// (sentence or paragraph, text or PDF), and most of their words are shared.
// Each pairs at most once, best match first. A file that gained or lost more
// passages than MAX_PASSAGES_PAIRED in one save was rewritten, and is not paired.

const PASSAGE_ANCHORS = ['text-excerpt', 'pdf-excerpt'];
// The share of words two wordings must have in common (Dice coefficient).
const MIN_SHARED_WORDS = 0.6;
const MAX_PASSAGES_PAIRED = 400;

const CHANGED_PASSAGES = `SELECT c.kind, c.object_id, v.id AS version_id, v.path, v.value_text,
    json_extract(v.anchor_json, '$.kind') AS anchor_kind,
    json_extract(v.anchor_json, '$.pageNumber') AS page_number,
    json_extract(v.anchor_json, '$.slideNumber') AS slide_number,
    json_extract(v.metadata_json, '$.excerptType') AS excerpt_type
  FROM object_changes c
  JOIN scientific_object_versions v ON v.id = COALESCE(c.after_version_id, c.before_version_id)
  WHERE c.snapshot_id = ? AND c.kind IN ('added', 'removed')
    AND json_extract(v.anchor_json, '$.kind') IN (${PASSAGE_ANCHORS.map(() => '?').join(', ')})`;

function wordCounts(text) {
  const counts = new Map();
  for (const word of String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) counts.set(word, (counts.get(word) ?? 0) + 1);
  return counts;
}

/** The share of two wordings' words they have in common, from 0 to 1. */
export function sharedWords(left, right) {
  let total = 0;
  let common = 0;
  for (const count of left.values()) total += count;
  for (const [word, count] of right) {
    total += count;
    common += Math.min(count, left.get(word) ?? 0);
  }
  return total ? (2 * common) / total : 0;
}

// Same file, same kind of anchor and passage, and the same slide when on one.
const groupOf = (row) => `${row.path}\u0000${row.anchor_kind}\u0000${row.excerpt_type ?? ''}\u0000${row.slide_number ?? ''}`;

function pairsIn(added, removed) {
  if (added.length > MAX_PASSAGES_PAIRED || removed.length > MAX_PASSAGES_PAIRED) return [];
  const removedWords = removed.map((row) => wordCounts(row.value_text));
  const candidates = [];
  for (const row of added) {
    const words = wordCounts(row.value_text);
    removed.forEach((old, index) => {
      const score = sharedWords(words, removedWords[index]);
      // A passage still on its page is the likelier one when two read alike.
      const samePage = old.page_number === row.page_number ? 0.001 : 0;
      if (score >= MIN_SHARED_WORDS) candidates.push({ row, old, score: score + samePage });
    });
  }
  candidates.sort((left, right) => right.score - left.score);
  const taken = new Set();
  const pairs = [];
  for (const { row, old } of candidates) {
    if (taken.has(row.object_id) || taken.has(old.object_id)) continue;
    taken.add(row.object_id);
    taken.add(old.object_id);
    pairs.push({ objectId: row.object_id, replacesVersionId: old.version_id });
  }
  return pairs;
}

/**
 * Records, for one snapshot's index, each added passage that rewords one the
 * same index removed. Runs inside the caller's transaction, after the index's
 * change records are written. Returns how many it recorded.
 */
export function recordPassageSuccessions(db, snapshotId) {
  const groups = new Map();
  for (const row of db.prepare(CHANGED_PASSAGES).all(snapshotId, ...PASSAGE_ANCHORS)) {
    const key = groupOf(row);
    if (!groups.has(key)) groups.set(key, { added: [], removed: [] });
    groups.get(key)[row.kind].push(row);
  }
  const insert = db.prepare(`INSERT OR IGNORE INTO passage_successions(snapshot_id, object_id, replaces_version_id)
    VALUES (?, ?, ?)`);
  let recorded = 0;
  for (const { added, removed } of groups.values()) {
    if (!added.length || !removed.length) continue;
    for (const pair of pairsIn(added, removed)) recorded += insert.run(snapshotId, pair.objectId, pair.replacesVersionId).changes;
  }
  return recorded;
}

/** The version a passage replaced when it was added, with the object and snapshot; null when it replaced none. */
export function replacedVersion(db, objectId) {
  return db.prepare(`SELECT s.snapshot_id, s.replaces_version_id AS version_id, v.object_id
    FROM passage_successions s JOIN scientific_object_versions v ON v.id = s.replaces_version_id
    WHERE s.object_id = ?`).get(objectId) ?? null;
}
