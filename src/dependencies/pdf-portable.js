import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('./pdf-portable-worker.js', import.meta.url));
const MAX_BYTES = 80_000_000;

/** Keep the synchronous indexing API while isolating PDF parsing and rendering.
 * The bundled Node executable and npm assets work without platform PDF tools.
 */
function runPdfWorker(buffer, operation, identifier = '') {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_BYTES
    || !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    throw new Error('PDF processing requires a valid PDF under 80 MB.');
  }
  const result = spawnSync(process.execPath, ['--max-old-space-size=256', worker, operation, String(identifier)], {
    input: buffer, encoding: 'utf8', timeout: 30_000, maxBuffer: 32_000_000, windowsHide: true,
  });
  if (result.error?.code === 'ETIMEDOUT') throw new Error('PDF processing exceeded the 30-second limit.');
  if (result.error) throw result.error;
  let output;
  try { output = JSON.parse(result.stdout); } catch {
    throw new Error(result.stderr?.trim().slice(-500) || 'The bundled PDF processor did not return a result.');
  }
  if (result.status !== 0 || output.error) throw new Error(output.error || 'The bundled PDF processor failed.');
  return output;
}

export function extractPortablePdfLayout(buffer) {
  return runPdfWorker(buffer, 'layout');
}

export function renderPortablePdfFigure(buffer, identifier) {
  const { image, ...metadata } = runPdfWorker(buffer, 'figure', identifier);
  if (!image) throw new Error('The cited PDF page could not be rendered.');
  return { ...metadata, image: Buffer.from(image, 'base64') };
}
