import type { ModelPayload } from '../lib/types';

interface Props {
  payload: ModelPayload;
  fileName: string;
  fileSize: number;
}

const numberFormat = new Intl.NumberFormat();

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export default function InfoPanel({ payload, fileName, fileSize }: Props) {
  const rows: Array<[string, string]> = [
    ['Format', payload.format],
    ['Size', formatBytes(fileSize)],
  ];

  if (payload.kind === 'mesh') {
    rows.push(['Vertices', numberFormat.format(payload.vertexCount)]);
    rows.push(['Triangles', numberFormat.format(Math.round(payload.triangleCount))]);
    rows.push(['Vertex colours', payload.hasVertexColors ? 'Yes' : 'No']);
  } else {
    const [sx, sy, sz] = payload.spacing;
    rows.push(['Modality', payload.modality]);
    rows.push(['Dimensions', `${payload.width} × ${payload.height} × ${payload.depth}`]);
    rows.push(['Voxel size', `${sx.toFixed(2)} × ${sy.toFixed(2)} × ${sz.toFixed(2)} mm`]);
    rows.push([
      'Extent',
      `${(payload.width * sx).toFixed(0)} × ${(payload.height * sy).toFixed(0)} × ${(
        payload.depth * sz
      ).toFixed(0)} mm`,
    ]);
    rows.push(['Intensity', `${Math.round(payload.rangeLow)} … ${Math.round(payload.rangeHigh)}`]);
  }

  return (
    <section className="panel">
      <h3 title={fileName} className="panel__title-ellipsis">
        {fileName}
      </h3>
      {payload.kind === 'volume' && payload.description && (
        <p className="info-subtitle">{payload.description}</p>
      )}
      <dl className="info">
        {rows.map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
