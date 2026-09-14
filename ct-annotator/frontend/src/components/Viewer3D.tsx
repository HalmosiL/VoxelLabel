import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { fetchLungMask } from "../api/annotatorApi";
import { marchingCubes } from "../lib/marchingCubes";

export interface Viewer3DLabel {
  id: number;
  name: string;
  color: string;
}

export interface Viewer3DObject {
  id: number;
  label_id: number;
  hidden: boolean;
}

type RenderMode = "cubes" | "surface";

/**
 * Real 3D view of the current segmentation -- reads the same
 * maskVolume/labels/objects ViewerPage.tsx already maintains for the 2D
 * overlays, purely as a visualization (no drawing happens here). Two
 * switchable render modes: instanced solid voxel cubes (always
 * available, no meshing step) and a marching-cubes surface per object
 * (smoother, more expensive). Deliberately does NOT rebuild on every
 * volume mutation -- painting elsewhere shouldn't pay for a mesh
 * rebuild on every pointermove -- only when `refreshKey` changes
 * (parent bumps it when this pane becomes visible) or the user clicks
 * the in-pane Refresh button.
 */
export default function Viewer3D({
  maskVolume,
  rows,
  columns,
  numSlices,
  labels,
  objects,
  refreshKey,
  seriesId,
}: {
  maskVolume: Uint8Array | null;
  rows: number;
  columns: number;
  numSlices: number;
  labels: Viewer3DLabel[];
  objects: Viewer3DObject[];
  refreshKey: number;
  seriesId: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const animationRef = useRef<number>(0);
  const disposablesRef = useRef<{ dispose: () => void }[]>([]);

  const [renderMode, setRenderMode] = useState<RenderMode>("cubes");
  // Auto-segmented from the HU volume server-side (threshold +
  // connected-component filtering, see backend/app/main.py's
  // _segment_lungs) -- not something the user paints. Fetched once on
  // first toggle-on and kept for the rest of this pane's lifetime;
  // there's no live-updating reason to refetch it (the underlying CT
  // data never changes), unlike the painted objects this pane also shows.
  const [showLung, setShowLung] = useState(false);
  const [lungMask, setLungMask] = useState<{ data: Uint8Array; rows: number; columns: number; numSlices: number } | null>(null);
  const [lungLoading, setLungLoading] = useState(false);
  const [voxelCount, setVoxelCount] = useState<number | null>(null);

  // ── Three.js lifecycle: create once, resize with the container, tear
  // down on unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10000);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    rendererRef.current = renderer;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    // Calmer than OrbitControls' defaults (1.0 across the board): at
    // full speed a short flick -- especially a finger's, which covers
    // far more of a tablet's screen than a mouse drag does -- spins the
    // volume well past whatever the person was trying to look at, and
    // the damping above then carries that overshoot on. Rotation is the
    // one that matters; zoom and pan get a gentler touch too.
    controls.rotateSpeed = 0.4;
    controls.zoomSpeed = 0.6;
    controls.panSpeed = 0.6;
    controlsRef.current = controls;

    const group = new THREE.Group();
    scene.add(group);
    groupRef.current = group;

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const directional = new THREE.DirectionalLight(0xffffff, 0.8);
    directional.position.set(1, 1, 1);
    scene.add(directional);
    const directional2 = new THREE.DirectionalLight(0xffffff, 0.4);
    directional2.position.set(-1, -1, -1);
    scene.add(directional2);

    function resize() {
      if (!container) return;
      const { width, height } = container.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    function animate() {
      animationRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    return () => {
      cancelAnimationFrame(animationRef.current);
      resizeObserver.disconnect();
      controls.dispose();
      disposablesRef.current.forEach((d) => d.dispose());
      disposablesRef.current = [];
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function rebuild() {
    const group = groupRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!group || !camera || !controls || !maskVolume || !rows || !columns || !numSlices) return;

    disposablesRef.current.forEach((d) => d.dispose());
    disposablesRef.current = [];
    group.clear();

    // No physical voxel spacing is persisted anywhere in this platform
    // (same known limitation the 2D panes' own "stretch to fill"
    // approximation works around) -- stretching Z by columns/numSlices
    // makes the bounding box roughly cubic instead of a flat wafer,
    // the same pragmatic choice, just generalized to 3D.
    const zScale = columns / numSlices;
    const centerX = columns / 2;
    const centerY = rows / 2;
    const centerZ = (numSlices * zScale) / 2;

    let totalVoxels = 0;

    for (const obj of objects) {
      if (obj.hidden) continue;
      const label = labels.find((l) => l.id === obj.label_id);
      if (!label) continue;

      let minX = columns, maxX = -1, minY = rows, maxY = -1, minZ = numSlices, maxZ = -1;
      for (let z = 0; z < numSlices; z++) {
        const zBase = z * rows * columns;
        for (let y = 0; y < rows; y++) {
          const yBase = zBase + y * columns;
          for (let x = 0; x < columns; x++) {
            if (maskVolume[yBase + x] === obj.id) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
              if (z < minZ) minZ = z;
              if (z > maxZ) maxZ = z;
            }
          }
        }
      }
      if (maxX < 0) continue; // this object currently has no voxels

      const color = new THREE.Color(label.color);

      if (renderMode === "cubes") {
        const positions: [number, number, number][] = [];
        for (let z = minZ; z <= maxZ; z++) {
          const zBase = z * rows * columns;
          for (let y = minY; y <= maxY; y++) {
            const yBase = zBase + y * columns;
            for (let x = minX; x <= maxX; x++) {
              if (maskVolume[yBase + x] === obj.id) positions.push([x, y, z]);
            }
          }
        }
        totalVoxels += positions.length;

        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const material = new THREE.MeshStandardMaterial({ color });
        const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
        const dummy = new THREE.Object3D();
        positions.forEach(([x, y, z], i) => {
          dummy.position.set(x - centerX, y - centerY, z * zScale - centerZ);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        group.add(mesh);
        disposablesRef.current.push(geometry, material);
      } else {
        // Pad the sampled region by 1 voxel so the surface can close at
        // the object's true boundary instead of being clipped flat.
        const bx0 = Math.max(0, minX - 1), bx1 = Math.min(columns - 1, maxX + 1);
        const by0 = Math.max(0, minY - 1), by1 = Math.min(rows - 1, maxY + 1);
        const bz0 = Math.max(0, minZ - 1), bz1 = Math.min(numSlices - 1, maxZ + 1);
        const dimsX = bx1 - bx0 + 1, dimsY = by1 - by0 + 1, dimsZ = bz1 - bz0 + 1;

        const { positions, normals } = marchingCubes(
          (lx, ly, lz) => (maskVolume[(bz0 + lz) * rows * columns + (by0 + ly) * columns + (bx0 + lx)] === obj.id ? 1 : 0),
          { x: dimsX, y: dimsY, z: dimsZ },
          0.5
        );
        if (positions.length === 0) continue;

        const world = new Float32Array(positions.length);
        for (let i = 0; i < positions.length; i += 3) {
          world[i] = positions[i] + bx0 - centerX;
          world[i + 1] = positions[i + 1] + by0 - centerY;
          world[i + 2] = (positions[i + 2] + bz0) * zScale - centerZ;
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(world, 3));
        // The Z-axis stretch above is anisotropic, so these normals (computed
        // pre-stretch) are only an approximation post-stretch -- a proper fix
        // needs the inverse-transpose normal matrix, not worth it for a 3D
        // preview rather than a physically exact renderer.
        geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));

        const material = new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geometry, material);
        group.add(mesh);
        disposablesRef.current.push(geometry, material);
      }
    }

    // Lung: a translucent surface so painted nodules remain visible
    // through it, built the exact same way an object's own surface is
    // (bounding-box scan, pad by 1, marching cubes, same zScale/center
    // transform) -- just against lungMask instead of maskVolume, and
    // always as a surface regardless of the Cubes/Surface toggle above
    // (a voxel-cube rendering of ~2.7M lung voxels would be both far
    // slower and far less legible than one smooth surface).
    if (showLung && lungMask) {
      let lx0 = lungMask.columns, lx1 = -1, ly0 = lungMask.rows, ly1 = -1, lz0 = lungMask.numSlices, lz1 = -1;
      for (let z = 0; z < lungMask.numSlices; z++) {
        const zBase = z * lungMask.rows * lungMask.columns;
        for (let y = 0; y < lungMask.rows; y++) {
          const yBase = zBase + y * lungMask.columns;
          for (let x = 0; x < lungMask.columns; x++) {
            if (lungMask.data[yBase + x]) {
              if (x < lx0) lx0 = x;
              if (x > lx1) lx1 = x;
              if (y < ly0) ly0 = y;
              if (y > ly1) ly1 = y;
              if (z < lz0) lz0 = z;
              if (z > lz1) lz1 = z;
            }
          }
        }
      }
      if (lx1 >= 0) {
        const bx0 = Math.max(0, lx0 - 1), bx1 = Math.min(lungMask.columns - 1, lx1 + 1);
        const by0 = Math.max(0, ly0 - 1), by1 = Math.min(lungMask.rows - 1, ly1 + 1);
        const bz0 = Math.max(0, lz0 - 1), bz1 = Math.min(lungMask.numSlices - 1, lz1 + 1);
        const dimsX = bx1 - bx0 + 1, dimsY = by1 - by0 + 1, dimsZ = bz1 - bz0 + 1;

        const { positions, normals } = marchingCubes(
          (lxv, lyv, lzv) =>
            lungMask.data[(bz0 + lzv) * lungMask.rows * lungMask.columns + (by0 + lyv) * lungMask.columns + (bx0 + lxv)],
          { x: dimsX, y: dimsY, z: dimsZ },
          0.5
        );
        if (positions.length > 0) {
          const world = new Float32Array(positions.length);
          for (let i = 0; i < positions.length; i += 3) {
            world[i] = positions[i] + bx0 - centerX;
            world[i + 1] = positions[i + 1] + by0 - centerY;
            world[i + 2] = (positions[i + 2] + bz0) * zScale - centerZ;
          }
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute("position", new THREE.BufferAttribute(world, 3));
          geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
          const material = new THREE.MeshStandardMaterial({
            color: 0xf2b8c6,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.3,
            depthWrite: false,
          });
          const mesh = new THREE.Mesh(geometry, material);
          group.add(mesh);
          disposablesRef.current.push(geometry, material);
        }
      }
    }

    setVoxelCount(renderMode === "cubes" ? totalVoxels : null);

    // Frame the camera on the whole volume's bounding box the first time
    // (and every rebuild -- cheap, and keeps new/grown objects in view).
    const maxExtent = Math.max(columns, rows, numSlices * zScale, 1);
    const distance = maxExtent * 1.6;
    camera.position.set(distance * 0.6, distance * 0.5, distance * 0.6);
    camera.near = maxExtent * 0.01;
    camera.far = maxExtent * 20;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();
  }

  useEffect(() => {
    rebuild();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, renderMode, showLung, lungMask]);

  /** Toggles the Lung layer -- fetches the mask on first use (skipped
   * if already cached in state, since the underlying CT data can't
   * change mid-session) and lets the rebuild effect above pick up the
   * new showLung/lungMask state. */
  function toggleLung() {
    if (showLung) {
      setShowLung(false);
      return;
    }
    setShowLung(true);
    if (lungMask || !seriesId) return;
    setLungLoading(true);
    fetchLungMask(seriesId)
      .then(setLungMask)
      .catch(() => setShowLung(false))
      .finally(() => setLungLoading(false));
  }

  return (
    <div className="relative flex h-full w-full flex-col">
      <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-[#333] bg-[#111] px-2 py-1">
        <button
          onClick={() => setRenderMode("cubes")}
          className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
            renderMode === "cubes" ? "border-blue-500 bg-blue-500/20 text-blue-300" : "border-[#444] bg-[#2a2a3e] text-gray-300 hover:bg-[#333]"
          }`}
        >
          Cubes
        </button>
        <button
          onClick={() => setRenderMode("surface")}
          className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
            renderMode === "surface" ? "border-blue-500 bg-blue-500/20 text-blue-300" : "border-[#444] bg-[#2a2a3e] text-gray-300 hover:bg-[#333]"
          }`}
        >
          Surface
        </button>
        <button
          onClick={toggleLung}
          disabled={lungLoading || !seriesId}
          title="Auto-segmented from the CT data (HU threshold), not something you paint"
          className={`rounded border px-2 py-0.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            showLung ? "border-pink-400 bg-pink-400/20 text-pink-300" : "border-[#444] bg-[#2a2a3e] text-gray-300 hover:bg-[#333]"
          }`}
        >
          {lungLoading ? "Lung…" : "Lung"}
        </button>
        <button
          onClick={rebuild}
          className="ml-auto rounded border border-[#444] bg-[#2a2a3e] px-2 py-0.5 text-[11px] text-gray-300 transition-colors hover:bg-[#333]"
          title="Rebuild from the current annotations (doesn't update live while drawing)"
        >
          Refresh
        </button>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1" />
      {voxelCount !== null && (
        <div className="pointer-events-none absolute bottom-1 left-2 text-[10px] text-gray-500">{voxelCount} voxels</div>
      )}
    </div>
  );
}
