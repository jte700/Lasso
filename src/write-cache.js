// Room for a long write on one SQLite connection.
//
// A write that touches pages all over a database's indexes, such as a table's
// rows or a folder's objects, keeps those pages in the connection's page
// cache until it commits. In SQLite's default 2 MB they were written out and
// read back many times first. A connection at rest keeps the default, so the
// room is taken for the write and given back after it.

const WRITE_CACHE_KILOBYTES = 32 * 1024;

/**
 * Gives a connection the page cache a long write needs. The function it
 * returns puts back the size it had and frees the pages, so a connection at
 * rest holds no more than it did. Calling it again does nothing.
 */
export function roomToWrite(db, kilobytes = WRITE_CACHE_KILOBYTES) {
  const atRest = db.prepare('PRAGMA cache_size').get().cache_size;
  db.exec(`PRAGMA cache_size = -${kilobytes}`);
  let given = true;
  return () => {
    if (!given) return;
    given = false;
    // A connection closed meanwhile has nothing left to give back.
    try { db.exec(`PRAGMA cache_size = ${atRest}; PRAGMA shrink_memory`); } catch { /* closed */ }
  };
}
