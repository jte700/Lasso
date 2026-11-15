// A fixed, allowlisted Excel formula language (paper §6.3): tokenizer, parser,
// R1C1 normalisation, dependency extraction and an evaluator. Anything outside
// the language (unknown or volatile functions, external workbooks, structured
// references, array formulas) is reported as unsupported, never translated
// into something nearby.

export const SUPPORTED_FUNCTIONS = new Set(['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'COUNTBLANK', 'COUNTIF', 'COUNTIFS', 'SUMIF', 'SUMIFS',
  'AVERAGEIF', 'AVERAGEIFS', 'IF', 'IFERROR', 'AND', 'OR', 'NOT', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'ABS', 'INT', 'MOD', 'POWER', 'SQRT', 'PRODUCT',
  'SUMPRODUCT', 'CONCATENATE', 'CONCAT', 'LEN', 'UPPER', 'LOWER', 'TRIM', 'LEFT', 'RIGHT', 'MID', 'VLOOKUP', 'INDEX', 'MATCH']);
const VOLATILE = new Set(['TODAY', 'NOW', 'RAND', 'RANDBETWEEN', 'OFFSET', 'INDIRECT', 'CELL', 'INFO']);

export class UnsupportedFormula extends Error {
  constructor(message) { super(message); this.code = 'unsupported'; }
}

// ── addresses ───────────────────────────────────────────────────────────────

export function columnIndex(letters) {
  let index = 0;
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index;
}

export function columnLetters(index) {
  let letters = '';
  for (let value = index; value > 0; value = Math.floor((value - 1) / 26)) letters = String.fromCharCode(65 + ((value - 1) % 26)) + letters;
  return letters;
}

export const cellName = (row, column) => `${columnLetters(column)}${row}`;

export function parseCellName(name) {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(name);
  if (!match) return null;
  return { column: columnIndex(match[1]), row: Number(match[2]) };
}

/** "Sheet!A1", "'My sheet'!A1:B4", "A1" (with a default sheet) → { sheet, r1, c1, r2, c2 }. */
export function parseReference(text, defaultSheet = null) {
  const match = /^(?:'((?:[^']|'')+)'|([^!:'"]+))?!?(.+)$/.exec(String(text).trim());
  let sheet = defaultSheet;
  let body = String(text).trim();
  if (body.includes('!')) {
    sheet = match[1] ? match[1].replace(/''/g, "'") : match[2];
    body = match[3];
  }
  const [left, right = left] = body.split(':');
  const a = parseCellName(left);
  const b = parseCellName(right);
  if (!a || !b) return null;
  return { sheet, r1: Math.min(a.row, b.row), c1: Math.min(a.column, b.column), r2: Math.max(a.row, b.row), c2: Math.max(a.column, b.column) };
}

const quoteSheet = (sheet) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`);
export const rangeName = ({ sheet, r1, c1, r2, c2 }) => `${sheet ? `${quoteSheet(sheet)}!` : ''}${cellName(r1, c1)}${r1 === r2 && c1 === c2 ? '' : `:${cellName(r2, c2)}`}`;

// ── tokenizer and parser ────────────────────────────────────────────────────

const REF = String.raw`\$?[A-Za-z]{1,3}\$?\d+`;
const SHEET = String.raw`(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)`;
const TOKEN = new RegExp([
  String.raw`(?<ws>\s+)`,
  String.raw`(?<str>"(?:[^"]|"")*")`,
  String.raw`(?<ext>\[[^\]]*\])`,
  String.raw`(?<ref>(?:${SHEET}!)?(?:${REF}(?::${REF})?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d+:\$?\d+))(?![A-Za-z0-9_(])`,
  String.raw`(?<num>\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)`,
  String.raw`(?<err>#(?:DIV/0!|N/A|NAME\?|NULL!|NUM!|REF!|VALUE!|SPILL!|CALC!))`,
  String.raw`(?<fn>[A-Za-z_][A-Za-z0-9_.]*)(?=\s*\()`,
  String.raw`(?<bool>TRUE|FALSE)(?![A-Za-z0-9_])`,
  String.raw`(?<name>[A-Za-z_][A-Za-z0-9_.]*)`,
  String.raw`(?<op><=|>=|<>|[-+*/^&=<>%(),;:{}])`,
].join('|'), 'gy');

function tokenize(text) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  let index = 0;
  while (index < text.length) {
    TOKEN.lastIndex = index;
    const match = TOKEN.exec(text);
    if (!match) throw new UnsupportedFormula(`cannot read formula at "${text.slice(index, index + 12)}"`);
    index = TOKEN.lastIndex;
    const [kind, value] = Object.entries(match.groups).find(([, part]) => part !== undefined);
    if (kind === 'ws') continue;
    if (kind === 'ext') throw new UnsupportedFormula('external or structured references are not supported');
    if (kind === 'name') throw new UnsupportedFormula(`defined names are not supported (${value})`);
    if (kind === 'op' && (value === '{' || value === '}')) throw new UnsupportedFormula('array constants are not supported');
    tokens.push({ kind, value });
  }
  return tokens;
}

function parseRefToken(text) {
  let sheet = null;
  let body = text;
  const bang = text.lastIndexOf('!');
  if (bang >= 0) {
    sheet = text.slice(0, bang);
    if (sheet.startsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'");
    body = text.slice(bang + 1);
  }
  const part = (piece) => {
    const cell = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(piece);
    if (cell) return { column: columnIndex(cell[2]), row: Number(cell[4]), absColumn: cell[1] === '$', absRow: cell[3] === '$' };
    const column = /^(\$?)([A-Za-z]{1,3})$/.exec(piece);
    if (column) return { column: columnIndex(column[2]), row: null, absColumn: column[1] === '$', absRow: true };
    const row = /^(\$?)(\d+)$/.exec(piece);
    if (row) return { column: null, row: Number(row[2]), absColumn: true, absRow: row[1] === '$' };
    return null;
  };
  const [left, right] = body.split(':');
  const a = part(left);
  if (right === undefined) return { type: 'ref', sheet, ...a };
  return { type: 'range', sheet, a, b: part(right) };
}

/** Parses a formula (with or without its leading "=") into an AST. */
export function parseFormula(source) {
  const text = String(source).replace(/^=/, '');
  const tokens = tokenize(text);
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const expect = (value) => {
    const token = take();
    if (!token || token.value !== value) throw new UnsupportedFormula(`expected "${value}" in formula`);
  };
  const BINARY = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };
  const primary = () => {
    const token = take();
    if (!token) throw new UnsupportedFormula('formula ends early');
    if (token.kind === 'num') return { type: 'num', value: Number(token.value) };
    if (token.kind === 'str') return { type: 'str', value: token.value.slice(1, -1).replace(/""/g, '"') };
    if (token.kind === 'bool') return { type: 'bool', value: token.value === 'TRUE' };
    if (token.kind === 'err') return { type: 'err', value: token.value };
    if (token.kind === 'ref') return parseRefToken(token.value);
    if (token.kind === 'fn') {
      const name = token.value.toUpperCase().replace(/^_XLFN\./, '');
      if (VOLATILE.has(name)) throw new UnsupportedFormula(`volatile function ${name} is not supported`);
      if (!SUPPORTED_FUNCTIONS.has(name)) throw new UnsupportedFormula(`function ${name} is not supported`);
      expect('(');
      const args = [];
      if (peek()?.value !== ')') {
        for (;;) {
          if (peek()?.value === ',' || peek()?.value === ';') args.push({ type: 'missing' });
          else args.push(expression(0));
          if (peek()?.value === ',' || peek()?.value === ';') { take(); continue; }
          break;
        }
      }
      expect(')');
      return { type: 'call', name, args };
    }
    if (token.value === '(') { const inner = expression(0); expect(')'); return inner; }
    if (token.value === '-' || token.value === '+') return { type: 'unary', op: token.value, arg: unaryOperand() };
    throw new UnsupportedFormula(`unexpected "${token.value}" in formula`);
  };
  // Excel binds negation tighter than ^ (so -2^2 is 4) and % as a postfix.
  const unaryOperand = () => {
    let node = primary();
    while (peek()?.value === '%') { take(); node = { type: 'percent', arg: node }; }
    return node;
  };
  // Every binary operator, ^ included, is left-associative in Excel (2^3^2 is 64).
  const expression = (minimum) => {
    let left = unaryOperand();
    for (;;) {
      const token = peek();
      const precedence = token?.kind === 'op' ? BINARY[token.value] : undefined;
      if (precedence === undefined || precedence < minimum) break;
      take();
      left = { type: 'binary', op: token.value, left, right: expression(precedence + 1) };
    }
    return left;
  };
  const tree = expression(0);
  if (position < tokens.length) throw new UnsupportedFormula(`unexpected "${tokens[position].value}" after formula`);
  return tree;
}

// ── references relative to a cell ──────────────────────────────────────────

/** A reference's actual position when the formula is evaluated at (row, column) and was written at anchor. */
const resolvePart = (part, row, column, anchor) => ({
  row: part.row === null ? null : part.absRow ? part.row : part.row + (row - anchor.row),
  column: part.column === null ? null : part.absColumn ? part.column : part.column + (column - anchor.column),
});

/** Ranges and single cells a formula reads, as {sheet, r1, c1, r2, c2}; whole columns/rows are clipped to `bounds(sheet)`. */
export function referencesOf(tree, { sheet, row, column, anchor = { row, column }, bounds }) {
  const found = [];
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'ref') {
      const at = resolvePart(node, row, column, anchor);
      found.push({ sheet: node.sheet ?? sheet, r1: at.row, c1: at.column, r2: at.row, c2: at.column, single: true });
    } else if (node.type === 'range') {
      const a = resolvePart(node.a, row, column, anchor);
      const b = resolvePart(node.b, row, column, anchor);
      const target = node.sheet ?? sheet;
      const limit = bounds(target);
      found.push({ sheet: target, r1: Math.min(a.row ?? 1, b.row ?? 1), c1: Math.min(a.column ?? 1, b.column ?? 1),
        r2: Math.max(a.row ?? limit.rows, b.row ?? limit.rows), c2: Math.max(a.column ?? limit.columns, b.column ?? limit.columns), single: false });
    } else if (node.type === 'call') node.args.forEach(walk);
    else if (node.type === 'binary') { walk(node.left); walk(node.right); } else if (node.type === 'unary' || node.type === 'percent') walk(node.arg);
  };
  walk(tree);
  return found;
}

const PRINT_PRECEDENCE = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };

/** The formula text in A1 style as it reads at (row, column). */
export function formulaText(tree, { row, column, anchor = { row, column } }) {
  const part = (piece) => {
    const at = resolvePart(piece, row, column, anchor);
    return `${piece.column === null ? '' : `${piece.absColumn ? '$' : ''}${columnLetters(at.column)}`}${piece.row === null ? '' : `${piece.absRow ? '$' : ''}${at.row}`}`;
  };
  const sheetPrefix = (node) => (node.sheet ? `${quoteSheet(node.sheet)}!` : '');
  const write = (node) => {
    switch (node.type) {
      case 'num': return String(node.value);
      case 'str': return `"${node.value.replace(/"/g, '""')}"`;
      case 'bool': return node.value ? 'TRUE' : 'FALSE';
      case 'err': return node.value;
      case 'missing': return '';
      case 'ref': return `${sheetPrefix(node)}${part(node)}`;
      case 'range': return `${sheetPrefix(node)}${part(node.a)}:${part(node.b)}`;
      case 'call': return `${node.name}(${node.args.map(write).join(',')})`;
      case 'unary': return `${node.op}${write(node.arg)}`;
      case 'percent': return `${write(node.arg)}%`;
      case 'binary': {
        // Parentheses only where precedence needs them: (a-b)*c, a-(b-c).
        const level = PRINT_PRECEDENCE[node.op];
        const left = node.left.type === 'binary' && PRINT_PRECEDENCE[node.left.op] < level ? `(${write(node.left)})` : write(node.left);
        const right = node.right.type === 'binary' && PRINT_PRECEDENCE[node.right.op] <= level ? `(${write(node.right)})` : write(node.right);
        return `${left}${node.op}${right}`;
      }
      default: return '?';
    }
  };
  return `=${write(tree)}`;
}

/** Position-independent form (R1C1): two cells share it exactly when one formula was filled from the other. */
export function r1c1(tree, { row, column, anchor = { row, column } }) {
  const part = (piece) => {
    const at = resolvePart(piece, row, column, anchor);
    const r = piece.row === null ? '' : piece.absRow ? `R${at.row}` : `R[${at.row - row}]`;
    const c = piece.column === null ? '' : piece.absColumn ? `C${at.column}` : `C[${at.column - column}]`;
    return `${r}${c}`;
  };
  const write = (node) => {
    switch (node.type) {
      case 'ref': return `${node.sheet ? `${node.sheet}!` : ''}${part(node)}`;
      case 'range': return `${node.sheet ? `${node.sheet}!` : ''}${part(node.a)}:${part(node.b)}`;
      case 'call': return `${node.name}(${node.args.map(write).join(',')})`;
      case 'unary': return `${node.op}${write(node.arg)}`;
      case 'percent': return `${write(node.arg)}%`;
      case 'binary': return `(${write(node.left)}${node.op}${write(node.right)})`;
      case 'str': return JSON.stringify(node.value);
      case 'missing': return '';
      default: return String(node.value);
    }
  };
  return write(tree);
}

// ── evaluation ──────────────────────────────────────────────────────────────

const ERROR = (code) => ({ error: code });
export const isError = (value) => value !== null && typeof value === 'object' && 'error' in value;
const isRange = (value) => value !== null && typeof value === 'object' && value.range === true;

function toNumber(value) {
  if (isError(value)) return value;
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const number = Number(String(value).trim());
  return Number.isFinite(number) && String(value).trim() !== '' ? number : ERROR('#VALUE!');
}
const toText = (value) => (value === null || value === undefined ? '' : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value));
const toBool = (value) => (typeof value === 'boolean' ? value : typeof value === 'number' ? value !== 0 : value === null ? false
  : /^true$/i.test(value) ? true : /^false$/i.test(value) ? false : ERROR('#VALUE!'));

function compare(left, right) {
  // Excel orders numbers < text < booleans; text compares case-insensitively.
  const rank = (value) => (value === null ? 0 : typeof value === 'number' ? 1 : typeof value === 'string' ? 2 : 3);
  if (left === null && typeof right === 'number') left = 0;
  if (right === null && typeof left === 'number') right = 0;
  if (left === null && typeof right === 'string') left = '';
  if (right === null && typeof left === 'string') right = '';
  if (rank(left) !== rank(right)) return rank(left) - rank(right);
  if (typeof left === 'string') return left.toLowerCase() < right.toLowerCase() ? -1 : left.toLowerCase() > right.toLowerCase() ? 1 : 0;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** An *IF criterion ("North", ">100", "<>x", "N*") as a predicate over cell values. */
function criterion(raw) {
  if (typeof raw === 'number' || typeof raw === 'boolean') return (value) => compare(value, raw) === 0 && value !== null;
  const text = toText(raw);
  const match = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(text);
  const op = match[1] ?? '=';
  const operand = match[2];
  const numeric = operand.trim() !== '' && Number.isFinite(Number(operand));
  if (numeric) {
    const target = Number(operand);
    return (value) => {
      if (typeof value !== 'number') return op === '<>';
      const order = value < target ? -1 : value > target ? 1 : 0;
      return { '=': order === 0, '<>': order !== 0, '<': order < 0, '>': order > 0, '<=': order <= 0, '>=': order >= 0 }[op];
    };
  }
  if (op === '=' || op === '<>') {
    if (operand === '') return op === '=' ? (value) => value === null || value === '' : (value) => value !== null && value !== '';
    const pattern = new RegExp(`^${operand.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/~\*/g, '\u0001').replace(/~\?/g, '\u0002')
      .replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\u0001/g, '\\*').replace(/\u0002/g, '\\?')}$`, 'is');
    return op === '=' ? (value) => typeof value === 'string' && pattern.test(value) : (value) => !(typeof value === 'string' && pattern.test(value));
  }
  return (value) => typeof value === 'string' && { '<': compare(value, operand) < 0, '>': compare(value, operand) > 0,
    '<=': compare(value, operand) <= 0, '>=': compare(value, operand) >= 0 }[op];
}

const flatten = (values) => values.flatMap((value) => (isRange(value) ? value.values : [value]));
const roundTo = (number, digits, mode) => {
  const factor = 10 ** digits;
  const scaled = number * factor;
  // Excel rounds half away from zero; correct the binary representation first.
  const nudged = Math.abs(scaled - Math.round(scaled)) < 1e-9 * Math.max(1, Math.abs(scaled)) ? Math.round(scaled) : scaled;
  const rounded = mode === 'up' ? Math.sign(nudged) * Math.ceil(Math.abs(nudged) - 1e-12) : mode === 'down' ? Math.trunc(nudged)
    : Math.sign(nudged) * Math.round(Math.abs(nudged));
  return rounded / factor;
};

/**
 * Evaluates a parsed formula written at `anchor` as it reads at (row, column)
 * of `sheet`. `read(sheet, row, column)` returns a cell's current value.
 */
export function evaluate(tree, { sheet, row, column, anchor = { row, column }, read, bounds }) {
  const rangeValues = (node) => {
    const [reference] = referencesOf(node, { sheet, row, column, anchor, bounds });
    const values = [];
    for (let r = reference.r1; r <= reference.r2; r += 1) for (let c = reference.c1; c <= reference.c2; c += 1) values.push(read(reference.sheet, r, c));
    return { range: true, values, rows: reference.r2 - reference.r1 + 1, columns: reference.c2 - reference.c1 + 1 };
  };
  const scalar = (value) => (isRange(value) ? (value.values.length === 1 ? value.values[0] : ERROR('#VALUE!')) : value);
  const value = (node) => {
    switch (node.type) {
      case 'num': case 'str': case 'bool': return node.value;
      case 'err': return ERROR(node.value);
      case 'missing': return null;
      case 'ref': {
        const at = resolvePart(node, row, column, anchor);
        return read(node.sheet ?? sheet, at.row, at.column);
      }
      case 'range': return rangeValues(node);
      case 'unary': {
        const number = toNumber(scalar(value(node.arg)));
        return isError(number) ? number : node.op === '-' ? -number : number;
      }
      case 'percent': {
        const number = toNumber(scalar(value(node.arg)));
        return isError(number) ? number : number / 100;
      }
      case 'binary': {
        const left = scalar(value(node.left));
        const right = scalar(value(node.right));
        if (isError(left)) return left;
        if (isError(right)) return right;
        if (node.op === '&') return toText(left) + toText(right);
        if (['=', '<>', '<', '>', '<=', '>='].includes(node.op)) {
          const order = compare(left, right);
          return { '=': order === 0, '<>': order !== 0, '<': order < 0, '>': order > 0, '<=': order <= 0, '>=': order >= 0 }[node.op];
        }
        const a = toNumber(left);
        const b = toNumber(right);
        if (isError(a)) return a;
        if (isError(b)) return b;
        if (node.op === '+') return a + b;
        if (node.op === '-') return a - b;
        if (node.op === '*') return a * b;
        if (node.op === '/') return b === 0 ? ERROR('#DIV/0!') : a / b;
        if (node.op === '^') return a ** b;
        return ERROR('#VALUE!');
      }
      case 'call': return call(node);
      default: return ERROR('#VALUE!');
    }
  };
  const numbersOf = (args) => {
    const numbers = [];
    for (const arg of args) {
      const result = value(arg);
      if (isRange(result)) {
        for (const item of result.values) { if (isError(item)) return item; if (typeof item === 'number') numbers.push(item); }
      } else {
        if (isError(result)) return result;
        const number = toNumber(result);
        if (isError(number)) return number;
        if (result !== null) numbers.push(number);
      }
    }
    return numbers;
  };
  const conditional = (pairs) => {
    // (range, criterion) pairs → indexes of cells meeting every criterion.
    let selected = null;
    for (const [rangeNode, criterionNode] of pairs) {
      const range = value(rangeNode);
      const test = criterion(scalar(value(criterionNode)));
      const cells = isRange(range) ? range.values : [range];
      const hits = new Set();
      cells.forEach((cell, index) => { if (test(cell)) hits.add(index); });
      selected = selected === null ? hits : new Set([...selected].filter((index) => hits.has(index)));
    }
    return selected ?? new Set();
  };
  const call = (node) => {
    const args = node.args;
    switch (node.name) {
      case 'SUM': { const numbers = numbersOf(args); return isError(numbers) ? numbers : numbers.reduce((sum, item) => sum + item, 0); }
      case 'PRODUCT': { const numbers = numbersOf(args); return isError(numbers) ? numbers : numbers.reduce((product, item) => product * item, 1); }
      case 'AVERAGE': { const numbers = numbersOf(args); return isError(numbers) ? numbers : numbers.length ? numbers.reduce((sum, item) => sum + item, 0) / numbers.length : ERROR('#DIV/0!'); }
      case 'MIN': { const numbers = numbersOf(args); return isError(numbers) ? numbers : numbers.length ? Math.min(...numbers) : 0; }
      case 'MAX': { const numbers = numbersOf(args); return isError(numbers) ? numbers : numbers.length ? Math.max(...numbers) : 0; }
      case 'COUNT': return flatten(args.map(value)).filter((item) => typeof item === 'number').length;
      case 'COUNTA': return flatten(args.map(value)).filter((item) => item !== null && item !== '').length;
      case 'COUNTBLANK': return flatten(args.map(value)).filter((item) => item === null || item === '').length;
      case 'COUNTIF': return conditional([[args[0], args[1]]]).size;
      case 'COUNTIFS': return conditional(Array.from({ length: args.length / 2 }, (_, index) => [args[index * 2], args[index * 2 + 1]])).size;
      case 'SUMIF': case 'AVERAGEIF': {
        const hits = conditional([[args[0], args[1]]]);
        const target = value(args[2] ?? args[0]);
        const cells = isRange(target) ? target.values : [target];
        const numbers = [...hits].map((index) => cells[index]).filter((item) => typeof item === 'number');
        if (node.name === 'SUMIF') return numbers.reduce((sum, item) => sum + item, 0);
        return numbers.length ? numbers.reduce((sum, item) => sum + item, 0) / numbers.length : ERROR('#DIV/0!');
      }
      case 'SUMIFS': case 'AVERAGEIFS': {
        const target = value(args[0]);
        const hits = conditional(Array.from({ length: (args.length - 1) / 2 }, (_, index) => [args[1 + index * 2], args[2 + index * 2]]));
        const cells = isRange(target) ? target.values : [target];
        const numbers = [...hits].map((index) => cells[index]).filter((item) => typeof item === 'number');
        if (node.name === 'SUMIFS') return numbers.reduce((sum, item) => sum + item, 0);
        return numbers.length ? numbers.reduce((sum, item) => sum + item, 0) / numbers.length : ERROR('#DIV/0!');
      }
      case 'IF': {
        const test = toBool(scalar(value(args[0])));
        if (isError(test)) return test;
        return test ? (args[1] ? scalar(value(args[1])) : true) : (args[2] ? scalar(value(args[2])) : false);
      }
      case 'IFERROR': { const result = scalar(value(args[0])); return isError(result) ? scalar(value(args[1])) : result; }
      case 'AND': case 'OR': {
        const values = flatten(args.map(value)).filter((item) => item !== null);
        for (const item of values) if (isError(item)) return item;
        const bools = values.map(toBool);
        return node.name === 'AND' ? bools.every(Boolean) : bools.some(Boolean);
      }
      case 'NOT': { const result = toBool(scalar(value(args[0]))); return isError(result) ? result : !result; }
      case 'ROUND': case 'ROUNDUP': case 'ROUNDDOWN': {
        const number = toNumber(scalar(value(args[0])));
        const digits = toNumber(scalar(value(args[1] ?? { type: 'num', value: 0 })));
        if (isError(number)) return number;
        if (isError(digits)) return digits;
        return roundTo(number, Math.trunc(digits), node.name === 'ROUNDUP' ? 'up' : node.name === 'ROUNDDOWN' ? 'down' : 'half');
      }
      case 'ABS': case 'INT': case 'SQRT': {
        const number = toNumber(scalar(value(args[0])));
        if (isError(number)) return number;
        if (node.name === 'SQRT') return number < 0 ? ERROR('#NUM!') : Math.sqrt(number);
        return node.name === 'ABS' ? Math.abs(number) : Math.floor(number);
      }
      case 'MOD': case 'POWER': {
        const a = toNumber(scalar(value(args[0])));
        const b = toNumber(scalar(value(args[1])));
        if (isError(a)) return a;
        if (isError(b)) return b;
        if (node.name === 'POWER') return a ** b;
        return b === 0 ? ERROR('#DIV/0!') : a - b * Math.floor(a / b);
      }
      case 'SUMPRODUCT': {
        const ranges = args.map(value).map((item) => (isRange(item) ? item.values : [item]));
        if (new Set(ranges.map((item) => item.length)).size > 1) return ERROR('#VALUE!');
        let total = 0;
        for (let index = 0; index < ranges[0].length; index += 1) total += ranges.reduce((product, items) => product * (typeof items[index] === 'number' ? items[index] : 0), 1);
        return total;
      }
      case 'CONCATENATE': case 'CONCAT': return flatten(args.map(value)).map(toText).join('');
      case 'LEN': return toText(scalar(value(args[0]))).length;
      case 'UPPER': return toText(scalar(value(args[0]))).toUpperCase();
      case 'LOWER': return toText(scalar(value(args[0]))).toLowerCase();
      case 'TRIM': return toText(scalar(value(args[0]))).trim().replace(/ +/g, ' ');
      case 'LEFT': case 'RIGHT': {
        const text = toText(scalar(value(args[0])));
        const count = args[1] ? toNumber(scalar(value(args[1]))) : 1;
        if (isError(count)) return count;
        return node.name === 'LEFT' ? text.slice(0, count) : text.slice(Math.max(0, text.length - count));
      }
      case 'MID': {
        const text = toText(scalar(value(args[0])));
        const start = toNumber(scalar(value(args[1])));
        const count = toNumber(scalar(value(args[2])));
        if (isError(start)) return start;
        if (isError(count)) return count;
        return text.slice(start - 1, start - 1 + count);
      }
      case 'VLOOKUP': {
        const key = scalar(value(args[0]));
        const table = value(args[1]);
        const index = toNumber(scalar(value(args[2])));
        const approximate = args[3] ? toBool(scalar(value(args[3]))) : true;
        if (approximate) throw new UnsupportedFormula('VLOOKUP with approximate match is not supported');
        for (let r = 0; r < table.rows; r += 1) {
          if (compare(table.values[r * table.columns], key) === 0) return table.values[r * table.columns + index - 1];
        }
        return ERROR('#N/A');
      }
      case 'MATCH': {
        const key = scalar(value(args[0]));
        const range = value(args[1]);
        const type = args[2] ? toNumber(scalar(value(args[2]))) : 1;
        if (type !== 0) throw new UnsupportedFormula('MATCH with approximate match is not supported');
        const at = range.values.findIndex((item) => compare(item, key) === 0);
        return at < 0 ? ERROR('#N/A') : at + 1;
      }
      case 'INDEX': {
        const range = value(args[0]);
        const r = toNumber(scalar(value(args[1])));
        const c = args[2] ? toNumber(scalar(value(args[2]))) : 1;
        if (!isRange(range)) return range;
        if (range.columns === 1 && !args[2]) return range.values[r - 1] ?? ERROR('#REF!');
        return range.values[(r - 1) * range.columns + (c - 1)] ?? ERROR('#REF!');
      }
      default: throw new UnsupportedFormula(`function ${node.name} is not supported`);
    }
  };
  const result = scalar(value(tree));
  return result === undefined ? null : result;
}
