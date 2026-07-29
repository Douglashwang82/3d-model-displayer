/// <reference lib="webworker" />
import { isDicom, parseDicomVolume } from '../lib/dicom';
import { UserFacingError } from '../lib/errors';
import { extensionOf, parseMeshFile, transferablesOf } from '../lib/meshParse';
import type { ModelPayload, WorkerRequest, WorkerResponse } from '../lib/types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  ctx.postMessage(message, transfer);
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, fileName, buffer } = event.data;
  const ext = extensionOf(fileName);

  try {
    let payload: ModelPayload;

    const parseVolume = (): ModelPayload => ({
      kind: 'volume',
      format: 'DICOM',
      ...parseDicomVolume(buffer, {
        onProgress: (fraction, message) => post({ id, type: 'progress', fraction, message }),
      }),
    });

    // The extension decides when it is recognised; sniffing the DICM marker is
    // the fallback, since DICOM files are often named without an extension.
    if (ext === 'dcm' || ext === 'dicom') {
      payload = parseVolume();
    } else if (ext === 'ply' || ext === 'stl' || ext === 'obj') {
      post({ id, type: 'progress', fraction: 0.25, message: `Parsing ${ext.toUpperCase()}` });
      payload = parseMeshFile(fileName, buffer);
    } else if (isDicom(buffer)) {
      payload = parseVolume();
    } else {
      throw new UserFacingError(
        `Unsupported file type "${ext || fileName}". Supported formats are PLY, STL, OBJ and DICOM.`,
      );
    }

    post({ id, type: 'progress', fraction: 1, message: 'Uploading to GPU' });
    post({ id, type: 'done', payload }, transferablesOf(payload));
  } catch (error) {
    const message =
      error instanceof UserFacingError
        ? error.message
        : `Could not open this file. (${error instanceof Error ? error.message : String(error)})`;
    post({ id, type: 'error', message });
  }
};
