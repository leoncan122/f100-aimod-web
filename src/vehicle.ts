import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

const VEHICLE_NAMES = ['HandlerVehicle005', 'HandlerVehicle.005'];

export interface Vehicle {
  /** Grupo con la camioneta ya desligada del paisaje. */
  root: THREE.Group;
  /** Nodos ROT_Rueda_* — giran sobre su eje X local. */
  wheels: THREE.Object3D[];
  /** Nodos PIV_Dir_* — pivotes de dirección (giro Y). */
  steering: THREE.Object3D[];
  size: THREE.Vector3;
}

/**
 * f100.glb contiene la escena completa (~843 m). Extrae el subárbol del
 * vehículo conservando su transformada mundial y libera el resto SIN tocar
 * geometrías/materiales/texturas compartidas con la camioneta.
 */
export function extractVehicle(gltf: GLTF): Vehicle {
  const source = VEHICLE_NAMES.map((n) => gltf.scene.getObjectByName(n)).find(Boolean);

  const root = new THREE.Group();
  root.name = 'F100';

  if (source) {
    gltf.scene.updateMatrixWorld(true);
    root.attach(source);

    const keepGeo = new Set<THREE.BufferGeometry>();
    const keepMat = new Set<THREE.Material>();
    const keepTex = new Set<THREE.Texture>();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (m.geometry) keepGeo.add(m.geometry);
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (!mat) continue;
        keepMat.add(mat);
        for (const v of Object.values(mat)) {
          if (v && (v as THREE.Texture).isTexture) keepTex.add(v as THREE.Texture);
        }
      }
    });

    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (m.geometry && !keepGeo.has(m.geometry)) m.geometry.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (!mat || keepMat.has(mat)) continue;
        for (const v of Object.values(mat)) {
          const tex = v as THREE.Texture;
          if (tex?.isTexture && !keepTex.has(tex)) tex.dispose();
        }
        mat.dispose();
      }
    });
    gltf.scene.clear();
  } else {
    root.add(gltf.scene);
  }

  const wheels: THREE.Object3D[] = [];
  const steering: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (/^ROT_Rueda_/.test(o.name)) wheels.push(o);
    if (/^PIV_Dir_/.test(o.name)) steering.push(o);
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });

  // Centrar en el origen, apoyado en Y=0, para poder colocarlo en cualquier escena.
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const inner = root.children[0];
  if (inner) {
    inner.position.x -= center.x;
    inner.position.y -= box.min.y;
    inner.position.z -= center.z;
  }

  return { root, wheels, steering, size };
}
