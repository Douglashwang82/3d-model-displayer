export interface MeshPayload {
  kind: 'mesh';
  format: string;
  position: Float32Array;
  normal: Float32Array | null;
  color: Float32Array | null;
  uv: Float32Array | null;
  index: Uint32Array | null;
  vertexCount: number;
  triangleCount: number;
  hasVertexColors: boolean;
}

export interface VolumePayload {
  kind: 'volume';
  format: string;
  data: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  depth: number;
  spacing: [number, number, number];
  rangeLow: number;
  rangeHigh: number;
  suggestedIso: number;
  suggestedWindow: [number, number];
  modality: string;
  description: string;
}

export type ModelPayload = MeshPayload | VolumePayload;

export interface WorkerRequest {
  id: number;
  fileName: string;
  buffer: ArrayBuffer;
}

export type WorkerResponse =
  | { id: number; type: 'progress'; fraction: number; message: string }
  | { id: number; type: 'done'; payload: ModelPayload }
  | { id: number; type: 'error'; message: string };

export type RenderMode = 'mip' | 'iso' | 'composite';
export type Colormap = 'grayscale' | 'bone' | 'hot';

export interface VolumeSettings {
  mode: RenderMode;
  colormap: Colormap;
  windowLow: number;
  windowHigh: number;
  iso: number;
  quality: number;
  clipMin: [number, number, number];
  clipMax: [number, number, number];
}

export type MeshShading = 'shaded' | 'wireframe' | 'points';

export interface MeshSettings {
  shading: MeshShading;
  useVertexColors: boolean;
  flatShading: boolean;
  showEdges: boolean;
}
