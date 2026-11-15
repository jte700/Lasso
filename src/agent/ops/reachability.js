// Exact boundary reachability (paper §4.1), with versioned region relations
// and supported edits (§4.2, Milestone 2).
//
// A directed graph is split into disjoint regions. B_i holds every vertex of
// region i incident to an edge that crosses regions; R_i holds each pair (u, v)
// of B_i with v reachable from u inside region i. H is the boundary vertices,
// every R_i pair and every crossing edge; s reaches t in G exactly when it does
// in H once s and t are promoted into their regions' boundaries. Promotion is
// done per query: a local search from s finds the boundary vertices it reaches
// inside its region, and one from t (backwards) those that reach it.
//
// R_i is computed lazily and cached against its region's version. Every edit
// bumps the versions of the regions it can affect: an internal edge its
// region, a crossing edge both endpoints' regions (boundary membership may
// change), a moved vertex its old and new regions. A handle records the
// versions a result relied on; a handle whose regions changed is stale and is
// refused, never silently reused.

export class StaleInterfaceError extends Error {
  constructor(regions) {
    super(`stale interface: region relation(s) ${regions.join(', ')} changed since this result was computed`);
    this.code = 'stale';
    this.regions = regions;
  }
}

export class BoundaryReachability {
  constructor() {
    this.out = new Map();
    this.in = new Map();
    this.regionOf = new Map();
    this.members = new Map();
    this.versions = new Map();
    this.cache = new Map();
    this.edits = 0;
    this.relationBuilds = 0;
  }

  bump(region) {
    this.versions.set(region, (this.versions.get(region) ?? 0) + 1);
    this.edits += 1;
  }

  /**
   * A copy to edit for a derived revision. Cached region relations are shared:
   * they are immutable and keyed by version, so a region the edits leave alone
   * keeps its relation and only edited regions are rebuilt.
   */
  clone() {
    const copy = new BoundaryReachability();
    for (const [vertex, targets] of this.out) copy.out.set(vertex, new Set(targets));
    for (const [vertex, sources] of this.in) copy.in.set(vertex, new Set(sources));
    copy.regionOf = new Map(this.regionOf);
    for (const [region, members] of this.members) copy.members.set(region, new Set(members));
    copy.versions = new Map(this.versions);
    copy.cache = new Map(this.cache);
    copy.edits = this.edits;
    return copy;
  }

  hasVertex(vertex) { return this.regionOf.has(vertex); }

  addVertex(vertex, region) {
    if (this.regionOf.has(vertex)) {
      if (this.regionOf.get(vertex) !== region) this.moveVertex(vertex, region);
      return;
    }
    this.regionOf.set(vertex, region);
    if (!this.members.has(region)) this.members.set(region, new Set());
    this.members.get(region).add(vertex);
    this.out.set(vertex, new Set());
    this.in.set(vertex, new Set());
    this.bump(region);
  }

  moveVertex(vertex, region) {
    const from = this.regionOf.get(vertex);
    if (from === region) return;
    this.members.get(from).delete(vertex);
    if (!this.members.has(region)) this.members.set(region, new Set());
    this.members.get(region).add(vertex);
    this.regionOf.set(vertex, region);
    this.bump(from);
    this.bump(region);
  }

  addEdge(from, to) {
    if (!this.regionOf.has(from) || !this.regionOf.has(to)) throw new Error(`unknown vertex in edge ${from} -> ${to}`);
    if (this.out.get(from).has(to)) return false;
    this.out.get(from).add(to);
    this.in.get(to).add(from);
    this.bump(this.regionOf.get(from));
    if (this.regionOf.get(to) !== this.regionOf.get(from)) this.bump(this.regionOf.get(to));
    return true;
  }

  removeEdge(from, to) {
    if (!this.out.get(from)?.has(to)) return false;
    this.out.get(from).delete(to);
    this.in.get(to).delete(from);
    this.bump(this.regionOf.get(from));
    if (this.regionOf.get(to) !== this.regionOf.get(from)) this.bump(this.regionOf.get(to));
    return true;
  }

  /** B_i: vertices of the region with an edge (either way) to another region. */
  boundary(region) {
    return this.interfaceOf(region).boundary;
  }

  /** The region's boundary and relation R_i (with its transpose), built once per region version. */
  interfaceOf(region) {
    const version = this.versions.get(region) ?? 0;
    const cached = this.cache.get(region);
    if (cached && cached.version === version) return cached;
    const members = this.members.get(region) ?? new Set();
    const boundary = new Set();
    for (const vertex of members) {
      let crossing = false;
      for (const next of this.out.get(vertex)) if (this.regionOf.get(next) !== region) { crossing = true; break; }
      if (!crossing) for (const previous of this.in.get(vertex)) if (this.regionOf.get(previous) !== region) { crossing = true; break; }
      if (crossing) boundary.add(vertex);
    }
    const relation = new Map();
    const transpose = new Map();
    for (const start of boundary) {
      const reached = this.localSearch([start], region, 'out').reached;
      const targets = new Set();
      for (const vertex of reached) if (vertex !== start && boundary.has(vertex)) targets.add(vertex);
      relation.set(start, targets);
      for (const target of targets) {
        if (!transpose.has(target)) transpose.set(target, new Set());
        transpose.get(target).add(start);
      }
    }
    this.relationBuilds += 1;
    const built = { version, boundary, relation, transpose };
    this.cache.set(region, built);
    return built;
  }

  /** Breadth-first search confined to one region, forwards ('out') or backwards ('in'). */
  localSearch(sources, region, direction) {
    const edges = direction === 'out' ? this.out : this.in;
    const reached = new Set(sources);
    const queue = [...sources];
    for (let index = 0; index < queue.length; index += 1) {
      for (const next of edges.get(queue[index])) {
        if (!reached.has(next) && this.regionOf.get(next) === region) {
          reached.add(next);
          queue.push(next);
        }
      }
    }
    return { reached };
  }

  /** Neighbours of a boundary vertex in H: its R_i targets plus its crossing edges. */
  interfaceNeighbours(vertex, direction) {
    const region = this.regionOf.get(vertex);
    const built = this.interfaceOf(region);
    const local = (direction === 'out' ? built.relation : built.transpose).get(vertex) ?? new Set();
    const neighbours = [...local];
    for (const next of (direction === 'out' ? this.out : this.in).get(vertex)) {
      if (this.regionOf.get(next) !== region) neighbours.push(next);
    }
    return neighbours;
  }

  /** Breadth-first search over H from boundary vertices; returns the boundary vertices reached and the regions touched. */
  interfaceSearch(starts, direction) {
    const visited = new Set(starts);
    const queue = [...starts];
    const regions = new Set(starts.map((vertex) => this.regionOf.get(vertex)));
    for (let index = 0; index < queue.length; index += 1) {
      for (const next of this.interfaceNeighbours(queue[index], direction)) {
        if (!visited.has(next)) {
          visited.add(next);
          regions.add(this.regionOf.get(next));
          queue.push(next);
        }
      }
    }
    return { visited, regions };
  }

  /** Exact: does `source` reach `target` in G? Decided on H with promoted endpoints. */
  reaches(source, target) {
    if (!this.regionOf.has(source) || !this.regionOf.has(target)) throw new Error('unknown vertex');
    if (source === target) return { reaches: true, handle: this.handle([this.regionOf.get(source)]) };
    const sourceRegion = this.regionOf.get(source);
    const targetRegion = this.regionOf.get(target);
    const fromSource = this.localSearch([source], sourceRegion, 'out').reached;
    if (sourceRegion === targetRegion && fromSource.has(target)) return { reaches: true, handle: this.handle([sourceRegion]) };
    const exits = [...fromSource].filter((vertex) => this.interfaceOf(sourceRegion).boundary.has(vertex));
    const toTarget = this.localSearch([target], targetRegion, 'in').reached;
    const entries = new Set([...toTarget].filter((vertex) => this.interfaceOf(targetRegion).boundary.has(vertex)));
    const { visited, regions } = this.interfaceSearch(exits, 'out');
    regions.add(sourceRegion);
    regions.add(targetRegion);
    let reaches = false;
    for (const vertex of entries) if (visited.has(vertex)) { reaches = true; break; }
    return { reaches, handle: this.handle([...regions]) };
  }

  /**
   * Exact: every vertex reachable from `source` (direction 'out': what it
   * affects) or reaching it ('in': what it depends on), the source included.
   */
  closure(source, direction = 'out') {
    if (!this.regionOf.has(source)) throw new Error(`unknown vertex ${source}`);
    const sourceRegion = this.regionOf.get(source);
    const local = this.localSearch([source], sourceRegion, direction).reached;
    const result = new Set(local);
    const starts = [...local].filter((vertex) => this.interfaceOf(sourceRegion).boundary.has(vertex));
    const { visited, regions } = this.interfaceSearch(starts, direction);
    const byRegion = new Map();
    for (const vertex of visited) {
      const region = this.regionOf.get(vertex);
      if (!byRegion.has(region)) byRegion.set(region, []);
      byRegion.get(region).push(vertex);
    }
    for (const [region, sources] of byRegion) {
      for (const vertex of this.localSearch(sources, region, direction).reached) result.add(vertex);
    }
    regions.add(sourceRegion);
    return { vertices: result, handle: this.handle([...regions]) };
  }

  /** A record of the region versions a result relied on. */
  handle(regions) {
    return { regions: Object.fromEntries(regions.map((region) => [region, this.versions.get(region) ?? 0])) };
  }

  /** Throws StaleInterfaceError when any region a handle relied on has changed. */
  validate(handle) {
    const stale = Object.entries(handle.regions).filter(([region, version]) => (this.versions.get(region) ?? 0) !== version).map(([region]) => region);
    if (stale.length) throw new StaleInterfaceError(stale);
    return true;
  }

  /** Structural sizes: the interface has at most Σ|B_i|² + |E_cross| edges (identifiers and metadata excluded). */
  stats() {
    let edges = 0;
    let crossEdges = 0;
    for (const [from, targets] of this.out) {
      for (const to of targets) {
        edges += 1;
        if (this.regionOf.get(from) !== this.regionOf.get(to)) crossEdges += 1;
      }
    }
    let boundaryVertices = 0;
    let squared = 0;
    let relationEdges = 0;
    for (const region of this.members.keys()) {
      const built = this.interfaceOf(region);
      boundaryVertices += built.boundary.size;
      squared += built.boundary.size ** 2;
      for (const targets of built.relation.values()) relationEdges += targets.size;
    }
    return { vertices: this.regionOf.size, edges, regions: this.members.size, boundaryVertices, crossEdges, relationEdges,
      interfaceEdges: relationEdges + crossEdges, sizeBound: squared + crossEdges };
  }
}
