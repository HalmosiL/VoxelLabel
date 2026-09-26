import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { fetchAirways, fetchLungMask, fetchVolume3D } from "../api/annotatorApi";
import { errorText } from "../lib/errorText";
import { enterFullscreen, exitFullscreen, fullscreenElement, onFullscreenChange } from "../lib/fullscreen";
import { fillLungHoles, FlyKeys, flyStep, labelPalette, objectBounds, pickAlongRay, shrinkMask, softMask, Vec3, VolumeInfo, windowToUnit } from "../lib/volumeRender";

/** A real 3D view of the CT itself, with the annotation inside it: the
 * volume is ray-marched on the GPU (a 3D texture of the series, see the
 * backend's get_volume_3d), every painted object drawn in its label's
 * colour. Opacity, smoothing, window, MIP and shading are set live; the
 * camera flies like a game character -- click the view, then the mouse
 * looks, WASD moves, Space goes up, Shift down, Esc lets go -- right into
 * the volume if you like, or orbits it. Nothing here changes the
 * annotation. */

type Mode = "volume" | "mip";
type Nav = "fly" | "orbit";

const PRESETS: { name: string; center: number; width: number }[] = [
  { name: "Lung", center: -600, width: 1500 },
  { name: "Soft tissue", center: 40, width: 400 },
  { name: "Bone", center: 400, width: 1800 },
  { name: "Skin", center: -300, width: 800 },
];
/** Vessels and nodules inside the lungs: soft tissue bright, the lung
 * itself faint -- with "Only inside the lungs" on, or the chest wall
 * (the same density) would hide it all. */
const VESSELS = { center: -350, width: 900 };
const AIRWAY_COLOR = "#a78bfa";
// the 2D panes' own colours (ViewerPage's PLANE_COLORS)
const PLANE_COLOR = { sagittal: "#f59e0b", coronal: "#22c55e", axial: "#38bdf8" };

const VERTEX = /* glsl */ `
out vec3 vLocal;
void main() {
  vLocal = position + 0.5; // the unit box, 0..1 like the texture
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
precision highp float;
precision highp sampler3D;
in vec3 vLocal;
out highp vec4 fragColor;
uniform sampler3D uVolume;
uniform sampler3D uMask;
uniform sampler3D uLung;
uniform bool uLungOnly;
uniform float uNearCut;
uniform sampler3D uAirway;
uniform bool uShowAirway;
uniform vec3 uAirwayColor;
uniform float uAirwayOpacity;
uniform vec3 uPick;
uniform bool uShowPick;
uniform vec3 uAspect;
uniform vec3 uPlanes;
uniform bool uShowPlanes;
uniform vec3 uPlaneX;
uniform vec3 uPlaneY;
uniform vec3 uPlaneZ;
uniform sampler2D uPalette;
uniform vec3 uCamLocal;
uniform vec3 uTexel;
uniform vec2 uWindow;
uniform float uOpacity;
uniform float uMaskOpacity;
uniform float uSmooth;
uniform float uSteps;
uniform int uMode;
uniform bool uShade;
uniform bool uShowMask;

float sampleVolume(vec3 p) {
  float v = texture(uVolume, p).r;
  if (uSmooth > 0.0) {
    vec3 o = uTexel * uSmooth;
    v = (v * 2.0 + texture(uVolume, p + vec3(o.x, 0, 0)).r + texture(uVolume, p - vec3(o.x, 0, 0)).r
               + texture(uVolume, p + vec3(0, o.y, 0)).r + texture(uVolume, p - vec3(0, o.y, 0)).r
               + texture(uVolume, p + vec3(0, 0, o.z)).r + texture(uVolume, p - vec3(0, 0, o.z)).r) / 8.0;
  }
  return v;
}

float windowed(float v) {
  return clamp((v - uWindow.x) / (uWindow.y - uWindow.x), 0.0, 1.0);
}

vec2 hitBox(vec3 o, vec3 d) {
  vec3 inv = 1.0 / d;
  vec3 t0 = (vec3(0.0) - o) * inv;
  vec3 t1 = (vec3(1.0) - o) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

void main() {
  vec3 dir = normalize(vLocal - uCamLocal);
  vec2 t = hitBox(uCamLocal, dir);
  float tStart = max(max(t.x, 0.0), uNearCut); // from the camera when it is inside; minus the cut
  if (t.y <= tStart) discard;
  float dt = 1.732 / uSteps;
  vec4 acc = vec4(0.0);
  float best = 0.0;
  vec4 maskHit = vec4(0.0);
  float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * dt;
  vec3 prevSide = sign(uCamLocal + dir * (tStart + jitter - dt) - uPlanes);
  for (float s = tStart + jitter; s < t.y; s += dt) {
    vec3 p = uCamLocal + dir * s;
    float a = windowed(sampleVolume(p));
    // the 2D panes' slices: a thin sheet in the pane's colour where the ray crosses one
    if (uShowPlanes && uMode == 0) {
      vec3 side = sign(p - uPlanes);
      vec3 crossed = abs(side - prevSide) * 0.5;
      prevSide = side;
      float sheets = crossed.x + crossed.y + crossed.z;
      if (sheets > 0.0) {
        vec3 pc = (crossed.x * uPlaneX + crossed.y * uPlaneY + crossed.z * uPlaneZ) / sheets;
        // faint as a sheet, strong along its edge: where it is, not a veil over the rest
        vec3 edge = min(p, 1.0 - p) / (uTexel * 2.0);
        float nearEdge = crossed.x > 0.0 ? min(edge.y, edge.z) : crossed.y > 0.0 ? min(edge.x, edge.z) : min(edge.x, edge.y);
        float sa = nearEdge < 1.0 ? 0.85 : 0.06;
        acc.rgb += (1.0 - acc.a) * sa * pc;
        acc.a += (1.0 - acc.a) * sa;
      }
    }
    // the picked point: a small yellow ball, round in real proportions
    if (uShowPick && length((p - uPick) * uAspect) < 0.012) {
      fragColor = vec4(1.0, 0.85, 0.2, 1.0) * (1.0 - acc.a) + vec4(acc.rgb, 0.0);
      return;
    }
    // a soft edge (softMask + linear filtering): a smooth cut, not voxel steps
    if (uLungOnly) a *= smoothstep(0.35, 0.65, texture(uLung, p).r);
    vec4 lc = vec4(0.0);
    if (uShowMask) {
      float id = texture(uMask, p).r * 255.0;
      if (id > 0.5) lc = texture(uPalette, vec2((floor(id + 0.5) + 0.5) / 256.0, 0.5));
    }
    // the bronchial tree: a smooth, shaded surface where its soft field crosses the middle
    vec4 aw = vec4(0.0);
    if (uShowAirway) {
      float f = texture(uAirway, p).r;
      if (f > 0.4) {
        vec3 g = vec3(
          texture(uAirway, p + vec3(uTexel.x, 0, 0)).r - texture(uAirway, p - vec3(uTexel.x, 0, 0)).r,
          texture(uAirway, p + vec3(0, uTexel.y, 0)).r - texture(uAirway, p - vec3(0, uTexel.y, 0)).r,
          texture(uAirway, p + vec3(0, 0, uTexel.z)).r - texture(uAirway, p - vec3(0, 0, uTexel.z)).r);
        float gl = length(g);
        vec3 c = uAirwayColor;
        if (gl > 1e-4) c *= 0.3 + 0.7 * abs(dot(g / gl, dir));
        aw = vec4(c, uAirwayOpacity);
      }
    }
    if (uMode == 1) {
      best = max(best, a);
      if (lc.a > 0.0 && maskHit.a == 0.0) maskHit = vec4(lc.rgb, 1.0);
      if (aw.a > 0.0 && maskHit.a == 0.0) maskHit = vec4(aw.rgb, 1.0);
      continue;
    }
    vec3 col = vec3(a);
    float alpha = a * a * uOpacity;
    if (uShade && alpha > 0.01) {
      vec3 g = vec3(
        windowed(texture(uVolume, p + vec3(uTexel.x, 0, 0)).r) - windowed(texture(uVolume, p - vec3(uTexel.x, 0, 0)).r),
        windowed(texture(uVolume, p + vec3(0, uTexel.y, 0)).r) - windowed(texture(uVolume, p - vec3(0, uTexel.y, 0)).r),
        windowed(texture(uVolume, p + vec3(0, 0, uTexel.z)).r) - windowed(texture(uVolume, p - vec3(0, 0, uTexel.z)).r));
      float gl = length(g);
      if (gl > 1e-4) col *= 0.35 + 0.65 * abs(dot(g / gl, dir));
    }
    if (aw.a > 0.0) {
      col = aw.rgb;
      alpha = max(alpha, aw.a);
    }
    if (lc.a > 0.0) {
      col = mix(col, lc.rgb, 0.85);
      alpha = max(alpha, uMaskOpacity);
    }
    // the same look whatever the step length
    alpha = 1.0 - pow(1.0 - clamp(alpha, 0.0, 0.999), dt * 200.0);
    acc.rgb += (1.0 - acc.a) * alpha * col;
    acc.a += (1.0 - acc.a) * alpha;
    if (acc.a > 0.97) break;
  }
  if (uMode == 1) {
    vec3 c = vec3(best);
    if (maskHit.a > 0.0 && (uShowMask || uShowAirway)) c = mix(c, maskHit.rgb, uMaskOpacity);
    fragColor = vec4(c, 1.0);
  } else {
    fragColor = vec4(acc.rgb, 1.0);
  }
}
`;

interface World {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  mesh: THREE.Mesh | null;
  material: THREE.ShaderMaterial | null;
  maskTex: THREE.Data3DTexture | null;
  paletteTex: THREE.DataTexture;
  orbit: OrbitControls;
  yaw: number;
  pitch: number;
  keys: FlyKeys;
  /** something changed: draw the next frame (only then -- a ray-marched
   * frame is heavy, an idle view shouldn't keep the GPU busy) */
  dirty: boolean;
  /** a turnaround being recorded: one turn around `target` */
  turn: { start: number; duration: number; target: THREE.Vector3; offset: THREE.Vector3; done: () => void } | null;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

export default function VolumeView({
  seriesId,
  maskVolume,
  rows,
  columns,
  numSlices,
  labels,
  objects,
  maskKey,
  onPick,
  onShow2D,
  focusObjectId,
  slices,
}: {
  seriesId: string | null;
  maskVolume: Uint8Array | null;
  rows: number;
  columns: number;
  numSlices: number;
  labels: { id: number; color: string }[];
  objects: { id: number; label_id: number; hidden: boolean }[];
  /** bumped by the parent when the painting may have changed */
  maskKey: number;
  /** a click in the view: the voxel it landed on (the series' own
   * columns/rows/slices), and the object there if any */
  onPick?: (p: { x: number; y: number; z: number; objectId: number | null }) => void;
  /** shown next to a pick while the 3D pane fills the screen */
  onShow2D?: () => void;
  /** the selected object (in review: the one on the card) -- "Go to object" */
  focusObjectId?: number | null;
  /** where the 2D panes are (the series' own column, row, slice) */
  slices?: { x: number | null; y: number | null; z: number };
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "nowebgl">("loading");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<VolumeInfo | null>(null);

  const [mode, setMode] = useState<Mode>("volume");
  const [nav, setNav] = useState<Nav>("fly");
  const [center, setCenter] = useState(-600);
  const [width, setWidth] = useState(1500);
  const [opacity, setOpacity] = useState(0.25);
  const [smooth, setSmooth] = useState(0.5);
  const [shade, setShade] = useState(true);
  const [showMask, setShowMask] = useState(true);
  const [maskOpacity, setMaskOpacity] = useState(0.8);
  const [quality, setQuality] = useState(1);
  const [speed, setSpeed] = useState(0.4);
  const [locked, setLocked] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showPanel, setShowPanel] = useState(true);
  const [lungOnly, setLungOnly] = useState(false);
  const [lungState, setLungState] = useState<"none" | "loading" | "ready" | "error">("none");
  const [nearCut, setNearCut] = useState(0);
  const [showAirways, setShowAirways] = useState(false);
  const [airwayState, setAirwayState] = useState<"none" | "loading" | "ready" | "notfound" | "error">("none");
  const [airwayInfo, setAirwayInfo] = useState<{ thresholdHu: number | null; volumeMl: number } | null>(null);
  const [airwayOpacity, setAirwayOpacity] = useState(0.9);
  // painting changes the mask in place: "Update annotation" (or a new or
  // deleted object) sends it to the GPU again
  const [maskTick, setMaskTick] = useState(0);
  const objectIds = objects.map((o) => o.id).join(",");

  // the three.js world, made once per mount
  const world = useRef<World | null>(null);
  const hoveredRef = useRef(false);
  // CPU copies of what the GPU draws, for picking (lib/volumeRender pickAlongRay)
  const cpu = useRef<{ data: Uint8Array | null; mask: Uint8Array | null; lung: Uint8Array | null; airway: Uint8Array | null }>({ data: null, mask: null, lung: null, airway: null });
  const [picked, setPicked] = useState<{ z: number; objectId: number | null } | null>(null);
  const [follow, setFollow] = useState(false);
  const [focused, setFocused] = useState<number | null>(null);
  const [showPlanes, setShowPlanes] = useState(true);
  const [recording, setRecording] = useState(false);
  const settingsRef = useRef({ center: -600, width: 1500, opacity: 0.25, mode: "volume" as Mode, showMask: true, lungOnly: false, showAirways: false, nearCut: 0 });
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const navRef = useRef(nav);
  navRef.current = nav;

  // ── renderer, camera, controls, the frame loop ─────────────────────────
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    const probe = document.createElement("canvas");
    if (!probe.getContext("webgl2")) {
      setStatus("nowebgl");
      return;
    }
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setClearColor(0x000000, 1);
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.setAttribute("data-testid", "volume-canvas");
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.001, 20);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enabled = false;
    orbit.enableDamping = true;
    const paletteTex = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1, THREE.RGBAFormat);
    paletteTex.minFilter = THREE.NearestFilter;
    paletteTex.magFilter = THREE.NearestFilter;
    paletteTex.needsUpdate = true;
    const w: World = {
      renderer,
      scene,
      camera,
      mesh: null,
      material: null,
      maskTex: null,
      paletteTex,
      orbit,
      yaw: 0,
      pitch: 0,
      keys: { forward: false, back: false, left: false, right: false, up: false, down: false },
      dirty: true,
      turn: null,
    };
    orbit.addEventListener("change", () => (w.dirty = true));
    world.current = w;
    resetView();

    const resize = () => {
      const r = host.getBoundingClientRect();
      const width = Math.max(1, Math.floor(r.width));
      const height = Math.max(1, Math.floor(r.height));
      renderer.setSize(width, height, false);
      renderer.domElement.style.width = `${width}px`;
      renderer.domElement.style.height = `${height}px`;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      w.dirty = true;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (w.turn) {
        // recording: one even turn around the target, a frame every tick
        const k = Math.min(1, (now - w.turn.start) / w.turn.duration);
        const o = w.turn.offset.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), k * Math.PI * 2);
        camera.position.copy(w.turn.target).add(o);
        camera.lookAt(w.turn.target);
        w.dirty = true;
        if (k >= 1) {
          const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
          w.yaw = e.y; // flying on from where the turn ended
          w.pitch = e.x;
          const done = w.turn.done;
          w.turn = null;
          done();
        }
      } else if (navRef.current === "fly") {
        const [dx, dy, dz] = flyStep(w.keys, w.yaw, w.pitch, speedRef.current, dt);
        if (dx || dy || dz) {
          camera.position.x += dx;
          camera.position.y += dy;
          camera.position.z += dz;
          w.dirty = true;
        }
        camera.rotation.set(w.pitch, w.yaw, 0, "YXZ");
      } else {
        orbit.update();
      }
      if (!w.dirty) {
        frame = requestAnimationFrame(tick);
        return;
      }
      w.dirty = false;
      if (w.mesh && w.material) {
        w.mesh.updateMatrixWorld();
        const local = w.mesh.worldToLocal(camera.position.clone()).addScalar(0.5);
        (w.material.uniforms.uCamLocal.value as THREE.Vector3).copy(local);
      }
      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      orbit.dispose();
      w.material?.dispose();
      w.mesh?.geometry.dispose();
      w.maskTex?.dispose();
      paletteTex.dispose();
      (w.material?.uniforms.uVolume.value as THREE.Texture | undefined)?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      world.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A click at (ndcX, ndcY) of the view: march that ray through the same
   * scene the shader draws, mark the point, tell the parent. */
  function pickAt(ndcX: number, ndcY: number) {
    const w = world.current;
    if (!w?.mesh || !w.material || !info || !cpu.current.data) return;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), w.camera);
    w.mesh.updateMatrixWorld();
    const o = w.mesh.worldToLocal(ray.ray.origin.clone()).addScalar(0.5);
    const far = w.mesh.worldToLocal(ray.ray.origin.clone().add(ray.ray.direction)).addScalar(0.5);
    const d = far.clone().sub(o).normalize();
    const st = settingsRef.current;
    const hit = pickAlongRay([o.x, o.y, o.z], [d.x, d.y, d.z], {
      dims: info.dims,
      data: cpu.current.data,
      window: windowToUnit(st.center, st.width, info),
      opacity: st.opacity,
      mode: st.mode,
      mask: st.showMask ? cpu.current.mask : null,
      lung: st.lungOnly ? cpu.current.lung : null,
      airway: st.showAirways ? cpu.current.airway : null,
      nearCut: st.nearCut,
      clipLo: [0, 0, 0],
      clipHi: [1, 1, 1],
    });
    if (!hit) return;
    const [px, py, pz] = hit.point as Vec3;
    (w.material.uniforms.uPick.value as THREE.Vector3).set(px, py, pz);
    w.material.uniforms.uShowPick.value = true;
    w.dirty = true;
    const at = { x: Math.min(columns - 1, Math.floor(px * columns)), y: Math.min(rows - 1, Math.floor(py * rows)), z: Math.min(numSlices - 1, Math.floor(pz * numSlices)), objectId: hit.objectId };
    setPicked({ z: at.z, objectId: at.objectId });
    onPickRef.current?.(at);
  }
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const pickAtRef = useRef(pickAt);
  pickAtRef.current = pickAt;

  /** The camera to an object: at a distance for its size, looking at its
   * middle (orbiting: turning around it). */
  function flyTo(id: number) {
    const w = world.current;
    if (!w?.mesh || !info || !cpu.current.mask) return;
    const b = objectBounds(cpu.current.mask, info.dims, id);
    if (!b) return;
    w.mesh.updateMatrixWorld();
    const center = w.mesh.localToWorld(new THREE.Vector3(b.center[0] - 0.5, b.center[1] - 0.5, b.center[2] - 0.5));
    const s = w.mesh.scale;
    const extent = Math.max(b.size[0] * Math.abs(s.x), b.size[1] * Math.abs(s.y), b.size[2] * Math.abs(s.z));
    const distance = Math.max(0.12, extent * 4);
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(w.camera.quaternion); // from where it looks now
    w.camera.position.copy(center).addScaledVector(back, distance);
    w.camera.lookAt(center);
    const e = new THREE.Euler().setFromQuaternion(w.camera.quaternion, "YXZ");
    w.yaw = e.y;
    w.pitch = e.x;
    w.orbit.target.copy(center);
    w.orbit.update();
    w.dirty = true;
    setFocused(id);
  }
  const flyToRef = useRef(flyTo);
  flyToRef.current = flyTo;
  useEffect(() => {
    if (follow && focusObjectId != null && status === "ready") flyToRef.current(focusObjectId);
  }, [follow, focusObjectId, status]);

  /** A picture of the view as it is, as a PNG download. */
  function saveImage() {
    const w = world.current;
    if (!w) return;
    // drawn and read in the same task: the WebGL buffer is still there
    w.renderer.render(w.scene, w.camera);
    w.renderer.domElement.toBlob((blob) => blob && download(blob, `ct-3d-${stamp()}.png`), "image/png");
  }

  /** One turn around the view's middle (or the object gone to), as a
   * webm video download. */
  function recordTurn() {
    const w = world.current;
    if (!w || recording || typeof MediaRecorder === "undefined") return;
    const canvas = w.renderer.domElement;
    const stream = canvas.captureStream(30);
    const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    const recorder = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 6_000_000 } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      download(new Blob(chunks, { type: "video/webm" }), `ct-3d-turn-${stamp()}.webm`);
      setRecording(false);
    };
    const target = w.orbit.target.clone();
    w.turn = { start: performance.now(), duration: 8000, target, offset: w.camera.position.clone().sub(target), done: () => recorder.stop() };
    setRecording(true);
    recorder.start(250);
  }

  /** In front of the patient, the whole volume in view. */
  function resetView() {
    const w = world.current;
    if (!w) return;
    w.yaw = 0;
    w.pitch = 0;
    w.camera.position.set(0, 0, 1.6);
    w.camera.rotation.set(0, 0, 0, "YXZ");
    w.orbit.target.set(0, 0, 0);
    w.orbit.update();
    w.dirty = true;
  }

  // a small pane (beside the 2D ones) would be all settings: start them folded
  useEffect(() => {
    if (status === "ready" && (hostRef.current?.getBoundingClientRect().width ?? 1000) < 520) setShowPanel(false);
  }, [status]);

  // ── the CT volume: fetched once per series, uploaded as a 3D texture ───
  useEffect(() => {
    if (!seriesId || status === "nowebgl") return;
    let cancelled = false;
    setStatus("loading");
    setError(null);
    fetchVolume3D(seriesId)
      .then(({ data, info }) => {
        const w = world.current;
        if (cancelled || !w) return;
        const [x, y, z] = info.dims;
        cpu.current.data = data;
        const tex = new THREE.Data3DTexture(data as Uint8Array<ArrayBuffer>, x, y, z);
        tex.format = THREE.RedFormat;
        tex.type = THREE.UnsignedByteType;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.unpackAlignment = 1;
        tex.needsUpdate = true;
        const emptyMask = new THREE.Data3DTexture(new Uint8Array(1), 1, 1, 1);
        emptyMask.format = THREE.RedFormat;
        emptyMask.needsUpdate = true;
        const material = new THREE.ShaderMaterial({
          glslVersion: THREE.GLSL3,
          vertexShader: VERTEX,
          fragmentShader: FRAGMENT,
          side: THREE.BackSide,
          uniforms: {
            uVolume: { value: tex },
            uMask: { value: emptyMask },
            uLung: { value: emptyMask },
            uLungOnly: { value: false },
            uNearCut: { value: 0 },
            uAirway: { value: emptyMask },
            uShowAirway: { value: false },
            uAirwayColor: { value: new THREE.Color(AIRWAY_COLOR) },
            uAirwayOpacity: { value: 0.9 },
            uPick: { value: new THREE.Vector3() },
            uShowPick: { value: false },
            uAspect: { value: new THREE.Vector3(1, 1, 1) },
            uPlanes: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
            uShowPlanes: { value: true },
            uPlaneX: { value: new THREE.Color(PLANE_COLOR.sagittal) },
            uPlaneY: { value: new THREE.Color(PLANE_COLOR.coronal) },
            uPlaneZ: { value: new THREE.Color(PLANE_COLOR.axial) },
            uPalette: { value: w.paletteTex },
            uCamLocal: { value: new THREE.Vector3() },
            uTexel: { value: new THREE.Vector3(1 / x, 1 / y, 1 / z) },
            uWindow: { value: new THREE.Vector2(0, 1) },
            uOpacity: { value: 0.25 },
            uMaskOpacity: { value: 0.8 },
            uSmooth: { value: 0.5 },
            uSteps: { value: 400 },
            uMode: { value: 0 },
            uShade: { value: true },
            uShowMask: { value: true },
          },
        });
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
        // real proportions: columns x rows x slices in mm, the largest 1 unit
        const [sx, sy, sz] = info.spacing;
        const size = [x * sx, y * sy, z * sz];
        const m = Math.max(...size);
        // Seen from the default camera (+Z, looking at the patient's front):
        // slices run down the screen, the first at the top (as on the
        // sagittal and coronal panes); the rows run from the front (row 0,
        // anterior) away from the viewer; the columns run to the right --
        // the patient's left on the viewer's right, as facing a person. The
        // rows need a mirror for that (three.js flips the face culling of
        // a mirrored object itself).
        mesh.scale.set(size[0] / m, -size[1] / m, size[2] / m);
        mesh.rotation.x = Math.PI / 2;
        (material.uniforms.uAspect.value as THREE.Vector3).set(size[0] / m, size[1] / m, size[2] / m);
        if (w.mesh) {
          w.scene.remove(w.mesh);
          w.mesh.geometry.dispose();
          w.material?.dispose();
        }
        w.scene.add(mesh);
        w.mesh = mesh;
        w.material = material;
        w.maskTex = emptyMask;
        w.dirty = true;
        setInfo(info);
        setStatus("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errorText(err));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesId]);

  // ── the annotation: its mask at the volume's size, its colours ─────────
  useEffect(() => {
    const w = world.current;
    if (!w?.material || !info || !maskVolume || !rows || !columns || !numSlices) return;
    if (maskVolume.length !== rows * columns * numSlices) return;
    const small = shrinkMask(maskVolume, rows, columns, numSlices, info.factor);
    const [x, y, z] = info.dims;
    if (small.length !== x * y * z) return; // a series changed under us
    const copy = small === maskVolume ? small.slice() : small;
    cpu.current.mask = copy;
    const tex = new THREE.Data3DTexture(copy, x, y, z);
    tex.format = THREE.RedFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    w.maskTex?.dispose();
    w.maskTex = tex;
    w.material.uniforms.uMask.value = tex;
    w.dirty = true;
  }, [info, maskVolume, rows, columns, numSlices, maskKey, maskTick, objectIds]);

  useEffect(() => {
    const w = world.current;
    if (!w) return;
    (w.paletteTex.image.data as Uint8Array).set(labelPalette(objects, labels));
    w.paletteTex.needsUpdate = true;
    w.dirty = true;
  }, [objects, labels, info]);

  // ── the 2D panes' slices, as sheets in the volume ───────────────────────
  useEffect(() => {
    const u = world.current?.material?.uniforms;
    if (!u || !slices || !rows || !columns || !numSlices) return;
    const x = slices.x ?? Math.floor(columns / 2);
    const y = slices.y ?? Math.floor(rows / 2);
    (u.uPlanes.value as THREE.Vector3).set((x + 0.5) / columns, (y + 0.5) / rows, (slices.z + 0.5) / numSlices);
    u.uShowPlanes.value = showPlanes;
    if (world.current) world.current.dirty = true;
  }, [slices?.x, slices?.y, slices?.z, showPlanes, rows, columns, numSlices, info]);

  // ── the lungs (the backend's own segmentation), for "Only inside the lungs"
  useEffect(() => {
    if (!lungOnly || lungState !== "none" || !seriesId || !info) return;
    setLungState("loading");
    fetchLungMask(seriesId)
      .then((m) => {
        const w = world.current;
        if (!w?.material) return;
        const [x, y, z] = info.dims;
        const shrunk = shrinkMask(m.data, m.rows, m.columns, m.numSlices, info.factor);
        if (shrunk.length !== x * y * z) throw new Error("size");
        const small = softMask(fillLungHoles(shrunk, x, y, z), x, y, z);
        cpu.current.lung = small;
        const tex = new THREE.Data3DTexture(small, x, y, z);
        tex.format = THREE.RedFormat;
        tex.type = THREE.UnsignedByteType;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.unpackAlignment = 1;
        tex.needsUpdate = true;
        w.material.uniforms.uLung.value = tex;
        w.dirty = true;
        setLungState("ready");
      })
      .catch(() => setLungState("error"));
  }, [lungOnly, lungState, seriesId, info]);

  // ── the bronchial tree, segmented by the backend (app/airways.py) ─────────
  useEffect(() => {
    if (!showAirways || airwayState !== "none" || !seriesId || !info) return;
    setAirwayState("loading");
    fetchAirways(seriesId)
      .then((a) => {
        const w = world.current;
        if (!w?.material) return;
        if (!a.found) {
          setAirwayState("notfound");
          return;
        }
        const [x, y, z] = info.dims;
        const shrunk = shrinkMask(a.data, a.rows, a.columns, a.numSlices, info.factor);
        if (shrunk.length !== x * y * z) throw new Error("size");
        const soft = softMask(shrunk, x, y, z);
        cpu.current.airway = soft;
        const tex = new THREE.Data3DTexture(soft, x, y, z);
        tex.format = THREE.RedFormat;
        tex.type = THREE.UnsignedByteType;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.unpackAlignment = 1;
        tex.needsUpdate = true;
        w.material.uniforms.uAirway.value = tex;
        w.dirty = true;
        setAirwayInfo({ thresholdHu: a.thresholdHu, volumeMl: a.volumeMl });
        setAirwayState("ready");
      })
      .catch(() => setAirwayState("error"));
  }, [showAirways, airwayState, seriesId, info]);

  // ── the knobs, straight into the shader ─────────────────────────────────
  useEffect(() => {
    const u = world.current?.material?.uniforms;
    if (!u || !info) return;
    const [lo, hi] = windowToUnit(center, width, info);
    (u.uWindow.value as THREE.Vector2).set(lo, hi);
    u.uOpacity.value = opacity;
    u.uMaskOpacity.value = maskOpacity;
    u.uSmooth.value = smooth;
    u.uSteps.value = Math.round(Math.max(...info.dims) * 1.6 * quality);
    u.uMode.value = mode === "mip" ? 1 : 0;
    u.uShade.value = shade;
    u.uShowMask.value = showMask;
    u.uLungOnly.value = lungOnly && lungState === "ready";
    u.uNearCut.value = nearCut;
    u.uShowAirway.value = showAirways && airwayState === "ready";
    settingsRef.current = { center, width, opacity, mode, showMask, lungOnly: lungOnly && lungState === "ready", showAirways: showAirways && airwayState === "ready", nearCut };
    u.uAirwayOpacity.value = airwayOpacity;
    if (world.current) world.current.dirty = true;
  }, [info, center, width, opacity, maskOpacity, smooth, quality, mode, shade, showMask, lungOnly, lungState, nearCut, showAirways, airwayState, airwayOpacity]);

  // ── flying: pointer lock + mouse look, WASD / Space / Shift ─────────────
  useEffect(() => {
    const w = world.current;
    if (!w) return;
    w.orbit.enabled = nav === "orbit";
    if (nav === "orbit") {
      if (document.pointerLockElement) document.exitPointerLock();
      w.orbit.target.set(0, 0, 0);
      w.orbit.update();
    } else {
      // take over the orbit camera's direction
      const e = new THREE.Euler().setFromQuaternion(w.camera.quaternion, "YXZ");
      w.yaw = e.y;
      w.pitch = e.x;
    }
    w.dirty = true;
  }, [nav]);

  useEffect(() => {
    const w = world.current;
    if (!w) return;
    const canvas = w.renderer.domElement;
    const onLockChange = () => setLocked(document.pointerLockElement === canvas);
    const look = (dx: number, dy: number) => {
      w.yaw -= dx * 0.0025;
      w.pitch = Math.max(-1.5, Math.min(1.5, w.pitch - dy * 0.0025));
      w.dirty = true;
    };
    const onMove = (e: MouseEvent) => {
      if (navRef.current === "fly" && document.pointerLockElement === canvas) look(e.movementX, e.movementY);
    };
    // without pointer lock (a touch screen): drag to look
    let drag: { x: number; y: number } | null = null;
    let press: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      press = { x: e.clientX, y: e.clientY };
      if (navRef.current !== "fly") return;
      if (document.pointerLockElement === canvas) {
        pickAtRef.current(0, 0); // flying: the crosshair in the middle
        return;
      }
      if (e.pointerType === "mouse" && canvas.requestPointerLock) {
        canvas.requestPointerLock();
        return;
      }
      drag = { x: e.clientX, y: e.clientY };
    };
    // orbiting (or a finger): a click that didn't drag picks where it is
    const onClickUp = (e: PointerEvent) => {
      const p = press;
      press = null;
      if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4) return;
      if (navRef.current === "fly" && e.pointerType === "mouse") return;
      const r = canvas.getBoundingClientRect();
      pickAtRef.current(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!drag) return;
      look(e.clientX - drag.x, e.clientY - drag.y);
      drag = { x: e.clientX, y: e.clientY };
    };
    const onUp = () => (drag = null);
    const onWheel = (e: WheelEvent) => {
      if (navRef.current !== "fly") return;
      e.preventDefault();
      setSpeed((s) => Math.max(0.05, Math.min(3, s * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
    };
    const KEY: Record<string, keyof FlyKeys> = { KeyW: "forward", KeyS: "back", KeyA: "left", KeyD: "right", Space: "up", ShiftLeft: "down", ShiftRight: "down" };
    const active = () => navRef.current === "fly" && (document.pointerLockElement === canvas || hoveredRef.current);
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      const k = KEY[e.code];
      if (!k) {
        if (down && e.code === "KeyR" && active()) resetView();
        return;
      }
      if (down && !active()) return;
      // the viewer's own keys (WASD pan, Space peek, ...) stay out of it
      e.preventDefault();
      e.stopImmediatePropagation();
      w.keys[k] = down;
    };
    const onKeyDown = onKey(true);
    const onKeyUp = onKey(false);
    const stopAll = () => {
      for (const k of Object.keys(w.keys) as (keyof FlyKeys)[]) w.keys[k] = false;
    };
    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("mousemove", onMove);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onClickUp);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", stopAll);
    return () => {
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onClickUp);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", stopAll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => onFullscreenChange(() => setFullscreen(fullscreenElement() === hostRef.current)), []);
  function toggleFullscreen() {
    if (fullscreenElement() === hostRef.current) exitFullscreen();
    else if (hostRef.current) enterFullscreen(hostRef.current);
  }

  const slider = (label: string, value: number, min: number, max: number, step: number, set: (v: number) => void, testId: string, show?: string) => (
    <label className="flex flex-col gap-0.5">
      <span className="flex justify-between text-[10px] uppercase tracking-wide text-gray-400">
        {label}
        <span className="font-mono normal-case text-gray-300">{show ?? value}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => set(Number(e.target.value))} data-testid={testId} className="accent-blue-500" />
    </label>
  );

  return (
    <div
      ref={hostRef}
      className="relative h-full min-h-[240px] w-full overflow-hidden bg-black"
      data-testid="volume-view"
      data-focused-object={focused ?? undefined}
      onPointerEnter={() => (hoveredRef.current = true)}
      onPointerLeave={() => (hoveredRef.current = false)}
    >
      <div ref={canvasHostRef} className="absolute inset-0" />

      {status !== "ready" && (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-gray-400" data-testid="volume-status">
          {status === "loading" && "Loading the CT for 3D…"}
          {status === "error" && (error ?? "The 3D view couldn't load this series.")}
          {status === "nowebgl" && "This browser has no WebGL 2, which the 3D view needs."}
        </div>
      )}

      {status === "ready" && (
        <>
          {locked && (
            <div className="pointer-events-none absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2" aria-hidden="true">
              <div className="absolute left-1/2 top-0 h-full w-px bg-yellow-300/80" />
              <div className="absolute left-0 top-1/2 h-px w-full bg-yellow-300/80" />
            </div>
          )}
          {picked && (
            <div className="absolute bottom-9 left-2 flex items-center gap-2 rounded bg-black/70 px-2 py-1 text-[11px] text-yellow-200" data-testid="volume-picked">
              <span>
                Picked: slice {picked.z + 1}
                {picked.objectId !== null ? ` · object ${picked.objectId}` : ""} -- the 2D panes are there
              </span>
              {onShow2D && (
                <button type="button" onClick={onShow2D} className="rounded border border-yellow-400/50 px-1.5 text-[10px] hover:bg-yellow-400/10" data-testid="volume-show-2d">
                  Show 2D
                </button>
              )}
            </div>
          )}
          <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 text-[10px] text-gray-300" data-testid="volume-hint">
            {nav === "fly"
              ? locked
                ? "Mouse looks · W A S D move · Space up · Shift down · click picks the middle · wheel speed · R reset · Esc lets go"
                : "Click the view to fly: mouse looks, W A S D, Space up, Shift down"
              : "Drag to turn · right-drag to move · wheel to zoom · click picks a point"}
          </div>
          {/* one column in the pane: the buttons wrap inside it, the settings open below them */}
          <div className="pointer-events-none absolute inset-x-2 top-2 bottom-10 flex flex-col gap-1">
          <div className="pointer-events-auto flex flex-wrap justify-end gap-1">
            <button type="button" onClick={() => setShowPanel((v) => !v)} className="rounded border border-[#444] bg-black/70 px-2 py-1 text-[11px] text-gray-200 hover:bg-[#333]" data-testid="volume-panel-toggle">
              {showPanel ? "Hide settings" : "Settings"}
            </button>
            <button type="button" onClick={saveImage} className="rounded border border-[#444] bg-black/70 px-2 py-1 text-[11px] text-gray-200 hover:bg-[#333]" title="A PNG of the view as it is" data-testid="volume-save-image">
              Save image
            </button>
            <button
              type="button"
              onClick={recordTurn}
              disabled={recording}
              className="rounded border border-[#444] bg-black/70 px-2 py-1 text-[11px] text-gray-200 hover:bg-[#333] disabled:text-red-300"
              title="A video of one turn around the view's middle (8 s) -- for a report or a slide"
              data-testid="volume-record"
            >
              {recording ? "● Recording…" : "Record turnaround"}
            </button>
            <button type="button" onClick={toggleFullscreen} className="rounded border border-[#444] bg-black/70 px-2 py-1 text-[11px] text-gray-200 hover:bg-[#333]" data-testid="volume-fullscreen">
              {fullscreen ? "Exit full screen" : "Full screen"}
            </button>
          </div>
          {showPanel && (
            <div className="pointer-events-auto flex min-h-0 w-56 max-w-full flex-col gap-2 self-start overflow-y-auto rounded border border-[#333] bg-black/75 p-2.5 text-[11px] text-gray-200" data-testid="volume-panel">
              <div className="flex gap-1" role="group" aria-label="Rendering">
                {(["volume", "mip"] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m} data-testid={`volume-mode-${m}`} className={`flex-1 rounded border px-1.5 py-0.5 ${mode === m ? "border-blue-500 bg-blue-500/25" : "border-[#444] hover:bg-[#333]"}`}>
                    {m === "volume" ? "Volume" : "MIP"}
                  </button>
                ))}
              </div>
              <div className="flex gap-1" role="group" aria-label="Camera">
                {(["fly", "orbit"] as const).map((n) => (
                  <button key={n} type="button" onClick={() => setNav(n)} aria-pressed={nav === n} data-testid={`volume-nav-${n}`} className={`flex-1 rounded border px-1.5 py-0.5 ${nav === n ? "border-blue-500 bg-blue-500/25" : "border-[#444] hover:bg-[#333]"}`}>
                    {n === "fly" ? "Fly (WASD)" : "Orbit"}
                  </button>
                ))}
                <button type="button" onClick={resetView} className="rounded border border-[#444] px-1.5 py-0.5 hover:bg-[#333]" title="Back in front of the patient (R)" data-testid="volume-reset">
                  Reset
                </button>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => focusObjectId != null && flyTo(focusObjectId)}
                  disabled={focusObjectId == null}
                  className="rounded border border-[#444] px-1.5 py-0.5 hover:bg-[#333] disabled:opacity-40"
                  title="The camera to the selected object"
                  data-testid="volume-goto-object"
                >
                  Go to object
                </button>
                <label className="flex items-center gap-1.5" title="Go along whenever another object is selected (in review: whenever the card steps)">
                  <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} data-testid="volume-follow" /> Follow
                </label>
              </div>
              <div className="flex flex-wrap gap-1" role="group" aria-label="Window">
                {PRESETS.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    onClick={() => {
                      setCenter(p.center);
                      setWidth(p.width);
                    }}
                    className={`rounded border px-1.5 py-0.5 ${center === p.center && width === p.width ? "border-blue-500 bg-blue-500/25" : "border-[#444] hover:bg-[#333]"}`}
                    data-testid={`volume-preset-${p.name}`}
                  >
                    {p.name}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setCenter(VESSELS.center);
                    setWidth(VESSELS.width);
                    setLungOnly(true);
                    setOpacity(0.35);
                  }}
                  className={`rounded border px-1.5 py-0.5 ${lungOnly && center === VESSELS.center && width === VESSELS.width ? "border-blue-500 bg-blue-500/25" : "border-[#444] hover:bg-[#333]"}`}
                  title="Vessels and nodules inside the lungs, the chest wall left out"
                  data-testid="volume-preset-Vessels"
                >
                  Lung vessels
                </button>
              </div>
              <label className="flex items-center gap-2" title="Draw only what lies inside the lungs (the annotation always shows) -- the chest wall has the same density as vessels and nodules, and hides them">
                <input type="checkbox" checked={lungOnly} onChange={(e) => setLungOnly(e.target.checked)} data-testid="volume-lung-only" />
                Only inside the lungs
                {lungOnly && lungState === "loading" && <span className="text-gray-500">finding the lungs…</span>}
                {lungOnly && lungState === "error" && <span className="text-red-400">no lungs found</span>}
              </label>
              <label className="flex flex-wrap items-center gap-x-2" title="The bronchial tree, found from the CT: the trachea, then everything connected to it below a threshold that rises until it would leak into the lung">
                <input type="checkbox" checked={showAirways} onChange={(e) => setShowAirways(e.target.checked)} data-testid="volume-airways" />
                <span style={{ color: AIRWAY_COLOR }}>Airways</span>
                {showAirways && airwayState === "loading" && <span className="text-gray-500">segmenting…</span>}
                {showAirways && airwayState === "notfound" && <span className="text-amber-300">no trachea found</span>}
                {showAirways && airwayState === "error" && <span className="text-red-400">failed</span>}
                {showAirways && airwayState === "ready" && airwayInfo && (
                  <span className="text-gray-500" data-testid="volume-airways-info">
                    {airwayInfo.volumeMl} mL · to {airwayInfo.thresholdHu} HU
                  </span>
                )}
              </label>
              {showAirways && airwayState === "ready" && slider("Airway opacity", airwayOpacity, 0.1, 1, 0.05, setAirwayOpacity, "volume-airway-opacity", `${Math.round(airwayOpacity * 100)}%`)}
              {slider("Center (HU)", center, -1000, 1500, 10, setCenter, "volume-center")}
              {slider("Width (HU)", width, 50, 4000, 10, setWidth, "volume-width")}
              {mode === "volume" && slider("Opacity", opacity, 0.01, 1, 0.01, setOpacity, "volume-opacity", `${Math.round(opacity * 100)}%`)}
              {slider("Smoothing", smooth, 0, 3, 0.25, setSmooth, "volume-smooth")}
              {slider("Cut away in front", nearCut, 0, 1.5, 0.02, setNearCut, "volume-near-cut", nearCut ? `${Math.round(nearCut * 100)}%` : "off")}
              {slider("Quality", quality, 0.5, 2, 0.25, setQuality, "volume-quality", `${quality}×`)}
              {mode === "volume" && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={shade} onChange={(e) => setShade(e.target.checked)} data-testid="volume-shade" /> Shading
                </label>
              )}
              {mode === "volume" && (
                <label className="flex items-center gap-2" title="Where the 2D panes are, as thin sheets in their own colours">
                  <input type="checkbox" checked={showPlanes} onChange={(e) => setShowPlanes(e.target.checked)} data-testid="volume-planes" /> The 2D slices
                </label>
              )}
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={showMask} onChange={(e) => setShowMask(e.target.checked)} data-testid="volume-show-mask" /> Annotation
                </label>
                <button type="button" onClick={() => setMaskTick((n) => n + 1)} className="ml-auto rounded border border-[#444] px-1.5 py-0.5 text-[10px] hover:bg-[#333]" title="Show the painting as it is now" data-testid="volume-update-mask">
                  Update
                </button>
              </div>
              {showMask && slider("Annotation opacity", maskOpacity, 0.05, 1, 0.05, setMaskOpacity, "volume-mask-opacity", `${Math.round(maskOpacity * 100)}%`)}
              {nav === "fly" && slider("Flying speed", Math.round(speed * 100) / 100, 0.05, 3, 0.05, setSpeed, "volume-speed")}
              {info && (
                <p className="text-[10px] text-gray-500">
                  {info.dims.join(" × ")} voxels · {info.spacing.map((s) => s.toFixed(2)).join(" × ")} mm
                </p>
              )}
            </div>
          )}
          </div>
        </>
      )}
    </div>
  );
}
