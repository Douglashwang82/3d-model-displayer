import * as THREE from 'three';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { UserFacingError } from './errors';
import type { MeshPayload, ModelPayload } from './types';

/** Mesh containers the loaders below can read, lower-case and without the dot. */
export const MESH_EXTENSIONS = new Set(['ply', 'stl', 'obj']);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Flattens a loaded scene graph into a single geometry. */
function mergeGroup(group: THREE.Object3D): THREE.BufferGeometry {
  const geometries: THREE.BufferGeometry[] = [];
  group.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) geometries.push(mesh.geometry);
  });
  if (geometries.length === 0) throw new Error('File contains no triangle meshes.');
  if (geometries.length === 1) return geometries[0];

  // Attribute sets can differ between sub-objects, so combine on position alone
  // and rebuild normals; that is always valid even for ragged inputs.
  let total = 0;
  for (const g of geometries) {
    const nonIndexed = g.index ? g.toNonIndexed() : g;
    total += nonIndexed.getAttribute('position').count;
  }
  const positions = new Float32Array(total * 3);
  let offset = 0;
  for (const g of geometries) {
    const nonIndexed = g.index ? g.toNonIndexed() : g;
    const attr = nonIndexed.getAttribute('position');
    positions.set(attr.array as Float32Array, offset);
    offset += attr.count * 3;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.computeVertexNormals();
  return merged;
}

function toFloat32(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined) {
  if (!attr) return null;
  const array = attr.array;
  return array instanceof Float32Array ? array : new Float32Array(array as ArrayLike<number>);
}

export function geometryToPayload(geometry: THREE.BufferGeometry, format: string): MeshPayload {
  const position = toFloat32(geometry.getAttribute('position') as THREE.BufferAttribute);
  if (!position) throw new Error('Model has no vertex positions.');
  // A malformed file often parses into an empty geometry rather than throwing;
  // reporting that as a successful load would just show an empty viewport.
  if (position.length === 0) {
    throw new UserFacingError(
      `No geometry could be read from this ${format} file. It may be truncated or malformed.`,
    );
  }

  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();

  const normal = toFloat32(geometry.getAttribute('normal') as THREE.BufferAttribute);
  const color = toFloat32(geometry.getAttribute('color') as THREE.BufferAttribute);
  const uv = toFloat32(geometry.getAttribute('uv') as THREE.BufferAttribute);

  let index: Uint32Array | null = null;
  if (geometry.index) {
    const src = geometry.index.array;
    index = src instanceof Uint32Array ? src : new Uint32Array(src as ArrayLike<number>);
  }

  const vertexCount = position.length / 3;
  const triangleCount = index ? index.length / 3 : vertexCount / 3;

  return {
    kind: 'mesh',
    format,
    position,
    normal,
    color,
    uv,
    index,
    vertexCount,
    triangleCount,
    hasVertexColors: !!color,
  };
}

/**
 * Runs a loader, translating its internal failures into something a user can
 * act on. Loaders throw things like "Offset is outside the bounds of the
 * DataView" when handed a truncated file, which is not a useful message on its own.
 */
function parseMesh(format: string, parse: () => THREE.BufferGeometry): MeshPayload {
  try {
    return geometryToPayload(parse(), format);
  } catch (error) {
    if (error instanceof UserFacingError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new UserFacingError(
      `Could not read this ${format} file — it may be truncated or malformed. (${detail})`,
    );
  }
}

/**
 * Reads one of the supported triangle-mesh containers. Throws
 * `UserFacingError` for anything the caller should show verbatim.
 */
export function parseMeshFile(fileName: string, buffer: ArrayBuffer): MeshPayload {
  switch (extensionOf(fileName)) {
    case 'ply':
      return parseMesh('PLY', () => new PLYLoader().parse(buffer));
    case 'stl':
      return parseMesh('STL', () => new STLLoader().parse(buffer));
    case 'obj':
      return parseMesh('OBJ', () =>
        mergeGroup(new OBJLoader().parse(new TextDecoder().decode(buffer))),
      );
    default:
      throw new UserFacingError(
        `Unsupported mesh type "${fileName}". Supported formats are PLY, STL and OBJ.`,
      );
  }
}

/** Collects the distinct ArrayBuffers behind a payload so they move, not copy. */
export function transferablesOf(payload: ModelPayload): Transferable[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (a: { buffer: ArrayBufferLike } | null) => {
    if (a && a.buffer instanceof ArrayBuffer) buffers.add(a.buffer);
  };
  if (payload.kind === 'mesh') {
    add(payload.position);
    add(payload.normal);
    add(payload.color);
    add(payload.uv);
    add(payload.index);
  } else {
    add(payload.data);
  }
  return [...buffers];
}
