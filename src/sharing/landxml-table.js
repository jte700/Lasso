// LandXML values as Civil 3D's Prospector lists them: one table per kind of
// element (pipes and structures per network, curves per alignment, PVIs per
// profile), a row per element, a column per property. Pipes carry the
// inverts at their two ends, read from the structures they run between.

const ROWS_BEFORE = 8;
const ROWS_AFTER = 40;

/** Which table a value belongs to, what that table is called, and what its first column names. */
const KINDS = {
  Parcel: { kind: 'parcel', title: () => 'Parcels', first: 'Parcel' },
  Alignment: { kind: 'alignment', title: () => 'Alignments', first: 'Alignment' },
  Curve: { kind: 'curve', title: (group) => `${group} curves`, first: 'Curve' },
  PVI: { kind: 'pvi', title: (group) => `${group} profile`, first: 'Station' },
  ParaCurve: { kind: 'pvi', title: (group) => `${group} profile`, first: 'Station' },
  CircCurve: { kind: 'pvi', title: (group) => `${group} profile`, first: 'Station' },
  Pipe: { kind: 'pipe', title: (group) => `${group ?? 'Network'} pipes`, first: 'Pipe' },
  Struct: { kind: 'structure', title: (group) => `${group ?? 'Network'} structures`, first: 'Structure' },
  CgPoint: { kind: 'point', title: (group) => (group ? `${group} points` : 'Survey points'), first: 'Point' },
  Surface: { kind: 'surface', title: () => 'Surfaces', first: 'Surface' },
};

const COLUMNS = {
  area: 'Area', length: 'Length', diameter: 'Diameter', height: 'Height', width: 'Width', span: 'Span',
  material: 'Material', slope: 'Slope', elevRim: 'Rim elevation', elevSump: 'Sump elevation', depth: 'Depth',
  staStart: 'Start station', staEnd: 'End station', radius: 'Radius', elevation: 'Elevation',
  northing: 'Northing', easting: 'Easting', elevMin: 'Minimum elevation', elevMax: 'Maximum elevation', area2DSurf: 'Plan area',
};

/** The kind of table a value sits in, or null for one Lasso lists nowhere. */
export function tableKind(fact) {
  return KINDS[fact.entityType] ?? null;
}

/** The column a value fills: "Rim elevation"; a PVI's curve is its "Vertical curve length". */
export function columnName(fact) {
  if (KINDS[fact.entityType]?.kind === 'pvi' && fact.propertyName === 'length') return 'Vertical curve length';
  return COLUMNS[fact.propertyName] ?? fact.propertyName;
}

/** The row a value is on: the element's name, a curve's name, a PVI's station. */
export function rowName(fact) {
  return fact.row ?? fact.entityName;
}

/** Each pipe's start and end inverts, from the structures at its ends. */
function pipeInverts(facts) {
  const byStructure = new Map(facts.filter((fact) => fact.entityType === 'Struct' && fact.pipeRef)
    .map((fact) => [`${fact.entityName}\n${fact.pipeRef}`, fact]));
  const ends = new Map();
  for (const route of facts.filter((fact) => fact.entityType === 'Pipe' && fact.propertyName === 'route')) {
    ends.set(route.elementId, {
      'Start invert': byStructure.get(`${route.from}\n${route.entityName}`),
      'End invert': byStructure.get(`${route.to}\n${route.entityName}`),
    });
  }
  return ends;
}

/** The rows of one table: its elements in file order, each with a value per column. */
function tableRows(facts, kind, group) {
  const rows = new Map();
  for (const fact of facts) {
    if (KINDS[fact.entityType]?.kind !== kind || (fact.group ?? null) !== group || fact.pipeRef) continue;
    if (!rows.has(fact.elementId)) rows.set(fact.elementId, { name: rowName(fact), cells: new Map() });
    const row = rows.get(fact.elementId);
    if (fact.propertyName === 'route') {
      row.cells.set('From', { fact, value: fact.from });
      row.cells.set('To', { fact, value: fact.to });
    } else {
      row.cells.set(columnName(fact), { fact, value: fact.value });
    }
    if (fact.description) row.cells.set('Description', { fact: null, value: fact.description });
  }
  if (kind === 'pipe') {
    const ends = pipeInverts(facts);
    for (const [elementId, row] of rows) {
      for (const [column, fact] of Object.entries(ends.get(elementId) ?? {})) if (fact) row.cells.set(column, { fact, value: fact.value });
    }
  }
  return [...rows.values()];
}

/**
 * The table a cited value is shown in, with its cell marked; null when the
 * value is not one Lasso lists in a table. A structure's invert for a pipe
 * is shown where Civil 3D lists it: in the pipe's row.
 */
export function landXmlTable(facts, cited) {
  const invertPipe = cited.entityType === 'Struct' && cited.pipeRef
    ? facts.find((fact) => fact.entityType === 'Pipe' && fact.entityName === cited.pipeRef && (fact.group ?? null) === (cited.group ?? null))
    : null;
  const anchorFact = invertPipe ?? cited;
  const type = tableKind(anchorFact);
  if (!type) return null;
  const group = anchorFact.group ?? null;
  const rows = tableRows(facts, type.kind, group);
  const columns = [...new Set(rows.flatMap((row) => [...row.cells.keys()]))];
  const index = rows.findIndex((row) => [...row.cells.values()].some((cell) => cell.fact === cited));
  if (index < 0) return null;
  const start = Math.max(0, index - ROWS_BEFORE);
  const end = Math.min(rows.length, index + ROWS_AFTER + 1);
  const headers = [type.first, ...columns];
  return {
    kind: 'table', format: 'landxml',
    // A property table has named columns, not spreadsheet letters.
    columns: headers.map(() => ''), headers,
    rows: rows.slice(start, end).map((row, offset) => ({
      rowNumber: start + offset + 1,
      cells: [{ value: row.name, cited: false },
        ...columns.map((column) => ({ value: row.cells.get(column)?.value ?? '', cited: row.cells.get(column)?.fact === cited }))],
    })),
    ...(rows.length > end ? { moreRows: rows.length - end } : {}),
    location: `${type.title(group)} · ${type.first} ${rows[index].name}`,
  };
}
