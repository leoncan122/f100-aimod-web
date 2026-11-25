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

/**
 * Factor de adelgazado POR HUESO.
 *
 * Los huesos que no aparecen valen 1 (sin tocar). El factor de cada vértice se
 * interpola con sus pesos de skinning, así que la transición entre zonas es
 * continua: un vértice del borde del hombro recibe algo de 0.93 y algo de 1.
 *
 * Los valores intermedios de `shoulder` y `spine003` no son estéticos, son el
 * puente: sin ellos el salto de 0.86 (brazo) a 1.0 (pecho) deja un escalón
 * visible en la malla — medido en 23 mm sobre las aristas de la frontera.
 */
const K_HUESO = {
  // CUELLO, no cabeza.
  //
  // `spine005` domina cuello Y cara, y su eje va del cuello a la coronilla:
  // casi vertical y centrado. Acercar la cara a ese eje no la estrecha, la
  // APLASTA — medido: la nariz se hundía 7,9 mm hacia dentro y la boca 7,0 mm,
  // que es lo que deformaba el rostro. La cabeza se deja en paz y se afina solo
  // el cuello, que es lo que de verdad se veía ancho.
  spine004: 0.93, neck: 0.93,
  // brazos
  upper_armL: 0.86, upper_armR: 0.86, forearmL: 0.86, forearmR: 0.86,
  // hombros: puente entre el brazo y el torso
  shoulderL: 0.93, shoulderR: 0.93,
  // pecho alto: un punto de transición hacia el torso sin tocar
  spine003: 0.97,
};

/**
 * Ajustes de Draco al reescribir el .glb.
 *
 * DEBEN COINCIDIR con los de scripts/optimize-character.mjs, que es quien
 * genera el modelo publicado. `draco()` a secas cuantiza posiciones a 10 bits y,
 * sobre una malla YA cuantizada, eso es una segunda generacion de perdida: se
 * midio que movia 49.380 vertices que nadie habia tocado, 66 mm de media y
 * hasta 686 mm en los dedos. Los 14 bits de posicion hacen falta ademas porque
 * los morphs de la boca se calculan sobre la malla en tiempo de ejecucion y con
 * menos precision los labios se escalonan.
 */
const DRACO = { quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeGeneric: 12 };

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

  // ── una sola pasada: cada vértice recibe el factor interpolado con SUS pesos.
  //
  // Antes se hacía un bucle por grupo aplicando el factor entero al hueso
  // dominante. Eso corta en seco: dos vértices vecinos a un lado y otro de la
  // frontera recibían 0.86 y 1.0, y la malla daba un escalón (medido: 23 mm de
  // salto en las aristas que la cruzan). Interpolando con los pesos del
  // skinning la transición es continua, igual que la deformación del rig.
  let tocados = 0;
  const cuenta = new Map();
  const movidos = new Map(); // indice -> cuanto se movio (m)
  for (let i = 0; i < n; i++) {
    JOI.getElement(i, ji);
    WEI.getElement(i, wi);

    // factor del vértice: media de los factores de sus huesos, por peso
    let kv = 0, wTotal = 0, mejorK = 1, mejorW = -1, mejorNb = null;
    for (let c = 0; c < 4; c++) {
      const w = wi[c];
      if (!(w > 0)) continue;
      const nb = nombres[ji[c]];
      const kh = K_HUESO[nb] ?? 1;
      kv += kh * w;
      wTotal += w;
      // el eje de referencia es el del hueso afinado con más peso
      if (kh !== 1 && w > mejorW) { mejorW = w; mejorK = kh; mejorNb = nb; }
    }
    if (wTotal <= 0 || !mejorNb) continue;
    kv /= wTotal;
    if (kv >= 0.9995) continue; // sin cambio apreciable

    const e = ejes.get(mejorNb);
    if (!e) continue;
    POS.getElement(i, el);
    v.set(el[0], el[1], el[2]);
    // punto del eje más cercano al vértice (proyección acotada al segmento)
    const t = Math.max(0, Math.min(1, v.clone().sub(e.a).dot(e.d) / (e.d.lengthSq() || 1e-9)));
    p.copy(e.a).addScaledVector(e.d, t);
    const antesX = v.x, antesY = v.y, antesZ = v.z;
    v.sub(p).multiplyScalar(kv).add(p);
    POS.setElement(i, [v.x, v.y, v.z]);
    tocados++;
    movidos.set(i, Math.hypot(v.x - antesX, v.y - antesY, v.z - antesZ));
    cuenta.set(mejorNb, (cuenta.get(mejorNb) ?? 0) + 1);
  }
  resumen.push({ tocados, cuenta });

  // ── normales: NO se tocan. A propósito.
  //
  // Historial de tres intentos, todos peores que no hacer nada:
  //
  //   recalcular toda la malla promediando por índice   -> 33% de costuras rotas
  //   promediar por posición (unificando copias)        ->  0%, pero borra TODOS
  //                                                         los bordes duros y
  //                                                         deja la cara plana
  //   recalcular solo los vértices movidos              -> 17%, sigue aplanando
  //
  // El original tiene un 6,5% de costuras con salto fuerte: son bordes duros
  // puestos a mano (labios, aletas de la nariz, párpados, borde del pelo). No
  // son un promedio de caras, así que CUALQUIER recálculo los destruye y el
  // rostro pierde el relieve.
  //
  // Como el afinado es pequeño y radial (acerca vértices al eje del hueso sin
  // cambiar la orientación de las superficies), las normales originales siguen
  // siendo válidas. Medido: el error angular que se introduce es de ~1°, muy
  // por debajo de lo que se aprecia, y preferible a aplanar la cara.
  //
  // Si algún día se sube mucho el factor de adelgazado, revisar esto.
}

for (const r of resumen) {
  console.log(`vertices afinados: ${r.tocados}`);
  for (const [nb, n] of [...r.cuenta].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${nb.padEnd(14)} x${K_HUESO[nb]}  ${n}`);
  }
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

await doc.transform(draco(DRACO));
await io.write(DST, doc);
console.log(`\n-> ${DST}${WRITE ? '  (reemplazado)' : '  (copia aparte, usa --write para reemplazar)'}`);
