import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export class BlobStore {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }

  pathFor(hash) {
    return path.join(this.root, hash.slice(0, 2), hash.slice(2));
  }

  put(buffer) {
    const hash = hashBuffer(buffer);
    const destination = this.pathFor(hash);
    if (!fs.existsSync(destination)) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporary, buffer, { flag: 'wx' });
      try {
        fs.renameSync(temporary, destination);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        fs.rmSync(temporary, { force: true });
      }
    }
    return hash;
  }

  get(hash) {
    return fs.readFileSync(this.pathFor(hash));
  }

  has(hash) {
    return fs.existsSync(this.pathFor(hash));
  }
}
