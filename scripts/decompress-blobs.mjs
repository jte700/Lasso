// Turns a Lasso data folder's compressed blobs back into raw ones, so a
// build from before blob compression can read its whole history again.
//
//   npm run blobs:decompress -- --data-dir <data folder>
//   node scripts/decompress-blobs.mjs <data folder>
//
// The data folder is the one holding timeline.sqlite and blobs/. Quit every
// Lasso using it first, or start them with LASSO_BLOB_COMPRESSION=off, so
// none compresses old versions again. Each raw copy is written whole before
// its compressed one is removed, so it is safe to stop and run again; a
// second run changes nothing.

import fs from 'node:fs';
import path from 'node:path';
import { BlobStore } from '../src/history/blob-store.js';

/** The data folder named by `--data-dir <dir>`, `--data-dir=<dir>`, or as the only argument. */
function dataFolder(args) {
  const flag = args.indexOf('--data-dir');
  if (flag >= 0) return args[flag + 1] ?? null;
  const joined = args.find((arg) => arg.startsWith('--data-dir='));
  if (joined) return joined.slice('--data-dir='.length);
  return args.find((arg) => !arg.startsWith('--')) ?? null;
}

const dataDir = dataFolder(process.argv.slice(2));
if (!dataDir) {
  console.error('Name the data folder to decompress: npm run blobs:decompress -- --data-dir <data folder>');
  process.exit(2);
}
const blobDir = path.join(path.resolve(dataDir), 'blobs');
if (!fs.existsSync(blobDir)) {
  console.error(`There is no blobs folder in ${path.resolve(dataDir)}.`);
  process.exit(2);
}

const { decompressed, damaged } = new BlobStore(blobDir).decompressAll();
console.log(`Turned ${decompressed} compressed blob${decompressed === 1 ? '' : 's'} back into raw ones in ${blobDir}.`);
if (damaged.length) {
  console.error(`${damaged.length} compressed blob${damaged.length === 1 ? ' was' : 's were'} damaged and left as they are:`);
  for (const hash of damaged) console.error(`  ${hash}`);
  process.exitCode = 1;
}
