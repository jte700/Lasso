// A snapshot's search index on disk. Building one reads every version row of
// a large folder, which takes seconds; reading it back takes a moment, at
// launch and after the idle server gave its caches up. Like the other derived
// stores, a missing or unreadable file is simply built again.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Postings, SEARCH_INDEX_VERSION, SnapshotSearchIndex } from './search-index.js';

const MAGIC = 'LSIX';
const LEAD_BYTES = 8;
const COLUMNS = { rowids: Float64Array, numberOf: Float64Array, typeOf: Uint8Array, flags: Uint8Array,
  pathOf: Int32Array, nameOf: Int32Array, nameOffsets: Int32Array, namePositions: Int32Array };
const POSTINGS = ['own', 'text', 'keys'];

export class SearchIndexStore {
  constructor(directory) {
    this.directory = directory;
  }

  pathFor(projectId, snapshotId) {
    return path.join(this.directory, `${projectId}.${snapshotId}.idx`);
  }

  /** Writes an index, and drops the ones kept for the folder's earlier snapshots. */
  save(index) {
    const arrays = [...Object.keys(COLUMNS).map((name) => index[name]),
      ...POSTINGS.flatMap((name) => [index[name].offsets, index[name].positions])];
    const header = Buffer.from(JSON.stringify({
      version: SEARCH_INDEX_VERSION, projectId: index.projectId, snapshotId: index.snapshotId,
      snapshotVersion: index.snapshotVersion, objectCount: index.objectCount,
      paths: index.paths, pathWords: index.pathWords, variables: index.variables, parts: index.parts,
      tokens: Object.fromEntries(POSTINGS.map((name) => [name, index[name].tokens])),
      sections: arrays.map((array) => array.byteLength),
    }));
    const lead = Buffer.alloc(LEAD_BYTES);
    lead.write(MAGIC, 0, 'latin1');
    lead.writeUInt32LE(header.length, MAGIC.length);
    const destination = this.pathFor(index.projectId, index.snapshotId);
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, Buffer.concat([lead, header,
        ...arrays.map((array) => Buffer.from(array.buffer, array.byteOffset, array.byteLength))]));
      fs.renameSync(temporary, destination);
      this.remove(index.projectId, { keep: index.snapshotId });
    } catch { /* Not kept: it is built from the version rows again next time. */ }
  }

  /** The kept index of a snapshot that has `objectCount` objects now, or null. */
  load(projectId, snapshotId, objectCount) {
    let buffer;
    try { buffer = fs.readFileSync(this.pathFor(projectId, snapshotId)); } catch { return null; }
    try {
      if (buffer.toString('latin1', 0, MAGIC.length) !== MAGIC) return null;
      const headerEnd = LEAD_BYTES + buffer.readUInt32LE(MAGIC.length);
      const header = JSON.parse(buffer.toString('utf8', LEAD_BYTES, headerEnd));
      // A snapshot only gains objects after its index is kept: a large table's
      // later rows, recorded when first offered and found through the table
      // index each time. One with fewer than were kept is not this library's.
      if (header.version !== SEARCH_INDEX_VERSION || header.snapshotId !== snapshotId
        || header.objectCount > objectCount) return null;
      const kinds = [...Object.values(COLUMNS), ...POSTINGS.flatMap(() => [Int32Array, Int32Array])];
      let offset = headerEnd;
      const arrays = header.sections.map((bytes, section) => {
        const start = buffer.byteOffset + offset;
        offset += bytes;
        // Copied, so each column is aligned and the file's buffer is let go.
        return new kinds[section](buffer.buffer.slice(start, start + bytes));
      });
      if (offset !== buffer.length) return null;
      const columns = Object.fromEntries(Object.keys(COLUMNS).map((name, at) => [name, arrays[at]]));
      const postings = Object.fromEntries(POSTINGS.map((name, at) => {
        const first = Object.keys(COLUMNS).length + at * 2;
        return [name, new Postings(header.tokens[name], arrays[first], arrays[first + 1])];
      }));
      return new SnapshotSearchIndex({
        projectId, snapshotId, snapshotVersion: header.snapshotVersion, objectCount: header.objectCount,
        ...columns, ...postings, paths: header.paths, pathWords: header.pathWords, variables: header.variables,
        parts: header.parts,
      });
    } catch {
      return null;
    }
  }

  /** Removes a folder's kept indexes, all of them or all but one snapshot's. */
  remove(projectId, { keep = null, only = null } = {}) {
    let entries = [];
    try { entries = fs.readdirSync(this.directory); } catch { return; }
    for (const entry of entries) {
      if (!entry.startsWith(`${projectId}.`) || entry === `${projectId}.${keep}.idx`) continue;
      if (only && entry !== `${projectId}.${only}.idx`) continue;
      fs.rmSync(path.join(this.directory, entry), { force: true });
    }
  }
}
