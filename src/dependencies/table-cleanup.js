import { chunkRowIds, immediately, storedTerms } from './table-storage.js';

// Removes what the table index no longer needs, a bounded batch at a time.
// A table whose file content no snapshot keeps is dropped first: its record
// goes at once, so nothing reads it again, and its list of chunks follows in
// batches. A chunk no table uses then goes, which releases its rows, and a row
// no chunk holds goes with the names it was found by. Every step is a short
// transaction of its own, so a build in the worker waits for none for long.

// The most rows (parts, chunk entries or row bodies) one step of a batch touches.
export const CLEANUP_BATCH_ROWS = 2_000;
// The most tables one batch drops.
const DROPPED_TABLES_PER_BATCH = 64;
// An unfinished table not written to for this long was left by a build that stopped.
const STALE_BUILD_MS = 60 * 60 * 1000;

/**
 * Drops tables in an older version, unfinished tables nobody is writing, and
 * finished tables whose content `keep` does not keep. `keep(hashes)` returns
 * the set of those content hashes still needed; without it every finished
 * table is kept.
 */
function dropTables(db, { keep, version, now }) {
  const tables = db.prepare('SELECT id, content_hash, version, complete, touched_at FROM tables').all();
  const finished = new Set(tables.filter((table) => table.complete && table.version === version).map((table) => table.content_hash));
  const kept = keep && finished.size ? keep(finished) : finished;
  const dropped = tables.filter((table) => (table.version !== version
    || (table.complete ? !kept.has(table.content_hash) : table.touched_at < now - STALE_BUILD_MS)))
    .slice(0, DROPPED_TABLES_PER_BATCH);
  if (!dropped.length) return [];
  const remove = db.prepare('DELETE FROM tables WHERE id = ? AND touched_at = ?');
  const mark = db.prepare('INSERT OR IGNORE INTO dropped_tables(table_id) VALUES (?)');
  return immediately(db, () => dropped.filter((table) => {
    // A table written to since it was listed is someone's build, and stays.
    if (!Number(remove.run(table.id, table.touched_at).changes)) return false;
    mark.run(table.id);
    return true;
  }));
}

/** Removes a table's record so nothing reads it, leaving its parts to cleanup. */
export function dropTable(db, tableId) {
  immediately(db, () => {
    db.prepare('DELETE FROM tables WHERE id = ?').run(tableId);
    db.prepare('INSERT OR IGNORE INTO dropped_tables(table_id) VALUES (?)').run(tableId);
  });
}

function removeParts(db, budget) {
  return immediately(db, () => {
    let removed = 0;
    const parts = db.prepare('SELECT first_ordinal, chunk_id FROM table_parts WHERE table_id = ? LIMIT ?');
    const removePart = db.prepare('DELETE FROM table_parts WHERE table_id = ? AND first_ordinal = ?');
    const release = db.prepare('UPDATE table_chunks SET refs = refs - 1 WHERE id = ?');
    for (const { table_id: tableId } of db.prepare('SELECT table_id FROM dropped_tables').all()) {
      const rows = parts.all(tableId, budget - removed);
      for (const part of rows) {
        removePart.run(tableId, part.first_ordinal);
        release.run(part.chunk_id);
      }
      removed += rows.length;
      if (removed >= budget) break;
      db.prepare('DELETE FROM dropped_tables WHERE table_id = ?').run(tableId);
    }
    return removed;
  });
}

function removeChunks(db, budget) {
  return immediately(db, () => {
    let entries = 0;
    let removed = 0;
    const release = db.prepare('UPDATE table_row_bodies SET refs = refs - 1 WHERE id = ?');
    const remove = db.prepare('DELETE FROM table_chunks WHERE id = ?');
    for (const chunk of db.prepare('SELECT id, row_count, entries FROM table_chunks WHERE refs <= 0 LIMIT ?').all(budget)) {
      if (removed && entries + chunk.row_count > budget) break;
      for (const rowId of chunkRowIds(chunk.entries, chunk.row_count)) release.run(rowId);
      remove.run(chunk.id);
      entries += chunk.row_count;
      removed += 1;
    }
    return removed;
  });
}

function removeRows(db, budget) {
  return immediately(db, () => {
    const unused = db.prepare('SELECT id, cells_json, term_columns FROM table_row_bodies WHERE refs <= 0 LIMIT ?').all(budget);
    const removeTerm = db.prepare('DELETE FROM table_row_terms WHERE label_column = ? AND term = ? AND row_id = ?');
    const remove = db.prepare('DELETE FROM table_row_bodies WHERE id = ?');
    for (const row of unused) {
      for (const [column, term] of storedTerms(row.cells_json, row.term_columns)) removeTerm.run(column, term, row.id);
      remove.run(row.id);
    }
    return unused.length;
  });
}

/**
 * One bounded batch of cleanup. Returns how many tables, parts, chunks and
 * rows it removed, and the tables it dropped, so their readings can be
 * forgotten. A batch that removes nothing means nothing is left to remove.
 */
export function cleanupBatch(db, { keep, version, now = Date.now(), budget = CLEANUP_BATCH_ROWS }) {
  const dropped = dropTables(db, { keep, version, now });
  const parts = removeParts(db, budget);
  const chunks = removeChunks(db, budget);
  const rows = removeRows(db, budget);
  return { tables: dropped.length, parts, chunks, rows, dropped };
}
