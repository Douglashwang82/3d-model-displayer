import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { UserFacingError } from '../errors';
import {
  count,
  recomputeNormals,
  triangleCountOf,
  vertexCountOf,
  type FilterOutcome,
  type MeshData,
} from './meshData';

export type BooleanOp = 'union' | 'difference' | 'intersection';

let toplevel: Promise<ManifoldToplevel> | null = null;

/** Loads the Manifold WASM module once and keeps it for later operations. */
function loadManifold(): Promise<ManifoldToplevel> {
  if (!toplevel) {
    toplevel = Module({ locateFile: () => wasmUrl }).then((module) => {
      module.setup();
      return module;
    });
  }
  return toplevel;
}

const KNOWN_STATUSES = [
  'NotManifold',
  'NonFiniteVertex',
  'VertexOutOfBounds',
  'PropertiesWrongLength',
  'MissingPositionProperties',
  'InvalidConstruction',
];

/**
 * Manifold reports some failures through `status()` and raises others as
 * exceptions whose message is the spaced-out status name — "Not manifold" for
 * `NotManifold`. Normalising both into one code keeps the advice consistent.
 */
function statusFromError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const squashed = message.replace(/[^a-z]/gi, '').toLowerCase();
  return KNOWN_STATUSES.find((status) => status.toLowerCase() === squashed) ?? message;
}

/**
 * Manifold refuses meshes that are not closed and orientable, because a CSG
 * result is only well defined for solids. Its status codes are precise but
 * terse, so translate them into something the user can act on.
 */
function describeStatus(status: string, which: string): string {
  switch (status) {
    case 'NotManifold':
      return `The ${which} mesh is not watertight — it has holes or edges shared by more than two faces. Try Merge close vertices, then Close holes.`;
    case 'VertexOutOfBounds':
    case 'PropertiesWrongLength':
    case 'MissingPositionProperties':
      return `The ${which} mesh has malformed vertex data and cannot be used for a boolean.`;
    case 'NonFiniteVertex':
      return `The ${which} mesh contains infinite or NaN vertex positions.`;
    case 'InvalidConstruction':
      return `The ${which} mesh could not be interpreted as a solid.`;
    default:
      return `The ${which} mesh was rejected by the CSG engine (${status}).`;
  }
}

function toManifold(api: ManifoldToplevel, data: MeshData, which: string): Manifold {
  const mesh = new api.Mesh({
    numProp: 3,
    // Manifold owns the buffers it is handed, so pass copies; the caller still
    // needs its own arrays if the operation fails and we fall back.
    vertProperties: new Float32Array(data.position),
    triVerts: new Uint32Array(data.index),
  });
  // Best-effort repair of vertices that are coincident but not shared, which is
  // exactly the state a freshly loaded STL is in.
  mesh.merge();

  let solid: Manifold;
  try {
    solid = api.Manifold.ofMesh(mesh);
  } catch (error) {
    throw new UserFacingError(describeStatus(statusFromError(error), which));
  }

  const status = solid.status();
  if (status !== 'NoError') {
    solid.delete();
    throw new UserFacingError(describeStatus(status, which));
  }
  return solid;
}

/**
 * Constructive solid geometry between the loaded model and a second mesh.
 * Both operands have to be closed solids.
 */
export async function booleanOp(
  data: MeshData,
  other: MeshData,
  op: BooleanOp,
): Promise<FilterOutcome> {
  const api = await loadManifold();

  const beforeTriangles = triangleCountOf(data);
  let a: Manifold | null = null;
  let b: Manifold | null = null;
  let result: Manifold | null = null;

  try {
    a = toManifold(api, data, 'loaded');
    b = toManifold(api, other, 'second');

    try {
      result =
        op === 'union'
          ? api.Manifold.union(a, b)
          : op === 'difference'
            ? api.Manifold.difference(a, b)
            : api.Manifold.intersection(a, b);
    } catch (error) {
      throw new UserFacingError(describeStatus(statusFromError(error), 'result'));
    }

    const status = result.status();
    if (status !== 'NoError') throw new UserFacingError(describeStatus(status, 'result'));

    const mesh = result.getMesh();
    if (mesh.numTri === 0) {
      throw new UserFacingError(
        op === 'intersection'
          ? 'The two meshes do not overlap, so the intersection is empty.'
          : 'The result of the operation is empty.',
      );
    }

    // getMesh interleaves properties; with numProp 3 that is positions alone.
    data.position = new Float32Array(mesh.vertProperties);
    data.index = new Uint32Array(mesh.triVerts);
    data.normal = null;
    data.color = null;
    data.uv = null;
    recomputeNormals(data);

    return {
      data,
      notes: [
        `${op[0].toUpperCase()}${op.slice(1)}: ${count(beforeTriangles)} → ${count(
          triangleCountOf(data),
        )} triangles, ${count(vertexCountOf(data))} vertices.`,
        'Vertex colours and UVs do not survive this filter.',
      ],
    };
  } finally {
    a?.delete();
    b?.delete();
    result?.delete();
  }
}
