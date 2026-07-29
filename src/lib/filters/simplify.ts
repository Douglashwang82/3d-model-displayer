import { MeshoptSimplifier, type SimplifierFlags } from 'meshoptimizer';
import { UserFacingError } from '../errors';
import {
  count,
  recomputeNormals,
  triangleCountOf,
  vertexCountOf,
  type FilterOutcome,
  type MeshData,
} from './meshData';

/** meshoptimizer's marker for a vertex that survived nothing. */
const UNUSED = 0xffffffff;

/**
 * Quadric edge-collapse simplification, the same family of algorithm as
 * MeshLab's "Simplification: Quadric Edge Collapse Decimation".
 *
 * @param targetPercent Share of the original triangles to aim for.
 * @param targetError Stop early once the deviation reaches this fraction of
 *   the model's extent, even if the triangle target has not been met.
 * @param lockBorder Hold open boundaries fixed, so a shell keeps its rim.
 */
export async function simplifyMesh(
  data: MeshData,
  targetPercent: number,
  targetError: number,
  lockBorder: boolean,
): Promise<FilterOutcome> {
  if (!MeshoptSimplifier.supported) {
    throw new UserFacingError('Simplification needs WebAssembly, which this browser did not provide.');
  }
  await MeshoptSimplifier.ready;

  const beforeTriangles = triangleCountOf(data);
  const beforeVertices = vertexCountOf(data);

  const targetIndexCount = Math.max(3, Math.floor((beforeTriangles * targetPercent) / 100) * 3);
  if (targetIndexCount >= data.index.length) {
    return { data, notes: ['Target is at or above the current triangle count; nothing to do.'] };
  }

  const flags: SimplifierFlags[] = lockBorder ? ['LockBorder'] : [];
  const [simplified, error] = MeshoptSimplifier.simplify(
    data.index,
    data.position,
    3,
    targetIndexCount,
    targetError,
    flags,
  );

  // compactMesh renumbers `simplified` in place and hands back old → new for
  // every vertex it kept, so the attribute arrays have to follow.
  const [remap, unique] = MeshoptSimplifier.compactMesh(simplified);
  data.index = simplified;
  data.position = gather(data.position, 3, remap, unique);
  data.normal = data.normal && gather(data.normal, 3, remap, unique);
  data.color = data.color && gather(data.color, 3, remap, unique);
  data.uv = data.uv && gather(data.uv, 2, remap, unique);

  // Collapses move the surviving vertices, so the inherited normals no longer
  // match the geometry they belong to.
  recomputeNormals(data);

  const afterTriangles = triangleCountOf(data);
  return {
    data,
    notes: [
      `${count(beforeTriangles)} → ${count(afterTriangles)} triangles ` +
        `(${((afterTriangles / beforeTriangles) * 100).toFixed(1)}%).`,
      `${count(beforeVertices)} → ${count(unique)} vertices.`,
      `Deviation from the original surface: ${(error * 100).toFixed(2)}% of the model size.`,
    ],
  };
}

function gather(
  source: Float32Array,
  stride: number,
  remap: Uint32Array,
  unique: number,
): Float32Array {
  const out = new Float32Array(unique * stride);
  const limit = Math.min(remap.length, source.length / stride);
  for (let v = 0; v < limit; v++) {
    const slot = remap[v];
    if (slot === UNUSED) continue;
    for (let k = 0; k < stride; k++) out[slot * stride + k] = source[v * stride + k];
  }
  return out;
}
