// Cleanup of the blob store that runs only while the library is quiet: it
// starts a while after the last capture, works in small batches with a pause
// between them, and stops while a capture is being read. Releasing old bytes
// (retention.js) and compressing old text (blob-compaction.js) both run this way.

// The pause between batches of one pass, so cleanup never holds the server for long.
export const BATCH_PAUSE_MS = 1_000;

export class IdleBatches {
  /**
   * `runBatch()` does one batch and returns `{ done, waiting }`: `done` once
   * a pass has looked at everything, `waiting` when a capture held it back.
   * `isEnabled()` is asked before each batch is scheduled. `label` names the
   * work in the message logged when a batch fails.
   */
  constructor({ timeline, idleMs, isEnabled, runBatch, label }) {
    this.idleMs = idleMs;
    this.isEnabled = isEnabled;
    this.runBatch = runBatch;
    this.label = label;
    // The next batch, when one is waiting. Nothing is scheduled while the work is off.
    this.timer = null;
    this.closed = false;
    // Each capture puts the next batch back, so cleanup waits for captures to stop.
    this.stopListening = timeline.onCapture(() => this.schedule(this.idleMs));
  }

  /** Schedules a first pass after startup, for a library that is not changing. */
  start() {
    this.schedule(this.idleMs);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.stopListening();
  }

  schedule(delayMs) {
    if (!this.isEnabled() || this.closed) return;
    clearTimeout(this.timer);
    // Unreferenced, so a waiting batch never keeps the process alive.
    this.timer = setTimeout(() => this.runScheduled(), delayMs);
    this.timer.unref?.();
  }

  runScheduled() {
    this.timer = null;
    let batch;
    try {
      batch = this.runBatch();
    } catch (error) {
      // The next capture starts another pass.
      console.error(`Lasso could not ${this.label}:`, error.message);
      return;
    }
    if (batch.done) return;
    this.schedule(batch.waiting ? this.idleMs : Math.min(BATCH_PAUSE_MS, this.idleMs));
  }
}
