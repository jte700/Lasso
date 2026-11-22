// The dim words at the right of a suggestion's row on the card, for table
// sources, read in layers: a column says what it holds ("Column · 1,250 to
// 126,400"), a value says which column and row it came from ("Invoice column ·
// Maple Paper Distribution"), a row shows its first cells ("Row · Actual 18000,
// Budget 18000"). A value whose row names something else ("Revenue" beside
// 485000) keeps showing the value. Each stays short enough to sit beside the
// suggestion's own name on one line without crowding it.

const SAMPLES_SHOWN = 2;
const FIELDS_SHOWN = 2;
const ROW_VALUES_SHOWN = 2;
// About what fits at the right of a card row beside a name of average length.
export const DETAIL_CHARACTERS = 32;
// Fewer letters than this of a cut part say nothing; it is left out instead.
const SHORTEST_PART = 8;
const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

const clean = (text) => String(text ?? '').trim();
const same = (left, right) => clean(left).toLowerCase() === clean(right).toLowerCase();
const hasLetter = (text) => /\p{L}/u.test(clean(text));

/** The text cut at a word to `room` characters, ending in an ellipsis. */
function cutWords(text, room) {
  if (text.length <= room) return text;
  const slice = text.slice(0, room - 1);
  const space = slice.lastIndexOf(' ');
  const kept = space >= room / 2 ? slice.slice(0, space) : slice;
  return `${kept.replace(/[\s,;:·-]+$/u, '')}…`;
}

/**
 * The head, then the first tail that fits whole after it. When none does, the
 * last tail is cut to the room left, or left out when too little is.
 * @param {string} head what the detail always says ("Column", "Invoice column")
 * @param {string[]} tails what may follow, longest first
 * @param {string} [separator]
 * @param {{ cut?: boolean }} [options] cut: false leaves a tail whole or out
 * @returns {string}
 */
function fitted(head, tails, separator = ' · ', { cut = true } = {}) {
  const start = cutWords(head, DETAIL_CHARACTERS);
  const room = DETAIL_CHARACTERS - start.length - separator.length;
  const present = tails.filter(Boolean);
  const whole = present.find((tail) => tail.length <= room);
  if (whole) return `${start}${separator}${whole}`;
  return cut && present.length && room >= SHORTEST_PART ? `${start}${separator}${cutWords(present.at(-1), room)}` : start;
}

/**
 * What an inferred column holds: its range when numeric, else its first values.
 * @param {{ metadata?: object }} object a VARIABLE read from a table's column
 * @returns {string}
 */
function columnDetail(object) {
  const { range, samples = [] } = object.metadata ?? {};
  if (range && Number.isFinite(range.min) && Number.isFinite(range.max)) {
    return fitted('Column', [range.min === range.max ? NUMBER.format(range.min)
      : `${NUMBER.format(range.min)} to ${NUMBER.format(range.max)}`]);
  }
  const shown = samples.map(clean).filter(Boolean);
  const more = (count) => (shown.length > count ? ', …' : '');
  return fitted('Column', Array.from({ length: Math.min(SAMPLES_SHOWN, shown.length) },
    (_, index) => `${shown.slice(0, SAMPLES_SHOWN - index).join(', ')}${more(SAMPLES_SHOWN - index)}`));
}

/**
 * A row's first cells past its name, each by its field ("Row · Actual 18000,
 * Budget 18000"), or, when its cells are not at hand, which fields it has.
 * @param {{ label?: string, metadata?: object }} object a DATASET_ROW
 * @param {{ column?: string, value?: string }[]} [cells] the row's cells, left to right
 * @returns {string}
 */
function rowDetail(object, cells = []) {
  const name = clean(object.anchor?.rowKey ?? object.label);
  const shown = cells.filter(({ value }) => clean(value) && !same(value, name))
    .slice(0, ROW_VALUES_SHOWN)
    .map(({ column, value }) => (hasLetter(column) ? `${clean(column)} ${clean(value)}` : clean(value)));
  if (shown.length) return fitted('Row', shown.map((_, index) => shown.slice(0, shown.length - index).join(', ')));
  const columns = (object.metadata?.columns ?? []).map(clean).filter(Boolean);
  const fields = columns.length > 1 ? columns.slice(1) : columns;
  const listed = (count) => `${fields.slice(0, count).join(', ')}${fields.length > count ? ` +${fields.length - count}` : ''}`;
  return fitted('Row', fields.length ? [listed(FIELDS_SHOWN), listed(1)] : []);
}

/**
 * Where a cell sits: its column, then the row it belongs to. A statement's
 * cell is named by its row first ("Rent · September Actual CAD").
 * @param {{ anchor?: object, metadata?: object, valueText?: string }} object
 * @returns {string|null}
 */
function cellDetail(object) {
  const anchor = object.anchor ?? {};
  const column = clean(object.metadata?.column ?? anchor.column);
  const row = clean(anchor.rowKey ?? object.metadata?.row);
  const namedColumn = hasLetter(column) && !column.startsWith('column:') ? column : '';
  // A row known only by a number or by this very value adds nothing.
  const namedRow = hasLetter(row) && !same(row, object.valueText) ? row : '';
  if (object.metadata?.orientation === 'ROW' && namedRow) return fitted(namedRow, [namedColumn]);
  if (!namedColumn) return namedRow ? cutWords(namedRow, DETAIL_CHARACTERS) : null;
  return fitted(`${namedColumn} column`, [namedRow]);
}

/**
 * The detail for a suggestion, or null to leave the card's own (the value).
 * @param {object} object the suggestion's source object
 * @param {string} shown the words the card shows as the suggestion's name
 * @param {{ rowCells?: { column?: string, value?: string }[] }} [context] a row's cells, when read
 * @returns {string|null}
 */
export function suggestionDetail(object, shown, context = {}) {
  if (!object?.objectType) return null;
  const kind = object.anchor?.kind;
  if (object.objectType === 'VARIABLE' && kind === 'table-column' && !object.metadata?.dictionary) {
    return columnDetail(object);
  }
  if (object.objectType === 'DATASET_ROW' && kind === 'table-row' && !clean(object.valueText)) {
    return rowDetail(object, context.rowCells);
  }
  // A value shown as its own name would otherwise be repeated beside itself.
  if (kind === 'table-cell' && (!clean(object.valueText) || same(shown, object.valueText))) {
    return cellDetail(object);
  }
  return null;
}

/**
 * What a cell from a tabbed value's row is: its field, of that value
 * ("Outstanding CAD of BILL-1160").
 * The row's own name sits in its table's label column.
 * @param {object} object the row mate's source object
 * @param {string} tabbedValue the value tabbed from the row
 * @param {number} [labelColumn] the index of the column naming the table's rows
 * @returns {string}
 */
export function rowMateDetail(object, tabbedValue, labelColumn = 0) {
  const column = clean(object.anchor?.kind === 'table-row'
    ? object.metadata?.columns?.[labelColumn]
    : object.metadata?.column ?? object.anchor?.column);
  return hasLetter(column) && !column.startsWith('column:')
    ? fitted(column, [`of ${tabbedValue}`], ' ', { cut: false }) : cutWords(`From ${tabbedValue}`, DETAIL_CHARACTERS);
}
