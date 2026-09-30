import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

const draco = new DRACOLoader().setDecoderPath(
  'https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/draco/gltf/',
);
const loader = new GLTFLoader().setDRACOLoader(draco);

/**
 * Los .glb publicados están optimizados con `npm run models:optimize`
 * (poda al vehículo + Draco + texturas WebP 1024): 24,7 MB -> 8,3 MB.
 * `f100-truck.glb` ya viene recortado, pero extractVehicle() sigue siendo
 * necesario para centrar el modelo y medir el radio de rueda.
 */
export const MODELS = {
  scene: 'escena.glb',
  truck: 'f100-truck.glb',
  cameraTrack: 'camara.json',
} as const;

export const asset = (file: string) => `${import.meta.env.BASE_URL}models/${file}`;

export function loadGLTF(file: string, onProgress?: (pct: number) => void): Promise<GLTF> {
  return new Promise((resolve, reject) => {
    loader.load(
      asset(file),
      resolve,
      (e) => {
        if (e.total && onProgress) onProgress(e.loaded / e.total);
      },
      reject,
    );
  });
}

export async function loadJSON<T>(file: string): Promise<T> {
  const res = await fetch(asset(file));
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function disposeObject(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m) continue;
      for (const v of Object.values(m)) {
        if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
      }
      m.dispose();
    }
  });
}

export function disposeLoaders() {
  draco.dispose();
}
