import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { gunshotSound, clinkSound, resumeAudio } from './audio';
import { buildHeightfield } from './terrain';
import type { Heightfield } from './terrain';

/**
 * Personaje de Meshy (esqueleto real + dedos riggeados en Blender) como
 * conductor de la camioneta de la cinemática.
 *
 * Estados:
 *  - `drive`    sentado al volante, pegado a la carrocería; manos al aro por IK.
 *  - `exiting`  se suelta del volante, gira hacia la puerta y se pone de pie fuera.
 *  - `foot`     lo controla el usuario sobre el terreno (mapa de alturas local).
 *  - `approach` camina solo hasta la puerta del conductor.
 *  - `entering` la salida al revés; al terminar avisa con `onSeated`.
 *
 * Convención de todos los ángulos procedurales: se escriben en el marco de reposo
 * del personaje (mira a +Z, su izquierda es +X, arriba +Y) y se convierten al
 * espacio local de cada hueso, así significan lo mismo sea cual sea el roll del
 * hueso que dejó el auto-rig.
 */

export type CharState = 'drive' | 'exiting' | 'foot' | 'approach' | 'entering';

export interface CharacterOptions {
  scene: THREE.Scene;
  gltf: GLTF;
  /** Nodo raíz del vehículo: marco de las cotas del habitáculo (frente en -Z, izquierda en -X). */
  vehicle: THREE.Object3D;
  /** Carrocería (sigue a la suspensión): el asiento va pegado a ella. */
  body: THREE.Object3D;
  /** Mallas que cuentan como suelo al caminar. */
  groundMeshes: THREE.Mesh[];
  onSeated: () => void;
  onSay: (text: string, ms: number) => void;
}

export interface CharacterInput {
  /** Dirección deseada en el plano XZ de mundo, longitud 0..1. */
  move: THREE.Vector3;
  run: boolean;
  /** Punto que mira (cursor proyectado o cámara), en mundo. */
  lookAt: THREE.Vector3 | null;
}

// ───────────────────────── utilidades
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const Q = () => new THREE.Quaternion();
const deg = THREE.MathUtils.degToRad;
const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const ss = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const ease = (t: number) => ss(0, 1, t);
const qE = (x: number, y: number, z: number, order: THREE.EulerOrder = 'XYZ') =>
  new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, order));
const angDiff = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const SIDES = [['L', 1], ['R', -1]] as const;
type Side = 'L' | 'R';

// ───────────────────────── poses de captura (deltas de mundo desde la pose T, marco del personaje, [w,x,y,z])
// Brazos colgando, tomados de la captura de caminar en el instante en que pasan
// bajo los hombros: la clavícula baja ~22° y el húmero rota hacia dentro. Bajar
// solo el brazo deja una esquina cuadrada tipo hombrera.
const MOCAP_HANG: Record<string, [number, number, number, number]> = {
  spine003: [0.9984, -0.0136, -0.0521, 0.0194],
  shoulderL: [0.9809, 0.0585, -0.1325, -0.1297], upper_armL: [-0.766, -0.2721, 0.2648, 0.5187],
  forearmL: [-0.764, -0.3106, 0.134, 0.5494], handL: [-0.7519, -0.309, 0.2388, 0.5312],
  shoulderR: [0.9829, 0.0502, -0.041, 0.1724], upper_armR: [-0.8137, -0.1524, -0.1507, -0.5403],
  forearmR: [-0.7928, -0.1214, -0.1015, -0.5886], handR: [-0.7607, -0.1439, -0.1427, -0.6167],
};
const mocapQ = (n: string) => {
  const [w, x, y, z] = MOCAP_HANG[n]!;
  return new THREE.Quaternion(x, y, z, w);
};
/** Rotación propia de cada hueso del brazo (relativa a su padre ya rotado). */
const HANG: Record<string, THREE.Quaternion> = {};
for (const s of ['L', 'R']) {
  const chain = ['spine003', `shoulder${s}`, `upper_arm${s}`, `forearm${s}`, `hand${s}`];
  for (let i = 1; i < chain.length; i++) HANG[chain[i]!] = mocapQ(chain[i - 1]!).invert().multiply(mocapQ(chain[i]!));
}

// ───────────────────────── habitáculo de la F100 (marco del vehículo, medido en escena.glb)
const CAB = {
  /** origen del personaje sentado: pelvis a 0,1 m sobre el banco (0,77) */
  seat: V(-0.4, 0.323, -0.12),
  hipDrop: -0.445,
  wheelCenter: V(-0.4, 1.17, -0.56),
  wheelRadius: 0.205,
  /** el aro está inclinado ~30° hacia el conductor (bbox: 0,38 m en Y, 0,22 m en Z) */
  wheelUp: V(0, Math.cos(deg(30)), Math.sin(deg(30))),
  pedals: { L: V(-0.5, 0.52, -0.72), R: V(-0.29, 0.52, -0.74) },
  /** de pie junto a la puerta del conductor, mirando hacia fuera (-X) */
  door: V(-1.3, 0, -0.2),
};

const JUMP = { take: 0.28, off: 0.55, land: 1.05, T: 1.75 };
const FLIGHT = JUMP.land - JUMP.off, V0 = (9.81 * FLIGHT) / 2;
const EXIT_T = 1.8;
const WALK = 1.45, RUN = 4.4;

const VIS: Record<string, [number, number, number]> = {
  a: [1, 0.2, 0], á: [1, 0.2, 0], e: [0.55, 0.75, 0], é: [0.55, 0.75, 0], i: [0.32, 0.95, 0], í: [0.32, 0.95, 0],
  o: [0.62, 0, 0.85], ó: [0.62, 0, 0.85], u: [0.35, 0, 1], ú: [0.35, 0, 1], m: [0, 0, 0], b: [0, 0, 0], p: [0, 0, 0],
  f: [0.12, 0.25, 0], v: [0.12, 0.25, 0], l: [0.35, 0.2, 0], r: [0.3, 0.25, 0], s: [0.2, 0.55, 0], ' ': [0, 0, 0],
};
const DEFAULT_VIS: [number, number, number] = [0.28, 0.25, 0.08];
const PHRASES = ['¡Hola! ¿Qué tal?', 'Bonita tarde para conducir.', 'Voy a estirar las piernas.', 'Mira qué paisaje.', 'Todo bajo control.'];

interface RestInfo { L: THREE.Quaternion; P: THREE.Vector3; W: THREE.Quaternion; Winv: THREE.Quaternion; WP: THREE.Vector3; M: THREE.Matrix4 }
interface Shell { mesh: THREE.Mesh; v: THREE.Vector3; w: THREE.Vector3; life: number; bounces: number }
type GunState = 'holstered' | 'reach' | 'raise' | 'aim' | 'lower' | 'stow';

export function createCharacter(opts: CharacterOptions) {
  const { scene, gltf, vehicle, body } = opts;

  const root = new THREE.Group();
  root.name = 'Personaje';
  scene.add(root);
  const model = gltf.scene;
  root.add(model);

  const B: Record<string, THREE.Bone> = {};
  let mesh: THREE.SkinnedMesh | null = null;
  model.traverse((o) => {
    if ((o as THREE.Bone).isBone) B[o.name.replace(/[^A-Za-z0-9_]/g, '')] = o as THREE.Bone;
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) {
      mesh = o as THREE.SkinnedMesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
    }
  });
  if (!mesh) throw new Error('personaje.glb: no hay malla con esqueleto');
  const skin: THREE.SkinnedMesh = mesh;

  // reposo, con el modelo en el origen del personaje
  model.updateMatrixWorld(true);
  const REST = new Map<THREE.Object3D, RestInfo>();
  model.traverse((o) => {
    if (!(o as THREE.Bone).isBone) return;
    const W = o.getWorldQuaternion(Q());
    REST.set(o, { L: o.quaternion.clone(), P: o.position.clone(), W, Winv: W.clone().invert(), WP: o.getWorldPosition(V()), M: o.matrixWorld.clone() });
  });
  const rest = (b: THREE.Object3D) => REST.get(b)!;
  const restLocal = (bone: THREE.Object3D, qChar: THREE.Quaternion) => {
    const r = rest(bone);
    return r.L.clone().multiply(r.Winv.clone().multiply(qChar).multiply(r.W));
  };
  const wp = (n: string) => rest(B[n]!).WP;

  // en la pose T de Meshy antebrazo y mano no son colineales con el brazo: se mide el desvío
  // para que los ángulos procedurales sean ángulos articulares reales (0° = brazo recto)
  const STRAIGHT: Record<string, THREE.Quaternion> = {};
  const RP: Record<string, THREE.Vector3> = {};
  for (const s of ['L', 'R'] as const) {
    const side = s === 'L' ? 'Left' : 'Right';
    const u = wp(`forearm${s}`).clone().sub(wp(`upper_arm${s}`)).normalize();
    const f = wp(`hand${s}`).clone().sub(wp(`forearm${s}`)).normalize();
    const h = wp(`${side}Hand_End`).clone().sub(wp(`hand${s}`)).normalize();
    STRAIGHT[`fore${s}`] = Q().setFromUnitVectors(f, u);
    STRAIGHT[`hand${s}`] = Q().setFromUnitVectors(h, f);
    RP[`ankle${s}`] = wp(`foot${s}`).clone();
    RP[`footDir${s}`] = wp(`toe${s}`).clone().sub(wp(`foot${s}`)).normalize();
    RP[`toeDir${s}`] = wp(`${side}Toe_end`).clone().sub(wp(`toe${s}`)).normalize();
    RP[`hip${s}`] = wp(`thigh${s}`).clone();
  }

  // ───────────────────────── herramientas de pose (marco del personaje = root)
  const _p = Q(), _r = Q();
  function premultiplyWorld(bone: THREE.Object3D, qChar: THREE.Quaternion) {
    root.getWorldQuaternion(_r);
    const qw = _r.clone().multiply(qChar).multiply(_r.clone().invert());
    bone.parent!.getWorldQuaternion(_p);
    bone.quaternion.premultiply(_p.clone().invert().multiply(qw).multiply(_p));
    bone.updateMatrixWorld(true);
  }
  function setWorldRot(bone: THREE.Object3D, qChar: THREE.Quaternion) {
    root.getWorldQuaternion(_r);
    bone.parent!.getWorldQuaternion(_p);
    bone.quaternion.copy(_p.invert().multiply(_r.clone().multiply(qChar)));
    bone.updateMatrixWorld(true);
  }
  const posC = (bone: THREE.Object3D, out = V()) => root.worldToLocal(bone.getWorldPosition(out));
  function aimBone(bone: THREE.Object3D, child: THREE.Object3D, dir: THREE.Vector3) {
    const cur = posC(child).sub(posC(bone)).normalize();
    premultiplyWorld(bone, Q().setFromUnitVectors(cur, dir.clone().normalize()));
  }
  /** IK analítica de dos huesos: a (cadera/hombro) → b (rodilla/codo) → c alcanza T doblando hacia `pole`. */
  function ik2(a: THREE.Object3D, b: THREE.Object3D, c: THREE.Object3D, T: THREE.Vector3, pole: THREE.Vector3) {
    const A0 = posC(a), B0 = posC(b), C0 = posC(c);
    const l1 = A0.distanceTo(B0), l2 = B0.distanceTo(C0);
    const toT = T.clone().sub(A0), dir = toT.clone().normalize();
    const d = clamp(toT.length(), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
    const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
    const pp = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
    const K = A0.clone().addScaledVector(dir, l1 * cosA).addScaledVector(pp, l1 * sinA);
    premultiplyWorld(a, Q().setFromUnitVectors(B0.sub(A0).normalize(), K.sub(A0).normalize()));
    const B1 = posC(b), C1 = posC(c), Tc = A0.clone().addScaledVector(dir, d);
    premultiplyWorld(b, Q().setFromUnitVectors(C1.sub(B1).normalize(), Tc.sub(B1).normalize()));
  }
  const snap = (bones: THREE.Object3D[]) => bones.map((b) => b.quaternion.clone());
  function blendBack(bones: THREE.Object3D[], saved: THREE.Quaternion[], w: number) {
    if (w >= 0.999) return;
    bones.forEach((b, i) => b.quaternion.copy(saved[i]!.clone().slerp(b.quaternion, w)));
    model.updateMatrixWorld(true);
  }
  /** Rotación (marco del personaje) que lleva los ejes de reposo (dedos f0, palma n0) a (f, n). */
  function basisRot(f0: THREE.Vector3, n0: THREE.Vector3, f: THREE.Vector3, n: THREE.Vector3) {
    const nn = n.clone().addScaledVector(f, -n.dot(f)).normalize();
    const Mr = new THREE.Matrix4().makeBasis(f0, n0, f0.clone().cross(n0));
    const Md = new THREE.Matrix4().makeBasis(f, nn, f.clone().cross(nn));
    return Q().setFromRotationMatrix(Md.multiply(Mr.transpose()));
  }

  // ───────────────────────── clip de reposo procedural (peso, respiración, péndulo de brazos)
  function idleRotations(t: number) {
    const w = Math.sin((2 * Math.PI * t) / 6);
    const br = Math.sin((2 * Math.PI * t) / 3);
    const sw = Math.sin((2 * Math.PI * t) / 2 + 0.6);
    const dx = 0.012 * w;
    const legAb = Math.atan(dx / 0.88);
    const R: Record<string, THREE.Quaternion> = {
      spine: qE(0, deg(1.5) * Math.sin((2 * Math.PI * t) / 6 + 1.2), deg(-1.6) * w, 'YXZ'),
      spine001: qE(deg(0.6) * br, 0, deg(0.9) * w),
      spine002: qE(deg(-1.0) * br, 0, deg(0.5) * w),
      spine003: qE(deg(-0.8) * br, 0, 0),
      spine005: qE(deg(3) + deg(1.2) * Math.sin((2 * Math.PI * t) / 6 + 2), deg(2.5) * Math.sin((2 * Math.PI * t) / 6 + 0.4), deg(-0.6) * w, 'YXZ'),
    };
    for (const [s, sg] of SIDES) {
      const relax = Math.abs(w) * (sg * w > 0 ? 0 : 1);
      R[`shoulder${s}`] = qE(0, 0, -sg * deg(1.2) * br).multiply(HANG[`shoulder${s}`]!);
      R[`upper_arm${s}`] = qE(-deg(1.5) * sw * sg, 0, 0).multiply(HANG[`upper_arm${s}`]!);
      R[`forearm${s}`] = HANG[`forearm${s}`]!.clone();
      R[`hand${s}`] = HANG[`hand${s}`]!.clone();
      R[`thigh${s}`] = qE(-deg(5) * relax, 0, -legAb + sg * deg(1.2), 'XZY');
      R[`shin${s}`] = qE(deg(10) * relax, 0, 0);
      R[`foot${s}`] = qE(-deg(5) * relax, 0, legAb - sg * deg(1.2), 'XZY');
    }
    return { R, hip: V(dx, (-0.004 * (1 - Math.cos((4 * Math.PI * t) / 6))) / 2, 0) };
  }
  function buildIdleClip() {
    const T = 6, fps = 30, n = T * fps + 1;
    const tracks: Record<string, Float32Array> = {};
    const times = new Float32Array(n), hipPos = new Float32Array(n * 3);
    const hip0 = rest(B.spine!).P;
    for (let i = 0; i < n; i++) {
      const t = i / fps;
      times[i] = t;
      const { R, hip } = idleRotations(t);
      for (const name in R) {
        const q = restLocal(B[name]!, R[name]!);
        (tracks[name] ??= new Float32Array(n * 4)).set([q.x, q.y, q.z, q.w], i * 4);
      }
      hipPos.set([hip0.x + hip.x, hip0.y + hip.y, hip0.z + hip.z], i * 3);
    }
    const list: THREE.KeyframeTrack[] = Object.entries(tracks).map(([name, v]) => new THREE.QuaternionKeyframeTrack(`${B[name]!.name}.quaternion`, times, v));
    list.push(new THREE.VectorKeyframeTrack(`${B.spine!.name}.position`, times, hipPos));
    return new THREE.AnimationClip('Idle', T, list);
  }

  // ───────────────────────── mixer: reposo + caminar/correr sincronizados por fase de pisada
  const mixer = new THREE.AnimationMixer(model);
  const clip = (n: string) => {
    const c = gltf.animations.find((a) => a.name === n);
    if (!c) throw new Error(`personaje.glb: falta el clip ${n}`);
    return c;
  };
  function footPhase(c: THREE.AnimationClip) {
    const m = new THREE.AnimationMixer(model), a = m.clipAction(c).play();
    let best = -1e9, ph = 0;
    const p = V(), h = V();
    for (let i = 0; i < 64; i++) {
      m.setTime((c.duration * i) / 64);
      model.updateMatrixWorld(true);
      B.footL!.getWorldPosition(p);
      B.spine!.getWorldPosition(h);
      if (p.z - h.z > best) { best = p.z - h.z; ph = i / 64; }
    }
    a.stop();
    m.uncacheRoot(model);
    return ph;
  }
  const walkClip = clip('Walking'), runClip = clip('Running');
  const gait = {
    walk: { clip: walkClip, stride: 1.5 * walkClip.duration, offset: footPhase(walkClip) },
    run: { clip: runClip, stride: 5.1 * runClip.duration, offset: footPhase(runClip) },
  };
  const acts = {
    idle: mixer.clipAction(buildIdleClip()),
    walk: mixer.clipAction(walkClip),
    run: mixer.clipAction(runClip),
  };
  for (const a of Object.values(acts)) { a.play(); a.setEffectiveWeight(0); }
  acts.idle.setEffectiveWeight(1);
  acts.walk.timeScale = acts.run.timeScale = 0;

  // ───────────────────────── pistola y funda
  const metal = new THREE.MeshStandardMaterial({ color: 0x23272c, metalness: 0.8, roughness: 0.35 });
  const poly = new THREE.MeshStandardMaterial({ color: 0x15171a, metalness: 0.05, roughness: 0.75 });
  const leather = new THREE.MeshStandardMaterial({ color: 0x2a2018, metalness: 0, roughness: 0.85 });
  const pistol = new THREE.Group();
  const addPart = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    m.castShadow = true;
    pistol.add(m);
    return m;
  };
  const slide = addPart(new THREE.BoxGeometry(0.027, 0.03, 0.18), metal, 0, 0.035, 0.05);
  addPart(new THREE.BoxGeometry(0.025, 0.018, 0.15), poly, 0, 0.012, 0.04);
  addPart(new THREE.BoxGeometry(0.026, 0.105, 0.042), poly, 0, -0.038, -0.022, 0.28);
  addPart(new THREE.BoxGeometry(0.004, 0.006, 0.006), metal, 0, 0.052, 0.132);
  addPart(new THREE.BoxGeometry(0.02, 0.006, 0.006), metal, 0, 0.052, -0.032);
  addPart(new THREE.TorusGeometry(0.017, 0.003, 6, 18, Math.PI), poly, 0, 0.003, 0.03).rotation.set(0, Math.PI / 2, Math.PI);
  addPart(new THREE.CylinderGeometry(0.006, 0.006, 0.01, 12), metal, 0, 0.036, 0.142, Math.PI / 2);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.036, 0.15);
  const port = new THREE.Object3D();
  port.position.set(-0.016, 0.042, 0.035);
  pistol.add(muzzle, port);

  // agarre definido en la pose T: cañón a lo largo del brazo (-X), miras hacia el pulgar (+Z);
  // la empuñadura cruza el puño bajo las falanges proximales para que los dedos la cierren
  const gripRest = new THREE.Matrix4().makeBasis(V(0, -1, 0), V(0, 0, 1), V(-1, 0, 0));
  gripRest.setPosition(wp('handR').clone().add(V(-0.137, -0.028, 0.09)));
  const PLOC = rest(B.handR!).M.clone().invert().multiply(gripRest);
  const PLOC_INV = PLOC.clone().invert();
  const holsterRest = new THREE.Matrix4().makeRotationX(Math.PI / 2).premultiply(new THREE.Matrix4().makeRotationZ(deg(-4)));
  holsterRest.setPosition(V(-0.228, 0.935, -0.035));
  const HLOC = rest(B.spine!).M.clone().invert().multiply(holsterRest);
  const holster = new THREE.Group();
  const hb = new THREE.Mesh(new THREE.BoxGeometry(0.038, 0.034, 0.16), leather);
  hb.position.set(0, 0.03, 0.06);
  hb.castShadow = true;
  const hc = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.05, 0.05), leather);
  hc.position.set(0.024, 0.03, -0.01);
  holster.add(hb, hc);
  B.spine!.add(holster);
  HLOC.decompose(holster.position, holster.quaternion, holster.scale);
  const holsterPistol = () => { B.spine!.add(pistol); HLOC.decompose(pistol.position, pistol.quaternion, pistol.scale); };
  const pistolToHand = () => { B.handR!.add(pistol); PLOC.decompose(pistol.position, pistol.quaternion, pistol.scale); };
  holsterPistol();
  // mano izquierda de apoyo, en el marco de la pistola: dedos adelante y algo cruzados, palma hacia el arma
  const LHAND_R = basisRot(V(1, 0, 0), V(0, -1, 0), V(-0.35, -0.12, 0.93).normalize(), V(-1, 0.35, 0).normalize());

  const flashCanvas = document.createElement('canvas');
  flashCanvas.width = flashCanvas.height = 64;
  {
    const x = flashCanvas.getContext('2d')!;
    const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,250,220,1)');
    gr.addColorStop(0.25, 'rgba(255,200,90,0.9)');
    gr.addColorStop(1, 'rgba(255,120,20,0)');
    x.fillStyle = gr;
    x.fillRect(0, 0, 64, 64);
  }
  const flashTex = new THREE.CanvasTexture(flashCanvas);
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  flash.visible = false;
  const flashLight = new THREE.PointLight(0xffb060, 0, 3, 2);
  muzzle.add(flash, flashLight);

  // ───────────────────────── boca: el rig no trae mandíbula; tres morphs y oscurecido de la comisura
  const MOUTH = { xc: 0.006, y: 1.579, hingeY: 1.6, hingeZ: 0.015 };
  const uMouth = { value: 0 };
  {
    const geo = skin.geometry;
    const P = geo.getAttribute('position') as THREE.BufferAttribute, n = P.count;
    const jaw = new Float32Array(n * 3), wide = new Float32Array(n * 3), round = new Float32Array(n * 3), gap = new Float32Array(n);
    const th = 0.2, c = Math.cos(th), s = Math.sin(th);
    for (let i = 0; i < n; i++) {
      const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
      if (y < 1.44 || z < 0 || Math.abs(x) > 0.13) continue;
      const ax = Math.abs(x - MOUTH.xc);
      const wj = ss(MOUTH.y + 0.0015, MOUTH.y - 0.004, y) * ss(0.03, 0.075, z) * (1 - ss(0.07, 0.095, ax)) * ss(1.475, 1.52, y);
      const dy = y - MOUTH.hingeY, dz = z - MOUTH.hingeZ;
      jaw[i * 3 + 1] = (dy * c - dz * s - dy) * wj;
      jaw[i * 3 + 2] = (dy * s + dz * c - dz) * wj;
      const wu = ss(MOUTH.y - 0.001, MOUTH.y + 0.003, y) * ss(MOUTH.y + 0.013, MOUTH.y + 0.006, y) * ss(0.105, 0.12, z) * (1 - ss(0.025, 0.04, ax));
      jaw[i * 3 + 1] = jaw[i * 3 + 1]! + 0.0025 * wu;
      const ww = Math.exp(-(((y - MOUTH.y) / 0.012) ** 2)) * (1 - ss(0.04, 0.06, ax)) * ss(0.09, 0.115, z);
      wide[i * 3] = (x - MOUTH.xc) * 0.2 * ww;
      wide[i * 3 + 2] = -0.003 * ww;
      round[i * 3] = -(x - MOUTH.xc) * 0.28 * ww;
      round[i * 3 + 2] = 0.006 * ww * (1 - Math.min(1, ax / 0.04));
      gap[i] = Math.exp(-(((y - MOUTH.y) / 0.0028) ** 2)) * (1 - ss(0.026, 0.036, ax)) * ss(0.11, 0.125, z);
    }
    geo.morphAttributes.position = [jaw, wide, round].map((a) => new THREE.Float32BufferAttribute(a, 3));
    geo.morphTargetsRelative = true;
    geo.setAttribute('aGap', new THREE.BufferAttribute(gap, 1));
    skin.updateMorphTargets();
    skin.morphTargetInfluences!.fill(0);
    const mat = skin.material as THREE.MeshStandardMaterial;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uMouth = uMouth;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aGap;\nvarying float vGap;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGap = aGap;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uMouth;\nvarying float vGap;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= 1.0 - 0.82 * clamp(vGap * uMouth, 0.0, 1.0);');
    };
    mat.needsUpdate = true;
  }

  // ───────────────────────── estado
  let state: CharState = 'drive';
  let stateT = 0;
  let heading = 0, speed = 0, phase = 0, yawRate = 0, lean = 0, t = 0;
  let legW = 0, terrainDrop = 0;
  let ground: Heightfield | null = null;
  let waveT = -1, flashT = 0, shake = 0;
  const look = { yaw: 0, pitch: 0, vy: 0, vp: 0 };
  const hands = { L: { c: 0.2, g: 0 }, R: { c: 0.2, g: 0 } };
  const kneel = { target: 0, k: 0 };
  const gun = { state: 'holstered' as GunState, t: 0, from: null as THREE.Matrix4 | null, recoil: 0, queued: false };
  const J = {
    t: -1, el: 0, T: JUMP.T, moving: false, vm: 0, vf: 1.9, vel: 0, want: 0, vEnd: 0, vEndSet: false,
    push: 'R' as Side, lead: 'L' as Side, P0: V(), L0: V(), r0: null as THREE.Vector3 | null, landW: {} as Partial<Record<Side, THREE.Vector3>>,
  };
  const talk = { on: false, text: '', start: 0, mode: 'timed' as 'timed' | 'words', idx: 0, idxT: 0, cps: 13, nod: 0, nodV: 0, mouth: [0, 0, 0] as [number, number, number], heard: false };
  let voiceShape: (() => [number, number, number] | null) | null = null;
  let voiceOnset: (() => boolean) | null = null;
  const shells: Shell[] = [];
  const shellGeo = new THREE.CylinderGeometry(0.0045, 0.0045, 0.019, 10);
  const shellMat = new THREE.MeshStandardMaterial({ color: 0xc8a050, metalness: 0.9, roughness: 0.3 });
  // pose de salida/entrada: desde el asiento hasta la puerta
  const exitFrom = { pos: V(), quat: Q() };
  const exitTo = { pos: V(), yaw: 0 };
  /** a dónde camina solo en `approach`: la puerta (para subirse) o un punto cualquiera */
  let goal: { pos: THREE.Vector3; yaw: number | null; enter: boolean } | null = null;
  /** rumbo al que girar en el sitio al llegar (mirar al lago, por ejemplo) */
  let faceYaw: number | null = null;

  const allBones = Object.values(B);
  const LEG = { L: ['thighL', 'shinL', 'footL', 'toeL'].map((n) => B[n]!), R: ['thighR', 'shinR', 'footR', 'toeR'].map((n) => B[n]!) };
  const TOE_END = { L: B.LeftToe_end!, R: B.RightToe_end! };
  const ARM_R = ['shoulderR', 'upper_armR', 'forearmR', 'handR'].map((n) => B[n]!);
  const ARM_L = ['shoulderL', 'upper_armL', 'forearmL', 'handL'].map((n) => B[n]!);
  const layerBase = new Map<THREE.Object3D, { q: THREE.Quaternion; p: THREE.Vector3 }>();
  const groundY = (x: number, z: number) => (ground ? ground.at(x, z) : root.position.y);

  // ───────────────────────── asiento: marco del vehículo → marco de la carrocería
  vehicle.updateWorldMatrix(true, true);
  const seatInVehicle = new THREE.Matrix4().compose(CAB.seat, Q().setFromAxisAngle(V(0, 1, 0), Math.PI), V(1, 1, 1));
  const vehicleToBody = body.matrixWorld.clone().invert().multiply(vehicle.matrixWorld);
  const SEAT = vehicleToBody.clone().multiply(seatInVehicle);
  const seatWorld = () => body.matrixWorld.clone().multiply(SEAT);
  const vehToWorld = (p: THREE.Vector3) => p.clone().applyMatrix4(vehicle.matrixWorld);
  const vehDirToWorld = (d: THREE.Vector3) => d.clone().transformDirection(vehicle.matrixWorld);
  const vehicleYaw = () => {
    const f = vehDirToWorld(V(0, 0, -1));
    return Math.atan2(f.x, f.z);
  };
  const doorWorld = () => {
    const p = vehToWorld(CAB.door);
    p.y = groundY(p.x, p.z);
    return p;
  };
  function placeAtSeat() {
    seatWorld().decompose(root.position, root.quaternion, root.scale);
    root.scale.set(1, 1, 1);
  }
  placeAtSeat();

  // ───────────────────────── acciones
  function startJump() {
    if (state !== 'foot' || J.t >= 0) return;
    if (kneel.target) { toggleKneel(); return; }
    const moving = speed > 0.6;
    const fz = (s: Side) => posC(B[`foot${s}`]!).z;
    J.push = moving ? (fz('L') > fz('R') ? 'L' : 'R') : 'R';
    J.lead = J.push === 'L' ? 'R' : 'L';
    Object.assign(J, { moving, vm: speed, vf: Math.max(1.9, speed * 1.05), vel: speed, want: 0, vEnd: 0, vEndSet: false, r0: null, landW: {}, el: 0 });
    const plantAt = (s: Side) => {
      const p = moving ? posC(B[`foot${s}`]!) : RP[`ankle${s}`]!.clone();
      p.y = RP[`ankle${s}`]!.y;
      return root.localToWorld(p);
    };
    J.P0 = plantAt(J.push);
    J.L0 = plantAt(J.lead);
    J.T = moving ? JUMP.land + 0.45 : JUMP.T;
    J.t = moving ? JUMP.take : 0;
  }
  function toggleKneel() {
    if (state !== 'foot' || J.t >= 0) return;
    kneel.target = kneel.target ? 0 : 1;
  }
  function toggleGun() {
    if (state !== 'foot') return;
    if (gun.state === 'holstered') { gun.state = 'reach'; gun.t = 0; waveT = -1; }
    else if (gun.state === 'aim' || gun.state === 'raise') { gun.state = 'lower'; gun.t = 0; gun.from = null; gun.queued = false; }
  }
  function shoot() {
    if (gun.recoil > 0.35) { gun.queued = true; return; }
    gun.recoil = 1;
    flashT = 0.06;
    shake = 1;
    gunshotSound();
    const m = new THREE.Mesh(shellGeo, shellMat);
    m.castShadow = true;
    port.getWorldPosition(m.position);
    scene.add(m);
    const right = V(-1, 0, 0).applyQuaternion(root.quaternion);
    shells.push({ mesh: m, v: right.multiplyScalar(1.6 + Math.random() * 0.6).add(V(0, 1.7 + Math.random() * 0.5, 0)), w: V(Math.random() * 30, Math.random() * 30, 0), life: 6, bounces: 0 });
    if (shells.length > 12) scene.remove(shells.shift()!.mesh);
  }
  function fire() {
    if (state !== 'foot') return;
    resumeAudio();
    if (gun.state === 'holstered') { toggleGun(); gun.queued = true; return; }
    if (gun.state === 'aim') shoot();
    else if (gun.state === 'reach' || gun.state === 'raise') gun.queued = true;
  }
  function wave() {
    if (state === 'foot' && gun.state !== 'holstered') { fire(); return; }
    if (state !== 'foot' || waveT >= 0) return;
    waveT = 0;
    opts.onSay('¡Hola!', 1800);
  }

  // ───────────────────────── habla (síntesis de voz del navegador + visemas)
  let esVoice: SpeechSynthesisVoice | null = null;
  const pickVoice = () => {
    const vs = speechSynthesis.getVoices();
    esVoice = vs.find((v) => /^es[-_]ES/i.test(v.lang)) ?? vs.find((v) => /^es/i.test(v.lang)) ?? null;
  };
  const hasSpeech = typeof speechSynthesis !== 'undefined';
  if (hasSpeech) {
    pickVoice();
    speechSynthesis.addEventListener('voiceschanged', pickVoice);
  }
  function speak(text: string) {
    const said = text.trim() || PHRASES[Math.floor(Math.random() * PHRASES.length)]!;
    const now = performance.now();
    Object.assign(talk, { on: true, text: said, start: now, mode: 'timed', idx: 0, idxT: now, heard: false, cps: 13 });
    opts.onSay(said, 1500 + said.length * 85);
    if (!hasSpeech) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(said);
      u.lang = esVoice?.lang ?? 'es-ES';
      if (esVoice) u.voice = esVoice;
      u.pitch = 0.9;
      u.onstart = () => { talk.heard = true; talk.start = performance.now(); talk.idx = 0; talk.idxT = talk.start; };
      u.onboundary = (e) => {
        if (e.name && e.name !== 'word') return;
        talk.mode = 'words';
        talk.idx = e.charIndex;
        talk.idxT = performance.now();
        talk.nodV += 1;
      };
      u.onend = () => { talk.on = false; };
      u.onerror = () => { talk.heard = false; };
      speechSynthesis.speak(u);
    } catch {
      /* sin voz: la boca sigue con el ritmo estimado */
    }
  }
  function stopSpeech() {
    talk.on = false;
    if (hasSpeech) speechSynthesis.cancel();
  }
  function talkUpdate(dt: number) {
    let target: [number, number, number] = [0, 0, 0];
    const vs = voiceShape?.() ?? null;
    if (vs) {
      target = vs;
      if (voiceOnset?.()) talk.nodV += 0.6;
    } else if (talk.on) {
      const now = performance.now(), text = talk.text.toLowerCase();
      let i = talk.mode === 'words' ? talk.idx + Math.floor(((now - talk.idxT) / 1000) * talk.cps) : Math.floor(((now - talk.start) / 1000) * talk.cps);
      if (i >= text.length) {
        if (!talk.heard || talk.mode === 'timed') talk.on = talk.heard && now - talk.start < (text.length / talk.cps) * 1000 + 1500;
        i = text.length - 1;
      }
      const ch = text[Math.max(0, i)] ?? ' ';
      const v = VIS[ch] ?? DEFAULT_VIS;
      target = /[.,;:!?¡¿]/.test(ch) ? [0, 0, 0] : [v[0], v[1], v[2]];
      if (talk.mode === 'timed' && ch === ' ' && text[i - 1] !== ' ') talk.nodV += 0.02;
      target[0] *= 0.75 + 0.25 * Math.sin(((now - talk.start) / 1000) * 2 * Math.PI * 5.5);
    }
    const inf = skin.morphTargetInfluences!;
    for (let k = 0; k < 3; k++) {
      talk.mouth[k] = talk.mouth[k]! + (target[k]! - talk.mouth[k]!) * (1 - Math.exp(-dt * 22));
      inf[k] = talk.mouth[k]!;
    }
    uMouth.value = clamp(talk.mouth[0] * 1.3 + talk.mouth[2] * 0.4, 0, 1);
    const a = -60 * talk.nod - 9 * talk.nodV;
    talk.nodV += a * dt;
    talk.nod += talk.nodV * dt * 0.6;
    if (!talk.on && !vs) talk.nod *= Math.exp(-dt * 4);
  }

  // ───────────────────────── dedos (manopla de 3 cadenas + pulgar)
  const FINGER_ANG = [deg(82), deg(95), deg(62)];
  const FINGER_MUL: Record<string, number> = { idx: 0.93, mid: 1, pky: 1.08 };
  function poseFingers(s: Side, curl: number, grip: number) {
    const sg = s === 'R' ? 1 : -1;
    for (const f in FINGER_MUL) for (let i = 0; i < 3; i++) {
      const b = B[`f_${f}${i + 1}${s}`];
      if (b) b.quaternion.copy(restLocal(b, qE(0, 0, sg * FINGER_ANG[i]! * curl * FINGER_MUL[f]!)));
    }
    const t1 = B[`f_thb1${s}`], t2 = B[`f_thb2${s}`], t3 = B[`f_thb3${s}`];
    if (t1) t1.quaternion.copy(restLocal(t1, qE(deg(6) + deg(12) * grip, -sg * deg(35) * grip, 0, 'YXZ')));
    if (t2) t2.quaternion.copy(restLocal(t2, qE(deg(6) + deg(14) * Math.max(grip, curl * 0.6), 0, 0)));
    if (t3) t3.quaternion.copy(restLocal(t3, qE(deg(4) + deg(18) * Math.max(grip, curl * 0.6), 0, 0)));
  }

  // ───────────────────────── salto
  function jumpVel(j: number) {
    if (j < JUMP.take) return J.moving ? J.vm : -0.15 * Math.sin((Math.PI * j) / JUMP.take);
    if (j < JUMP.off) {
      const u = (j - JUMP.take) / (JUMP.off - JUMP.take);
      return J.moving ? lerp(J.vm, J.vf, u) : J.vf * Math.pow(u, 0.8);
    }
    if (j < JUMP.land) return J.vf;
    return lerp(J.vf, J.vEnd, ease((j - JUMP.land) / (J.moving ? 0.3 : 0.35)));
  }
  const jumpLift = (j: number) => { const tt = j - JUMP.off; return tt > 0 && tt < FLIGHT ? V0 * tt - 4.905 * tt * tt : 0; };
  function jumpAbsorb(j: number) {
    const a = j - JUMP.land;
    if (a < 0) return 0;
    const hit = J.moving ? 0.09 : 0.12;
    return a < hit ? Math.sin(((a / hit) * Math.PI) / 2) : 1 - ease((a - hit) / (J.T - JUMP.land - hit));
  }
  function jumpHipsOff(j: number) {
    const side = J.push === 'L' ? 1 : -1;
    let y: number, x: number;
    if (j < JUMP.take) { const c = ease(j / JUMP.take); y = -0.1 * c; x = 0.035 * side * c; }
    else if (j < JUMP.off) {
      const u = (j - JUMP.take) / (JUMP.off - JUMP.take);
      if (J.moving) { y = -0.06 * Math.sin(Math.PI * u) + 0.03 * u; x = 0.02 * side * Math.sin(Math.PI * u); }
      else { y = lerp(-0.1, 0.03, ease(u)); x = 0.035 * side; }
    } else if (j < JUMP.land) { const u = (j - JUMP.off) / FLIGHT; y = 0.03 * (1 - u); x = (J.moving ? 0 : 0.035 * side) * (1 - ease(u)); }
    else { y = (J.moving ? -0.13 : -0.2) * jumpAbsorb(j); x = 0; }
    return V(x, y, 0);
  }
  const jumpHip = (s: Side, j: number) => RP[`hip${s}`]!.clone().add(jumpHipsOff(j)).add(V(0, jumpLift(j), 0));

  /** Objetivos de una pierna (marco del personaje, suelo plano en y = 0) para rodilla y salto. */
  function legTargets(s: Side) {
    const k = kneel.k, j = J.t;
    const st = RP[`ankle${s}`]!.clone();
    let ank = st.clone();
    const pole = V(0, 0, 1), fdir = RP[`footDir${s}`]!.clone(), tdir = RP[`toeDir${s}`]!.clone();
    if (k > 0) {
      if (s === 'L') {
        const kl = ss(0, 0.55, k);
        ank.lerpVectors(st, V(0.12, st.y, 0.34), kl);
        ank.y += 0.11 * Math.sin(Math.PI * kl);
        pole.set(0.1, 0.3, 1);
      } else {
        const kr = ss(0.25, 1, k);
        ank.lerpVectors(st, V(-0.1, 0.135, -0.5), kr);
        pole.set(-0.05, -lerp(-0.3, 1, kr), lerp(1, 0.15, kr)).normalize();
        fdir.lerp(V(0, -0.97, 0.12).normalize(), kr).normalize();
        tdir.lerp(V(0, 0, 1), kr).normalize();
      }
    }
    if (j >= 0) {
      const planted = (W: THREE.Vector3) => root.worldToLocal(W.clone());
      const landRel = st.clone().sub(RP[`hip${s}`]!).add(V(0, 0, 0.1));
      const hipNow = jumpHip(s, j);
      const plantar = V(0, -0.9, 0.44).normalize(), dorsi = V(0, -0.45, 0.89).normalize();
      if (j >= JUMP.land) {
        J.landW[s] ??= root.localToWorld(jumpHip(s, JUMP.land).add(landRel).setY(st.y));
        ank = planted(J.landW[s]!);
      } else if (s === J.lead) {
        const drive = V(0.01, -0.4, 0.26);
        if (j < JUMP.take) ank = planted(J.L0);
        else if (j < JUMP.off) {
          const u = ease((j - JUMP.take) / (JUMP.off - JUMP.take));
          ank = planted(J.L0).lerp(hipNow.clone().add(drive), u);
          fdir.lerp(dorsi, u).normalize();
        } else {
          const u = ease((j - JUMP.off) / FLIGHT);
          ank = hipNow.clone().add(drive.clone().lerp(landRel, u));
          fdir.lerp(dorsi, 1 - u).normalize();
        }
        pole.set(0.05, 0.25, 1).normalize();
      } else {
        if (j < JUMP.off) {
          ank = planted(J.P0);
          const h = ss(JUMP.take + (J.moving ? 0.02 : 0.1), JUMP.off, j);
          ank.y += 0.085 * h;
          fdir.lerp(plantar, h).normalize();
        } else {
          J.r0 ??= planted(J.P0).add(V(0, 0.085, 0)).sub(jumpHip(s, JUMP.off));
          const e = ease((j - JUMP.off) / FLIGHT);
          ank = hipNow.clone()
            .add(J.r0.clone().multiplyScalar((1 - e) * (1 - e)))
            .add(V(-0.01, -0.46, -0.18).multiplyScalar(2 * e * (1 - e)))
            .add(landRel.clone().multiplyScalar(e * e));
          fdir.lerp(plantar, 1 - e).normalize();
        }
        pole.set(-0.05, 0.1, 1).normalize();
      }
    }
    return { ank, pole, fdir, tdir };
  }
  /** Desnivel del terreno bajo un punto del marco del personaje respecto al de los pies del personaje. */
  const terrainDelta = (pChar: THREE.Vector3) => {
    if (!ground || state !== 'foot') return 0;
    const w = root.localToWorld(pChar.clone());
    return ground.at(w.x, w.z) - root.position.y;
  };

  // ───────────────────────── conducción: manos al aro, pies a los pedales
  function wheelGrip(s: Side) {
    const phi = deg(s === 'L' ? 150 : 30); // 10 y 2 en punto
    const X = V(1, 0, 0), U = CAB.wheelUp;
    const radial = X.clone().multiplyScalar(Math.cos(phi)).addScaledVector(U, Math.sin(phi));
    const rim = CAB.wheelCenter.clone().addScaledVector(radial, CAB.wheelRadius);
    const N = X.clone().cross(U).normalize(); // normal del aro, hacia el conductor
    const fingers = N.clone().negate().multiplyScalar(0.8).addScaledVector(radial, 0.5).normalize();
    const palm = radial.clone().negate().addScaledVector(N, -0.6).normalize();
    const wrist = rim.clone().addScaledVector(fingers, -0.085).addScaledVector(palm, -0.03);
    return { wrist: root.worldToLocal(vehToWorld(wrist)), fingers: worldDirToChar(vehDirToWorld(fingers)), palm: worldDirToChar(vehDirToWorld(palm)) };
  }
  const worldDirToChar = (d: THREE.Vector3) => d.clone().applyQuaternion(root.getWorldQuaternion(Q()).invert());

  // ───────────────────────── bajarse / subirse
  function exitVehicle() {
    if (state !== 'drive') return;
    // mapa de alturas de un cuadrado de 64 m alrededor de la puerta
    const d = vehToWorld(CAB.door);
    ground = buildHeightfield(opts.groundMeshes, d, 32, 0.2);
    exitFrom.pos.copy(root.position);
    exitFrom.quat.copy(root.quaternion);
    exitTo.pos.copy(doorWorld());
    exitTo.yaw = vehicleYaw() + Math.PI / 2; // mirando hacia fuera de la puerta izquierda
    state = 'exiting';
    stateT = 0;
  }
  function enterVehicle() {
    if (state !== 'foot') return;
    if (kneel.target) kneel.target = 0;
    if (gun.state !== 'holstered' && gun.state !== 'stow' && gun.state !== 'lower') { gun.state = 'lower'; gun.t = 0; gun.from = null; }
    waveT = -1;
    goal = { pos: doorWorld(), yaw: null, enter: true };
    faceYaw = null;
    state = 'approach';
  }
  /** Camina solo hasta `point` (mundo) y, si se da `yaw`, se gira hacia él al llegar. */
  function walkTo(point: THREE.Vector3, yaw: number | null = null) {
    if (state !== 'foot') return false;
    if (kneel.target) kneel.target = 0;
    waveT = -1;
    goal = { pos: point.clone(), yaw, enter: false };
    faceYaw = null;
    state = 'approach';
    return true;
  }

  // ───────────────────────── bucle
  const tmp = V(), headW = V();
  function update(dt: number, input: CharacterInput) {
    t += dt;
    stateT += dt;
    const foot = state === 'foot' || state === 'approach';
    const seated = state === 'drive' || state === 'exiting' || state === 'entering';

    // --- intención de movimiento
    const mv = input.move.clone();
    if (!foot || kneel.k > 0.02) mv.set(0, 0, 0);
    let targetSpeed = 0, wantHeading = heading;
    const armed = gun.state !== 'holstered';
    if (state === 'approach' && goal) {
      if (goal.enter) goal.pos.copy(doorWorld()); // la camioneta puede haberse movido
      tmp.subVectors(goal.pos, root.position).setY(0);
      const dist = tmp.length();
      if (dist < 0.3 && J.t < 0 && (gun.state === 'holstered' || !goal.enter)) {
        speed = Math.max(0, speed - dt * 6);
        if (speed < 0.05) {
          if (goal.enter) {
            exitFrom.pos.copy(root.position);
            exitTo.pos.copy(root.position);
            exitTo.yaw = heading;
            state = 'entering';
          } else {
            faceYaw = goal.yaw;
            state = 'foot';
          }
          goal = null;
          stateT = 0;
        }
      } else {
        targetSpeed = Math.min(WALK, dist * 1.6 + 0.3);
        wantHeading = Math.atan2(tmp.x, tmp.z);
      }
    } else if (mv.lengthSq() > 0.0025) {
      faceYaw = null;
      if (kneel.target) kneel.target = 0;
      const running = input.run && !armed;
      targetSpeed = running ? RUN : WALK * Math.max(0.5, Math.min(1, mv.length()));
      wantHeading = Math.atan2(mv.x, mv.z);
    }
    const jumping = J.t >= 0;
    if (foot) {
      const acc = targetSpeed > speed ? (targetSpeed > 2 ? 3.2 : 2.6) : kneel.k > 0.02 ? 6 : 3.4;
      if (jumping) { J.want = targetSpeed; speed = Math.max(0, J.vel); }
      else speed += clamp(targetSpeed - speed, -acc * dt, acc * dt);
      const maxTurn = lerp(7, 3.2, ss(1.5, 4.4, speed)) * (jumping ? 0 : 1);
      const turn = clamp(angDiff(heading, wantHeading), -maxTurn * dt, maxTurn * dt);
      if (speed > 0.05 || targetSpeed > 0) heading += turn;
      else if (faceYaw !== null && J.t < 0) {
        // girar en el sitio, sin prisa, hasta quedar mirando a donde toca
        const dy = angDiff(heading, faceYaw);
        heading += clamp(dy, -2.2 * dt, 2.2 * dt);
        if (Math.abs(dy) < 0.01) faceYaw = null;
      }
      yawRate += (turn / Math.max(dt, 1e-4) - yawRate) * (1 - Math.exp(-dt * 6));
      if (speed > 0.001 && !jumping) {
        root.position.x += Math.sin(heading) * speed * dt;
        root.position.z += Math.cos(heading) * speed * dt;
      }
    } else {
      speed = 0;
      yawRate = 0;
    }

    // --- marco del personaje según el estado
    let sitW = 0, wheelW = 0;
    if (state === 'drive') {
      placeAtSeat();
      sitW = 1;
      wheelW = 1;
    } else if (state === 'exiting' || state === 'entering') {
      const raw = clamp(stateT / EXIT_T, 0, 1);
      const u = state === 'exiting' ? raw : 1 - raw;
      // del asiento a un punto junto al umbral y de ahí al suelo
      const seatM = seatWorld();
      const sp = V(), sq = Q(), ssc = V();
      seatM.decompose(sp, sq, ssc);
      if (state === 'entering') { exitFrom.pos.copy(sp); exitFrom.quat.copy(sq); }
      const sill = vehToWorld(V(-0.92, CAB.seat.y + 0.04, -0.18));
      const a1 = ease(ss(0.1, 0.6, u)), a2 = ease(ss(0.55, 1, u));
      const p = exitFrom.pos.clone().lerp(sill, a1).lerp(exitTo.pos, a2);
      p.y += 0.06 * Math.sin(Math.PI * ss(0.45, 1, u));
      root.position.copy(p);
      const seatYaw = new THREE.Euler().setFromQuaternion(exitFrom.quat, 'YXZ').y;
      const yaw = seatYaw + angDiff(seatYaw, exitTo.yaw) * ease(ss(0.12, 0.8, u));
      const upright = Q().setFromAxisAngle(V(0, 1, 0), yaw);
      root.quaternion.copy(exitFrom.quat.clone().slerp(upright, ease(ss(0.1, 0.7, u))));
      sitW = 1 - ss(0.35, 0.95, u);
      wheelW = 1 - ss(0, 0.25, u);
      if (raw >= 1) {
        if (state === 'exiting') {
          state = 'foot';
          heading = exitTo.yaw;
          root.quaternion.setFromAxisAngle(V(0, 1, 0), heading);
        } else {
          state = 'drive';
          ground = null;
          opts.onSeated();
        }
        stateT = 0;
      }
    }
    if (state === 'foot' || state === 'approach') {
      root.rotation.set(0, heading, 0);
      if (ground) {
        // dentro del parche del mapa de alturas
        const dx = root.position.x - ground.center.x, dz = root.position.z - ground.center.y, lim = ground.half - 2;
        root.position.x = ground.center.x + clamp(dx, -lim, lim);
        root.position.z = ground.center.y + clamp(dz, -lim, lim);
        root.position.y = ground.at(root.position.x, root.position.z);
      }
    }
    root.updateMatrixWorld(true);

    // --- mixer (capa base)
    const runK = ss(2.0, 3.9, speed);
    phase = (phase + (dt * speed) / lerp(gait.walk.stride, gait.run.stride, runK)) % 1;
    acts.walk.time = ((phase + gait.walk.offset) % 1) * walkClip.duration;
    acts.run.time = ((phase + gait.run.offset) % 1) * runClip.duration;
    const moving = ss(0.05, 0.8, speed);
    acts.idle.setEffectiveWeight(1 - moving);
    acts.walk.setEffectiveWeight(moving * (1 - runK));
    acts.run.setEffectiveWeight(moving * runK);
    // el mixer solo escribe un hueso si su valor cambia: se deshacen las capas del frame anterior
    for (const [b, v] of layerBase) { b.quaternion.copy(v.q); b.position.copy(v.p); }
    mixer.update(dt);
    for (const b of allBones) {
      let v = layerBase.get(b);
      if (!v) { v = { q: Q(), p: V() }; layerBase.set(b, v); }
      v.q.copy(b.quaternion);
      v.p.copy(b.position);
    }
    model.position.y = 0;
    model.updateMatrixWorld(true);

    lean += (clamp(-yawRate * speed * 0.045, -0.2, 0.2) - lean) * (1 - Math.exp(-dt * 5));
    if (Math.abs(lean) > 1e-4) premultiplyWorld(B.spine!, qE(0, 0, lean));

    // --- cuerpo entero: sentado, rodilla, salto
    kneel.k = clamp(kneel.k + (kneel.target ? 1 : -1) * dt * (kneel.target ? 1 / 1.1 : 1 / 0.9), 0, 1);
    const kH = ease(ss(0.2, 1, kneel.k));
    const hips = V(0, -0.455 * kH, -0.03 * kH);
    let pitch = deg(4) * kH, lift = 0, armW = 0, swingL = 0, swingR = 0;
    if (J.t >= 0) {
      J.t += dt;
      J.el += dt;
      const j = Math.min(J.t, J.T);
      if (j >= JUMP.land && !J.vEndSet) { J.vEnd = J.want; J.vEndSet = true; }
      J.vel = jumpVel(j);
      root.position.x += Math.sin(heading) * J.vel * dt;
      root.position.z += Math.cos(heading) * J.vel * dt;
      if (ground) root.position.y = ground.at(root.position.x, root.position.z);
      root.updateMatrixWorld(true);
      hips.add(jumpHipsOff(j));
      lift = jumpLift(j);
      const ab = jumpAbsorb(j);
      let sOpp = 0, sSame = 0;
      if (j < JUMP.take) { const c = ease(j / JUMP.take); pitch += deg(8) * c; sOpp = sSame = deg(35) * c; }
      else if (j < JUMP.off) {
        const p = ease((j - JUMP.take) / (JUMP.off - JUMP.take));
        pitch += lerp(deg(J.moving ? 6 : 8), deg(3), p);
        const a0 = J.moving ? 0 : deg(35);
        sOpp = lerp(a0, deg(-145), p);
        sSame = lerp(a0, deg(-110), p);
      } else if (j < JUMP.land) {
        const u = ease((j - JUMP.off) / FLIGHT);
        pitch += deg(3);
        sOpp = lerp(deg(-145), deg(-55), u);
        sSame = lerp(deg(-110), deg(-55), u);
      } else {
        const u = ease((j - JUMP.land) / (J.T - JUMP.land));
        pitch += deg(3) + deg(J.moving ? 10 : 17) * ab;
        sOpp = sSame = lerp(deg(-55), 0, u) - deg(12) * ab;
      }
      if (J.lead === 'L') { swingR = sOpp; swingL = sSame; } else { swingL = sOpp; swingR = sSame; }
      armW = ss(0, 0.1, J.el) * (1 - ss(J.T - 0.25, J.T, j));
      if (J.t >= J.T) { J.t = -1; speed = J.vEnd; }
    }
    // sentado: la pelvis baja al banco y bascula hacia atrás contra el respaldo
    hips.y += CAB.hipDrop * sitW;
    pitch += deg(-9) * sitW;
    // en terreno: la pelvis baja lo que haga falta para que el pie del lado más bajo llegue al suelo
    if (state === 'foot' && J.t < 0) {
      const dL = terrainDelta(posC(B.footL!)), dR = terrainDelta(posC(B.footR!));
      terrainDrop += (Math.min(0, dL, dR) - terrainDrop) * (1 - Math.exp(-dt * 10));
    } else terrainDrop *= Math.exp(-dt * 10);
    hips.y += terrainDrop;

    const wantLeg = J.t >= 0 || kneel.k > 0 || sitW > 0 ? 1 : 0;
    legW += (wantLeg - legW) * (1 - Math.exp(-dt * 14));
    if (J.t >= 0) legW = Math.max(legW, ss(0, 0.06, J.el) * (1 - (J.moving && J.vEnd > 0.05 ? ss(J.T - 0.15, J.T, J.t) : 0)));
    if (kneel.k > 0) legW = Math.max(legW, ss(0, 0.05, kneel.k));
    if (sitW > 0) legW = Math.max(legW, sitW);

    B.spine!.position.add(hips);
    model.position.y = lift;
    model.updateMatrixWorld(true);
    if (Math.abs(pitch) > 1e-4) premultiplyWorld(B.spine!, qE(pitch, 0, 0));
    premultiplyWorld(B.spine002!, qE(-pitch * 0.45, 0, 0));

    if (armW > 0.001 && !armed && waveT < 0) {
      for (const s of ['L', 'R'] as const) {
        const sw = s === 'L' ? swingL : swingR;
        const b = B[`upper_arm${s}`]!, f = B[`forearm${s}`]!;
        b.quaternion.slerp(restLocal(b, qE(sw, 0, 0).multiply(HANG[`upper_arm${s}`]!)), armW);
        f.quaternion.slerp(restLocal(f, qE(0, (s === 'L' ? -1 : 1) * deg(30) * ss(0.3, 1.5, -sw), 0).multiply(HANG[`forearm${s}`]!)), armW);
      }
      model.updateMatrixWorld(true);
    }

    // saludo (sobrescribe el brazo derecho)
    if (waveT >= 0 && !armed && foot) {
      waveT += dt;
      const D = 2.8, env = ss(0, 0.45, waveT) * (1 - ss(D - 0.55, D, waveT));
      const osc = Math.sin((waveT - 0.45) * 2 * Math.PI * 1.7) * ss(0.35, 0.7, waveT);
      const W: Record<string, THREE.Quaternion> = {
        shoulderR: HANG.shoulderR!.clone().slerp(qE(0, 0, deg(-10)), env),
        upper_armR: qE(deg(-85), deg(14), deg(-8), 'YZX'),
        forearmR: qE(0, deg(80) - deg(18) * osc, 0).multiply(STRAIGHT.foreR!),
        handR: qE(deg(-8), 0, deg(4) * osc).multiply(STRAIGHT.handR!),
      };
      const elbow = ss(0, 0.3, waveT) * (1 - ss(D - 0.35, D, waveT));
      for (const name in W) B[name]!.quaternion.slerp(restLocal(B[name]!, W[name]!), name === 'forearmR' || name === 'handR' ? elbow : env);
      if (waveT >= D) waveT = -1;
      model.updateMatrixWorld(true);
    } else if (armed || !foot) waveT = -1;

    // --- IK de piernas: pedales (sentado), rodilla/salto, o desnivel del terreno (de pie)
    for (const [s] of SIDES) {
      const L = LEG[s];
      const saved = snap(L);
      let ank: THREE.Vector3, pole: THREE.Vector3, fdir: THREE.Vector3, tdir: THREE.Vector3;
      if (sitW > 0) {
        const ped = root.worldToLocal(vehToWorld(CAB.pedals[s]));
        const stand = RP[`ankle${s}`]!.clone();
        if (state !== 'drive') stand.y += terrainDelta(stand);
        ank = stand.lerp(ped, sitW);
        pole = V(0, 0.6, 1).normalize();
        fdir = RP[`footDir${s}`]!.clone().lerp(V(0, -0.35, 0.94).normalize(), sitW).normalize();
        tdir = RP[`toeDir${s}`]!.clone();
      } else if (J.t >= 0 || kneel.k > 0) {
        ({ ank, pole, fdir, tdir } = legTargets(s));
        ank.y += terrainDelta(ank);
      } else if (state === 'foot' || state === 'approach') {
        // pose del mixer, corregida en altura por el desnivel bajo cada pie
        ank = posC(L[2]!);
        const dz = terrainDelta(ank) - terrainDrop;
        if (Math.abs(dz) < 0.004) continue;
        ank.y += dz;
        pole = posC(L[1]!).sub(posC(L[0]!)).normalize().add(V(0, 0, 0.3));
        fdir = posC(L[3]!).sub(posC(L[2]!)).normalize();
        tdir = posC(TOE_END[s]).sub(posC(L[3]!)).normalize();
        ik2(L[0]!, L[1]!, L[2]!, ank, pole);
        aimBone(L[2]!, L[3]!, fdir);
        aimBone(L[3]!, TOE_END[s], tdir);
        continue;
      } else continue;
      ik2(L[0]!, L[1]!, L[2]!, ank, pole);
      aimBone(L[2]!, L[3]!, fdir);
      aimBone(L[3]!, TOE_END[s], tdir);
      blendBack(L, saved, legW);
    }

    // --- de rodillas: el antebrazo izquierdo descansa sobre la rodilla
    if (kneel.k > 0 && !armed && waveT < 0) {
      const w = ease(ss(0.45, 1, kneel.k));
      if (w > 0.001) {
        const saved = snap(ARM_L);
        ik2(B.upper_armL!, B.forearmL!, B.handL!, posC(B.shinL!).add(V(-0.04, 0.07, 0.07)), V(0.6, -0.2, -0.6).normalize());
        blendBack(ARM_L, saved, w);
      }
    }

    // --- manos al volante
    if (wheelW > 0.001) {
      for (const [s, sg] of SIDES) {
        const arm = s === 'L' ? ARM_L : ARM_R;
        const saved = snap(arm);
        const g = wheelGrip(s);
        ik2(B[`upper_arm${s}`]!, B[`forearm${s}`]!, B[`hand${s}`]!, g.wrist, V(sg * 0.8, -0.6, -0.2).normalize());
        const f0 = V(sg, 0, 0), n0 = V(0, -1, 0);
        setWorldRot(B[`hand${s}`]!, basisRot(f0, n0, g.fingers, g.palm).multiply(rest(B[`hand${s}`]!).W));
        blendBack(arm, saved, wheelW);
      }
    }

    // --- pistola
    let rW = 0, lW = 0;
    let pd: THREE.Matrix4 | null = null;
    const holsterM = () => { holster.updateMatrixWorld(true); return root.matrixWorld.clone().invert().multiply(holster.matrixWorld); };
    const aimM = () => {
      const m = new THREE.Matrix4().makeRotationX(-deg(12) * gun.recoil);
      m.setPosition(posC(B.spine003!).add(V(-0.03, 0.115 + 0.03 * gun.recoil, 0.5 - 0.05 * gun.recoil)));
      return m;
    };
    const mix = (m1: THREE.Matrix4, m2: THREE.Matrix4, u: number, arc: number) => {
      const p1 = V(), q1 = Q(), p2 = V(), q2 = Q(), s1 = V();
      m1.decompose(p1, q1, s1);
      m2.decompose(p2, q2, s1);
      const p = p1.lerp(p2, u);
      p.y += arc * Math.sin(Math.PI * u);
      p.z += arc * 0.5 * Math.sin(Math.PI * u);
      return new THREE.Matrix4().compose(p, q1.slerp(q2, u), V(1, 1, 1));
    };
    if (gun.state !== 'holstered') {
      gun.t += dt;
      if (gun.state === 'reach') {
        rW = ease(gun.t / 0.4);
        pd = holsterM();
        if (gun.t >= 0.4) { pistolToHand(); gun.from = pd.clone(); gun.state = 'raise'; gun.t = 0; }
      } else if (gun.state === 'raise') {
        rW = 1;
        pd = mix(gun.from!, aimM(), ease(gun.t / 0.5), 0.06);
        lW = ease((gun.t - 0.18) / 0.32);
        if (gun.t >= 0.5) { gun.state = 'aim'; gun.t = 0; }
      } else if (gun.state === 'aim') {
        rW = 1; lW = 1; pd = aimM();
        if (gun.queued && gun.recoil < 0.3) { gun.queued = false; shoot(); }
      } else if (gun.state === 'lower') {
        gun.from ??= aimM();
        rW = 1;
        pd = mix(gun.from, holsterM(), ease(gun.t / 0.5), 0.05);
        lW = 1 - ease(gun.t / 0.25);
        if (gun.t >= 0.5) { holsterPistol(); gun.state = 'stow'; gun.t = 0; }
      } else {
        rW = 1 - ease(gun.t / 0.4);
        pd = holsterM();
        if (gun.t >= 0.4) gun.state = 'holstered';
      }
      gun.recoil = Math.max(0, gun.recoil - dt * 7);
      slide.position.z = 0.05 - 0.022 * Math.min(1, gun.recoil * 2.5);
    }
    if (pd && rW > 0.001) {
      const wrist = V(), hq = Q(), sc = V();
      pd.clone().multiply(PLOC_INV).decompose(wrist, hq, sc);
      const savedR = snap(ARM_R);
      premultiplyWorld(B.shoulderR!, qE(0, 0, deg(-6) * ss(0.4, 1, wrist.y - posC(B.spine003!).y + 0.6)));
      ik2(B.upper_armR!, B.forearmR!, B.handR!, wrist, V(-0.7, -0.6, -0.4).normalize());
      setWorldRot(B.handR!, hq);
      blendBack(ARM_R, savedR, rW);
      if (lW > 0.001) {
        const pq = V(), pqq = Q();
        pd.decompose(pq, pqq, sc);
        const savedL = snap(ARM_L);
        ik2(B.upper_armL!, B.forearmL!, B.handL!, V(0.05, -0.075, -0.03).applyQuaternion(pqq).add(pq), V(0.7, -0.7, -0.2).normalize());
        setWorldRot(B.handL!, pqq.clone().multiply(LHAND_R).multiply(rest(B.handL!).W));
        blendBack(ARM_L, savedL, lW);
      }
    }
    model.updateMatrixWorld(true);

    // --- dedos
    {
      const holding = gun.state === 'raise' || gun.state === 'aim' || gun.state === 'lower' || (gun.state === 'reach' && gun.t > 0.3) || (gun.state === 'stow' && gun.t < 0.1);
      const relaxed = 0.2 + 0.25 * ss(2, 4, speed) + (J.t >= 0 ? 0.1 : 0);
      const k = 1 - Math.exp(-dt * 16);
      hands.R.c += ((holding ? 1 : lerp(relaxed, 0.85, wheelW)) - hands.R.c) * k;
      hands.R.g += ((holding ? 1 : 0) - hands.R.g) * k;
      hands.L.c += (lerp(lerp(relaxed, 0.85, wheelW), 1.0, lW) - hands.L.c) * k;
      hands.L.g += (lW * 0.6 - hands.L.g) * k;
      poseFingers('L', hands.L.c, hands.L.g);
      poseFingers('R', hands.R.c, hands.R.g);
      model.updateMatrixWorld(true);
    }

    // --- mirada: conduciendo mira la carretera; a pie, al cursor o a la cámara
    let ty = 0, tp = 0;
    B.spine005!.getWorldPosition(headW);
    headW.y += 0.08;
    const target = seated && state === 'drive' ? root.localToWorld(V(0, 1.5, 25)) : input.lookAt;
    if (target) {
      tmp.copy(target).sub(headW).applyQuaternion(root.getWorldQuaternion(Q()).invert());
      const yawRaw = Math.atan2(tmp.x, tmp.z), pitchRaw = Math.atan2(-tmp.y, Math.hypot(tmp.x, tmp.z));
      const k = (1 - ss(deg(95), deg(115), Math.abs(yawRaw))) * (1 - moving * 0.55) * (state === 'exiting' || state === 'entering' ? 0.3 : 1);
      ty = clamp(yawRaw, -deg(armed ? 60 : 75), deg(armed ? 60 : 75)) * k;
      tp = clamp(pitchRaw, -deg(30), deg(35)) * k * (armed ? 0.6 : 1);
    }
    const spring = (x: number, v: number, tg: number): [number, number] => {
      const a = 49 * (tg - x) - 14 * v;
      const nv = clamp(v + a * dt, -deg(300), deg(300));
      return [x + nv * dt, nv];
    };
    [look.yaw, look.vy] = spring(look.yaw, look.vy, ty);
    [look.pitch, look.vp] = spring(look.pitch, look.vp, tp);
    const aimK = gun.state === 'aim' ? 1 : gun.state === 'raise' ? ease(gun.t / 0.5) : gun.state === 'lower' ? 1 - ease(gun.t / 0.5) : 0;
    const chain: [string, number][] = [['spine002', lerp(0.1, 0.4, aimK)], ['spine003', lerp(0.15, 0.5, aimK)], ['spine004', lerp(0.3, 0.05, aimK)], ['spine005', lerp(0.45, 0.05, aimK)]];
    if (Math.abs(look.yaw) + Math.abs(look.pitch) > 1e-4) {
      for (const [name, f] of chain) premultiplyWorld(B[name]!, qE(look.pitch * f, look.yaw * f, 0, 'YXZ'));
    }

    talkUpdate(dt);
    if (Math.abs(talk.nod) > 1e-4) premultiplyWorld(B.spine005!, qE(talk.nod * 0.5, talk.nod * 0.15, 0));

    // --- fogonazo y casquillos
    flashT -= dt;
    flash.visible = flashT > 0;
    if (flash.visible) {
      const s = 0.09 + Math.random() * 0.06;
      flash.scale.set(s, s, s);
      flash.material.rotation = Math.random() * 6.28;
    }
    flashLight.intensity = flashT > 0 ? 6 : 0;
    for (let i = shells.length - 1; i >= 0; i--) {
      const sh = shells[i]!;
      sh.life -= dt;
      if (sh.life <= 0) { scene.remove(sh.mesh); shells.splice(i, 1); continue; }
      const floorY = groundY(sh.mesh.position.x, sh.mesh.position.z) + 0.0045;
      if (sh.v.lengthSq() > 1e-4 || sh.mesh.position.y > floorY + 0.002) {
        sh.v.y -= 9.81 * dt;
        sh.mesh.position.addScaledVector(sh.v, dt);
        sh.mesh.rotation.x += sh.w.x * dt;
        sh.mesh.rotation.y += sh.w.y * dt;
        if (sh.mesh.position.y < floorY) {
          sh.mesh.position.y = floorY;
          sh.v.y = -sh.v.y * 0.35;
          sh.v.x *= 0.6;
          sh.v.z *= 0.6;
          sh.w.multiplyScalar(0.5);
          if (sh.bounces++ < 2) clinkSound(1 / sh.bounces);
          if (Math.abs(sh.v.y) < 0.2) { sh.v.set(0, 0, 0); sh.mesh.rotation.x = Math.PI / 2; }
        }
      }
    }
    shake = Math.max(0, shake - dt * 9);
  }

  /** Prueba de clic sobre el personaje: cilindro de cuerpo alrededor de la raíz. */
  function hitTest(ray: THREE.Ray) {
    const c = root.position;
    for (let s = 0; s < 40; s += 0.05) {
      const p = ray.at(s, tmp);
      if (p.y > c.y && p.y < c.y + 1.85 && Math.hypot(p.x - c.x, p.z - c.z) < 0.28) return true;
    }
    return false;
  }

  return {
    root,
    get state() { return state; },
    /** True si en `approach` va hacia la puerta (y no a otro punto). */
    get boarding() { return state === 'approach' && !!goal?.enter; },
    /** Rumbo actual del personaje en el plano (rad). */
    get heading() { return heading; },
    get armed() { return gun.state !== 'holstered'; },
    get aiming() { return gun.state === 'aim'; },
    get kneeling() { return kneel.target === 1; },
    get shake() { return shake; },
    /** Punto de la cabeza en mundo (bocadillo, cámara). */
    head(out = V()) { return B.spine005!.getWorldPosition(out); },
    /** Pecho, para orientar la cámara de seguimiento. */
    chest(out = V()) { return B.spine003!.getWorldPosition(out); },
    setVoice(shape: () => [number, number, number] | null, onset: () => boolean) { voiceShape = shape; voiceOnset = onset; },
    exitVehicle,
    enterVehicle,
    walkTo,
    /** Altura del suelo del parche de terreno (tras bajarse). */
    groundAt: (x: number, z: number) => groundY(x, z),
    startJump,
    toggleKneel,
    toggleGun,
    fire,
    wave,
    speak,
    stopSpeech,
    hitTest,
    update,
    dispose() {
      stopSpeech();
      if (hasSpeech) speechSynthesis.removeEventListener('voiceschanged', pickVoice);
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      for (const sh of shells) scene.remove(sh.mesh);
      scene.remove(root);
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        const isSprite = (o as THREE.Sprite).isSprite === true;
        if (m.isMesh || isSprite) {
          if (!isSprite) m.geometry?.dispose(); // la geometría de los sprites es compartida por three.js
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mt of mats) {
            for (const v of Object.values(mt)) if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
            mt.dispose();
          }
        }
      });
      shellGeo.dispose();
      shellMat.dispose();
      flashTex.dispose();
    },
  };
}

export type Character = ReturnType<typeof createCharacter>;
