/// <reference lib="webworker" />
import { UserFacingError } from '../lib/errors';
import { applyFilter } from '../lib/filters/apply';
import { parseMeshFile, transferablesOf } from '../lib/meshParse';
import type { FilterRequest, FilterResponse } from '../lib/types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(message: FilterResponse, transfer: Transferable[] = []): void {
  ctx.postMessage(message, transfer);
}

ctx.onmessage = async (event: MessageEvent<FilterRequest>) => {
  const { id, filterId, params, payload, secondMesh } = event.data;
  const started = performance.now();

  try {
    post({ id, type: 'progress', fraction: 0.05, message: 'Preparing mesh' });

    let secondary = null;
    if (secondMesh) {
      post({ id, type: 'progress', fraction: 0.1, message: `Reading ${secondMesh.fileName}` });
      secondary = parseMeshFile(secondMesh.fileName, secondMesh.buffer);
    }

    const result = await applyFilter(filterId, params, payload, secondary, (fraction, message) =>
      post({ id, type: 'progress', fraction, message }),
    );

    post(
      {
        id,
        type: 'done',
        payload: result.payload,
        notes: result.notes,
        elapsedMs: performance.now() - started,
      },
      transferablesOf(result.payload),
    );
  } catch (error) {
    const message =
      error instanceof UserFacingError
        ? error.message
        : `The filter failed. (${error instanceof Error ? error.message : String(error)})`;
    post({ id, type: 'error', message });
  }
};
