// Reading and writing the zip archives Office files are made of. Entries are
// listed once from the central directory, inflated only when asked for, and
// copied into a new archive still compressed when nothing in them changes.
import { crc32, inflateRawSync } from 'node:zlib';

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;
// The end record sits in the last 22 bytes plus a comment of up to 64 KiB.
const END_SEARCH_BYTES = 65_557;
const STORED = 0;
const DEFLATED = 8;
const UTF8_NAMES = 0x800;
// 1980-01-01 00:00: archives Lasso writes carry no filesystem timestamps.
const DOS_DATE = 0x21;

/**
 * Every entry of an archive by name: its compression method, its stored
 * bytes, and the checksum and size of its contents. Null when the buffer is
 * not a zip archive Lasso can read, such as a password-protected Office file.
 * @param {Buffer} buffer
 * @returns {Map<string, { name: string, method: number, compressed: Buffer, crc: number, size: number }> | null}
 */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return null;
  const minimum = Math.max(0, buffer.length - END_SEARCH_BYTES);
  let end = -1;
  for (let index = buffer.length - 22; index >= minimum; index -= 1) {
    if (buffer.readUInt32LE(index) === END_OF_DIRECTORY) { end = index; break; }
  }
  if (end < 0) return null;
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let entry = 0; entry < count; entry += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== DIRECTORY_ENTRY) return null;
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_ENTRY) continue;
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    if (start + compressedSize > buffer.length) continue;
    entries.set(name, { name, method, compressed: buffer.subarray(start, start + compressedSize), crc, size });
  }
  return entries;
}

/**
 * An entry's contents, or null when it is missing, larger than `limit` or
 * compressed in a way Lasso does not read.
 */
export function zipBytes(entry, limit) {
  if (!entry || entry.size > limit) return null;
  if (entry.method === STORED) return entry.compressed;
  if (entry.method === DEFLATED) return inflateRawSync(entry.compressed, { maxOutputLength: limit });
  return null;
}

/**
 * A new archive. Each entry is `{ name, content }`, stored as given, or an
 * entry read by readZip, copied with its compressed bytes untouched.
 * @param {Array<{ name: string, content?: Buffer, method?: number, compressed?: Buffer, crc?: number, size?: number }>} entries
 * @returns {Buffer}
 */
export function writeZip(entries) {
  if (entries.length > 65_535) throw new Error('Too many files for one archive.');
  const files = [];
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    const copied = !entry.content;
    const data = copied ? entry.compressed : entry.content;
    const method = copied ? entry.method : STORED;
    const checksum = copied ? entry.crc : crc32(data);
    const size = copied ? entry.size : data.length;
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_ENTRY, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    files.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(DIRECTORY_ENTRY, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAMES, 8); central.writeUInt16LE(method, 10); central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const index = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_DIRECTORY, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, index, end]);
}
