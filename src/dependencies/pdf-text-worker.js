// Reads PDFs' text into the text store, off the server's thread. The native
// reader takes a moment per file and seconds for a long one; the server then
// takes the text from the store as if it had read it itself.

import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { extractDrawingDocument } from './drawing-extraction.js';
import { extractPdfFullText } from './document-extraction.js';
import { TextStore } from './text-store.js';

const { root, readerVersion, items } = workerData;
const store = new TextStore(root, readerVersion, { tidy: false });
for (const [index, item] of items.entries()) {
  try {
    const buffer = fs.readFileSync(item.blobPath);
    const layout = extractDrawingDocument(buffer);
    // A reading the native reader failed, such as a timeout under load, is not kept.
    if (layout.status !== 'error') {
      store.set(`${item.contentHash}|pdf|all`, extractPdfFullText(buffer));
      if (item.pages) {
        store.set(`${item.contentHash}|pdf|pages`, layout.pages.map((page) => ({ pageNumber: page.pageNumber, text: page.text ?? '' })));
      }
    }
  } catch { /* The server reads this one itself when it is asked for. */ }
  parentPort.postMessage({ progress: (index + 1) / items.length });
}
parentPort.postMessage({ done: true });
