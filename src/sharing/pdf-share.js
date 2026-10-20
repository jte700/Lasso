import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const bundled = fileURLToPath(new URL('../../scripts/render-shared-pdf', import.meta.url));
const helper = fileURLToPath(new URL('../../scripts/render-shared-pdf.swift', import.meta.url));
let executablePromise;
const cache = new Map();
let cachedBytes = 0;
const MAX_CACHED_BYTES = 48 * 1024 * 1024;

async function executable() {
  if (fs.existsSync(bundled)) return bundled;
  if (process.platform !== 'darwin') throw new Error('Visual PDF sharing requires the local PDF renderer.');
  executablePromise ??= (async () => {
    const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lasso-pdf-share-helper-'));
    process.once('exit', () => { try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* cleanup */ } });
    const target = path.join(temporary, 'render-shared-pdf');
    await execute('/usr/bin/swiftc', ['-O', '-module-cache-path', path.join(os.tmpdir(), 'lasso-swift-module-cache'),
      '-framework', 'PDFKit', '-framework', 'AppKit', helper, '-o', target], { timeout: 60_000, maxBuffer: 1_000_000 });
    return target;
  })();
  return executablePromise;
}

export function pdfShareRequest(resolved) {
  if (!/\.pdf$/i.test(resolved.internal.filePath)) return null;
  if (resolved.share.accessScope === 'REDACTED') {
    const masks = resolved.share.redactions ?? [];
    return masks.length && masks.every(mask => mask.kind === 'PDF')
      ? { mode: 'REDACTED', regions: masks } : null;
  }
  if (resolved.share.accessScope !== 'INDEXED') return null;
  const excerpt = resolved.share.excerpt;
  if (excerpt?.kind === 'PDF') return { mode: 'INDEXED', regions: excerpt.regions ?? [], text: excerpt.text ?? '',
    page: excerpt.page ?? undefined };
  const { anchor = {}, metadata = {} } = resolved.source;
  const text = String(anchor.selectedText ?? (metadata.componentType === 'PDF_EXCERPT' ? metadata.rawText : '') ?? '').trim();
  return text ? { mode: 'INDEXED', regions: [], text,
    page: Math.max(1, Number(anchor.pageNumber ?? metadata.pageNumber) || 1) } : null;
}

export async function buildSafePdf(content, request) {
  if (!Buffer.isBuffer(content) || !request) return null;
  const key = crypto.createHash('sha256').update(content).update(JSON.stringify(request)).digest('hex');
  if (cache.has(key)) return cache.get(key).promise;
  const entry = { promise: null, size: 0 };
  const task = (async () => {
    const renderer = await executable();
    const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lasso-safe-pdf-'));
    try {
      const input = path.join(temporary, 'input.pdf'), options = path.join(temporary, 'selection.json'), output = path.join(temporary, 'shared.pdf');
      await Promise.all([fs.promises.writeFile(input, content, { mode: 0o600 }),
        fs.promises.writeFile(options, JSON.stringify(request), { mode: 0o600 })]);
      await execute(renderer, [input, options, output], { timeout: 60_000, maxBuffer: 1_000_000 });
      const result = await fs.promises.readFile(output);
      if (!result.subarray(0, 5).equals(Buffer.from('%PDF-')) || result.length > 64 * 1024 * 1024) throw new Error('Invalid generated PDF.');
      return result;
    } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
  })();
  entry.promise = task;
  cache.set(key, entry);
  try {
    const result = await task;
    entry.size = result.length;
    cachedBytes += result.length;
    // Eviction is synchronous. Awaiting another render here lets concurrent
    // completions remove/count the same entry twice and defeats the byte cap.
    for (const [oldest, value] of cache) {
      if (cache.size <= 16 && cachedBytes <= MAX_CACHED_BYTES) break;
      if (!value.size) continue;
      cachedBytes -= value.size;
      cache.delete(oldest);
    }
    return result;
  } catch (error) { cache.delete(key); throw error; }
}
