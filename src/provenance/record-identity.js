// Who this Lasso is when it writes an AI record into a document: the name
// shown on the other Mac (the Mac account's full name until someone changes
// it) and a signing key of its own, made the first time a record is written
// and kept beside the library. Also the choices about records: whether Lasso
// writes them at all, and whether prompts go in them (they stay out unless
// someone includes them, since a prompt can say more than the document does).

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FOLDER = 'ai-record';
const KEY_FILE = 'identity.json';
const SETTINGS_FILE = 'settings.json';
const LONGEST_NAME = 60;

export const DEFAULT_RECORD_SETTINGS = Object.freeze({ carry: true, includePrompts: false });

/** A short, stable name for a public key: the first 16 hex digits of its hash. */
export function fingerprintOf(publicKey) {
  return crypto.createHash('sha256').update(String(publicKey ?? '')).digest('hex').slice(0, 16);
}

/** Whether `signature` (base64) is `publicKey`'s (base64 SPKI) signature of `text`. */
export function verifySignature(text, signature, publicKey) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** The Mac account's full name, or the account's short name. */
function accountName() {
  if (process.platform === 'darwin') {
    try {
      const full = execFileSync('/usr/bin/id', ['-F'], { encoding: 'utf8', timeout: 1000 }).trim();
      if (full) return full;
    } catch { /* the short name stands in */ }
  }
  try { return os.userInfo().username; } catch { return 'Someone'; }
}

export class RecordIdentity {
  /** `dataDir` is the library; nothing is written there until a record is signed or a choice is saved. */
  constructor({ dataDir }) {
    this.folder = dataDir ? path.join(dataDir, FOLDER) : null;
    this.cachedKey = undefined;
    this.cachedName = null;
  }

  read(name) {
    if (!this.folder) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.folder, name), 'utf8')); } catch { return null; }
  }

  write(name, value, mode = 0o644) {
    fs.mkdirSync(this.folder, { recursive: true });
    const target = path.join(this.folder, name);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    fs.renameSync(temporary, target);
  }

  /** { name, carry, includePrompts, key }: key is this Lasso's fingerprint, or null before its first record. */
  settings() {
    const saved = this.read(SETTINGS_FILE) ?? {};
    return {
      name: typeof saved.name === 'string' && saved.name.trim() ? saved.name.trim() : this.defaultName(),
      carry: typeof saved.carry === 'boolean' ? saved.carry : DEFAULT_RECORD_SETTINGS.carry,
      includePrompts: typeof saved.includePrompts === 'boolean' ? saved.includePrompts : DEFAULT_RECORD_SETTINGS.includePrompts,
      key: this.ownKey()?.fingerprint ?? null,
    };
  }

  defaultName() {
    this.cachedName ??= accountName().slice(0, LONGEST_NAME);
    return this.cachedName;
  }

  /** Saves the choices given; an empty name goes back to the account's. */
  update(changes = {}) {
    if (!this.folder) throw new Error('Lasso has no library to keep these choices in.');
    const saved = this.read(SETTINGS_FILE) ?? {};
    if (typeof changes.name === 'string') saved.name = changes.name.trim().slice(0, LONGEST_NAME) || undefined;
    if (typeof changes.carry === 'boolean') saved.carry = changes.carry;
    if (typeof changes.includePrompts === 'boolean') saved.includePrompts = changes.includePrompts;
    this.write(SETTINGS_FILE, saved);
    return this.settings();
  }

  /** This Lasso's key as already made: { publicKey, fingerprint, privateKey }, or null. Never makes one. */
  ownKey() {
    if (this.cachedKey !== undefined) return this.cachedKey;
    const saved = this.read(KEY_FILE);
    this.cachedKey = saved?.publicKey && saved?.privateKey
      ? { publicKey: saved.publicKey, privateKey: saved.privateKey, fingerprint: fingerprintOf(saved.publicKey) }
      : null;
    return this.cachedKey;
  }

  /** This Lasso's key, made and kept the first time it is needed. */
  signingKey() {
    const known = this.ownKey();
    if (known) return known;
    if (!this.folder) throw new Error('Lasso has no library to keep its key in.');
    const pair = crypto.generateKeyPairSync('ed25519');
    const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const privateKey = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    this.write(KEY_FILE, { publicKey, privateKey, createdAt: new Date().toISOString() }, 0o600);
    this.cachedKey = undefined;
    return this.ownKey();
  }

  /** `text` signed with this Lasso's key: { publicKey, signature } in base64. */
  sign(text) {
    const key = this.signingKey();
    const privateKey = crypto.createPrivateKey({ key: Buffer.from(key.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
    return { publicKey: key.publicKey, signature: crypto.sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64') };
  }

  /** Who this Lasso is on a record: { name, key }. */
  signer() {
    return { name: this.settings().name, key: this.signingKey().fingerprint };
  }
}
