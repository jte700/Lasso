// A PDF as a Word document, for a recipient who would rather edit it. Its
// text keeps its fonts, sizes and colours, a page to a page. A page with no
// text, such as a scan or a copy Lasso drew as pixels, becomes a picture of
// the page, so a redacted or cropped copy stays exactly the pixels it was.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readZip, writeZip, zipBytes } from '../dependencies/zip-archive.js';
import { execute, renderCache, swiftHelper } from './swift-helper.js';

const executable = swiftHelper('render-document-pages', ['AppKit', 'PDFKit', 'QuickLookThumbnailing'],
  'Converting a PDF to Word requires a Mac.');
const cached = renderCache({ entries: 8, bytes: 96 * 1024 * 1024 });
const CONVERSION_TIMEOUT_MS = 120_000;
const MAX_PART_BYTES = 64 * 1024 * 1024;
const EMU_PER_POINT = 12_700;
const DOCUMENT_PART = 'word/document.xml';
const RELATIONSHIPS_PART = 'word/_rels/document.xml.rels';
const CONTENT_TYPES = '[Content_Types].xml';
const IMAGE_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

/**
 * The PDF as a .docx.
 * @param {Buffer} content
 * @returns {Promise<Buffer>}
 */
export function pdfToWord(content) {
  if (!Buffer.isBuffer(content)) return Promise.reject(new Error('There is no PDF to convert.'));
  const key = crypto.createHash('sha256').update('pdf-docx:').update(content).digest('hex');
  return cached(key, () => convert(content));
}

async function convert(content) {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lasso-pdf-word-'));
  try {
    const input = path.join(temporary, 'input.pdf'), output = path.join(temporary, 'output.docx');
    const folder = path.join(temporary, 'pictures');
    await fs.promises.mkdir(folder);
    await fs.promises.writeFile(input, content, { mode: 0o600 });
    // Unguessable, so no text in the PDF can stand where a picture goes.
    const marker = `LassoPicture${crypto.randomBytes(8).toString('hex')}x`;
    await execute(await executable(), ['pdf-docx', input, output, folder, marker],
      { timeout: CONVERSION_TIMEOUT_MS, maxBuffer: 1_000_000 });
    const manifest = JSON.parse(await fs.promises.readFile(path.join(folder, 'pictures.json'), 'utf8'));
    const word = await fs.promises.readFile(output);
    if (!manifest.pictures.length) return checkedWord(word);
    const pictures = await Promise.all(manifest.pictures.map(async (picture) => ({
      ...picture, content: await fs.promises.readFile(path.join(folder, path.basename(picture.file))) })));
    return checkedWord(withPictures(word, { ...manifest, pictures }, marker));
  } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
}

function checkedWord(content) {
  if (!readZip(content)?.has(DOCUMENT_PART)) throw new Error('The Word document was not written.');
  return content;
}

/** The picture's size in EMU, shrunk to fit inside the page's margins. */
function fitted(picture, { paper, margin }) {
  const room = { width: paper.width - margin * 2, height: paper.height - margin * 2 };
  const scale = Math.min(1, room.width / picture.width, room.height / picture.height);
  return { cx: Math.round(picture.width * scale * EMU_PER_POINT), cy: Math.round(picture.height * scale * EMU_PER_POINT) };
}

function drawing(picture, relationshipId, { cx, cy }) {
  const name = `Page ${picture.page}`;
  return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>`
    + `<wp:docPr id="${picture.page}" name="${name}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">`
    + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + `<pic:nvPicPr><pic:cNvPr id="${picture.page}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>';
}

/** The Word document with each page picture in place of its marker. */
function withPictures(word, manifest, marker) {
  const zip = readZip(word);
  const text = (part) => zipBytes(zip.get(part), MAX_PART_BYTES)?.toString('utf8');
  let document = text(DOCUMENT_PART);
  let relationships = text(RELATIONSHIPS_PART);
  let contentTypes = text(CONTENT_TYPES);
  if (!document || !relationships || !contentTypes) throw new Error('The Word document is missing a part.');
  const media = [];
  for (const picture of manifest.pictures) {
    const relationshipId = `rIdLassoPage${picture.page}`;
    const target = `media/page-${picture.page}.jpg`;
    // The marker is a run's whole text; the run keeps its page break, if it has one.
    const placeholder = new RegExp(`<w:t\\b[^>]*>${marker}${picture.page}</w:t>`);
    if (!placeholder.test(document)) throw new Error(`Page ${picture.page}'s picture has no place in the document.`);
    document = document.replace(placeholder, drawing(picture, relationshipId, fitted(picture, manifest)));
    relationships = relationships.replace('</Relationships>',
      `<Relationship Id="${relationshipId}" Type="${IMAGE_RELATIONSHIP}" Target="${target}"/></Relationships>`);
    media.push({ name: `word/${target}`, content: picture.content });
  }
  if (!/<Default\b[^>]*Extension="jpg"/i.test(contentTypes)) {
    contentTypes = contentTypes.replace(/<Types\b[^>]*>/, (open) => `${open}<Default Extension="jpg" ContentType="image/jpeg"/>`);
  }
  const written = new Map([[DOCUMENT_PART, document], [RELATIONSHIPS_PART, relationships], [CONTENT_TYPES, contentTypes]]);
  return writeZip([...[...zip.values()].map((entry) => (written.has(entry.name)
    ? { name: entry.name, content: Buffer.from(written.get(entry.name), 'utf8') } : entry)), ...media]);
}
