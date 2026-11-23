// The values a LandXML model states, element by element, as civil engineers
// and surveyors write them: parcel areas; alignment lengths, stations and
// curve radii; profile PVIs and vertical curves; pipe sizes, materials,
// routes and slopes; structure elevations, sizes and depths; survey points;
// surface ranges. A value is read only where the file states it with a
// declared unit. A slope and a depth are worked out from the elevations the
// file states, and say so (`measurementBasis`).

import { createHash } from 'node:crypto';

const SLOPE_DECIMALS = 2;
// Exports write floating-point noise (799.999999999896); plans show at most this many decimals.
const SHOWN_DECIMALS = 3;

export function numeric(value) {
  const raw = String(value ?? '').trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

/** The numbers written in an element's text: "5472.5 4919.3" (northing easting). */
export function textNumbers(node) {
  const values = String(node?.text ?? '').trim().split(/\s+/).filter(Boolean).map(numeric);
  return values.every((value) => value != null) ? values : [];
}

const round = (value, places) => Number(value.toFixed(places));
const shown = (value) => round(value, SHOWN_DECIMALS);

/**
 * A station as a plan labels it: "0+125.75" in metres (a station is 1000 m),
 * "24+55.50" in feet (a station is 100 ft).
 */
export function stationText(value, imperial) {
  const size = imperial ? 100 : 1000;
  const sign = value < 0 ? '-' : '';
  const whole = Math.floor(Math.abs(value) / size);
  const rest = (Math.abs(value) - whole * size).toFixed(2).padStart(imperial ? 5 : 6, '0');
  return `${sign}${whole}+${rest}`;
}

/** Records annotations for one model, given its declared units. */
export function annotationRecorder({ declarations, unit, warnings, lines, imperial }) {
  const annotations = [];
  const push = (element, source, propertyName, fields) => {
    const id = createHash('sha256').update(`${element.path}\n${source.path}\n${propertyName}`).digest('hex').slice(0, 24);
    annotations.push({ id: `landxml-${id}`, rawText: source.raw, measurementBasis: 'model-property', elementId: element.path,
      entityType: element.name, entityName: element.attributes.name ?? element.name, propertyName, ...fields,
      ...(lines ? { line: source.line } : {}) });
  };
  return {
    annotations,
    imperial,
    unit,
    /** A number the file states in an attribute, in its declared unit. */
    measure(element, source, propertyName, kind, unitType, label, { attribute = propertyName, units = null, ...extra } = {}) {
      const rawValue = source.attributes[attribute];
      if (rawValue == null) return null;
      const value = numeric(rawValue);
      if (value == null || (['area', 'length', 'diameter'].includes(kind) && value < 0)) {
        warnings.add(`Invalid ${propertyName} for ${element.attributes.name ?? element.name}; measurement omitted.`);
        return null;
      }
      const resolvedUnit = units ?? unit(unitType);
      if (!resolvedUnit) return null;
      push(element, source, propertyName, { label, kind, value: `${shown(value)} ${resolvedUnit}`, numericValue: value, units: resolvedUnit,
        sourcePropertyPath: `${source.path}/@${attribute}`, sourceUnits: declarations[unitType] ?? resolvedUnit, originalValue: rawValue, ...extra });
      return value;
    },
    /** A number the file states in an element's text (a point's elevation, a PVI's station). */
    stated(element, source, propertyName, kind, unitType, label, value, extra = {}) {
      const resolvedUnit = unit(unitType);
      if (value == null || !resolvedUnit) return;
      push(element, source, propertyName, { label, kind, value: `${shown(value)} ${resolvedUnit}`, numericValue: value, units: resolvedUnit,
        sourcePropertyPath: source.path, sourceUnits: declarations[unitType] ?? resolvedUnit, originalValue: String(value), ...extra });
    },
    /** A station: "0+125.75". */
    station(element, source, propertyName, label, value, extra = {}) {
      if (value == null || !unit('linearUnit')) return;
      push(element, source, propertyName, { label, kind: 'station', value: stationText(value, imperial), numericValue: value,
        units: unit('linearUnit'), sourcePropertyPath: source.path, originalValue: String(value), ...extra });
    },
    /** Words the file states: a material, the structures a pipe runs between. */
    words(element, source, propertyName, label, value, extra = {}) {
      const text = String(value ?? '').trim();
      if (!text) return;
      push(element, source, propertyName, { label, kind: 'text', value: text, numericValue: null, units: null,
        sourcePropertyPath: source.path, originalValue: text, ...extra });
    },
    /** A value worked out from stated values, rounded as plans round it. */
    derived(element, propertyName, kind, label, value, units, basis, extra = {}) {
      if (value == null || !Number.isFinite(value)) return;
      push(element, element, propertyName, { label, kind, value: units === '%' ? `${value}%` : `${value} ${units}`, numericValue: value,
        units, sourcePropertyPath: element.path, originalValue: String(value), measurementBasis: basis, ...extra });
    },
  };
}

function readParcels(root, children, record, warnings) {
  for (const collection of children(root, 'Parcels')) for (const parcel of children(collection, 'Parcel')) {
    const name = parcel.attributes.name;
    if (!name) { warnings.add('Unnamed parcel quantities were omitted.'); continue; }
    const terms = parcel.attributes.desc ? { searchTerms: parcel.attributes.desc } : {};
    record.measure(parcel, parcel, 'area', 'area', 'areaUnit', `Parcel ${name} area`, { group: collection.attributes.name ?? null, ...terms });
  }
}

function readProfiles(alignment, children, record) {
  for (const profile of children(alignment, 'Profile')) for (const design of children(profile, 'ProfAlign')) {
    const profileName = design.attributes.name ?? profile.attributes.name ?? alignment.attributes.name;
    for (const point of design.children.filter((child) => ['PVI', 'ParaCurve', 'CircCurve'].includes(child.name))) {
      const [station, elevation] = textNumbers(point);
      if (station == null || elevation == null) continue;
      const at = stationText(station, record.imperial);
      const extra = { group: profileName, row: at, station };
      record.stated(point, point, 'elevation', 'elevation', 'linearUnit', `Profile ${profileName} PVI ${at} elevation`, elevation, extra);
      if (point.name !== 'PVI') {
        record.measure(point, point, 'length', 'length', 'linearUnit', `Profile ${profileName} vertical curve at ${at} length`, extra);
      }
    }
  }
}

function readAlignments(root, children, record, warnings) {
  for (const collection of children(root, 'Alignments')) for (const alignment of children(collection, 'Alignment')) {
    const name = alignment.attributes.name;
    if (!name) { warnings.add('Unnamed alignment quantities were omitted.'); continue; }
    const group = { group: collection.attributes.name ?? null };
    const length = record.measure(alignment, alignment, 'length', 'length', 'linearUnit', `Alignment ${name} length`, group);
    const start = numeric(alignment.attributes.staStart);
    if (start != null) {
      record.station(alignment, alignment, 'staStart', `Alignment ${name} start station`, start, group);
      if (length != null) record.station(alignment, alignment, 'staEnd', `Alignment ${name} end station`, start + length, group);
    }
    let curve = 0;
    for (const geometry of children(alignment, 'CoordGeom')) for (const part of children(geometry, 'Curve')) {
      curve += 1;
      const curveName = part.attributes.name ?? `curve ${curve}`;
      const extra = { group: name, row: part.attributes.name ?? String(curve) };
      record.measure(part, part, 'radius', 'radius', 'linearUnit', `Alignment ${name} ${curveName} radius`, extra);
      record.measure(part, part, 'length', 'length', 'linearUnit', `Alignment ${name} ${curveName} length`, extra);
    }
    readProfiles(alignment, children, record);
  }
}

/** Each structure's stated invert elevation for each pipe that meets it. */
function invertsByStructure(network, children) {
  const inverts = new Map();
  for (const structs of children(network, 'Structs')) for (const structure of children(structs, 'Struct')) {
    for (const invert of children(structure, 'Invert')) {
      const elevation = numeric(invert.attributes.elev);
      if (structure.attributes.name && invert.attributes.refPipe && elevation != null) {
        inverts.set(`${structure.attributes.name}\n${invert.attributes.refPipe}`, elevation);
      }
    }
  }
  return inverts;
}

function readPipe(pipe, children, record, warnings, { group, inverts }) {
  const name = pipe.attributes.name;
  if (!name) { warnings.add('Unnamed pipe quantities were omitted.'); return; }
  const label = `Pipe ${name}`;
  const extra = { group };
  const { refStart, refEnd, material } = pipe.attributes;
  if (refStart && refEnd) record.words(pipe, pipe, 'route', `${label} route`, `${refStart} to ${refEnd}`, { ...extra, from: refStart, to: refEnd });
  const length = record.measure(pipe, pipe, 'length', 'length', 'linearUnit', `${label} length`, extra);
  for (const circular of children(pipe, 'CircPipe')) record.measure(pipe, circular, 'diameter', 'diameter', 'diameterUnit', `${label} diameter`, extra);
  for (const shaped of [...children(pipe, 'RectPipe'), ...children(pipe, 'EggPipe'), ...children(pipe, 'ElliPipe')]) {
    record.measure(pipe, shaped, 'height', 'length', 'diameterUnit', `${label} height`, extra);
    record.measure(pipe, shaped, 'width', 'length', 'diameterUnit', `${label} width`, extra);
    record.measure(pipe, shaped, 'span', 'length', 'diameterUnit', `${label} span`, extra);
  }
  record.words(pipe, pipe, 'material', `${label} material`, material, extra);
  // The fall between the inverts at each end over the pipe's length; the
  // file's own slope attribute does not say whether it is a ratio or a percent.
  const upper = inverts.get(`${refStart}\n${name}`);
  const lower = inverts.get(`${refEnd}\n${name}`);
  if (length > 0 && upper != null && lower != null) {
    record.derived(pipe, 'slope', 'slope', `${label} slope`, round(((upper - lower) / length) * 100, SLOPE_DECIMALS), '%', 'computed-from-inverts', extra);
  } else if (pipe.attributes.slope != null) {
    warnings.add(`${label} slope "${pipe.attributes.slope}" was omitted because its unit convention is not explicit.`);
  }
}

function readStructure(structure, children, record, warnings, { group }) {
  const name = structure.attributes.name;
  if (!name) { warnings.add('Unnamed structure elevations were omitted.'); return; }
  const extra = { group };
  const rim = record.measure(structure, structure, 'elevRim', 'elevation', 'linearUnit', `Structure ${name} rim elevation`, extra);
  const sump = record.measure(structure, structure, 'elevSump', 'elevation', 'linearUnit', `Structure ${name} sump elevation`, extra);
  if (rim != null && sump != null && record.unit('linearUnit')) {
    record.derived(structure, 'depth', 'length', `Structure ${name} depth`, round(rim - sump, 3), record.unit('linearUnit'), 'computed-from-elevations', extra);
  }
  for (const circular of children(structure, 'CircStruct')) record.measure(structure, circular, 'diameter', 'diameter', 'diameterUnit', `Structure ${name} diameter`, extra);
  for (const rectangular of children(structure, 'RectStruct')) {
    record.measure(structure, rectangular, 'length', 'length', 'diameterUnit', `Structure ${name} length`, extra);
    record.measure(structure, rectangular, 'width', 'length', 'diameterUnit', `Structure ${name} width`, extra);
  }
  for (const invert of children(structure, 'Invert')) {
    const pipeRef = invert.attributes.refPipe;
    record.measure(structure, invert, pipeRef ? `invert:${pipeRef}` : 'invert', 'elevation', 'linearUnit',
      `Structure ${name}${pipeRef ? ` pipe ${pipeRef}` : ''} invert elevation`, { attribute: 'elev', pipeRef: pipeRef ?? null, ...extra });
  }
}

function readPipeNetworks(root, children, record, warnings) {
  for (const networks of children(root, 'PipeNetworks')) for (const network of children(networks, 'PipeNetwork')) {
    const context = { group: network.attributes.name ?? null, inverts: invertsByStructure(network, children) };
    for (const pipes of children(network, 'Pipes')) for (const pipe of children(pipes, 'Pipe')) readPipe(pipe, children, record, warnings, context);
    for (const structs of children(network, 'Structs')) for (const structure of children(structs, 'Struct')) readStructure(structure, children, record, warnings, context);
  }
}

/** Survey points: northing, easting and elevation, in that order, as LandXML writes them. */
function readPoints(root, children, record) {
  for (const collection of children(root, 'CgPoints')) for (const point of children(collection, 'CgPoint')) {
    const name = point.attributes.name;
    const [northing, easting, elevation] = textNumbers(point);
    if (!name || northing == null || easting == null) continue;
    const extra = { group: collection.attributes.name ?? null, ...(point.attributes.desc ? { searchTerms: point.attributes.desc, description: point.attributes.desc } : {}) };
    record.stated(point, point, 'northing', 'coordinate', 'linearUnit', `Point ${name} northing`, northing, extra);
    record.stated(point, point, 'easting', 'coordinate', 'linearUnit', `Point ${name} easting`, easting, extra);
    if (elevation != null) record.stated(point, point, 'elevation', 'elevation', 'linearUnit', `Point ${name} elevation`, elevation, extra);
  }
}

function readSurfaces(root, children, record) {
  for (const collection of children(root, 'Surfaces')) for (const surface of children(collection, 'Surface')) {
    const name = surface.attributes.name;
    if (!name) continue;
    const extra = { group: collection.attributes.name ?? null };
    for (const definition of children(surface, 'Definition')) {
      record.measure(surface, definition, 'elevMin', 'elevation', 'linearUnit', `Surface ${name} minimum elevation`, extra);
      record.measure(surface, definition, 'elevMax', 'elevation', 'linearUnit', `Surface ${name} maximum elevation`, extra);
      record.measure(surface, definition, 'area2DSurf', 'area', 'areaUnit', `Surface ${name} plan area`, extra);
    }
  }
}

/** Every value the model states, in the order a civil set reads: parcels, alignments, pipe networks, points, surfaces. */
export function readCivilModel(root, children, record, warnings) {
  readParcels(root, children, record, warnings);
  readAlignments(root, children, record, warnings);
  readPipeNetworks(root, children, record, warnings);
  readPoints(root, children, record);
  readSurfaces(root, children, record);
  return record.annotations;
}
