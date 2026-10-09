import * as THREE from 'three';

/**
 * Silueta del torso de un personaje para colisiones entre cuerpos.
 *
 * Un círculo fijo no sirve: un cuerpo es ancho de hombro a hombro (con los
 * brazos colgando) y estrecho de pecho a espalda. Dos personas de frente se
 * tocan mucho antes que de costado… al revés. Se usa una elipse orientada con
 * el rumbo del personaje, medida sobre la malla deformada por el esqueleto.
 *
 * Marco: el personaje mira a +Z con rumbo 0; su izquierda es +X.
 */
export interface BodyShape {
  /** del eje vertical de la raíz a lo más adelantado (pecho) */
  front: number;
  /** del eje a lo más atrasado (espalda, glúteos) */
  back: number;
  /** media anchura, brazos incluidos */
  half: number;
}

export interface BodyCollider {
  x: number;
  z: number;
  yaw: number;
  shape: BodyShape;
}

/**
 * Mide la silueta sobre la malla con la pose actual (skinning aplicado), solo
 * entre las alturas y0..y1 sobre la raíz: torso y brazos, no la cabeza ni las
 * manos que oscilan por debajo de la cadera. `stride` submuestrea los vértices.
 */
export function measureBody(meshes: THREE.Mesh[], root: THREE.Object3D, y0: number, y1: number, stride = 6): BodyShape {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const v = new THREE.Vector3();
  let front = 0, back = 0, half = 0;
  for (const mesh of meshes) {
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) continue;
    const skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? (mesh as THREE.SkinnedMesh) : null;
    skinned?.skeleton.update();
    for (let i = 0; i < pos.count; i += stride) {
      if (skinned) skinned.getVertexPosition(i, v);
      else v.fromBufferAttribute(pos, i);
      v.applyMatrix4(mesh.matrixWorld).applyMatrix4(inv);
      if (v.y < y0 || v.y > y1) continue;
      if (v.z > front) front = v.z;
      if (-v.z > back) back = -v.z;
      const ax = Math.abs(v.x);
      if (ax > half) half = ax;
    }
  }
  return { front, back, half };
}

/** Distancia del centro al borde de la elipse en la dirección de mundo (dx, dz) unitaria. */
export function bodyExtent(c: BodyCollider, dx: number, dz: number): number {
  const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
  const lx = dx * cs - dz * sn; // hacia su izquierda
  const lz = dx * sn + dz * cs; // hacia delante
  const az = lz >= 0 ? c.shape.front : c.shape.back;
  const k = (lx / Math.max(c.shape.half, 1e-3)) ** 2 + (lz / Math.max(az, 1e-3)) ** 2;
  return 1 / Math.sqrt(Math.max(k, 1e-9));
}

/**
 * Si `self` invade a `other`, devuelve dónde debe quedar la raíz de `self`
 * (separada a lo largo de la línea entre centros, con holgura `gap`).
 */
export function separate(self: BodyCollider, other: BodyCollider, gap: number): { x: number; z: number } | null {
  let dx = self.x - other.x, dz = self.z - other.z;
  let d = Math.hypot(dx, dz);
  if (d < 1e-4) { dx = Math.sin(self.yaw); dz = Math.cos(self.yaw); d = 0; } else { dx /= d; dz /= d; }
  const need = bodyExtent(self, -dx, -dz) + bodyExtent(other, dx, dz) + gap;
  if (d >= need) return null;
  return { x: other.x + dx * need, z: other.z + dz * need };
}

/** Obstáculo plano entre dos puntos (una puerta abierta vista desde arriba). */
export interface Segment { ax: number; az: number; bx: number; bz: number; r: number }

/**
 * Si un cuerpo de radio `radius` centrado en (x, z) invade el segmento
 * (engordado `seg.r`), devuelve la posición corregida; si no, null.
 */
export function pushFromSegment(x: number, z: number, radius: number, seg: Segment): { x: number; z: number } | null {
  const abx = seg.bx - seg.ax, abz = seg.bz - seg.az;
  const len2 = abx * abx + abz * abz || 1e-9;
  const t = Math.min(1, Math.max(0, ((x - seg.ax) * abx + (z - seg.az) * abz) / len2));
  const cx = seg.ax + abx * t, cz = seg.az + abz * t;
  let dx = x - cx, dz = z - cz;
  const d = Math.hypot(dx, dz), need = radius + seg.r;
  if (d >= need) return null;
  if (d < 1e-5) { dx = -abz; dz = abx; } // justo encima: hacia un lado del segmento
  const l = Math.hypot(dx, dz) || 1;
  return { x: cx + (dx / l) * need, z: cz + (dz / l) * need };
}

/** Radio "redondo" equivalente de una silueta, para obstáculos sin orientación. */
export const roundRadius = (s: BodyShape) => (s.half + Math.min(s.front, s.back)) / 2;
