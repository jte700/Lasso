// A bounded XML reader shared by LandXML and every other XML file. It never
// loads schemas, DTDs or external entities: a document type without an
// internal subset is skipped, and entity declarations are refused.

const MAX_ELEMENTS = 250_000;
const MAX_DEPTH = 128;
const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE\b[^[>]*>|<\/?[A-Za-z_][\w:.-]*(?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*)?\s*\/?>/g;
const ATTRIBUTE = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g;

export function decodeXml(value) {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/i.test(value)) throw new Error('Unsupported XML entity reference.');
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (_, entity) => {
    const known = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
    if (known) return known;
    const point = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isInteger(point) || point <= 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new Error('Invalid XML character reference.');
    return String.fromCodePoint(point);
  });
}

export function newlines(text) {
  let count = 0;
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) count += 1;
  return count;
}

function attributesOf(tag, name) {
  const attributeText = tag.slice(1 + name.length).replace(/\/?\s*>$/, '');
  const attributes = Object.create(null);
  let cursor = 0;
  for (const attribute of attributeText.matchAll(ATTRIBUTE)) {
    if (attributeText.slice(cursor, attribute.index).trim()) throw new Error('Malformed XML attribute.');
    if (Object.hasOwn(attributes, attribute[1])) throw new Error('Duplicate XML attribute.');
    attributes[attribute[1]] = decodeXml(attribute[2] ?? attribute[3]);
    cursor = attribute.index + attribute[0].length;
  }
  if (attributeText.slice(cursor).trim()) throw new Error('Malformed XML attribute.');
  return attributes;
}

/**
 * The document's root element. Each element has its local `name`,
 * `qualifiedName`, `namespace`, `attributes`, element `children`, the `text`
 * written directly inside it, the source `line` its tag starts on, and a
 * `path` that names it the same way in every version of the file: by its
 * `name` attribute where it has one, otherwise by its place among siblings of
 * the same tag (`/Invoice/InvoiceLine[2]/Price`).
 */
export function parseXml(source) {
  if (/<!\s*ENTITY\b/i.test(source) || /<!DOCTYPE\b[^>]*\[/i.test(source)) throw new Error('XML DTDs and entity declarations are not supported.');
  const document = { name: '#document', children: [], namespaces: {}, path: '', childCounts: new Map() };
  const stack = [document];
  let cursor = 0, count = 0, line = 1;
  for (const token of source.matchAll(TOKEN)) {
    const preceding = source.slice(cursor, token.index);
    line += newlines(preceding);
    const tagLine = line;
    line += newlines(token[0]);
    if (preceding.includes('<') || (stack.length === 1 && preceding.trim())) throw new Error('Malformed XML content.');
    if (stack.length > 1 && preceding.trim()) stack.at(-1).text += decodeXml(preceding);
    cursor = token.index + token[0].length;
    const tag = token[0];
    if (tag.startsWith('<![CDATA[')) {
      if (stack.length > 1) stack.at(-1).text += tag.slice(9, -3);
      continue;
    }
    if (tag.startsWith('<!') || tag.startsWith('<?')) continue;
    const closing = tag.startsWith('</');
    const name = tag.match(/^<\/?([^\s/>]+)/)[1];
    if (closing) {
      if (stack.length === 1 || stack.at(-1).qualifiedName !== name || !/^<\/[^\s/>]+\s*>$/.test(tag)) throw new Error('Mismatched XML closing element.');
      stack.pop();
      continue;
    }
    if (++count > MAX_ELEMENTS || stack.length > MAX_DEPTH) throw new Error('The XML exceeds the complexity limit.');
    const parent = stack.at(-1);
    const attributes = attributesOf(tag, name);
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
    const node = { name: localName, qualifiedName: name, namespace, namespaces, attributes, children: [], text: '',
      childCounts: new Map(), path: `${parent.path}/${identity}${ordinal > 1 ? `[${ordinal}]` : ''}`, raw: tag, line: tagLine };
    parent.children.push(node);
    if (!tag.endsWith('/>')) stack.push(node);
  }
  if (stack.length !== 1 || source.slice(cursor).trim() || document.children.length !== 1) throw new Error('Incomplete or invalid XML document.');
  return document.children[0];
}
