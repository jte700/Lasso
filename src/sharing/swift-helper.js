// The small Swift programs the share renderers run, and the cache their
// output is kept in. The app bundles each program compiled; run from the
// repository, a program is compiled once, on first use.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const execute = promisify(execFile);
const COMPILE_TIMEOUT_MS = 60_000;
const compiling = new Map();

/**
 * A function that resolves to the path of `scripts/<name>`, the bundled
 * build when there is one.
 * @param {string} name the program, and its source `scripts/<name>.swift`
 * @param {string[]} frameworks linked when compiling from source
 * @param {string} unavailable why it cannot run off a Mac
 * @returns {() => Promise<string>}
 */
export function swiftHelper(name, frameworks, unavailable) {
  const bundled = fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url));
  const source = fileURLToPath(new URL(`../../scripts/${name}.swift`, import.meta.url));
  return async () => {
    if (fs.existsSync(bundled)) return bundled;
    if (process.platform !== 'darwin') throw new Error(unavailable);
    if (!compiling.has(name)) {
      compiling.set(name, (async () => {
        const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), `lasso-${name}-`));
        process.once('exit', () => { try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* cleanup */ } });
        const target = path.join(temporary, name);
        await execute('/usr/bin/swiftc', ['-O', '-module-cache-path', path.join(os.tmpdir(), 'lasso-swift-module-cache'),
          ...frameworks.flatMap((framework) => ['-framework', framework]), source, '-o', target],
        { timeout: COMPILE_TIMEOUT_MS, maxBuffer: 1_000_000 });
        return target;
      })());
    }
    return compiling.get(name);
  };
}

/**
 * Rendered files kept by key, at most `entries` of them and `bytes` in all.
 * A key asked for again while it renders shares that render; a failed render
 * is forgotten, so the next request tries again.
 * @returns {(key: string, render: () => Promise<Buffer>) => Promise<Buffer>}
 */
export function renderCache({ entries, bytes }) {
  const cache = new Map();
  let cachedBytes = 0;
  return async (key, render) => {
    if (cache.has(key)) return cache.get(key).promise;
    const entry = { promise: render(), size: 0 };
    cache.set(key, entry);
    try {
      const result = await entry.promise;
      entry.size = result.length;
      cachedBytes += result.length;
      // Eviction is synchronous. Awaiting another render here lets concurrent
      // completions remove/count the same entry twice and defeats the byte cap.
      for (const [oldest, value] of cache) {
        if (cache.size <= entries && cachedBytes <= bytes) break;
        if (!value.size) continue;
        cachedBytes -= value.size;
        cache.delete(oldest);
      }
      return result;
    } catch (error) { cache.delete(key); throw error; }
  };
}
