// An ISO 10303-21 (STEP physical file) reader: the DATA section as entities.
// Values: numbers, strings, {ref}, {enum}, null ($), '*', lists, and typed
// values {type, args}. Complex instances are {complex: [{type, args}, …]}.

function parseValue(text, start) {
  let index = start;
  const skip = () => { while (index < text.length && /\s/.test(text[index])) index += 1; };
  const value = () => {
    skip();
    const character = text[index];
    if (character === "'") {
      let out = '';
      index += 1;
      for (;;) {
        if (text[index] === "'" && text[index + 1] === "'") { out += "'"; index += 2; continue; }
        if (text[index] === "'") { index += 1; break; }
        out += text[index];
        index += 1;
      }
      return out;
    }
    if (character === '#') {
      const match = /^#(\d+)/.exec(text.slice(index, index + 20));
      index += match[0].length;
      return { ref: Number(match[1]) };
    }
    if (character === '$') { index += 1; return null; }
    if (character === '*') { index += 1; return '*'; }
    if (character === '.') {
      const end = text.indexOf('.', index + 1);
      const name = text.slice(index + 1, end);
      index = end + 1;
      return { enum: name };
    }
    if (character === '(') {
      index += 1;
      const items = [];
      skip();
      if (text[index] === ')') { index += 1; return items; }
      for (;;) {
        items.push(value());
        skip();
        if (text[index] === ',') { index += 1; continue; }
        if (text[index] === ')') { index += 1; break; }
        throw new Error(`STEP: expected , or ) at ${index}`);
      }
      return items;
    }
    const number = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(text.slice(index, index + 40));
    if (number) { index += number[0].length; return Number(number[0]); }
    const typed = /^([A-Z_][A-Z0-9_]*)\s*\(/.exec(text.slice(index, index + 120));
    if (typed) {
      index += typed[0].length - 1;
      return { type: typed[1], args: value() };
    }
    throw new Error(`STEP: cannot read value at "${text.slice(index, index + 20)}"`);
  };
  const result = value();
  return { value: result, end: index };
}

export function parseStep(text) {
  const begin = text.indexOf('DATA;');
  const finish = text.lastIndexOf('ENDSEC;');
  if (begin < 0 || finish < begin) throw new Error('not a STEP file: no DATA section');
  const data = text.slice(begin + 5, finish);
  const entities = new Map();
  let start = 0;
  let inString = false;
  for (let index = 0; index < data.length; index += 1) {
    const character = data[index];
    if (character === "'") { inString = !inString; continue; }
    if (inString || character !== ';') continue;
    const statement = data.slice(start, index).trim();
    start = index + 1;
    if (!statement) continue;
    const match = /^#(\d+)\s*=\s*([\s\S]*)$/.exec(statement);
    if (!match) continue;
    const body = match[2].trim();
    if (body.startsWith('(')) {
      // Complex instance: ( A(…) B(…) … )
      const parts = [];
      let at = 1;
      while (at < body.length - 1) {
        while (/\s/.test(body[at])) at += 1;
        if (body[at] === ')') break;
        const name = /^([A-Z_][A-Z0-9_]*)\s*/.exec(body.slice(at, at + 120));
        if (!name) break;
        at += name[0].length;
        const parsed = parseValue(body, at);
        parts.push({ type: name[1], args: parsed.value });
        at = parsed.end;
      }
      entities.set(Number(match[1]), { complex: parts });
    } else {
      const name = /^([A-Z_][A-Z0-9_]*)\s*/.exec(body);
      if (!name) continue;
      const parsed = parseValue(body, name[0].length);
      entities.set(Number(match[1]), { type: name[1], args: parsed.value });
    }
  }
  const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/.exec(text)?.[1] ?? null;
  return { entities, schema };
}

/** The part of an entity of a given type (a simple entity, or one member of a complex one). */
export function part(entity, type) {
  if (!entity) return null;
  if (entity.type === type) return entity;
  return entity.complex?.find((member) => member.type === type) ?? null;
}
