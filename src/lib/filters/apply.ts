import type { MeshPayload } from '../types';
import { booleanOp, type BooleanOp } from './boolean';
import { cleanMesh, removeSmallComponents, weldVertices } from './clean';
import { closeHoles } from './holes';
import { convexHull } from './hull';
import { recomputeNormals, toMeshData, toPayload, type FilterOutcome, type MeshData } from './meshData';
import {
  boolParam,
  findFilter,
  numberParam,
  stringParam,
  type FilterId,
  type FilterParams,
} from './registry';
import { simplifyMesh } from './simplify';
import { laplacianSmooth, taubinSmooth } from './smooth';

export interface FilterRun {
  payload: MeshPayload;
  notes: string[];
}

type Progress = (fraction: number, message: string) => void;

async function dispatch(
  id: FilterId,
  params: FilterParams,
  data: MeshData,
  other: MeshData | null,
): Promise<FilterOutcome> {
  switch (id) {
    case 'weld':
      return weldVertices(data, numberParam(params, 'tolerance', 0));
    case 'clean':
      return cleanMesh(data);
    case 'removeSmallComponents':
      return removeSmallComponents(data, numberParam(params, 'minFraction', 0.01));
    case 'recomputeNormals':
      recomputeNormals(data);
      return { data, notes: ['Vertex normals rebuilt from the geometry.'] };
    case 'closeHoles':
      return closeHoles(data, Math.round(numberParam(params, 'maxEdges', 200)));
    case 'smoothLaplacian':
      return laplacianSmooth(
        data,
        Math.round(numberParam(params, 'iterations', 3)),
        numberParam(params, 'strength', 0.5),
        boolParam(params, 'preserveBoundary', true),
      );
    case 'smoothTaubin':
      return taubinSmooth(
        data,
        Math.round(numberParam(params, 'iterations', 5)),
        numberParam(params, 'lambda', 0.5),
        numberParam(params, 'mu', -0.53),
        boolParam(params, 'preserveBoundary', true),
      );
    case 'simplify':
      return simplifyMesh(
        data,
        numberParam(params, 'targetPercent', 50),
        numberParam(params, 'targetError', 0.01),
        boolParam(params, 'lockBorder', false),
      );
    case 'convexHull':
      return convexHull(data);
    case 'boolean':
      if (!other) throw new Error('This filter needs a second mesh.');
      return booleanOp(data, other, stringParam(params, 'op', 'difference') as BooleanOp);
  }
}

/**
 * Runs one filter over a parsed mesh and returns the replacement payload.
 *
 * Filters that read connectivity are given a welded mesh first: a triangle
 * soup has no shared edges, so smoothing or hole detection would otherwise
 * report nothing to do and quietly leave the model untouched.
 */
export async function applyFilter(
  id: FilterId,
  params: FilterParams,
  payload: MeshPayload,
  secondary: MeshPayload | null,
  onProgress: Progress,
): Promise<FilterRun> {
  const def = findFilter(id);
  const data = toMeshData(payload);
  const notes: string[] = [];

  if (def.needsTopology && payload.index === null) {
    onProgress(0.15, 'Merging coincident vertices');
    const welded = weldVertices(data, 0);
    notes.push(`Welded first — ${welded.notes.join(' ')}`);
  }

  onProgress(0.4, `Running ${def.label.toLowerCase()}`);
  const other = secondary ? toMeshData(secondary) : null;
  const outcome = await dispatch(id, params, data, other);
  notes.push(...outcome.notes);

  onProgress(0.95, 'Uploading to GPU');
  return { payload: toPayload(outcome.data, payload.format), notes };
}
