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
  /** escena.glb sin paisaje: camioneta + perro animados (scripts/extract-cinematic-vehicle.mjs). */
  vehicleScene: 'escena-vehiculo.glb',
  truck: 'f100-truck.glb',
  cameraTrack: 'camara.json',
  /** Conductor de la cinemática (scripts/optimize-character.mjs). */
  character: 'personaje.glb',
  /** Aitziber, la acompañante de la cinemática three.js (scripts/optimize-aitzi.mjs). */
  companion: 'aitzi.glb',
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

/**
 * Quita la transmisión (refracción) de los materiales de la camioneta.
 *
 * Con un solo material visible con `transmission > 0`, three.js renderiza cada
 * frame la escena entera una vez más en una textura para que el cristal "vea"
 * lo que tiene detrás: el coste del frame se duplica (medido a 1080p en Intel
 * UHD: ~30 → ~15 ms). En la F100 la traen tres materiales exportados de Blender:
 *  - `Metal` (llantas Pontiac): transmisión 1, un error — el metal no es translúcido.
 *  - `Faro_Vidrio` y `Faro_Posicion`: cristal de faros y pilotos; con una
 *    transparencia normal (como `Vidrio_Cabina`) se ven igual por mucho menos.
 * Devuelve cuántos materiales se han cambiado.
 */
export function removeTransmission(root: THREE.Object3D): number {
  const done = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const mat = m as THREE.MeshPhysicalMaterial;
      if (!mat?.isMeshPhysicalMaterial || done.has(mat) || !(mat.transmission > 0)) continue;
      const glass = /vidrio|faro|posici|cristal|glass|lens/i.test(mat.name);
      if (glass) {
        // cristal: transparencia simple, más opaca cuanto menos dejaba pasar
        mat.opacity = THREE.MathUtils.lerp(1, 0.3, mat.transmission);
        mat.transparent = true;
        mat.depthWrite = false;
      } else {
        mat.transparent = false;
        mat.opacity = 1;
      }
      mat.transmission = 0;
      mat.needsUpdate = true;
      done.add(mat);
    }
  });
  return done.size;
}
