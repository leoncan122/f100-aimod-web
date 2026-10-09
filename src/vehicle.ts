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
  /** Radio real del neumático (m), medido desde el eje de giro. */
  wheelRadius: number;
}

/**
 * Radio real de una rueda: distancia máxima del eje de giro a sus vértices,
 * medida en el plano perpendicular al eje (X local → plano YZ).
 *
 * No sirve un Box3 del nodo: engloba frenos y suspensión, que sobresalen por
 * detrás del neumático y dan un radio inflado (0.52 m en vez de 0.37 m).
 */
export function measureWheelRadius(node: THREE.Object3D): number {
  const inv = new THREE.Matrix4().copy(node.matrixWorld).invert();
  const p = new THREE.Vector3();
  let rMax = 0;
  node.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pa = mesh.geometry?.attributes.position as THREE.BufferAttribute | undefined;
    if (!pa) return;
    for (let i = 0; i < pa.count; i++) {
      p.fromBufferAttribute(pa, i);
      mesh.localToWorld(p);
      p.applyMatrix4(inv);
      const r = Math.hypot(p.y, p.z);
      if (r > rMax) rMax = r;
    }
  });
  return rMax;
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

  // Centrar en el origen. En Y se alinea por el CONTACTO DE LAS RUEDAS
  // (eje de giro − radio real), no por el Box3 del conjunto: ese bbox lo
  // define la pieza más baja (suspensión/frenos, ~14 cm por debajo del
  // neumático) y además oscila hasta 14 cm al girar las ruedas, porque la
  // llanta no es un cilindro perfecto. Alinear por contacto deja el
  // vehículo apoyado y estable durante toda la animación.
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  let wheelRadius = 0;
  let contactY = box.min.y; // fallback si el rig no trae ruedas
  if (wheels.length) {
    const wp = new THREE.Vector3();
    let lowest = Infinity;
    for (const w of wheels) {
      const r = measureWheelRadius(w);
      if (r > wheelRadius) wheelRadius = r;
      w.getWorldPosition(wp);
      lowest = Math.min(lowest, wp.y - r);
    }
    contactY = lowest;
  }

  const inner = root.children[0];
  if (inner) {
    inner.position.x -= center.x;
    inner.position.y -= contactY;
    inner.position.z -= center.z;
  }

  return { root, wheels, steering, size, wheelRadius };
}
