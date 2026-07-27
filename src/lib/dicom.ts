/**
 * Minimal DICOM reader for uncompressed single-file volumes.
 *
 * Scope is deliberately narrow: enough to turn a multi-frame CT/MR (or a
 * classic single-frame image) into a scalar volume. Compressed transfer
 * syntaxes (JPEG/JPEG2000/RLE) are detected and rejected with a clear message
 * rather than half-decoded.
 */

import { UserFacingError } from './errors';

export interface VolumeData {
  /** Normalized scalar field, one byte per voxel, x fastest then y then z. */
  data: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  depth: number;
  /** Physical size of one voxel in mm. */
  spacing: [number, number, number];
  /** Stored-value range mapped onto 0..255, expressed in rescaled units (HU for CT). */
  rangeLow: number;
  rangeHigh: number;
  /** Starting isosurface threshold, normalized to 0..1. */
  suggestedIso: number;
  /** Starting display window, normalized to 0..1. */
  suggestedWindow: [number, number];
  modality: string;
  description: string;
}

const EXPLICIT_LONG_VR = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'UT', 'UC', 'UR', 'UN']);

const UNCOMPRESSED_TS: Record<string, { explicitVR: boolean; littleEndian: boolean }> = {
  '1.2.840.10008.1.2': { explicitVR: false, littleEndian: true }, // Implicit VR LE
  '1.2.840.10008.1.2.1': { explicitVR: true, littleEndian: true }, // Explicit VR LE
  '1.2.840.10008.1.2.2': { explicitVR: true, littleEndian: false }, // Explicit VR BE
};

const tagKey = (group: number, element: number) => (group << 16 | element) >>> 0;

const T = {
  TransferSyntaxUID: tagKey(0x0002, 0x0010),
  Modality: tagKey(0x0008, 0x0060),
  SeriesDescription: tagKey(0x0008, 0x103e),
  Manufacturer: tagKey(0x0008, 0x0070),
  ModelName: tagKey(0x0008, 0x1090),
  SliceThickness: tagKey(0x0018, 0x0050),
  SpacingBetweenSlices: tagKey(0x0018, 0x0088),
  NumberOfFrames: tagKey(0x0028, 0x0008),
  Rows: tagKey(0x0028, 0x0010),
  Columns: tagKey(0x0028, 0x0011),
  PixelSpacing: tagKey(0x0028, 0x0030),
  BitsAllocated: tagKey(0x0028, 0x0100),
  BitsStored: tagKey(0x0028, 0x0101),
  PixelRepresentation: tagKey(0x0028, 0x0103),
  RescaleIntercept: tagKey(0x0028, 0x1052),
  RescaleSlope: tagKey(0x0028, 0x1053),
  PixelData: tagKey(0x7fe0, 0x0010),
} as const;

const ITEM = tagKey(0xfffe, 0xe000);
const ITEM_DELIM = tagKey(0xfffe, 0xe00d);
const SEQ_DELIM = tagKey(0xfffe, 0xe0dd);
const UNDEFINED_LENGTH = 0xffffffff;

interface Element {
  vr: string;
  offset: number;
  length: number;
}

/**
 * Sequence tags we must descend into even under implicit VR, where a
 * defined-length sequence is otherwise indistinguishable from an opaque blob.
 * Enhanced multi-frame objects bury pixel measures inside these.
 */
const KNOWN_SEQUENCES = new Set([
  tagKey(0x5200, 0x9229), // SharedFunctionalGroupsSequence
  tagKey(0x5200, 0x9230), // PerFrameFunctionalGroupsSequence
  tagKey(0x0028, 0x9110), // PixelMeasuresSequence
  tagKey(0x0028, 0x9145), // FrameVOILUTSequence
  tagKey(0x0020, 0x9116), // PlaneOrientationSequence
  tagKey(0x0020, 0x9113), // PlanePositionSequence
]);

const MAX_DEPTH = 16;

/**
 * Walks the dataset collecting the first occurrence of each tag we care about.
 * Descends into sequences, since enhanced multi-frame objects store spacing
 * inside the shared functional groups rather than at the top level.
 */
class Parser {
  private view: DataView;
  private explicitVR: boolean;
  private littleEndian: boolean;
  private done = false;
  elements = new Map<number, Element>();
  pixelDataOffset = -1;
  pixelDataLength = 0;

  constructor(view: DataView, explicitVR: boolean, littleEndian: boolean) {
    this.view = view;
    this.explicitVR = explicitVR;
    this.littleEndian = littleEndian;
  }

  walk(start: number, end: number): void {
    this.done = false;
    this.walkElements(start, end, 0);
  }

  private tagAt(pos: number): number {
    return tagKey(
      this.view.getUint16(pos, this.littleEndian),
      this.view.getUint16(pos + 2, this.littleEndian),
    );
  }

  /**
   * Reads elements until `end`, or until an item/sequence delimiter which is
   * left unconsumed. Returns the stop position.
   */
  private walkElements(start: number, end: number, depth: number): number {
    let pos = start;
    while (!this.done && pos + 8 <= end) {
      const group = this.view.getUint16(pos, this.littleEndian);
      const key = this.tagAt(pos);

      if (key === ITEM_DELIM || key === SEQ_DELIM) return pos;

      let valueStart = pos + 4;
      let vr = '';
      let length: number;

      // Group 0xFFFE items never carry a VR, even under explicit VR.
      if (this.explicitVR && group !== 0xfffe) {
        vr = String.fromCharCode(
          this.view.getUint8(valueStart),
          this.view.getUint8(valueStart + 1),
        );
        if (EXPLICIT_LONG_VR.has(vr)) {
          length = this.view.getUint32(valueStart + 4, this.littleEndian);
          valueStart += 8;
        } else {
          length = this.view.getUint16(valueStart + 2, this.littleEndian);
          valueStart += 4;
        }
      } else {
        length = this.view.getUint32(valueStart, this.littleEndian);
        valueStart += 4;
        vr = KNOWN_SEQUENCES.has(key) ? 'SQ' : 'UN';
      }

      if (key === T.PixelData) {
        this.pixelDataOffset = valueStart;
        this.pixelDataLength = length;
        this.done = true;
        return valueStart;
      }

      if (vr === 'SQ' || length === UNDEFINED_LENGTH) {
        pos = this.walkSequence(valueStart, end, depth + 1, length);
        continue;
      }

      if (!this.elements.has(key)) {
        this.elements.set(key, { vr, offset: valueStart, length });
      }
      pos = valueStart + length + (length % 2); // values are even-padded
    }
    return Math.min(pos, end);
  }

  /** Reads the items of a sequence. Returns the position just past it. */
  private walkSequence(start: number, end: number, depth: number, seqLength: number): number {
    if (depth > MAX_DEPTH) {
      this.done = true;
      return end;
    }
    if (seqLength !== UNDEFINED_LENGTH) {
      const seqEnd = Math.min(start + seqLength, end);
      this.walkItems(start, seqEnd, depth);
      return start + seqLength;
    }
    return this.walkItems(start, end, depth);
  }

  /** Reads consecutive items. Returns the position past the sequence delimiter. */
  private walkItems(start: number, end: number, depth: number): number {
    let pos = start;
    while (!this.done && pos + 8 <= end) {
      const key = this.tagAt(pos);
      if (key === SEQ_DELIM) return pos + 8;
      if (key !== ITEM) return pos; // malformed; let the caller recover

      const itemLength = this.view.getUint32(pos + 4, this.littleEndian);
      pos += 8;

      if (itemLength === UNDEFINED_LENGTH) {
        pos = this.walkElements(pos, end, depth);
        if (pos + 8 <= end && this.tagAt(pos) === ITEM_DELIM) pos += 8;
      } else {
        const itemEnd = Math.min(pos + itemLength, end);
        this.walkElements(pos, itemEnd, depth);
        pos = itemEnd;
      }
    }
    return Math.min(pos, end);
  }

  string(key: number): string | undefined {
    const el = this.elements.get(key);
    if (!el) return undefined;
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + el.offset, el.length);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s.replace(/\0+$/, '').trim();
  }

  /** Reads a numeric value, honouring the binary VRs as well as decimal strings. */
  number(key: number): number | undefined {
    const el = this.elements.get(key);
    if (!el) return undefined;
    switch (el.vr) {
      case 'US':
        return this.view.getUint16(el.offset, this.littleEndian);
      case 'SS':
        return this.view.getInt16(el.offset, this.littleEndian);
      case 'UL':
        return this.view.getUint32(el.offset, this.littleEndian);
      case 'SL':
        return this.view.getInt32(el.offset, this.littleEndian);
      case 'FL':
        return this.view.getFloat32(el.offset, this.littleEndian);
      case 'FD':
        return this.view.getFloat64(el.offset, this.littleEndian);
      default: {
        const s = this.string(key);
        if (s === undefined) return undefined;
        const n = parseFloat(s.split('\\')[0]);
        return Number.isFinite(n) ? n : undefined;
      }
    }
  }

  /** Reads a backslash-delimited multi-valued decimal string. */
  numbers(key: number): number[] | undefined {
    const s = this.string(key);
    if (s === undefined) return undefined;
    const parts = s.split('\\').map((p) => parseFloat(p));
    return parts.every((n) => Number.isFinite(n)) ? parts : undefined;
  }
}

export function isDicom(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 132) return false;
  const b = new Uint8Array(buffer, 128, 4);
  return b[0] === 0x44 && b[1] === 0x49 && b[2] === 0x43 && b[3] === 0x4d; // "DICM"
}

export interface ParseOptions {
  /** Volumes with more voxels than this are downsampled to stay within GPU limits. */
  maxVoxels?: number;
  onProgress?: (fraction: number, message: string) => void;
}

export function parseDicomVolume(buffer: ArrayBuffer, options: ParseOptions = {}): VolumeData {
  const { maxVoxels = 300_000_000, onProgress } = options;

  if (!isDicom(buffer)) {
    throw new UserFacingError('Not a DICOM file (missing DICM marker).');
  }

  const view = new DataView(buffer);
  onProgress?.(0.05, 'Reading DICOM header');

  // The file meta group is always explicit VR little endian.
  const meta = new Parser(view, true, true);
  meta.walk(132, Math.min(buffer.byteLength, 132 + 4096));
  const transferSyntax = meta.string(T.TransferSyntaxUID) ?? '1.2.840.10008.1.2.1';

  const syntax = UNCOMPRESSED_TS[transferSyntax];
  if (!syntax) {
    throw new UserFacingError(
      `This DICOM uses a compressed transfer syntax (${transferSyntax}) which this viewer cannot decode. ` +
        'Convert it to uncompressed (Explicit VR Little Endian) and try again.',
    );
  }

  // The dataset starts after the meta group; find where by re-walking the meta
  // group and taking the end of its last element.
  const metaEnd = findDatasetStart(view, buffer.byteLength);

  const ds = new Parser(view, syntax.explicitVR, syntax.littleEndian);
  ds.walk(metaEnd, buffer.byteLength);

  if (ds.pixelDataOffset < 0) throw new UserFacingError('DICOM file contains no pixel data.');
  if (ds.pixelDataLength === UNDEFINED_LENGTH) {
    throw new UserFacingError('DICOM pixel data is encapsulated (compressed), which this viewer cannot decode.');
  }

  const width = ds.number(T.Columns) ?? 0;
  const height = ds.number(T.Rows) ?? 0;
  const depth = ds.number(T.NumberOfFrames) ?? 1;
  const bitsAllocated = ds.number(T.BitsAllocated) ?? 16;
  const signed = (ds.number(T.PixelRepresentation) ?? 0) === 1;
  const slope = ds.number(T.RescaleSlope) ?? 1;
  const intercept = ds.number(T.RescaleIntercept) ?? 0;

  if (!width || !height) throw new UserFacingError('DICOM file is missing image dimensions.');
  if (depth < 2) {
    throw new UserFacingError(
      'This DICOM holds a single 2D slice, so there is no volume to render in 3D. ' +
        'Load a multi-frame study instead.',
    );
  }
  if (bitsAllocated !== 8 && bitsAllocated !== 16) {
    throw new UserFacingError(`Unsupported DICOM bit depth (${bitsAllocated} bits per sample).`);
  }

  const pixelSpacing = ds.numbers(T.PixelSpacing);
  const sliceSpacing = ds.number(T.SpacingBetweenSlices) ?? ds.number(T.SliceThickness) ?? 1;
  // PixelSpacing is stored as [row spacing, column spacing] = [y, x].
  const spacing: [number, number, number] = [
    pixelSpacing?.[1] ?? 1,
    pixelSpacing?.[0] ?? 1,
    sliceSpacing,
  ];

  onProgress?.(0.2, 'Reading voxels');

  const voxelCount = width * height * depth;
  const bytesPerVoxel = bitsAllocated / 8;
  const available = Math.min(ds.pixelDataLength, buffer.byteLength - ds.pixelDataOffset);
  if (available < voxelCount * bytesPerVoxel) {
    throw new UserFacingError('DICOM pixel data is truncated.');
  }

  // Choose a stride that keeps the 3D texture within budget.
  let stride = 1;
  while (
    Math.ceil(width / stride) * Math.ceil(height / stride) * Math.ceil(depth / stride) >
    maxVoxels
  ) {
    stride++;
  }

  const raw = readScalars(
    view,
    ds.pixelDataOffset,
    voxelCount,
    bitsAllocated,
    signed,
    syntax.littleEndian,
  );

  onProgress?.(0.6, 'Measuring intensity range');

  const stats = analyseIntensities(raw);
  const { low: min, high: max } = stats;

  onProgress?.(0.75, 'Building 3D texture');

  const outW = Math.ceil(width / stride);
  const outH = Math.ceil(height / stride);
  const outD = Math.ceil(depth / stride);
  const data = new Uint8Array(outW * outH * outD);
  const scale = 255 / (max - min);

  // Values outside the robust range are clamped rather than allowed to stretch
  // the scale; metal artefacts otherwise crush all real anatomy into a few codes.
  let o = 0;
  for (let z = 0; z < outD; z++) {
    const sz = Math.min(z * stride, depth - 1) * width * height;
    for (let y = 0; y < outH; y++) {
      const sy = sz + Math.min(y * stride, height - 1) * width;
      for (let x = 0; x < outW; x++) {
        const v = (raw[sy + (stride === 1 ? x : Math.min(x * stride, width - 1))] - min) * scale;
        data[o++] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }

  onProgress?.(1, 'Done');

  const descriptionParts = [
    ds.string(T.Manufacturer),
    ds.string(T.ModelName),
    ds.string(T.SeriesDescription),
  ].filter((s): s is string => !!s && s.length > 0);

  return {
    data,
    width: outW,
    height: outH,
    depth: outD,
    spacing: [spacing[0] * stride, spacing[1] * stride, spacing[2] * stride],
    rangeLow: min * slope + intercept,
    rangeHigh: max * slope + intercept,
    suggestedIso: stats.suggestedIso,
    suggestedWindow: stats.suggestedWindow,
    modality: ds.string(T.Modality) ?? 'Unknown',
    description: descriptionParts.join(' · '),
  };
}

interface Intensities {
  /** Robust lower bound of the mapped range, in stored units. */
  low: number;
  /** Robust upper bound of the mapped range, in stored units. */
  high: number;
  /** Suggested opaque-surface threshold, normalized to 0..1. */
  suggestedIso: number;
  /** Suggested display window, normalized to 0..1. */
  suggestedWindow: [number, number];
}

/**
 * Derives a display range from the value distribution rather than the absolute
 * extremes. Medical volumes routinely contain a thin tail of metal-artefact
 * voxels thousands of units above real tissue; scaling to those makes the whole
 * study render nearly black.
 */
function analyseIntensities(raw: ArrayLike<number>): Intensities {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    return { low: 0, high: 1, suggestedIso: 0.5, suggestedWindow: [0, 1] };
  }

  const BINS = 16384;
  const hist = new Uint32Array(BINS);
  const toBin = (BINS - 1) / (max - min);
  for (let i = 0; i < raw.length; i++) {
    hist[((raw[i] - min) * toBin) | 0]++;
  }

  const total = raw.length;
  const binValue = (b: number) => min + (b + 0.5) / toBin;
  const percentile = (p: number): number => {
    const target = total * p;
    let acc = 0;
    for (let b = 0; b < BINS; b++) {
      acc += hist[b];
      if (acc >= target) return binValue(b);
    }
    return max;
  };

  let low = percentile(0.001);
  let high = percentile(0.999);
  if (high - low < (max - min) * 1e-4) {
    low = min;
    high = max;
  }

  const norm = (v: number) => Math.min(1, Math.max(0, (v - low) / (high - low)));

  return {
    low,
    high,
    // Dense tissue sits in the upper tail of the distribution; these percentiles
    // land on bone for CT/CBCT rather than on the surrounding soft tissue, which
    // would otherwise fog the whole render.
    suggestedIso: Math.min(0.9, Math.max(0.08, norm(percentile(0.955)))),
    suggestedWindow: [norm(percentile(0.92)), norm(percentile(0.999))],
  };
}

/** Re-reads the file meta group to locate the first byte of the main dataset. */
function findDatasetStart(view: DataView, byteLength: number): number {
  let pos = 132;
  const limit = Math.min(byteLength, 132 + 65536);
  while (pos + 8 <= limit) {
    const group = view.getUint16(pos, true);
    if (group !== 0x0002) break;
    const vr = String.fromCharCode(view.getUint8(pos + 4), view.getUint8(pos + 5));
    let length: number;
    if (EXPLICIT_LONG_VR.has(vr)) {
      length = view.getUint32(pos + 8, true);
      pos += 12;
    } else {
      length = view.getUint16(pos + 6, true);
      pos += 8;
    }
    pos += length;
  }
  return pos;
}

function readScalars(
  view: DataView,
  offset: number,
  count: number,
  bitsAllocated: number,
  signed: boolean,
  littleEndian: boolean,
): ArrayLike<number> {
  const base = view.byteOffset + offset;
  if (bitsAllocated === 8) {
    return signed
      ? new Int8Array(view.buffer, base, count)
      : new Uint8Array(view.buffer, base, count);
  }

  // Typed-array views require natural alignment and match host endianness, so
  // fall back to a manual copy when either assumption breaks.
  const aligned = base % 2 === 0;
  if (aligned && littleEndian && isLittleEndianHost()) {
    return signed
      ? new Int16Array(view.buffer, base, count)
      : new Uint16Array(view.buffer, base, count);
  }

  const out = signed ? new Int16Array(count) : new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = signed
      ? view.getInt16(offset + i * 2, littleEndian)
      : view.getUint16(offset + i * 2, littleEndian);
  }
  return out;
}

let littleEndianHost: boolean | undefined;
function isLittleEndianHost(): boolean {
  if (littleEndianHost === undefined) {
    littleEndianHost = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  }
  return littleEndianHost;
}
