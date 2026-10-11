/**
 * Afina las proporciones del conductor reescribiendo su .glb.
 *
 * QUÉ HACE: acerca los vértices al eje de su hueso dominante — cabeza y cuello
 * un 10%, brazos un 14%, hombros un 7%. Es el volumen de carne lo que cambia.
 *
 * POR QUÉ ASÍ Y NO ESCALANDO HUESOS: el esqueleto no se toca, así que ninguna
 * longitud ósea varía y la biomecánica queda intacta — el IK de manos y pies,
 * las poses procedurales, la marcha, el salto y las animaciones siguen dando
 * exactamente el mismo resultado. Escalar huesos sí rompería todo eso.
 *
 * POR QUÉ EN EL .GLB Y NO EN RUNTIME: hacerlo al cargar costaría recorrer 92k
 * vértices en cada arranque y recalcular normales, y además dejaría el código
 * del visor lleno de cirugía de malla. Aquí se hace una vez y el visor no se
 * entera.
 *
 * SEGURIDAD: no sobreescribe nada sin pedirlo (`--write`). El original está en
 * ~/hermes-workspace/scratchpad/f100-backup/personaje.ORIGINAL.glb
 *
 * Uso:
 *   node scripts/afinar-personaje.mjs                 # escribe un -afinado.glb aparte
 *   node scripts/afinar-personaje.mjs --write         # reemplaza public/models/personaje.glb
 */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { Matrix4, Vector3, Quaternion } from 'three';

const SRC = 'public/models/personaje.glb';
const WRITE = process.argv.includes('--write');
const DST = WRITE ? SRC : 'public/models/personaje-afinado.glb';

/**
 * Cuánto se acerca cada grupo a su eje (1 = sin cambio).
 *
 * Los nombres se comparan saneados: en el glb los huesos se llaman
 * `spine.005` / `upper_arm.L`, pero three.js convierte los puntos en nada
 * (`spine005`, `upper_armL`). Se normaliza para que la misma lista valga en los
 * dos lados y no haya que mantener dos juegos de nombres.
 */
const limpia = (s) => s.replace(/[.\s]/g, '');
const FACTORES = [
  { k: 0.9, huesos: ['spine004', 'spine005', 'neck', 'head', 'headfront', 'head_end'], que: 'cabeza y cuello' },
  { k: 0.86, huesos: ['upper_armL', 'upper_armR', 'forearmL', 'forearmR'], que: 'brazos' },
  { k: 0.93, huesos: ['shoulderL', 'shoulderR'], que: 'hombros' },
];

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

const doc = await io.read(SRC);
const root = doc.getRoot();

// ── malla con piel y su esqueleto
let skinNode = null;
for (const n of root.listNodes()) if (n.getSkin() && n.getMesh()) skinNode = n;
if (!skinNode) throw new Error('no se encontro el nodo con skin');
const skin = skinNode.getSkin();
const joints = skin.listJoints();
const nombres = joints.map((j) => limpia(j.getName()));

/**
 * Matriz de mundo de un nodo, subiendo por los padres.
 *
 * Hace falta la pose de BIND: la posición de cada hueso en el estado en que se
 * pintaron los pesos, que es el marco en el que viven las posiciones de los
 * vértices del glb.
 */
const padres = new Map();
for (const n of root.listNodes()) for (const c of n.listChildren()) padres.set(c, n);
const mundo = (node) => {
  const m = new Matrix4();
  let cur = node;
  const cadena = [];
  while (cur) { cadena.unshift(cur); cur = padres.get(cur); }
  for (const n of cadena) {
    const t = n.getTranslation(), r = n.getRotation(), s = n.getScale();
    m.multiply(new Matrix4().compose(
      new Vector3(t[0], t[1], t[2]),
      new Quaternion(r[0], r[1], r[2], r[3]),
      new Vector3(s[0], s[1], s[2]),
    ));
  }
  return m;
};

// eje de cada hueso: de su origen al de su primer hijo que también sea hueso
const setJoints = new Set(joints);
const ejes = new Map();
for (const j of joints) {
  const a = new Vector3().setFromMatrixPosition(mundo(j));
  const hijo = j.listChildren().find((c) => setJoints.has(c));
  const b = hijo
    ? new Vector3().setFromMatrixPosition(mundo(hijo))
    : a.clone().add(new Vector3(0, 0.1, 0));
  ejes.set(limpia(j.getName()), { a, d: b.clone().sub(a) });
}

const resumen = [];
for (const prim of skinNode.getMesh().listPrimitives()) {
  const POS = prim.getAttribute('POSITION');
  const JOI = prim.getAttribute('JOINTS_0');
  const WEI = prim.getAttribute('WEIGHTS_0');
  if (!POS || !JOI || !WEI) continue;

  const n = POS.getCount();
  // hueso dominante de cada vértice
  const dom = new Uint16Array(n);
  const ji = [0, 0, 0, 0], wi = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    JOI.getElement(i, ji);
    WEI.getElement(i, wi);
    let best = 0, bw = -1;
    for (let k = 0; k < 4; k++) if (wi[k] > bw) { bw = wi[k]; best = ji[k]; }
    dom[i] = best;
  }

  const v = new Vector3(), p = new Vector3();
  const el = [0, 0, 0];
  for (const { k, huesos, que } of FACTORES) {
    const set = new Set(huesos.map(limpia));
    let tocados = 0;
    for (let i = 0; i < n; i++) {
      const nb = nombres[dom[i]];
      if (!set.has(nb)) continue;
      const e = ejes.get(nb);
      if (!e) continue;
      POS.getElement(i, el);
      v.set(el[0], el[1], el[2]);
      // punto del eje más cercano al vértice (proyección acotada al segmento)
      const t = Math.max(0, Math.min(1, v.clone().sub(e.a).dot(e.d) / (e.d.lengthSq() || 1e-9)));
      p.copy(e.a).addScaledVector(e.d, t);
      v.sub(p).multiplyScalar(k).add(p);
      POS.setElement(i, [v.x, v.y, v.z]);
      tocados++;
    }
    resumen.push({ que, k, tocados });
  }

  // ── normales: tras mover vértices hay que recalcularlas o la luz se ve mal
  const NOR = prim.getAttribute('NORMAL');
  const IDX = prim.getIndices();
  if (NOR && IDX) {
    const acc = new Float32Array(n * 3);
    const a = new Vector3(), b = new Vector3(), c = new Vector3();
    const ab = new Vector3(), ac = new Vector3(), cross = new Vector3();
    const t0 = [0, 0, 0], t1 = [0, 0, 0], t2 = [0, 0, 0];
    const ic = IDX.getCount();
    for (let k = 0; k < ic; k += 3) {
      const i0 = IDX.getScalar(k), i1 = IDX.getScalar(k + 1), i2 = IDX.getScalar(k + 2);
      POS.getElement(i0, t0); POS.getElement(i1, t1); POS.getElement(i2, t2);
      a.set(t0[0], t0[1], t0[2]); b.set(t1[0], t1[1], t1[2]); c.set(t2[0], t2[1], t2[2]);
      ab.subVectors(b, a); ac.subVectors(c, a);
      cross.crossVectors(ab, ac); // sin normalizar: pondera por area del triangulo
      for (const i of [i0, i1, i2]) {
        acc[i * 3] += cross.x; acc[i * 3 + 1] += cross.y; acc[i * 3 + 2] += cross.z;
      }
    }
    for (let i = 0; i < n; i++) {
      const x = acc[i * 3], y = acc[i * 3 + 1], z = acc[i * 3 + 2];
      const l = Math.hypot(x, y, z) || 1;
      NOR.setElement(i, [x / l, y / l, z / l]);
    }
    console.log('normales recalculadas');
  }
}

for (const r of resumen) {
  console.log(`${r.que.padEnd(16)} x${r.k}  ${r.tocados} vertices`);
}

// medidas de control
const prim = skinNode.getMesh().listPrimitives()[0];
const POS = prim.getAttribute('POSITION');
const franja = (y0, y1, maxZ) => {
  let lo = Infinity, hi = -Infinity;
  const el = [0, 0, 0];
  for (let i = 0; i < POS.getCount(); i++) {
    POS.getElement(i, el);
    if (el[1] < y0 || el[1] > y1) continue;
    if (maxZ !== undefined && Math.abs(el[2]) > maxZ) continue;
    lo = Math.min(lo, el[0]);
    hi = Math.max(hi, el[0]);
  }
  return +(hi - lo).toFixed(3);
};
let alto = -Infinity;
const el2 = [0, 0, 0];
for (let i = 0; i < POS.getCount(); i++) { POS.getElement(i, el2); alto = Math.max(alto, el2[1]); }
console.log(`\nancho de cabeza: ${franja(1.6, 1.75, 0.2)} m · altura total: ${alto.toFixed(3)} m`);

await doc.transform(draco());
await io.write(DST, doc);
console.log(`\n-> ${DST}${WRITE ? '  (reemplazado)' : '  (copia aparte, usa --write para reemplazar)'}`);
