import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const locator = path.resolve(moduleDirectory, '../../scripts/locate-pdf-figure-page.js');

export function renderPdfFigurePage(buffer, identifier) {
  if (process.platform !== 'darwin'
    || !fs.existsSync('/usr/bin/osascript') || !fs.existsSync('/usr/bin/sips')) {
    throw new Error('PDF figure rendering requires macOS PDFKit.');
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-pdf-figure-'));
  const input = path.join(directory, 'source.pdf');
  const selectedPage = path.join(directory, 'selected-page.pdf');
  const output = path.join(directory, 'figure-page.png');
  try {
    fs.writeFileSync(input, buffer, { flag: 'wx' });
    const located = spawnSync('/usr/bin/osascript', [
      '-l', 'JavaScript', locator, input, selectedPage, String(identifier ?? ''),
    ], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 2_000_000,
    });
    if (located.error) throw located.error;
    if (located.status !== 0 || !fs.existsSync(selectedPage)) {
      throw new Error(located.stderr?.trim() || 'The cited PDF page could not be located.');
    }
    const rendered = spawnSync('/usr/bin/sips', [
      '-s', 'format', 'png', selectedPage, '--out', output,
    ], { encoding: 'utf8', timeout: 20_000, maxBuffer: 2_000_000 });
    if (rendered.error) throw rendered.error;
    if (rendered.status !== 0 || !fs.existsSync(output)) {
      throw new Error(rendered.stderr?.trim() || 'The cited PDF page could not be rendered.');
    }
    const metadata = JSON.parse(located.stdout.trim().split('\n').at(-1));
    return { ...metadata, image: fs.readFileSync(output) };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
