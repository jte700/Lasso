import path from 'node:path';
import { crc32 } from 'node:zlib';
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
  if (resolved.share.accessScope === 'INDEXED' && /\.pdf$/i.test(resolved.source.filename)
      && !(document?.kind === 'pdf' && document.safe === true && Buffer.isBuffer(document.content))) return null;
  let type, format;
  if (document?.kind === 'pdf' && document.safe === true && Buffer.isBuffer(document.content)) {
    type = 'pdf'; format = 'PDF';
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
  } else if (resolved.share.accessScope !== 'INDEXED' && document?.kind === 'model-plan') {
    type = 'drawing'; format = 'SVG';
  } else if (recipientExcerptText(resolved.source)) {
    type = 'text'; format = 'TXT';
  }
  return type ? { type, format, label: redacted ? 'Download redacted copy' : 'Download excerpt' } : null;
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

// Small dependency-free ZIP using the store method. Entry names are generated
// internally, so no source path or traversal component can enter the archive.
function zip(entries) {
  if (entries.length > 65535) throw new Error('Too many worksheets to export.');
  const files = [], directory = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const filename = Buffer.from(name, 'utf8'), checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0x21, 12); // 1980-01-01, no filesystem timestamps.
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(filename.length, 26);
    files.push(local, filename, content);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += local.length + filename.length + content.length;
  }
  const index = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, index, end]);
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
  } else if (options.type === 'table') {
    content = csv([preview.headers, ...preview.rows.map(row => row.cells.map(cell => cell.value))]);
  } else if (options.type === 'sheets') {
    const entries = document.sheets.map((sheet, sheetIndex) => ({
      name: `${sheetIndex + 1}-${safeStem(sheet.name)}.csv`,
      content: csv(sheet.rows.map((row, rowIndex) => row.map((cell, column) =>
        maskFor('CELL', { sheet: sheetIndex, row: rowIndex, column }) ? '[Redacted]' : cell))),
    }));
    content = entries.length > 1 ? zip(entries) : entries[0].content;
  } else if (options.type === 'drawing') {
    const svg = sharedDrawingSvg(document, { requireRedacted: resolved.share.accessScope === 'REDACTED' });
    if (!svg) return null;
    content = Buffer.from(svg, 'utf8');
  } else {
    const text = options.type === 'blocks'
      ? document.blocks.map((block, index) => {
        const masked = maskFor('BLOCK', { block: index });
        // Adjacent visible list items stay one Markdown list.
        const separator = index === 0 ? '' : document.styles?.[index]?.type === 'item'
          && document.styles[index - 1]?.type === 'item' && !masked
          && !maskFor('BLOCK', { block: index - 1 }) ? '\n' : '\n\n';
        return separator + (masked ? '[Redacted]' : block);
      }).join('')
      : recipientExcerptText(resolved.source);
    content = Buffer.from(`${text}\n`, 'utf8');
  }
  const version = Number.isSafeInteger(resolved.source.snapshotVersion) ? `-v${resolved.source.snapshotVersion}` : '';
  const suffix = resolved.share.accessScope === 'REDACTED' ? 'redacted' : 'excerpt';
  const contentType = { PDF: 'application/pdf', CSV: 'text/csv; charset=utf-8', ZIP: 'application/zip', TXT: 'text/plain; charset=utf-8', MD: 'text/markdown; charset=utf-8', SVG: 'image/svg+xml; charset=utf-8' }[options.format];
  return { ...options, content, contentType,
    filename: `${safeStem(resolved.source.filename)}-${suffix}${version}.${options.format.toLowerCase()}` };
}
