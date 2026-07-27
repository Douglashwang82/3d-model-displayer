import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { volumeFragmentShader, volumeVertexShader } from './volumeShader';
import type {
  MeshPayload,
  MeshSettings,
  ModelPayload,
  VolumePayload,
  VolumeSettings,
} from './types';

const COLORMAP_INDEX = { grayscale: 0, bone: 1, hot: 2 } as const;
const MODE_INDEX = { mip: 0, iso: 1, composite: 2 } as const;

/**
 * Owns the three.js scene and swaps between a triangle-mesh view (PLY/STL) and
 * a GPU ray-marched volume view (DICOM). Rendering is on demand: frames are
 * produced only while the camera is moving or after a settings change, which
 * matters because a full-quality volume pass is expensive.
 */
export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private resizeObserver: ResizeObserver;
  private frameHandle = 0;
  private needsRender = true;
  private interacting = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  private content: THREE.Object3D | null = null;
  private volumeMaterial: THREE.ShaderMaterial | null = null;
  private volumeTexture: THREE.Data3DTexture | null = null;
  private meshMaterial: THREE.MeshStandardMaterial | null = null;
  private mesh: THREE.Mesh | null = null;
  private points: THREE.Points | null = null;
  private geometry: THREE.BufferGeometry | null = null;

  /** Radius of the current model, used for camera framing and grid scale. */
  private modelRadius = 1;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x0d1117, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
    this.camera.position.set(0, 0, 5);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.zoomSpeed = 1.1;
    this.controls.rotateSpeed = 0.9;
    this.controls.panSpeed = 0.9;
    this.controls.addEventListener('start', () => {
      this.interacting = true;
      this.requestRender();
    });
    this.controls.addEventListener('end', () => {
      this.interacting = false;
      // Re-render once at full quality after the camera settles.
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.requestRender(), 90);
    });

    this.setupLights();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    const loop = () => {
      if (this.disposed) return;
      this.frameHandle = requestAnimationFrame(loop);
      const moved = this.controls.update();
      if (moved || this.needsRender) {
        this.needsRender = false;
        this.renderFrame();
      }
    };
    this.frameHandle = requestAnimationFrame(loop);
  }

  private setupLights(): void {
    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x2a2f3a, 1.5);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(1, 1.4, 1);
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x93b8ff, 0.9);
    fill.position.set(-1, -0.4, -0.8);
    this.scene.add(fill);
  }

  requestRender(): void {
    this.needsRender = true;
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  private renderFrame(): void {
    if (this.volumeMaterial && this.content) {
      const u = this.volumeMaterial.uniforms;
      // The shader needs the eye position in the volume box's own space.
      this.content.updateMatrixWorld();
      const local = this.camera.position.clone();
      this.content.worldToLocal(local);
      u.uCameraLocal.value.copy(local);
      // Trade sampling density for responsiveness while the user drags.
      u.uStepScale.value = this.interacting
        ? this.volumeQualityScale * 2.5
        : this.volumeQualityScale;
    }
    this.renderer.render(this.scene, this.camera);
  }

  private volumeQualityScale = 1;

  /** Removes and frees whatever model is currently displayed. */
  private clearContent(): void {
    if (this.content) {
      this.scene.remove(this.content);
      this.content = null;
    }
    this.geometry?.dispose();
    this.geometry = null;
    this.meshMaterial?.dispose();
    this.meshMaterial = null;
    this.volumeMaterial?.dispose();
    this.volumeMaterial = null;
    this.volumeTexture?.dispose();
    this.volumeTexture = null;
    this.mesh = null;
    this.points = null;
  }

  load(payload: ModelPayload): void {
    this.clearContent();
    if (payload.kind === 'mesh') this.loadMesh(payload);
    else this.loadVolume(payload);
    this.requestRender();
  }

  private loadMesh(payload: MeshPayload): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(payload.position, 3));
    if (payload.index) geometry.setIndex(new THREE.BufferAttribute(payload.index, 1));
    if (payload.color) geometry.setAttribute('color', new THREE.BufferAttribute(payload.color, 3));
    if (payload.uv) geometry.setAttribute('uv', new THREE.BufferAttribute(payload.uv, 2));
    if (payload.normal) {
      geometry.setAttribute('normal', new THREE.BufferAttribute(payload.normal, 3));
    } else {
      geometry.computeVertexNormals();
    }

    // Centre on the origin so orbiting feels anchored to the model.
    geometry.computeBoundingBox();
    const centre = new THREE.Vector3();
    geometry.boundingBox!.getCenter(centre);
    geometry.translate(-centre.x, -centre.y, -centre.z);
    geometry.computeBoundingSphere();
    // Degenerate geometry can yield a zero or NaN radius, which would put the
    // camera at an invalid distance.
    const radius = geometry.boundingSphere?.radius ?? 0;
    this.modelRadius = Number.isFinite(radius) && radius > 0 ? radius : 1;

    const material = new THREE.MeshStandardMaterial({
      color: payload.hasVertexColors ? 0xffffff : 0xc7ccd6,
      vertexColors: payload.hasVertexColors,
      roughness: 0.55,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    const group = new THREE.Group();
    group.add(mesh);

    this.geometry = geometry;
    this.meshMaterial = material;
    this.mesh = mesh;
    this.content = group;
    this.scene.add(group);
    this.frameCamera();
  }

  private loadVolume(payload: VolumePayload): void {
    const { data, width, height, depth, spacing } = payload;

    const texture = new THREE.Data3DTexture(data, width, height, depth);
    texture.format = THREE.RedFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.wrapR = THREE.ClampToEdgeWrapping;
    // Row length is rarely a multiple of 4, so byte-align the upload.
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;

    const size = new THREE.Vector3(width * spacing[0], height * spacing[1], depth * spacing[2]);

    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: volumeVertexShader,
      fragmentShader: volumeFragmentShader,
      transparent: true,
      depthWrite: false,
      side: THREE.BackSide,
      uniforms: {
        uVolume: { value: texture },
        uSize: { value: size },
        uVoxelStep: { value: new THREE.Vector3(1 / width, 1 / height, 1 / depth) },
        uCameraLocal: { value: new THREE.Vector3() },
        uClipMin: { value: new THREE.Vector3(0, 0, 0) },
        uClipMax: { value: new THREE.Vector3(1, 1, 1) },
        uWindow: { value: new THREE.Vector2(payload.suggestedWindow[0], payload.suggestedWindow[1]) },
        uIso: { value: payload.suggestedIso },
        uStepScale: { value: 1 },
        uDensity: { value: 1.6 },
        uMode: { value: MODE_INDEX.iso },
        uColormap: { value: COLORMAP_INDEX.bone },
      },
    });

    const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    const box = new THREE.Mesh(geometry, material);

    const group = new THREE.Group();
    group.add(box);
    // DICOM stores axes as patient left / posterior / superior. Rotating -90°
    // about X maps superior onto screen-up and puts the viewer anterior of the
    // patient, which is the conventional orientation.
    group.rotation.x = -Math.PI / 2;

    this.geometry = geometry;
    this.volumeTexture = texture;
    this.volumeMaterial = material;
    this.mesh = box;
    this.content = group;
    this.modelRadius = size.length() / 2;
    this.scene.add(group);
    this.frameCamera();
  }

  /** Places the camera so the whole model fits with a small margin. */
  frameCamera(): void {
    const radius = this.modelRadius || 1;
    const fov = (this.camera.fov * Math.PI) / 180;
    const distance = (radius / Math.sin(fov / 2)) * 1.15;

    this.camera.near = Math.max(radius / 1000, 0.001);
    this.camera.far = distance + radius * 10;
    this.camera.updateProjectionMatrix();

    this.camera.position.set(distance * 0.45, distance * 0.35, distance * 0.82);
    this.controls.target.set(0, 0, 0);
    this.controls.minDistance = radius * 0.05;
    this.controls.maxDistance = distance * 6;
    this.controls.update();
    this.requestRender();
  }

  applyMeshSettings(settings: MeshSettings, payload: MeshPayload): void {
    if (!this.meshMaterial || !this.mesh || !this.geometry || !this.content) return;

    const material = this.meshMaterial;
    material.vertexColors = settings.useVertexColors && payload.hasVertexColors;
    material.color.set(material.vertexColors ? 0xffffff : 0xc7ccd6);
    material.flatShading = settings.flatShading;
    material.wireframe = settings.shading === 'wireframe';
    material.needsUpdate = true;

    const wantPoints = settings.shading === 'points';
    this.mesh.visible = !wantPoints;

    if (wantPoints && !this.points) {
      const pointsMaterial = new THREE.PointsMaterial({
        size: this.modelRadius * 0.004,
        vertexColors: material.vertexColors,
        color: material.vertexColors ? 0xffffff : 0xc7ccd6,
        sizeAttenuation: true,
      });
      this.points = new THREE.Points(this.geometry, pointsMaterial);
      this.content.add(this.points);
    }
    if (this.points) {
      this.points.visible = wantPoints;
      const pm = this.points.material as THREE.PointsMaterial;
      pm.vertexColors = material.vertexColors;
      pm.color.set(material.vertexColors ? 0xffffff : 0xc7ccd6);
      pm.needsUpdate = true;
    }

    this.requestRender();
  }

  applyVolumeSettings(settings: VolumeSettings): void {
    const material = this.volumeMaterial;
    if (!material) return;
    const u = material.uniforms;
    u.uMode.value = MODE_INDEX[settings.mode];
    u.uColormap.value = COLORMAP_INDEX[settings.colormap];
    u.uWindow.value.set(settings.windowLow, settings.windowHigh);
    u.uIso.value = settings.iso;
    u.uClipMin.value.set(...settings.clipMin);
    u.uClipMax.value.set(...settings.clipMax);
    // Higher quality means smaller steps.
    this.volumeQualityScale = 1 / settings.quality;
    u.uStepScale.value = this.volumeQualityScale;
    this.requestRender();
  }

  /** Renders the current view to a PNG data URL. */
  snapshot(): string {
    this.renderFrame();
    return this.renderer.domElement.toDataURL('image/png');
  }

  get domElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    clearTimeout(this.idleTimer);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.clearContent();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
