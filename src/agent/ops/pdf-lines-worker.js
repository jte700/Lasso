// Reads a PDF's lines in a process of its own and prints them as JSON, so that the evidence service, which answers
// synchronously, can have a PDF's layout without waiting on pdf.js in its own thread. Argument: the file's path.

import fs from 'node:fs';
import { extractLines } from './pdf-lines.js';

const { pages, lines, runningRemoved } = await extractLines(fs.readFileSync(process.argv[2]));
// What the document adapter reads of a line; the glyph runs it was built from stay here.
const kept = lines.map(({ page, y, pageHeight, x, size, font, cells, text }) => ({ page, y, pageHeight, x, size, font, cells, text }));
process.stdout.write(JSON.stringify({ pages, runningRemoved, lines: kept }));
