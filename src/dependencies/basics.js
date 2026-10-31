// Small helpers every dependency module shares: ids, timestamps, hashes and paths.

import path from 'node:path';
import crypto from 'node:crypto';

export function id() { return crypto.randomUUID(); }
export function now() { return new Date().toISOString(); }
export function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
export function posixPath(value) { return String(value).split(path.sep).join('/'); }
