import {
  boundsOf,
  compactVertices,
  count,
  plural,
  triangleCountOf,
  vertexCountOf,
  type FilterOutcome,
  type MeshData,
} from './meshData';

/**
 * Sorts vertex ids by a quantised (x, y, z) cell so that coincident vertices
 * land in one contiguous run.
 *
 * Sorting rather than hashing keeps this exact: a hash small enough to be an
 * exact JS number cannot hold three 21-bit coordinates, and a lossy hash would
 * silently weld unrelated vertices together.
 */
function orderByCell(cells: Int32Array, vertexCount: number): Uint32Array {
  const order = new Uint32Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) order[v] = v;
  order.sort((a, b) => {
    const ia = a * 3;
    const ib = b * 3;
    return (
      cells[ia] - cells[ib] || cells[ia + 1] - cells[ib + 1] || cells[ia + 2] - cells[ib + 2]
    );
  });
  return order;
}

/**
 * Merges vertices that share a position, which is what turns a triangle soup
 * into a surface with topology. STL has no vertex sharing at all, so this is
 * the prerequisite for smoothing, hole filling and simplification.
 *
 * @param tolerance Fraction of the bounding-box diagonal within which vertices
 *   are treated as the same point. Zero merges only exact duplicates.
 */
export function weldVertices(data: MeshData, tolerance: number): FilterOutcome {
  const vertexCount = vertexCountOf(data);
  const position = data.position;
  const { diagonal } = boundsOf(position);

  // With tolerance 0 the grid still has to be finite, so snap at a scale far
  // below any meaningful geometry — bit-identical positions still collide.
  const cell = tolerance > 0 ? tolerance * diagonal : Math.max(diagonal, 1) * 1e-7;

  const cells = new Int32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount * 3; i++) {
    const value = position[i];
    cells[i] = Number.isFinite(value) ? Math.round(value / cell) : 0;
  }

  const order = orderByCell(cells, vertexCount);
  const remap = new Uint32Array(vertexCount);

  // The merged mesh can only shrink, so allocating for the worst case up front
  // avoids growing a JS array with millions of loose numbers in it.
  const newPosition = new Float32Array(vertexCount * 3);
  const sourceOf = new Uint32Array(vertexCount);
  const normalSum = new Float32Array(vertexCount * 3);

  let unique = 0;
  for (let k = 0; k < vertexCount; ) {
    const first = order[k];
    const base = first * 3;

    let end = k + 1;
    while (end < vertexCount) {
      const v = order[end] * 3;
      if (cells[v] !== cells[base] || cells[v + 1] !== cells[base + 1] || cells[v + 2] !== cells[base + 2]) break;
      end++;
    }

    newPosition[unique * 3] = position[base];
    newPosition[unique * 3 + 1] = position[base + 1];
    newPosition[unique * 3 + 2] = position[base + 2];
    sourceOf[unique] = first;

    for (let j = k; j < end; j++) {
      const v = order[j];
      remap[v] = unique;
      if (data.normal) {
        normalSum[unique * 3] += data.normal[v * 3];
        normalSum[unique * 3 + 1] += data.normal[v * 3 + 1];
        normalSum[unique * 3 + 2] += data.normal[v * 3 + 2];
      }
    }

    unique++;
    k = end;
  }

  if (unique === vertexCount) {
    return { data, notes: ['No coincident vertices found.'] };
  }

  data.position = newPosition.slice(0, unique * 3);

  if (data.normal) {
    // Averaging the normals of merged vertices is the point of welding an STL:
    // it replaces per-face normals with a shared, smoothly varying one.
    const normal = new Float32Array(unique * 3);
    for (let v = 0; v < unique; v++) {
      const length = Math.hypot(normalSum[v * 3], normalSum[v * 3 + 1], normalSum[v * 3 + 2]);
      if (length > 0) {
        normal[v * 3] = normalSum[v * 3] / length;
        normal[v * 3 + 1] = normalSum[v * 3 + 1] / length;
        normal[v * 3 + 2] = normalSum[v * 3 + 2] / length;
      } else {
        normal[v * 3 + 1] = 1;
      }
    }
    data.normal = normal;
  }

  // Colours and UVs are taken from the first vertex of each group rather than
  // averaged: a UV seam has two legitimately different values at one position,
  // and blending them smears the texture across the seam.
  data.color = data.color && pick(data.color, 3, sourceOf, unique);
  data.uv = data.uv && pick(data.uv, 2, sourceOf, unique);

  const before = triangleCountOf(data);
  data.index = remapAndDropDegenerate(data.index, remap);
  const collapsed = before - triangleCountOf(data);

  const notes = [`${count(vertexCount)} → ${count(unique)} vertices.`];
  if (collapsed > 0) {
    notes.push(
      `${count(collapsed)} ${plural(collapsed, 'triangle')} collapsed to nothing and ${
        collapsed === 1 ? 'was' : 'were'
      } removed.`,
    );
  }
  return { data, notes };
}

function pick(
  source: Float32Array,
  stride: number,
  sourceOf: Uint32Array,
  unique: number,
): Float32Array {
  const out = new Float32Array(unique * stride);
  for (let v = 0; v < unique; v++) {
    const src = sourceOf[v] * stride;
    for (let k = 0; k < stride; k++) out[v * stride + k] = source[src + k];
  }
  return out;
}

function remapAndDropDegenerate(index: Uint32Array, remap: Uint32Array): Uint32Array {
  const out = new Uint32Array(index.length);
  let write = 0;
  for (let i = 0; i < index.length; i += 3) {
    const a = remap[index[i]];
    const b = remap[index[i + 1]];
    const c = remap[index[i + 2]];
    if (a === b || b === c || a === c) continue;
    out[write++] = a;
    out[write++] = b;
    out[write++] = c;
  }
  return out.subarray(0, write).slice();
}

/**
 * Removes the three defects that make a mesh awkward to process: triangles
 * with zero area, triangles that duplicate another, and vertices that no
 * triangle references.
 */
export function cleanMesh(data: MeshData): FilterOutcome {
  const index = data.index;
  const position = data.position;
  const { diagonal } = boundsOf(position);
  // Twice the area of the smallest triangle worth keeping. Scaling by the model
  // size keeps the test meaningful whether the model is in metres or microns.
  const areaEpsilon = Math.max(diagonal * diagonal * 1e-12, Number.MIN_VALUE);

  const triangleCount = index.length / 3;
  const drop = new Uint8Array(triangleCount);
  let degenerate = 0;

  for (let t = 0; t < triangleCount; t++) {
    const a = index[t * 3];
    const b = index[t * 3 + 1];
    const c = index[t * 3 + 2];
    if (a === b || b === c || a === c) {
      drop[t] = 1;
      degenerate++;
      continue;
    }
    const ax = position[a * 3];
    const ay = position[a * 3 + 1];
    const az = position[a * 3 + 2];
    const abx = position[b * 3] - ax;
    const aby = position[b * 3 + 1] - ay;
    const abz = position[b * 3 + 2] - az;
    const acx = position[c * 3] - ax;
    const acy = position[c * 3 + 1] - ay;
    const acz = position[c * 3 + 2] - az;
    const cx = aby * acz - abz * acy;
    const cy = abz * acx - abx * acz;
    const cz = abx * acy - aby * acx;
    if (!Number.isFinite(cx + cy + cz) || Math.hypot(cx, cy, cz) <= areaEpsilon) {
      drop[t] = 1;
      degenerate++;
    }
  }

  // Duplicates are found by sorting triangles on their vertex ids in ascending
  // order, so that the same three corners match regardless of winding.
  const sorted = new Uint32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    let a = index[t * 3];
    let b = index[t * 3 + 1];
    let c = index[t * 3 + 2];
    if (a > b) [a, b] = [b, a];
    if (b > c) [b, c] = [c, b];
    if (a > b) [a, b] = [b, a];
    sorted[t * 3] = a;
    sorted[t * 3 + 1] = b;
    sorted[t * 3 + 2] = c;
  }
  const order = new Uint32Array(triangleCount);
  for (let t = 0; t < triangleCount; t++) order[t] = t;
  order.sort((x, y) => {
    const ix = x * 3;
    const iy = y * 3;
    return (
      sorted[ix] - sorted[iy] ||
      sorted[ix + 1] - sorted[iy + 1] ||
      sorted[ix + 2] - sorted[iy + 2]
    );
  });

  let duplicates = 0;
  for (let k = 1; k < triangleCount; k++) {
    const prev = order[k - 1] * 3;
    const cur = order[k] * 3;
    if (
      sorted[cur] === sorted[prev] &&
      sorted[cur + 1] === sorted[prev + 1] &&
      sorted[cur + 2] === sorted[prev + 2] &&
      !drop[order[k]]
    ) {
      drop[order[k]] = 1;
      duplicates++;
    }
  }

  if (degenerate + duplicates > 0) {
    const out = new Uint32Array((triangleCount - degenerate - duplicates) * 3);
    let write = 0;
    for (let t = 0; t < triangleCount; t++) {
      if (drop[t]) continue;
      out[write++] = index[t * 3];
      out[write++] = index[t * 3 + 1];
      out[write++] = index[t * 3 + 2];
    }
    data.index = out;
  }

  const orphaned = compactVertices(data);

  const notes: string[] = [];
  if (degenerate) notes.push(`Removed ${count(degenerate)} degenerate ${plural(degenerate, 'triangle')}.`);
  if (duplicates) notes.push(`Removed ${count(duplicates)} duplicate ${plural(duplicates, 'triangle')}.`);
  if (orphaned) notes.push(`Removed ${count(orphaned)} unreferenced ${plural(orphaned, 'vertex', 'vertices')}.`);
  if (notes.length === 0) notes.push('Mesh was already clean.');
  return { data, notes };
}

/** Union–find with path halving; fast enough to run over every edge. */
function makeUnionFind(size: number) {
  const parent = new Uint32Array(size);
  const rank = new Uint8Array(size);
  for (let i = 0; i < size; i++) parent[i] = i;

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) parent[ra] = rb;
    else if (rank[ra] > rank[rb]) parent[rb] = ra;
    else {
      parent[rb] = ra;
      rank[ra]++;
    }
  }

  return { find, union };
}

/**
 * Deletes connected pieces smaller than a share of the whole model — the usual
 * way to clear the specks and floating fragments a scanner leaves behind. The
 * largest piece is always kept, so this can never empty the mesh.
 *
 * @param minFraction Smallest piece to keep, as a fraction of all triangles.
 */
export function removeSmallComponents(data: MeshData, minFraction: number): FilterOutcome {
  const vertexCount = vertexCountOf(data);
  const index = data.index;
  const triangleCount = index.length / 3;
  if (triangleCount === 0) return { data, notes: ['Mesh has no triangles.'] };

  const uf = makeUnionFind(vertexCount);
  for (let i = 0; i < index.length; i += 3) {
    uf.union(index[i], index[i + 1]);
    uf.union(index[i + 1], index[i + 2]);
  }

  const facesPerRoot = new Map<number, number>();
  const rootOfTriangle = new Uint32Array(triangleCount);
  for (let t = 0; t < triangleCount; t++) {
    const root = uf.find(index[t * 3]);
    rootOfTriangle[t] = root;
    facesPerRoot.set(root, (facesPerRoot.get(root) ?? 0) + 1);
  }

  if (facesPerRoot.size === 1) {
    return { data, notes: ['Mesh is a single connected piece.'] };
  }

  let largestRoot = -1;
  let largestSize = -1;
  for (const [root, size] of facesPerRoot) {
    if (size > largestSize) {
      largestSize = size;
      largestRoot = root;
    }
  }

  const threshold = minFraction * triangleCount;
  const keep = new Set<number>();
  for (const [root, size] of facesPerRoot) {
    if (root === largestRoot || size >= threshold) keep.add(root);
  }

  const removedPieces = facesPerRoot.size - keep.size;
  if (removedPieces === 0) {
    return {
      data,
      notes: [`${count(facesPerRoot.size)} connected pieces, all above the size threshold.`],
    };
  }

  let write = 0;
  const out = new Uint32Array(index.length);
  for (let t = 0; t < triangleCount; t++) {
    if (!keep.has(rootOfTriangle[t])) continue;
    out[write++] = index[t * 3];
    out[write++] = index[t * 3 + 1];
    out[write++] = index[t * 3 + 2];
  }
  data.index = out.subarray(0, write).slice();
  const orphaned = compactVertices(data);

  return {
    data,
    notes: [
      `Removed ${count(removedPieces)} of ${count(facesPerRoot.size)} pieces ` +
        `(${count(triangleCount - write / 3)} triangles, ${count(orphaned)} vertices).`,
    ],
  };
}
