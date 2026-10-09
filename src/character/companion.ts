import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { buildHeightfield } from './terrain';
import type { Heightfield } from './terrain';

/**
 * Aitziber: la acompañante del conductor en la cinemática three.js.
 *
 * Modelo y animaciones vienen del artefacto "Aitziber al sol": un rig propio
 * (hips, spine, chest… con dedos) animado de forma procedural — cada gesto es
 * una función del tiempo que devuelve rotaciones por hueso, con fundidos entre
 * estados e IK de dos huesos para apoyar las manos. Aquí se porta ese sistema y
 * se le añade la vida en la camioneta:
 *
 *  - `seated`   en el asiento del copiloto (pegada a la carrocería, como el conductor)
 *  - `exiting`  se baja por la puerta derecha
 *  - `foot`     acompaña al conductor caminando a su lado; gestos desde su panel
 *  - `boarding` vuelve sola a su puerta cuando él se sube
 *  - `entering` la salida al revés
 *
 * Convención (la del artefacto): el modelo mira a +Z con rumbo 0; rumbo = atan2(x, z).
 */

export type CompanionState = 'seated' | 'exiting' | 'foot' | 'boarding' | 'entering';

export interface CompanionDriver {
  root: THREE.Object3D;
  readonly heading: number;
  readonly state: string;
  chest(out?: THREE.Vector3): THREE.Vector3;
}

export interface CompanionOptions {
  scene: THREE.Scene;
  gltf: GLTF;
  /** Nodo raíz del vehículo (frente en -Z, izquierda en -X). */
  vehicle: THREE.Object3D;
  /** Carrocería: el asiento va pegado a ella. */
  body: THREE.Object3D;
  groundMeshes: THREE.Mesh[];
  driver: CompanionDriver;
  /** Contenedor del panel de gestos. */
  host: HTMLElement;
}

// ───────────────────────── utilidades
type Vec3 = [number, number, number];
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ease = (v: number) => { v = clamp01(v); return v * v * (3 - 2 * v); };
const ss = (a: number, b: number, x: number) => ease((x - a) / (b - a));
/** Ventana de entrada/salida: sube en `f` s desde `a`, baja en los últimos `f` s de `d`. */
const env = (t: number, a: number, d: number, f = 0.35) => ease((t - a) / f) * (1 - ease((t - d) / f));
const angDiff = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

// ───────────────────────── habitáculo, lado del copiloto (espejo del conductor en character.ts)
const CAB = {
  /** raíz del modelo sentado; con la pose de sentada la pelvis cae sobre el banco */
  seat: V(0.4, 0.37, -0.5),
  sill: V(0.92, 0.36, -0.18),
  door: V(1.3, 0, -0.2),
};
const EXIT_T = 1.8;

// ───────────────────────── pose procedural (portado del artefacto)
const BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'L_shoulder', 'L_upperarm', 'L_forearm', 'L_foretwist', 'L_hand',
  'R_shoulder', 'R_upperarm', 'R_forearm', 'R_foretwist', 'R_hand', 'L_thigh', 'L_shin', 'L_foot', 'R_thigh', 'R_shin', 'R_foot',
  'L_fing1', 'L_fing2', 'L_thumb1', 'L_thumb2', 'R_fing1', 'R_fing2', 'R_thumb1', 'R_thumb2'] as const;
type Bone = (typeof BONES)[number];
/** Eje de giro propio (roll) de un hueso = dirección a su hijo en reposo. */
const TWIST_CHILD: Partial<Record<Bone, Bone>> = {
  L_upperarm: 'L_forearm', L_foretwist: 'L_hand', L_hand: 'L_fing1', R_upperarm: 'R_forearm', R_foretwist: 'R_hand', R_hand: 'R_fing1',
};

interface IK { side: 'L' | 'R'; target: THREE.Vector3; w: number; pole: THREE.Vector3 }
interface Pose { b: Partial<Record<Bone, Vec3>>; tw: Partial<Record<Bone, number>>; ik: IK[]; off: Vec3 }

const P = (): Pose => ({ b: {}, tw: {}, ik: [], off: [0, 0, 0] });
function tw(p: Pose, n: Bone, v: number, k = 1) { p.tw[n] = (p.tw[n] ?? 0) + v * k; return p; }
function add(p: Pose, n: Bone, x = 0, y = 0, z = 0, k = 1) {
  const r = p.b[n] ?? (p.b[n] = [0, 0, 0]);
  r[0] += x * k; r[1] += y * k; r[2] += z * k;
  return p;
}
function mix(a: Pose, b: Pose, k: number): Pose {
  const o = P();
  o.off = [lerp(a.off[0], b.off[0], k), lerp(a.off[1], b.off[1], k), lerp(a.off[2], b.off[2], k)];
  for (const n of BONES) {
    const x = a.b[n] ?? [0, 0, 0], y = b.b[n] ?? [0, 0, 0];
    o.b[n] = [lerp(x[0], y[0], k), lerp(x[1], y[1], k), lerp(x[2], y[2], k)];
    const ta = a.tw[n] ?? 0, tb = b.tw[n] ?? 0;
    if (ta || tb) o.tw[n] = lerp(ta, tb, k);
  }
  o.ik = [...a.ik.map((i) => ({ ...i, w: i.w * (1 - k) })), ...b.ik.map((i) => ({ ...i, w: i.w * k }))];
  return o;
}
/** Postura de pie: brazos relajados (el escaneo está en pose A con las palmas al frente). */
function base(p: Pose, t: number) {
  const br = Math.sin(t * 1.7);
  add(p, 'chest', 0.012 * br); add(p, 'neck', -0.01 * br);
  add(p, 'L_shoulder', 0, 0, 0.01 * br); add(p, 'R_shoulder', 0, 0, -0.01 * br);
  add(p, 'L_upperarm', 0, 0, -0.1); add(p, 'L_forearm', 0, 0, -0.18);
  add(p, 'R_upperarm', 0, 0, 0.1); add(p, 'R_forearm', 0, 0, 0.18);
  tw(p, 'L_upperarm', 0.18); tw(p, 'L_foretwist', 1.0); tw(p, 'L_hand', 0.42);
  tw(p, 'R_upperarm', -0.18); tw(p, 'R_foretwist', -1.0); tw(p, 'R_hand', -0.42);
  add(p, 'L_hand', -0.08); add(p, 'R_hand', -0.08);
  for (const S of ['L', 'R'] as const) {
    const m = S === 'L' ? 1 : -1;
    add(p, `${S}_fing1`, -0.22); add(p, `${S}_fing2`, -0.3); add(p, `${S}_thumb1`, -0.12, 0, -0.12 * m); add(p, `${S}_thumb2`, -0.15);
  }
  return p;
}
function openHand(p: Pose, S: 'L' | 'R', k: number) {
  const m = S === 'L' ? 1 : -1;
  tw(p, `${S}_upperarm`, -0.18 * m, k); tw(p, `${S}_foretwist`, -1.0 * m, k); tw(p, `${S}_hand`, -0.42 * m, k);
  add(p, `${S}_fing1`, 0.26, 0, 0, k); add(p, `${S}_fing2`, 0.32, 0, 0, k); add(p, `${S}_thumb1`, 0.1, 0, 0.2 * m, k); add(p, `${S}_thumb2`, 0.15, 0, 0, k);
  return p;
}
function curl(p: Pose, S: 'L' | 'R', f1: number, f2: number, th: number, k = 1) {
  const m = S === 'L' ? 1 : -1;
  add(p, `${S}_fing1`, -f1, 0, 0, k); add(p, `${S}_fing2`, -f2, 0, 0, k); add(p, `${S}_thumb1`, -th * 0.5, 0, -th * m, k); add(p, `${S}_thumb2`, -th * 0.8, 0, 0, k);
  return p;
}

const WALK_T = 1.08, STEP = 0.3;
/** Velocidad natural del paso (m/s) para que los pies no patinen. */
const SPEED = (2 * 2 * 0.86 * Math.sin(STEP)) / WALK_T;
function gait(p: Pose, t: number, amt = 1) {
  const ph = (t / WALK_T) * Math.PI * 2, s = Math.sin(ph), c = Math.cos(ph);
  add(p, 'L_thigh', -STEP * s, -0.04, 0, amt); add(p, 'R_thigh', STEP * s, 0.04, 0, amt);
  add(p, 'L_shin', 0.06 + 0.5 * Math.pow(Math.max(0, c), 1.4), 0, 0, amt);
  add(p, 'R_shin', 0.06 + 0.5 * Math.pow(Math.max(0, -c), 1.4), 0, 0, amt);
  add(p, 'L_foot', 0.25 * Math.max(0, c) - 0.12 * s, 0, 0, amt);
  add(p, 'R_foot', 0.25 * Math.max(0, -c) + 0.12 * s, 0, 0, amt);
  add(p, 'hips', 0, -0.13 * s, 0.055 * c, amt);
  add(p, 'spine', 0.03, 0.09 * s, -0.04 * c, amt);
  add(p, 'chest', 0, 0.06 * s, -0.02 * c, amt);
  add(p, 'head', -0.02, -0.02 * s, 0.02 * c, amt);
  p.off[0] += -0.022 * c * amt;
  p.off[1] += (-0.012 + 0.012 * Math.cos(2 * ph)) * amt;
  add(p, 'L_upperarm', 0.26 * s, 0, 0.03, amt); add(p, 'L_forearm', -0.18 - 0.14 * Math.max(0, -s), 0, 0, amt); add(p, 'L_hand', 0.15, 0, 0.1 * s, amt);
  add(p, 'R_upperarm', -0.1 * s, 0, -0.02, amt); add(p, 'R_forearm', -0.12, 0, 0, amt);
}
/** Sentada: `k` 0 de pie → 1 sentada. Las manos descansan en el regazo. */
function sitPose(p: Pose, k: number, t: number, settled: boolean) {
  const dip = Math.sin(Math.PI * k);
  add(p, 'L_thigh', -1.42, 0.1, -0.07, k); add(p, 'R_thigh', -1.42, -0.12, 0.1, k);
  add(p, 'L_shin', 1.36, 0, 0, k); add(p, 'R_shin', 1.36, 0, 0, k);
  add(p, 'L_foot', 0.12, 0, 0, k); add(p, 'R_foot', 0.22, 0, 0, k);
  add(p, 'spine', 0.06 + 0.32 * dip, 0, 0, k); add(p, 'chest', 0.02, 0, 0, k); add(p, 'head', -0.06 - 0.2 * dip, 0, 0, k);
  add(p, 'L_upperarm', -0.42, -0.05, -0.12, k); add(p, 'L_forearm', -0.95, 0, -0.3, k); add(p, 'L_hand', 0.2, 0, -0.1, k); tw(p, 'L_foretwist', 1.53, k); tw(p, 'L_hand', 0.72, k);
  add(p, 'R_upperarm', -0.42, 0.05, 0.1, k); add(p, 'R_forearm', -0.95, 0, 0.3, k); add(p, 'R_hand', 0.2, 0, 0.1, k); tw(p, 'R_foretwist', -1.53, k); tw(p, 'R_hand', -0.72, k);
  p.off[1] += -0.405 * k; p.off[2] += -0.4 * k;
  if (settled) {
    // mirando el paisaje por la ventanilla
    add(p, 'head', 0.03 * Math.sin(t * 0.5), 0.18 + 0.14 * Math.sin(t * 0.23), 0.05 * Math.sin(t * 0.27));
    add(p, 'chest', 0.015 * Math.sin(t * 1.7));
  }
  return p;
}

/**
 * En la cabina el suelo (Int_Piso, y 0,57) queda más alto que en un banco: con
 * la pose de banco los pies lo atravesaban. Rodillas algo más arriba y piernas
 * estiradas hacia delante, apoyando los pies en el suelo de la cabina.
 */
function cabLegs(p: Pose, k: number) {
  add(p, 'L_thigh', -0.2, 0, 0, k); add(p, 'R_thigh', -0.2, 0, 0, k);
  add(p, 'L_shin', -0.45, 0, 0, k); add(p, 'R_shin', -0.45, 0, 0, k);
  add(p, 'L_foot', 0.12, 0, 0, k); add(p, 'R_foot', 0.12, 0, 0, k);
  return p;
}

// ───────────────────────── gestos (sin desplazamiento de raíz salvo `fwd`)
type GestureId = 'wave' | 'laugh' | 'jump' | 'hug' | 'kiss';
interface GestureCtx { partnerL: THREE.Vector3; partnerR: THREE.Vector3; wrist: (S: 'L' | 'R', target: THREE.Vector3) => THREE.Vector3; yaw: number }
interface Gesture { label: string; dur: number; near?: number; fn: (t: number, c: GestureCtx) => Pose & { fwd?: number } }

const GESTURES: Record<GestureId, Gesture> = {
  wave: { label: 'Saludando', dur: 3.4, fn(t) {
    const p = base(P(), t), e = env(t, 0, 3.4, 0.45), w = Math.sin(t * 8.5);
    add(p, 'L_upperarm', -0.3, 0.2, 1.0, e);
    add(p, 'L_forearm', 0, 0, 1.75 + 0.38 * w, e);
    add(p, 'L_hand', -0.1, 0, 0.25 * Math.sin(t * 8.5 - 0.8), e); openHand(p, 'L', e);
    add(p, 'L_shoulder', 0, 0, 0.08, e);
    add(p, 'hips', 0, -0.08, -0.06, e); p.off[0] += 0.025 * e;
    add(p, 'spine', 0, 0.05, 0.03, e); add(p, 'chest', 0, 0.04, -0.03, e);
    add(p, 'head', 0.04, 0.12, 0.16 + 0.03 * w, e);
    add(p, 'R_upperarm', 0, 0, -0.04, e); add(p, 'R_forearm', -0.25, 0, 0, e);
    add(p, 'R_thigh', -0.08, 0.1, -0.03, e); add(p, 'R_shin', 0.16, 0, 0, e);
    return p;
  } },
  laugh: { label: 'Riendo', dur: 3.6, fn(t) {
    const p = base(P(), t), e = env(t, 0, 3.6, 0.45);
    const burstK = Math.pow(Math.abs(Math.sin(t * 9.5)), 2) * e * (t < 3 ? 1 : 0);
    const fold = ease((t - 1.4) / 0.5) * (1 - ease((t - 2.6) / 0.6));
    add(p, 'head', -0.28 + 0.55 * fold + 0.07 * burstK, 0.12, 0.1, e);
    add(p, 'neck', -0.08 + 0.1 * fold, 0, 0.04, e);
    add(p, 'chest', -0.05 + 0.06 * burstK + 0.12 * fold, 0, 0, e);
    add(p, 'spine', -0.04 + 0.18 * fold, -0.05, 0, e);
    add(p, 'hips', 0, 0, -0.04, e); p.off[0] += 0.02 * e;
    add(p, 'L_shoulder', 0, 0, 0.06 * burstK); add(p, 'R_shoulder', 0, 0, -0.06 * burstK);
    add(p, 'L_upperarm', -0.95, -0.15, -0.32, e); add(p, 'L_forearm', -2.05, 0, -0.25, e); add(p, 'L_hand', 0.25, 0.2, 0, e);
    add(p, 'R_upperarm', -0.25, 0, 0.12, e); add(p, 'R_forearm', -1.0, 0, 0.55, e); add(p, 'R_hand', 0, 0, 0.2, e);
    p.off[1] += -0.01 * burstK - 0.03 * fold;
    return p;
  } },
  jump: { label: 'Saltando de emoción', dur: 3.5, fn(t) {
    const p = base(P(), t), e = env(t, 0, 3.5, 0.3);
    const H0 = 0.35, HP = 0.5, N = 5, h = (t - H0) / HP, i = Math.floor(h), u = h - i;
    let lift = 0, crouch = 0;
    if (h >= 0 && i < N) {
      const air = clamp01((u - 0.18) / 0.64);
      lift = u > 0.18 && u < 0.82 ? Math.sin(Math.PI * air) : 0;
      crouch = u <= 0.18 ? Math.sin((Math.PI * u) / 0.36) : u >= 0.82 ? Math.sin((Math.PI * (1 - u)) / 0.36) : 0;
    } else if (t < H0) crouch = Math.sin((Math.PI * t) / (2 * H0)) * 0.6;
    const side = i % 2 ? 1 : -1;
    const fl = Math.sin(t * 22) * 0.08;
    add(p, 'L_upperarm', -0.6, -0.2, -0.22, e); add(p, 'L_forearm', -1.95, 0, -0.26 + fl, e); add(p, 'L_hand', 0.3, 0, 0, e); curl(p, 'L', 0.3, 0.3, 0.2, e);
    add(p, 'R_upperarm', -0.6, 0.2, 0.22, e); add(p, 'R_forearm', -1.95, 0, 0.26 - fl, e); add(p, 'R_hand', 0.3, 0, 0, e); curl(p, 'R', 0.3, 0.3, 0.2, e);
    add(p, 'L_shoulder', 0, 0, 0.1 * lift + 0.04, e); add(p, 'R_shoulder', 0, 0, -0.1 * lift - 0.04, e);
    add(p, 'L_thigh', -0.1 * lift - 0.35 * crouch, 0, 0, e); add(p, 'R_thigh', -0.1 * lift - 0.35 * crouch, 0, 0, e);
    add(p, 'L_shin', 1.05 * lift + 0.6 * crouch, 0, 0, e); add(p, 'R_shin', 0.95 * lift + 0.6 * crouch, 0, 0, e);
    add(p, 'L_foot', 0.55 * lift - 0.25 * crouch, 0, 0, e); add(p, 'R_foot', 0.55 * lift - 0.25 * crouch, 0, 0, e);
    add(p, 'spine', 0.08 * crouch - 0.04 * lift, 0, 0.03 * side * lift, e);
    add(p, 'head', -0.12 * lift, 0.08 * side, 0.14 * side * lift, e);
    p.off[1] += (0.16 * lift - 0.07 * crouch) * e;
    p.off[2] += 0.03 * crouch * e;
    return p;
  } },
  // Abrazo y beso: se colocan delante del conductor (`near` m) antes de empezar.
  hug: { label: 'Abrazándole', dur: 5, near: 0.42, fn(t) {
    const p = base(P(), t), e = env(t, 0, 5, 0.4);
    const open = ease(t / 0.8) * (1 - ease((t - 0.9) / 0.6));
    const wrap = ease((t - 0.9) / 0.7) * (1 - ease((t - 4.2) / 0.6));
    const sway = Math.sin((t - 1.4) * 2.1) * ease((t - 1.5) / 0.5) * wrap;
    add(p, 'L_upperarm', -1.05 * open - 1.42 * wrap, 0.75 * open - 0.1 * wrap, 0.2 * open, e);
    add(p, 'R_upperarm', -1.05 * open - 1.42 * wrap, -0.75 * open + 0.1 * wrap, -0.2 * open, e);
    add(p, 'L_forearm', -0.25 * open, 0, -0.2 * open - 0.5 * wrap, e);
    add(p, 'R_forearm', -0.25 * open, 0, 0.2 * open + 0.5 * wrap, e);
    add(p, 'L_hand', 0, 0, -0.3 * wrap, e); add(p, 'R_hand', 0, 0, 0.3 * wrap, e);
    add(p, 'spine', 0.1 * wrap - 0.05 * open, 0, 0.07 * sway, e);
    add(p, 'chest', 0.05 * wrap - 0.06 * open, 0.05 * sway, 0.04 * sway, e);
    add(p, 'head', 0.05 * wrap, -0.35 * wrap, 0.22 * wrap + 0.05 * sway, e);
    add(p, 'hips', 0, 0, -0.03 * sway, e);
    add(p, 'L_foot', 0.25 * wrap, 0, 0, e); add(p, 'R_foot', 0.25 * wrap, 0, 0, e);
    add(p, 'R_thigh', 0.1 * wrap, 0, 0, e); add(p, 'R_shin', 0.85 * wrap * ease((t - 1.6) / 0.5), 0, 0, e);
    p.off[1] += 0.035 * wrap * e; p.off[2] += 0.03 * wrap * e;
    return p;
  } },
  kiss: { label: 'Dándole un beso', dur: 5.6, near: 0.5, fn(t, c) {
    const p: Pose & { fwd?: number } = base(P(), t);
    const close = ease(t / 0.8) * (1 - ease((t - 2.6) / 0.6));
    const lean = ease((t - 0.7) / 0.6) * (1 - ease((t - 2.3) / 0.5));
    const blow = ease((t - 3.2) / 0.4) * (1 - ease((t - 5.1) / 0.4));
    const toss = ease((t - 4.0) / 0.35);
    p.fwd = 0.13 * close + 0.05 * lean;
    add(p, 'L_foot', 0.45, 0, 0, lean); add(p, 'R_foot', 0.45, 0, 0, lean); p.off[1] += 0.06 * lean;
    add(p, 'R_thigh', 0.12, 0, 0, lean); add(p, 'R_shin', 0.9, 0, 0, lean * ease((t - 1) / 0.4));
    add(p, 'spine', 0.06 * close + 0.12 * lean); add(p, 'chest', 0.06 * lean);
    add(p, 'neck', 0.1, 0.15, 0.05, lean); add(p, 'head', 0.02, 0.38, 0.3, lean);
    add(p, 'R_upperarm', -0.9, 0, 0.1, close); add(p, 'R_forearm', -1.0, 0, 0, close); curl(p, 'R', 0.35, 0.3, 0.1, close);
    add(p, 'L_upperarm', -0.8, 0, -0.05, close); add(p, 'L_forearm', -0.9, 0, 0, close); curl(p, 'L', 0.3, 0.25, 0.1, close);
    if (close > 0.001) {
      // manos sobre él: la derecha en su hombro izquierdo, la izquierda en su brazo derecho
      const right = V(-Math.cos(c.yaw), 0, Math.sin(c.yaw));
      p.ik.push({ side: 'R', target: c.wrist('R', c.partnerL), w: close, pole: right.clone().multiplyScalar(0.7).add(V(0, -1, 0)) });
      p.ik.push({ side: 'L', target: c.wrist('L', c.partnerR), w: close, pole: right.multiplyScalar(-0.7).add(V(0, -1, 0)) });
    }
    add(p, 'R_upperarm', -1.0 - 0.35 * toss, 0, 0.3 - 0.2 * toss, blow); add(p, 'R_forearm', -2.2 + 1.55 * toss, 0, 0.2, blow); add(p, 'R_hand', 0.25 - 0.55 * toss, 0, 0, blow);
    curl(p, 'R', 0.7 * (1 - toss), 0.5 * (1 - toss), 0.6 * (1 - toss), blow); openHand(p, 'R', blow * toss);
    add(p, 'head', 0.08 * (1 - toss) - 0.05 * toss, 0.1, 0.08, blow);
    return p;
  } },
};

// ───────────────────────── corazones, "ja" y destellos
function spriteTex(draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createCompanion(opts: CompanionOptions) {
  const { scene, gltf, vehicle, body, driver } = opts;

  const actor = new THREE.Group();
  actor.name = 'Aitziber';
  actor.add(gltf.scene);
  scene.add(actor);
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false; // el skin se sale del bbox de reposo
  });
  const bones = {} as Record<Bone, THREE.Object3D>;
  for (const n of BONES) {
    const b = gltf.scene.getObjectByName(n);
    if (!b) throw new Error(`Aitziber: falta el hueso ${n}`);
    bones[n] = b;
  }
  const hipsRest = bones.hips.position.clone();
  const TW_AXIS: Partial<Record<Bone, THREE.Vector3>> = {};
  for (const [n, c] of Object.entries(TWIST_CHILD) as [Bone, Bone][]) TW_AXIS[n] = bones[c].position.clone().normalize();

  // ── marcos del vehículo
  vehicle.updateWorldMatrix(true, true);
  const seatInVehicle = new THREE.Matrix4().compose(CAB.seat, new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI), V(1, 1, 1));
  const SEAT = body.matrixWorld.clone().invert().multiply(vehicle.matrixWorld).multiply(seatInVehicle);
  const seatWorld = () => body.matrixWorld.clone().multiply(SEAT);
  const vehToWorld = (p: THREE.Vector3) => p.clone().applyMatrix4(vehicle.matrixWorld);
  const vehicleYaw = () => {
    const f = V(0, 0, -1).transformDirection(vehicle.matrixWorld);
    return Math.atan2(f.x, f.z);
  };
  // caja de la camioneta en su propio marco, para no atravesarla al caminar
  const vInv = vehicle.matrixWorld.clone().invert();
  const vBox = new THREE.Box3();
  vehicle.traverse((o) => {
    const m = o as THREE.Mesh;
    // las piezas ocultas o escaladas a cero (tapa de la caja abierta…) no cuentan
    if (!m.isMesh || !m.visible || Math.abs(m.matrixWorld.determinant()) < 1e-6) return;
    m.geometry.computeBoundingBox();
    vBox.union(m.geometry.boundingBox!.clone().applyMatrix4(vInv.clone().multiply(m.matrixWorld)));
  });
  // simétrica en X sin los retrovisores: la carrocería mide ~2 m de ancho
  const halfW = Math.min(1.0, -vBox.min.x, vBox.max.x);
  vBox.min.x = -halfW;
  vBox.max.x = halfW;

  // ── estado
  let state: CompanionState = 'seated';
  let stateT = 0;
  let t = 0;
  let ground: Heightfield | null = null;
  const pos = V();
  let heading = 0, speed = 0, phase = 0, turnRate = 0, still = 0;
  /** lado al que camina respecto al conductor: +1 su izquierda, -1 su derecha */
  let side = -1;
  let faceYaw: number | null = null;
  const exitFrom = { pos: V(), quat: new THREE.Quaternion() };
  const exitTo = { pos: V(), yaw: 0 };
  let gesture: { id: GestureId; t: number } | null = null;
  /** gesto que espera a que llegue delante del conductor */
  let pending: GestureId | null = null;
  let label = 'En el coche';
  // fundido entre poses: la última pose mostrada se congela y se mezcla con la nueva
  let lastPose: Pose | null = null;
  let fromPose: Pose | null = null;
  let fade = 1, fadeDur = 0.5;
  let poseKey = 'seated';

  const groundY = (x: number, z: number) => (ground ? ground.at(x, z) : pos.y);
  const doorWorld = () => {
    const p = vehToWorld(CAB.door);
    p.y = groundY(p.x, p.z);
    return p;
  };

  // ── sprites
  const TEX = {
    heart: spriteTex((g) => { g.fillStyle = '#e0607a'; g.beginPath(); g.moveTo(64, 108); g.bezierCurveTo(10, 72, 8, 30, 38, 24); g.bezierCurveTo(52, 21, 61, 30, 64, 40); g.bezierCurveTo(67, 30, 76, 21, 90, 24); g.bezierCurveTo(120, 30, 118, 72, 64, 108); g.fill(); }),
    ja: spriteTex((g) => { g.fillStyle = '#c2566b'; g.font = 'italic 600 64px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('ja', 64, 66); }),
    spark: spriteTex((g) => { g.fillStyle = '#f2b544'; g.beginPath(); for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4, r = i % 2 ? 16 : 56; g.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r); } g.fill(); }),
  };
  interface Floater { s: THREE.Sprite; v: THREE.Vector3; life: number; max: number; delay: number; size: number }
  const floaters: Floater[] = [];
  const timers: { at: number; fn: () => void }[] = [];
  function burst(kind: keyof typeof TEX, origin: THREE.Vector3, n: number, o: { size?: number; spread?: number; stagger?: number } = {}) {
    for (let i = 0; i < n; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX[kind], transparent: true, depthWrite: false, fog: false }));
      const size = (o.size ?? 0.12) * (0.7 + Math.random() * 0.6);
      s.scale.setScalar(size);
      s.position.copy(origin).add(V((Math.random() - 0.5) * (o.spread ?? 0.4), (Math.random() - 0.3) * 0.2, (Math.random() - 0.5) * (o.spread ?? 0.4)));
      s.visible = false;
      scene.add(s);
      floaters.push({ s, v: V((Math.random() - 0.5) * 0.25, 0.35 + Math.random() * 0.35, (Math.random() - 0.5) * 0.25), life: 0, max: 1.4 + Math.random() * 0.8, delay: (o.stagger ?? 0) * i, size });
    }
  }
  const later = (s: number, fn: () => void) => timers.push({ at: t + s, fn });
  const headPos = (dy = 0) => bones.head.getWorldPosition(V()).add(V(0, dy, 0));
  const FX: Record<GestureId, () => void> = {
    laugh: () => later(0.3, () => burst('ja', headPos(0.15), 5, { size: 0.14, stagger: 0.32, spread: 0.5 })),
    jump: () => later(0.45, () => burst('spark', headPos(-0.1), 14, { size: 0.09, stagger: 0.17, spread: 0.8 })),
    hug: () => later(1.5, () => burst('heart', headPos(-0.2), 10, { size: 0.12, stagger: 0.12, spread: 0.6 })),
    wave: () => later(0.7, () => burst('spark', headPos(0.05), 3, { size: 0.07, stagger: 0.4, spread: 0.2 })),
    kiss: () => {
      later(1.3, () => burst('heart', headPos(0.05), 6, { size: 0.09, stagger: 0.1, spread: 0.25 }));
      later(4.25, () => burst('heart', bones.R_hand.getWorldPosition(V()), 7, { size: 0.1, stagger: 0.08, spread: 0.3 }));
    },
  };

  // ── IK de dos huesos (hombro–codo–muñeca), mezclada sobre la pose FK
  const _a = V(), _b = V(), _c = V();
  function solveIK(S: 'L' | 'R', target: THREE.Vector3, w: number, pole: THREE.Vector3) {
    const A = bones[`${S}_upperarm`], B = bones[`${S}_forearm`], C = bones[`${S}_hand`];
    A.getWorldPosition(_a); B.getWorldPosition(_b); C.getWorldPosition(_c);
    const lab = _b.distanceTo(_a), lcb = _c.distanceTo(_b);
    const lat = Math.min(Math.max(target.distanceTo(_a), 0.01), lab + lcb - 1e-3);
    const cl = (v: number) => Math.min(1, Math.max(-1, v));
    const ac = _c.clone().sub(_a).normalize(), ab = _b.clone().sub(_a).normalize(), ba = _a.clone().sub(_b).normalize(), bc = _c.clone().sub(_b).normalize(), at = target.clone().sub(_a).normalize();
    const acab0 = Math.acos(cl(ac.dot(ab))), babc0 = Math.acos(cl(ba.dot(bc))), acat0 = Math.acos(cl(ac.dot(at)));
    const acab1 = Math.acos(cl((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat))), babc1 = Math.acos(cl((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb)));
    const ax0 = V().crossVectors(ac, pole); if (ax0.lengthSq() < 1e-10) ax0.crossVectors(ac, ab); ax0.normalize();
    const ax1 = V().crossVectors(ac, at); if (ax1.lengthSq() < 1e-10) ax1.copy(ax0); ax1.normalize();
    const r0 = new THREE.Quaternion().setFromAxisAngle(ax0, acab1 - acab0);
    const r1 = new THREE.Quaternion().setFromAxisAngle(ax0, babc1 - babc0);
    const r2 = new THREE.Quaternion().setFromAxisAngle(ax1, acat0);
    const qa = A.getWorldQuaternion(new THREE.Quaternion()), qb = B.getWorldQuaternion(new THREE.Quaternion());
    const aNew = A.quaternion.clone().multiply(qa.clone().invert().multiply(r2).multiply(r0).multiply(qa));
    const bNew = B.quaternion.clone().multiply(qb.clone().invert().multiply(r1).multiply(qb));
    A.quaternion.slerp(aNew, w);
    B.quaternion.slerp(bNew, w);
    A.updateMatrixWorld(true);
  }
  const wrist = (S: 'L' | 'R', target: THREE.Vector3) => {
    const sh = bones[`${S}_upperarm`].getWorldPosition(V());
    return target.clone().add(sh.sub(target).normalize().multiplyScalar(0.075));
  };

  const _e = new THREE.Euler(), _qt = new THREE.Quaternion();
  function applyPose(p: Pose) {
    for (const n of BONES) {
      const r = p.b[n] ?? [0, 0, 0];
      _e.set(r[0], r[1], r[2], 'YXZ');
      bones[n].quaternion.setFromEuler(_e);
      const a = p.tw[n];
      const axis = TW_AXIS[n];
      if (a && axis) {
        _qt.setFromAxisAngle(axis, a);
        if (n.endsWith('upperarm')) bones[n].quaternion.multiply(_qt);
        else bones[n].quaternion.premultiply(_qt);
      }
    }
    bones.hips.position.set(hipsRest.x + p.off[0], hipsRest.y + p.off[1], hipsRest.z + p.off[2]);
    if (p.ik.length) {
      actor.updateMatrixWorld(true);
      for (const k of p.ik) if (k.w > 0.002) solveIK(k.side, k.target, Math.min(1, k.w), k.pole);
    }
  }

  /** Cambia la "clave" de pose y arranca un fundido desde la última pose mostrada. */
  function setPoseKey(key: string, dur = 0.45) {
    if (key === poseKey) return;
    poseKey = key;
    fromPose = lastPose;
    fade = 0;
    fadeDur = dur;
  }

  // ── conductor como pareja
  const driverPos = () => driver.root.getWorldPosition(V());
  const driverFwd = () => V(Math.sin(driver.heading), 0, Math.cos(driver.heading));
  /** su izquierda (en el marco del personaje la izquierda es +X) */
  const driverLeft = () => V(Math.cos(driver.heading), 0, -Math.sin(driver.heading));
  const driverOnFoot = () => driver.state === 'foot' || driver.state === 'approach';

  // ── acciones públicas
  function exitVehicle() {
    if (state !== 'seated') return;
    ground = buildHeightfield(opts.groundMeshes, vehToWorld(CAB.door), 32, 0.2);
    actor.matrixWorld.decompose(exitFrom.pos, exitFrom.quat, V());
    exitTo.pos.copy(doorWorld());
    exitTo.yaw = vehicleYaw() - Math.PI / 2; // mirando hacia fuera de la puerta derecha
    state = 'exiting';
    stateT = 0;
    gesture = null;
    pending = null;
    label = 'Bajándose';
  }
  function board() {
    if (state !== 'foot') return;
    gesture = null;
    pending = null;
    state = 'boarding';
    label = 'Volviendo al coche';
  }
  function request(id: GestureId) {
    if (state !== 'foot') return;
    if (gesture) return;
    const g = GESTURES[id];
    if (g.near && driverOnFoot()) { pending = id; label = 'Hacia él'; return; }
    startGesture(id);
  }
  function startGesture(id: GestureId) {
    gesture = { id, t: 0 };
    pending = null;
    label = GESTURES[id].label;
    FX[id]();
    setPoseKey(`g:${id}`, 0.45);
  }

  /** Mueve hacia `goal` con el paso natural; devuelve la distancia restante. */
  function steer(dt: number, goal: THREE.Vector3, maxSpeed: number, arriveR = 0.12) {
    const d = V(goal.x - pos.x, 0, goal.z - pos.z);
    const dist = d.length();
    let target = 0;
    if (dist > arriveR) {
      target = Math.min(maxSpeed, dist * 1.5 + 0.15);
      const want = Math.atan2(d.x, d.z);
      const diff = angDiff(heading, want);
      const stepA = Math.sign(diff) * Math.min(Math.abs(diff), dt * 5.5);
      heading += stepA;
      turnRate += (stepA / Math.max(dt, 1e-4) - turnRate) * (1 - Math.exp(-dt * 6));
      target *= 1 - Math.min(0.6, Math.abs(diff) * 0.25);
    } else turnRate *= Math.exp(-dt * 6);
    speed += (target - speed) * (1 - Math.exp(-dt * (target > speed ? 5 : 7)));
    pos.x += Math.sin(heading) * speed * dt;
    pos.z += Math.cos(heading) * speed * dt;
    phase += (dt / WALK_T) * Math.max(speed / SPEED, Math.min(0.8, Math.abs(turnRate) * 0.15));
    return dist;
  }
  /**
   * Si la línea recta hasta `goal` cruza la camioneta, devuelve la esquina por
   * la que rodearla (por delante o por detrás, la más corta); si no, `goal`.
   */
  const segHitsBox = (a: THREE.Vector3, b: THREE.Vector3, x0: number, x1: number, z0: number, z1: number) => {
    for (let i = 1; i < 24; i++) {
      const u = i / 24, x = lerp(a.x, b.x, u), z = lerp(a.z, b.z, u);
      if (x > x0 && x < x1 && z > z0 && z < z1) return true;
    }
    return false;
  };
  function routeAround(goal: THREE.Vector3) {
    // choque contra la carrocería con su radio (estrecho); esquinas de paso con holgura
    const R = 0.2, M = 0.55;
    const b0 = vBox.min.x - R, b1 = vBox.max.x + R, c0 = vBox.min.z - R, c1z = vBox.max.z + R;
    const x0 = vBox.min.x - M, x1 = vBox.max.x + M, z0 = vBox.min.z - M, z1 = vBox.max.z + M;
    const inv = vehicle.matrixWorld.clone().invert(); // la camioneta se ha movido desde la carga
    const h = pos.clone().applyMatrix4(inv), g = goal.clone().applyMatrix4(inv);
    // junto a él, pegado a la carrocería, el punto puede caer dentro: se saca al lateral más cercano
    if (g.x > b0 && g.x < b1 && g.z > c0 && g.z < c1z) {
      const out = [[g.x - b0, b0 - 0.02, g.z], [b1 - g.x, b1 + 0.02, g.z], [g.z - c0, g.x, c0 - 0.02], [c1z - g.z, g.x, c1z + 0.02]].sort((a, b) => a[0]! - b[0]!)[0]!;
      g.set(out[1]!, g.y, out[2]!);
      goal = g.clone().applyMatrix4(vehicle.matrixWorld).setY(goal.y);
    }
    if (!segHitsBox(h, g, b0, b1, c0, c1z)) return { to: goal, direct: true };
    const sideX = (x: number) => (x >= 0 ? x1 : x0);
    let best: THREE.Vector3 | null = null, bestLen = Infinity;
    for (const z of [z0, z1]) {
      const c1 = V(sideX(h.x), h.y, z), c2 = V(sideX(g.x), h.y, z);
      const len = h.distanceTo(c1) + c1.distanceTo(c2) + c2.distanceTo(g);
      if (len >= bestLen) continue;
      bestLen = len;
      best = !segHitsBox(h, c2, b0, b1, c0, c1z) ? c2 : c1;
    }
    return { to: best!.applyMatrix4(vehicle.matrixWorld).setY(goal.y), direct: false };
  }

  /** Fuera de la camioneta y sin pisar al conductor. */
  function collide(minDriver: number) {
    const local = pos.clone().applyMatrix4(vehicle.matrixWorld.clone().invert());
    const R = 0.25;
    if (local.x > vBox.min.x - R && local.x < vBox.max.x + R && local.z > vBox.min.z - R && local.z < vBox.max.z + R) {
      const push = [
        [local.x - (vBox.min.x - R), -1, 0], [vBox.max.x + R - local.x, 1, 0],
        [local.z - (vBox.min.z - R), 0, -1], [vBox.max.z + R - local.z, 0, 1],
      ].sort((a, b) => a[0]! - b[0]!)[0]!;
      local.x += push[1]! * push[0]!;
      local.z += push[2]! * push[0]!;
      const w = local.applyMatrix4(vehicle.matrixWorld);
      pos.x = w.x;
      pos.z = w.z;
    }
    if (driverOnFoot() || driver.state === 'exiting' || driver.state === 'entering') {
      const dp = driverPos();
      const dx = pos.x - dp.x, dz = pos.z - dp.z, d = Math.hypot(dx, dz);
      if (d < minDriver && d > 1e-4) { pos.x = dp.x + (dx / d) * minDriver; pos.z = dp.z + (dz / d) * minDriver; }
    }
    if (ground) {
      const lim = ground.half - 2;
      pos.x = ground.center.x + THREE.MathUtils.clamp(pos.x - ground.center.x, -lim, lim);
      pos.z = ground.center.y + THREE.MathUtils.clamp(pos.z - ground.center.y, -lim, lim);
      pos.y = ground.at(pos.x, pos.z);
    }
  }

  // ── panel de gestos
  const panel = document.createElement('div');
  panel.id = 'aitziPanel';
  panel.innerHTML = `
    <div class="who"><b>Aitziber</b><span class="now"></span></div>
    <div class="acts">
      <button type="button" class="btn" data-g="wave">Saludar <kbd>1</kbd></button>
      <button type="button" class="btn" data-g="laugh">Reír <kbd>2</kbd></button>
      <button type="button" class="btn" data-g="jump">Saltar <kbd>3</kbd></button>
      <button type="button" class="btn" data-g="hug">Abrazarle <kbd>4</kbd></button>
      <button type="button" class="btn" data-g="kiss">Beso <kbd>5</kbd></button>
    </div>`;
  opts.host.appendChild(panel);
  const nowEl = panel.querySelector<HTMLSpanElement>('.now')!;
  const buttons = [...panel.querySelectorAll<HTMLButtonElement>('[data-g]')];
  for (const b of buttons) b.onclick = () => { request(b.dataset.g as GestureId); b.blur(); };
  const KEYS: Record<string, GestureId> = { Digit1: 'wave', Digit2: 'laugh', Digit3: 'jump', Digit4: 'hug', Digit5: 'kiss', Numpad1: 'wave', Numpad2: 'laugh', Numpad3: 'jump', Numpad4: 'hug', Numpad5: 'kiss' };
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement | null)?.closest?.('input, textarea')) return;
    const g = KEYS[e.code];
    if (g && !e.repeat) { e.preventDefault(); request(g); }
  };
  window.addEventListener('keydown', onKey);

  // ── bucle
  function update(dt: number) {
    t += dt;
    stateT += dt;
    for (let i = timers.length - 1; i >= 0; i--) if (t >= timers[i]!.at) { timers[i]!.fn(); timers.splice(i, 1); }

    let p: Pose;
    if (state === 'seated') {
      seatWorld().decompose(actor.position, actor.quaternion, actor.scale);
      actor.scale.set(1, 1, 1);
      setPoseKey('seated', 0.6);
      p = cabLegs(sitPose(P(), 1, t, true), 1);
      label = 'En el coche';
    } else if (state === 'exiting' || state === 'entering') {
      const raw = clamp01(stateT / EXIT_T);
      const u = state === 'exiting' ? raw : 1 - raw;
      const sp = V(), sq = new THREE.Quaternion();
      seatWorld().decompose(sp, sq, V());
      if (state === 'entering') { exitFrom.pos.copy(sp); exitFrom.quat.copy(sq); }
      const a1 = ease(ss(0.1, 0.6, u)), a2 = ease(ss(0.55, 1, u));
      const at = exitFrom.pos.clone().lerp(vehToWorld(CAB.sill), a1).lerp(exitTo.pos, a2);
      at.y += 0.06 * Math.sin(Math.PI * ss(0.45, 1, u));
      actor.position.copy(at);
      const seatYaw = new THREE.Euler().setFromQuaternion(exitFrom.quat, 'YXZ').y;
      const yaw = seatYaw + angDiff(seatYaw, exitTo.yaw) * ease(ss(0.12, 0.8, u));
      const upright = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), yaw);
      actor.quaternion.copy(exitFrom.quat.clone().slerp(upright, ease(ss(0.1, 0.7, u))));
      const k = 1 - ss(0.35, 0.95, u);
      // de la pose del asiento a la de pie (misma pose de partida que `seated`: sin saltos)
      p = mix(base(P(), t), cabLegs(sitPose(P(), 1, t, false), 1), k);
      gait(p, t, 0.35 * Math.sin(Math.PI * ss(0.55, 1, u)));
      poseKey = 'transit';
      fade = 1;
      if (raw >= 1) {
        if (state === 'exiting') {
          state = 'foot';
          pos.copy(exitTo.pos);
          heading = exitTo.yaw;
          speed = 0;
          // camina por el lado de la camioneta en que se ha bajado
          side = V().subVectors(pos, driverPos()).dot(driverLeft()) >= 0 ? 1 : -1;
          label = 'De pie';
        } else {
          state = 'seated';
          ground = null;
        }
        stateT = 0;
      }
    } else {
      // ── a pie: acompañar, volver al coche o acercarse para un gesto
      let goal: THREE.Vector3 | null = null;
      let goalYaw: number | null = null;
      let maxSpeed = SPEED * 1.25;
      let arrive = 0.15;
      let minDriver = 0.55;
      if (state === 'boarding') {
        goal = doorWorld();
        goalYaw = vehicleYaw() - Math.PI / 2; // de espaldas a la puerta: se sienta y gira hacia dentro
        maxSpeed = SPEED * 1.8;
        if (Math.hypot(goal.x - pos.x, goal.z - pos.z) < 0.2 && speed < 0.08) {
          exitFrom.pos.copy(actor.position);
          exitTo.pos.copy(actor.position);
          exitTo.yaw = heading;
          state = 'entering';
          stateT = 0;
          label = 'Subiendo';
        }
      } else if (pending && driverOnFoot()) {
        const g = GESTURES[pending];
        goal = driverPos().addScaledVector(driverFwd(), g.near ?? 0.5);
        goalYaw = driver.heading + Math.PI;
        minDriver = (g.near ?? 0.5) - 0.05;
        arrive = 0.08;
        if (Math.hypot(goal.x - pos.x, goal.z - pos.z) < 0.12 && speed < 0.08 && Math.abs(angDiff(heading, goalYaw)) < 0.12) startGesture(pending);
      } else if (!gesture && driverOnFoot()) {
        // a su lado, medio paso por detrás
        goal = driverPos().addScaledVector(driverLeft(), side * 0.95).addScaledVector(driverFwd(), -0.15);
        const far = Math.hypot(goal.x - pos.x, goal.z - pos.z);
        maxSpeed = far > 4 ? SPEED * 2.6 : far > 1.5 ? SPEED * 1.7 : SPEED * 1.15;
        goalYaw = driver.heading;
      }
      if (gesture) {
        speed = 0;
        const g = GESTURES[gesture.id];
        gesture.t += dt;
        // si él se va, ella termina el gesto antes
        if (gesture.t >= g.dur || (g.near && !driverOnFoot())) { gesture = null; label = 'De pie'; }
      } else if (goal) {
        const r = routeAround(goal);
        const dist = r.direct ? steer(dt, r.to, maxSpeed, arrive) : (steer(dt, r.to, maxSpeed, 0.05), Infinity);
        if (dist <= arrive && speed < 0.08 && goalYaw !== null) faceYaw = goalYaw;
        else if (dist > arrive) faceYaw = null;
      } else {
        speed *= Math.exp(-dt * 7);
      }
      if (faceYaw !== null && speed < 0.08 && !gesture) {
        const dy = angDiff(heading, faceYaw);
        heading += Math.sign(dy) * Math.min(Math.abs(dy), dt * 2.4);
        if (Math.abs(dy) < 0.01) faceYaw = null;
        phase += (dt / WALK_T) * Math.min(0.5, Math.abs(dy) * 2);
      }
      collide(minDriver);
      actor.position.copy(pos);
      actor.rotation.set(0, heading, 0);

      if (gesture) {
        const g = GESTURES[gesture.id];
        const dl = driverLeft();
        const chest = driver.chest(V());
        const ctx: GestureCtx = {
          partnerL: chest.clone().addScaledVector(dl, 0.17).add(V(0, 0.08, 0)),
          partnerR: chest.clone().addScaledVector(dl, -0.24).add(V(0, -0.06, 0)),
          wrist, yaw: heading,
        };
        const gp = g.fn(gesture.t, ctx);
        if (gp.fwd) actor.position.addScaledVector(V(Math.sin(heading), 0, Math.cos(heading)), gp.fwd);
        p = gp;
      } else {
        const moving = speed > 0.05 || (faceYaw !== null && Math.abs(angDiff(heading, faceYaw)) > 0.02);
        if (moving) still = 0; else still += dt;
        setPoseKey(still > 0.25 ? 'idle' : 'move', 0.35);
        p = base(P(), t);
        const amt = speed / SPEED;
        gait(p, phase * WALK_T, Math.min(1, Math.max(amt, Math.min(0.3, Math.abs(turnRate) * 0.1))));
        if (amt > 1) { add(p, 'spine', 0.1 * Math.min(1, amt - 1)); add(p, 'L_upperarm', 0, 0, 0.05); add(p, 'R_upperarm', 0, 0, -0.05); }
        const lean = Math.max(-1, Math.min(1, turnRate * 0.25)) * Math.min(1, amt);
        add(p, 'spine', 0, 0, -0.06 * lean); add(p, 'head', 0, 0.18 * lean, -0.04 * lean);
        if (still > 0.25) {
          const w = Math.sin(t * 0.55);
          add(p, 'hips', 0, 0.03 * w, 0.025 * w); add(p, 'spine', 0, -0.02 * w, -0.02 * w);
          add(p, 'head', 0.02 * Math.sin(t * 0.37), 0.07 * Math.sin(t * 0.31), -0.03 * w);
          p.off[0] += 0.012 * w;
        }
      }
    }

    // fundido desde la pose anterior
    if (fromPose && fade < 1) {
      fade = Math.min(1, fade + dt / fadeDur);
      p = mix(fromPose, p, ease(fade));
    } else fromPose = null;
    actor.updateMatrixWorld(true);
    applyPose(p);
    lastPose = p;

    // sprites
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i]!;
      if (f.delay > 0) { f.delay -= dt; continue; }
      f.s.visible = true;
      f.life += dt;
      f.s.position.addScaledVector(f.v, dt);
      const k = f.life / f.max;
      f.s.material.opacity = k < 0.15 ? k / 0.15 : 1 - Math.max(0, (k - 0.5) / 0.5);
      f.s.scale.setScalar(f.size * (1 + k * 0.4));
      if (f.life >= f.max) { scene.remove(f.s); f.s.material.dispose(); floaters.splice(i, 1); }
    }

    // panel
    const onFoot = state === 'foot';
    panel.classList.toggle('foot', onFoot);
    for (const b of buttons) b.disabled = !onFoot || !!gesture || !!pending;
    nowEl.textContent = label;
  }

  return {
    root: actor,
    get state() { return state; },
    get seated() { return state === 'seated'; },
    exitVehicle,
    board,
    request,
    update,
    dispose() {
      window.removeEventListener('keydown', onKey);
      panel.remove();
      for (const f of floaters) { scene.remove(f.s); f.s.material.dispose(); }
      for (const tx of Object.values(TEX)) tx.dispose();
      scene.remove(actor);
      actor.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry.dispose();
        const mat = m.material as THREE.MeshStandardMaterial;
        for (const v of Object.values(mat)) if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
        mat.dispose();
      });
    },
  };
}

export type Companion = ReturnType<typeof createCompanion>;
