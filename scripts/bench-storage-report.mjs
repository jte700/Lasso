// Prints one storage benchmark run as a table, its targets and the notes
// that explain them. Sizes are decimal megabytes.

const BYTES_PER_MB = 1_000_000;

export function round(value, places) {
  return Number(value.toFixed(places));
}

function megabytes(bytes) {
  return (bytes / BYTES_PER_MB).toFixed(2);
}

function signed(text, value) {
  return `${value < 0 ? '' : '+'}${text}`;
}

/** A total in megabytes with its change since the step before. */
function sizeWithDelta(step, key) {
  return `${megabytes(step.totals[key])} (${signed(megabytes(step.delta[key]), step.delta[key])})`;
}

function countWithDelta(step, key) {
  return `${step.totals[key]} (${signed(String(step.delta[key]), step.delta[key])})`;
}

const COLUMNS = [
  { title: 'step', left: true, value: (step) => step.name },
  { title: 'ms', value: (step) => step.wallMs.toFixed(1) },
  { title: 'blobs MB', value: (step) => sizeWithDelta(step, 'blobsBytes') },
  { title: 'timeline+wal MB', value: (step) => sizeWithDelta(step, 'timelineBytes') },
  { title: 'timeline stored MB', value: (step) => sizeWithDelta(step, 'timelineStoredBytes') },
  { title: 'derived MB', value: (step) => sizeWithDelta(step, 'derivedBytes') },
  { title: 'tables.sqlite MB', value: (step) => sizeWithDelta(step, 'derivedTablesBytes') },
  { title: 'derived stored MB', value: (step) => sizeWithDelta(step, 'derivedStoredBytes') },
  { title: 'versions', value: (step) => countWithDelta(step, 'versionRows') },
  { title: 'removals', value: (step) => countWithDelta(step, 'removalRows') },
  { title: 'RSS MB', value: (step) => sizeWithDelta(step, 'rssBytes') },
  { title: 'heap MB', value: (step) => sizeWithDelta(step, 'heapUsedBytes') },
];

function tableLines(steps) {
  const cells = steps.map((step) => COLUMNS.map((column) => column.value(step)));
  const widths = COLUMNS.map((column, index) => Math.max(column.title.length, ...cells.map((row) => row[index].length)));
  const line = (row) => row.map((cell, index) => (COLUMNS[index].left ? cell.padEnd(widths[index]) : cell.padStart(widths[index])))
    .join('  ');
  return [line(COLUMNS.map((column) => column.title)), widths.map((width) => '-'.repeat(width)).join('  '), ...cells.map(line)];
}

function breakdownLines(breakdown) {
  const rows = breakdown.rowDeltas.map(({ table, rows: count }) => `  ${table}: ${signed(String(count), count)} rows`);
  const pages = (breakdown.pageByteDeltas ?? []).map(({ name, bytes }) => `  ${name}: ${signed(megabytes(bytes), bytes)} MB of pages`);
  return [
    'First csv edit, where timeline.sqlite grew:', ...rows, ...pages,
    `  structured_diff_json of the new change: ${breakdown.structuredDiffJsonBytes} bytes`,
    `  ${breakdown.newVersionRows} new version rows holding ${megabytes(breakdown.newVersionRowsContentBytes)} MB of column content`,
  ];
}

function noteLines(run) {
  const { referenceCell, topRowInsert, restart, files } = run;
  return [
    `Files: csv ${megabytes(files.csvFileBytes)} MB, xlsx ${megabytes(files.xlsxFileBytes)} MB, 200-row csv ${files.smallCsvFileBytes} bytes.`,
    `"${referenceCell.label}" was never edited and has ${referenceCell.versions} versions with ${referenceCell.distinctContentHashes} content hashes; `
      + `identical apart from content_hash: ${referenceCell.identicalApartFromContentHash}.`,
    `Top-row insert: ${topRowInsert.kept} of ${topRowInsert.total} objects kept their identity; ${topRowInsert.removals} removals recorded.`,
    `First edit after restart wrote ${restart.versionRows} version rows; the file has ${restart.fileObjects} objects and its folder `
      + `${restart.folderObjects}. ${restart.rewroteFileIndex ? 'It rewrote the file\'s index' : 'It carried the file\'s index forward'}`
      + `${restart.builtOnPreviousIndex ? ', stored as differences from the index before it.' : ', stored in full.'}`,
    `In a process just started the first edit took ${restart.freshProcess.firstEditMs} ms, after ${restart.freshProcess.moduleLoadMs} ms `
      + `loading the server and ${restart.freshProcess.openMs} ms opening the library.`,
    'Stored sizes count each database page once, with the write-ahead log folded in; growth per edit is taken from them.',
  ];
}

export function printRun(label, run) {
  console.log(`Storage benchmark "${label}", ${run.date}, node ${run.node}, ${run.platform}, commit ${run.commit}`);
  console.log('Totals after each step, with the change from the step before in brackets.\n');
  console.log(tableLines(run.steps).join('\n'));
  console.log(`\n${breakdownLines(run.firstCsvEdit).join('\n')}`);
  console.log(`\n${noteLines(run).join('\n')}`);
  console.log(`\ntargets\n${JSON.stringify(run.targets, null, 2)}`);
}
