/**
 * The catalogue of mesh filters. Kept free of heavy imports so that the UI can
 * describe every filter without pulling three.js, meshoptimizer or the CSG
 * WebAssembly module into the main bundle — those only load inside the worker.
 */

export type FilterId =
  | 'weld'
  | 'clean'
  | 'removeSmallComponents'
  | 'recomputeNormals'
  | 'closeHoles'
  | 'smoothLaplacian'
  | 'smoothTaubin'
  | 'simplify'
  | 'convexHull'
  | 'boolean';

export type ParamValue = number | string | boolean;
export type FilterParams = Record<string, ParamValue>;

export interface RangeParam {
  kind: 'range';
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  format?: (value: number) => string;
}

export interface CheckParam {
  kind: 'check';
  key: string;
  label: string;
  default: boolean;
}

export interface SelectParam {
  kind: 'select';
  key: string;
  label: string;
  default: string;
  options: Array<{ value: string; label: string }>;
}

export type FilterParam = RangeParam | CheckParam | SelectParam;

export type FilterGroup = 'Clean' | 'Repair' | 'Smooth' | 'Remesh' | 'Combine';

export interface FilterDef {
  id: FilterId;
  label: string;
  group: FilterGroup;
  description: string;
  params: FilterParam[];
  /** Requires a second mesh, chosen by the user at the time it is run. */
  secondMesh?: boolean;
  /**
   * Reads connectivity, so it is meaningless on a triangle soup. The runner
   * welds unindexed input first rather than silently producing nothing.
   */
  needsTopology?: boolean;
}

const percentOfSize = (value: number) =>
  value === 0 ? 'exact matches only' : `${(value * 100).toFixed(3)}% of model size`;

export const FILTERS: FilterDef[] = [
  {
    id: 'weld',
    label: 'Merge close vertices',
    group: 'Clean',
    description:
      'Joins vertices that share a position. STL files store every triangle separately, so this is what gives them a connected surface to work on.',
    params: [
      {
        kind: 'range',
        key: 'tolerance',
        label: 'Tolerance',
        min: 0,
        max: 0.01,
        step: 0.00025,
        default: 0,
        format: percentOfSize,
      },
    ],
  },
  {
    id: 'clean',
    label: 'Remove defects',
    group: 'Clean',
    description:
      'Deletes zero-area triangles, triangles that duplicate another, and vertices no triangle uses.',
    params: [],
  },
  {
    id: 'removeSmallComponents',
    label: 'Remove small pieces',
    group: 'Clean',
    description:
      'Deletes disconnected fragments below a size threshold — scanner specks and stray shells. The largest piece is always kept.',
    params: [
      {
        kind: 'range',
        key: 'minFraction',
        label: 'Smallest piece to keep',
        min: 0.0005,
        max: 0.25,
        step: 0.0005,
        default: 0.01,
        format: (value) => `${(value * 100).toFixed(2)}% of triangles`,
      },
    ],
    needsTopology: true,
  },
  {
    id: 'recomputeNormals',
    label: 'Recompute normals',
    group: 'Clean',
    description:
      'Rebuilds vertex normals from the geometry, weighted by triangle area. Fixes shading on files with missing or wrong normals.',
    params: [],
  },
  {
    id: 'closeHoles',
    label: 'Close holes',
    group: 'Repair',
    description:
      'Finds open boundary loops and patches each with a triangle fan. Large loops are usually the model’s intended open side, so they are skipped by default.',
    params: [
      {
        kind: 'range',
        key: 'maxEdges',
        label: 'Largest hole to fill',
        min: 3,
        max: 1000,
        step: 1,
        default: 200,
        format: (value) => `${value} edges`,
      },
    ],
    needsTopology: true,
  },
  {
    id: 'smoothLaplacian',
    label: 'Laplacian smooth',
    group: 'Smooth',
    description:
      'Moves each vertex toward the average of its neighbours. Removes noise quickly, but shrinks the model as iterations rise.',
    params: [
      { kind: 'range', key: 'iterations', label: 'Iterations', min: 1, max: 20, step: 1, default: 3 },
      { kind: 'range', key: 'strength', label: 'Strength', min: 0.05, max: 1, step: 0.05, default: 0.5 },
      { kind: 'check', key: 'preserveBoundary', label: 'Hold open edges still', default: true },
    ],
    needsTopology: true,
  },
  {
    id: 'smoothTaubin',
    label: 'Taubin smooth',
    group: 'Smooth',
    description:
      'A shrinking pass followed by a slightly larger inflating one. Smooths without visibly deflating the model.',
    params: [
      { kind: 'range', key: 'iterations', label: 'Passes', min: 1, max: 20, step: 1, default: 5 },
      { kind: 'range', key: 'lambda', label: 'λ (shrink)', min: 0.1, max: 0.9, step: 0.05, default: 0.5 },
      { kind: 'range', key: 'mu', label: 'μ (inflate)', min: -0.9, max: -0.15, step: 0.01, default: -0.53 },
      { kind: 'check', key: 'preserveBoundary', label: 'Hold open edges still', default: true },
    ],
    needsTopology: true,
  },
  {
    id: 'simplify',
    label: 'Simplify',
    group: 'Remesh',
    description:
      'Quadric edge-collapse decimation. Collapses the edges that change the surface least until the triangle target or the error limit is reached.',
    params: [
      {
        kind: 'range',
        key: 'targetPercent',
        label: 'Target',
        min: 1,
        max: 99,
        step: 1,
        default: 50,
        format: (value) => `${value}% of triangles`,
      },
      {
        kind: 'range',
        key: 'targetError',
        label: 'Error limit',
        min: 0.001,
        max: 0.05,
        step: 0.001,
        default: 0.01,
        format: (value) => `${(value * 100).toFixed(1)}% of model size`,
      },
      { kind: 'check', key: 'lockBorder', label: 'Keep open edges fixed', default: false },
    ],
    needsTopology: true,
  },
  {
    id: 'convexHull',
    label: 'Convex hull',
    group: 'Remesh',
    description:
      'Replaces the mesh with the smallest convex solid that contains every vertex. Slow on very large models.',
    params: [],
  },
  {
    id: 'boolean',
    label: 'Boolean',
    group: 'Combine',
    description:
      'Constructive solid geometry against a second mesh. Both operands must be watertight solids — run Merge close vertices and Close holes first if the operation is rejected.',
    params: [
      {
        kind: 'select',
        key: 'op',
        label: 'Operation',
        default: 'difference',
        options: [
          { value: 'union', label: 'Union (A ∪ B)' },
          { value: 'difference', label: 'Difference (A − B)' },
          { value: 'intersection', label: 'Intersection (A ∩ B)' },
        ],
      },
    ],
    secondMesh: true,
  },
];

export const FILTER_GROUPS: FilterGroup[] = ['Clean', 'Repair', 'Smooth', 'Remesh', 'Combine'];

export function findFilter(id: FilterId): FilterDef {
  const filter = FILTERS.find((f) => f.id === id);
  if (!filter) throw new Error(`Unknown filter "${id}".`);
  return filter;
}

export function defaultParams(def: FilterDef): FilterParams {
  const params: FilterParams = {};
  for (const param of def.params) params[param.key] = param.default;
  return params;
}

export function numberParam(params: FilterParams, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function boolParam(params: FilterParams, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function stringParam(params: FilterParams, key: string, fallback: string): string {
  const value = params[key];
  return typeof value === 'string' ? value : fallback;
}
