import { useCallback, useEffect, useRef, useState } from 'react';
import DropZone from './components/DropZone';
import Controls from './components/Controls';
import InfoPanel from './components/InfoPanel';
import { Viewer } from './lib/Viewer';
import type {
  MeshSettings,
  ModelPayload,
  VolumeSettings,
  WorkerRequest,
  WorkerResponse,
} from './lib/types';

const DEFAULT_MESH_SETTINGS: MeshSettings = {
  shading: 'shaded',
  useVertexColors: true,
  flatShading: false,
  showEdges: false,
};

const DEFAULT_VOLUME_SETTINGS: VolumeSettings = {
  mode: 'iso',
  colormap: 'bone',
  windowLow: 0.2,
  windowHigh: 0.85,
  iso: 0.35,
  quality: 1,
  clipMin: [0, 0, 0],
  clipMax: [1, 1, 1],
};

interface SampleFile {
  name: string;
  size: number;
  url: string;
}

export default function App() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestId = useRef(0);

  const [payload, setPayload] = useState<ModelPayload | null>(null);
  const [fileInfo, setFileInfo] = useState<{ name: string; size: number } | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [progress, setProgress] = useState({ fraction: 0, message: '' });
  const [error, setError] = useState('');
  const [meshSettings, setMeshSettings] = useState(DEFAULT_MESH_SETTINGS);
  const [volumeSettings, setVolumeSettings] = useState(DEFAULT_VOLUME_SETTINGS);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [samples, setSamples] = useState<SampleFile[]>([]);

  // Set up the renderer and the parsing worker once.
  useEffect(() => {
    if (!canvasHostRef.current) return;
    const viewer = new Viewer(canvasHostRef.current);
    viewerRef.current = viewer;

    const worker = new Worker(new URL('./workers/model.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      // Ignore results from a file that has since been superseded.
      if (message.id !== requestId.current) return;

      if (message.type === 'progress') {
        setProgress({ fraction: message.fraction, message: message.message });
        return;
      }
      if (message.type === 'error') {
        setError(message.message);
        setStatus('error');
        return;
      }

      const next = message.payload;
      if (next.kind === 'volume') {
        setVolumeSettings({
          ...DEFAULT_VOLUME_SETTINGS,
          windowLow: next.suggestedWindow[0],
          windowHigh: next.suggestedWindow[1],
          iso: next.suggestedIso,
        });
      } else {
        setMeshSettings(DEFAULT_MESH_SETTINGS);
      }
      setPayload(next);
      setStatus('ready');
    };

    worker.onerror = (event) => {
      setError(event.message || 'The model parser crashed.');
      setStatus('error');
    };

    return () => {
      worker.terminate();
      viewer.dispose();
      viewerRef.current = null;
      workerRef.current = null;
    };
  }, []);

  // In development the files in ./data are offered as one-click samples.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    fetch('/__samples')
      .then((r) => (r.ok ? r.json() : []))
      .then((list: SampleFile[]) => setSamples(list))
      .catch(() => setSamples([]));
  }, []);

  // Push the parsed model into the scene.
  useEffect(() => {
    if (payload && viewerRef.current) viewerRef.current.load(payload);
  }, [payload]);

  // Keep the scene in sync with the control panels.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !payload) return;
    if (payload.kind === 'mesh') viewer.applyMeshSettings(meshSettings, payload);
    else viewer.applyVolumeSettings(volumeSettings);
  }, [payload, meshSettings, volumeSettings]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const loadBuffer = useCallback((name: string, size: number, buffer: ArrayBuffer) => {
    const worker = workerRef.current;
    if (!worker) return;

    const id = requestId.current + 1;
    requestId.current = id;

    setFileInfo({ name, size });
    setPayload(null);
    setError('');
    setStatus('loading');
    setProgress({ fraction: 0, message: 'Reading file' });

    const request: WorkerRequest = { id, fileName: name, buffer };
    worker.postMessage(request, [buffer]);
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      setStatus('loading');
      setProgress({ fraction: 0, message: 'Reading file' });
      try {
        const buffer = await file.arrayBuffer();
        loadBuffer(file.name, file.size, buffer);
      } catch {
        setError('Could not read that file from disk.');
        setStatus('error');
      }
    },
    [loadBuffer],
  );

  const handleSample = useCallback(
    async (sample: SampleFile) => {
      setStatus('loading');
      setProgress({ fraction: 0, message: 'Downloading sample' });
      try {
        const response = await fetch(sample.url);
        if (!response.ok) throw new Error(String(response.status));
        const buffer = await response.arrayBuffer();
        loadBuffer(sample.name, buffer.byteLength, buffer);
      } catch {
        setError(`Could not load sample "${sample.name}".`);
        setStatus('error');
      }
    },
    [loadBuffer],
  );

  const saveImage = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const link = document.createElement('a');
    link.href = viewer.snapshot();
    link.download = `${(fileInfo?.name ?? 'model').replace(/\.[^.]+$/, '')}.png`;
    link.click();
  }, [fileInfo]);

  // Prefer real fullscreen, but fall back to hiding the sidebar when the
  // browser refuses it (embedded frames and some managed environments do).
  const toggleExpanded = useCallback(async () => {
    const stage = stageRef.current;
    if (!stage) return;

    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (expanded) {
      setExpanded(false);
      return;
    }
    try {
      await stage.requestFullscreen();
    } catch {
      setExpanded(true);
    }
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  return (
    <div className={`app${expanded ? ' app--expanded' : ''}`}>
      <aside className="sidebar">
        <header className="brand">
          <h1>3D Model Viewer</h1>
          <p>Meshes and medical volumes, rendered in your browser.</p>
        </header>

        <DropZone onFile={handleFile} compact={status === 'ready'} />

        {samples.length > 0 && status !== 'loading' && (
          <section className="panel">
            <h3>Samples</h3>
            <div className="samples">
              {samples.map((sample) => (
                <button key={sample.url} className="btn btn--sample" onClick={() => handleSample(sample)}>
                  <span className="btn__name">{sample.name}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {status === 'error' && (
          <section className="panel panel--error">
            <h3>Could not open that file</h3>
            <p>{error}</p>
          </section>
        )}

        {status === 'ready' && payload && fileInfo && (
          <>
            <InfoPanel payload={payload} fileName={fileInfo.name} fileSize={fileInfo.size} />
            <Controls
              payload={payload}
              meshSettings={meshSettings}
              volumeSettings={volumeSettings}
              onMeshChange={(patch) => setMeshSettings((s) => ({ ...s, ...patch }))}
              onVolumeChange={(patch) => setVolumeSettings((s) => ({ ...s, ...patch }))}
              onResetView={() => viewerRef.current?.frameCamera()}
              onSaveImage={saveImage}
            />
          </>
        )}

        <footer className="hint">
          <strong>Drag</strong> to orbit · <strong>Scroll</strong> to zoom · <strong>Right-drag</strong> to pan
        </footer>
      </aside>

      <main className="stage" ref={stageRef}>
        <div className="stage__canvas" ref={canvasHostRef} />

        {status === 'ready' && (
          <button
            className="fullscreen-btn"
            onClick={toggleExpanded}
            title={expanded ? 'Restore the sidebar (Esc)' : 'Fill the window'}
          >
            {isFullscreen || expanded ? 'Exit' : 'Expand'}
          </button>
        )}

        {status === 'loading' && (
          <div className="overlay">
            <div className="spinner" />
            <p className="overlay__message">{progress.message}</p>
            <div className="progress">
              <div className="progress__bar" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
            </div>
          </div>
        )}

        {status === 'idle' && (
          <div className="overlay overlay--quiet">
            <p>No model loaded</p>
          </div>
        )}
      </main>
    </div>
  );
}
