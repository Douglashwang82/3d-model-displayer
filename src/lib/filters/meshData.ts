import type { MeshPayload } from '../types';

/**
 * The working form used by every filter: always indexed, so that topology
 * (which vertices share a corner, which edges have one face) is well defined.
 * Files that arrive without an index — STL in particular — get an identity
 * index and are expected to be welded before anything topological runs.
 */
export interface MeshData {
  position: Float32Array;
  normal: Float32Array | null;
  color: Float32Array | null;
  uv: Float32Array | null;
  index: Uint32Array;
}

/** A filter's output: the new mesh plus lines describing what it did. */
export interface FilterOutcome {
  data: MeshData;
  notes: string[];
}

const numberFormat = new Intl.NumberFormat();

export function count(n: number): string {
  return numberFormat.format(Math.round(n));
}

export function plural(n: number, singular: string, many = `${singular}s`): string {
  return n === 1 ? singular : many;
}

export function toMeshData(payload: MeshPayload): MeshData {
  const vertexCount = payload.position.length / 3;
  let index = payload.index;
  if (!index) {
    index = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) index[i] = i;
  }
  return {
    position: payload.position,
    normal: payload.normal,
    color: payload.color,
    uv: payload.uv,
    index,
  };
}

export function toPayload(data: MeshData, format: string): MeshPayload {
  return {
    kind: 'mesh',
    format,
    position: data.position,
    normal: data.normal,
    color: data.color,
    uv: data.uv,
    index: data.index,
    vertexCount: data.position.length / 3,
    triangleCount: data.index.length / 3,
    hasVertexColors: !!data.color,
  };
}

export function vertexCountOf(data: MeshData): number {
  return data.position.length / 3;
}

export function triangleCountOf(data: MeshData): number {
  return data.index.length / 3;
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
  diagonal: number;
}

export function boundsOf(position: Float32Array): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < position.length; i += 3) {
    const x = position[i];
    const y = position[i + 1];
    const z = position[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) {
    return { min: [0, 0, 0], max: [0, 0, 0], diagonal: 0 };
  }
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dz = maxZ - minZ;
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    diagonal: Math.sqrt(dx * dx + dy * dy + dz * dz),
  };
}

/**
 * Packs an undirected edge into a single number. Vertex counts stay well below
 * 2^26 in practice, so a*2^26 + b is exactly representable as a double and
 * makes a far cheaper Map key than a string.
 */
const EDGE_SHIFT = 67108864; // 2^26

function edgeKey(a: number, b: number): number {
  return a < b ? a * EDGE_SHIFT + b : b * EDGE_SHIFT + a;
}

/** True when the index buffer is small enough for {@link edgeKey} to be exact. */
export function canUseEdgeKeys(vertexCount: number): boolean {
  return vertexCount < EDGE_SHIFT;
}

/**
 * Counts how many triangles use each undirected edge. An edge used once is on
 * a boundary (a hole); an edge used twice is a normal interior edge.
 */
export function edgeUseCounts(index: Uint32Array): Map<number, number> {
  const counts = new Map<number, number>();
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i];
    const b = index[i + 1];
    const c = index[i + 2];
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const key = edgeKey(u, v);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** Flags vertices that touch an edge used by exactly one triangle. */
export function boundaryVertices(index: Uint32Array, vertexCount: number): Uint8Array {
  const flags = new Uint8Array(vertexCount);
  const counts = edgeUseCounts(index);
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i];
    const b = index[i + 1];
    const c = index[i + 2];
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      if (counts.get(edgeKey(u, v)) === 1) {
        flags[u] = 1;
        flags[v] = 1;
      }
    }
  }
  return flags;
}

export interface Adjacency {
  /** Neighbours of vertex v live in `neighbours[offset[v] … offset[v + 1])`. */
  offset: Uint32Array;
  neighbours: Uint32Array;
}

/**
 * Builds the vertex-neighbour lists the smoothing filters average over.
 *
 * Neighbours are *not* de-duplicated: every interior neighbour is reached from
 * exactly two triangles, so the duplication cancels out of the average and
 * skipping the dedup pass saves a Set per vertex on meshes with millions of
 * them. Boundary vertices are the exception, which is why the smoothers offer
 * to hold them still instead.
 */
export function buildAdjacency(index: Uint32Array, vertexCount: number): Adjacency {
  const degree = new Uint32Array(vertexCount);
  for (let i = 0; i < index.length; i++) degree[index[i]] += 2;

  const offset = new Uint32Array(vertexCount + 1);
  let running = 0;
  for (let v = 0; v < vertexCount; v++) {
    offset[v] = running;
    running += degree[v];
  }
  offset[vertexCount] = running;

  const cursor = offset.slice(0, vertexCount);
  const neighbours = new Uint32Array(running);
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i];
    const b = index[i + 1];
    const c = index[i + 2];
    neighbours[cursor[a]++] = b;
    neighbours[cursor[a]++] = c;
    neighbours[cursor[b]++] = c;
    neighbours[cursor[b]++] = a;
    neighbours[cursor[c]++] = a;
    neighbours[cursor[c]++] = b;
  }
  return { offset, neighbours };
}

/**
 * Drops vertices no triangle references and renumbers the index buffer.
 * Returns the number of vertices removed.
 */
export function compactVertices(data: MeshData): number {
  const vertexCount = vertexCountOf(data);
  const used = new Uint8Array(vertexCount);
  for (let i = 0; i < data.index.length; i++) used[data.index[i]] = 1;

  let kept = 0;
  const remap = new Uint32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    if (used[v]) remap[v] = kept++;
  }
  if (kept === vertexCount) return 0;

  data.position = gather(data.position, 3, used, remap, kept);
  data.normal = data.normal && gather(data.normal, 3, used, remap, kept);
  data.color = data.color && gather(data.color, 3, used, remap, kept);
  data.uv = data.uv && gather(data.uv, 2, used, remap, kept);

  const index = data.index;
  for (let i = 0; i < index.length; i++) index[i] = remap[index[i]];

  return vertexCount - kept;
}

function gather(
  source: Float32Array,
  stride: number,
  used: Uint8Array,
  remap: Uint32Array,
  kept: number,
): Float32Array {
  const out = new Float32Array(kept * stride);
  for (let v = 0; v < used.length; v++) {
    if (!used[v]) continue;
    const dst = remap[v] * stride;
    const src = v * stride;
    for (let k = 0; k < stride; k++) out[dst + k] = source[src + k];
  }
  return out;
}

/**
 * Recomputes vertex normals by accumulating each triangle's cross product,
 * whose length is twice the triangle area — so larger faces pull harder, which
 * is what makes curved surfaces shade smoothly.
 */
export function recomputeNormals(data: MeshData): void {
  const vertexCount = vertexCountOf(data);
  const position = data.position;
  const normal = new Float32Array(vertexCount * 3);
  const index = data.index;

  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] * 3;
    const b = index[i + 1] * 3;
    const c = index[i + 2] * 3;

    const abx = position[b] - position[a];
    const aby = position[b + 1] - position[a + 1];
    const abz = position[b + 2] - position[a + 2];
    const acx = position[c] - position[a];
    const acy = position[c + 1] - position[a + 1];
    const acz = position[c + 2] - position[a + 2];

    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    normal[a] += nx;
    normal[a + 1] += ny;
    normal[a + 2] += nz;
    normal[b] += nx;
    normal[b + 1] += ny;
    normal[b + 2] += nz;
    normal[c] += nx;
    normal[c + 1] += ny;
    normal[c + 2] += nz;
  }

  for (let v = 0; v < normal.length; v += 3) {
    const length = Math.hypot(normal[v], normal[v + 1], normal[v + 2]);
    if (length > 0) {
      normal[v] /= length;
      normal[v + 1] /= length;
      normal[v + 2] /= length;
    } else {
      // An isolated or fully degenerate vertex has no defined normal; pointing
      // it up is arbitrary but keeps the attribute finite for the shader.
      normal[v + 1] = 1;
    }
  }

  data.normal = normal;
}
