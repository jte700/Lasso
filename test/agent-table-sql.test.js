import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSql, runSql, SqlError, tablesNamed } from '../src/agent/table-sql.js';
import { cellDate, cellNumber, typedTable } from '../src/agent/table-data.js';

// Two sheets as a workbook's reader gives them: every cell as the text written in it.
const ORDERS = typedTable({ name: 'Orders', headers: ['Order ID', 'Date', 'Customer', 'Region', 'Product', 'Qty', 'Unit Price', 'Discount', 'Net'],
  rows: [
    ['SO-001', '2025-01-14', 'Ashford', 'North', 'Valve', '10', '20.00', '0.0%', '200.00'],
    ['SO-002', '2025-02-03', 'Bexley', 'South', 'Pump', '2', '150.00', '10.0%', '270.00'],
    ['SO-003', '2025-04-21', 'Ashford', 'North', 'Pump', '1', '150.00', '0.0%', '150.00'],
    ['SO-004', '2025-07-09', 'Croydon', 'West', 'Valve', '5', '20.00', '0.0%', '100.00'],
    ['SO-005', '2025-10-30', 'Ashford', 'North', 'Filter', '4', '12.50', '0.0%', '50.00'],
    ['SO-002', '2025-11-02', 'Bexley', 'South', 'Valve', '3', '20.00', '0.0%', '61.00'],
  ], rowNumbers: [2, 3, 4, 5, 6, 7] });
const PRODUCTS = typedTable({ name: 'Products', headers: ['Product', 'Category', 'Unit Cost'],
  rows: [['Valve', 'Valves', '12.00'], ['Pump', 'Pumps', '90.00'], ['Gasket', 'Seals', '1.50']], rowNumbers: [2, 3, 4] });
const lookup = ({ table }) => ({ orders: ORDERS, products: PRODUCTS })[table.toLowerCase()] ?? null;
const run = (sql, options) => runSql(sql, lookup, options);

test('a query filters, groups, orders and limits over every row of its table', () => {
  // Arrange, act
  const byRegion = run('SELECT Region, SUM(Net) AS total, COUNT(*) AS orders FROM Orders GROUP BY Region ORDER BY total DESC');
  const big = run('SELECT "Order ID", Net FROM Orders WHERE Net >= 150 AND Region <> \'West\' ORDER BY Net DESC LIMIT 2');

  // Assert
  assert.deepEqual(byRegion.columns, ['Region', 'total', 'orders']);
  assert.deepEqual(byRegion.rows, [['North', 400, 3], ['South', 331, 2], ['West', 100, 1]]);
  assert.deepEqual(byRegion.scanned, [{ table: 'Orders', rows: 6 }], 'it says how many rows it read');
  assert.deepEqual(big.rows, [['SO-002', 270], ['SO-001', 200]], 'figures order as numbers, not as text');
  assert.equal(big.total, 3, 'how many rows there were before the limit');
  assert.deepEqual(big.written, [['SO-002', '270.00'], ['SO-001', '200.00']], 'beside each row, its plain columns as their cells are written');
  assert.equal(byRegion.written, null, 'a grouped row is worked out, not read from one cell');
});

test('GROUP BY 1 groups by the first selected column, and a quarter is read from a date', () => {
  // Arrange, act
  const quarters = run('SELECT QUARTER(Date) AS quarter, SUM(Net) FROM Orders WHERE YEAR(Date) = 2025 GROUP BY 1 ORDER BY 1');
  const months = run("SELECT strftime('%Y-%m', Date) AS month, COUNT(*) FROM Orders GROUP BY month HAVING COUNT(*) >= 1 ORDER BY month LIMIT 2");
  const extracted = run('SELECT EXTRACT(MONTH FROM Date) FROM Orders WHERE "Order ID" = \'SO-004\'');

  // Assert
  assert.deepEqual(quarters.rows, [[1, 470], [2, 150], [3, 100], [4, 111]]);
  assert.deepEqual(months.rows, [['2025-01', 1], ['2025-02', 1]]);
  assert.deepEqual(extracted.rows, [[7]]);
});

test('customers by the quarters they ordered in, repeated ids and a stored figure that disagrees with its parts are each one query', () => {
  // Arrange, act
  const everyQuarter = run('SELECT Customer FROM Orders GROUP BY Customer HAVING COUNT(DISTINCT QUARTER(Date)) = 3 ORDER BY Customer');
  const repeated = run('SELECT "Order ID", COUNT(*) AS times FROM Orders GROUP BY "Order ID" HAVING COUNT(*) > 1');
  const mismatched = run('SELECT order_id, ROW() AS row, Net, ROUND(Qty * unit_price * (1 - Discount), 2) AS expected FROM Orders '
    + 'WHERE ABS(Net - Qty * "Unit Price" * (1 - Discount)) > 0.005');

  // Assert
  assert.deepEqual(everyQuarter.rows, [['Ashford']]);
  assert.deepEqual(repeated.rows, [['SO-002', 2]]);
  assert.deepEqual(mismatched.rows, [['SO-002', 7, 61, 60]], 'a percentage is the fraction it stands for, and a column answers to its name written with an underscore');
});

test('a join on equal columns reads both tables, and a row without a match is kept only by LEFT JOIN', () => {
  // Arrange, act
  const margin = run('SELECT p.Category, SUM(o.Net - o.Qty * p."Unit Cost") AS margin FROM Orders o JOIN Products p ON o.Product = p.Product GROUP BY p.Category ORDER BY 1');
  const unmatched = run('SELECT o."Order ID" FROM Orders o LEFT JOIN Products p ON p.Product = o.Product WHERE p.Product IS NULL');
  const slow = run('SELECT COUNT(*) FROM Orders o JOIN Products p ON o.Product = p.Product OR 1 = 0');

  // Assert
  assert.deepEqual(margin.rows, [['Pumps', 150], ['Valves', 145]]);
  assert.deepEqual(margin.scanned, [{ table: 'Orders', rows: 6 }, { table: 'Products', rows: 3 }]);
  assert.deepEqual(unmatched.rows, [['SO-005']]);
  assert.deepEqual(slow.rows, [[5]], 'a join that is not a plain equality gives the same rows, pair by pair');
});

test('a query is read as models write it: two-word columns without quotes, JOIN … USING, and DATE_TRUNC', () => {
  // Arrange: the columns of the tables a query names are known before it is read.
  const columns = [...ORDERS.columns, ...PRODUCTS.columns].map((column) => column.name);
  const read = (sql) => runSql(sql, lookup, { columns });

  // Act
  const unquoted = read('SELECT Order ID, Unit Price FROM Orders WHERE Qty * Unit Price > 250 ORDER BY Order ID');
  const using = read('SELECT Category, SUM(Net - Qty * Unit Cost) AS margin, COUNT(Product) FROM Orders JOIN Products USING (Product) GROUP BY Category ORDER BY 1');
  const truncated = read("SELECT DATE_TRUNC('quarter', Date) AS q, COUNT(*) FROM Orders GROUP BY 1 ORDER BY 1");
  const aliased = read('SELECT Net amount FROM Orders WHERE Order ID = \'SO-004\'');

  // Assert
  assert.deepEqual(unquoted.rows, [['SO-002', 150]], 'Order ID is the column, though ORDER is also a word of the language');
  assert.deepEqual(using.rows, [['Pumps', 150, 2], ['Valves', 145, 3]], 'the column joined on is one column, not an ambiguous two');
  assert.deepEqual(truncated.rows, [['2025-01-01', 2], ['2025-04-01', 1], ['2025-07-01', 1], ['2025-10-01', 2]], 'a period is named by its first day');
  assert.deepEqual([aliased.columns, aliased.rows], [['amount'], [[100]]], 'two words that are no column are still a column and its alias');
  assert.throws(() => read("SELECT DATE_TRUNC('week', Date) FROM Orders"), /DATE_TRUNC\(\) reads 'year', 'quarter', 'month' or 'day'/);
});

test('a query in parentheses is a value or a list', () => {
  // Arrange, act
  const above = run('SELECT "Order ID" FROM Orders WHERE Net > (SELECT AVG(Net) FROM Orders) ORDER BY 1');
  const sold = run('SELECT Product FROM Products WHERE Product NOT IN (SELECT Product FROM Orders)');

  // Assert
  assert.deepEqual(above.rows, [['SO-001'], ['SO-002'], ['SO-003']]);
  assert.deepEqual(sold.rows, [['Gasket']]);
  assert.throws(() => run('SELECT (SELECT Net FROM Orders) FROM Products'), /returned 6 rows/);
});

test('text is never treated as a number: the query fails naming the text, and NUMBER() leaves it out when asked', () => {
  // Arrange
  const mixed = typedTable({ name: 'Readings', headers: ['Site', 'Value'], rows: [['A', '4'], ['B', 'n/a'], ['C', '6'], ['D', '']], rowNumbers: [2, 3, 4, 5] });
  const read = (sql) => runSql(sql, () => mixed);

  // Act and assert
  assert.throws(() => read('SELECT SUM(Value) FROM Readings'), (error) => error instanceof SqlError && /met the text "n\/a"/.test(error.message) && /NUMBER\(/.test(error.message));
  assert.deepEqual(read('SELECT SUM(NUMBER(Value)), COUNT(NUMBER(Value)), COUNT(*) FROM Readings').rows, [[10, 2, 4]], 'an empty cell is no value, not zero');
  assert.throws(() => read('SELECT Site FROM Readings WHERE YEAR(Site) = 2025'), /YEAR\(\) met the text "A", which is not a date/);
  assert.throws(() => read('SELECT Site + 1 FROM Readings'), /met the text/);
});

test('what is asked for by a wrong name is answered with the names there are', () => {
  // Arrange, act and assert
  assert.throws(() => run('SELECT Amount FROM Orders'), /no column named Amount; columns are Order ID, Date, Customer, Region, Product, Qty, Unit Price, Discount, Net/);
  assert.throws(() => run('SELECT Product FROM Orders o JOIN Products p ON o.Product = p.Product'), /column Product is ambiguous; qualify it with a table name/);
  assert.throws(() => run('SELECT 1 FROM Returns'), /no table named Returns/);
  assert.deepEqual(run('SELECT COUNT(*) FROM Orders WHERE Region = "North"').rows, [[3]], 'a double-quoted word that is no column is text, as SQLite reads it');
  assert.deepEqual(tablesNamed(parseSql('SELECT 1 FROM "Operations 2025.xlsx".Orders o JOIN Products p ON 1 = 1 WHERE o.Net > (SELECT MAX(Net) FROM Returns)')),
    [{ file: 'Operations 2025.xlsx', table: 'Orders' }, { file: null, table: 'Products' }, { file: null, table: 'Returns' }]);
});

test('what this SQL does not have is refused by name, and work beyond the local limit is refused, never cut short', () => {
  // Arrange, act and assert
  assert.throws(() => run('WITH q AS (SELECT 1 FROM Orders) SELECT * FROM q'), /WITH is not supported/);
  assert.throws(() => run('SELECT Region FROM Orders UNION SELECT Category FROM Products'), /UNION is not supported/);
  assert.throws(() => run('SELECT SUM(Net) OVER (PARTITION BY Region) FROM Orders'), /window functions .* are not supported/);
  assert.throws(() => run('SELECT MEDIAN(Net) FROM Orders'), /unsupported function MEDIAN\(\); the functions are /);
  assert.throws(() => run('SELECT COUNT(*) FROM Orders a JOIN Orders b ON a.Net < b.Net', { maxWork: 20 }), /over the local limit/);
  assert.throws(() => run('DELETE FROM Orders'), /expected SELECT/);
});

test('cells are read as written: figures with separators, percentages, codes that keep their zeros, and dates in the ways people write them', () => {
  // Arrange
  const table = typedTable({ name: 'Ledger', headers: ['Code', 'Amount', 'Share', 'Paid', '', 'Amount'],
    rows: [['007', '1,234.50', '12.5%', '14 March 2025', 'x', '1'], ['012', '$2,000', '7%', 'Mar 15, 2025', '', '2'], ['100', '-3', '', '2025/03/16', '', '']], rowNumbers: [2, 3, 4] });
  const slashes = typedTable({ name: 'Visits', headers: ['Seen', 'Due'], rows: [['03/04/2025', '13/04/2025'], ['05/06/2025', '01/05/2025']], rowNumbers: [2, 3] });

  // Act
  const kinds = Object.fromEntries(table.columns.map((column) => [column.name, column.kind]));

  // Assert
  assert.deepEqual(kinds, { Code: 'text', Amount: 'number', Share: 'percent', Paid: 'date', 'Column E': 'text', 'Amount 2': 'number' },
    'a column without a heading is named by its letter, and a heading used twice is numbered');
  assert.deepEqual(table.rows[0], ['007', 1234.5, 0.125, '2025-03-14', 'x', 1]);
  assert.deepEqual(table.rows[2], ['100', -3, null, '2025-03-16', null, null]);
  assert.deepEqual(slashes.columns.map((column) => column.kind), ['text', 'date'], 'day and month are told apart only when the column settles it');
  assert.deepEqual(slashes.rows.map((row) => row[1]), ['2025-04-13', '2025-05-01']);
  assert.deepEqual([cellNumber('1,234'), cellNumber('12 apples'), cellNumber('0.50'), cellNumber('1e3'), cellNumber('0012')], [1234, null, 0.5, 1000, null]);
  assert.deepEqual([cellDate('2025-01-02T10:00:00Z'), cellDate('January 2025'), cellDate('31 Feb 2025')], ['2025-01-02', null, null]);
});
