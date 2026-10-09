import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Paisaje de la cinemática generado con three.js, sin assets.
 *
 * Sustituye al paisaje exportado de Blender (terreno de 259k triángulos con
 * MeshStandardMaterial, 33 rocas de 5k triángulos cada una, carretera con
 * talud...). La camioneta y el perro siguen siendo los del glb, con su
 * animación horneada, así que el terreno se construye ALREDEDOR del recorrido
 * real del vehículo: la carretera es el camino muestreado del mixer y el
 * terreno se aplana hacia ella. Así las ruedas apoyan sin tocar la animación.
 *
 * Presupuesto: 10 draw calls para todo el escenario (terreno, agua, asfalto,
 * arcén, líneas, árboles, rocas, postes, guardarraíles, cielo). Lo repetido es
 * InstancedMesh y el sombreado es Lambert salvo el agua y el metal.
 */

export interface LandscapeOptions {
  /** Posición del origen del vehículo a lo largo de la película, en orden. */
  path: THREE.Vector3[];
  /** Altura de la superficie de rodadura respecto al origen del vehículo. */
  groundOffset: number;
  /**
   * Líneas de visión cámara → camioneta del track (y de la cámara trasera).
   * El terreno se rebaja y los árboles se apartan para no tapar ninguna.
   */
  sightlines: [THREE.Vector3, THREE.Vector3][];
  /** Donde se detiene la camioneta al final (mirador). */
  stop: THREE.Vector3;
  lake: { center: THREE.Vector3; level: number };
  /** Dirección hacia el sol (normalizada). */
  sun: THREE.Vector3;
  fogColor: THREE.ColorRepresentation;
}

export interface Landscape {
  group: THREE.Group;
  /** Mallas sobre las que camina el conductor (heightfield de character/terrain). */
  groundMeshes: THREE.Mesh[];
  /** Altura del terreno generado en (x, z). */
  heightAt: (x: number, z: number) => number;
  /** Mantiene el domo del cielo centrado en la cámara. */
  update: (camera: THREE.Camera) => void;
  stats: { triangles: number; drawCalls: number; trees: number; rocks: number; buildMs: number };
  dispose: () => void;
}

// ───────────────────────── dimensiones
// Mismo recuadro que Paisaje_Terreno en el glb (840 × 840 m).
const X0 = -470, X1 = 370, Z0 = -570, Z1 = 270;
const SEG = 240; // 3,5 m por celda → 58k vértices, 115k triángulos
const ROAD_HALF = 3.6;
const SHOULDER = 1.4;
const FLAT = 6.5; // m desde el eje en los que el terreno queda bajo la carretera
const BLEND = 26; // m de talud hasta el terreno natural
/** Radio visible de la orilla: el de las rocas Roca_Orilla del glb (65–72 m). */
const SHORE_R = 66;
/** Hasta dónde llega el disco de agua (queda oculto bajo el terreno de la orilla). */
const WATER_R = 100;

// ───────────────────────── ruido determinista (mismo paisaje en cada carga)
function hash2(ix: number, iz: number, seed: number) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function valueNoise(x: number, z: number, seed: number) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return (a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz) * 2 - 1;
}
/** fbm en [-1, 1] aprox. */
function fbm(x: number, z: number, seed: number, oct = 5) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += valueNoise(x * f, z * f, seed + i * 17) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s / norm;
}
const smooth = (a: number, b: number, x: number) => {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ───────────────────────── eje de la carretera
interface Road {
  pts: THREE.Vector3[]; // superficie de rodadura, cada ~2 m
  normals: THREE.Vector3[]; // horizontal, hacia la derecha de la marcha
  dist: number[]; // distancia acumulada
}

function buildRoad(path: THREE.Vector3[], groundOffset: number): Road {
  // fuera duplicados: al inicio y en la parada el vehículo no se mueve
  const raw: THREE.Vector3[] = [];
  for (const p of path) if (!raw.length || raw[raw.length - 1]!.distanceTo(p) > 0.5) raw.push(p.clone());
  if (raw.length < 2) raw.push(raw[0]!.clone().add(new THREE.Vector3(0, 0, 1)));
  // prolongar el comienzo 80 m hacia atrás: la cámara ve carretera por detrás
  const d0 = raw[0]!.clone().sub(raw[1]!).setY(0).normalize();
  const n = raw.length;
  const d1 = raw[n - 1]!.clone().sub(raw[n - 2]!).setY(0).normalize();
  raw.unshift(raw[0]!.clone().addScaledVector(d0, 80));
  raw.push(raw[n]!.clone().addScaledVector(d1, 10));

  const curve = new THREE.CatmullRomCurve3(raw, false, 'centripetal');
  const count = Math.max(2, Math.ceil(curve.getLength() / 2));
  const pts = curve.getSpacedPoints(count).map((p) => p.setY(p.y + groundOffset));
  const normals: THREE.Vector3[] = [];
  const dist: number[] = [];
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(pts.length - 1, i + 1)]!;
    const t = b.clone().sub(a).setY(0).normalize();
    normals.push(new THREE.Vector3(-t.z, 0, t.x));
    if (i > 0) acc += pts[i]!.distanceTo(pts[i - 1]!);
    dist.push(acc);
  }
  return { pts, normals, dist };
}

/**
 * Distancia horizontal al eje, altura de la carretera en el punto más cercano y
 * una altura de referencia suave (media ponderada por distancia inversa) para
 * el terreno lejano: con la del punto más cercano el terreno daría un escalón
 * allí donde el punto más cercano salta de un tramo de carretera a otro.
 */
function roadQuery(road: Road, x: number, z: number) {
  const { pts } = road;
  let best = Infinity, yr = 0, wsum = 0, ysum = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    const abx = b.x - a.x, abz = b.z - a.z;
    const len2 = abx * abx + abz * abz || 1e-6;
    const t = THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.z) * abz) / len2, 0, 1);
    const px = a.x + abx * t - x, pz = a.z + abz * t - z;
    const d2 = px * px + pz * pz;
    const y = a.y + (b.y - a.y) * t;
    if (d2 < best) { best = d2; yr = y; }
    const w = 1 / Math.pow(d2 + 400, 1.5);
    wsum += w;
    ysum += w * y;
  }
  return { d: Math.sqrt(best), yr, ySmooth: ysum / wsum };
}

// ───────────────────────── materiales compartidos
function lambert(color: THREE.ColorRepresentation, extra: THREE.MeshLambertMaterialParameters = {}) {
  return new THREE.MeshLambertMaterial({ color, ...extra });
}

export function createProceduralLandscape(opts: LandscapeOptions): Landscape {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'PaisajeProcedural';
  const road = buildRoad(opts.path, opts.groundOffset);
  const lc = opts.lake.center;
  const level = opts.lake.level;
  const stopY = opts.stop.y + opts.groundOffset;

  // ───────────────────────── terreno: campo de alturas
  const N = SEG + 1;
  const dx = (X1 - X0) / SEG, dz = (Z1 - Z0) / SEG;
  const H = new Float32Array(N * N);
  const D = new Float32Array(N * N); // distancia a la carretera (para colorear)
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const x = X0 + ix * dx, z = Z0 + iz * dz;
      const { d, yr, ySmooth } = roadQuery(road, x, z);

      // colinas suaves que crecen al alejarse de la carretera
      const hillMask = smooth(8, 150, d);
      const hills = hillMask * (fbm(x * 0.0055, z * 0.0055, 11) * 24 + 9) + smooth(4, 40, d) * fbm(x * 0.04, z * 0.04, 29, 3) * 2.2;
      // cordillera de fondo: anillo exterior, recortada contra el cielo
      const dc = Math.hypot(x + 50, z + 150);
      const ridge = 1 - Math.abs(fbm(x * 0.0035, z * 0.0035, 53, 4));
      const mountains = smooth(260, 430, dc) * (22 + 85 * ridge * ridge);
      let h = ySmooth + hills + mountains;

      // vaso del lago y orilla en pendiente
      const rl = Math.hypot(x - lc.x, z - lc.z);
      const shore = rl < SHORE_R
        ? level - 0.8 - 6 * (1 - (rl / SHORE_R) ** 2)
        : level - 0.8 + (rl - SHORE_R) * 0.42;
      h = THREE.MathUtils.lerp(h, shore, 1 - smooth(SHORE_R, SHORE_R + 55, rl));

      // explanada del mirador
      const dp = Math.hypot(x - opts.stop.x, z - opts.stop.z);
      h = THREE.MathUtils.lerp(h, stopY - 0.04, 1 - smooth(24, 46, dp));

      // carretera: plano bajo el asfalto y talud hasta el terreno natural
      h = THREE.MathUtils.lerp(h, yr - 0.22, 1 - smooth(FLAT, FLAT + BLEND, d));
      if (dp < 24) h = Math.max(h, stopY - 0.04);

      H[iz * N + ix] = h;
      D[iz * N + ix] = d;
    }
  }

  // Ninguna cámara puede quedar bajo tierra ni con una loma entre ella y la
  // camioneta: se rebaja el terreno en un cono bajo cada línea de visión.
  const lower = (x: number, z: number, y: number, r: number) => {
    const cx = Math.round((x - X0) / dx), cz = Math.round((z - Z0) / dz);
    const rc = Math.ceil(r / dx);
    for (let iz = Math.max(0, cz - rc); iz <= Math.min(N - 1, cz + rc); iz++) {
      for (let ix = Math.max(0, cx - rc); ix <= Math.min(N - 1, cx + rc); ix++) {
        const dd = Math.hypot(X0 + ix * dx - x, Z0 + iz * dz - z);
        if (dd > r) continue;
        const lim = y + dd * 0.6;
        const k = iz * N + ix;
        if (H[k]! > lim) H[k] = lim;
      }
    }
  };
  for (const [cam, target] of opts.sightlines) {
    lower(cam.x, cam.z, cam.y - 1.6, 9);
    for (let s = 1; s <= 8; s++) {
      const u = s / 10; // hasta el 80 %: junto a la camioneta manda la carretera
      lower(
        THREE.MathUtils.lerp(cam.x, target.x, u),
        THREE.MathUtils.lerp(cam.z, target.z, u),
        THREE.MathUtils.lerp(cam.y, target.y, u) - 1.2,
        6,
      );
    }
  }

  const heightAt = (x: number, z: number) => {
    const fx = THREE.MathUtils.clamp((x - X0) / dx, 0, SEG - 1e-4);
    const fz = THREE.MathUtils.clamp((z - Z0) / dz, 0, SEG - 1e-4);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const k = iz * N + ix;
    const top = H[k]! * (1 - tx) + H[k + 1]! * tx;
    const bot = H[k + N]! * (1 - tx) + H[k + N + 1]! * tx;
    return top * (1 - tz) + bot * tz;
  };

  // geometría del terreno
  const pos = new Float32Array(N * N * 3);
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const k = iz * N + ix;
    pos[k * 3] = X0 + ix * dx;
    pos[k * 3 + 1] = H[k]!;
    pos[k * 3 + 2] = Z0 + iz * dz;
  }
  const idx = new Uint32Array(SEG * SEG * 6);
  let o = 0;
  for (let iz = 0; iz < SEG; iz++) for (let ix = 0; ix < SEG; ix++) {
    const a = iz * N + ix, b = a + 1, c = a + N, d = c + 1;
    idx[o++] = a; idx[o++] = c; idx[o++] = b;
    idx[o++] = b; idx[o++] = c; idx[o++] = d;
  }
  const terrainGeo = new THREE.BufferGeometry();
  terrainGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  terrainGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  terrainGeo.computeVertexNormals();

  // color por vértice: hierba seca/verde, tierra junto al arcén, roca en las
  // pendientes, arena en la orilla y fondo oscuro bajo el agua
  const nrm = terrainGeo.getAttribute('normal') as THREE.BufferAttribute;
  const col = new Float32Array(N * N * 3);
  const cGreen = new THREE.Color(0x4a6a28), cDry = new THREE.Color(0x7f8540);
  const cDirt = new THREE.Color(0x8a7254), cRock = new THREE.Color(0x857a6a);
  const cSand = new THREE.Color(0xbfa877), cDeep = new THREE.Color(0x3a4a3c);
  const cMount = new THREE.Color(0x7c8a6a);
  const c = new THREE.Color();
  for (let k = 0; k < N * N; k++) {
    const x = pos[k * 3]!, y = pos[k * 3 + 1]!, z = pos[k * 3 + 2]!;
    c.copy(cGreen).lerp(cDry, THREE.MathUtils.clamp(fbm(x * 0.012, z * 0.012, 71, 4) * 0.9 + 0.45, 0, 1));
    c.lerp(cMount, smooth(60, 160, y));
    c.lerp(cRock, smooth(0.86, 0.62, nrm.getY(k)));
    c.lerp(cDirt, 0.75 * (1 - smooth(ROAD_HALF + SHOULDER, ROAD_HALF + SHOULDER + 2.5, D[k]!)));
    const rl = Math.hypot(x - lc.x, z - lc.z);
    if (rl < SHORE_R + 25) c.lerp(cSand, (1 - smooth(level + 0.6, level + 2.2, y)));
    c.lerp(cDeep, smooth(level - 0.4, level - 3, y));
    // variación fina para que no se vea plano
    c.multiplyScalar(0.92 + 0.16 * hash2(Math.round(x * 0.7), Math.round(z * 0.7), 5));
    col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
  }
  terrainGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const terrainMat = lambert(0xffffff, { vertexColors: true });
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.name = 'Proc_Terreno';
  terrain.receiveShadow = true;
  group.add(terrain);

  // ───────────────────────── agua
  const waterGeo = new THREE.CircleGeometry(WATER_R, 64).rotateX(-Math.PI / 2);
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x1f5a7a, roughness: 0.3, metalness: 0, envMapIntensity: 0.45 });
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.name = 'Proc_Lago';
  water.position.set(lc.x, level, lc.z);
  water.receiveShadow = true;
  group.add(water);

  // ───────────────────────── carretera: asfalto, arcén y líneas
  // La explanada del mirador no lleva asfalto.
  const onRoad = road.pts.map((p) => Math.hypot(p.x - opts.stop.x, p.z - opts.stop.z) > 20);
  const ribbon = (inner: number, outer: number, yIn: number, yOut: number, both: boolean, keep: (i: number) => boolean) => {
    const v: number[] = [], ix: number[] = [];
    const sides = both ? [1, -1] : [1];
    for (const s of sides) {
      let prev = -1;
      for (let i = 0; i < road.pts.length; i++) {
        if (!keep(i)) { prev = -1; continue; }
        const p = road.pts[i]!, n = road.normals[i]!;
        const base = v.length / 3;
        v.push(p.x + n.x * inner * s, p.y + yIn, p.z + n.z * inner * s);
        v.push(p.x + n.x * outer * s, p.y + yOut, p.z + n.z * outer * s);
        if (prev >= 0) {
          // orientación de las caras según el lado para que miren hacia arriba
          // (normals[] apunta a la derecha de la marcha)
          if (s > 0) ix.push(prev, prev + 1, base, prev + 1, base + 1, base);
          else ix.push(prev, base, prev + 1, prev + 1, base, base + 1);
        }
        prev = base;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.setIndex(ix);
    g.computeVertexNormals();
    return g;
  };
  const asphaltGeo = ribbon(0, ROAD_HALF, 0.02, 0.02, true, (i) => onRoad[i]!);
  const asphalt = new THREE.Mesh(asphaltGeo, lambert(0x4b4845, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  asphalt.name = 'Proc_Asfalto';
  asphalt.receiveShadow = true;
  const shoulderGeo = ribbon(ROAD_HALF, ROAD_HALF + SHOULDER, 0.0, -0.18, true, (i) => onRoad[i]!);
  const shoulder = new THREE.Mesh(shoulderGeo, lambert(0x8e7f66, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  shoulder.name = 'Proc_Arcen';
  shoulder.receiveShadow = true;

  // líneas: bordes continuos y eje discontinuo (3 m pintados cada 9 m)
  const edgeL = ribbon(ROAD_HALF - 0.35, ROAD_HALF - 0.2, 0.04, 0.04, true, (i) => onRoad[i]!);
  const dashed = (i: number) => onRoad[i]! && road.dist[i]! % 9 < 3.2;
  const centre = ribbon(-0.07, 0.07, 0.04, 0.04, false, dashed);
  const linesGeo = mergeGeometries([edgeL, centre])!;
  edgeL.dispose();
  centre.dispose();
  const lines = new THREE.Mesh(linesGeo, lambert(0xe6e1d3, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  lines.name = 'Proc_Lineas';
  lines.receiveShadow = true;
  group.add(asphalt, shoulder, lines);

  // ───────────────────────── guardarraíles en el lado que cae
  const postGeo = new THREE.BoxGeometry(0.12, 0.85, 0.12).translate(0, 0.425, 0);
  const railGeo = new THREE.BoxGeometry(0.06, 0.3, 1);
  const metal = new THREE.MeshStandardMaterial({ color: 0xbfc4c9, metalness: 0.7, roughness: 0.38 });
  const posts: THREE.Matrix4[] = [];
  const rails: THREE.Matrix4[] = [];
  const RAIL_OFF = ROAD_HALF + 0.9;
  const q = new THREE.Quaternion();
  for (const s of [1, -1]) {
    let last: THREE.Vector3 | null = null;
    for (let i = 0; i < road.pts.length; i += 2) {
      const p = road.pts[i]!, n = road.normals[i]!;
      const probe = heightAt(p.x + n.x * s * 11, p.z + n.z * s * 11);
      const drops = onRoad[i]! && i > 40 && probe < p.y - 1.8;
      if (!drops) { last = null; continue; }
      const at = new THREE.Vector3(p.x + n.x * s * RAIL_OFF, p.y - 0.05, p.z + n.z * s * RAIL_OFF);
      posts.push(new THREE.Matrix4().makeTranslation(at.x, at.y, at.z));
      if (last) {
        const mid = at.clone().add(last).multiplyScalar(0.5).setY((at.y + last.y) / 2 + 0.68);
        const dir = at.clone().sub(last);
        const len = dir.length();
        q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.normalize());
        rails.push(new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, len)));
      }
      last = at;
    }
  }
  const postMesh = new THREE.InstancedMesh(postGeo, metal, Math.max(1, posts.length));
  posts.forEach((m, i) => postMesh.setMatrixAt(i, m));
  postMesh.count = posts.length;
  const railMesh = new THREE.InstancedMesh(railGeo, metal, Math.max(1, rails.length));
  rails.forEach((m, i) => railMesh.setMatrixAt(i, m));
  railMesh.count = rails.length;
  postMesh.castShadow = railMesh.castShadow = true;
  postMesh.name = 'Proc_Postes';
  railMesh.name = 'Proc_Guardarrail';
  postMesh.computeBoundingSphere();
  railMesh.computeBoundingSphere();
  group.add(postMesh, railMesh);

  // ───────────────────────── árboles (pinos low-poly instanciados)
  const tint = (g: THREE.BufferGeometry, hex: number) => {
    const cc = new THREE.Color(hex);
    const n = g.getAttribute('position').count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = cc.r; a[i * 3 + 1] = cc.g; a[i * 3 + 2] = cc.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    g.deleteAttribute('uv');
    return g;
  };
  const treeGeo = mergeGeometries([
    tint(new THREE.CylinderGeometry(0.22, 0.32, 2.4, 5).translate(0, 1.2, 0), 0x5a4030),
    tint(new THREE.ConeGeometry(2.3, 4.6, 7).translate(0, 4.0, 0), 0x35552a),
    tint(new THREE.ConeGeometry(1.7, 3.8, 7).translate(0, 6.2, 0), 0x3f6330),
    tint(new THREE.ConeGeometry(1.0, 2.8, 7).translate(0, 8.1, 0), 0x4a6e36),
  ])!;
  const MAX_TREES = 1100;
  const trees = new THREE.InstancedMesh(treeGeo, lambert(0xffffff, { vertexColors: true }), MAX_TREES);
  trees.name = 'Proc_Arboles';
  trees.castShadow = true;
  trees.receiveShadow = true;
  const sight2d = opts.sightlines.filter((_, i) => i % 2 === 0);
  /** True si un árbol de copa a `top` en (x, z) taparía alguna línea de visión. */
  const blocksView = (x: number, z: number, top: number) => {
    for (const [a, b] of sight2d) {
      const abx = b.x - a.x, abz = b.z - a.z;
      const len2 = abx * abx + abz * abz || 1e-6;
      const t = THREE.MathUtils.clamp(((x - a.x) * abx + (z - a.z) * abz) / len2, 0, 1);
      const px = a.x + abx * t - x, pz = a.z + abz * t - z;
      if (px * px + pz * pz > 25) continue;
      if (top > a.y + (b.y - a.y) * t - 0.5) return true;
    }
    return false;
  };
  const rand = rng(424242);
  const m4 = new THREE.Matrix4();
  const tc = new THREE.Color();
  let nTrees = 0;
  for (let tries = 0; tries < 30000 && nTrees < MAX_TREES; tries++) {
    const x = X0 + rand() * (X1 - X0), z = Z0 + rand() * (Z1 - Z0);
    if (Math.hypot(x + 50, z + 150) > 360) continue; // no en la cordillera
    const density = fbm(x * 0.009, z * 0.009, 91, 3);
    if (density < 0.05 + rand() * 0.25) continue; // bosquetes, no una alfombra
    const { d } = roadQuery(road, x, z);
    if (d < 11) continue;
    if (Math.hypot(x - lc.x, z - lc.z) < SHORE_R + 6) continue;
    if (Math.hypot(x - opts.stop.x, z - opts.stop.z) < 30) continue;
    const y = heightAt(x, z);
    if (y < level + 1.5) continue;
    const slope = Math.abs(heightAt(x + 2, z) - heightAt(x - 2, z)) + Math.abs(heightAt(x, z + 2) - heightAt(x, z - 2));
    if (slope > 3.2) continue;
    const s = 0.75 + rand() * 0.8;
    if (blocksView(x, z, y + 9.5 * s)) continue;
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rand() * Math.PI * 2);
    m4.compose(new THREE.Vector3(x, y - 0.2, z), q, new THREE.Vector3(s, s * (0.9 + rand() * 0.3), s));
    trees.setMatrixAt(nTrees, m4);
    trees.setColorAt(nTrees, tc.setHSL(0.24 + rand() * 0.06, 0.25 + rand() * 0.2, 0.42 + rand() * 0.18));
    nTrees++;
  }
  trees.count = nTrees;
  trees.computeBoundingSphere();
  group.add(trees);

  // ───────────────────────── rocas: orilla del lago, sueltas y la peña del mirador
  const rockGeo = (() => {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const k = 0.75 + 0.45 * (valueNoise(v.x * 1.7 + 3, v.z * 1.7 + v.y * 2.1, 7) * 0.5 + 0.5);
      p.setXYZ(i, v.x * k, v.y * k * 0.72, v.z * k);
    }
    const flat = g.toNonIndexed();
    g.dispose();
    flat.computeVertexNormals();
    return flat;
  })();
  const MAX_ROCKS = 260;
  const rocks = new THREE.InstancedMesh(rockGeo, lambert(0x8f887b, { flatShading: true }), MAX_ROCKS);
  rocks.name = 'Proc_Rocas';
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  let nRocks = 0;
  const putRock = (x: number, z: number, s: number, sink = 0.35) => {
    if (nRocks >= MAX_ROCKS) return;
    const y = heightAt(x, z) - s * sink;
    q.setFromEuler(new THREE.Euler(rand() * 0.4, rand() * Math.PI * 2, rand() * 0.4));
    m4.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s * (0.8 + rand() * 0.5), s, s * (0.8 + rand() * 0.5)));
    rocks.setMatrixAt(nRocks, m4);
    rocks.setColorAt(nRocks, tc.setHSL(0.09, 0.08 + rand() * 0.06, 0.45 + rand() * 0.15));
    nRocks++;
  };
  // peña del mirador: misma posición que Mirador_Roca en el glb
  putRock(-76, -256, 11, 0.45);
  putRock(-66, -246, 7, 0.4);
  putRock(-84, -268, 6, 0.4);
  for (let i = 0; i < 4000 && nRocks < MAX_ROCKS; i++) {
    const shoreBand = i % 2 === 0;
    let x: number, z: number, s: number;
    if (shoreBand) {
      const a = rand() * Math.PI * 2, r = SHORE_R - 2 + rand() * 12;
      x = lc.x + Math.cos(a) * r; z = lc.z + Math.sin(a) * r;
      s = 0.5 + rand() * 1.8;
    } else {
      x = X0 + rand() * (X1 - X0); z = Z0 + rand() * (Z1 - Z0);
      if (Math.hypot(x + 50, z + 150) > 330) continue;
      s = 0.3 + rand() * rand() * 2.2;
    }
    if (roadQuery(road, x, z).d < ROAD_HALF + SHOULDER + 2 + s) continue;
    if (blocksView(x, z, heightAt(x, z) + s)) continue;
    putRock(x, z, s);
  }
  rocks.count = nRocks;
  rocks.computeBoundingSphere();
  group.add(rocks);

  // ───────────────────────── cielo: domo con degradado (sustituye a Sky en pantalla)
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      sunDir: { value: opts.sun.clone().normalize() },
      zenith: { value: new THREE.Color(0x3d6db6) },
      horizon: { value: new THREE.Color(0xf2c690) },
      below: { value: new THREE.Color(opts.fogColor) },
      sunCol: { value: new THREE.Color(0xffc887) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // siempre en el plano lejano
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 sunDir, zenith, horizon, below, sunCol;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 c = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.42));
        c = mix(c, below, smoothstep(0.02, -0.08, h));
        float s = max(dot(d, sunDir), 0.0);
        c += sunCol * (pow(s, 6.0) * 0.3 + pow(s, 900.0) * 3.0);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(2400, 32, 16), skyMat);
  skyDome.name = 'Proc_Cielo';
  skyDome.renderOrder = -1;
  skyDome.frustumCulled = false;
  group.add(skyDome);

  const meshes: THREE.Mesh[] = [terrain, water, asphalt, shoulder, lines, postMesh, railMesh, trees, rocks, skyDome];
  let triangles = 0;
  for (const m of meshes) {
    const g = m.geometry;
    const t = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    triangles += t * ((m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1);
  }

  return {
    group,
    groundMeshes: [terrain, asphalt, shoulder],
    heightAt,
    update(camera) {
      skyDome.position.copy(camera.position);
    },
    stats: { triangles: Math.round(triangles), drawCalls: meshes.length, trees: nTrees, rocks: nRocks, buildMs: Math.round(performance.now() - t0) },
    dispose() {
      for (const m of meshes) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      group.clear();
    },
  };
}
