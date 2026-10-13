// STEP/IFC property reader: resolves relationships, quantities and declared
// units without trying to tessellate the model or infer absent quantities.
const MAX_BYTES = 64_000_000;
const MAX_RECORDS = 500_000;
const MAX_FACTS = 8_000;
const PREFIX = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: 0.1, CENTI: 0.01, MILLI: 0.001, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12 };
const DIMENSIONS = { LENGTHUNIT: ['m', 1], AREAUNIT: ['m²', 2], VOLUMEUNIT: ['m³', 3] };
const MEASURES = { IFCQUANTITYAREA: 'AREAUNIT', IFCQUANTITYLENGTH: 'LENGTHUNIT', IFCQUANTITYVOLUME: 'VOLUMEUNIT', IFCAREAMEASURE: 'AREAUNIT', IFCLENGTHMEASURE: 'LENGTHUNIT', IFCPOSITIVELENGTHMEASURE: 'LENGTHUNIT', IFCVOLUMEMEASURE: 'VOLUMEUNIT' };

function decodeStep(value) {
  return value.replace(/\\X([24])\\([0-9a-f]+)\\X0\\/gi, (_, size, hex) => {
    const width = Number(size) * 2;
    if (hex.length % width) return '';
    let output = '';
    for (let index = 0; index < hex.length; index += width) {
      const code = parseInt(hex.slice(index, index + width), 16);
      if (code > 0x10ffff) return '';
      output += String.fromCodePoint(code);
    }
    return output;
  }).replace(/\\X\\([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\S\\(.)/g, (_, character) => String.fromCharCode(character.charCodeAt(0) + 128));
}

export function parseStepArguments(source) {
  let cursor = 0;
  function whitespace() { while (/\s/.test(source[cursor] ?? '') && cursor < source.length) cursor++; }
  function value(depth) {
    if (depth > 64) throw new Error('IFC property nesting exceeds the supported limit.');
    whitespace();
    const first = source[cursor++];
    if (first === "'") {
      let text = '';
      while (cursor < source.length) {
        const next = source[cursor++];
        if (next === "'") {
          if (source[cursor] === "'") { cursor++; text += "'"; } else return decodeStep(text);
        } else text += next;
      }
      throw new Error('Unterminated IFC string.');
    }
    if (first === '(') return list(depth + 1, true);
    if (first === '$' || first === '*') return null;
    if (first === '#') {
      const number = source.slice(cursor).match(/^\d+/)?.[0];
      if (!number) throw new Error('Invalid IFC reference.');
      cursor += number.length;
      return { ref: Number(number) };
    }
    if (first === '.') {
      const enumeration = source.slice(cursor).match(/^([A-Z_]+)\./i);
      if (enumeration) { cursor += enumeration[0].length; return enumeration[1].toUpperCase(); }
    }
    cursor--;
    const numeric = source.slice(cursor).match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (numeric) { cursor += numeric[0].length; return Number(numeric[0]); }
    const type = source.slice(cursor).match(/^[A-Z][A-Z0-9_]*/i);
    if (type) {
      cursor += type[0].length; whitespace();
      if (source[cursor++] !== '(') throw new Error('Invalid IFC typed value.');
      return { type: type[0].toUpperCase(), args: list(depth + 1, true) };
    }
    throw new Error('Invalid IFC property value.');
  }
  function list(depth, closing) {
    const values = [];
    whitespace();
    if (closing && source[cursor] === ')') { cursor++; return values; }
    while (cursor < source.length) {
      values.push(value(depth)); whitespace();
      if (closing && source[cursor] === ')') { cursor++; return values; }
      if (!closing && cursor === source.length) return values;
      if (source[cursor++] !== ',') throw new Error('Invalid IFC argument separator.');
      whitespace();
      if (cursor === source.length || source[cursor] === ')') throw new Error('Trailing IFC argument separator.');
    }
    if (closing) throw new Error('Unterminated IFC list.');
    return values;
  }
  return list(0, false);
}

function stepSections(source) {
  const statements = [];
  let start = 0, quoted = false, depth = 0;
  for (let cursor = 0; cursor < source.length; cursor++) {
    const character = source[cursor];
    if (character === "'") {
      if (quoted && source[cursor + 1] === "'") { cursor++; continue; }
      quoted = !quoted;
    }
    if (quoted) continue;
    if (character === '(') depth++;
    if (character === ')' && --depth < 0) throw new Error('Unbalanced IFC record.');
    if (character === ';' && depth === 0) {
      statements.push(source.slice(start, cursor).trim()); start = cursor + 1;
      if (statements.length > MAX_RECORDS + 100) throw new Error('IFC exceeds the record limit.');
    }
  }
  if (quoted || depth || source.slice(start).trim()) throw new Error('Truncated IFC STEP document.');
  const dataStart = statements.findIndex((part) => /^DATA$/i.test(part));
  if (!/^ISO-10303-21$/i.test(statements[0] ?? '') || !/^HEADER$/i.test(statements[1] ?? '')
    || dataStart < 4 || !/^ENDSEC$/i.test(statements[dataStart - 1] ?? '')
    || !/^ENDSEC$/i.test(statements.at(-2) ?? '') || !/^END-ISO-10303-21$/i.test(statements.at(-1) ?? '')) {
    throw new Error('Expected one IFC HEADER section and one DATA section inside the STEP document.');
  }
  return { header: statements.slice(2, dataStart - 1), data: statements.slice(dataStart + 1, -2) };
}

function recordsFrom(statements) {
  const records = new Map();
  for (const statement of statements) {
    if (records.size >= MAX_RECORDS) throw new Error('IFC exceeds the 500,000 entity limit.');
    const match = statement.match(/^#(\d+)\s*=\s*(IFC[A-Z0-9_]+)\s*\(([\s\S]*)\)$/i);
    if (!match) throw new Error('Invalid entity in IFC DATA section.');
    const entityId = Number(match[1]);
    if (records.has(entityId)) throw new Error('Duplicate IFC STEP entity identifier.');
    records.set(entityId, { id: entityId, type: match[2].toUpperCase(), body: match[3], raw: `${statement};` });
  }
  return records;
}

const reference = (value) => value && typeof value === 'object' && Number.isInteger(value.ref) ? value.ref : null;
const scalar = (value) => value && typeof value === 'object' && value.type ? scalar(value.args?.[0]) : value;
const pretty = (value) => String(value ?? '').replace(/([a-z])([A-Z])/g, '$1 $2');
const format = (value) => Number(value.toPrecision(12)).toString();

export function extractIfcDocument(buffer) {
  const warnings = new Set();
  const result = { isDrawing: true, format: 'IFC', method: 'ifc-properties', status: 'ready', warnings: [], pages: [] };
  function fail(reason) { return { ...result, status: 'error', warnings: [reason] }; }
  if (buffer.length > MAX_BYTES) return fail('IFC exceeds the 64 MB extraction limit.');
  let source = buffer.toString('utf8');
  if (!/^\s*ISO-10303-21;/i.test(source) || !/END-ISO-10303-21\s*;/i.test(source)) return fail('Expected a complete IFC STEP (.ifc) exchange file.');
  // STEP comments are ignored, but quoted descriptions remain evidence.
  source = source.replace(/'(?:[^']|'')*'|\/\*[\s\S]*?\*\//g, (part) => part.startsWith('/*') ? ' '.repeat(part.length) : part);
  let sections, schema;
  try {
    sections = stepSections(source);
    const schemaStatement = sections.header.find((part) => /^FILE_SCHEMA\s*\(/i.test(part));
    schema = parseStepArguments(schemaStatement?.match(/^FILE_SCHEMA\s*\(([\s\S]*)\)$/i)?.[1] ?? '')?.[0]?.[0] ?? '';
  } catch (error) { return fail(error.message); }
  if (!/^IFC(?:2X3|4(?:X[123])?)(?:_|$)/i.test(schema)) return { ...result, status: 'unsupported', warnings: [`Unsupported IFC schema ${schema || '(missing)'}. Use IFC2X3 or IFC4/4.3 STEP.`] };
  let records;
  try { records = recordsFrom(sections.data); } catch (error) { return fail(error.message); }
  const get = (ref) => records.get(typeof ref === 'number' ? ref : reference(ref));
  const args = (entity) => entity ? entity.args ??= parseStepArguments(entity.body) : [];
  const unit = (ref, depth = 0) => {
    if (depth > 8) return null;
    const entity = get(ref);
    if (!entity) return null;
    const values = args(entity), dimension = values[1];
    if (!DIMENSIONS[dimension]) return null;
    const [units, power] = DIMENSIONS[dimension];
    if (entity.type === 'IFCSIUNIT') {
      if (values[3] !== ({ LENGTHUNIT: 'METRE', AREAUNIT: 'SQUARE_METRE', VOLUMEUNIT: 'CUBIC_METRE' })[dimension]) return null;
      const multiplier = values[2] == null ? 1 : PREFIX[values[2]];
      if (!multiplier) return null;
      return { units, dimension, factor: multiplier ** power, sourceUnits: `${values[2] ?? ''}${values[3]}` };
    }
    if (entity.type === 'IFCCONVERSIONBASEDUNIT') {
      const conversion = get(values[3]);
      if (conversion?.type !== 'IFCMEASUREWITHUNIT') return null;
      const [factor, base] = args(conversion), underlying = unit(base, depth + 1);
      const number = scalar(factor);
      if (!underlying || underlying.dimension !== dimension || typeof number !== 'number' || !Number.isFinite(number) || number <= 0) return null;
      return { units, dimension, factor: number * underlying.factor, sourceUnits: values[2] };
    }
    return null;
  };
  const defaults = new Map();
  const parents = new Map();
  const annotations = [];
  const seen = new Map();
  try {
    const projects = [...records.values()].filter((entity) => entity.type === 'IFCPROJECT');
    if (projects.length !== 1) return fail('IFC must contain one project to resolve measurement units unambiguously.');
    const project = projects[0], projectValues = args(project), assignment = get(projectValues[8]);
    for (const ref of args(assignment)[0] ?? []) {
      const resolved = unit(ref);
      if (resolved) {
        if (defaults.has(resolved.dimension)) return fail(`IFC has ambiguous ${resolved.dimension} definitions.`);
        defaults.set(resolved.dimension, resolved);
      }
    }
    for (const entity of records.values()) {
      if (entity.type === 'IFCRELAGGREGATES') {
        const values = args(entity);
        for (const child of values[5] ?? []) parents.set(reference(child), reference(values[4]));
      } else if (entity.type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE') {
        const values = args(entity);
        for (const child of values[4] ?? []) parents.set(reference(child), reference(values[5]));
      }
    }
    const location = (entity) => {
      const chain = [], visited = new Set();
      for (let current = parents.get(entity.id); current && !visited.has(current) && chain.length < 8; current = parents.get(current)) {
        visited.add(current); const parent = get(current);
        if (parent) chain.push({ type: parent.type, name: args(parent)[2], globalId: args(parent)[0] });
      }
      return chain;
    };
    for (const relation of records.values()) {
      if (relation.type !== 'IFCRELDEFINESBYPROPERTIES') continue;
      const rel = args(relation), setRefs = Array.isArray(rel[5]) ? rel[5] : rel[5]?.type === 'IFCPROPERTYSETDEFINITIONSET' ? rel[5].args[0] : [rel[5]];
      for (const setRef of setRefs ?? []) {
        const set = get(setRef);
        if (!['IFCELEMENTQUANTITY', 'IFCPROPERTYSET'].includes(set?.type)) continue;
        const values = args(set), quantity = set.type === 'IFCELEMENTQUANTITY', setName = values[2] ?? set.type;
        for (const targetRef of rel[4] ?? []) {
          const target = get(targetRef);
          if (!target) continue;
          const targetValues = args(target), globalId = targetValues[0];
          if (typeof globalId !== 'string' || !globalId) continue;
          const entityName = [target.type === 'IFCSPACE' ? targetValues[7] : null, targetValues[2]].filter(Boolean).filter((name, index, names) => names.indexOf(name) === index).join(' · ') || target.type;
          const spatialPath = location(target);
          for (const propertyRef of values[quantity ? 5 : 4] ?? []) {
            const property = get(propertyRef);
            if (!property) continue;
            const p = args(property), propertyName = p[0];
            let dimension = quantity ? MEASURES[property.type] : MEASURES[p[2]?.type];
            const typedValue = quantity ? p[3] : p[2];
            const originalValue = scalar(typedValue);
            if (typeof originalValue !== 'number' || !Number.isFinite(originalValue)) continue;
            if (!quantity && property.type !== 'IFCPROPERTYSINGLEVALUE') continue;
            const explicitUnit = quantity ? p[2] : p[3];
            const resolvedUnit = explicitUnit ? unit(explicitUnit) : defaults.get(dimension);
            if (!dimension && resolvedUnit) dimension = resolvedUnit.dimension;
            if (!dimension || !resolvedUnit || resolvedUnit.dimension !== dimension) {
              if (dimension) warnings.add(`No supported ${dimension} for ${entityName} / ${propertyName}; quantity omitted.`);
              continue;
            }
            if (originalValue < 0 && dimension !== 'LENGTHUNIT') { warnings.add(`Negative ${propertyName} on ${entityName} omitted.`); continue; }
            const numericValue = originalValue * resolvedUnit.factor;
            if (!Number.isFinite(numericValue)) continue;
            let id = `${globalId}:${values[0] ?? setName}:${propertyName}`;
            if (seen.get(id) === property.id) continue;
            if (seen.has(id)) {
              warnings.add(`Duplicate property ${propertyName} on ${entityName}; compare its sources before using it.`);
              id += `:duplicate:${property.id}`;
            }
            seen.set(id, property.id);
            if (annotations.length >= MAX_FACTS) { warnings.add('IFC measurement index limited to 8,000 properties.'); break; }
            const areaType = /net/i.test(propertyName) ? 'net' : /gross/i.test(propertyName) ? 'gross' : null;
            const kind = dimension === 'AREAUNIT' ? target.type === 'IFCSPACE' && /^(?:(?:net|gross)?(?:floor|planned))?area$/i.test(propertyName) ? 'room_area' : 'area'
              : dimension === 'VOLUMEUNIT' ? 'volume' : /diameter/i.test(propertyName) ? 'pipe_diameter' : /elevation|invert/i.test(propertyName) ? 'elevation' : 'length';
            annotations.push({ id, label: `${entityName} ${pretty(propertyName)}`, entityName,
              kind, value: `${format(numericValue)} ${resolvedUnit.units}`, numericValue, units: resolvedUnit.units,
              originalNumericValue: originalValue, originalUnits: resolvedUnit.sourceUnits, unitFactor: resolvedUnit.factor,
              rawText: `${target.raw}\n${set.type} ${setName}\n${property.raw}`, confidence: 1,
              measurementBasis: 'model-property', entityType: target.type, elementId: globalId, globalId,
              stepId: `#${target.id}`, propertyStepId: `#${property.id}`, propertySet: setName, propertyName, areaType,
              roomName: target.type === 'IFCSPACE' ? targetValues[7] ?? targetValues[2] : null,
              roomNumber: target.type === 'IFCSPACE' ? targetValues[2] : null,
              storey: spatialPath.find((parent) => parent.type === 'IFCBUILDINGSTOREY')?.name ?? null,
              spatialPath, bbox: null,
            });
          }
        }
      }
    }
    if (!annotations.length) warnings.add('No supported quantities were exported. Export IFC rooms/spaces and base quantities or typed property sets from the authoring application.');
    result.pages.push({ pageNumber: null, sheetNumber: null, title: projectValues[2] || 'IFC model', text: `${schema} · ${records.size} entities · ${annotations.length} measurements`, annotations });
  } catch (error) { return fail(`Cannot read IFC properties: ${error.message}`); }
  result.schema = schema;
  result.warnings = [...warnings];
  result.status = warnings.size ? 'partial' : 'ready';
  return result;
}
