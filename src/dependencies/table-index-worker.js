// Reads one large table file into the table index, off the server's thread.
// A worksheet is inflated a piece at a time and a delimited file is read a
// megabyte at a time, so the file's size does not decide the memory used.

import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { parentPort, workerData } from 'node:worker_threads';
import { delimitedRows } from '../history/diff.js';
import { streamSpreadsheetRows } from './document-extraction.js';
import { TableWriter, openTableDatabase } from './table-index.js';

const { databasePath, blobPath, contentHash, kind, delimiter, flag, port } = workerData;
const channel = port ?? parentPort;

async function readWorkbook(db) {
  let writer = null;
  let position = 0;
  const result = await streamSpreadsheetRows(fs.readFileSync(blobPath), {
    onSheet(name) {
      writer?.abandon();
      writer = new TableWriter(db, contentHash, name, position++);
    },
    onRows(rows, rowNumbers, displayRows) {
      writer.add(rows.map((cells, index) => ({ rowNumber: rowNumbers[index], cells,
        display: displayRows[index] ? { ...displayRows[index] } : null })));
    },
    onSheetEnd({ merges }) {
      writer.finish({ merges });
      writer = null;
    },
    onProgress: (share) => channel.postMessage({ progress: share }),
  });
  // A sheet that failed part way is not kept half read.
  writer?.abandon();
  if (result?.skipped?.length) {
    db.prepare(`UPDATE tables SET extras_json = json_set(extras_json, '$.skipped', json(?)) WHERE content_hash = ?`)
      .run(JSON.stringify(result.skipped), contentHash);
  }
  return result ? { readable: true, sheets: result.sheets, skipped: result.skipped } : { readable: false, sheets: [], skipped: [] };
}

async function readDelimited(db) {
  const writer = new TableWriter(db, contentHash, null, 0);
  const reader = delimitedRows(delimiter);
  const size = Math.max(1, fs.statSync(blobPath).size);
  let physical = 0;
  let read = 0;
  let batch = [];
  const take = (rows) => {
    for (const cells of rows) {
      batch.push({ rowNumber: physical, cells, blank: !cells.some((cell) => String(cell ?? '').trim()) });
      physical += 1;
    }
    if (batch.length >= 2_000) {
      writer.add(batch);
      batch = [];
    }
  };
  try {
    const decoder = new StringDecoder('utf8');
    // The indexer reads "\r\n" as "\n"; a "\r" that ends one piece waits for the next.
    let carriage = '';
    for await (const chunk of fs.createReadStream(blobPath, { highWaterMark: 1024 * 1024 })) {
      let text = carriage + decoder.write(chunk);
      carriage = text.endsWith('\r') ? '\r' : '';
      if (carriage) text = text.slice(0, -1);
      take(reader.write(text.replace(/\r\n/g, '\n')));
      read += chunk.length;
      channel.postMessage({ progress: read / size });
    }
    take(reader.write((carriage + decoder.end()).replace(/\r\n/g, '\n')));
    take(reader.end());
    writer.add(batch);
    writer.finish({});
  } catch (error) {
    writer.abandon();
    throw error;
  }
  return { readable: true, sheets: [''], skipped: [] };
}

try {
  const db = openTableDatabase(databasePath);
  const result = kind === 'spreadsheet' ? await readWorkbook(db) : await readDelimited(db);
  db.close();
  channel.postMessage({ done: true, ...result });
} catch (error) {
  channel.postMessage({ error: error?.message ?? String(error) });
} finally {
  if (flag) {
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
  }
}
