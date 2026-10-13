// LandXML values come from named civil model elements and declared units.
// This bounded XML reader never loads schemas, DTDs, or external entities.
import { createHash } from 'node:crypto';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ELEMENTS = 250_000;
const LANDXML_NS = /^https?:\/\/www\.landxml\.org\/schema\/LandXML-1\.[012]\/?$/i;
const UNIT_NAMES = {
  meter: 'm', metre: 'm', millimeter: 'mm', centimeter: 'cm', kilometer: 'km',
  foot: 'ft', ussurveyfoot: 'US survey ft', inch: 'in', yard: 'yd', mile: 'mi',
  squaremeter: 'm²', squaremetre: 'm²', squaremillimeter: 'mm²', squarecentimeter: 'cm²', squarekilometer: 'km²',
  squarefoot: 'ft²', squareussurveyfoot: 'US survey ft²', squareinch: 'in²', squareyard: 'yd²', squaremile: 'mi²',
  hectare: 'ha', acre: 'acre',
};

function decodeXml(value) {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/i.test(value)) throw new Error('Unsupported XML entity reference.');
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (_, entity) => {
    const known = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
    if (known) return known;
    const point = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(point) || point <= 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new Error('Invalid XML character reference.');
    return String.fromCodePoint(point);
  });
}

function parseXml(source) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error('LandXML DTDs and entity declarations are not supported.');
  const document = { name: '#document', children: [], namespaces: {}, path: '', childCounts: new Map() };
  const stack = [document];
  const tagPattern = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_][\w:.-]*(?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g;
  let cursor = 0, count = 0;
  for (const token of source.matchAll(tagPattern)) {
    const preceding = source.slice(cursor, token.index);
    if (preceding.includes('<') || (stack.length === 1 && preceding.trim())) throw new Error('Malformed XML content.');
    cursor = token.index + token[0].length;
    const tag = token[0];
    if (tag.startsWith('<!--') || tag.startsWith('<?') || tag.startsWith('<![CDATA[')) continue;
    const closing = tag.startsWith('</');
    const name = tag.match(/^<\/?([^\s/>]+)/)[1];
    if (closing) {
      if (stack.length === 1 || stack.at(-1).qualifiedName !== name || !/^<\/[^\s/>]+\s*>$/.test(tag)) throw new Error('Mismatched XML closing element.');
      stack.pop();
      continue;
    }
    if (++count > MAX_ELEMENTS || stack.length > 128) throw new Error('LandXML exceeds the XML complexity limit.');
    const parent = stack.at(-1);
    const attributeText = tag.slice(1 + name.length).replace(/\/?\s*>$/, '');
    const attributes = Object.create(null);
    let attributeCursor = 0;
    for (const attribute of attributeText.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g)) {
      if (attributeText.slice(attributeCursor, attribute.index).trim()) throw new Error('Malformed XML attribute.');
      if (Object.hasOwn(attributes, attribute[1])) throw new Error('Duplicate XML attribute.');
      attributes[attribute[1]] = decodeXml(attribute[2] ?? attribute[3]);
      attributeCursor = attribute.index + attribute[0].length;
    }
    if (attributeText.slice(attributeCursor).trim()) throw new Error('Malformed XML attribute.');
    const namespaces = { ...parent.namespaces };
    for (const [key, value] of Object.entries(attributes)) {
      if (key === 'xmlns') namespaces[''] = value;
      else if (key.startsWith('xmlns:')) namespaces[key.slice(6)] = value;
    }
    const parts = name.split(':');
    if (parts.length > 2 || (parts.length === 2 && !Object.hasOwn(namespaces, parts[0]))) throw new Error('Invalid XML namespace prefix.');
    const localName = parts.at(-1);
    const namespace = namespaces[parts.length === 2 ? parts[0] : ''] ?? '';
    const identity = attributes.name != null ? `${localName}[name=${JSON.stringify(attributes.name)}]` : localName;
    const ordinal = (parent.childCounts.get(identity) ?? 0) + 1;
    parent.childCounts.set(identity, ordinal);
    const node = { name: localName, qualifiedName: name, namespace, namespaces, attributes, children: [],
      childCounts: new Map(), path: `${parent.path}/${identity}${ordinal > 1 ? `[${ordinal}]` : ''}`, raw: tag };
    parent.children.push(node);
    if (!tag.endsWith('/>')) stack.push(node);
  }
  if (stack.length !== 1 || source.slice(cursor).trim() || document.children.length !== 1) throw new Error('Incomplete or invalid XML document.');
  return document.children[0];
}

function numeric(value) {
  const raw = String(value ?? '').trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

/** Reads a LandXML 1.0–1.2 model without estimating unspecified quantities. */
export function extractLandXmlDocument(buffer) {
  const result = { isDrawing: true, format: 'LandXML', method: 'landxml-properties', status: 'ready', warnings: [], pages: [] };
  const fail = (message) => ({ ...result, status: 'error', warnings: [message] });
  if (buffer.length > MAX_BYTES) return fail('LandXML exceeds the 32 MB extraction limit.');
  let root;
  try { root = parseXml(buffer.toString('utf8').replace(/^\uFEFF/, '')); } catch (error) { return fail(error.message); }
  if (root.name !== 'LandXML' || (root.namespace && !LANDXML_NS.test(root.namespace))) return { ...result, isDrawing: false, status: 'unsupported', warnings: ['Expected a LandXML exchange document.'] };
  if (root.attributes.version && !/^1\.[012]$/.test(root.attributes.version)) return { ...result, status: 'unsupported', warnings: [`Unsupported LandXML version ${root.attributes.version}.`] };
  const children = (node, name) => node.children.filter((child) => child.name === name && child.namespace === root.namespace);
  const warnings = new Set();
  const unitDeclarations = children(root, 'Units').flatMap((node) => [...children(node, 'Metric'), ...children(node, 'Imperial')]);
  if (unitDeclarations.length !== 1) return fail('LandXML must declare exactly one Metric or Imperial unit system.');
  const declarations = unitDeclarations[0].attributes;
  const unit = (kind) => {
    const declared = declarations[kind];
    const key = String(declared ?? '').toLowerCase();
    const areaUnit = /^(?:square|hectare$|acre$)/.test(key);
    const value = Object.hasOwn(UNIT_NAMES, key) && (kind === 'areaUnit') === areaUnit ? UNIT_NAMES[key] : null;
    if (!value) warnings.add(`Missing or unsupported declared ${kind}${declared ? ` "${declared}"` : ''}; measurements needing it were omitted.`);
    return value ?? null;
  };
  const annotations = [];
  const add = (element, source, propertyName, kind, unitType, label, { attribute = propertyName, units = null, ...extra } = {}) => {
    const rawValue = source.attributes[attribute];
    if (rawValue == null) return;
    const value = numeric(rawValue);
    if (value == null || (['area', 'length', 'diameter'].includes(kind) && value < 0)) {
      warnings.add(`Invalid ${propertyName} for ${element.attributes.name ?? element.name}; measurement omitted.`);
      return;
    }
    const resolvedUnit = units ?? unit(unitType);
    if (!resolvedUnit) return;
    const id = createHash('sha256').update(`${element.path}\n${source.path}\n${propertyName}`).digest('hex').slice(0, 24);
    annotations.push({ id: `landxml-${id}`, label, kind, value: `${value} ${resolvedUnit}`, numericValue: value, units: resolvedUnit,
      rawText: source.raw, measurementBasis: 'model-property', elementId: element.path, entityType: element.name,
      entityName: element.attributes.name ?? element.name, propertyName, sourcePropertyPath: `${source.path}/@${attribute}`,
      sourceUnits: declarations[unitType] ?? resolvedUnit, originalValue: rawValue, ...extra });
  };
  for (const collection of children(root, 'Parcels')) for (const parcel of children(collection, 'Parcel')) {
    const name = parcel.attributes.name;
    if (!name) { warnings.add('Unnamed parcel quantities were omitted.'); continue; }
    add(parcel, parcel, 'area', 'area', 'areaUnit', `Parcel ${name} area`);
  }
  for (const collection of children(root, 'Alignments')) for (const alignment of children(collection, 'Alignment')) {
    const name = alignment.attributes.name;
    if (!name) { warnings.add('Unnamed alignment quantities were omitted.'); continue; }
    add(alignment, alignment, 'length', 'length', 'linearUnit', `Alignment ${name} length`);
  }
  for (const networks of children(root, 'PipeNetworks')) for (const network of children(networks, 'PipeNetwork')) {
    for (const pipes of children(network, 'Pipes')) for (const pipe of children(pipes, 'Pipe')) {
      const name = pipe.attributes.name;
      if (!name) { warnings.add('Unnamed pipe quantities were omitted.'); continue; }
      const label = `Pipe ${name}`;
      add(pipe, pipe, 'length', 'length', 'linearUnit', `${label} length`);
      for (const circular of children(pipe, 'CircPipe')) add(pipe, circular, 'diameter', 'diameter', 'diameterUnit', `${label} diameter`);
      if (pipe.attributes.slope != null) warnings.add(`${label} slope "${pipe.attributes.slope}" was omitted because its unit convention is not explicit.`);
    }
    for (const structs of children(network, 'Structs')) for (const structure of children(structs, 'Struct')) {
      const name = structure.attributes.name;
      if (!name) { warnings.add('Unnamed structure elevations were omitted.'); continue; }
      add(structure, structure, 'elevRim', 'elevation', 'linearUnit', `Structure ${name} rim elevation`);
      add(structure, structure, 'elevSump', 'elevation', 'linearUnit', `Structure ${name} sump elevation`);
      for (const invert of children(structure, 'Invert')) {
        const pipeRef = invert.attributes.refPipe;
        add(structure, invert, pipeRef ? `invert:${pipeRef}` : 'invert', 'elevation', 'linearUnit',
          `Structure ${name}${pipeRef ? ` pipe ${pipeRef}` : ''} invert elevation`, { attribute: 'elev', pipeRef: pipeRef ?? null });
      }
    }
  }
  if (!annotations.length) warnings.add('No supported named parcel, alignment, pipe, or structure measurements with declared units were found.');
  const project = children(root, 'Project')[0];
  const title = project?.attributes.name ?? 'LandXML civil model';
  const text = [title, ...annotations.map((annotation) => `${annotation.label}: ${annotation.value}`)].join('\n');
  return { ...result, status: warnings.size ? 'partial' : 'ready', warnings: [...warnings],
    pages: [{ pageNumber: 1, sheetNumber: null, title, text, annotations, status: warnings.size ? 'partial' : 'ready' }] };
}
