import test from 'node:test';
import assert from 'node:assert/strict';
import { openEngine } from '../src/agent/engine.js';
import { formatAnswer } from '../src/agent/render.js';
import { askTextOptions } from '../src/agent/mcp.js';
import { agentLibrary } from './fixtures/agent-library.js';
import { xlsxFile } from '../scripts/agent-eval/build.mjs';

// A year of orders, more rows than the index keeps as cells, and the products they name. One order's stored Net is
// off by one, and the last order repeats the first one's id: what only a reading of every row finds.
const PRICES = { Valve: 20, Pump: 150, Filter: 12.5 };
const ORDERS = Array.from({ length: 1200 }, (_, index) => {
  const product = ['Valve', 'Pump', 'Filter'][index % 3];
  const qty = (index % 7) + 1;
  const date = new Date(Date.UTC(2025, 0, 1 + Math.floor((index * 365) / 1200))).toISOString().slice(0, 10);
  return { id: index === 1199 ? 'SO-00001' : `SO-${String(index + 1).padStart(5, '0')}`, date, customer: ['Ashford', 'Bexley', 'Croydon', 'Dartford', 'Enfield'][index % 5],
    region: ['North', 'South', 'West', 'East'][index % 4], product, qty, price: PRICES[product], net: qty * PRICES[product] + (index === 99 ? 1 : 0) };
});
const WORKBOOK = xlsxFile([
  { name: 'Orders', header: ['Order ID', 'Date', 'Customer', 'Region', 'Product', 'Qty', 'Unit Price', 'Net'],
    rows: ORDERS.map((order) => [order.id, order.date, order.customer, order.region, order.product, String(order.qty), String(order.price), String(order.net)]) },
  { name: 'Products', header: ['Product', 'Category', 'Unit Cost'], rows: [['Valve', 'Valves', '12'], ['Pump', 'Pumps', '90'], ['Filter', 'Filters', '5'], ['Gasket', 'Seals', '1.5']] },
]);
const sumBy = (key, value = (order) => order.net) => {
  const totals = new Map();
  for (const order of ORDERS) totals.set(key(order), (totals.get(key(order)) ?? 0) + value(order));
  return [...totals.entries()].sort(([left], [right]) => (left < right ? -1 : 1));
};
const quarterOf = (order) => Math.ceil(Number(order.date.slice(5, 7)) / 3);

async function library(t, scope = ['*']) {
  const { dataDir } = await agentLibrary(t, { extra: { 'Finance/Operations 2025.xlsx': WORKBOOK } });
  const engine = openEngine({ dataDir, scope });
  t.after(() => engine.close());
  // As the MCP server asks: whole-table operations are for a model over MCP.
  const ask = (...asks) => engine.evidence.ask({ ask: asks }, null, { mcp: true });
  const text = (response) => formatAnswer('ask', response, 'text', askTextOptions(['lasso']));
  return { engine, ask, text };
}

test('a SELECT is answered from every row of a sheet, says how many it read, and joins the workbook\'s other sheet', async (t) => {
  // Arrange
  const { ask, text } = await library(t);

  // Act
  const response = ask('SELECT Region, SUM(Net) AS total FROM Orders GROUP BY Region ORDER BY Region',
    'SELECT p.Category, SUM(o.Net - o.Qty * p."Unit Cost") AS margin FROM Orders o JOIN Products p ON o.Product = p.Product GROUP BY p.Category ORDER BY 1',
    'SELECT COUNT(*) FROM Orders WHERE Region = \'Central\'');
  const [byRegion, margin, none] = response.answers;
  const costs = { Valve: 12, Pump: 90, Filter: 5 };

  // Assert
  assert.deepEqual([byRegion.kind, byRegion.status, byRegion.items[0].type], ['computed', 'complete', 'query']);
  assert.deepEqual(byRegion.items[0].rows, sumBy((order) => order.region));
  assert.deepEqual(byRegion.items[0].tables.map((table) => [table.name, table.rows]), [['Orders', 1200]], 'every row, not the first ones the index keeps as cells');
  assert.deepEqual(margin.items[0].rows, sumBy((order) => ({ Valve: 'Valves', Pump: 'Pumps', Filter: 'Filters' })[order.product], (order) => order.net - order.qty * costs[order.product]));
  assert.deepEqual(margin.items[0].tables.map((table) => [table.name, table.rows]), [['Orders', 1200], ['Products', 4]]);
  assert.deepEqual(none.items[0].rows, [[0]]);
  assert.match(text(response), /^\[1\] s1 Orders: 4 rows, over all 1,200 rows\n {2}Region \| total\n {2}East \| \d+(?:\.\d+)?\n/m);
  assert.match(text(response), /^\[2\] s1 Orders, Products: 3 rows, over all 1,200 rows of Orders and all 4 of Products$/m);
});

test('the rows that repeat and the stored figure that disagrees with its parts are found, and finding none is an exact answer', async (t) => {
  // Arrange
  const { ask, text } = await library(t);

  // Act
  const response = ask('SELECT "Order ID", COUNT(*) AS times FROM Orders GROUP BY 1 HAVING COUNT(*) > 1',
    'SELECT "Order ID", ROW() AS row, Net FROM Orders WHERE ABS(Net - Qty * "Unit Price") > 0.005',
    'SELECT "Order ID" FROM Orders WHERE Qty > 7');
  const [repeated, mismatched, absent] = response.answers.map((answer) => answer.items[0]);

  // Assert
  assert.deepEqual(repeated.rows, [['SO-00001', 2]]);
  assert.deepEqual(mismatched.rows, [['SO-00100', 101, String(ORDERS[99].net)]], 'the sheet row it is on, and the figure as its cell has it');
  assert.deepEqual([absent.rows, absent.total, response.answers[2].status], [[], 0, 'complete']);
  assert.match(text(response), /^\[3\] s1 Orders: no rows, over all 1,200 rows$/m);
});

test('a total by quarter or by a column, a count per value and repeated ids are answered from plain words, with the query that was run', async (t) => {
  // Arrange
  const { ask, text } = await library(t);

  // Act
  const response = ask('total Net by quarter of 2025 in Operations 2025.xlsx', 'sum of Net grouped by Region in the Orders sheet',
    'number of orders per Customer in Operations 2025.xlsx', 'duplicate Order IDs in Operations 2025.xlsx', 'average Qty for each Product in Operations 2025.xlsx');
  const [quarters, regions, customers, repeated, quantities] = response.answers.map((answer) => answer.items[0]);

  // Assert
  assert.deepEqual(response.answers.map((answer) => [answer.kind, answer.status]), Array(5).fill(['computed', 'complete']));
  assert.deepEqual(quarters.rows, sumBy(quarterOf).map(([quarter, total]) => [`Q${quarter}`, total]));
  assert.match(quarters.ran, /^SELECT .*QUARTER\("Date"\).*SUM\("Net"\).*FROM "Orders" WHERE YEAR\("Date"\) = 2025 GROUP BY/);
  assert.deepEqual(regions.rows, sumBy((order) => order.region));
  assert.deepEqual(customers.rows, sumBy((order) => order.customer, () => 1));
  assert.deepEqual(repeated.rows, [['SO-00001', 2]]);
  assert.deepEqual(quantities.rows.map(([product]) => product), ['Filter', 'Pump', 'Valve']);
  assert.match(text(response), /^\[1\] s1 Orders: 4 rows, over all 1,200 rows\n {2}ran: SELECT /m);
});

test('a table two files have is never chosen between, a table no file has is answered with those there are, and a folder not shared has none', async (t) => {
  // Arrange
  const { ask } = await library(t);
  const { ask: outside } = await library(t, ['Api']);

  // Act
  const response = ask('SELECT Division, Revenue FROM budget', 'SELECT Division, Revenue FROM "Approved/budget.csv"', 'SELECT 1 FROM Returns',
    'SELECT Amount FROM Orders');
  const [shared, approved, missing, column] = response.answers;
  const [hidden] = outside('SELECT COUNT(*) FROM Orders').answers;

  // Assert
  assert.deepEqual([shared.kind, shared.error.code], ['error', 'ambiguous']);
  assert.deepEqual(shared.error.matches.map((match) => `${match.folder}/${match.path}`).sort(), ['Finance/Approved/budget.csv', 'Finance/Planning/budget.csv']);
  assert.deepEqual(approved.items[0].rows, [['North division', '11.9']], 'its folder settles which');
  assert.deepEqual([missing.kind, missing.error.code], ['error', 'not_found']);
  assert.ok(missing.error.similar.includes('Orders') && missing.error.similar.includes('Products'), JSON.stringify(missing.error));
  assert.match(column.error.message, /no column named Amount; columns are Order ID, Date, Customer, Region, Product, Qty, Unit Price, Net/);
  assert.deepEqual([hidden.kind, hidden.error.code], ['error', 'not_found'], 'authorization comes before the table is looked for');
});

test('a file named before a query, or with it, settles which table is meant', async (t) => {
  // Arrange
  const { ask } = await library(t);

  // Act
  const response = ask('Finance/Planning/budget.csv: SELECT Division, Revenue FROM budget ORDER BY Revenue DESC');
  const structured = (await library(t)).engine.evidence.ask({ ask: [{ sql: 'SELECT COUNT(*) AS divisions FROM budget', file: 'Approved/budget.csv' },
    { sql: 'SELECT COUNT(*) FROM Products', file: 'Operations 2025.xlsx' }, 'Operations 2025.xlsx: SELECT COUNT(*) FROM "Operations 2025"'] }, null, { mcp: true });
  const [approved, products, whole] = structured.answers;

  // Assert
  assert.deepEqual(response.answers[0].items[0].rows, [['North division', '12.4'], ['South division', '9.10']], 'a column read as it stands keeps its cells as written: 9.10, not 9.1');
  assert.deepEqual(approved.items[0].rows, [[1]]);
  assert.deepEqual(products.items[0].rows, [[4]]);
  assert.deepEqual([whole.kind, whole.error.code], ['error', 'ambiguous'], 'a workbook of several sheets named as a table lists its sheets');
  assert.deepEqual(whole.error.matches.map((match) => match.sheet), ['Orders', 'Products']);
});

test('the queries a model wrote in the live run are answered: unquoted two-word columns, USING, and a file named after the query', async (t) => {
  // Arrange
  const { ask } = await library(t);

  // Act
  const response = ask('SELECT Order ID, Qty, Unit Price, Net FROM Orders WHERE ABS(Net - Qty * Unit Price) > 0.01',
    'SELECT Category, SUM(Net - Qty * Unit Cost) AS GrossMargin FROM Orders JOIN Products USING (Product) GROUP BY Category ORDER BY GrossMargin DESC',
    'SELECT Region, SUM(Net) AS NetSales FROM Orders GROUP BY Region ORDER BY Region in Finance/Operations 2025.xlsx',
    "SELECT Customer, DATE_TRUNC('quarter', Date) AS q FROM Orders GROUP BY Customer, q HAVING COUNT(*) >= 100");
  const [mismatched, margin, regions, quarters] = response.answers;

  // Assert
  assert.deepEqual(response.answers.map((answer) => answer.kind), ['computed', 'computed', 'computed', 'computed'], JSON.stringify(response.answers.map((answer) => answer.error?.message)));
  assert.deepEqual(mismatched.items[0].rows, [['SO-00100', String(ORDERS[99].qty), String(ORDERS[99].price), String(ORDERS[99].net)]]);
  assert.deepEqual(margin.items[0].rows.map((row) => row[0]), ['Pumps', 'Valves', 'Filters']);
  assert.deepEqual(regions.items[0].rows, sumBy((order) => order.region));
  assert.deepEqual(quarters.items[0].total, 0);
});

test('a filter, a count of each value, a measure by a column and a named sheet\'s total are answered from plain words', async (t) => {
  // Arrange
  const { ask } = await library(t);
  const north = ORDERS.filter((order) => order.region === 'North');

  // Act
  const response = ask('Finance/Operations 2025.xlsx count of Orders rows where Region = North', 'Finance/Operations 2025.xlsx total Net for Orders rows where Region is North',
    'Finance/Operations 2025.xlsx Orders rows where Customer is blank', 'Finance/Operations 2025.xlsx distinct Region values in Orders with counts',
    'Finance/Operations 2025.xlsx Orders Net by Region', 'Finance/Operations 2025.xlsx Orders sheet SUM of Net column over every row',
    'Finance/Operations 2025.xlsx Orders rows where Order ID = SO-00007, with Customer and Net');
  const [count, total, blank, values, byRegion, whole, rows] = response.answers.map((answer) => answer.items?.[0]);

  // Assert
  assert.deepEqual(response.answers.map((answer) => [answer.kind, answer.status]), Array(7).fill(['computed', 'complete']), JSON.stringify(response.answers.map((answer) => answer.kind)));
  assert.deepEqual(count.rows, [[north.length]]);
  assert.match(count.ran, /^SELECT COUNT\(\*\) AS rows FROM "Orders" WHERE "Region" = 'North'$/);
  assert.deepEqual(total.rows, [[north.reduce((sum, order) => sum + order.net, 0)]]);
  assert.deepEqual([blank.total, blank.tables[0].rows], [0, 1200], 'no row has a blank Customer, said of every row');
  assert.deepEqual(values.rows, sumBy((order) => order.region, () => 1).sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1)));
  assert.deepEqual(byRegion.rows, sumBy((order) => order.region));
  assert.deepEqual(whole.rows, [[ORDERS.reduce((sum, order) => sum + order.net, 0)]]);
  assert.deepEqual(rows.rows, [[ORDERS[6].customer, String(ORDERS[6].net)]]);
});

test('an ask that wants something worked out is shown a table\'s header and two rows, and told its tables\' columns before anything else', async (t) => {
  // Arrange
  const { ask, text } = await library(t);

  // Act
  const response = ask('Finance/Operations 2025.xlsx: identify every customer who ordered in each quarter, with the rows that support it');
  const [answer] = response.answers;
  const lines = text(response).split('\n');
  const orders = answer.items.find((item) => item.type === 'table' && item.sheet === 'Orders');

  // Assert
  assert.deepEqual(answer.query_tables[0], { name: 'Orders', rows: 1200, columns: ['Order ID', 'Date', 'Customer', 'Region', 'Product', 'Qty', 'Unit Price', 'Net'] });
  assert.equal(lines[2], '  (a query reads every row: ask "SELECT … FROM Orders", with WHERE, GROUP BY or JOIN; Orders has 1,200 rows: Order ID, Date, Customer, Region, Product, Qty, Unit Price, Net; '
    + 'Products 4: Product, Category, Unit Cost)', 'said second, before the rows');
  assert.equal(orders.rows.length, 2, 'two rows show how its cells are written; the rest is for a query');
  assert.ok(orders.more_rows > 0);
});

test('a file named with words it does not have shows two rows of a long table, not sixty', async (t) => {
  // Arrange
  const { ask } = await library(t);

  // Act
  const [answer] = ask('Finance/Operations 2025.xlsx reconciliation variance').answers;
  const orders = answer.items.find((item) => item.type === 'table' && item.sheet === 'Orders');
  const products = answer.items.find((item) => item.type === 'table' && item.sheet === 'Products');

  // Assert
  assert.deepEqual([answer.kind, answer.absent], ['digest', ['reconciliation', 'variance']]);
  assert.equal(orders.rows.length, 2);
  assert.equal(products.rows.length, 4, 'a short table is shown whole');
  assert.ok(answer.query_tables.length);
});

test('a cell named as a spreadsheet names it is read exactly, with its row and column where it has them', async (t) => {
  // Arrange
  const { ask, text } = await library(t);

  // Act
  const response = ask('Finance/Operations 2025.xlsx Orders!H101', 'Operations 2025.xlsx Products!B2:C3', 'Operations 2025.xlsx Orders!H1', 'Operations 2025.xlsx Returns!A1');
  const [cell, range, header, missing] = response.answers;

  // Assert
  assert.deepEqual([cell.kind, cell.status], ['cells', 'complete']);
  assert.deepEqual(cell.items[0].cells, [{ at: 'H101', column: 'Net', row: 'SO-00100', value: String(ORDERS[99].net) }]);
  assert.deepEqual(range.items[0].cells.map((entry) => [entry.at, entry.column, entry.row, entry.value]),
    [['B2', 'Category', 'Valve', 'Valves'], ['C2', 'Unit Cost', 'Valve', '12'], ['B3', 'Category', 'Pump', 'Pumps'], ['C3', 'Unit Cost', 'Pump', '90']]);
  assert.match(text(response), /^\[1\] s1 Orders!H101 "Net" of "SO-00100": "\d+(?:\.\d+)?"$/m);
  assert.deepEqual(header.items[0].cells, [{ at: 'H1', value: 'Net' }], 'a workbook\'s cell outside its table is read too: the header row has no row label or column of its own');
  assert.notEqual(missing.kind, 'cells', 'a sheet no file has is not a cell to read: the ask is answered as any other');
});

test('a row found by its name is cited at the row the sheet shows it in', async (t) => {
  // Arrange
  const { ask } = await library(t);

  // Act
  const [record] = ask('Net of SO-00100').answers;

  // Assert
  assert.deepEqual(record.items.map((item) => [item.row, item.at]), [['SO-00100', 'Orders!101:101']],
    'the header is row 1, so the hundredth order is row 101');
});

test('a result too long to send whole is cut, says so, and is partial; a table shown in part says how to ask about all of it', async (t) => {
  // Arrange
  const { ask, text } = await library(t);

  // Act
  const response = ask('SELECT "Order ID", Net FROM Orders ORDER BY ROW()', 'Operations 2025.xlsx');
  const [long, digest] = response.answers;
  const lean = text(response);

  // Assert
  assert.equal(long.status, 'partial');
  assert.ok(long.items[0].rows.length < 1200 && long.items[0].more_rows === 1200 - long.items[0].rows.length);
  assert.deepEqual(long.items[0].rows[0], ['SO-00001', String(ORDERS[0].net)]);
  assert.match(lean, /^\[1\] s1 Orders: first \d+ of 1,200 rows, over all 1,200 rows; LIMIT and OFFSET give the rest$/m);
  assert.equal(digest.kind, 'digest');
  assert.deepEqual(digest.query_tables.map((table) => [table.name, table.rows]), [['Orders', 1200], ['Products', 4]]);
  assert.match(lean, /^ {2}\(a query reads every row: ask "SELECT … FROM Orders", with WHERE, GROUP BY or JOIN; Orders has 1,200 rows: Order ID, Date, [^;]+; Products 4: Product, Category, Unit Cost\)$/m);
  assert.doesNotMatch(formatAnswer('ask', response), /a query reads/, 'the text REST asks for has no such line');
});

test('whole-table operations are for a model over MCP: the same asks sent any other way are answered as before', async (t) => {
  // Arrange
  const { engine, ask } = await library(t);
  const asks = ['SELECT Region, SUM(Net) FROM Orders GROUP BY Region', 'total Net by quarter of 2025 in Operations 2025.xlsx'];

  // Act
  const overMcp = ask(...asks);
  const otherwise = engine.evidence.ask({ ask: asks });
  const digest = engine.evidence.ask({ ask: ['Operations 2025.xlsx'] });

  // Assert
  assert.deepEqual(overMcp.answers.map((answer) => answer.items?.[0]?.type), ['query', 'query']);
  assert.ok(otherwise.answers.every((answer) => !(answer.items ?? []).some((item) => item.type === 'query')), JSON.stringify(otherwise.answers.map((answer) => answer.kind)));
  assert.ok(!JSON.stringify(digest).includes('query_tables'));
});
