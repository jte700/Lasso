// How a row's name is compared, by the ranking and by the table index alike.

/** A row name without case, spaces or punctuation: "Ontario, Males" is "ontariomales". */
export function normalizedRowSearch(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** A numbered row such as "Control 3" or "ctrl-3", as one reference ("con3"). */
export function canonicalRowReference(value) {
  const match = String(value ?? '').trim().match(/\b([A-Za-z]{1,16})[\s_-]*(\d+)\b/i);
  if (!match) return '';
  const rawPrefix = match[1].toLowerCase();
  const prefix = /^(?:control|ctrl|con)$/.test(rawPrefix) ? 'con'
    : /^(?:case|ca)$/.test(rawPrefix) ? 'ca' : rawPrefix;
  return `${prefix}${Number(match[2])}`;
}

/** Every spelling a row can be found by: its normalized name and its numbered references. */
export function rowSearchAliases(value) {
  const raw = normalizedRowSearch(value);
  const canonical = canonicalRowReference(value);
  const aliases = new Set([raw, canonical].filter(Boolean));
  const numbered = canonical.match(/^([a-z]+)(\d+)$/);
  if (numbered?.[1] === 'con') {
    aliases.add(`control${numbered[2]}`);
    aliases.add(`ctrl${numbered[2]}`);
  } else if (numbered?.[1] === 'ca') {
    aliases.add(`case${numbered[2]}`);
  }
  return [...aliases];
}
