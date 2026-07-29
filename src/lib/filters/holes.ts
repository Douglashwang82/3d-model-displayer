import { UserFacingError } from '../errors';
import {
  canUseEdgeKeys,
  count,
  edgeUseCounts,
  recomputeNormals,
  vertexCountOf,
  type FilterOutcome,
  type MeshData,
} from './meshData';

const EDGE_SHIFT = 67108864; // 2^26, matching meshData's edge keys

/**
 * Walks the open edges of the mesh and returns each hole as the ring of
 * vertices around it, in the direction the existing triangles wind.
 */
function traceBoundaryLoops(index: Uint32Array): number[][] {
  const counts = edgeUseCounts(index);

  // Only edges used by a single triangle bound a hole. Collecting them as
  // outgoing lists lets a loop be traced by repeatedly following "next".
  const outgoing = new Map<number, number[]>();
  let openEdges = 0;
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i];
    const b = index[i + 1];
    const c = index[i + 2];
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const key = u < v ? u * EDGE_SHIFT + v : v * EDGE_SHIFT + u;
      if (counts.get(key) !== 1) continue;
      const list = outgoing.get(u);
      if (list) list.push(v);
      else outgoing.set(u, [v]);
      openEdges++;
    }
  }
  if (openEdges === 0) return [];

  const loops: number[][] = [];
  for (const start of [...outgoing.keys()]) {
    // A vertex can sit on several holes, so keep draining it until it is empty.
    while ((outgoing.get(start)?.length ?? 0) > 0) {
      const loop: number[] = [];
      let current = start;

      for (;;) {
        const list = outgoing.get(current);
        if (!list || list.length === 0) break;
        const next = list.pop()!;
        if (list.length === 0) outgoing.delete(current);
        loop.push(current);
        current = next;
        if (current === start) break;
        // A non-manifold boundary can fold back on itself; abandoning the walk
        // is better than filling a ring that visits a vertex twice.
        if (loop.length > openEdges) break;
      }

      if (loop.length >= 3 && current === start) loops.push(loop);
    }
  }
  return loops;
}

/**
 * Fills open boundaries with a triangle fan around each hole's centroid.
 *
 * A fan is not the minimum-area patch that MeshLab's hole filler searches for,
 * but it is stable on the non-planar rings that scanned surfaces produce, and
 * the smoothing filters can relax the result afterwards.
 *
 * @param maxEdges Largest ring to fill, counted in boundary edges. Big rings
 *   are usually the model's intended open side rather than a defect.
 */
export function closeHoles(data: MeshData, maxEdges: number): FilterOutcome {
  const vertexCount = vertexCountOf(data);
  if (!canUseEdgeKeys(vertexCount)) {
    throw new UserFacingError(
      'This mesh has too many vertices for the hole finder. Simplify it first.',
    );
  }

  const loops = traceBoundaryLoops(data.index);
  if (loops.length === 0) {
    return { data, notes: ['Mesh is closed — no open boundaries found.'] };
  }

  const fillable = loops.filter((loop) => loop.length <= maxEdges);
  const skipped = loops.length - fillable.length;
  if (fillable.length === 0) {
    return {
      data,
      notes: [
        `Found ${count(loops.length)} holes, all larger than ${count(maxEdges)} edges. ` +
          'Raise the limit to fill them.',
      ],
    };
  }

  // A three-sided hole is closed by one triangle; anything larger gets a new
  // centre vertex, so count those separately when sizing the new arrays.
  const newVertices = fillable.filter((loop) => loop.length > 3).length;
  let newTriangles = 0;
  for (const loop of fillable) newTriangles += loop.length === 3 ? 1 : loop.length;

  const position = grow(data.position, 3, vertexCount, newVertices);
  const color = data.color && grow(data.color, 3, vertexCount, newVertices);
  const uv = data.uv && grow(data.uv, 2, vertexCount, newVertices);

  const index = new Uint32Array(data.index.length + newTriangles * 3);
  index.set(data.index);

  let nextVertex = vertexCount;
  let write = data.index.length;

  for (const loop of fillable) {
    if (loop.length === 3) {
      // Reversed relative to the boundary walk so the patch faces outwards.
      index[write++] = loop[2];
      index[write++] = loop[1];
      index[write++] = loop[0];
      continue;
    }

    const centre = nextVertex++;
    average(position, 3, loop, centre);
    if (color) average(color, 3, loop, centre);
    if (uv) average(uv, 2, loop, centre);

    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      // The surface already traverses a → b, so the patch traverses b → a.
      index[write++] = b;
      index[write++] = a;
      index[write++] = centre;
    }
  }

  data.position = position;
  data.color = color;
  data.uv = uv;
  data.index = index;
  recomputeNormals(data);

  const notes = [
    `Filled ${count(fillable.length)} hole${fillable.length === 1 ? '' : 's'} ` +
      `with ${count(newTriangles)} triangles.`,
  ];
  if (skipped > 0) {
    notes.push(`Left ${count(skipped)} hole${skipped === 1 ? '' : 's'} larger than ${count(maxEdges)} edges alone.`);
  }
  return { data, notes };
}

function grow(source: Float32Array, stride: number, vertexCount: number, extra: number): Float32Array {
  const out = new Float32Array((vertexCount + extra) * stride);
  out.set(source.subarray(0, vertexCount * stride));
  return out;
}

function average(target: Float32Array, stride: number, loop: number[], slot: number): void {
  for (let k = 0; k < stride; k++) {
    let sum = 0;
    for (const v of loop) sum += target[v * stride + k];
    target[slot * stride + k] = sum / loop.length;
  }
}
