import { setImmediate as nextTurn } from 'node:timers/promises';

// Long reads (scanning a folder, indexing its files, re-reading them) are
// written once, as generators that yield after each unit of work. Callers
// that need the answer at once drain them; the work directory list runs them
// in slices instead, so the server keeps answering the menu and suggestions
// while a large folder is read, and can say how far it has got.

// How long one slice holds the event loop before letting other work run.
const SLICE_MS = 12;

/** Runs a step generator to completion and returns its result. */
export function runSync(steps) {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/**
 * Runs a step generator a slice at a time. Each yielded value is a progress
 * report, handed to `onProgress`. A step that throws rejects the promise.
 * `cancelled()` is asked after every pause; an error it returns stops the
 * work there, before another step touches storage that may have closed.
 */
export async function runSliced(steps, { onProgress = null, cancelled = null, sliceMs = SLICE_MS } = {}) {
  let sliceStart = performance.now();
  try {
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
      if (step.value && onProgress) onProgress(step.value);
      if (performance.now() - sliceStart >= sliceMs) {
        await nextTurn();
        const reason = cancelled?.();
        if (reason) throw reason;
        sliceStart = performance.now();
      }
    }
  } catch (error) {
    steps.return?.();
    throw error;
  }
}

/**
 * A file's share of a read: one unit, and one more for every 256 KB, so one
 * large workbook moves the bar further than a short note.
 */
export function workUnits(size) {
  return 1 + Math.max(0, Number(size) || 0) / 262_144;
}
