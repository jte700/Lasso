// Writes a connection's items into its folder: Markdown rendered from an
// item, or a file's own bytes downloaded when it changed. Files whose bytes
// are already here are left alone, a file moved in the app is moved here
// without downloading it, and files of items the app no longer has are removed.
import fs from 'node:fs';
import path from 'node:path';
import { relativePathFor, renderItem } from './providers.js';

// The Mac's file system does not tell "Report.pdf" from "report.pdf".
const key = (relative) => relative.normalize('NFC').toLowerCase();

// A path this file system will not hold: a folder and a file of one name, or a
// name too long. The item is left out and the rest still come in.
const UNWRITABLE = new Set(['EEXIST', 'ENOTDIR', 'EISDIR', 'ENAMETOOLONG']);

/** Removes a file, then the folders it leaves empty, up to the connection's folder; whether there was a file. */
function removeFile(folder, relative) {
  const existed = fs.existsSync(path.join(folder, relative));
  fs.rmSync(path.join(folder, relative), { force: true });
  let directory = path.dirname(path.join(folder, relative));
  while (directory.startsWith(`${folder}${path.sep}`)) {
    try { fs.rmdirSync(directory); } catch { break; }
    directory = path.dirname(directory);
  }
  return existed;
}

function moveFile(folder, from, to) {
  fs.mkdirSync(path.dirname(path.join(folder, to)), { recursive: true });
  fs.renameSync(path.join(folder, from), path.join(folder, to));
  removeFile(folder, from);
}

/** Whether a file item still belongs at its old path: same folders and name, whatever copy number it had. */
function samePlace(item, relative) {
  const copy = Number(path.basename(relative).match(/ \((\d+)\)(?:\.[^.]*)?$/)?.[1] ?? 1);
  return relativePathFor(item, copy) === relative || relativePathFor(item) === relative;
}

/**
 * The item's path. It keeps its old one while that still fits it, and a new
 * one never takes another item's old path, which that item may still keep.
 */
function freePath(item, known, taken, owners) {
  const free = (relative) => !taken.has(key(relative)) && (owners.get(key(relative)) ?? item.id) === item.id;
  if (known?.path && free(known.path)
    && (item.kind === 'file' ? samePlace(item, known.path) : known.title === item.title)) return known.path;
  let copy = 1;
  while (!free(relativePathFor(item, copy))) copy++;
  return relativePathFor(item, copy);
}

/** Writes bytes unless the file already holds them; whether it did. */
function writeBytes(target, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  let current = null;
  try { current = fs.readFileSync(target); } catch { /* a new item */ }
  if (current?.equals(bytes)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return true;
}

/** The item's content, or null when the app would not send it. */
async function contentOf(item, providerName) {
  try {
    return item.kind === 'file' ? await item.download() : renderItem(item, { providerName });
  } catch (error) {
    if (error.skip) return null;
    throw error;
  }
}

/**
 * Puts one item at its path; whether a file changed. Throws only for a path
 * the file system will not hold, which leaves the item out.
 */
function place(folder, { known, kept, content, relative, taken }) {
  if (kept) {
    if (relative === known.path) return false;
    moveFile(folder, known.path, relative);
    return true;
  }
  const changed = writeBytes(path.join(folder, relative), content);
  if (known?.path && key(known.path) !== key(relative) && !taken.has(key(known.path))) removeFile(folder, known.path);
  return changed;
}

/**
 * Brings the folder in line with `items`. `previous` is what the last sync
 * wrote, by item id; the result is what this one wrote and how many files changed.
 */
export async function writeItems({ folder, items, previous, providerName, onProgress = () => {}, keepMissing = false }) {
  const files = {};
  const taken = new Set();
  // Each old path stays its item's until that item has been written.
  const owners = new Map(items.filter((item) => previous[item.id]?.path)
    .map((item) => [key(previous[item.id].path), item.id]));
  let changed = 0;
  const here = (known) => Boolean(known?.path && fs.existsSync(path.join(folder, known.path)));
  const keepCopy = (itemId, known) => {
    // The app would not send this item, or it cannot be written: a copy already here stays.
    if (here(known) && !taken.has(key(known.path))) { files[itemId] = known; taken.add(key(known.path)); }
  };
  const downloads = items.filter((item) => item.kind === 'file' && !(item.unchanged && here(previous[item.id]))).length;
  let downloaded = 0;
  for (const item of items) {
    const known = previous[item.id];
    const kept = Boolean(item.unchanged && here(known));
    const content = kept ? null : await contentOf(item, providerName);
    if (item.kind === 'file' && !kept) onProgress(++downloaded / downloads);
    if (!kept && content == null) { keepCopy(item.id, known); continue; }
    const relative = freePath(item, known, taken, owners);
    try {
      if (place(folder, { known, kept, content, relative, taken })) changed++;
    } catch (error) {
      if (!UNWRITABLE.has(error.code)) throw error;
      keepCopy(item.id, known);
      continue;
    }
    taken.add(key(relative));
    const { link: _formerLink, ...earlier } = kept ? known : {};
    // The link is the item's as read now; one the app no longer gives is dropped.
    files[item.id] = { ...earlier, path: relative, title: item.title, edited: item.edited ?? null,
      ...(/^https:\/\//i.test(item.link ?? '') ? { link: item.link } : {}) };
  }
  for (const [itemId, known] of Object.entries(previous)) {
    if (files[itemId] || taken.has(key(known.path))) continue;
    if (keepMissing) { keepCopy(itemId, known); continue; }
    if (removeFile(folder, known.path)) changed++;
  }
  return { files, changed };
}
