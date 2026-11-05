// Draws the README's benchmark charts as SVG files in docs/benchmarks, from
// results.json (typing benchmarks, written by scripts/benchmark.mjs) and
// mcp-summary.json (live MCP runs recorded in docs/agent). Each chart follows
// the viewer's light or dark theme.
//
//   node scripts/render-benchmark-charts.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outputDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'benchmarks');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(outputDirectory, name), 'utf8'));
const typing = readJson('results.json');
const mcp = readJson('mcp-summary.json');

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const WIDTH = 760;
const LEFT = 24;
const BAR = 14;

// Colour roles, light then dark, from a palette checked for colour-vision deficiency.
const STYLE = `
  .surface { fill: #fcfcfb; stroke: #e6e5e1; }
  .title { fill: #0b0b0b; font: 600 17px ${FONT}; }
  .subtitle { fill: #52514e; font: 13px ${FONT}; }
  .label { fill: #0b0b0b; font: 13px ${FONT}; }
  .strong { fill: #0b0b0b; font: 600 13px ${FONT}; }
  .value { fill: #0b0b0b; font: 600 12px ${FONT}; }
  .tick { fill: #6f6e69; font: 11px ${FONT}; }
  .grid { stroke: #e6e5e1; stroke-width: 1; }
  .axis { stroke: #a8a7a1; stroke-width: 1; }
  .reference { stroke: #52514e; stroke-width: 1.5; stroke-dasharray: 4 4; }
  .series-1 { fill: #2a78d6; }
  .series-2 { fill: #eb6834; }
  .muted-bar { fill: #c9c8c2; }
  .hero { fill: #0b0b0b; font: 700 30px ${FONT}; }
  .hero-label { fill: #52514e; font: 13px ${FONT}; }
  .accent { fill: #2a78d6; }
  @media (prefers-color-scheme: dark) {
    .surface { fill: #1a1a19; stroke: #333330; }
    .title, .label, .strong, .value, .hero { fill: #f0efec; }
    .subtitle, .hero-label { fill: #c3c2b7; }
    .tick { fill: #9d9c95; }
    .grid { stroke: #333330; }
    .axis { stroke: #6f6e69; }
    .reference { stroke: #c3c2b7; }
    .series-1, .accent { fill: #3987e5; }
    .series-2 { fill: #d95926; }
    .muted-bar { fill: #5c5b56; }
  }`;

const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x, y, value, className, anchor = 'start') =>
  `<text x="${x}" y="${y}" class="${className}" text-anchor="${anchor}">${escape(value)}</text>`;
const thousands = (value) => Math.round(value).toLocaleString('en-US');
const percent = (fraction) => `${Math.round(fraction * 100)}%`;
const ms = (value) => (value < 10 ? value.toFixed(1) : String(Math.round(value)));
const saving = (lasso, baseline) => 1 - lasso / baseline;

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
<rect class="surface" x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="12"/>
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
  const savings = mcp.models.map((model) => saving(model.lasso.tokens, model.fileTools.tokens));
  const costs = mcp.models.map((model) => saving(model.lasso.cost, model.fileTools.cost));
  const tasks = mcp.models.reduce((sum, model) => sum + model.tasks, 0);
  const lassoCorrect = mcp.models.reduce((sum, model) => sum + model.lasso.correct, 0);
  const toolsCorrect = mcp.models.reduce((sum, model) => sum + model.fileTools.correct, 0);
  const range = (values) => `${percent(Math.min(...values)).slice(0, -1)}–${percent(Math.max(...values))}`;
  const tiles = [
    { value: range(savings), label: 'fewer agent tokens (MCP)' },
    { value: range(costs), label: 'lower model cost' },
    { value: `${lassoCorrect}/${tasks}`, label: `answers correct (${toolsCorrect} without)` },
    { value: `${ms(typing.wholeLibrary.score.latency.p50)} ms`, label: 'per keystroke, typing' },
  ];
  const tileWidth = (WIDTH - 2 * LEFT) / tiles.length;
  const body = tiles.map((tile, index) => {
    const x = LEFT + index * tileWidth;
    return `<rect class="accent" x="${x}" y="78" width="3" height="44" rx="1.5"/>` +
      text(x + 14, 106, tile.value, 'hero') + text(x + 14, 128, tile.label, 'hero-label');
  }).join('\n');
  write('summary.svg', frame(148, 'Lasso by the numbers',
    'AI agents: live OpenAI runs, provider-recorded usage. Typing: local benchmark on an Apple M3.', body,
    tiles.map((tile) => `${tile.value} ${tile.label}`).join('; ')));
}

// Total tokens for each model's run, file tools against Lasso.
function mcpTokensChart() {
  const plotLeft = LEFT + 150;
  const plotWidth = WIDTH - plotLeft - 230;
  const max = Math.max(...mcp.models.map((model) => model.fileTools.tokens));
  const scale = (value) => plotWidth * value / max;
  const groupHeight = 88;
  const top = 92;
  const groups = mcp.models.map((model, index) => {
    const y = top + index * groupHeight;
    const rows = [
      { run: model.fileTools, className: 'muted-bar' },
      { run: model.lasso, className: 'series-1' },
    ];
    const bars = rows.map((row, rowIndex) => {
      const barY = y + 8 + rowIndex * 22;
      const width = scale(row.run.tokens);
      return bar(plotLeft, barY, width, BAR, row.className) +
        text(plotLeft + width + 8, barY + BAR - 2, `${thousands(row.run.tokens)} tokens · ${row.run.correct}/${model.tasks} correct`, 'value');
    }).join('');
    const cut = percent(saving(model.lasso.tokens, model.fileTools.tokens));
    return text(LEFT, y + 20, model.model, 'strong') + text(LEFT, y + 36, `${model.tasks} tasks`, 'tick') +
      text(LEFT, y + 60, `${cut} fewer`, 'title') + bars;
  }).join('\n');
  const height = top + mcp.models.length * groupHeight + 20;
  const body = `${swatch(LEFT, 76, 'muted-bar', 'File tools only (Read, Grep, Glob)')}${swatch(250, 76, 'series-1', 'With the Lasso MCP server')}
<line class="axis" x1="${plotLeft}" x2="${plotLeft}" y1="${top}" y2="${height - 24}"/>
${groups}`;
  write('mcp-tokens.svg', frame(height, 'Tokens an AI agent spends to answer from your files', '', body,
    mcp.models.map((model) => `${model.model}: file tools ${model.fileTools.tokens} tokens, Lasso ${model.lasso.tokens} tokens`).join('; ')));
}

// Savings by kind of file, positive where Lasso used fewer tokens.
function mcpByFileChart() {
  const rows = mcp.byFileKind.rows.map((row) => ({ ...row, saving: saving(row.lasso, row.fileTools) }));
  const labelRight = LEFT + 236;
  const zero = labelRight + 64;
  const plotRight = WIDTH - 110;
  const scale = (fraction) => (plotRight - zero) * fraction;
  const top = 92;
  const rowHeight = 32;
  const height = top + rows.length * rowHeight + 38;
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
      bar(zero, y, width, BAR, positive ? 'series-1' : 'series-2') +
      text(positive ? zero + width + 8 : zero + 8, y + BAR - 2, label, 'value');
  }).join('\n');
  const body = `${swatch(LEFT, 76, 'series-1', 'Fewer tokens than file tools')}${swatch(230, 76, 'series-2', 'More tokens than file tools')}
${grid}
<line class="axis" x1="${zero}" x2="${zero}" y1="${top - 6}" y2="${top + rows.length * rowHeight}"/>
${bars}`;
  write('mcp-by-file.svg', frame(height, `Where the MCP saves tokens, by file (${mcp.byFileKind.model})`, '', body,
    rows.map((row) => `${row.kind}: ${percent(row.saving)} saving`).join('; ')));
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
  const height = top + rows.length * rowHeight + 38;
  const grid = [0, 20, 40, 60, 80, 100].map((value) => {
    const x = plotLeft + scale(value);
    return `<line class="grid" x1="${x}" x2="${x}" y1="${top - 4}" y2="${top + rows.length * rowHeight}"/>` +
      text(x, top + rows.length * rowHeight + 16, `${value} ms`, 'tick', 'middle');
  }).join('');
  const reference = plotLeft + scale(100);
  const bars = rows.map((row, index) => {
    const y = top + index * rowHeight + 5;
    return text(plotLeft - 12, y + 18, row.name, 'label', 'end') +
      bar(plotLeft, y, scale(row.latency.p50), 11, 'series-1') + bar(plotLeft, y + 13, scale(row.latency.p95), 11, 'series-2') +
      text(plotLeft + scale(Math.max(row.latency.p50, row.latency.p95)) + 8, y + 18,
        `${ms(row.latency.p50)} / ${ms(row.latency.p95)} ms`, 'value');
  }).join('\n');
  const body = `${swatch(LEFT, 76, 'series-1', 'Median')}${swatch(110, 76, 'series-2', '95th percentile')}
${grid}
<line class="reference" x1="${reference}" x2="${reference}" y1="${top - 8}" y2="${top + rows.length * rowHeight}"/>
${text(reference - 6, 76, '100 ms: feels instant', 'tick', 'end')}
<line class="axis" x1="${plotLeft}" x2="${plotLeft}" y1="${top - 4}" y2="${top + rows.length * rowHeight}"/>
${bars}`;
  write('latency.svg', frame(height, 'Time to show suggestions, per keystroke', '', body,
    rows.map((row) => `${row.name}: median ${row.latency.p50} ms, p95 ${row.latency.p95} ms`).join('; ')));
}

summaryCard();
mcpTokensChart();
mcpByFileChart();
latencyChart();
