/**
 * Single-pass volume ray marcher.
 *
 * The volume is drawn as a box whose back faces give each ray its exit point;
 * the entry point comes from a slab intersection against the (optionally
 * cropped) unit cube. Everything downstream works in normalized 0..1 texture
 * space so non-cubic voxel spacing only affects the box dimensions.
 */

export const volumeVertexShader = /* glsl */ `
out vec3 vLocalPos;

void main() {
  vLocalPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const volumeFragmentShader = /* glsl */ `
precision highp float;
precision highp sampler3D;

in vec3 vLocalPos;
out vec4 fragColor;

uniform sampler3D uVolume;
uniform vec3 uSize;        // physical box dimensions
uniform vec3 uVoxelStep;   // 1 / voxel counts, in normalized space
uniform vec3 uCameraLocal; // camera position in the box's local space
uniform vec3 uClipMin;
uniform vec3 uClipMax;
uniform vec2 uWindow;      // low / high, normalized intensity
uniform float uIso;
uniform float uStepScale;  // >1 marches coarser, for interaction
uniform float uDensity;
uniform int uMode;         // 0 = MIP, 1 = isosurface, 2 = composite
uniform int uColormap;     // 0 = grayscale, 1 = bone, 2 = hot

const int MAX_STEPS = 1024;

bool intersectBox(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax, out float t0, out float t1) {
  // Guard against exact zeros so axis-aligned rays don't produce NaNs.
  vec3 safeRd = mix(rd, vec3(1e-6), lessThan(abs(rd), vec3(1e-6)));
  vec3 invD = 1.0 / safeRd;
  vec3 ta = (bmin - ro) * invD;
  vec3 tb = (bmax - ro) * invD;
  vec3 tsmall = min(ta, tb);
  vec3 tbig = max(ta, tb);
  t0 = max(max(tsmall.x, tsmall.y), tsmall.z);
  t1 = min(min(tbig.x, tbig.y), tbig.z);
  return t1 > max(t0, 0.0);
}

float sampleVolume(vec3 p) {
  return texture(uVolume, p).r;
}

float applyWindow(float v) {
  return clamp((v - uWindow.x) / max(uWindow.y - uWindow.x, 1e-5), 0.0, 1.0);
}

vec3 shade(float t) {
  if (uColormap == 1) {
    // Warm bone ramp: dark blue-grey shadows into cream highlights.
    vec3 lo = vec3(0.03, 0.04, 0.07);
    vec3 mid = vec3(0.55, 0.44, 0.34);
    vec3 hi = vec3(1.0, 0.97, 0.91);
    return t < 0.5 ? mix(lo, mid, t * 2.0) : mix(mid, hi, (t - 0.5) * 2.0);
  }
  if (uColormap == 2) {
    // Black-body style ramp.
    return clamp(vec3(t * 2.2, t * t * 1.7, t * t * t * 1.8), 0.0, 1.0);
  }
  return vec3(t);
}

vec3 gradient(vec3 p) {
  vec3 h = uVoxelStep;
  return vec3(
    sampleVolume(p + vec3(h.x, 0.0, 0.0)) - sampleVolume(p - vec3(h.x, 0.0, 0.0)),
    sampleVolume(p + vec3(0.0, h.y, 0.0)) - sampleVolume(p - vec3(0.0, h.y, 0.0)),
    sampleVolume(p + vec3(0.0, 0.0, h.z)) - sampleVolume(p - vec3(0.0, 0.0, h.z))
  );
}

vec3 lightSurface(vec3 p, vec3 rd, vec3 albedo) {
  vec3 g = gradient(p);
  float gl = length(g);
  // Flat regions carry no reliable normal; fall back to facing the viewer.
  vec3 n = gl > 1e-5 ? normalize(-g) : -rd;
  vec3 l = normalize(-rd + vec3(0.35, 0.55, 0.2));
  float diff = max(dot(n, l), 0.0);
  vec3 h = normalize(l - rd);
  float spec = pow(max(dot(n, h), 0.0), 32.0) * 0.35;
  float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0) * 0.18;
  return albedo * (0.22 + 0.78 * diff) + vec3(spec + rim);
}

void main() {
  vec3 origin = uCameraLocal / uSize + 0.5;
  vec3 exitPoint = vLocalPos / uSize + 0.5;
  vec3 rd = normalize(exitPoint - origin);

  float t0, t1;
  if (!intersectBox(origin, rd, uClipMin, uClipMax, t0, t1)) discard;
  t0 = max(t0, 0.0);

  float span = t1 - t0;
  if (span <= 0.0) discard;

  float baseStep = min(min(uVoxelStep.x, uVoxelStep.y), uVoxelStep.z) * uStepScale;
  int steps = int(min(float(MAX_STEPS), ceil(span / max(baseStep, 1e-5))));
  float dt = span / float(steps);

  // Dither the entry point to trade banding for a little noise.
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float t = t0 + dt * jitter;

  if (uMode == 0) {
    float maxVal = 0.0;
    for (int i = 0; i < MAX_STEPS; i++) {
      if (i >= steps) break;
      maxVal = max(maxVal, sampleVolume(origin + rd * t));
      t += dt;
    }
    float v = applyWindow(maxVal);
    if (v <= 0.001) discard;
    fragColor = vec4(shade(v), v);
    return;
  }

  if (uMode == 1) {
    float prev = sampleVolume(origin + rd * t);
    for (int i = 0; i < MAX_STEPS; i++) {
      if (i >= steps) break;
      float tn = t + dt;
      float cur = sampleVolume(origin + rd * tn);
      if (cur >= uIso && prev < uIso) {
        // Refine the crossing so the surface doesn't show stair steps.
        float a = t;
        float b = tn;
        for (int k = 0; k < 5; k++) {
          float m = (a + b) * 0.5;
          if (sampleVolume(origin + rd * m) >= uIso) b = m; else a = m;
        }
        vec3 hit = origin + rd * b;
        vec3 albedo = shade(clamp(applyWindow(uIso) * 0.55 + 0.45, 0.0, 1.0));
        fragColor = vec4(lightSurface(hit, rd, albedo), 1.0);
        return;
      }
      prev = cur;
      t = tn;
    }
    discard;
  }

  // Composite: front-to-back accumulation.
  vec3 acc = vec3(0.0);
  float alpha = 0.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= steps || alpha >= 0.99) break;
    vec3 p = origin + rd * t;
    float v = applyWindow(sampleVolume(p));
    if (v > 0.002) {
      // Opacity is corrected for step size so quality changes don't alter density.
      float a = 1.0 - pow(1.0 - clamp(v * v * uDensity, 0.0, 1.0), dt * 400.0);
      vec3 col = lightSurface(p, rd, shade(v));
      acc += (1.0 - alpha) * a * col;
      alpha += (1.0 - alpha) * a;
    }
    t += dt;
  }
  if (alpha <= 0.001) discard;
  fragColor = vec4(acc / max(alpha, 1e-4), alpha);
}
`;
