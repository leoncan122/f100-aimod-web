import * as THREE from 'three';

/**
 * Mapa de alturas local para caminar sobre el paisaje de la cinemática.
 *
 * `Paisaje_Terreno` tiene ~260k triángulos: lanzar un raycast por pie y por
 * frame contra esa malla es inasumible sin BVH. Al bajarse del vehículo se
 * rasteriza UNA vez la parte de las mallas de suelo que cae en un cuadrado
 * alrededor del punto de bajada, guardando la altura máxima por celda (la cara
 * superior), y después cada consulta es una interpolación bilineal.
 */
export interface Heightfield {
  /** Altura del suelo en (x, z) de mundo. Fuera del parche devuelve el borde. */
  at(x: number, z: number): number;
  /** Centro y semilado del parche, para limitar por dónde se puede caminar. */
  center: THREE.Vector2;
  half: number;
}

export function buildHeightfield(
  meshes: THREE.Mesh[],
  center: THREE.Vector3,
  half = 32,
  cell = 0.2,
): Heightfield {
  const n = Math.ceil((half * 2) / cell) + 1;
  const h = new Float32Array(n * n).fill(-Infinity);
  const x0 = center.x - half;
  const z0 = center.z - half;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) continue;
    const index = mesh.geometry.getIndex();
    const tris = index ? index.count / 3 : pos.count / 3;
    const m = mesh.matrixWorld;
    for (let t = 0; t < tris; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(m);
      b.fromBufferAttribute(pos, i1).applyMatrix4(m);
      c.fromBufferAttribute(pos, i2).applyMatrix4(m);
      const minX = Math.min(a.x, b.x, c.x), maxX = Math.max(a.x, b.x, c.x);
      const minZ = Math.min(a.z, b.z, c.z), maxZ = Math.max(a.z, b.z, c.z);
      if (maxX < x0 || minX > x0 + half * 2 || maxZ < z0 || minZ > z0 + half * 2) continue;
      // caras casi verticales no son suelo
      const area = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
      if (Math.abs(area) < 1e-9) continue;
      const ix0 = Math.max(0, Math.ceil((minX - x0) / cell)), ix1 = Math.min(n - 1, Math.floor((maxX - x0) / cell));
      const iz0 = Math.max(0, Math.ceil((minZ - z0) / cell)), iz1 = Math.min(n - 1, Math.floor((maxZ - z0) / cell));
      for (let iz = iz0; iz <= iz1; iz++) {
        const pz = z0 + iz * cell;
        for (let ix = ix0; ix <= ix1; ix++) {
          const px = x0 + ix * cell;
          // coordenadas baricéntricas en el plano XZ
          const w0 = ((b.x - px) * (c.z - pz) - (c.x - px) * (b.z - pz)) / area;
          const w1 = ((c.x - px) * (a.z - pz) - (a.x - px) * (c.z - pz)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
          const y = w0 * a.y + w1 * b.y + w2 * c.y;
          const k = iz * n + ix;
          if (y > h[k]!) h[k] = y;
        }
      }
    }
  }

  // celdas sin triángulo (huecos de la malla): se rellenan con el vecino válido más cercano
  let fallback = center.y;
  for (let k = 0; k < h.length; k++) if (Number.isFinite(h[k]!)) { fallback = h[k]!; break; }
  for (let pass = 0; pass < 4; pass++) {
    for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) {
      const k = iz * n + ix;
      if (Number.isFinite(h[k]!)) continue;
      let s = 0, c2 = 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const jx = ix + dx, jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= n || jz >= n) continue;
        const v = h[jz * n + jx]!;
        if (Number.isFinite(v)) { s += v; c2++; }
      }
      if (c2) h[k] = s / c2;
    }
  }
  for (let k = 0; k < h.length; k++) if (!Number.isFinite(h[k]!)) h[k] = fallback;

  return {
    center: new THREE.Vector2(center.x, center.z),
    half,
    at(x: number, z: number) {
      const fx = THREE.MathUtils.clamp((x - x0) / cell, 0, n - 1.0001);
      const fz = THREE.MathUtils.clamp((z - z0) / cell, 0, n - 1.0001);
      const ix = Math.floor(fx), iz = Math.floor(fz);
      const tx = fx - ix, tz = fz - iz;
      const k = iz * n + ix;
      const top = h[k]! * (1 - tx) + h[k + 1]! * tx;
      const bot = h[k + n]! * (1 - tx) + h[k + n + 1]! * tx;
      return top * (1 - tz) + bot * tz;
    },
  };
}
