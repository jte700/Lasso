// Turns for the workers heavy readers run in (PDF text, IFC and STEP geometry,
// large tables). Each reader starts its own worker for one job, with its own
// memory limit, and ends it when the job is done, so no worker sits idle. At
// most MAX_WORKERS run at once; the rest wait in the order they asked, except
// that a preview someone is waiting to see goes before indexing.
//
// A reader reports each step it makes with `heard()`. One silent for longer
// than its limit loses its turn: its task is told through `signal` to stop its
// worker, and its call fails, so a worker that never exits cannot hold a turn.
//
// A caller that blocks the main thread while it waits for its worker
// (TableIndex.buildBlocking) must not take a turn here: the turn it waits for
// could only be handed over by the thread it is blocking.

export const MAX_WORKERS = 2;
// Long enough for one slow file between two reports.
export const SILENT_TURN_MS = 120_000;

let running = 0;
const waiting = [];
const previews = [];

function release() {
  running -= 1;
  const next = previews.shift() ?? waiting.shift();
  if (next) {
    running += 1;
    next();
  }
}

/** A promise that fails after `silentMs` without a call to its `heard()`. */
function silenceWatch(silentMs, controller) {
  let timer = null;
  let fail;
  const stalled = new Promise((_, reject) => { fail = reject; });
  const heard = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const error = new Error(`A worker reader was silent for ${Math.round(silentMs / 1000)} s and was stopped.`);
      controller.abort(error);
      fail(error);
    }, silentMs);
    timer.unref?.();
  };
  heard();
  return { stalled, heard, stop: () => clearTimeout(timer) };
}

/**
 * Runs `task({ signal, heard })`, which starts a worker and settles when it is
 * done, once a turn is free. `interactive` puts it ahead of waiting indexing.
 */
export async function pooled(task, { interactive = false, silentMs = SILENT_TURN_MS } = {}) {
  if (running < MAX_WORKERS) running += 1;
  else await new Promise((resolve) => (interactive ? previews : waiting).push(resolve));
  const controller = new AbortController();
  const watch = silenceWatch(silentMs, controller);
  try {
    return await Promise.race([task({ signal: controller.signal, heard: watch.heard }), watch.stalled]);
  } finally {
    watch.stop();
    release();
  }
}

/** How many workers run and how many wait, for tests and diagnostics. */
export function poolState() {
  return { running, waiting: waiting.length + previews.length };
}
