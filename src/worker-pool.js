// Turns for the workers heavy readers run in (PDF text, IFC and STEP geometry,
// large tables). Each reader starts its own worker for one job, with its own
// memory limit, and ends it when the job is done, so no worker sits idle. At
// most MAX_WORKERS run at once; the rest wait in the order they asked.
//
// A caller that blocks the main thread while it waits for its worker
// (TableIndex.buildBlocking) must not take a turn here: the turn it waits for
// could only be handed over by the thread it is blocking.

export const MAX_WORKERS = 2;

let running = 0;
const waiting = [];

function release() {
  running -= 1;
  const next = waiting.shift();
  if (next) {
    running += 1;
    next();
  }
}

/** Runs `task` (which starts a worker and settles when it is done) once a turn is free. */
export async function pooled(task) {
  if (running < MAX_WORKERS) running += 1;
  else await new Promise((resolve) => waiting.push(resolve));
  try {
    return await task();
  } finally {
    release();
  }
}

/** How many workers run and how many wait, for tests and diagnostics. */
export function poolState() {
  return { running, waiting: waiting.length };
}
