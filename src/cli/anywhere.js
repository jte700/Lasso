// Every provenance question answered for any file on disk, not only files
// in Lasso folders. Where Lasso has recorded a file, its history answers
// first; then the file and the system answer on the spot: what macOS keeps
// about it, what it says about itself, its copies, git, and other files to
// compare it with. Without a library on this Mac only the on-the-spot
// answers are given, and nothing is written anywhere.

import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../history/errors.js';
import { parseSince } from '../terminal/parser.js';
import { SYSTEM, copiesOf, hasSpotlight, locate, namesLike, systemFacts, unescapePath } from './disk-facts.js';
import { embeddedFacts, isOfficeFile, isWordFile, readZipParts, officeProperties } from './embedded-facts.js';
import { committedVersion, folderCommits, gitBlame, gitFacts } from './git-facts.js';
import { aiLabels } from './ai-facts.js';
import { compareBuffers, compareFiles, comparisonKind, filesBeside, sourceFiles, valuesFrom } from './compare.js';
import { MAX_VERIFY_NUMBERS, judgeClaim, numbersIn, readDocumentText, sha256File } from './provenance.js';
import { tilde, untilde } from './format.js';

const DAY = 86_400_000;
const LOG_DAYS = 14;
/** Entries a folder's log walks before it stops looking. */
const MAX_WALKED = 60_000;
const SKIPPED_FOLDERS = new Set(['node_modules', '__pycache__', 'Library', '.git', '.Trash']);
const PACKAGES = /\.(app|photoslibrary|bundle|framework|xcodeproj|xcworkspace|lproj|musiclibrary|tvlibrary|fcpbundle)$/i;

export class Anywhere {
  /**
   * @param {{ provenance?: import('./provenance.js').Provenance|null, system?: typeof SYSTEM, cwd?: string, now?: () => number }} options
   */
  constructor({ provenance = null, system = SYSTEM, cwd = process.cwd(), now = () => Date.now() } = {}) {
    this.provenance = provenance;
    this.system = system;
    this.cwd = cwd;
    this.now = now;
  }

  /** The Lasso folder file at a path, when Lasso has recorded it. */
  recordedAt(absolute) {
    const tracked = this.provenance?.trackedAt(absolute) ?? null;
    return tracked?.recorded ? tracked : null;
  }

  /**
   * The file a person means: a path on disk, a file in a Lasso folder named
   * by the end of its path, or a name Spotlight finds. { absolute, query,
   * recorded, found, others }.
   */
  find(target) {
    const raw = unescapePath(target);
    if (!raw) throw new HttpError(400, 'Name a file.');
    const direct = locate(raw, { cwd: this.cwd, system: this.system, spotlight: false });
    if (direct) return { absolute: direct.absolute, query: direct.absolute, recorded: this.recordedAt(direct.absolute), found: 'path', others: [] };
    if (this.provenance) {
      try {
        const { folder, file, absolute, others } = this.provenance.resolveFile(raw, { cwd: this.cwd });
        return { absolute, query: raw, recorded: { folder, path: file.path }, found: 'library',
          others: others.map((other) => `${other.folder}/${other.path}`) };
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    const found = locate(raw, { cwd: this.cwd, system: this.system });
    if (found) return { absolute: found.absolute, query: found.absolute, recorded: this.recordedAt(found.absolute), found: 'spotlight', others: found.others };
    const where = raw.includes('/') || !hasSpotlight(this.system) ? '' : ', and Spotlight finds no file by that name';
    throw new HttpError(404, `There is no file at ${raw}${where}.`);
  }

  // ── whence ─────────────────────────────────────────────────────────────

  /** Where a file came from: Lasso's record of its bytes, then what this Mac and the file itself say. */
  whence(target) {
    const found = this.find(target);
    const absolute = found.absolute;
    let stats;
    try { stats = fs.statSync(absolute); } catch { throw new HttpError(404, `${found.query} is in Lasso's record but no longer on disk.`); }
    if (!stats.isFile()) throw new HttpError(400, `${target} is a folder; whence reads one file.`);
    const hash = sha256File(absolute);
    const recorded = this.provenance ? this.provenance.whence(absolute, { hash })
      : { file: absolute, name: path.basename(absolute), size: stats.size, modifiedAt: stats.mtime.toISOString(), hash, matches: [], tracked: null, sameName: [] };
    const copies = copiesOf(absolute, { size: stats.size, hash, system: this.system });
    // What AIs wrote of the version Lasso holds, and whether that is still the one on disk.
    const tracked = recorded.tracked?.recorded ? recorded.tracked : null;
    const share = tracked ? this.provenance.aiShare(tracked.folder.id, tracked.path) : null;
    return {
      ...recorded,
      ai: share ? { ...share, current: tracked.recordedHash === hash } : null,
      aiLabels: aiLabels(absolute),
      library: Boolean(this.provenance),
      found: found.found,
      others: found.others,
      system: systemFacts(absolute, { system: this.system, stats }),
      embedded: embeddedFacts(absolute),
      git: gitFacts(absolute, { system: this.system }),
      copies,
      names: namesLike(absolute, { system: this.system, exclude: copies.copies.map((copy) => copy.path) }),
    };
  }

  // ── blame ──────────────────────────────────────────────────────────────

  /**
   * Who wrote what in a file: Lasso's record for a file in its folders;
   * otherwise `git blame` for text in a repository, or a Word document's
   * tracked changes and comments; otherwise what the file says of its authors.
   */
  blame(target, options = {}) {
    const found = this.find(target);
    if (found.recorded && this.provenance) return { kind: 'library', ...this.provenance.blame(found.query, { cwd: this.cwd, ...options }) };
    const absolute = found.absolute;
    const base = { file: absolute, name: path.basename(absolute), shown: tilde(absolute) };
    if (isWordFile(absolute)) {
      const facts = embeddedFacts(absolute);
      if (facts.tracked) return { kind: 'word', ...base, tracked: facts.tracked, properties: facts.properties };
    }
    if (comparisonKind(absolute) === 'text') {
      const blame = gitBlame(absolute, { system: this.system });
      if (blame) return { kind: 'git', ...base, ...blame };
    }
    const facts = embeddedFacts(absolute);
    return { kind: 'none', ...base, properties: facts.properties, pdf: facts.pdf, git: gitFacts(absolute, { system: this.system }),
      inLibrary: Boolean(this.provenance), aiLabels: aiLabels(absolute) };
  }

  // ── diff ───────────────────────────────────────────────────────────────

  /**
   * What changed: two files compared on the spot; a Lasso folder file's
   * recorded change; or a file in git against its last commit.
   */
  diff(words, { version = null } = {}) {
    const list = (Array.isArray(words) ? words : [words]).map(String);
    const pair = this.pairOf(list);
    if (pair) return { kind: 'compare', ...compareFiles(pair[0], pair[1]) };
    const found = this.find(list.join(' '));
    if (found.recorded && this.provenance) return { kind: 'library', ...this.provenance.diff(found.query, { cwd: this.cwd, version }) };
    const absolute = found.absolute;
    const name = path.basename(absolute);
    if (version !== null && version !== undefined) {
      throw new HttpError(400, `Versions come from Lasso's record, and ${name} is not in a Lasso folder.`);
    }
    const committed = comparisonKind(absolute) === 'bytes' ? null : committedVersion(absolute, { system: this.system });
    if (committed) {
      return { kind: 'git', file: absolute, name, shown: tilde(absolute), commit: committed.commit, newer: committed.newer,
        state: committed.state, ...compareBuffers(committed.bytes, fs.readFileSync(absolute), absolute) };
    }
    throw new HttpError(404, `Lasso has no earlier version of ${name}: it is in no Lasso folder and no git repository. `
      + `Compare it with another file: /diff ${quoted(tilde(absolute))} <other file>`);
  }

  /** Two existing files in the words typed, however the words split ("a b.xlsx c.xlsx"); null for one. */
  pairOf(words) {
    if (words.length < 2) return null;
    const file = (text) => locate(text, { cwd: this.cwd, system: this.system, spotlight: false })?.absolute ?? null;
    if (file(words.join(' '))) return null;
    for (let split = 1; split < words.length; split += 1) {
      const first = file(words.slice(0, split).join(' '));
      const second = first && file(words.slice(split).join(' '));
      if (first && second) return [first, second];
    }
    return null;
  }

  // ── verify ─────────────────────────────────────────────────────────────

  /**
   * A document's numbers checked against sources: files named with
   * `against`; otherwise the library's folders; otherwise, with no library,
   * the spreadsheets beside the document.
   */
  verify(target, { against = null } = {}) {
    const found = this.find(target);
    const absolute = found.absolute;
    const hasFolders = Boolean(this.provenance?.folders().length);
    if (!against && hasFolders) return { mode: 'library', ...this.provenance.verify(absolute, { cwd: this.cwd }) };
    const named = against ? path.resolve(this.cwd, untilde(unescapePath(against))) : null;
    const files = named ? sourceFiles(named, { cwd: this.cwd, document: absolute }) : filesBeside(absolute);
    let text;
    try { text = readDocumentText(absolute); } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(404, `Lasso cannot read ${target}: ${error.message}`);
    }
    const claims = numbersIn(text).slice(0, MAX_VERIFY_NUMBERS);
    const { index, read } = valuesFrom(files, new Set(claims.map((claim) => claim.key)));
    const results = claims.map((claim) => judgeClaim(claim, index));
    const tally = { current: 0, stale: 0, ambiguous: 0, unsourced: 0 };
    for (const result of results) tally[result.status] += 1;
    return { mode: 'files', file: absolute, name: path.basename(absolute), numbers: claims.length, tally, results, sources: read,
      against: named ? tilde(named) : null, beside: !named ? tilde(path.dirname(absolute)) : null };
  }

  // ── log ────────────────────────────────────────────────────────────────

  /** Changes in a folder on disk: Lasso's record when it is (in) a Lasso folder, else the files' own dates. */
  log(target, options = {}) {
    const folder = path.resolve(this.cwd, untilde(unescapePath(target || '.')));
    const library = this.provenance?.folders().find((entry) => folder === entry.rootPath || folder.startsWith(`${entry.rootPath}${path.sep}`));
    if (library) {
      const inside = path.relative(library.rootPath, folder).split(path.sep).join('/');
      return { kind: 'library', ...this.provenance.log({ ...options, folder: library.name, file: inside ? `${inside}/` : null }) };
    }
    return { kind: 'folder', ...this.folderLog(folder, options) };
  }

  /**
   * What changed lately in any folder on disk, read from the files' own
   * dates: newest first, who saved an Office file last, and the folder's
   * git commits when it is in a repository.
   */
  folderLog(target = '.', { since = null, limit = 40 } = {}) {
    const folder = path.resolve(this.cwd, untilde(unescapePath(target || '.')));
    let stats;
    try { stats = fs.statSync(folder); } catch { throw new HttpError(404, `There is no folder at ${target}.`); }
    if (!stats.isDirectory()) throw new HttpError(400, `${target} is a file. /whence ${quoted(target)} says where it came from.`);
    const now = this.now();
    const from = since ? parseSince(since, now) : now - LOG_DAYS * DAY;
    if (since && from === null) throw new HttpError(400, `Lasso cannot read "${since}" as a time. Try 2h, 3d, 1w, today or yesterday.`);
    const found = [];
    let walked = 0;
    const visit = (directory, depth) => {
      let entries;
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (walked >= MAX_WALKED) return;
        walked += 1;
        if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_FOLDERS.has(entry.name) && !PACKAGES.test(entry.name) && depth < 12) visit(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        let fileStats;
        try { fileStats = fs.statSync(full); } catch { continue; }
        if (fileStats.mtimeMs < from) continue;
        const born = fileStats.birthtimeMs > 0 ? fileStats.birthtimeMs : null;
        found.push({ path: path.relative(folder, full).split(path.sep).join('/'), absolute: full, at: fileStats.mtime.toISOString(),
          change: born && born >= from && Math.abs(fileStats.mtimeMs - born) < 2000 ? 'added' : 'edited', size: fileStats.size });
      }
    };
    visit(folder, 0);
    found.sort((a, b) => b.at.localeCompare(a.at));
    const entries = found.slice(0, limit).map(({ absolute, ...entry }) => {
      if (!isOfficeFile(absolute)) return entry;
      const parts = readZipParts(absolute, ['docProps/core.xml']);
      const savedBy = parts ? officeProperties(parts.get('docProps/core.xml'), null)?.lastSavedBy ?? null : null;
      return savedBy ? { ...entry, savedBy } : entry;
    });
    return { folder: tilde(folder), from: new Date(from).toISOString(), days: since ? null : LOG_DAYS, total: found.length,
      truncated: found.length > limit, complete: walked < MAX_WALKED, entries, commits: this.folderCommits(folder, from) };
  }

  /** A folder's commits since a time, when it is in a git repository. */
  folderCommits(folder, from) {
    return folderCommits(folder, from, { system: this.system });
  }
}

const quoted = (text) => (/\s/.test(text) ? `"${text}"` : text);
