import os from 'node:os';
import path from 'node:path';

// How the timeline reads a folder path it is given, and names a file's move.

/** A file that keeps its name in a new place was moved; one whose name changed was renamed. */
export function classifyPathChange(beforePath, afterPath) {
  return path.posix.basename(beforePath) === path.posix.basename(afterPath) ? 'MOVED' : 'RENAMED';
}

/** A folder path as typed or dropped: quotes, escaped spaces and a leading ~ are read as a shell would. */
export function normalizeProjectRootPath(input) {
  let value = String(input ?? '').trim();
  const quote = value[0];
  if (value.length >= 2 && (quote === "'" || quote === '"') && value.at(-1) === quote) {
    value = value.slice(1, -1).trim();
  }
  // Backslash is a directory separator on Windows, including before a space.
  if (process.platform !== 'win32') value = value.replace(/\\ /g, ' ');
  if (value === '~') value = os.homedir();
  else if (value.startsWith('~/') || (process.platform === 'win32' && value.startsWith('~\\'))) value = path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}
