import type {
  Colormap,
  MeshPayload,
  MeshSettings,
  MeshShading,
  ModelPayload,
  RenderMode,
  VolumePayload,
  VolumeSettings,
} from '../lib/types';

interface Props {
  payload: ModelPayload;
  meshSettings: MeshSettings;
  volumeSettings: VolumeSettings;
  onMeshChange: (patch: Partial<MeshSettings>) => void;
  onVolumeChange: (patch: Partial<VolumeSettings>) => void;
  onResetView: () => void;
  onSaveImage: () => void;
}

const AXES = ['X', 'Y', 'Z'] as const;

export default function Controls(props: Props) {
  const { payload, onResetView, onSaveImage } = props;
  return (
    <div className="controls">
      {payload.kind === 'mesh'
        ? <MeshControls {...props} payload={payload} />
        : <VolumeControls {...props} payload={payload} />}
      <div className="button-row">
        <button className="btn" onClick={onResetView}>
          Reset view
        </button>
        <button className="btn" onClick={onSaveImage}>
          Save image
        </button>
      </div>
    </div>
  );
}

function MeshControls({
  payload,
  meshSettings,
  onMeshChange,
}: Props & { payload: MeshPayload }) {
  return (
    <section className="panel">
      <h3>Appearance</h3>

      <label className="field">
        <span>Display</span>
        <select
          value={meshSettings.shading}
          onChange={(e) => onMeshChange({ shading: e.target.value as MeshShading })}
        >
          <option value="shaded">Solid</option>
          <option value="wireframe">Wireframe</option>
          <option value="points">Point cloud</option>
        </select>
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={meshSettings.useVertexColors}
          disabled={!payload.hasVertexColors}
          onChange={(e) => onMeshChange({ useVertexColors: e.target.checked })}
        />
        <span>
          Vertex colours
          {!payload.hasVertexColors && <em> (not in file)</em>}
        </span>
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={meshSettings.flatShading}
          onChange={(e) => onMeshChange({ flatShading: e.target.checked })}
        />
        <span>Flat shading</span>
      </label>
    </section>
  );
}

function VolumeControls({
  payload,
  volumeSettings: v,
  onVolumeChange,
}: Props & { payload: VolumePayload }) {
  // Normalized slider values map back onto the study's real intensity units.
  const toUnits = (n: number) =>
    Math.round(payload.rangeLow + n * (payload.rangeHigh - payload.rangeLow));
  const unitLabel = payload.modality === 'CT' ? 'HU' : '';

  return (
    <>
      <section className="panel">
        <h3>Rendering</h3>

        <label className="field">
          <span>Mode</span>
          <select
            value={v.mode}
            onChange={(e) => onVolumeChange({ mode: e.target.value as RenderMode })}
          >
            <option value="composite">Volumetric</option>
            <option value="iso">Surface</option>
            <option value="mip">Max intensity</option>
          </select>
        </label>

        <label className="field">
          <span>Colour</span>
          <select
            value={v.colormap}
            onChange={(e) => onVolumeChange({ colormap: e.target.value as Colormap })}
          >
            <option value="bone">Bone</option>
            <option value="grayscale">Greyscale</option>
            <option value="hot">Heat</option>
          </select>
        </label>

        {v.mode === 'iso' ? (
          <Slider
            label="Surface threshold"
            value={v.iso}
            readout={`${toUnits(v.iso)} ${unitLabel}`}
            onChange={(iso) => onVolumeChange({ iso })}
          />
        ) : (
          <>
            <Slider
              label="Window low"
              value={v.windowLow}
              max={v.windowHigh}
              readout={`${toUnits(v.windowLow)} ${unitLabel}`}
              onChange={(windowLow) => onVolumeChange({ windowLow })}
            />
            <Slider
              label="Window high"
              value={v.windowHigh}
              min={v.windowLow}
              readout={`${toUnits(v.windowHigh)} ${unitLabel}`}
              onChange={(windowHigh) => onVolumeChange({ windowHigh })}
            />
          </>
        )}

        <Slider
          label="Quality"
          value={v.quality}
          min={0.4}
          max={2}
          step={0.1}
          readout={`${v.quality.toFixed(1)}×`}
          onChange={(quality) => onVolumeChange({ quality })}
        />
      </section>

      <section className="panel">
        <h3>Crop</h3>
        {AXES.map((axis, i) => (
          <div className="crop-row" key={axis}>
            <span className="crop-row__axis">{axis}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={v.clipMin[i]}
              onChange={(e) => {
                const next = [...v.clipMin] as [number, number, number];
                next[i] = Math.min(parseFloat(e.target.value), v.clipMax[i] - 0.01);
                onVolumeChange({ clipMin: next });
              }}
            />
            <input
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={v.clipMax[i]}
              onChange={(e) => {
                const next = [...v.clipMax] as [number, number, number];
                next[i] = Math.max(parseFloat(e.target.value), v.clipMin[i] + 0.01);
                onVolumeChange({ clipMax: next });
              }}
            />
          </div>
        ))}
        <button
          className="btn btn--wide"
          onClick={() => onVolumeChange({ clipMin: [0, 0, 0], clipMax: [1, 1, 1] })}
        >
          Clear crop
        </button>
      </section>
    </>
  );
}

interface SliderProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  readout?: string;
}

function Slider({ label, value, onChange, min = 0, max = 1, step = 0.005, readout }: SliderProps) {
  return (
    <label className="field field--slider">
      <span className="field__label">
        {label}
        {readout && <em>{readout}</em>}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </label>
  );
}
