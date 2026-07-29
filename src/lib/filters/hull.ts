import { Vector3 } from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { UserFacingError } from '../errors';
import { weldVertices } from './clean';
import {
  count,
  recomputeNormals,
  triangleCountOf,
  vertexCountOf,
  type FilterOutcome,
  type MeshData,
} from './meshData';

/**
 * Replaces the mesh with the smallest convex solid containing all its
 * vertices. Useful as a collision proxy, or to sanity-check the extent of a
 * scan before processing it further.
 */
export function convexHull(data: MeshData): FilterOutcome {
  const vertexCount = vertexCountOf(data);
  const beforeTriangles = triangleCountOf(data);

  const points: Vector3[] = new Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    points[v] = new Vector3(data.position[v * 3], data.position[v * 3 + 1], data.position[v * 3 + 2]);
  }

  let geometry: ConvexGeometry;
  try {
    geometry = new ConvexGeometry(points);
  } catch (error) {
    // QuickHull cannot start from points that are all coplanar or coincident.
    throw new UserFacingError(
      `Could not build a hull from this mesh — its vertices may be flat or coincident. (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }

  const position = geometry.getAttribute('position');
  if (!position || position.count === 0) {
    throw new UserFacingError('The convex hull came out empty.');
  }

  const hullPositions = new Float32Array(position.array as ArrayLike<number>);
  const identity = new Uint32Array(hullPositions.length / 3);
  for (let i = 0; i < identity.length; i++) identity[i] = i;

  const hull: MeshData = {
    position: hullPositions,
    normal: null,
    color: null,
    uv: null,
    index: identity,
  };
  // ConvexGeometry emits separate corners per face; welding gives back a
  // properly connected solid that the other filters can operate on.
  weldVertices(hull, 0);
  recomputeNormals(hull);

  Object.assign(data, hull);
  geometry.dispose();

  return {
    data,
    notes: [
      `Hull of ${count(vertexCount)} points: ${count(vertexCountOf(data))} vertices, ` +
        `${count(triangleCountOf(data))} triangles (was ${count(beforeTriangles)}).`,
      'Vertex colours and UVs do not survive this filter.',
    ],
  };
}
