// The small Swift programs the share renderers run, and the cache their
// output is kept in. The app bundles each program compiled; run from the
// repository, a program is compiled once, on first use.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

export const execute = promisify(execFile);
const COMPILE_TIMEOUT_MS = 60_000;
const compiling = new Map();
const compiledNow = new Map();

/**
 * A function that resolves to the path of `scripts/<name>`, the bundled
 * build when there is one.
 * @param {string} name the program, and its source `scripts/<name>.swift`
 * @param {string[]} frameworks linked when compiling from source
 * @param {string} unavailable why it cannot run off a Mac
 * @returns {(() => Promise<string>) & { sync: () => string }}
 */
export function swiftHelper(name, frameworks, unavailable) {
  const bundled = fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url));
  const source = fileURLToPath(new URL(`../../scripts/${name}.swift`, import.meta.url));
  const target = () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `lasso-${name}-`));
    process.once('exit', () => { try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* cleanup */ } });
    return path.join(temporary, name);
  };
  const compilerArguments = (output) => ['-O', '-module-cache-path', path.join(os.tmpdir(), 'lasso-swift-module-cache'),
    ...frameworks.flatMap((framework) => ['-framework', framework]), source, '-o', output];
  const resolve = async () => {
    if (fs.existsSync(bundled)) return bundled;
    if (process.platform !== 'darwin') throw new Error(unavailable);
    if (!compiling.has(name)) {
      compiling.set(name, (async () => {
        const output = target();
        await execute('/usr/bin/swiftc', compilerArguments(output), { timeout: COMPILE_TIMEOUT_MS, maxBuffer: 1_000_000 });
        return output;
      })());
    }
    return compiling.get(name);
  };
  // The same program for a caller that cannot wait: compiled here, at most once, when no build is waiting.
  resolve.sync = () => {
    if (fs.existsSync(bundled)) return bundled;
    if (process.platform !== 'darwin') throw new Error(unavailable);
    if (!compiledNow.has(name)) {
      const output = target();
      execFileSync('/usr/bin/swiftc', compilerArguments(output), { timeout: COMPILE_TIMEOUT_MS, maxBuffer: 1_000_000 });
      compiledNow.set(name, output);
    }
    return compiledNow.get(name);
  };
  return resolve;
}

/**
 * Rendered files kept by key, at most `entries` of them and `bytes` in all.
 * A key asked for again while it renders shares that render; a failed render
 * is forgotten, so the next request tries again. `has(key)` says whether a
 * key is kept or rendering.
 * @returns {((key: string, render: () => Promise<Buffer>) => Promise<Buffer>) & { has: (key: string) => boolean }}
 */
export function renderCache({ entries, bytes }) {
  const cache = new Map();
  let cachedBytes = 0;
  const has = (key) => cache.has(key);
  return Object.assign(async (key, render) => {
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
  }, { has });
}
