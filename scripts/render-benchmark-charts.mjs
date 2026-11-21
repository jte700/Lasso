// Draws the README's benchmark charts as SVG files in docs/benchmarks, from
// results.json (typing benchmarks, written by scripts/benchmark.mjs),
// mcp-summary.json (live MCP runs recorded in docs/agent), and storage.json
// (storage and memory runs written by scripts/bench-storage.mjs). Each chart
// follows the viewer's light or dark theme in Lasso's site palette.
//
//   node scripts/render-benchmark-charts.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(repoRoot, 'docs', 'benchmarks');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(outputDirectory, name), 'utf8'));
const typing = readJson('results.json');
const mcp = readJson('mcp-summary.json');
const storage = readJson('storage.json');

const FONT = "'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const WIDTH = 760;
const LEFT = 24;
const BAR = 14;

// Lasso's site palette (trial.css / RanchLook): warm paper & ink in light mode,
// near-black & warm white in dark mode, with sky blue as the primary accent.
const STYLE = `
  .surface { fill: #fffdf7; stroke: #e3dfd2; }
  .tile-bg { fill: #f7f5ed; stroke: #e7e3d6; }
  .title { fill: #1b1f17; font: 600 17px ${FONT}; letter-spacing: -0.02em; }
  .subtitle { fill: #5a5e55; font: 13px ${FONT}; }
  .label { fill: #1b1f17; font: 13px ${FONT}; }
  .strong { fill: #1b1f17; font: 600 13px ${FONT}; }
  .value { fill: #1b1f17; font: 600 12px ${FONT}; }
  .tick { fill: #6c7067; font: 11px ${FONT}; }
  .grid { stroke: #e8e4d8; stroke-width: 1; }
  .axis { stroke: #b8b4a6; stroke-width: 1; }
  .reference { stroke: #6c7067; stroke-width: 1.5; stroke-dasharray: 4 4; }
  .series-1 { fill: #2a6db0; }
  .series-1-light { fill: #8ec5f4; }
  .series-sage { fill: #5f7f51; }
  .muted-bar { fill: #d0ccc0; }
  .hero { fill: #1b1f17; font: 700 28px ${FONT}; letter-spacing: -0.03em; }
  .hero-label { fill: #5a5e55; font: 12px ${FONT}; }
  .accent { fill: #2a6db0; }
  .accent-sage { fill: #5f7f51; }
  .accent-rope { fill: #a98643; }
  .accent-terra { fill: #b8563a; }
  .line-1 { fill: none; stroke: #2a6db0; stroke-width: 2.5; stroke-linejoin: round; }
  .line-base { fill: none; stroke: #928f85; stroke-width: 2; stroke-linejoin: round; }
  .dot-1 { fill: #2a6db0; stroke: #fffdf7; stroke-width: 2; }
  .dot-base { fill: #928f85; stroke: #fffdf7; stroke-width: 2; }
  .area-1 { fill: #2a6db0; fill-opacity: 0.10; }
  .callout { fill: #2a6db0; font: 700 14px ${FONT}; }
  .footnote { fill: #757970; font: 11px ${FONT}; }
  @media (prefers-color-scheme: dark) {
    .surface { fill: #151513; stroke: #2c2c28; }
    .tile-bg { fill: #1c1c19; stroke: #2d2d29; }
    .title, .label, .strong, .value, .hero { fill: #f6f4ec; }
    .subtitle, .hero-label { fill: #a9a79f; }
    .tick { fill: #8a8880; }
    .grid { stroke: #282824; }
    .axis { stroke: #57564f; }
    .reference { stroke: #99978f; }
    .series-1, .accent { fill: #8ec5f4; }
    .series-1-light { fill: #3c658a; }
    .series-sage, .accent-sage { fill: #91a984; }
    .accent-rope { fill: #d7bd85; }
    .accent-terra { fill: #c96749; }
    .muted-bar { fill: #494842; }
    .line-1 { stroke: #8ec5f4; }
    .line-base { stroke: #76746c; }
    .dot-1 { fill: #8ec5f4; stroke: #151513; }
    .dot-base { fill: #76746c; stroke: #151513; }
    .area-1 { fill: #8ec5f4; fill-opacity: 0.12; }
    .callout { fill: #8ec5f4; }
    .footnote { fill: #7f7d75; }
  }`;

const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x, y, value, className, anchor = 'start') =>
  `<text x="${x}" y="${y}" class="${className}" text-anchor="${anchor}">${escape(value)}</text>`;
const thousands = (value) => Math.round(value).toLocaleString('en-US');
const percent = (fraction) => `${Math.round(fraction * 100)}%`;
const ms = (value) => (value < 10 ? value.toFixed(1) : String(Math.round(value)));
const saving = (lasso, baseline) => 1 - lasso / baseline;
const formatBytes = (bytes) => {
  if (bytes === 0) return '0 B';
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

// A bar growing right from x (or left, with a negative width), its data end
// rounded and its base square on the axis.
function bar(x, y, width, height, className) {
  const size = Math.abs(width);
  if (size < 0.5) return '';
  const radius = Math.min(4, size / 2, height / 2);
  const direction = width < 0 ? -1 : 1;
  const run = (size - radius) * direction;
  const sweep = direction > 0 ? 1 : 0;
  return `<path class="${className}" d="M${x},${y} h${run} a${radius},${radius} 0 0 ${sweep} ${radius * direction},${radius}` +
    ` v${height - 2 * radius} a${radius},${radius} 0 0 ${sweep} ${-radius * direction},${radius} h${-run} z"/>`;
}

const swatch = (x, y, className, label) =>
  `<rect class="${className}" x="${x}" y="${y - 10}" width="12" height="12" rx="3"/>${text(x + 18, y, label, 'tick')}`;

function frame(height, title, subtitle, body, description) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="t d">
<title id="t">${escape(title)}</title><desc id="d">${escape(description)}</desc>
<style>${STYLE}</style>
<rect class="surface" x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="16"/>
${text(LEFT, 34, title, 'title')}
${subtitle ? text(LEFT, 54, subtitle, 'subtitle') : ''}
${body}
</svg>
`;
}

function write(name, svg) {
  fs.writeFileSync(path.join(outputDirectory, name), svg);
  console.log(`Wrote docs/benchmarks/${name}`);
}

function summaryCard() {
  const pooled = mcp.pooled;
  const tokenSaved = percent(saving(pooled.lasso.tokens, pooled.fileTools.tokens));
  const costSaved = percent(saving(pooled.lasso.cost, pooled.fileTools.cost));
  const finalEdit = formatBytes(storage.final.targets.dbGrowthPerEditBytes);
  const baseEdit = formatBytes(storage.baseline.targets.dbGrowthPerEditBytes);
  const tiles = [
    { value: tokenSaved, accent: 'accent', lines: ['fewer agent tokens', `across ${pooled.tasks} live MCP tasks`] },
    { value: costSaved, accent: 'accent-sage', lines: ['lower model cost', `${pooled.lasso.correct}/${pooled.tasks} right vs ${pooled.fileTools.correct}/${pooled.tasks}`] },
    { value: `${ms(typing.wholeLibrary.score.latency.p50)} ms`, accent: 'accent-rope', lines: ['median per keystroke', `${typing.wholeLibrary.score.top1}/${typing.wholeLibrary.score.cases} top-1 · 0 tokens`] },
    { value: finalEdit, accent: 'accent-terra', lines: ['per spreadsheet edit', `down from ${baseEdit}`] },
  ];
  const gap = 12;
  const tileWidth = (WIDTH - 2 * LEFT - gap * (tiles.length - 1)) / tiles.length;
  const body = tiles.map((tile, index) => {
    const x = LEFT + index * (tileWidth + gap);
    return `<rect class="tile-bg" x="${x.toFixed(1)}" y="74" width="${tileWidth.toFixed(1)}" height="88" rx="12"/>` +
      `<rect class="${tile.accent}" x="${(x + 14).toFixed(1)}" y="86" width="24" height="3" rx="1.5"/>` +
      text((x + 14).toFixed(1), 118, tile.value, 'hero') +
      tile.lines.map((line, row) => text((x + 14).toFixed(1), 137 + row * 15, line, 'hero-label')).join('');
  }).join('\n');
  write('summary.svg', frame(182, 'Measured results',
    'MCP: live provider-recorded runs on gpt-5.4-mini. Typing & history: local benchmarks on Apple M3.', body,
    tiles.map((tile) => `${tile.value} ${tile.lines.join(' ')}`).join('; ')));
}

// Savings by kind of file, positive where Lasso used fewer tokens.
function mcpByFileChart() {
  const rows = mcp.byFileKind.rows.map((row) => ({ ...row, saving: saving(row.lasso, row.fileTools) }));
  const labelRight = LEFT + 226;
  const zero = labelRight + 64;
  const plotRight = WIDTH - 112;
  const scale = (fraction) => (plotRight - zero) * fraction;
  const top = 92;
  const rowHeight = 32;
  const height = top + rows.length * rowHeight + 58;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
    const x = zero + scale(fraction);
    return `<line class="grid" x1="${x}" x2="${x}" y1="${top - 6}" y2="${top + rows.length * rowHeight}"/>` +
      text(x, top + rows.length * rowHeight + 16, percent(fraction), 'tick', 'middle');
  }).join('');
  const bars = rows.map((row, index) => {
    const y = top + index * rowHeight + (rowHeight - BAR) / 2;
    const width = scale(row.saving);
    const positive = row.saving >= 0;
    const label = positive ? `${percent(row.saving)} fewer` : `${percent(-row.saving)} more`;
    return text(labelRight, y + BAR - 2, `${row.kind} · ${row.tasks} tasks`, 'label', 'end') +
      bar(zero, y, width, BAR, positive ? 'series-1' : 'muted-bar') +
      text(positive ? zero + width + 8 : zero + 8, y + BAR - 2, label, 'value');
  }).join('\n');
  const body = `${swatch(LEFT, 76, 'series-1', 'Fewer tokens than file tools')}${swatch(230, 76, 'muted-bar', 'More tokens than file tools')}
${grid}
<line class="axis" x1="${zero}" x2="${zero}" y1="${top - 6}" y2="${top + rows.length * rowHeight}"/>
${bars}
${text(LEFT, height - 14, 'Tokens with Lasso against file tools on the same tasks (live runs in docs/agent). Small files cost less to read directly.', 'footnote')}`;
  write('mcp-by-file.svg', frame(height, `Where Lasso MCP saves tokens, by file (${mcp.byFileKind.model})`, '', body,
    rows.map((row) => `${row.kind}: ${percent(row.saving)} saving`).join('; ')));
}

// Running token totals over a run's tasks, file tools against Lasso, one
// panel per model on a shared scale.
function cumulativeRun(model) {
  const { results } = JSON.parse(fs.readFileSync(path.join(repoRoot, model.records), 'utf8'));
  const tasks = new Map();
  for (const result of results) {
    if (result.capability) continue;
    const key = `${result.run}:${result.task}`;
    const side = result.arm === 'direct' ? 'fileTools' : 'lasso';
    tasks.set(key, { ...tasks.get(key), [side]: result.input + result.output });
  }
  const paired = [...tasks.values()].filter((task) => task.fileTools != null && task.lasso != null);
  const running = (side) => paired.reduce((sums, task) => [...sums, (sums.at(-1) ?? 0) + task[side]], [0]);
  return { fileTools: running('fileTools'), lasso: running('lasso') };
}

function cumulativeChart() {
  const runs = mcp.models.map((model) => ({ model, ...cumulativeRun(model) }));
  const STEP = 50000;
  const axisMax = Math.ceil(Math.max(...runs.map((run) => run.fileTools.at(-1))) / STEP) * STEP;
  const gap = 36;
  const panelLeft = LEFT + 42;
  const panelWidth = (WIDTH - panelLeft - LEFT - gap - 42) / 2;
  const plotTop = 126;
  const plotHeight = 196;
  const plotBottom = plotTop + plotHeight;
  const y = (value) => plotBottom - plotHeight * value / axisMax;
  const panels = runs.map((run, index) => {
    const left = panelLeft + index * (panelWidth + gap + 42);
    const count = run.fileTools.length - 1;
    const x = (task) => left + panelWidth * task / count;
    const points = (series) => series.map((value, task) => `${x(task).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
    const grid = [];
    for (let value = 0; value <= axisMax; value += STEP) {
      grid.push(`<line class="${value ? 'grid' : 'axis'}" x1="${left}" x2="${left + panelWidth}" y1="${y(value)}" y2="${y(value)}"/>`,
        text(left - 8, y(value) + 4, value ? `${value / 1000}K` : '0', 'tick', 'end'));
    }
    const endX = x(count);
    const base = run.fileTools.at(-1);
    const lasso = run.lasso.at(-1);
    const area = `${points(run.lasso)} ${endX},${plotBottom} ${left},${plotBottom}`;
    return `${grid.join('')}
${text(left, plotTop - 22, `${run.model.model} · ${count} tasks`, 'strong')}
${text(left + panelWidth, plotTop - 22, `${percent(saving(lasso, base))} fewer tokens`, 'callout', 'end')}
<polygon class="area-1" points="${area}"/>
<polyline class="line-base" points="${points(run.fileTools)}"/>
<polyline class="line-1" points="${points(run.lasso)}"/>
<circle class="dot-base" cx="${endX}" cy="${y(base)}" r="4.5"/>
<circle class="dot-1" cx="${endX}" cy="${y(lasso)}" r="4.5"/>
${text(endX - 8, y(base) - 10, thousands(base), 'value', 'end')}
${text(endX - 8, y(lasso) - 10, thousands(lasso), 'value', 'end')}
${text(left, plotBottom + 18, '0', 'tick', 'middle')}${text(endX, plotBottom + 18, String(count), 'tick', 'middle')}
${text(left + panelWidth / 2, plotBottom + 18, 'tasks completed', 'tick', 'middle')}`;
  }).join('\n');
  const height = plotBottom + 56;
  const body = `${swatch(LEFT, 76, 'muted-bar', 'File tools only (Read, Grep, Glob)')}${swatch(250, 76, 'series-1', 'With the Lasso MCP server')}
${panels}
${text(LEFT, height - 14, 'Running total of tokens per lookup run (input, including tool definitions and conversation, plus output). Provider records in docs/agent.', 'footnote')}`;
  write('mcp-cumulative.svg', frame(height, 'Tokens an agent spends answering from your files', '', body,
    runs.map((run) => `${run.model.model}: ${run.fileTools.at(-1)} tokens with file tools, ${run.lasso.at(-1)} with Lasso`).join('; ')));
}

function latencyChart() {
  const rows = [
    ...typing.corpora.filter((corpus) => corpus.score.cases > 0)
      .map((corpus) => ({ name: corpus.name, latency: corpus.score.latency })),
    { name: `All ${typing.wholeLibrary.folders} folders on`, latency: typing.wholeLibrary.score.latency },
  ];
  const plotLeft = LEFT + 186;
  const plotWidth = WIDTH - plotLeft - 96;
  const axisMax = 100;
  const scale = (value) => plotWidth * Math.min(value, axisMax) / axisMax;
  const top = 96;
  const rowHeight = 34;
  const height = top + rows.length * rowHeight + 58;
  const grid = [0, 20, 40, 60, 80, 100].map((value) => {
    const x = plotLeft + scale(value);
    return `<line class="grid" x1="${x}" x2="${x}" y1="${top - 4}" y2="${top + rows.length * rowHeight}"/>` +
      text(x, top + rows.length * rowHeight + 16, `${value} ms`, 'tick', 'middle');
  }).join('');
  const reference = plotLeft + scale(100);
  const bars = rows.map((row, index) => {
    const y = top + index * rowHeight + 5;
    return text(plotLeft - 12, y + 18, row.name, 'label', 'end') +
      bar(plotLeft, y, scale(row.latency.p50), 11, 'series-1') + bar(plotLeft, y + 13, scale(row.latency.p95), 11, 'series-1-light') +
      text(plotLeft + scale(Math.max(row.latency.p50, row.latency.p95)) + 8, y + 18,
        `${ms(row.latency.p50)} / ${ms(row.latency.p95)} ms`, 'value');
  }).join('\n');
  const body = `${swatch(LEFT, 76, 'series-1', 'Median')}${swatch(110, 76, 'series-1-light', '95th percentile')}
${grid}
<line class="reference" x1="${reference}" x2="${reference}" y1="${top - 8}" y2="${top + rows.length * rowHeight}"/>
${text(reference - 6, 76, '100 ms: feels instant', 'tick', 'end')}
<line class="axis" x1="${plotLeft}" x2="${plotLeft}" y1="${top - 4}" y2="${top + rows.length * rowHeight}"/>
${bars}
${text(LEFT, height - 14, `${typing.wholeLibrary.score.latency.samples} keystrokes replayed one at a time, in process. ${typing.machine.cpu}, Node.js ${typing.machine.node}.`, 'footnote')}`;
  write('latency.svg', frame(height, 'Time to show suggestions, per keystroke', '', body,
    rows.map((row) => `${row.name}: median ${row.latency.p50} ms, p95 ${row.latency.p95} ms`).join('; ')));
}

function storageChart() {
  const b = storage.baseline.targets;
  const f = storage.final.targets;
  const metrics = [
    {
      name: 'DB growth per 1-cell edit',
      before: b.dbGrowthPerEditBytes,
      after: f.dbGrowthPerEditBytes,
      beforeLabel: formatBytes(b.dbGrowthPerEditBytes),
      afterLabel: formatBytes(f.dbGrowthPerEditBytes),
    },
    {
      name: 'Version rows written',
      before: b.versionRowsPerOneCellEdit,
      after: f.versionRowsPerOneCellEdit,
      beforeLabel: `${thousands(b.versionRowsPerOneCellEdit)} rows`,
      afterLabel: `${f.versionRowsPerOneCellEdit} rows`,
    },
    {
      name: 'Derived growth per CSV edit',
      before: b.derivedGrowthPerCsvEditBytes,
      after: f.derivedGrowthPerCsvEditBytes,
      beforeLabel: formatBytes(b.derivedGrowthPerCsvEditBytes),
      afterLabel: formatBytes(f.derivedGrowthPerCsvEditBytes),
    },
    {
      name: 'First edit after restart',
      before: b.firstEditAfterRestartMs,
      after: f.firstEditAfterRestartMs,
      beforeLabel: `${Math.round(b.firstEditAfterRestartMs)} ms`,
      afterLabel: `${Math.round(f.firstEditAfterRestartMs)} ms`,
    },
    {
      name: 'Peak memory (RSS)',
      before: b.peakRssBytes,
      after: f.peakRssBytes,
      beforeLabel: `${Math.round(b.peakRssBytes / 1048576)} MB`,
      afterLabel: `${Math.round(f.peakRssBytes / 1048576)} MB`,
    },
  ];
  const plotLeft = LEFT + 196;
  const plotWidth = WIDTH - plotLeft - 122;
  const top = 104;
  const rowHeight = 40;
  const height = top + metrics.length * rowHeight + 52;
  const rows = metrics.map((metric, index) => {
    const y = top + index * rowHeight + 4;
    const max = Math.max(metric.before, metric.after, 1);
    const beforeW = plotWidth * (metric.before / max);
    const afterW = metric.after === 0 ? 0 : Math.max(3, plotWidth * (metric.after / max));
    return text(plotLeft - 12, y + 19, metric.name, 'label', 'end') +
      bar(plotLeft, y, beforeW, 12, 'muted-bar') +
      text(plotLeft + beforeW + 8, y + 10, metric.beforeLabel, 'tick') +
      bar(plotLeft, y + 15, afterW, 12, 'series-1') +
      text(plotLeft + afterW + 8, y + 25, metric.afterLabel, 'value');
  }).join('\n');
  const body = `${swatch(LEFT, 82, 'muted-bar', 'Before indexing rework')}${swatch(200, 82, 'series-1', 'Current build')}
<line class="axis" x1="${plotLeft}" x2="${plotLeft}" y1="${top - 4}" y2="${top + metrics.length * rowHeight}"/>
${rows}
${text(LEFT, height - 14, `1,882-row (${formatBytes(f.csvFileBytes)}) CSV edit benchmark (npm run bench:storage). Row identities kept on top-row insert: ${b.identitiesKeptOnTopRowInsert.kept} → ${f.identitiesKeptOnTopRowInsert.kept}/${f.identitiesKeptOnTopRowInsert.total}.`, 'footnote')}`;
  write('storage.svg', frame(height, 'History storage, edit speed and memory',
    'Versioned provenance overhead before and after the indexing rework (docs/benchmarks/storage.json).', body,
    metrics.map((m) => `${m.name}: ${m.beforeLabel} to ${m.afterLabel}`).join('; ')));
}

summaryCard();
cumulativeChart();
mcpByFileChart();
latencyChart();
storageChart();
