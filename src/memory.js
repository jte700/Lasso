// Giving memory back after large pieces of work. Indexing a changed table
// parses the whole file and compares it with the version before, which leaves
// tens of megabytes of garbage. V8 collects it lazily and grows the heap in
// the meantime, so a run of edits to a large file kept raising the process's
// peak memory. A full collection right after such work keeps the heap near
// what is actually held, for about 15 ms per large edit.

import v8 from 'node:v8';
import vm from 'node:vm';

// Work that read less than this many bytes of files leaves too little garbage
// to be worth a full collection. Compressed formats (xlsx, docx) parse into
// many times their size on disk, so the bar is low.
export const COLLECT_AFTER_BYTES = 64 * 1024;

let collect;

/** The engine's full collection, made available once without a launch flag. */
function fullCollection() {
  if (collect !== undefined) return collect;
  try {
    if (typeof globalThis.gc === 'function') collect = globalThis.gc;
    else {
      v8.setFlagsFromString('--expose-gc');
      collect = vm.runInNewContext('gc');
    }
  } catch {
    collect = null;
  }
  return collect;
}

/**
 * Runs a full collection when the work just finished read at least
 * COLLECT_AFTER_BYTES of files. Returns whether it ran.
 */
export function releaseAfterWork(bytesRead) {
  if (!(bytesRead >= COLLECT_AFTER_BYTES)) return false;
  const gc = fullCollection();
  if (!gc) return false;
  gc();
  return true;
}
