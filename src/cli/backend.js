// What the CLI asks Lasso, answered from the person's library opened in this
// process (the agent engine: no server, no folder watching), so the CLI
// works whether or not the Mac app is running. The interactive shell runs
// this in a worker thread (backend-worker.js) so its spinner and keys stay
// live while a long question is answered; one-shot commands call it here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { HttpError } from '../history/errors.js';
import { openEngine, resolveDataDir } from '../agent/engine.js';
import { Provenance } from './provenance.js';
import { Anywhere } from './anywhere.js';
import { SYSTEM } from './disk-facts.js';
import { hookState } from './ai-hooks-install.js';

/** Who the CLI records actions as, beside the Mac app's "Desktop". */
export const TERMINAL_ACTOR = Object.freeze({ id: 'human:terminal', displayName: 'Terminal', actorType: 'HUMAN_SELF' });

/** The person's first name from their account, for the welcome; null when it cannot be read. */
export function firstName() {
  try {
    const full = process.platform === 'darwin'
      ? execFileSync('id', ['-F'], { encoding: 'utf8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      : os.userInfo().username;
    const first = full.split(/\s+/)[0];
    return first ? first[0].toUpperCase() + first.slice(1) : null;
  } catch {
    return null;
  }
}

/**
 * The library the CLI reads: one named (--data-dir or LASSO_DATA_DIR), else
 * the Mac app's (or the Windows app's), else one made beside a checkout in
 * the folder the CLI runs in; null when there is none, so the CLI never
 * makes a library just by being run.
 */
export function findLibrary(explicit = null, { env = process.env, home = os.homedir(), cwd = process.cwd(), platform = process.platform } = {}) {
  if (explicit || env.LASSO_DATA_DIR) return resolveDataDir(explicit, { env, home, platform });
  const candidates = [
    platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Lasso', 'data') : null,
    platform === 'win32' && env.APPDATA ? path.join(env.APPDATA, 'Lasso', 'data') : null,
    path.join(cwd, '.lasso-data'),
    path.join(cwd, '.colab-dry-data'),
  ].filter(Boolean);
  return candidates.find((folder) => fs.existsSync(path.join(folder, 'timeline.sqlite'))) ?? null;
}

const NEEDS_LIBRARY = 'This needs the Lasso app\'s library, and there is none on this computer. '
  + '/whence, /blame, /diff, /verify and /log work on any file without one.';

/**
 * @param {{ dataDir?: string|null, cwd?: string, readHistory?: boolean, system?: typeof SYSTEM }} options
 */
export function openBackend({ dataDir = null, cwd = process.cwd(), readHistory = true, system = SYSTEM, env = process.env, home = os.homedir() } = {}) {
  const library = findLibrary(dataDir, { env, home, cwd });
  const engine = library ? openEngine({ dataDir: library, scope: [] }) : null;
  const provenance = engine ? new Provenance(engine) : null;
  const anywhere = new Anywhere({ provenance, system, cwd });
  // Change counts read each folder's whole value history; start that now, off this thread.
  if (readHistory) engine?.workspace.readValueHistory?.().catch(() => {});
  const withLibrary = (answer) => (...args) => {
    if (!engine) throw new HttpError(409, NEEDS_LIBRARY);
    return answer(...args);
  };
  const methods = {
    hello: () => ({ dataDir: library, library: Boolean(engine), name: firstName(),
      summary: provenance?.summary() ?? null, recent: provenance?.log({ limit: 5 }) ?? null }),
    summary: () => (provenance ? { ...provenance.summary(), claudeHook: hookState({ home }) } : null),
    run: withLibrary((input) => engine.workspace.terminalRun(String(input ?? ''), TERMINAL_ACTOR)),
    complete: (input) => (engine ? engine.workspace.terminalComplete(String(input ?? '')) : { suggestions: [] }),
    whence: (target) => anywhere.whence(target),
    // The library's changes; with no library, the changes in the folder the CLI was opened in.
    log: (options = {}) => (provenance ? { kind: 'library', ...provenance.log(options) } : { kind: 'folder', ...anywhere.folderLog('.', options) }),
    logAt: (target, options = {}) => anywhere.log(target, options),
    blame: (target, options = {}) => anywhere.blame(target, options),
    diff: (words, options = {}) => anywhere.diff(words, options),
    verify: (target, options = {}) => anywhere.verify(target, options),
    cursor: withLibrary(() => provenance.cursor()),
    events: withLibrary((cursor) => provenance.events(cursor)),
    files: (prefix) => (provenance ? fileNames(provenance, prefix) : []),
  };
  return {
    dataDir: library,
    engine,
    provenance,
    async call(method, ...args) {
      if (!methods[method]) throw new Error(`Unknown request ${method}.`);
      return methods[method](...args);
    },
    close() { engine?.close(); },
  };
}

/** Library file paths that start with or contain `prefix`, for completing file arguments. */
function fileNames(provenance, prefix) {
  const wanted = String(prefix ?? '').toLowerCase();
  const out = [];
  for (const folder of provenance.folders()) {
    if (!folder.currentSnapshotId) continue;
    for (const file of provenance.timeline.snapshotFiles(folder.currentSnapshotId)) {
      const lower = file.path.toLowerCase();
      const base = lower.slice(lower.lastIndexOf('/') + 1);
      if (!wanted || base.startsWith(wanted) || lower.startsWith(wanted)) out.push(file.path);
      if (out.length >= 200) return out;
    }
  }
  return out.sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/**
 * The same calls answered by a worker thread. Requests resolve in the
 * order they finish; `call` rejects with the backend's own message.
 */
export function startBackendWorker({ dataDir = null, cwd = process.cwd() } = {}) {
  const worker = new Worker(new URL('./backend-worker.js', import.meta.url), {
    workerData: { dataDir, cwd },
    execArgv: ['--disable-warning=ExperimentalWarning'],
    stdout: true,
    stderr: true,
  });
  // The engine logs indexing notes; they would break the drawn screen.
  worker.stdout?.resume();
  worker.stderr?.resume();
  let next = 1;
  const pending = new Map();
  let failure = null;
  const ready = new Promise((resolve, reject) => {
    worker.once('message', (message) => {
      if (message.type === 'ready') resolve(message);
      else reject(new Error(message.error ?? 'Lasso could not open your library.'));
    });
    worker.once('error', reject);
  });
  worker.on('message', (message) => {
    if (message.type !== 'reply') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) {
      const error = new Error(message.error);
      error.status = message.status ?? null;
      request.reject(error);
    } else request.resolve(message.value);
  });
  worker.on('error', (error) => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  worker.on('exit', (code) => {
    const error = failure ?? new Error(`Lasso's library process stopped (${code}).`);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  return {
    ready,
    call(method, ...args) {
      if (failure) return Promise.reject(failure);
      const id = next;
      next += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, method, args });
      });
    },
    async close() {
      worker.postMessage({ type: 'close' });
      const timer = setTimeout(() => worker.terminate(), 1500);
      await new Promise((resolve) => worker.once('exit', resolve));
      clearTimeout(timer);
    },
  };
}
