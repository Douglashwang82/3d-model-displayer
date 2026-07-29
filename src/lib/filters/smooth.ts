import { UserFacingError } from '../errors';
import {
  boundaryVertices,
  buildAdjacency,
  canUseEdgeKeys,
  recomputeNormals,
  vertexCountOf,
  type Adjacency,
  type FilterOutcome,
  type MeshData,
} from './meshData';

/**
 * One umbrella-operator pass: each vertex moves a fraction `factor` of the way
 * towards the average of its neighbours. A positive factor smooths and shrinks;
 * a negative one re-inflates, which is what Taubin smoothing exploits.
 */
function relax(
  position: Float32Array,
  adjacency: Adjacency,
  frozen: Uint8Array | null,
  factor: number,
): Float32Array {
  const { offset, neighbours } = adjacency;
  const vertexCount = position.length / 3;
  const out = new Float32Array(position.length);

  for (let v = 0; v < vertexCount; v++) {
    const base = v * 3;
    const start = offset[v];
    const end = offset[v + 1];
    const degree = end - start;

    if (degree === 0 || (frozen && frozen[v])) {
      out[base] = position[base];
      out[base + 1] = position[base + 1];
      out[base + 2] = position[base + 2];
      continue;
    }

    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let k = start; k < end; k++) {
      const n = neighbours[k] * 3;
      sx += position[n];
      sy += position[n + 1];
      sz += position[n + 2];
    }

    out[base] = position[base] + factor * (sx / degree - position[base]);
    out[base + 1] = position[base + 1] + factor * (sy / degree - position[base + 1]);
    out[base + 2] = position[base + 2] + factor * (sz / degree - position[base + 2]);
  }

  return out;
}

function prepare(data: MeshData, preserveBoundary: boolean) {
  const vertexCount = vertexCountOf(data);
  // Finding the boundary relies on packed edge keys, which stop being exact
  // past 2^26 vertices. Smoothing the interior does not, so only the
  // boundary-preserving path is restricted.
  if (preserveBoundary && !canUseEdgeKeys(vertexCount)) {
    throw new UserFacingError(
      'This mesh has too many vertices to locate its open edges. Simplify it first, or turn off "Hold open edges still".',
    );
  }
  const adjacency = buildAdjacency(data.index, vertexCount);
  const frozen = preserveBoundary ? boundaryVertices(data.index, vertexCount) : null;
  return { adjacency, frozen };
}

/**
 * Classic Laplacian smoothing. Effective and simple, but every pass pulls the
 * surface towards its own average, so the model visibly shrinks as iterations
 * climb — use Taubin when the silhouette matters.
 */
export function laplacianSmooth(
  data: MeshData,
  iterations: number,
  strength: number,
  preserveBoundary: boolean,
): FilterOutcome {
  const { adjacency, frozen } = prepare(data, preserveBoundary);
  let position = data.position;
  for (let i = 0; i < iterations; i++) {
    position = relax(position, adjacency, frozen, strength);
  }
  data.position = position;
  recomputeNormals(data);

  const notes = [`Smoothed over ${iterations} iteration${iterations === 1 ? '' : 's'} at strength ${strength}.`];
  if (frozen) notes.push('Boundary vertices held in place.');
  return { data, notes };
}

/**
 * Taubin's λ|μ smoothing: a shrinking pass followed by a slightly larger
 * inflating one. The pair acts as a low-pass filter that removes noise while
 * leaving the overall volume close to where it started.
 */
export function taubinSmooth(
  data: MeshData,
  iterations: number,
  lambda: number,
  mu: number,
  preserveBoundary: boolean,
): FilterOutcome {
  const { adjacency, frozen } = prepare(data, preserveBoundary);
  let position = data.position;
  for (let i = 0; i < iterations; i++) {
    position = relax(position, adjacency, frozen, lambda);
    position = relax(position, adjacency, frozen, mu);
  }
  data.position = position;
  recomputeNormals(data);

  const notes = [
    `Smoothed over ${iterations} λ|μ pass${iterations === 1 ? '' : 'es'} (λ ${lambda}, μ ${mu}).`,
  ];
  if (frozen) notes.push('Boundary vertices held in place.');
  return { data, notes };
}
