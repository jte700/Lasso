// What any file on disk says about where it came from, read on the spot:
// its dates, what macOS keeps about it (Spotlight's metadata, such as the
// address it was downloaded from or the app that wrote it, and the mark a
// download or a sandboxed app leaves), the other files on this Mac with the
// same bytes, and files named like it. Nothing is indexed or kept: each
// question asks the system that already knows, and each reading is skipped
// where the system lacks it (Spotlight off, another platform).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { untilde } from './format.js';

/** The commands disk facts are read with; tests stand in their own. */
export const SYSTEM = Object.freeze({
  platform: process.platform,
  /** A command's output as text, or null when it is missing, fails or takes too long. */
  run(command, args, { cwd = undefined, input = undefined, timeout = 5000 } = {}) {
    try {
      return execFileSync(command, args, { cwd, input, encoding: 'utf8', timeout, maxBuffer: 32 << 20,
        stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  },
});

/** Spotlight's names for what it knows about a file, read in one call. */
const SPOTLIGHT_NAMES = [
  'kMDItemWhereFroms', 'kMDItemDownloadedDate', 'kMDItemDateAdded', 'kMDItemContentCreationDate',
  'kMDItemContentModificationDate', 'kMDItemCreator', 'kMDItemEncodingApplications', 'kMDItemAuthors',
  'kMDItemLastUsedDate', 'kMDItemUseCount', 'kMDItemAcquisitionMake', 'kMDItemAcquisitionModel',
  'kMDItemLatitude', 'kMDItemLongitude', 'kMDItemDurationSeconds', 'kMDItemCodecs', 'kMDItemPixelWidth',
  'kMDItemPixelHeight', 'kMDItemNumberOfPages', 'kMDItemTitle', 'kMDItemFinderComment',
  'kMDItemUserSharedReceivedSender', 'kMDItemUserSharedReceivedSenderHandle', 'kMDItemUserSharedReceivedTransport',
  'kMDItemUserSharedReceivedDate',
];

/** Files of one size hashed to find copies; past these the search stops. */
const MAX_COPY_CANDIDATES = 40;
const MAX_COPY_BYTES = 4 * 1024 ** 3;
const MAX_NAMES_LIKE = 6;

export const hasSpotlight = (system) => system.platform === 'darwin';

// ── finding the file ─────────────────────────────────────────────────────

/** A typed path with the backslashes a Finder drag puts before spaces taken out. */
export function unescapePath(text) {
  const trimmed = String(text ?? '').trim();
  return process.platform === 'win32' ? trimmed : trimmed.replace(/\\(.)/g, '$1');
}

/**
 * The file a person means: a path that exists, or, for a bare name that is
 * not in this folder, the files Spotlight finds with exactly that name,
 * newest first. Null when there is none.
 */
export function locate(query, { cwd = process.cwd(), system = SYSTEM, folders = false, spotlight = true } = {}) {
  const raw = unescapePath(query);
  if (!raw) return null;
  const absolute = path.resolve(cwd, untilde(raw));
  const kind = kindAt(absolute);
  if (kind === 'file' || (folders && kind === 'folder')) return { absolute, kind, others: [] };
  if (!spotlight || raw.includes('/') || !hasSpotlight(system)) return null;
  const hits = spotlightFind(system, ['-name', raw])
    .filter((hit) => path.basename(hit).toLowerCase() === raw.toLowerCase() && kindAt(hit) === 'file')
    .map((hit) => ({ path: hit, modified: statOf(hit)?.mtimeMs ?? 0 }))
    .sort((a, b) => b.modified - a.modified)
    .map((hit) => hit.path);
  if (!hits.length) return null;
  return { absolute: hits[0], kind: 'file', found: 'spotlight', others: hits.slice(1, 6) };
}

function kindAt(absolute) {
  const stats = statOf(absolute);
  return stats?.isFile() ? 'file' : stats?.isDirectory() ? 'folder' : null;
}

function statOf(absolute) {
  try { return fs.statSync(absolute); } catch { return null; }
}

/** Paths Spotlight answers for a query, without its own notes. */
function spotlightFind(system, args) {
  const output = system.run('mdfind', args, { timeout: 6000 });
  return output ? output.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('/')) : [];
}

// ── what the system knows about one file ─────────────────────────────────

/**
 * { created, modified, spotlight, mark, zone } for a file: its own dates,
 * what Spotlight knows of it, and the mark a download leaves (macOS's
 * quarantine attribute, Windows's Zone.Identifier).
 */
export function systemFacts(absolute, { system = SYSTEM, stats = statOf(absolute) } = {}) {
  const created = stats?.birthtimeMs > 0 ? stats.birthtime.toISOString() : null;
  const facts = { created, modified: stats?.mtime?.toISOString() ?? null, spotlight: null, mark: null, zone: null };
  if (system.platform === 'darwin') {
    facts.spotlight = spotlightFacts(absolute, system);
    facts.mark = quarantineMark(system.run('xattr', ['-p', 'com.apple.quarantine', absolute]));
    if (!facts.spotlight?.whereFrom?.length) {
      const whereFrom = whereFromsAttribute(absolute, system);
      if (whereFrom.length) facts.spotlight = { ...(facts.spotlight ?? {}), whereFrom };
    }
  }
  if (system.platform === 'win32') facts.zone = zoneIdentifier(absolute);
  return facts;
}

/** What Spotlight keeps about a file, in plain names; null when it has nothing. */
export function spotlightFacts(absolute, system = SYSTEM) {
  const args = ['-plist', '-'];
  for (const name of SPOTLIGHT_NAMES) args.push('-name', name);
  const values = parsePlist(system.run('mdls', [...args, absolute]) ?? '');
  if (!values || typeof values !== 'object') return null;
  const list = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]).map(String).filter(Boolean);
  const camera = [values.kMDItemAcquisitionMake, values.kMDItemAcquisitionModel].filter(Boolean);
  const facts = {
    whereFrom: list(values.kMDItemWhereFroms),
    downloadedAt: firstDate(values.kMDItemDownloadedDate),
    addedAt: firstDate(values.kMDItemDateAdded),
    contentCreatedAt: firstDate(values.kMDItemContentCreationDate),
    contentModifiedAt: firstDate(values.kMDItemContentModificationDate),
    creator: values.kMDItemCreator ? String(values.kMDItemCreator) : null,
    encoders: list(values.kMDItemEncodingApplications),
    authors: list(values.kMDItemAuthors),
    lastOpenedAt: firstDate(values.kMDItemLastUsedDate),
    opens: Number.isFinite(values.kMDItemUseCount) ? values.kMDItemUseCount : null,
    // The maker's name often starts the model's ("Apple" and "iPhone 15 Pro", or "Canon" and "Canon EOS R6").
    camera: camera.length ? (camera[1]?.startsWith(camera[0]) ? camera[1] : camera.join(' ')) : null,
    location: Number.isFinite(values.kMDItemLatitude) && Number.isFinite(values.kMDItemLongitude)
      ? { latitude: values.kMDItemLatitude, longitude: values.kMDItemLongitude } : null,
    duration: Number.isFinite(values.kMDItemDurationSeconds) ? values.kMDItemDurationSeconds : null,
    codecs: list(values.kMDItemCodecs),
    pixels: values.kMDItemPixelWidth && values.kMDItemPixelHeight ? `${values.kMDItemPixelWidth}×${values.kMDItemPixelHeight}` : null,
    pages: Number.isFinite(values.kMDItemNumberOfPages) ? values.kMDItemNumberOfPages : null,
    title: values.kMDItemTitle ? String(values.kMDItemTitle) : null,
    comment: values.kMDItemFinderComment ? String(values.kMDItemFinderComment) : null,
    received: values.kMDItemUserSharedReceivedTransport || values.kMDItemUserSharedReceivedSender
      ? { from: list(values.kMDItemUserSharedReceivedSender)[0] ?? list(values.kMDItemUserSharedReceivedSenderHandle)[0] ?? null,
        via: list(values.kMDItemUserSharedReceivedTransport)[0] ?? null, at: firstDate(values.kMDItemUserSharedReceivedDate) }
      : null,
  };
  const known = Object.values(facts).some((value) => (Array.isArray(value) ? value.length : value !== null));
  return known ? facts : null;
}

const firstDate = (value) => {
  const date = Array.isArray(value) ? value[0] : value;
  return typeof date === 'string' && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null;
};

/** The download addresses kept on the file itself, for a file Spotlight does not index. */
function whereFromsAttribute(absolute, system) {
  const hex = system.run('xattr', ['-px', 'com.apple.metadata:kMDItemWhereFroms', absolute]);
  if (!hex) return [];
  const bytes = Buffer.from(hex.replace(/\s+/g, ''), 'hex');
  const xml = system.run('plutil', ['-convert', 'xml1', '-o', '-', '-'], { input: bytes });
  const value = parsePlist(xml ?? '');
  return (Array.isArray(value) ? value : []).map(String).filter(Boolean);
}

/**
 * macOS's quarantine attribute ("0083;65a1b2c3;Safari;…"): the app that
 * downloaded or wrote the file and when, and whether it came from a
 * download (the attribute's first flag).
 */
export function quarantineMark(value) {
  const parts = String(value ?? '').trim().split(';');
  if (parts.length < 3 || !/^[0-9a-f]+$/i.test(parts[0])) return null;
  const flags = Number.parseInt(parts[0], 16);
  const seconds = Number.parseInt(parts[1], 16);
  return {
    app: parts[2] || null,
    at: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null,
    downloaded: (flags & 0x1) === 0x1,
  };
}

/** The address Windows keeps on a downloaded file (its Zone.Identifier stream). */
function zoneIdentifier(absolute) {
  try {
    const text = fs.readFileSync(`${absolute}:Zone.Identifier`, 'utf8');
    const value = (name) => text.match(new RegExp(`^${name}=(.*)$`, 'mi'))?.[1]?.trim() ?? null;
    return { host: value('HostUrl'), referrer: value('ReferrerUrl'), zone: value('ZoneId') };
  } catch {
    return null;
  }
}

// ── copies and names ─────────────────────────────────────────────────────

export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    let read;
    while ((read = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

/**
 * Other files on this Mac with exactly these bytes: Spotlight lists the
 * files of the same size, and each is hashed. A file kept only in iCloud
 * is skipped, since reading it would download it. Oldest first.
 */
export function copiesOf(absolute, { size, hash, system = SYSTEM } = {}) {
  if (!hasSpotlight(system) || !size) return { copies: [], checked: 0 };
  const candidates = spotlightFind(system, [`kMDItemFSSize == ${size}`]).filter((hit) => hit !== absolute);
  const copies = [];
  let checked = 0;
  let hashedBytes = 0;
  for (const candidate of candidates) {
    if (checked >= MAX_COPY_CANDIDATES || hashedBytes + size > MAX_COPY_BYTES) break;
    const stats = statOf(candidate);
    if (!stats?.isFile() || stats.size !== size || (stats.blocks === 0 && size > 0)) continue;
    checked += 1;
    hashedBytes += size;
    let same = false;
    try { same = sha256File(candidate) === hash; } catch { same = false; }
    if (!same) continue;
    const spotlight = spotlightBrief(candidate, system);
    copies.push({ path: candidate, created: stats.birthtimeMs > 0 ? stats.birthtime.toISOString() : null,
      modified: stats.mtime.toISOString(), addedAt: spotlight.addedAt, whereFrom: spotlight.whereFrom });
  }
  copies.sort((a, b) => String(a.addedAt ?? a.created ?? '').localeCompare(String(b.addedAt ?? b.created ?? '')));
  return { copies, checked, more: candidates.length > checked };
}

/** When a copy arrived and from where, for listing it. */
function spotlightBrief(absolute, system) {
  const values = parsePlist(system.run('mdls', ['-plist', '-', '-name', 'kMDItemDateAdded', '-name', 'kMDItemWhereFroms', absolute]) ?? '') ?? {};
  return { addedAt: firstDate(values.kMDItemDateAdded), whereFrom: Array.isArray(values.kMDItemWhereFroms) ? values.kMDItemWhereFroms.map(String) : [] };
}

/**
 * Files whose names extend this one's or that this one's extends
 * ("model.xlsx" and "model-final.xlsx", "clip.mov" and "clip_rotated.mov"),
 * found by Spotlight. These are names only; nothing says one was made from
 * the other.
 */
export function namesLike(absolute, { system = SYSTEM, exclude = [] } = {}) {
  if (!hasSpotlight(system)) return [];
  const stem = stemOf(absolute);
  if (stem.length < 3) return [];
  // The name up to its last separator finds both its shorter forms and its longer ones.
  const cut = stem.search(/[\s._-][^\s._-]*$/);
  const query = cut >= 4 ? stem.slice(0, cut) : stem;
  const skip = new Set([absolute, ...exclude]);
  const mine = stem.toLowerCase();
  const found = [];
  for (const hit of spotlightFind(system, ['-name', query]).slice(0, 400)) {
    if (skip.has(hit) || /\/(\.Trash|Library\/Caches|node_modules|\.git)\//.test(hit)) continue;
    const theirs = stemOf(hit).toLowerCase();
    const related = theirs === mine || (mine.startsWith(theirs) && /^[\s._-]/.test(mine.slice(theirs.length)))
      || (theirs.startsWith(mine) && /^[\s._-]/.test(theirs.slice(mine.length)));
    if (!related) continue;
    const stats = statOf(hit);
    if (!stats?.isFile()) continue;
    found.push({ path: hit, size: stats.size, modified: stats.mtime.toISOString(),
      created: stats.birthtimeMs > 0 ? stats.birthtime.toISOString() : null, shorter: mine.startsWith(theirs) && theirs !== mine });
  }
  return found.sort((a, b) => Number(b.shorter) - Number(a.shorter) || b.modified.localeCompare(a.modified)).slice(0, MAX_NAMES_LIKE);
}

const stemOf = (file) => path.basename(file).replace(/\.[^.]+$/, '');

// ── property lists ───────────────────────────────────────────────────────

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (text) => text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, name) => (name[0] === '#'
  ? String.fromCodePoint(name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1)))
  : ENTITIES[name.toLowerCase()]));

/** An XML property list (what `mdls -plist` and `plutil` write) as plain values; null when there is none. */
export function parsePlist(xml) {
  const text = String(xml ?? '');
  const tag = /<(\/?)(dict|array|key|string|date|integer|real|data|true|false)\b[^>]*?(\/?)>/g;
  const stack = [];
  let root = null;
  let seen = false;
  const add = (value) => {
    const top = stack.at(-1);
    if (!top) { root = value; seen = true; return; }
    if (Array.isArray(top.value)) top.value.push(value);
    else if (top.key !== null) { top.value[top.key] = value; top.key = null; }
  };
  let match;
  while ((match = tag.exec(text))) {
    const [, closing, name, selfClosing] = match;
    if (name === 'dict' || name === 'array') {
      if (selfClosing) add(name === 'dict' ? {} : []);
      else if (closing) { const done = stack.pop(); if (done) add(done.value); }
      else stack.push({ value: name === 'dict' ? {} : [], key: null });
      continue;
    }
    if (name === 'true' || name === 'false') { if (!closing) add(name === 'true'); continue; }
    if (closing) continue;
    let raw = '';
    if (!selfClosing) {
      const end = text.indexOf(`</${name}>`, tag.lastIndex);
      if (end < 0) break;
      raw = decode(text.slice(tag.lastIndex, end));
      tag.lastIndex = end + name.length + 3;
    }
    if (name === 'key') { if (stack.at(-1)) stack.at(-1).key = raw; continue; }
    add(name === 'integer' || name === 'real' ? Number(raw) : name === 'date' ? new Date(raw).toISOString() : raw);
  }
  return seen ? root : null;
}
