// A redacted picture: a fresh PNG drawn by scripts/render-shared-image.swift,
// its masked areas covered and none of the original file's metadata kept.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectFileType } from '../history/file-types.js';
import { execute, renderCache, swiftHelper } from './swift-helper.js';

const executable = swiftHelper('render-shared-image', ['AppKit', 'CoreImage', 'ImageIO', 'UniformTypeIdentifiers'],
  'Redacted pictures require the local picture renderer.');
const cached = renderCache({ entries: 16, bytes: 48 * 1024 * 1024 });
const RENDER_TIMEOUT_MS = 60_000;
const MAX_PNG_BYTES = 48 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @param {string} filePath */
export const isImagePath = (filePath) => detectFileType(String(filePath ?? '')) === 'image';

/** A rendered file is used only when it is a PNG of a sane size. */
function checkedPng(content) {
  if (!content.subarray(0, 8).equals(PNG_SIGNATURE) || content.length > MAX_PNG_BYTES) throw new Error('Invalid generated picture.');
  return content;
}

/**
 * The picture with each region covered, as PNG bytes.
 * @param {Buffer} content the original picture
 * @param {Array<{x: number, y: number, width: number, height: number, effect: string}>} regions from the top left, 0...1
 * @param {string} filePath the picture's name, whose extension the renderer reads it by
 * @returns {Promise<Buffer>}
 */
export async function buildRedactedImage(content, regions, filePath) {
  if (!Buffer.isBuffer(content) || !regions?.length) throw new Error('Nothing to redact.');
  const request = { regions: regions.map(({ x, y, width, height, effect }) => ({ x, y, width, height, effect })) };
  const key = crypto.createHash('sha256').update(content).update(JSON.stringify(request)).digest('hex');
  return cached(key, async () => {
    const renderer = await executable();
    const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lasso-shared-image-'));
    try {
      // The renderer reads the picture by its extension (an SVG is not a bitmap).
      const extension = path.extname(String(filePath ?? '')).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.png';
      const input = path.join(temporary, `input${extension}`), options = path.join(temporary, 'regions.json');
      const output = path.join(temporary, 'shared.png');
      await Promise.all([fs.promises.writeFile(input, content, { mode: 0o600 }),
        fs.promises.writeFile(options, JSON.stringify(request), { mode: 0o600 })]);
      await execute(renderer, [input, options, output], { timeout: RENDER_TIMEOUT_MS, maxBuffer: 1_000_000 });
      return checkedPng(await fs.promises.readFile(output));
    } finally { await fs.promises.rm(temporary, { recursive: true, force: true }); }
  });
}
