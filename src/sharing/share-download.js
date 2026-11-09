import path from 'node:path';
import { writeZip } from '../dependencies/zip-archive.js';
import { sharedDrawingSvg } from './shared-drawing.js';

export function isInferredProfile(source) {
  return source.objectType === 'DATASET_COLUMN'
    || /;\s*inferred (?:numeric|categorical|text) variable\b/i.test(source.valueText ?? '');
}

// Only fields already permitted on the public page belong in a text excerpt.
// Full text extraction, private metadata and filesystem paths never enter it.
export function recipientExcerptText(source) {
  return isInferredProfile(source) ? '' : String(source.valueText ?? '').trim();
}

export function shareDownloadOptions(resolved, preview, document) {
  const redacted = resolved.share.accessScope === 'REDACTED';
  // A failed PDF crop must never fall back to a different indexed passage or
  // source summary. Only renderer-produced pixels can fulfill a PDF excerpt.
  const safePdf = document?.kind === 'pdf' && document.safe === true && Buffer.isBuffer(document.content);
  if (resolved.share.accessScope === 'INDEXED' && /\.pdf$/i.test(resolved.source.filename) && !safePdf) return null;
  // Only the drawn copy is a marked copy; it never falls back to the cited text.
  if (resolved.share.accessScope === 'MARKED' && !safePdf) return null;
  let type, format;
  if (document?.kind === 'pdf' && document.safe === true && Buffer.isBuffer(document.content)) {
    type = 'pdf'; format = 'PDF';
  } else if (resolved.share.accessScope === 'INDEXED' && document?.citedSlide === true && typeof document.slideFile === 'function') {
    // The one slide as a deck of its own, opened in PowerPoint or Keynote as it looks.
    return { type: 'slide', format: 'PPTX', label: 'Download slide' };
  } else if (redacted) {
    if (document?.kind === 'table' && document.sheets?.length) {
      type = 'sheets'; format = document.sheets.length > 1 ? 'ZIP' : 'CSV';
    } else if (document?.kind === 'text' && document.blocks?.length) {
      type = 'blocks'; format = document.format === 'markdown' ? 'MD' : 'TXT';
    } else if (document?.kind === 'model-plan' && document.redacted === true) {
      type = 'drawing'; format = 'SVG';
    }
  } else if (preview?.headers?.length && preview.rows?.length) {
    type = 'table'; format = 'CSV';
  } else if (document?.kind === 'model-plan' && (resolved.share.accessScope !== 'INDEXED' || document.citedPart === true)) {
    type = 'drawing'; format = 'SVG';
  } else if (recipientExcerptText(resolved.source)) {
    type = 'text'; format = 'TXT';
  }
  const label = redacted ? 'Download redacted copy' : resolved.share.accessScope === 'MARKED' ? 'Download marked copy' : 'Download excerpt';
  return type ? { type, format, label } : null;
}

function safeStem(value) {
  return path.basename(String(value ?? '').replaceAll('\\', '/'), path.extname(String(value ?? '')))
    .replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^\.+/, '').slice(0, 100) || 'source';
}

function csv(rows) {
  const cell = value => {
    let text = String(value ?? '');
    // Preserve ordinary negative numbers. Other spreadsheet formula prefixes
    // are quoted as text before the file reaches Excel or another spreadsheet.
    if (/^[\x00-\x20\uFEFF]*[=+@-]/u.test(text)
      && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return Buffer.from(`\uFEFF${rows.map(row => row.map(cell).join(',')).join('\r\n')}\r\n`, 'utf8');
}

export function downloadDisposition(filename) {
  const clean = String(filename).replaceAll('\\', '/').split('/').at(-1)
    .replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || 'source';
  const fallback = clean.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(clean).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return fallback === clean ? `attachment; filename="${fallback}"`
    : `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function buildShareDownload(resolved, preview, document) {
  const options = shareDownloadOptions(resolved, preview, document);
  if (!options) return null;
  const redactions = resolved.share.accessScope === 'REDACTED' ? resolved.share.redactions ?? [] : [];
  const maskFor = (kind, coordinates) => redactions.some(mask => mask.kind === kind
    && Object.entries(coordinates).every(([key, value]) => (key === 'sheet' ? mask[key] ?? 0 : mask[key]) === value));
  let content;
  if (options.type === 'pdf') {
    content = document.content;
  } else if (options.type === 'slide') {
    content = document.slideFile();
    if (!content) return null;
  } else if (options.type === 'table') {
    content = csv([preview.headers, ...preview.rows.map(row => row.cells.map(cell => cell.value))]);
  } else if (options.type === 'sheets') {
    const entries = document.sheets.map((sheet, sheetIndex) => ({
      name: `${sheetIndex + 1}-${safeStem(sheet.name)}.csv`,
      content: csv(sheet.rows.map((row, rowIndex) => row.map((cell, column) =>
        maskFor('CELL', { sheet: sheetIndex, row: rowIndex, column }) ? '[Redacted]' : cell))),
    }));
    content = entries.length > 1 ? writeZip(entries) : entries[0].content;
  } else if (options.type === 'drawing') {
    const svg = sharedDrawingSvg(document, { requireRedacted: resolved.share.accessScope === 'REDACTED' });
    if (!svg) return null;
    content = Buffer.from(svg, 'utf8');
  } else {
    const text = options.type === 'blocks'
      ? document.blocks.map((block, index) => {
        const masked = maskFor('BLOCK', { block: index });
        // Adjacent visible list items stay one Markdown list. XML sections are its lines.
        const separator = index === 0 ? '' : document.format === 'lines' ? '\n'
          : document.styles?.[index]?.type === 'item' && document.styles[index - 1]?.type === 'item' && !masked
          && !maskFor('BLOCK', { block: index - 1 }) ? '\n' : '\n\n';
        return separator + (masked ? '[Redacted]' : block);
      }).join('')
      : recipientExcerptText(resolved.source);
    content = Buffer.from(`${text}\n`, 'utf8');
  }
  const version = Number.isSafeInteger(resolved.source.snapshotVersion) ? `-v${resolved.source.snapshotVersion}` : '';
  const suffix = resolved.share.accessScope === 'REDACTED' ? 'redacted' : resolved.share.accessScope === 'MARKED' ? 'marked' : options.type === 'slide' ? `slide-${document.slide}` : 'excerpt';
  const contentType = { PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', PDF: 'application/pdf', CSV: 'text/csv; charset=utf-8', ZIP: 'application/zip', TXT: 'text/plain; charset=utf-8', MD: 'text/markdown; charset=utf-8', SVG: 'image/svg+xml; charset=utf-8' }[options.format];
  return { ...options, content, contentType,
    filename: `${safeStem(resolved.source.filename)}-${suffix}${version}.${options.format.toLowerCase()}` };
}
