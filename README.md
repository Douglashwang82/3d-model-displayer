# 3D Model Viewer

A browser-based viewer for 3D model files and medical volumes. Drop in a file and
orbit, zoom, and crop it. Everything runs locally in the browser — nothing is
uploaded to a server.

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## Supported formats

| Format | Notes |
| --- | --- |
| **PLY** | ASCII and binary, including per-vertex colours |
| **STL** | ASCII and binary |
| **OBJ** | Geometry only; sub-objects are merged |
| **DICOM** | Uncompressed multi-frame volumes (CT/CBCT/MR) |

DICOM files that use a compressed transfer syntax (JPEG, JPEG 2000, RLE) are
rejected with an explanatory message rather than rendered incorrectly.

Meshes can be exported again as PLY, STL, OBJ or GLB.

## Controls

- **Drag** to orbit, **scroll** to zoom, **right-drag** to pan
- **Expand** fills the window; if the browser blocks the Fullscreen API the
  viewer falls back to hiding the sidebar (press `Esc` to restore)
- **Save image** downloads the current view as a PNG

Meshes can be displayed solid, as a wireframe, or as a point cloud, with
vertex colours and flat shading toggles.

Volumes offer three rendering modes:

- **Surface** — an isosurface at a chosen density threshold, lit with
  gradient-derived normals. This is the default and is usually the clearest
  view of bone or other dense structure.
- **Volumetric** — front-to-back alpha compositing, which shows soft tissue
  and dense tissue together.
- **Max intensity** — a maximum-intensity projection, similar to an X-ray.

Window/level, isosurface threshold, colour ramp, per-axis cropping, and sampling
quality are all adjustable. Thresholds are reported in Hounsfield units for CT.

## Mesh filters

Loaded meshes can be edited in place. Every filter runs locally in a Web Worker;
nothing is uploaded.

| Filter | What it does |
| --- | --- |
| **Merge close vertices** | Joins vertices sharing a position, within a tolerance |
| **Remove defects** | Drops zero-area and duplicate triangles, and unreferenced vertices |
| **Remove small pieces** | Deletes disconnected fragments below a share of the model |
| **Recompute normals** | Rebuilds vertex normals, area-weighted |
| **Close holes** | Patches open boundary loops up to a size limit |
| **Laplacian smooth** | Umbrella-operator smoothing; shrinks as iterations rise |
| **Taubin smooth** | λ\|μ smoothing, which denoises without deflating the model |
| **Simplify** | Quadric edge-collapse decimation to a triangle or error target |
| **Convex hull** | Smallest convex solid containing every vertex |
| **Boolean** | Union, difference or intersection against a second mesh file |

Each run reports what it changed — vertex and triangle counts, holes filled,
measured deviation from the original surface — and the last five states are kept
for **Undo**, with **Revert to file** always returning to the mesh as loaded.

### Why not MeshLab itself

[MeshLab](https://www.meshlab.net/) is the obvious reference for this feature
set, but it cannot be embedded here. It is a C++/Qt desktop application under
GPL-3.0, and its browser port, [MeshLabJS], was last touched in 2022 and targets
a pre-WebAssembly Emscripten toolchain. Its Python binding, PyMeshLab, is
maintained but needs a server — which would mean uploading the very medical
volumes this viewer is careful to keep local, and every option in that family
carries GPL or AGPL copyleft.

So the filters above are equivalents rather than MeshLab code, built on
permissively licensed pieces: [meshoptimizer] (MIT) for decimation,
[Manifold] (Apache-2.0) for CSG, and three.js for hull construction and export.
The cleaning, smoothing and hole-filling passes are implemented directly in
`src/lib/filters/`.

[MeshLabJS]: https://github.com/cnr-isti-vclab/meshlabjs
[meshoptimizer]: https://github.com/zeux/meshoptimizer
[Manifold]: https://github.com/elalish/manifold

## How it works

Parsing happens in a Web Worker (`src/workers/model.worker.ts`) so that large
files do not block the UI, and the resulting typed arrays are transferred rather
than copied.

Meshes are loaded with three.js's stock `PLYLoader`, `STLLoader`, and
`OBJLoader`, then rendered with a standard material.

Filters run in a second worker (`src/workers/filter.worker.ts`) and work on an
always-indexed form of the mesh, since topology — which vertices share a corner,
which edges have only one face — is what most of them read. STL stores every
triangle separately and PLY files are often exported the same way, so a filter
that needs topology welds the mesh first and says so in its report; without that
step, smoothing and hole detection would find nothing to do and silently leave
the model alone.

The geometry handed to three.js wraps the payload's typed arrays rather than
copying them, so the viewer must not modify them in place. Centring the model
for orbiting is therefore done by offsetting the containing group, not by
translating the geometry — otherwise every load would quietly rewrite the
coordinates that the filters and the exporters read back.

Volumes take a different path. `src/lib/dicom.ts` is a small DICOM reader that
walks the dataset — descending into sequences, since enhanced multi-frame
objects store voxel spacing inside the shared functional groups — and turns the
pixel data into a single normalized scalar field.

Two details there are worth knowing about:

- **Intensity is normalized against percentiles, not the absolute range.**
  Medical scans routinely contain a thin tail of metal-artefact voxels
  (dental work, implants) thousands of units above real tissue. Scaling to the
  true maximum crushes all the anatomy into a handful of codes and renders
  nearly black, so the 0.1st–99.9th percentile range is used instead and
  outliers are clamped.
- **Voxels are stored as 8-bit.** This halves texture memory versus 16-bit and,
  unlike an integer texture, supports hardware linear filtering, which the ray
  marcher depends on for smooth gradients.

The volume itself is drawn by `src/lib/volumeShader.ts`, a single-pass ray
marcher. A box is rendered back-face-first so each fragment gives the ray's exit
point; the entry point comes from a slab intersection against the cropped unit
cube. Sampling steps are jittered to trade banding for noise, and the step size
coarsens while the camera is moving so interaction stays responsive.

Rendering is on demand — frames are only produced while the camera is moving or
after a settings change — because a full-quality volume pass is expensive.

## Sample files

In development, any PLY/STL/OBJ/DICOM files in `./data` are listed in the
sidebar as one-click samples. This is dev-only and is not part of a production
build.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Type-check and build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | Type-check only |

## Requirements

A browser with WebGL 2 (needed for 3D textures). Volume rendering is
GPU-intensive; the 401³ sample allocates roughly 64 MB of texture memory.
Volumes larger than about 300 million voxels are automatically downsampled.
