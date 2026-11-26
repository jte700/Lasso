// Files a cloud drive keeps online alone. With "Optimize Mac Storage" on,
// iCloud Drive, and the Google Drive, OneDrive and Dropbox apps under
// ~/Library/CloudStorage, leave a placeholder on the Mac: a file of the right
// name and size whose bytes are not here. macOS marks it dataless
// (SF_DATALESS), and reading it downloads it, so Lasso never reads one while
// indexing. It is counted instead, and downloaded only when the person asks.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const SF_DATALESS = 0x40000000;
// Paths handed to one stat(1) run.
const BATCH = 200;

/** The flags stat(1) reports for each path, in order, or null where it failed. */
function flagsOf(paths) {
  const run = spawnSync('/usr/bin/stat', ['-f', '%f', ...paths], { encoding: 'utf8' });
  if (run.error) return paths.map(() => null);
  const lines = run.stdout.split('\n').filter(Boolean);
  // A path that failed prints no line, so the lines no longer line up: ask one at a time.
  if (lines.length !== paths.length) return paths.length === 1 ? [null] : paths.flatMap((one) => flagsOf([one]));
  return lines.map((line) => (/^\d+$/.test(line.trim()) ? Number(line.trim()) : null));
}

export const macPlaceholders = Object.freeze({
  /**
   * The absolute paths of `files` (`{ absolutePath, stat }`, stat as BigInt)
   * that are dataless. Only a file with a size and no blocks on disk can be
   * one, so a folder of ordinary files costs no extra call.
   */
  find(files) {
    if (process.platform !== 'darwin') return new Set();
    const candidates = files.filter((file) => file.stat && file.stat.size > 0n && file.stat.blocks === 0n)
      .map((file) => file.absolutePath);
    const found = new Set();
    for (let start = 0; start < candidates.length; start += BATCH) {
      const batch = candidates.slice(start, start + BATCH);
      flagsOf(batch).forEach((flags, index) => {
        // eslint-disable-next-line no-bitwise
        if (flags !== null && (flags & SF_DATALESS) !== 0) found.add(batch[index]);
      });
    }
    return found;
  },

  /** Downloads one placeholder: reading its first byte has macOS bring the whole file. */
  async materialize(absolutePath) {
    const handle = await fs.promises.open(absolutePath, 'r');
    try { await handle.read(Buffer.alloc(1), 0, 1, 0); }
    finally { await handle.close(); }
  },
});
