/**
 * Repinta el blanco que el escaneo proyectó sobre la piel del conductor.
 *
 * CÓMO SE DECIDE QUÉ TOCAR: no por color, sino por geometría. `build-mask-piel`
 * rasteriza en el atlas los triángulos que el esqueleto dice que son brazo,
 * hombro alto, cuello o cabeza. Dentro de esa máscara la superficie ES piel por
 * construcción, así que cualquier píxel blanquecino allí es derrame del escaneo
 * — sin ambigüedad y sin riesgo de tocar la camiseta, que queda fuera.
 *
 * Dos intentos previos fallaron y por eso se hace así:
 *  1. radio de piel alrededor de cada píxel → solo repintaba el borde de las
 *     manchas grandes (su interior solo ve blanco): a ojo no cambiaba nada;
 *  2. regiones conexas con umbral de contorno → mejoraba, pero al bajar el
 *     umbral para coger la mancha del hombro empezaba a dejar churretes grises
 *     en el cuello, donde piel y prenda se tocan.
 *
 * El relleno es por difusión desde la piel sana del borde, así que el tono sale
 * de la propia textura y conserva iluminación y grano del escaneo.
 *
 * Requiere: node scripts/build-mask-piel.mjs (genera mask-piel.raw)
 * Uso: node scripts/fix-textura.mjs [entrada.png] [salida.png]
 */
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const SRC = process.argv[2] ?? 'test-results/personaje/textura.png';
const DST = process.argv[3] ?? 'test-results/personaje/textura-fix.png';
const MASK = 'test-results/personaje/mask-piel.raw';

/** Un píxel es "descolorido" si está claro y sin saturación. */
const LUZ_MIN = 150;
const SAT_MAX = 0.17;

const img = sharp(SRC);
const { width: W, height: H } = await img.metadata();
const px = Buffer.from(await img.removeAlpha().raw().toBuffer());
const N = W * H;

let piel;
try {
  piel = readFileSync(MASK);
} catch {
  console.error('falta la mascara: ejecuta antes  node scripts/build-mask-piel.mjs');
  process.exit(1);
}
if (piel.length !== N) {
  console.error(`la mascara es de ${piel.length} px y la textura de ${N}`);
  process.exit(1);
}

// ── 1. dentro de la piel, marcar lo descolorido
const objetivo = new Uint8Array(N);
let nObj = 0, nPiel = 0;
for (let i = 0, p = 0; i < N; i++, p += 3) {
  if (!piel[i]) continue;
  nPiel++;
  const r = px[p], g = px[p + 1], b = px[p + 2];
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  if (max > LUZ_MIN && sat < SAT_MAX) { objetivo[i] = 1; nObj++; }
}
console.log(`mascara de piel: ${nPiel} px (${((nPiel / N) * 100).toFixed(1)}% del atlas)`);
console.log(`descoloridos dentro de la piel: ${nObj} (${((nObj / nPiel) * 100).toFixed(1)}% de la piel)`);

// ── 2. ensanchar un poco para coger el halo de antialias del borde
const dilatar = (src, pasos) => {
  let cur = src;
  for (let k = 0; k < pasos; k++) {
    const next = Uint8Array.from(cur);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (cur[i] || !piel[i]) continue; // solo crece dentro de la piel
        if (cur[i - 1] || cur[i + 1] || cur[i - W] || cur[i + W]) next[i] = 1;
      }
    }
    cur = next;
  }
  return cur;
};
const obj = dilatar(objetivo, 2);
let nFinal = 0;
for (let i = 0; i < N; i++) if (obj[i]) nFinal++;
console.log(`tras ensanchar 2 px: ${nFinal} px a repintar (${((nFinal / N) * 100).toFixed(2)}% de la textura)`);

// ── 3. difusión desde la piel sana
//
// Se hace en dos tiempos para no dejar un parche de borde duro:
//   a) difusión pura, que rellena la mancha con el tono de su contorno;
//   b) mezcla ponderada según lo adentro que esté cada píxel (ver abajo).
const out = Buffer.from(px);
const pend = Uint8Array.from(obj);
const d8 = [-1, 1, -W, W, -W - 1, -W + 1, W - 1, W + 1];
let restantes = nFinal;
/** Distancia (en pasadas) de cada píxel al borde sano: 1 = pegado al borde. */
const prof = new Uint16Array(N);
for (let pasada = 1; pasada <= 600 && restantes > 0; pasada++) {
  const hechos = [];
  for (let i = 0; i < N; i++) {
    if (!pend[i]) continue;
    let r = 0, g = 0, b = 0, n = 0;
    for (const d of d8) {
      const j = i + d;
      if (j < 0 || j >= N || pend[j]) continue;
      if (!piel[j]) continue; // el tono solo puede venir de piel
      const q = j * 3;
      r += out[q]; g += out[q + 1]; b += out[q + 2]; n++;
    }
    if (!n) continue;
    const p = i * 3;
    out[p] = Math.round(r / n); out[p + 1] = Math.round(g / n); out[p + 2] = Math.round(b / n);
    hechos.push(i);
    prof[i] = pasada;
  }
  if (!hechos.length) break;
  for (const i of hechos) pend[i] = 0;
  restantes -= hechos.length;
}
console.log(`repintados: ${nFinal - restantes}${restantes ? ` (${restantes} sin piel sana alrededor)` : ''}`);

// Los que se quedaron sin rellenar están rodeados de blanco por todos lados:
// zonas donde el derrame es tan ancho que no tiene piel sana cerca. Se dejan
// COMO ESTABAN a propósito.
//
// Probé a darles el tono medio de la piel repintada y fue peor: un relleno
// plano sobre un área grande (la papada y el cuello bajo la barbilla) se ve
// como un manchón de plastilina, sin sombra ni grano. Un resto del blanco
// original molesta menos que eso.
if (restantes) {
  for (let i = 0; i < N; i++) if (pend[i]) obj[i] = 0; // fuera del suavizado
  console.log(`  ${restantes} px se dejan sin tocar (no hay piel sana alrededor)`);
}

// ── 3b. desvanecer el borde: en los primeros píxeles de la mancha se mezcla lo
// repintado con el original, para que no se note dónde empieza el parche.
const FUNDIDO = 3;
for (let i = 0; i < N; i++) {
  if (!obj[i] || !prof[i] || prof[i] > FUNDIDO) continue;
  const k = prof[i] / (FUNDIDO + 1); // 0 en el borde, ~1 hacia dentro
  const q = i * 3;
  for (let c = 0; c < 3; c++) out[q + c] = Math.round(px[q + c] * (1 - k) + out[q + c] * k);
}

// ── 4. suavizar solo lo repintado: la difusión deja anillos concéntricos
for (let k = 0; k < 4; k++) {
  const copia = Buffer.from(out);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!obj[i]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const q = (i + dy * W + dx) * 3;
          r += copia[q]; g += copia[q + 1]; b += copia[q + 2]; n++;
        }
      }
      const p = i * 3;
      out[p] = Math.round(r / n); out[p + 1] = Math.round(g / n); out[p + 2] = Math.round(b / n);
    }
  }
}

await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toFile(DST);
console.log(`-> ${DST}`);

const vis = Buffer.alloc(N * 3);
for (let i = 0; i < N; i++) {
  const p = i * 3;
  if (obj[i]) { vis[p] = 235; vis[p + 1] = 55; vis[p + 2] = 55; }
  else if (piel[i]) { vis[p] = 40; vis[p + 1] = 120; vis[p + 2] = 50; }
  else { vis[p] = 26; vis[p + 1] = 30; vis[p + 2] = 38; }
}
await sharp(vis, { raw: { width: W, height: H, channels: 3 } })
  .resize({ width: 1024 }).png().toFile('test-results/personaje/mascara-repintado.png');
console.log('mascara -> test-results/personaje/mascara-repintado.png (rojo repintado, verde piel, gris resto)');
