// A restricted SQL over tables read whole: how an agent asks for what no
// excerpt can show, a total by group, a filter, a join, the rows that repeat.
// One SELECT [DISTINCT] … FROM t [JOIN u ON …] WHERE … GROUP BY … HAVING …
// ORDER BY … LIMIT n [OFFSET m], with a query in parentheses as a value or a
// list. Every query reads every row of its tables, and says how many.
//
// Two rules keep an answer from being wrong without saying so. Text is never
// a number: arithmetic, SUM or AVG over text is an error that names the
// text, and so is a date function on text that is no date, so a mistyped
// query cannot come back as an exact empty result. And work is bounded: a
// join or scan past the limit is refused, never cut short.
//
// The evaluator began in the operation-preserving trial, where a model used
// it live on whole-workbook tasks; the two rules come from its misses there.
// What it accepts beyond that is what a model wrote in the live run of 12
// November 2026 and was refused for: a column of two words without quotes
// (Unit Price), JOIN … USING (…), and DATE_TRUNC.

export class SqlError extends Error {
  constructor(message) { super(message); this.code = 'invalid'; }
}

/** A table's or column's name as a query may write it: "Unit Price", unit_price and UnitPrice are one name. */
export const normalizeName = (name) => String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const SHAPE = 'one SELECT with JOIN, WHERE, GROUP BY, HAVING, ORDER BY and LIMIT, and a query in parentheses as a value or a list';
const FUNCTIONS = 'COUNT SUM AVG MIN MAX GROUP_CONCAT, ROUND ABS NUMBER, UPPER LOWER TRIM LENGTH SUBSTR CONCAT, COALESCE NULLIF IIF, YEAR QUARTER MONTH DAY DATE DATE_TRUNC STRFTIME, ROW, and for a sheet\'s cells FORMULA KIND CALC ADDRESS';
// Row pairs compared and rows read by one query, at most: about a second of work.
const MAX_WORK = 20_000_000;

// ── reading the query ───────────────────────────────────────────────────────

const KEYWORDS = new Set(['SELECT', 'DISTINCT', 'FROM', 'JOIN', 'INNER', 'LEFT', 'OUTER', 'ON', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'ASC', 'DESC',
  'LIMIT', 'OFFSET', 'AS', 'AND', 'OR', 'NOT', 'LIKE', 'IN', 'BETWEEN', 'IS', 'NULL', 'TRUE', 'FALSE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END']);
const NOT_HERE = { WITH: 'WITH', UNION: 'UNION', EXCEPT: 'EXCEPT', INTERSECT: 'INTERSECT', WINDOW: 'WINDOW' };

function tokenize(text) {
  const tokens = [];
  const pattern = /\s+|--[^\n]*|(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)|'((?:[^']|'')*)'|"((?:[^"]|"")*)"|`([^`]*)`|\[([^\]]*)\]|([\p{L}_][\p{L}\p{N}_]*)|(<=|>=|<>|!=|==|\|\||[-+*/%=<>(),.;])/guy;
  let index = 0;
  while (index < text.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(text);
    if (!match) throw new SqlError(`cannot read the query at "${text.slice(index, index + 15)}"`);
    index = pattern.lastIndex;
    if (match[1] !== undefined) tokens.push({ kind: 'num', value: Number(match[1]) });
    else if (match[2] !== undefined) tokens.push({ kind: 'str', value: match[2].replace(/''/g, "'") });
    else if (match[3] !== undefined) tokens.push({ kind: 'id', value: match[3].replace(/""/g, '"'), quoted: true });
    else if (match[4] !== undefined) tokens.push({ kind: 'id', value: match[4] });
    else if (match[5] !== undefined) tokens.push({ kind: 'id', value: match[5] });
    else if (match[6] !== undefined) {
      const upper = match[6].toUpperCase();
      tokens.push(KEYWORDS.has(upper) ? { kind: 'kw', value: upper } : { kind: 'id', value: match[6], bare: true });
    } else if (match[7] !== undefined) tokens.push({ kind: 'op', value: match[7] });
  }
  while (tokens.at(-1)?.kind === 'op' && tokens.at(-1).value === ';') tokens.pop();
  return tokens;
}

const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'GROUP_CONCAT', 'STRING_AGG', 'TOTAL']);
const NUMBER_TYPES = new Set(['INTEGER', 'INT', 'BIGINT', 'REAL', 'FLOAT', 'DOUBLE', 'NUMERIC', 'DECIMAL', 'NUMBER']);
const DATE_PARTS = new Set(['YEAR', 'QUARTER', 'MONTH', 'DAY']);

/**
 * Words written one after another that together are a known column's name become that column: `Unit Price`,
 * `Order ID` (though ORDER is also a word of the language). The longest name wins, and a column's name is preferred
 * to reading the second word as an alias. Only names made of plain words are joined; any other needs its quotes.
 */
function joinColumnWords(tokens, columns) {
  const plain = /^[\p{L}_][\p{L}\p{N}_]*$/u;
  const named = [...new Set(columns.map(String))].map((name) => ({ name, words: name.trim().toLowerCase().split(/\s+/) }))
    .filter((column) => column.words.length > 1 && column.words.every((word) => plain.test(word)))
    .sort((left, right) => right.words.length - left.words.length);
  if (!named.length) return tokens;
  const wordAt = (token) => (token && (token.kind === 'kw' || token.bare) ? String(token.value).toLowerCase() : null);
  const joined = [];
  for (let at = 0; at < tokens.length;) {
    const column = named.find((candidate) => candidate.words.every((word, offset) => wordAt(tokens[at + offset]) === word));
    if (column) { joined.push({ kind: 'id', value: column.name }); at += column.words.length; } else { joined.push(tokens[at]); at += 1; }
  }
  return joined;
}

/** The tables a query's text names after FROM and JOIN, read before the query is: their columns are what its words are joined by. */
export function tablesWritten(text) {
  const tokens = tokenize(String(text ?? ''));
  const named = [];
  tokens.forEach((token, at) => {
    if (token.kind !== 'kw' || !['FROM', 'JOIN'].includes(token.value) || tokens[at + 1]?.kind !== 'id') return;
    const qualified = tokens[at + 2]?.kind === 'op' && tokens[at + 2].value === '.' && tokens[at + 3]?.kind === 'id';
    named.push(qualified ? { file: tokens[at + 1].value, table: tokens[at + 3].value } : { file: null, table: tokens[at + 1].value });
  });
  return named;
}

/**
 * The query as a tree. A syntax this SQL does not have is refused by name. `columns` are the names of the columns
 * of the tables it reads, when known, so that a name of two words can be written without quotes.
 */
export function parseSql(text, { columns = [] } = {}) {
  const tokens = joinColumnWords(tokenize(String(text ?? '')), columns);
  let position = 0;
  const peek = (offset = 0) => tokens[position + offset];
  const take = () => tokens[position++];
  const is = (kind, value) => peek()?.kind === kind && (value === undefined || peek().value === value);
  const accept = (kind, value) => (is(kind, value) ? take() : null);
  const near = () => (peek() ? String(peek().value) : 'the end of the query');
  const word = (offset = 0) => (peek(offset)?.bare ? peek(offset).value.toUpperCase() : null);
  const refuse = () => {
    if (NOT_HERE[word()]) throw new SqlError(`${NOT_HERE[word()]} is not supported here; this SQL is ${SHAPE}`);
  };
  const expect = (kind, value) => {
    if (!is(kind, value)) { refuse(); throw new SqlError(`expected ${value ?? (kind === 'id' ? 'a name' : kind)} near "${near()}"`); }
    return take();
  };

  const primary = () => {
    if (accept('op', '(')) {
      if (is('kw', 'SELECT')) { const query = select(); expect('op', ')'); return { type: 'subquery', query }; }
      const inner = expression();
      expect('op', ')');
      return inner;
    }
    if (is('num')) return { type: 'lit', value: take().value };
    if (is('str')) return { type: 'lit', value: take().value };
    if (accept('kw', 'NULL')) return { type: 'lit', value: null };
    if (accept('kw', 'TRUE')) return { type: 'lit', value: true };
    if (accept('kw', 'FALSE')) return { type: 'lit', value: false };
    if (accept('kw', 'CASE')) {
      const subject = is('kw', 'WHEN') ? null : expression();
      const branches = [];
      while (accept('kw', 'WHEN')) {
        const when = expression();
        expect('kw', 'THEN');
        branches.push({ when, then: expression() });
      }
      const otherwise = accept('kw', 'ELSE') ? expression() : { type: 'lit', value: null };
      expect('kw', 'END');
      return { type: 'case', subject, branches, otherwise };
    }
    if (is('id')) {
      const name = take();
      if (name.bare && is('op', '(')) {
        take();
        const fn = name.value.toUpperCase();
        if (accept('op', ')')) return { type: 'call', name: fn, args: [] };
        if (fn === 'COUNT' && accept('op', '*')) { expect('op', ')'); return over({ type: 'agg', name: 'COUNT', star: true }); }
        // CAST(x AS REAL) and EXTRACT(MONTH FROM d) are written with a word inside.
        if (fn === 'CAST') {
          const value = expression();
          expect('kw', 'AS');
          const type = expect('id').value.toUpperCase();
          if (accept('op', '(')) { while (!accept('op', ')')) take(); }
          expect('op', ')');
          return { type: 'call', name: NUMBER_TYPES.has(type) ? 'TO_NUMBER' : 'TO_TEXT', args: [value] };
        }
        if (fn === 'EXTRACT' && DATE_PARTS.has(word()) && peek(1)?.kind === 'kw' && peek(1).value === 'FROM') {
          const part = take().value.toUpperCase();
          take();
          const value = expression();
          expect('op', ')');
          return { type: 'call', name: part, args: [value] };
        }
        const distinct = Boolean(accept('kw', 'DISTINCT'));
        const args = [expression()];
        while (accept('op', ',')) args.push(expression());
        expect('op', ')');
        // MIN and MAX of several values are the least and greatest of them, not an aggregate.
        if ((fn === 'MIN' || fn === 'MAX') && args.length > 1) return { type: 'call', name: fn === 'MIN' ? 'LEAST' : 'GREATEST', args };
        if (AGGREGATES.has(fn)) return over({ type: 'agg', name: fn === 'STRING_AGG' ? 'GROUP_CONCAT' : fn === 'TOTAL' ? 'SUM' : fn, distinct, args });
        return over({ type: 'call', name: fn, args });
      }
      if (accept('op', '.')) {
        const column = expect('id');
        return { type: 'col', table: name.value, name: column.value };
      }
      return { type: 'col', table: null, name: name.value, ...(name.quoted ? { quoted: true } : {}) };
    }
    refuse();
    throw new SqlError(`unexpected "${near()}"`);
  };
  const over = (node) => {
    if (word() === 'OVER') throw new SqlError(`window functions (OVER) are not supported here; this SQL is ${SHAPE}`);
    return node;
  };
  const unary = () => {
    if (accept('op', '-')) return { type: 'neg', arg: unary() };
    if (accept('op', '+')) return unary();
    return primary();
  };
  const multiplicative = () => {
    let left = unary();
    while (is('op', '*') || is('op', '/') || is('op', '%')) left = { type: 'bin', op: take().value, left, right: unary() };
    return left;
  };
  const additive = () => {
    let left = multiplicative();
    while (is('op', '+') || is('op', '-') || is('op', '||')) left = { type: 'bin', op: take().value, left, right: multiplicative() };
    return left;
  };
  const wrapNot = (negated, node) => (negated ? { type: 'not', arg: node } : node);
  const comparison = () => {
    const left = additive();
    for (const op of ['=', '==', '<>', '!=', '<=', '>=', '<', '>']) {
      if (accept('op', op)) return { type: 'bin', op: op === '!=' ? '<>' : op === '==' ? '=' : op, left, right: additive() };
    }
    const negated = Boolean(accept('kw', 'NOT'));
    if (accept('kw', 'LIKE')) return wrapNot(negated, { type: 'like', left, right: additive() });
    if (accept('kw', 'IN')) {
      expect('op', '(');
      if (is('kw', 'SELECT')) { const query = select(); expect('op', ')'); return wrapNot(negated, { type: 'in', left, query }); }
      const items = [expression()];
      while (accept('op', ',')) items.push(expression());
      expect('op', ')');
      return wrapNot(negated, { type: 'in', left, items });
    }
    if (accept('kw', 'BETWEEN')) {
      const low = additive();
      expect('kw', 'AND');
      return wrapNot(negated, { type: 'between', left, low, high: additive() });
    }
    if (negated) throw new SqlError('expected LIKE, IN or BETWEEN after NOT');
    if (accept('kw', 'IS')) {
      const not = Boolean(accept('kw', 'NOT'));
      expect('kw', 'NULL');
      return { type: 'isnull', left, not };
    }
    return left;
  };
  const negation = () => (accept('kw', 'NOT') ? { type: 'not', arg: negation() } : comparison());
  const conjunction = () => {
    let left = negation();
    while (accept('kw', 'AND')) left = { type: 'and', left, right: negation() };
    return left;
  };
  const expression = () => {
    let left = conjunction();
    while (accept('kw', 'OR')) left = { type: 'or', left, right: conjunction() };
    return left;
  };
  const alias = () => {
    if (accept('kw', 'AS')) return expect('id').value;
    if (is('id') && !NOT_HERE[word()] && !['OVER', 'USING'].includes(word())) return take().value;
    return null;
  };
  // A table is named alone (Orders) or with its file before it ("Operations 2025.xlsx".Orders).
  const tableName = () => {
    const first = expect('id').value;
    return accept('op', '.') ? { file: first, table: expect('id').value } : { file: null, table: first };
  };

  function select() {
    expect('kw', 'SELECT');
    const distinct = Boolean(accept('kw', 'DISTINCT'));
    const items = [];
    do {
      if (accept('op', '*')) items.push({ star: true });
      else {
        const expr = expression();
        items.push({ expr, alias: alias() });
      }
    } while (accept('op', ','));
    expect('kw', 'FROM');
    if (is('op', '(')) throw new SqlError(`a query in FROM is not supported here; this SQL is ${SHAPE}`);
    const from = tableName();
    from.alias = alias() ?? from.table;
    const joins = [];
    const using = [];
    for (;;) {
      const left = Boolean(accept('kw', 'LEFT'));
      accept('kw', 'OUTER');
      accept('kw', 'INNER');
      if (!accept('kw', 'JOIN')) { if (left) throw new SqlError('expected JOIN after LEFT'); break; }
      const joined = tableName();
      const joinAlias = alias() ?? joined.table;
      if (word() === 'USING') {
        // JOIN u USING (a, b): rows whose a and b are the same in u as in the tables before it.
        take();
        expect('op', '(');
        const names = [expect('id').value];
        while (accept('op', ',')) names.push(expect('id').value);
        expect('op', ')');
        const same = names.map((name) => ({ type: 'bin', op: '=', left: { type: 'col', table: null, name, sourcesBefore: joins.length + 1 },
          right: { type: 'col', table: joinAlias, name } }));
        joins.push({ ...joined, alias: joinAlias, on: same.reduce((all, one) => ({ type: 'and', left: all, right: one })), left });
        using.push(...names.map(normalizeName));
        continue;
      }
      expect('kw', 'ON');
      joins.push({ ...joined, alias: joinAlias, on: expression(), left });
    }
    const where = accept('kw', 'WHERE') ? expression() : null;
    const groupBy = [];
    if (accept('kw', 'GROUP')) { expect('kw', 'BY'); do groupBy.push(expression()); while (accept('op', ',')); }
    const having = accept('kw', 'HAVING') ? expression() : null;
    const orderBy = [];
    if (accept('kw', 'ORDER')) {
      expect('kw', 'BY');
      do {
        const expr = expression();
        const descending = Boolean(accept('kw', 'DESC'));
        if (!descending) accept('kw', 'ASC');
        orderBy.push({ expr, descending });
      } while (accept('op', ','));
    }
    let limit = null;
    let offset = 0;
    if (accept('kw', 'LIMIT')) {
      limit = expect('num').value;
      if (accept('kw', 'OFFSET')) offset = expect('num').value;
      else if (accept('op', ',')) { offset = limit; limit = expect('num').value; }
    }
    return { distinct, items, from, joins, using, where, groupBy, having, orderBy, limit, offset };
  }

  if (!is('kw', 'SELECT')) { refuse(); throw new SqlError(`expected SELECT near "${near()}"`); }
  const query = select();
  if (position < tokens.length) { refuse(); throw new SqlError(`unexpected "${near()}" after the query`); }
  return query;
}

/** Every node of an expression, without those of a query in parentheses, which is a query of its own. */
function* nodesOf(value) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) yield* nodesOf(item); return; }
  yield value;
  for (const [key, child] of Object.entries(value)) if (key !== 'query') yield* nodesOf(child);
}

/** The tables a query reads, in the order it names them, as `{ file, table }`; a query in parentheses counts too. */
export function tablesNamed(query) {
  const named = [];
  const add = (reference) => {
    if (!named.some((other) => other.table === reference.table && other.file === reference.file)) named.push({ file: reference.file, table: reference.table });
  };
  const visit = (current) => {
    add(current.from);
    for (const join of current.joins) add(join);
    for (const node of nodesOf([current.items, current.joins.map((join) => join.on), current.where, current.groupBy, current.having, current.orderBy])) {
      if (node.query) visit(node.query);
    }
  };
  visit(query);
  return named;
}

// ── working it out ──────────────────────────────────────────────────────────

const toNumber = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const text = String(value).trim();
  return text !== '' && Number.isFinite(Number(text)) ? Number(text) : null;
};
const truthy = (value) => value !== null && value !== undefined && value !== false && value !== 0 && value !== '';
const shown = (value) => JSON.stringify(String(value).slice(0, 40));
/** A number for arithmetic: empty stays NULL; text that is not a number is an error, never zero or NULL. */
const numeric = (value, where) => {
  if (value === null || value === undefined || value === '') return null;
  const number = toNumber(value);
  if (number === null) {
    throw new SqlError(`${where} met the text ${shown(value)}; text is never treated as a number (NUMBER(x) gives no value for text, so SUM(NUMBER(x)) leaves it out)`);
  }
  return number;
};

function compareValues(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return null;
  const a = toNumber(left);
  const b = toNumber(right);
  if (a !== null && b !== null && (typeof left === 'number' || typeof right === 'number')) return a < b ? -1 : a > b ? 1 : 0;
  const x = String(left);
  const y = String(right);
  return x < y ? -1 : x > y ? 1 : 0;
}
// Values equal under compareValues share a key, so a join looks up its matches and then checks each as written.
const joinKey = (value) => { const number = toNumber(value); return number !== null ? `n:${number}` : `s:${value}`; };

/** A date's parts from its ISO form; empty is NULL, and text that is no date is an error. */
const dateOf = (value, where) => {
  if (value === null || value === undefined || value === '') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!match) throw new SqlError(`${where} met the text ${shown(value)}, which is not a date written like 2025-03-14`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), iso: match[0] };
};

const roundHalfAway = (number, digits) => {
  const factor = 10 ** digits;
  const scaled = number * factor;
  const nudged = Math.abs(scaled - Math.round(scaled)) < 1e-9 * Math.max(1, Math.abs(scaled)) ? Math.round(scaled) : scaled;
  return (Math.sign(nudged) * Math.round(Math.abs(nudged))) / factor;
};

/**
 * Runs a query. `lookup({ file, table })` gives a table as
 * `{ name, columns: [{ name }], rows: [values[]], rowNumber(index) }`, its
 * cells typed (a number, text, or null for empty), or null when there is none.
 * Returns `{ columns, rows, total, scanned: [{ table, rows }], grouped, written }`:
 * `total` counts the rows before LIMIT, `scanned` the rows read of each table,
 * and `written`, for a query that is not grouped, gives beside each row the
 * text of the cells its plain columns were read from (`table.written`), so
 * "9.10" and "12.5%" can be shown as their file has them.
 */
export function runSql(text, lookup, { maxWork = MAX_WORK, columns = [] } = {}) {
  const budget = { left: maxWork };
  const scanned = [];
  const result = evaluate(typeof text === 'string' ? parseSql(text, { columns }) : text, lookup, budget, scanned);
  return { ...result, scanned };
}

function evaluate(query, lookup, budget, scanned) {
  const spend = (amount) => {
    budget.left -= amount;
    if (budget.left < 0) throw new SqlError('this query is over the local limit of work; narrow it with WHERE, or join on equal columns');
  };
  const tableOf = (reference) => {
    const table = lookup(reference);
    if (!table) throw new SqlError(`no table named ${reference.file ? `${reference.file}.` : ''}${reference.table}`);
    if (!scanned.some((entry) => entry.table === table.name)) scanned.push({ table: table.name, rows: table.rows.length });
    return table;
  };
  const sources = [{ alias: query.from.alias, table: tableOf(query.from) }, ...query.joins.map((join) => ({ alias: join.alias, table: tableOf(join), join }))];

  // Column resolution: (table alias | null, name) → [source index, column index], or null when no source has it.
  const findColumn = (node, upTo = sources.length) => {
    const key = normalizeName(node.name);
    const candidates = [];
    sources.slice(0, Math.min(upTo, node.sourcesBefore ?? upTo)).forEach((source, index) => {
      if (node.table && normalizeName(node.table) !== normalizeName(source.alias) && normalizeName(node.table) !== normalizeName(source.table.name)) return;
      const column = source.table.columns.findIndex((item) => normalizeName(item.name) === key);
      if (column >= 0) candidates.push([index, column]);
    });
    // A column joined on with USING is one column, the same in each of its tables.
    if (candidates.length > 1 && !(query.using?.includes(key) && !node.table)) throw new SqlError(`column ${node.name} is ambiguous; qualify it with a table name`);
    return candidates[0] ?? null;
  };
  const resolveColumn = (node) => {
    const found = findColumn(node);
    if (found) return found;
    const known = sources.flatMap((source) => source.table.columns.map((column) => column.name));
    throw new SqlError(`no column named ${node.table ? `${node.table}.` : ''}${node.name}; columns are ${known.join(', ')}`);
  };

  // A row environment is an array of row indexes, one per source (−1 for a missing LEFT JOIN row).
  const columnValue = (env, [source, column]) => (env[source] < 0 ? null : sources[source].table.rows[env[source]][column] ?? null);

  // A query in parentheses is worked out once: it cannot name this query's columns.
  const subResults = new Map();
  const subquery = (node) => {
    if (!subResults.has(node)) subResults.set(node, evaluate(node.query, lookup, budget, scanned));
    return subResults.get(node);
  };

  const scalar = (node, env, group = null) => {
    switch (node.type) {
      case 'lit': return node.value;
      case 'col': {
        if (env === null) throw new SqlError(`column ${node.name} must be inside an aggregate or listed in GROUP BY`);
        // "North" in double quotes that names no column is the text North, as SQLite reads it.
        if (node.quoted && !node.table && !findColumn(node)) return node.name;
        return columnValue(env, resolveColumn(node));
      }
      case 'neg': { const value = numeric(scalar(node.arg, env, group), 'a minus sign'); return value === null ? null : -value; }
      case 'bin': {
        const left = scalar(node.left, env, group);
        const right = scalar(node.right, env, group);
        if (node.op === '||') return left === null || right === null ? null : `${left}${right}`;
        if (['=', '<>', '<', '>', '<=', '>='].includes(node.op)) {
          const order = compareValues(left, right);
          if (order === null) return null;
          return { '=': order === 0, '<>': order !== 0, '<': order < 0, '>': order > 0, '<=': order <= 0, '>=': order >= 0 }[node.op];
        }
        const a = numeric(left, `"${node.op}"`);
        const b = numeric(right, `"${node.op}"`);
        if (a === null || b === null) return null;
        if (node.op === '+') return a + b;
        if (node.op === '-') return a - b;
        if (node.op === '*') return a * b;
        if (node.op === '/') return b === 0 ? null : a / b;
        if (node.op === '%') return b === 0 ? null : a % b;
        return null;
      }
      case 'and': {
        // Three-valued logic: false wins, then unknown (NULL), then true.
        const left = scalar(node.left, env, group);
        if (left !== null && !truthy(left)) return false;
        const right = scalar(node.right, env, group);
        if (right !== null && !truthy(right)) return false;
        return left === null || right === null ? null : true;
      }
      case 'or': {
        const left = scalar(node.left, env, group);
        if (truthy(left)) return true;
        const right = scalar(node.right, env, group);
        if (truthy(right)) return true;
        return left === null || right === null ? null : false;
      }
      case 'not': { const value = scalar(node.arg, env, group); return value === null ? null : !truthy(value); }
      case 'like': {
        const value = scalar(node.left, env, group);
        const pattern = scalar(node.right, env, group);
        if (value === null || pattern === null) return null;
        const regex = new RegExp(`^${String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 'is');
        return regex.test(String(value));
      }
      case 'in': {
        const value = scalar(node.left, env, group);
        if (value === null) return null;
        if (node.query) {
          const listed = subquery(node);
          if (listed.columns.length !== 1) throw new SqlError('a query after IN gives one column');
          return listed.rows.some((row) => compareValues(value, row[0]) === 0);
        }
        return node.items.some((item) => compareValues(value, scalar(item, env, group)) === 0);
      }
      case 'between': {
        const value = scalar(node.left, env, group);
        const low = compareValues(value, scalar(node.low, env, group));
        const high = compareValues(value, scalar(node.high, env, group));
        return low === null || high === null ? null : low >= 0 && high <= 0;
      }
      case 'isnull': { const value = scalar(node.left, env, group); return node.not ? value !== null && value !== '' : value === null || value === ''; }
      case 'case': {
        const subject = node.subject ? scalar(node.subject, env, group) : null;
        for (const branch of node.branches) {
          const test = scalar(branch.when, env, group);
          if (node.subject ? compareValues(subject, test) === 0 : truthy(test)) return scalar(branch.then, env, group);
        }
        return scalar(node.otherwise, env, group);
      }
      case 'subquery': {
        const value = subquery(node);
        if (value.columns.length !== 1) throw new SqlError('a query used as a value gives one column');
        if (value.rows.length > 1) throw new SqlError(`a query used as a value returned ${value.rows.length} rows; it must give one (use an aggregate, or IN for a list)`);
        return value.rows[0]?.[0] ?? null;
      }
      case 'agg': {
        if (!group) throw new SqlError(`${node.name}() needs GROUP BY or a whole-table aggregate`);
        return aggregate(node, group);
      }
      case 'call': return call(node, env, group);
      default: throw new SqlError('unsupported expression');
    }
  };

  const call = (node, env, group) => {
    const args = () => node.args.map((arg) => scalar(arg, env, group));
    switch (node.name) {
      case 'ROW': {
        if (env === null) throw new SqlError('ROW() must be per row');
        let source = 0;
        if (node.args.length === 1 && node.args[0].type === 'col') {
          source = sources.findIndex((item) => normalizeName(item.alias) === normalizeName(node.args[0].name) || normalizeName(item.table.name) === normalizeName(node.args[0].name));
          if (source < 0) throw new SqlError(`ROW() takes a table name; ${node.args[0].name} is not one`);
        }
        return env[source] < 0 ? null : sources[source].table.rowNumber(env[source]);
      }
      // About the cell a column's value sits in, where the table knows its cells (a workbook's sheet): its address,
      // whether it is a formula or a literal, the formula as written, and its value recomputed from that formula.
      case 'ADDRESS': case 'KIND': case 'FORMULA': case 'CALC': {
        if (node.args.length !== 1 || node.args[0].type !== 'col') throw new SqlError(`${node.name}() takes one column, as in ${node.name}("Net")`);
        if (env === null) throw new SqlError(`${node.name}() must be per row`);
        const [source, column] = resolveColumn(node.args[0]);
        if (!sources[source].table.info) throw new SqlError(`${node.name}() is for a workbook's sheets; ${sources[source].table.name} has no cells to ask about`);
        if (env[source] < 0) return null;
        return sources[source].table.info(env[source], column)?.[node.name.toLowerCase()] ?? null;
      }
      case 'NUMBER': case 'NUM': { const [value] = args(); return value === '' ? null : toNumber(value); }
      case 'TO_NUMBER': return numeric(args()[0], 'CAST()');
      case 'TO_TEXT': { const [value] = args(); return value === null ? null : String(value); }
      case 'ROUND': { const [value, digits = 0] = args(); const number = numeric(value, 'ROUND()'); return number === null ? null : roundHalfAway(number, toNumber(digits) ?? 0); }
      case 'ABS': { const number = numeric(args()[0], 'ABS()'); return number === null ? null : Math.abs(number); }
      case 'UPPER': { const [value] = args(); return value === null ? null : String(value).toUpperCase(); }
      case 'LOWER': { const [value] = args(); return value === null ? null : String(value).toLowerCase(); }
      case 'TRIM': { const [value] = args(); return value === null ? null : String(value).trim(); }
      case 'LENGTH': case 'LEN': { const [value] = args(); return value === null ? null : String(value).length; }
      case 'SUBSTR': case 'SUBSTRING': {
        const [value, start, length] = args();
        if (value === null) return null;
        const text = String(value);
        const from = Math.max(0, (toNumber(start) ?? 1) - 1);
        return length === undefined ? text.slice(from) : text.slice(from, from + (toNumber(length) ?? 0));
      }
      case 'CONCAT': { const values = args(); return values.some((value) => value === null) ? null : values.join(''); }
      case 'COALESCE': case 'IFNULL': return args().find((value) => value !== null && value !== '') ?? null;
      case 'NULLIF': { const [value, other] = args(); return compareValues(value, other) === 0 ? null : value; }
      case 'IIF': case 'IF': return truthy(scalar(node.args[0], env, group)) ? scalar(node.args[1], env, group) : node.args[2] ? scalar(node.args[2], env, group) : null;
      case 'LEAST': case 'GREATEST': {
        const values = args();
        if (values.some((value) => value === null)) return null;
        return values.reduce((best, value) => ((node.name === 'LEAST' ? compareValues(value, best) < 0 : compareValues(value, best) > 0) ? value : best));
      }
      case 'YEAR': return dateOf(args()[0], 'YEAR()')?.year ?? null;
      case 'MONTH': return dateOf(args()[0], 'MONTH()')?.month ?? null;
      case 'DAY': return dateOf(args()[0], 'DAY()')?.day ?? null;
      case 'QUARTER': { const date = dateOf(args()[0], 'QUARTER()'); return date ? Math.ceil(date.month / 3) : null; }
      case 'DATE': return dateOf(args()[0], 'DATE()')?.iso ?? null;
      case 'DATE_TRUNC': {
        // A period by its first day, as PostgreSQL gives it: the quarter of 2025-05-14 is 2025-04-01.
        const [part, value] = args();
        const unit = String(part).toLowerCase();
        if (!['year', 'quarter', 'month', 'day'].includes(unit)) throw new SqlError(`DATE_TRUNC() reads 'year', 'quarter', 'month' or 'day', not ${shown(part)}`);
        const date = dateOf(value, 'DATE_TRUNC()');
        if (!date) return null;
        const month = unit === 'year' ? 1 : unit === 'quarter' ? Math.ceil(date.month / 3) * 3 - 2 : date.month;
        return `${String(date.year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(unit === 'day' ? date.day : 1).padStart(2, '0')}`;
      }
      case 'STRFTIME': {
        const [format, value] = args();
        const date = dateOf(value, 'STRFTIME()');
        if (!date) return null;
        return String(format).replace(/%(.)/g, (whole, code) => {
          if (code === 'Y') return String(date.year);
          if (code === 'm') return String(date.month).padStart(2, '0');
          if (code === 'd') return String(date.day).padStart(2, '0');
          if (code === '%') return '%';
          throw new SqlError(`STRFTIME() reads %Y, %m and %d; for a quarter use QUARTER(x), not ${whole}`);
        });
      }
      default: throw new SqlError(`unsupported function ${node.name}(); the functions are ${FUNCTIONS}`);
    }
  };

  const aggregate = (node, group) => {
    if (node.star) return group.length;
    const values = group.map((env) => scalar(node.args[0], env, null)).filter((value) => value !== null && value !== '');
    const items = node.distinct ? [...new Map(values.map((value) => [typeof value === 'number' ? `n:${value}` : `s:${value}`, value])).values()] : values;
    switch (node.name) {
      case 'COUNT': return items.length;
      case 'SUM': { const numbers = items.map((value) => numeric(value, 'SUM()')); return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : null; }
      case 'AVG': { const numbers = items.map((value) => numeric(value, 'AVG()')); return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null; }
      case 'MIN': return items.reduce((best, value) => (best === null || compareValues(value, best) < 0 ? value : best), null);
      case 'MAX': return items.reduce((best, value) => (best === null || compareValues(value, best) > 0 ? value : best), null);
      case 'GROUP_CONCAT': {
        const separator = node.args[1] ? String(scalar(node.args[1], group[0] ?? null, null)) : ', ';
        return items.map(String).join(separator);
      }
      default: throw new SqlError(`unsupported aggregate ${node.name}`);
    }
  };

  // FROM and JOIN. A join on two equal columns looks its matches up; any other compares every pair.
  spend(sources[0].table.rows.length);
  let envs = sources[0].table.rows.map((_, index) => [index]);
  query.joins.forEach((join, index) => {
    const at = index + 1;
    const right = sources[at].table;
    const next = [];
    const sides = join.on.type === 'bin' && join.on.op === '=' && join.on.left.type === 'col' && join.on.right.type === 'col'
      ? [join.on.left, join.on.right].map((node) => findColumn(node, at + 1)) : null;
    const [outer, inner] = sides?.every(Boolean) ? (sides[0][0] === at ? [sides[1], sides[0]] : [sides[0], sides[1]]) : [];
    if (outer && inner && inner[0] === at && outer[0] < at) {
      spend(right.rows.length + envs.length);
      const matches = new Map();
      right.rows.forEach((row, rowIndex) => {
        const value = row[inner[1]];
        if (value === null || value === undefined) return;
        const key = joinKey(value);
        if (!matches.has(key)) matches.set(key, []);
        matches.get(key).push(rowIndex);
      });
      for (const env of envs) {
        const value = columnValue(env, outer);
        const candidates = value === null ? [] : matches.get(joinKey(value)) ?? [];
        spend(candidates.length);
        let matched = false;
        for (const rowIndex of candidates) {
          const candidate = [...env, rowIndex];
          if (truthy(scalar(join.on, candidate))) { next.push(candidate); matched = true; }
        }
        if (!matched && join.left) next.push([...env, -1]);
      }
    } else {
      spend(envs.length * right.rows.length);
      for (const env of envs) {
        let matched = false;
        for (let row = 0; row < right.rows.length; row += 1) {
          const candidate = [...env, row];
          if (truthy(scalar(join.on, candidate))) { next.push(candidate); matched = true; }
        }
        if (!matched && join.left) next.push([...env, -1]);
      }
    }
    envs = next;
  });
  if (query.where) envs = envs.filter((env) => truthy(scalar(query.where, env)));

  // GROUP BY and HAVING may name a select alias (GROUP BY q, HAVING n > 1) where no column has that name,
  // and GROUP BY may give a selected column's position (GROUP BY 1).
  const aliases = new Map(query.items.filter((item) => item.alias).map((item) => [normalizeName(item.alias), item.expr]));
  const substitute = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'col' && !node.table && aliases.has(normalizeName(node.name)) && !findColumn(node)) return aliases.get(normalizeName(node.name));
    if (node.type === 'subquery' || node.query) return node;
    if (Array.isArray(node)) return node.map(substitute);
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, typeof value === 'object' ? substitute(value) : value]));
  };
  const positioned = (expr) => {
    if (expr.type !== 'lit' || !Number.isInteger(expr.value)) return expr;
    const item = query.items[expr.value - 1];
    if (!item || item.star) throw new SqlError(`GROUP BY ${expr.value} names no selected column`);
    return item.expr;
  };
  const groupBy = query.groupBy.map(positioned).map(substitute);
  const having = query.having ? substitute(query.having) : null;

  const hasAggregate = (node) => { for (const inner of nodesOf(node)) { if (inner.type === 'agg') return true; } return false; };
  const grouped = groupBy.length > 0 || query.items.some((item) => !item.star && hasAggregate(item.expr)) || hasAggregate(having);

  const expandStar = () => sources.flatMap((source, index) => source.table.columns.map((column, at) => ({ name: column.name, expr: { type: '_direct', source: index, column: at } })));
  const items = query.items.flatMap((item) => (item.star ? expandStar() : [{ name: item.alias ?? labelOf(item.expr), expr: item.expr }]));
  const evaluateItem = (expr, env, group) => (expr.type === '_direct' ? columnValue(env, [expr.source, expr.column]) : scalar(expr, env, group));

  let rows;
  if (grouped) {
    const groups = new Map();
    for (const env of envs) {
      const key = JSON.stringify(groupBy.map((expr) => scalar(expr, env)));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(env);
    }
    if (!groupBy.length && !groups.size) groups.set('[]', []);
    rows = [];
    for (const group of groups.values()) {
      const representative = group[0] ?? null;
      const scope = (expr) => {
        if (expr.type === 'agg') return aggregate(expr, group);
        if (expr.type === 'col' || expr.type === '_direct') return representative ? evaluateItem(expr, representative, group) : null;
        return scalar(expr, representative, group);
      };
      if (having && !truthy(scope(having))) continue;
      rows.push({ values: items.map((item) => scope(item.expr)), sort: query.orderBy.map((order) => orderValue(order.expr, items, scope)) });
    }
  } else {
    // The cell behind each selected item that is a column as it stands, and nothing worked out from it.
    const cellOf = (expr) => (expr.type === '_direct' ? [expr.source, expr.column] : expr.type === 'col' ? findColumn(expr) : null);
    const direct = items.map((item) => cellOf(item.expr));
    rows = envs.map((env) => ({ values: items.map((item) => evaluateItem(item.expr, env, null)),
      written: direct.map((at) => (at && env[at[0]] >= 0 ? sources[at[0]].table.written?.(env[at[0]], at[1]) ?? null : undefined)),
      sort: query.orderBy.map((order) => orderValue(order.expr, items, (expr) => evaluateItem(expr, env, null))) }));
  }
  if (query.distinct) {
    const seen = new Set();
    rows = rows.filter((row) => { const key = JSON.stringify(row.values); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  if (query.orderBy.length) {
    rows.sort((left, right) => {
      for (const [index, order] of query.orderBy.entries()) {
        const a = left.sort[index] ?? null;
        const b = right.sort[index] ?? null;
        if (a === null && b === null) continue;
        if (a === null) return 1;
        if (b === null) return -1;
        const result = compareValues(a, b);
        if (result) return order.descending ? -result : result;
      }
      return 0;
    });
  }
  const total = rows.length;
  if (query.offset) rows = rows.slice(query.offset);
  if (query.limit !== null) rows = rows.slice(0, query.limit);
  return { columns: items.map((item) => item.name), rows: rows.map((row) => row.values), total, grouped,
    written: grouped ? null : rows.map((row) => row.written) };
}

/** ORDER BY may name a select alias or a 1-based column position. */
function orderValue(expr, items, evaluate) {
  if (expr.type === 'lit' && typeof expr.value === 'number' && Number.isInteger(expr.value) && expr.value >= 1 && expr.value <= items.length) {
    return evaluate(items[expr.value - 1].expr);
  }
  if (expr.type === 'col' && !expr.table) {
    const alias = items.find((item) => normalizeName(item.name) === normalizeName(expr.name));
    if (alias) return evaluate(alias.expr);
  }
  return evaluate(expr);
}

function labelOf(expr) {
  switch (expr.type) {
    case 'col': return expr.name;
    case 'agg': return expr.star ? 'COUNT(*)' : `${expr.name}(${expr.distinct ? 'DISTINCT ' : ''}${expr.args.map(labelOf).join(', ')})`;
    case 'call': return `${expr.name}(${expr.args.map(labelOf).join(', ')})`;
    case 'lit': return String(expr.value);
    case 'bin': return `${labelOf(expr.left)} ${expr.op} ${labelOf(expr.right)}`;
    case 'neg': return `-${labelOf(expr.arg)}`;
    case 'subquery': return 'query';
    default: return expr.type;
  }
}
