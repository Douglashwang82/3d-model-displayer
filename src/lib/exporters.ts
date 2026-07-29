import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { PLYExporter } from 'three/examples/jsm/exporters/PLYExporter.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import type { MeshPayload } from './types';

export type ExportFormat = 'ply' | 'stl' | 'obj' | 'glb';

export const EXPORT_FORMATS: Array<{ value: ExportFormat; label: string }> = [
  { value: 'ply', label: 'PLY (binary)' },
  { value: 'stl', label: 'STL (binary)' },
  { value: 'obj', label: 'OBJ' },
  { value: 'glb', label: 'glTF (GLB)' },
];

/**
 * Rebuilds a three.js mesh from the payload rather than reading it back out of
 * the viewer, because the viewer recentres geometry on the origin for orbiting
 * and an export should keep the model's original coordinates.
 */
function toObject(payload: MeshPayload): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(payload.position, 3));
  if (payload.index) geometry.setIndex(new THREE.BufferAttribute(payload.index, 1));
  if (payload.normal) geometry.setAttribute('normal', new THREE.BufferAttribute(payload.normal, 3));
  if (payload.color) geometry.setAttribute('color', new THREE.BufferAttribute(payload.color, 3));
  if (payload.uv) geometry.setAttribute('uv', new THREE.BufferAttribute(payload.uv, 2));

  const material = new THREE.MeshStandardMaterial({ vertexColors: !!payload.color });
  return new THREE.Mesh(geometry, material);
}

/** Serialises the current mesh into one of the supported containers. */
export async function exportMesh(payload: MeshPayload, format: ExportFormat): Promise<Blob> {
  const object = toObject(payload);
  try {
    switch (format) {
      case 'ply': {
        const data = await new Promise<ArrayBuffer>((resolve) => {
          new PLYExporter().parse(object, (result) => resolve(result), { binary: true });
        });
        return new Blob([data], { type: 'application/octet-stream' });
      }
      case 'stl': {
        const view = new STLExporter().parse(object, { binary: true });
        // The exporter's DataView is always backed by a plain ArrayBuffer, but
        // its type says ArrayBufferLike, which Blob will not accept.
        return new Blob([view.buffer as ArrayBuffer], { type: 'model/stl' });
      }
      case 'obj': {
        const text = new OBJExporter().parse(object);
        return new Blob([text], { type: 'text/plain' });
      }
      case 'glb': {
        const result = await new GLTFExporter().parseAsync(object, { binary: true });
        return new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
      }
    }
  } finally {
    object.geometry.dispose();
    (object.material as THREE.Material).dispose();
  }
}

/** Replaces a file's extension, e.g. `skull.stl` → `skull-filtered.ply`. */
export function exportFileName(source: string, format: ExportFormat): string {
  const base = source.replace(/\.[^.]+$/, '') || 'model';
  return `${base}.${format}`;
}
