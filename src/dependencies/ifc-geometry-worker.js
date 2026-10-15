// IFC solids are tessellated by the bundled web-ifc engine. No quantity or
// bounding box is substituted for source geometry when a representation fails.
import { parentPort, workerData } from 'node:worker_threads';
import { IfcAPI, IFCPRODUCT, IFCSPACE, IFCBUILDINGSTOREY, IFCRELAGGREGATES,
  IFCRELCONTAINEDINSPATIALSTRUCTURE, IFCRELDEFINESBYTYPE, LogLevel } from 'web-ifc';
import polygonClipping from 'polygon-clipping';

const MAX_PRODUCTS = 20_000;
const MAX_TRIANGLES = 2_000_000;
const MAX_ELEMENT_TRIANGLES = 50_000;
const MAX_PLAN_POINTS = 400_000;

const scalar = value => value?.value ?? null;
const round = value => Math.round(value * 1e6) / 1e6;
const emptyBounds = () => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
function include(bounds, point) {
  bounds.minX = Math.min(bounds.minX, point[0]); bounds.maxX = Math.max(bounds.maxX, point[0]);
  bounds.minY = Math.min(bounds.minY, point[1]); bounds.maxY = Math.max(bounds.maxY, point[1]);
}

export async function tessellateIfc(bytes) {
  const api = new IfcAPI();
  let model = -1;
  const entities = new Map(), parents = new Map(), instances = new Map();
  const elements = [], warnings = [];
  let triangleCount = 0, planPointCount = 0;
  try {
    await api.Init();
    api.SetLogLevel(LogLevel.LOG_LEVEL_OFF);
    try {
      model = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false, CIRCLE_SEGMENTS: 32,
        MEMORY_LIMIT: 512 * 1024 * 1024, TAPE_SIZE: 16 * 1024 * 1024 });
    } catch { throw new Error('The IFC model could not be opened by the geometry engine.'); }
    if (model < 0) throw new Error('The IFC model could not be opened by the geometry engine.');
    function metadata(id) {
      if (entities.has(id)) return entities.get(id);
      const line = api.GetLine(model, id);
      if (!line) return null;
      const name = scalar(line.Name), longName = scalar(line.LongName);
      const entity = { id, guid: scalar(line.GlobalId),
        label: [...new Set([name, longName].filter(Boolean))].join(' · ') || `#${id}`,
        entityType: api.GetNameFromTypeCode(line.type).toUpperCase(),
        hasRepresentation: Boolean(line.Representation),
        elevation: scalar(line.Elevation) };
      entities.set(id, entity);
      return entity;
    }
    const products = api.GetLineIDsWithType(model, IFCPRODUCT, true);
    if (products.size() > MAX_PRODUCTS) throw new Error('IFC visual preview exceeds the 20,000-product limit.');
    for (let i = 0; i < products.size(); i++) metadata(products.get(i));
    for (const type of [IFCRELAGGREGATES, IFCRELCONTAINEDINSPATIALSTRUCTURE, IFCRELDEFINESBYTYPE]) {
      const ids = api.GetLineIDsWithType(model, type);
      for (let i = 0; i < ids.size(); i++) {
        const relation = api.GetLine(model, ids.get(i));
        const parent = scalar(relation.RelatingStructure ?? relation.RelatingObject ?? relation.RelatingType);
        const children = relation.RelatedElements ?? relation.RelatedObjects ?? [];
        if (!parent) continue;
        metadata(parent);
        if (type === IFCRELDEFINESBYTYPE) instances.set(parent, children.map(scalar));
        else for (const child of children) parents.set(scalar(child), parent);
      }
    }
    function storeyFor(id) {
      const seen = new Set();
      while (id && !seen.has(id)) {
        seen.add(id);
        if (entities.get(id)?.entityType === 'IFCBUILDINGSTOREY') return id;
        id = parents.get(id);
      }
      return null;
    }
    for (const entity of [...entities.values()]) {
      if (!entity.hasRepresentation) continue;
      const triangles = [], seen = new Set();
      let flatMesh;
      try {
        // StreamAllMeshes deliberately excludes IfcSpace; GetFlatMesh includes
        // its real representation as well as every other represented product.
        flatMesh = api.GetFlatMesh(model, entity.id, true);
        for (let i = 0; i < flatMesh.geometries.size(); i++) {
          const placed = flatMesh.geometries.get(i), matrix = placed.flatTransformation;
          const geometry = api.GetGeometry(model, placed.geometryExpressID);
          try {
            const vertices = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
            const indices = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
            triangleCount += indices.length / 3;
            if (triangleCount > MAX_TRIANGLES) throw new Error('IFC visual preview exceeds the mesh complexity limit.');
            const point = index => {
              const offset = index * 6, x = vertices[offset], y = vertices[offset + 1], z = vertices[offset + 2];
              // web-ifc's placed mesh matrix uses Y-up. Convert back to IFC's
              // XY ground plane; Stream/GetFlatMesh scaling yields metres.
              return [round(matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]),
                round(-(matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]))];
            };
            for (let n = 0; n < indices.length; n += 3) {
              const triangle = [point(indices[n]), point(indices[n + 1]), point(indices[n + 2])];
              if (!triangle.every(p => p.every(Number.isFinite))) continue;
              const [a, b, c] = triangle;
              if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 1e-10) continue;
              const key = triangle.map(p => p.join(',')).sort().join(';');
              if (seen.has(key)) continue;
              seen.add(key); triangles.push([triangle]);
              if (triangles.length > MAX_ELEMENT_TRIANGLES) throw new Error('IFC element exceeds the projected mesh complexity limit.');
            }
          } finally { geometry.delete(); }
        }
        if (!triangles.length) continue;
        // Union real projected faces, retaining concavity and holes. Chunking
        // avoids spreading large triangle arrays into the JS argument stack.
        let union = [];
        // Integer micrometre input avoids tiny world-coordinate residues at
        // shared mesh edges destabilising the polygon sweep line.
        const integerTriangles = triangles.map(polygon => polygon.map(ring => ring.map(point => point.map(value => Math.round(value * 1e6)))));
        for (const batchSize of [256, 16, 1]) {
          union = [];
          try {
            for (let i = 0; i < integerTriangles.length; i += batchSize) {
              union = polygonClipping.union(union, ...integerTriangles.slice(i, i + batchSize))
                .map(polygon => polygon.map(ring => ring.map(point => point.map(Math.round))));
            }
            break;
          } catch (error) {
            // Snap after smaller batches when coincident curved faces cause
            // a numerical degeneracy inside the sweep-line operation.
            if (batchSize === 1) throw error;
          }
        }
        const polygons = union.flat().map(ring => ring.map(p => p.map(value => value ? value / 1e6 : 0)));
        const bounds = emptyBounds();
        for (const ring of polygons) for (const point of ring) include(bounds, point);
        if (!Number.isFinite(bounds.minX)) continue;
        planPointCount += polygons.reduce((count, ring) => count + ring.length, 0);
        if (planPointCount > MAX_PLAN_POINTS) throw new Error('IFC visual preview exceeds the plan complexity limit.');
        elements.push({ ...entity, role: entity.entityType === 'IFCSPACE' ? 'space' : 'context',
          polygons, bounds, storeyId: storeyFor(entity.id) });
      } catch (error) {
        if (/limit/.test(error.message)) throw error;
        warnings.push(`Geometry for ${entity.label} (#${entity.id}) could not be projected: ${error.message.slice(0, 160)}`);
      } finally { flatMesh?.delete?.(); }
    }
    if (!elements.length) throw new Error('This IFC file contains no supported geometric representations to preview.');
    const storeys = [...entities.values()].filter(entity => entity.entityType === 'IFCBUILDINGSTOREY');
    return { elements, entities: [...entities.values()], parents: [...parents], instances: [...instances], storeys, warnings };
  } finally {
    if (model >= 0) api.CloseModel(model);
    api.Dispose();
  }
}

if (parentPort) {
  try { parentPort.postMessage({ model: await tessellateIfc(workerData.bytes) }); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
}
