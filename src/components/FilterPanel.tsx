import { useCallback, useMemo, useRef, useState } from 'react';
import { EXPORT_FORMATS, type ExportFormat } from '../lib/exporters';
import {
  FILTERS,
  FILTER_GROUPS,
  defaultParams,
  findFilter,
  type FilterId,
  type FilterParam,
  type FilterParams,
} from '../lib/filters/registry';
import type { FilterLogEntry } from '../lib/types';

interface Props {
  busy: boolean;
  progress: { fraction: number; message: string };
  error: string;
  log: FilterLogEntry[];
  canUndo: boolean;
  canRevert: boolean;
  onApply: (filterId: FilterId, params: FilterParams, secondMesh: File | null) => void;
  onUndo: () => void;
  onRevert: () => void;
  onExport: (format: ExportFormat) => void;
}

export default function FilterPanel({
  busy,
  progress,
  error,
  log,
  canUndo,
  canRevert,
  onApply,
  onUndo,
  onRevert,
  onExport,
}: Props) {
  const [selected, setSelected] = useState<FilterId>('weld');
  // Parameters are kept per filter so that switching away and back does not
  // discard a setting the user just dialled in.
  const [paramsById, setParamsById] = useState<Partial<Record<FilterId, FilterParams>>>({});
  const [secondMesh, setSecondMesh] = useState<File | null>(null);
  const [format, setFormat] = useState<ExportFormat>('ply');
  const fileInput = useRef<HTMLInputElement>(null);

  const def = useMemo(() => findFilter(selected), [selected]);
  const params = paramsById[selected] ?? defaultParams(def);

  const setParam = useCallback(
    (key: string, value: number | string | boolean) => {
      setParamsById((current) => ({
        ...current,
        [selected]: { ...(current[selected] ?? defaultParams(def)), [key]: value },
      }));
    },
    [def, selected],
  );

  const resetParams = useCallback(() => {
    setParamsById((current) => ({ ...current, [selected]: defaultParams(def) }));
  }, [def, selected]);

  const missingSecondMesh = !!def.secondMesh && !secondMesh;

  return (
    <>
      <section className="panel">
        <h3>Filters</h3>

        <label className="field">
          <span>Filter</span>
          <select
            value={selected}
            disabled={busy}
            onChange={(e) => setSelected(e.target.value as FilterId)}
          >
            {FILTER_GROUPS.map((group) => (
              <optgroup key={group} label={group}>
                {FILTERS.filter((f) => f.group === group).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <p className="filter__description">{def.description}</p>

        {def.params.map((param) => (
          <ParamControl
            key={param.key}
            param={param}
            value={params[param.key]}
            disabled={busy}
            onChange={(value) => setParam(param.key, value)}
          />
        ))}

        {def.secondMesh && (
          <div className="filter__second">
            <input
              ref={fileInput}
              type="file"
              accept=".ply,.stl,.obj"
              disabled={busy}
              onChange={(e) => setSecondMesh(e.target.files?.[0] ?? null)}
            />
            <button
              className="btn btn--wide"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {secondMesh ? `B: ${secondMesh.name}` : 'Choose second mesh…'}
            </button>
          </div>
        )}

        <div className={`button-row${def.params.length > 0 ? '' : ' button-row--single'}`}>
          <button
            className="btn btn--primary"
            disabled={busy || missingSecondMesh}
            onClick={() => onApply(selected, params, secondMesh)}
            title={missingSecondMesh ? 'Choose a second mesh first' : undefined}
          >
            {busy ? 'Working…' : 'Apply'}
          </button>
          {def.params.length > 0 && (
            <button className="btn" disabled={busy} onClick={resetParams}>
              Defaults
            </button>
          )}
        </div>

        {busy && (
          <div className="progress progress--inline">
            <div className="progress__bar" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
          </div>
        )}
        {busy && progress.message && <p className="filter__status">{progress.message}</p>}

        {error && <p className="filter__error">{error}</p>}

        <div className="button-row">
          <button className="btn" disabled={busy || !canUndo} onClick={onUndo}>
            Undo
          </button>
          <button className="btn" disabled={busy || !canRevert} onClick={onRevert}>
            Revert to file
          </button>
        </div>

        {log.length > 0 && (
          <ol className="filter__log">
            {log.map((entry, i) => (
              <li key={log.length - i}>
                <strong>{entry.label}</strong>
                <em>{formatDuration(entry.elapsedMs)}</em>
                {entry.notes.map((note, j) => (
                  <span key={j}>{note}</span>
                ))}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="panel">
        <h3>Export</h3>
        <label className="field">
          <span>Format</span>
          <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
            {EXPORT_FORMATS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn--wide" disabled={busy} onClick={() => onExport(format)}>
          Download mesh
        </button>
      </section>
    </>
  );
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

interface ParamProps {
  param: FilterParam;
  value: number | string | boolean | undefined;
  disabled: boolean;
  onChange: (value: number | string | boolean) => void;
}

function ParamControl({ param, value, disabled, onChange }: ParamProps) {
  if (param.kind === 'check') {
    return (
      <label className="check">
        <input
          type="checkbox"
          checked={typeof value === 'boolean' ? value : param.default}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{param.label}</span>
      </label>
    );
  }

  if (param.kind === 'select') {
    return (
      <label className="field">
        <span>{param.label}</span>
        <select
          value={typeof value === 'string' ? value : param.default}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {param.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  const current = typeof value === 'number' ? value : param.default;
  return (
    <label className="field field--slider">
      <span className="field__label">
        {param.label}
        <em>{param.format ? param.format(current) : String(current)}</em>
      </span>
      <input
        type="range"
        min={param.min}
        max={param.max}
        step={param.step}
        value={current}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </label>
  );
}
