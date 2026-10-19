import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrackedFile } from '../src/history/file-types.js';

test('lock, temporary and system files are not tracked as sources', () => {
  for (const name of ['~$Budget.xlsx', '~$gagement-Letter.docx', '.~lock.Budget.xlsx#', '~WRL0001.tmp',
    'Report.pdf.crdownload', 'Archive.zip.part', '._Budget.xlsx', '.DS_Store', 'Thumbs.db', 'desktop.ini', 'Icon\r']) {
    assert.equal(isTrackedFile(`Finance/${name}`), false, name);
  }
});

test('ordinary work files are tracked', () => {
  for (const name of ['Budget.xlsx', 'Engagement-Letter.docx', 'notes.md', 'Q3 ~ draft.txt', 'temp-readings.csv']) {
    assert.equal(isTrackedFile(`Finance/${name}`), true, name);
  }
});
