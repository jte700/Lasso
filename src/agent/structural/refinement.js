/** Explicit, opt-in evidence reuse for the research prototype.
 * No implicit MCP connection state or model memory is assumed. A client may
 * request a patch only when it retains the full payload named by the digest.
 * Digests detect mismatches; they are not signatures or authorization tokens.
 */
import { createHash } from 'node:crypto';
import { compileContext } from './compiler.js';

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError('Context payload must contain only JSON data.');
  return text;
}

export function contextDigest(payload) {
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const declared = (payload) => [...new Set([...payload.covered, ...payload.missing])];

/** Compile the next full packet, then choose a patch only if it is smaller.
 * A next request preserves all previous declared requirements, including ones
 * that could not previously be answered. Explicitly start a new query to drop
 * requirements. Next graph and pinned revisions are always supplied by caller.
 * Budget bounds the serialized update and the full reconstructed payload.
 */
export function refineContext({ previous, request, retainedDigest } = {}) {
  if (!previous?.payload || !request) throw new TypeError('previous compilation and next request are required.');
  const requirements = [...new Set([...declared(previous.payload), ...request.requirements])].sort();
  const next = compileContext({ ...request, requirements });
  const baseDigest = contextDigest(previous.payload);
  const nextDigest = contextDigest(next.payload);
  let payload = next.payload;
  let kind = 'full';
  let reason = retainedDigest === baseDigest ? 'patch_not_smaller' : 'client_has_not_confirmed_retention';
  if (retainedDigest === baseDigest) {
    const old = new Map(previous.payload.evidence.map((item) => [item.id, item]));
    const current = new Map(next.payload.evidence.map((item) => [item.id, item]));
    const { evidence, ...meta } = next.payload;
    const patch = {
      kind: 'structural_context_patch', baseDigest, nextDigest, meta,
      remove: [...old.keys()].filter((id) => !current.has(id)).sort(),
      upsert: evidence.filter((item) => !old.has(item.id) || canonical(old.get(item.id)) !== canonical(item)),
    };
    const patchText = JSON.stringify(patch);
    const tokenCost = request.tokenCounter ? request.tokenCounter(patchText) : null;
    if (tokenCost !== null && (!Number.isSafeInteger(tokenCost) || tokenCost < 0)) throw new TypeError('tokenCounter must return a nonnegative safe integer.');
    const optimizeTokens = (request.objective ?? (request.tokenCounter ? 'tokens' : 'bytes')) === 'tokens';
    const smaller = optimizeTokens ? tokenCost < next.audit.accounting.responseTokens : bytes(patch) < Buffer.byteLength(next.text, 'utf8');
    if (smaller && bytes(patch) <= request.budgetBytes && (request.budgetTokens === undefined || tokenCost <= request.budgetTokens)) {
      payload = patch; kind = 'patch'; reason = 'explicit_retention_and_smaller_payload';
    }
  }
  const text = JSON.stringify(payload);
  return { kind, payload, text, full: next,
    audit: { reason, baseDigest, nextDigest, responseBytes: Buffer.byteLength(text, 'utf8'),
      fullResponseBytes: Buffer.byteLength(next.text, 'utf8'),
      ...(request.tokenCounter ? { responseTokens: request.tokenCounter(text), fullResponseTokens: next.audit.accounting.responseTokens } : {}),
      requirementsPreserved: requirements } };
}

/** Client-side reconstruction. A missing/wrong retained base is a hard error.
 * Call refineContext without retainedDigest to obtain a full recovery payload.
 */
export function applyContextUpdate(previousPayload, updatePayload) {
  if (updatePayload?.kind !== 'structural_context_patch') {
    if (!Array.isArray(updatePayload?.evidence) || !Array.isArray(updatePayload?.covered) || !Array.isArray(updatePayload?.missing)) {
      throw new TypeError('Invalid full context payload.');
    }
    return structuredClone(updatePayload);
  }
  if (!previousPayload || contextDigest(previousPayload) !== updatePayload.baseDigest) throw new Error('Context base digest mismatch; request a full response.');
  if (!Array.isArray(updatePayload.remove) || !Array.isArray(updatePayload.upsert) || !updatePayload.meta) throw new TypeError('Invalid context patch.');
  const evidence = new Map(previousPayload.evidence.map((item) => [item.id, structuredClone(item)]));
  for (const id of updatePayload.remove) evidence.delete(id);
  for (const item of updatePayload.upsert) evidence.set(item.id, structuredClone(item));
  const payload = { ...structuredClone(updatePayload.meta), evidence: [...evidence.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
  if (contextDigest(payload) !== updatePayload.nextDigest) throw new Error('Context patch digest mismatch; request a full response.');
  return payload;
}
