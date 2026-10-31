// The other formats a recipient may download a share in: a slide as a
// picture, a PDF as a Word document and a Word document as a PDF. Each is made
// from exactly what the recipient may already download, the excerpt or, when
// the whole document is shared, the original, so no format discloses more.
import path from 'node:path';
import { isPresentationPath } from '../dependencies/presentation-extraction.js';
import { buildPagePdf } from './document-pages.js';
import { shareDownloadOptions } from './share-download.js';
import { pdfToWord } from './word-conversion.js';

export const CONVERTED_TYPES = {
  JPEG: { extension: 'jpg', contentType: 'image/jpeg' },
  DOCX: { extension: 'docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  PDF: { extension: 'pdf', contentType: 'application/pdf' },
};
const FORMAT_NAMES = { jpg: 'JPEG', jpeg: 'JPEG', docx: 'DOCX', word: 'DOCX', pdf: 'PDF' };

/**
 * The format a recipient asked for (`?as=jpg`), or null for one Lasso does not make.
 * @param {string|null|undefined} value
 * @returns {'JPEG'|'DOCX'|'PDF'|null}
 */
export function conversionFormat(value) {
  return FORMAT_NAMES[String(value ?? '').toLowerCase()] ?? null;
}

/**
 * The conversions this share offers: of the excerpt download or the original.
 * @returns {{of: 'excerpt'|'original', format: 'JPEG'|'DOCX'|'PDF', label: string}[]}
 */
export function shareConversions(resolved, preview, document) {
  const excerpt = shareDownloadOptions(resolved, preview, document);
  const filename = String(resolved.source.filename ?? '');
  const whole = resolved.share.accessScope === 'DOCUMENT';
  const pictured = typeof document?.slidePicture === 'function';
  return [
    excerpt?.type === 'slide' && pictured && { of: 'excerpt', format: 'JPEG', label: excerpt.label },
    excerpt?.type === 'pdf' && { of: 'excerpt', format: 'DOCX', label: excerpt.label },
    whole && /\.pdf$/i.test(filename) && { of: 'original', format: 'DOCX', label: 'Download as Word' },
    whole && /\.docx$/i.test(filename) && { of: 'original', format: 'PDF', label: 'Download as PDF' },
    // Only a deck of one slide is one picture.
    whole && isPresentationPath(filename) && document?.slideCount === 1 && pictured
      && { of: 'original', format: 'JPEG', label: 'Download as picture' },
  ].filter(Boolean);
}

/**
 * The excerpt or original in the format asked for, when the share offers it.
 * `excerpt` and `original` are downloads already permitted: `{content, filename}`.
 * @returns {Promise<{status: 'OK', content: Buffer, contentType: string, filename: string}
 *   | {status: 'CONVERSION_UNAVAILABLE'|'CONVERSION_FAILED'}>}
 */
export async function convertedShareDownload(of, format, offered, { excerpt, original, document }) {
  const conversion = offered.find((entry) => entry.of === of && entry.format === format);
  const from = of === 'excerpt' ? excerpt : original;
  if (!conversion || !Buffer.isBuffer(from?.content)) return { status: 'CONVERSION_UNAVAILABLE' };
  let content;
  try {
    content = format === 'JPEG' ? await document.slidePicture()
      : format === 'DOCX' ? await pdfToWord(from.content)
        : await buildPagePdf({ path: from.filename, content: from.content });
  } catch (error) {
    console.error('Lasso could not convert %s to %s: %s', from.filename, format, error.message);
  }
  if (!Buffer.isBuffer(content) || !content.length) return { status: 'CONVERSION_FAILED' };
  const { extension, contentType } = CONVERTED_TYPES[format];
  const stem = path.basename(String(from.filename), path.extname(String(from.filename)));
  return { status: 'OK', content, contentType, filename: `${stem}.${extension}` };
}
