import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execute, renderCache, swiftHelper } from './swift-helper.js';

const executable = swiftHelper('render-shared-pdf', ['PDFKit', 'AppKit'], 'Visual PDF sharing requires the local PDF renderer.');
const cached = renderCache({ entries: 16, bytes: 48 * 1024 * 1024 });
const RENDER_TIMEOUT_MS = 60_000;
const MAX_PDF_BYTES = 64 * 1024 * 1024;

/** A rendered file is used only when it is a PDF of a sane size. */
export function checkedPdf(content) {
  if (!content.subarray(0, 5).equals(Buffer.from('%PDF-')) || content.length > MAX_PDF_BYTES) throw new Error('Invalid generated PDF.');
  return content;
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

/** A marked copy: the pen, marker and highlighter strokes drawn on the document's pages. */
export function markedPdfRequest(resolved) {
  return resolved.share.accessScope === 'MARKED' ? { mode: 'MARKED', strokes: resolved.share.redactions ?? [] } : null;
}

export async function buildSafePdf(content, request) {
  if (!Buffer.isBuffer(content) || !request) return null;
  const key = crypto.createHash('sha256').update(content).update(JSON.stringify(request)).digest('hex');
  return cached(key, async () => {
    const renderer = await executable();
    const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lasso-safe-pdf-'));
    try {
      const input = path.join(temporary, 'input.pdf'), options = path.join(temporary, 'selection.json'), output = path.join(temporary, 'shared.pdf');
      await Promise.all([fs.promises.writeFile(input, content, { mode: 0o600 }),
        fs.promises.writeFile(options, JSON.stringify(request), { mode: 0o600 })]);
      await execute(renderer, [input, options, output], { timeout: RENDER_TIMEOUT_MS, maxBuffer: 1_000_000 });
      return checkedPdf(await fs.promises.readFile(output));
    } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
  });
}
