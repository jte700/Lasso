/**
 * Compile an authorized, revision-pinned graph into a bounded JSON response.
 * The caller authenticates scope and supplies truthful, complete adapter claims;
 * this compiler cannot prove either. Completion is relative to declared inputs.
 * Evidence requires closure is visible. Audit closure is validated locally only.
 * Budgets cover serialized text only, not local audit or MCP framing. Optional
 * tokenCounter measures a named tokenizer; it does not estimate provider billing.
 */
export const EXACT_ALTERNATIVE_LIMIT = 18;
const GUARANTEES = new Set(['supported_operator', 'declared_dependencies', 'heuristic']);
const MODES = new Set(['auto', 'exact', 'greedy']);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sorted = (values) => [...new Set(values)].sort(compare);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function identifier(value, label) {
  if (typeof value !== 'string' || !value.length) throw new TypeError(label + ' must be a nonempty string.');
  return value;
}
function list(value, label) {
  if (!Array.isArray(value)) throw new TypeError(label + ' must be an array.');
  return sorted(value.map((entry) => identifier(entry, label + ' entry')));
}
// Canonical JSON locators; never invoke toJSON or silently drop unsupported data.
function jsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Invalid JSON locator.');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Invalid JSON locator.');
  const next = new Set(ancestors).add(value);
  if (Array.isArray(value)) return Array.from(value, (entry) => jsonValue(entry, next));
  return Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, jsonValue(value[key], next)]));
}

function prepareRecords(records, expectedRevisions) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array.');
  const map = new Map();
  for (const given of records) {
    if (!given || typeof given !== 'object') throw new TypeError('Each record must be an object.');
    const id = identifier(given.id, 'record.id');
    if (map.has(id)) throw new TypeError('Duplicate record id: ' + id + '.');
    const requires = list(given.requires ?? [], 'record ' + id + '.requires');
    const reasons = [];
    if (given.validity !== 'valid') reasons.push('record ' + id + ': validity is ' + (given.validity ?? 'unknown'));
    if (typeof given.text !== 'string') reasons.push('record ' + id + ': text is not a string');
    const source = given.source;
    let normalizedSource = null;
    if (!source || typeof source.id !== 'string' || !source.id || typeof source.revision !== 'string' || !source.revision) {
      reasons.push('record ' + id + ': source id and revision are required');
    } else {
      if (!own(expectedRevisions, source.id)) reasons.push('record ' + id + ': source ' + source.id + ' has no pinned revision');
      else if (expectedRevisions[source.id] !== source.revision) reasons.push('record ' + id + ': stale revision for source ' + source.id);
      normalizedSource = { id: source.id, revision: source.revision };
      if (own(source, 'locator')) {
        try { normalizedSource.locator = jsonValue(source.locator); }
        catch { reasons.push('record ' + id + ': locator is not finite, acyclic JSON data'); }
      }
    }
    map.set(id, { id, text: given.text, source: normalizedSource, requires, reasons });
  }
  return map;
}

// Iterative closure accepts valid cycles and handles deep chains without recursion.
function closure(roots, records) {
  const visited = new Set(), reasons = new Set(), pending = [...roots];
  while (pending.length) {
    const id = pending.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    const record = records.get(id);
    if (!record) { reasons.add('missing record ' + id); continue; }
    for (const reason of record.reasons) reasons.add(reason);
    for (const dependency of record.requires) pending.push(dependency);
  }
  return { ids: sorted(visited), reasons: sorted(reasons) };
}

function prepareAlternatives(alternatives, records, requirements) {
  if (!Array.isArray(alternatives)) throw new TypeError('alternatives must be an array.');
  const ids = new Set(), accepted = [], rejected = [];
  for (const given of alternatives) {
    if (!given || typeof given !== 'object') throw new TypeError('Each alternative must be an object.');
    const id = identifier(given.id, 'alternative.id');
    if (ids.has(id)) throw new TypeError('Duplicate alternative id: ' + id + '.');
    ids.add(id);
    const covers = list(given.covers, 'alternative ' + id + '.covers');
    if (covers.some((requirement) => !requirements.includes(requirement))) throw new TypeError('Alternative ' + id + ' covers an undeclared requirement.');
    if (!GUARANTEES.has(given.guarantee)) throw new TypeError('Alternative ' + id + ' has an unsupported guarantee.');
    const visible = closure(list(given.evidence, 'alternative ' + id + '.evidence'), records);
    const local = closure(list(given.audit ?? [], 'alternative ' + id + '.audit'), records);
    const reasons = sorted([...visible.reasons, ...local.reasons]);
    if (covers.length && !visible.ids.length) reasons.push('alternative ' + id + ': coverage has no visible evidence');
    if (reasons.length) rejected.push({ id, reasons: sorted(reasons) });
    else accepted.push({ id, covers, evidence: visible.ids, audit: local.ids, guarantee: given.guarantee });
  }
  return { accepted: accepted.sort((a, b) => compare(a.id, b.id)), rejected: rejected.sort((a, b) => compare(a.id, b.id)) };
}

function candidate(selected, records, requirements, accounting) {
  const covered = sorted(selected.flatMap((alternative) => alternative.covers));
  const coveredSet = new Set(covered);
  const missing = requirements.filter((requirement) => !coveredSet.has(requirement));
  const evidenceIds = sorted(selected.flatMap((alternative) => alternative.evidence));
  const payload = {
    status: missing.length ? 'partial' : 'complete_for_declared_requirements',
    covered, missing,
    evidence: evidenceIds.map((id) => { const record = records.get(id); return { id, text: record.text, source: record.source }; }),
    guarantees: sorted(selected.map((alternative) => alternative.guarantee)),
  };
  const text = JSON.stringify(payload);
  const tokens = accounting.tokenCounter ? accounting.tokenCounter(text) : null;
  if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens < 0)) throw new TypeError('tokenCounter must return a nonnegative safe integer.');
  const bytes = Buffer.byteLength(text, 'utf8');
  return { payload, text, bytes, tokens, cost: accounting.objective === 'tokens' ? tokens : bytes, selected, evidenceIds };
}

function fits(proposal, accounting) {
  return proposal.bytes <= accounting.budgetBytes
    && (accounting.budgetTokens === undefined || proposal.tokens <= accounting.budgetTokens);
}

// Maximize coverage, minimize measured full JSON cost, then bytes, root count, IDs.
function better(left, right) {
  if (left.payload.covered.length !== right.payload.covered.length) return left.payload.covered.length > right.payload.covered.length;
  if (left.cost !== right.cost) return left.cost < right.cost;
  if (left.bytes !== right.bytes) return left.bytes < right.bytes;
  if (left.selected.length !== right.selected.length) return left.selected.length < right.selected.length;
  for (let index = 0; index < left.selected.length; index += 1) {
    const order = compare(left.selected[index].id, right.selected[index].id);
    if (order) return order < 0;
  }
  return false;
}

function exact(accepted, records, requirements, accounting, empty) {
  let best = empty, evaluated = 1;
  const selected = [];
  function visit(start) {
    for (let index = start; index < accepted.length; index += 1) {
      selected.push(accepted[index]);
      const proposal = candidate([...selected], records, requirements, accounting);
      evaluated += 1;
      if (fits(proposal, accounting) && better(proposal, best)) best = proposal;
      visit(index + 1);
      selected.pop();
    }
  }
  visit(0);
  return { best, evaluated };
}

function greedy(accepted, records, requirements, accounting, empty) {
  let best = empty, evaluated = 1;
  const remaining = new Set(accepted);
  while (best.payload.missing.length) {
    let winner = null;
    for (const alternative of remaining) {
      const selected = [...best.selected, alternative].sort((a, b) => compare(a.id, b.id));
      const proposal = candidate(selected, records, requirements, accounting);
      evaluated += 1;
      const gain = proposal.payload.covered.length - best.payload.covered.length;
      if (!gain || !fits(proposal, accounting)) continue;
      const cost = proposal.cost - best.cost;
      if (!winner || gain * winner.cost > winner.gain * cost
        || (gain * winner.cost === winner.gain * cost && better(proposal, winner.proposal))) winner = { alternative, proposal, gain, cost };
    }
    if (!winner) break;
    remaining.delete(winner.alternative);
    best = winner.proposal;
  }
  return { best, evaluated };
}

/**
 * @param {{records: object[], alternatives: object[], requirements: string[],
 *   budgetBytes: number, expectedRevisions: Object<string,string>, mode?: 'auto'|'exact'|'greedy',
 *   tokenCounter?: (text:string)=>number, budgetTokens?:number, objective?:'bytes'|'tokens'}} input
 * @returns {{payload: object, text: string, audit: object}}
 */
export function compileContext({ records, alternatives, requirements, budgetBytes, expectedRevisions, mode = 'auto',
  tokenCounter, budgetTokens, objective = tokenCounter ? 'tokens' : 'bytes' } = {}) {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) throw new RangeError('budgetBytes must be a nonnegative safe integer.');
  if (tokenCounter !== undefined && typeof tokenCounter !== 'function') throw new TypeError('tokenCounter must be a function.');
  if (!['bytes', 'tokens'].includes(objective) || (objective === 'tokens' && !tokenCounter)) throw new TypeError('Token optimization requires tokenCounter.');
  if (budgetTokens !== undefined && (!tokenCounter || !Number.isSafeInteger(budgetTokens) || budgetTokens < 0)) throw new RangeError('budgetTokens requires tokenCounter and a nonnegative safe integer.');
  const accounting = { budgetBytes, budgetTokens, tokenCounter, objective };
  if (!MODES.has(mode)) throw new TypeError('mode must be auto, exact, or greedy.');
  if (!expectedRevisions || typeof expectedRevisions !== 'object' || Array.isArray(expectedRevisions)) throw new TypeError('expectedRevisions must map source IDs to trusted pinned revisions.');
  for (const [sourceId, revision] of Object.entries(expectedRevisions)) {
    identifier(sourceId, 'pinned source id'); identifier(revision, 'revision of ' + sourceId);
  }
  const wanted = list(requirements, 'requirements');
  const recordMap = prepareRecords(records, expectedRevisions);
  const { accepted, rejected } = prepareAlternatives(alternatives, recordMap, wanted);
  if (mode === 'exact' && alternatives.length > EXACT_ALTERNATIVE_LIMIT) throw new RangeError('Exact enumeration supports at most ' + EXACT_ALTERNATIVE_LIMIT + ' alternatives; use auto or greedy.');
  const solver = mode === 'greedy' || (mode === 'auto' && alternatives.length > EXACT_ALTERNATIVE_LIMIT) ? 'heuristic' : 'exact';
  const empty = candidate([], recordMap, wanted, accounting);
  if (empty.bytes > budgetBytes) throw new RangeError('budgetBytes is too small: the empty response requires ' + empty.bytes + ' UTF-8 bytes.');
  if (!fits(empty, accounting)) throw new RangeError('budgetTokens is too small for the empty response.');
  const { best, evaluated } = (solver === 'exact' ? exact : greedy)(accepted, recordMap, wanted, accounting, empty);
  const computationDependencyIds = sorted(best.selected.flatMap((alternative) => alternative.audit));
  return { payload: best.payload, text: best.text, audit: {
    selectedAlternatives: best.selected.map((alternative) => alternative.id),
    computationDependencyIds,
    validatedRecordIds: sorted([...best.evidenceIds, ...computationDependencyIds]),
    rejectedAlternatives: rejected,
    solver,
    optimality: solver === 'exact' ? 'proven_for_declared_alternatives' : 'unknown',
    accounting: { budgetBytes, responseBytes: best.bytes, unit: 'utf8_bytes', objective,
      ...(tokenCounter ? { responseTokens: best.tokens, budgetTokens: budgetTokens ?? null, tokenUnit: 'caller_supplied_tokenizer' } : {}),
      auditIncluded: false, evaluatedSubsets: evaluated },
  } };
}
