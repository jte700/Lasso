import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

const MAX_BYTES = 64_000_000;
const MAX_CACHE_ENTRIES = 3;
const MAX_CACHE_BYTES = 32_000_000;
const MAX_PENDING = 4;
const cache = new Map();
let cacheBytes = 0, pending = 0, queue = Promise.resolve();

function runWorker(bytes) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./ifc-geometry-worker.js', import.meta.url), {
      workerData: { bytes }, resourceLimits: { maxOldGenerationSizeMb: 256 },
      // Parent CLI/test-runner flags may be invalid for a file worker.
      execArgv: [],
    });
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timeout); void worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const timeout = setTimeout(() => finish(new Error('IFC visual preview exceeded the 30-second processing limit.')), 30_000);
    worker.once('message', message => finish(message.error ? new Error(message.error) : null, message.model));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!finished) finish(new Error(`IFC geometry worker exited before producing a preview (${code}).`)); });
  });
}

async function modelFor(bytes, sourceHash) {
  const cached = cache.get(sourceHash);
  if (cached) {
    cache.delete(sourceHash); cache.set(sourceHash, cached);
    return cached.promise;
  }
  if (pending >= MAX_PENDING) throw new Error('IFC visual preview is busy. Please retry shortly.');
  pending++;
  const entry = { size: 0, promise: null };
  entry.promise = queue.then(() => runWorker(bytes)).then(model => {
    entry.size = Buffer.byteLength(JSON.stringify(model));
    cacheBytes += entry.size;
    for (const [hash, value] of cache) {
      if (cache.size <= MAX_CACHE_ENTRIES && cacheBytes <= MAX_CACHE_BYTES) break;
      if (!value.size) continue;
      cache.delete(hash); cacheBytes -= value.size;
    }
    return model;
  }).catch(error => { cache.delete(sourceHash); throw error; }).finally(() => { pending--; });
  queue = entry.promise.catch(() => {});
  cache.set(sourceHash, entry);
  return entry.promise;
}

function combinedBounds(elements) {
  return elements.reduce((bounds, element) => ({ minX: Math.min(bounds.minX, element.bounds.minX),
    minY: Math.min(bounds.minY, element.bounds.minY), maxX: Math.max(bounds.maxX, element.bounds.maxX),
    maxY: Math.max(bounds.maxY, element.bounds.maxY) }),
  { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}
function padded(bounds, fraction = 0.2) {
  const margin = Math.max(0.6, (bounds.maxX - bounds.minX) * fraction, (bounds.maxY - bounds.minY) * fraction);
  return { minX: bounds.minX - margin, minY: bounds.minY - margin, maxX: bounds.maxX + margin, maxY: bounds.maxY + margin };
}
const identity = entity => entity ? { id: entity.id, guid: entity.guid, label: entity.label, entityType: entity.entityType } : null;

/** Build a source-version-specific plan from actual IFC representations.
 * Explicit anchors never fall back to a nearby name or another element. A
 * product type/spatial container may select its explicitly related instances.
 * Rings use even-odd fill, including holes; coordinates are IFC XY in metres.
 */
export async function buildIfcPlan(buffer, { elementId = null, stepId = null, storey = null } = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('IFC visual preview requires a nonempty file under 64 MB.');
  const sourceHash = createHash('sha256').update(bytes).digest('hex');
  const model = await modelFor(bytes, sourceHash);
  const guid = elementId == null ? null : String(elementId);
  const step = stepId == null ? null : Number(String(stepId).replace(/^#/, ''));
  const selected = guid ? model.entities.find(entity => entity.guid === guid)
    : step != null ? model.entities.find(entity => entity.id === step) : null;
  if ((guid || step != null) && !selected) throw new Error('The cited IFC element is not present in this source version.');
  if (selected && step != null && selected.id !== step) throw new Error('The IFC GUID and STEP identifier do not identify the same source element.');
  const parents = new Map(model.parents), instances = new Map(model.instances);
  function isDescendant(id, ancestor) {
    const seen = new Set();
    while (id && !seen.has(id)) {
      if (id === ancestor) return true;
      seen.add(id); id = parents.get(id);
    }
    return false;
  }
  const instanceIds = selected ? new Set(instances.get(selected.id) ?? []) : new Set();
  const ownGeometry = selected && model.elements.find(element => element.id === selected.id);
  const targets = ownGeometry ? [ownGeometry] : selected ? model.elements.filter(element =>
    isDescendant(element.id, selected.id) || instanceIds.has(element.id)) : [];
  if (selected && !targets.length) throw new Error(`No supported geometric representation is available for ${selected.label} in this IFC source.`);
  let storeyEntity = storey == null ? null : model.storeys.find(entity => entity.guid === String(storey) || entity.id === Number(storey));
  if (storey != null && !storeyEntity) throw new Error('The requested storey is not present in this IFC source.');
  if (!storeyEntity && targets.length) {
    const storeyIds = new Set(targets.map(element => element.storeyId).filter(Boolean));
    if (storeyIds.size === 1) storeyEntity = model.storeys.find(entity => entity.id === [...storeyIds][0]);
  }
  if (!storeyEntity && !selected) {
    // A whole-file preview opens the lowest inhabited storey instead of
    // superimposing several unrelated floor plans into an unreadable drawing.
    storeyEntity = [...model.storeys].filter(floor => model.elements.some(element => element.storeyId === floor.id && element.role === 'space'))
      .sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0))[0] ?? null;
  }
  const targetIds = new Set(targets.map(element => element.id));
  const elements = model.elements.filter(element => targetIds.has(element.id)
    || ((!storeyEntity || element.storeyId === storeyEntity.id) && element.entityType !== 'IFCOPENINGELEMENT'))
    .map(({ hasRepresentation, elevation, ...element }) => ({ ...element, selected: targetIds.has(element.id) }));
  const rank = element => element.selected ? 4 : /SLAB|ROOF|SITE/.test(element.entityType) ? 0 : element.role === 'space' ? 1 : 2;
  elements.sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  if (!elements.length) throw new Error('The requested IFC view contains no supported geometry.');
  const bounds = combinedBounds(elements);
  return { kind: 'model-plan', format: 'ifc', sourceHash, units: 'm', projection: 'plan', fillRule: 'evenodd',
    elements, bounds, focusBounds: padded(targets.length ? combinedBounds(targets) : bounds),
    selected: identity(selected), storey: identity(storeyEntity), warnings: [...model.warnings] };
}
