/**
 * Quita la piel que el escaneo derramó ENCIMA de la camiseta.
 *
 * ⚠️ NO USAR TAL CUAL: se conserva porque mide el límite, no porque funcione.
 *
 * Es el defecto inverso al que arregla `fix-textura.mjs`: allí era blanco de
 * prenda sobre el brazo; aquí son lengüetas de tono carne que bajan del hombro
 * y la clavícula sobre el tejido blanco.
 *
 * POR QUÉ NO SIRVE (medido con scripts/diag-hombro.mjs): de los 4.239 vértices
 * que SE VEN como piel en la franja del hombro, solo el 3% están dominados por
 * huesos del torso, que es lo que esta máscara alcanza. El 97% restante lo
 * dominan `upper_arm` y `shoulder`, que son piel de verdad en casi toda su
 * extensión — repintarlos de blanco destruiría el brazo y el cuello.
 *
 * Al probarlo se vio exactamente eso: pintaba blanco sobre el cuello y apenas
 * tocaba la lengüeta del hombro.
 *
 * El borde piel/prenda no cae donde cambia el hueso, así que ninguna máscara
 * por hueso puede separarlos. Hace falta pintar a mano sobre el modelo
 * (docs/retoque-textura.md) o una máscara dibujada en el espacio UV.
 *
 * Requiere: node scripts/build-mask.mjs camiseta
 * Uso: node scripts/fix-piel-en-camiseta.mjs [entrada.png] [salida.png]
 */
import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const SRC = process.argv[2] ?? 'test-results/personaje/textura.png';
const DST = process.argv[3] ?? 'test-results/personaje/textura-fix2.png';
const MASK = 'test-results/personaje/mask-camiseta.raw';

/**
 * Qué cuenta como "piel" dentro de la camiseta.
 *
 * La tela blanca en sombra baja de luminosidad pero se mantiene gris (poca
 * saturación); la piel es cálida y saturada. El corte va por saturación, no
 * por brillo, para no comerse los pliegues oscuros de la prenda.
 */
const SAT_MIN = 0.20;
/** Además tiene que ser cálida: rojo por encima de azul. */
const CALIDO_MIN = 18;

const img = sharp(SRC);
const { width: W, height: H } = await img.metadata();
const px = Buffer.from(await img.removeAlpha().raw().toBuffer());
const N = W * H;

let tela;
try {
  tela = readFileSync(MASK);
} catch {
  console.error('falta la mascara: ejecuta antes  node scripts/build-mask.mjs camiseta');
  process.exit(1);
}
if (tela.length !== N) {
  console.error(`la mascara es de ${tela.length} px y la textura de ${N}`);
  process.exit(1);
}

// ── 1. dentro de la camiseta, marcar lo que tiene tono de piel
const objetivo = new Uint8Array(N);
let nObj = 0, nTela = 0;
for (let i = 0, p = 0; i < N; i++, p += 3) {
  if (!tela[i]) continue;
  nTela++;
  const r = px[p], g = px[p + 1], b = px[p + 2];
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  if (sat > SAT_MIN && r - b > CALIDO_MIN) { objetivo[i] = 1; nObj++; }
}
console.log(`mascara de camiseta: ${nTela} px (${((nTela / N) * 100).toFixed(1)}% del atlas)`);
console.log(`con tono de piel: ${nObj} (${((nObj / nTela) * 100).toFixed(1)}% de la prenda)`);

// ── 2. ensanchar para coger el halo de antialias del borde
let obj = Uint8Array.from(objetivo);
for (let k = 0; k < 2; k++) {
  const next = Uint8Array.from(obj);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (obj[i] || !tela[i]) continue; // solo crece dentro de la prenda
      if (obj[i - 1] || obj[i + 1] || obj[i - W] || obj[i + W]) next[i] = 1;
    }
  }
  obj = next;
}
let nFinal = 0;
for (let i = 0; i < N; i++) if (obj[i]) nFinal++;
console.log(`tras ensanchar 2 px: ${nFinal} px a repintar (${((nFinal / N) * 100).toFixed(2)}% de la textura)`);

// ── 3. difusión desde la tela sana
const out = Buffer.from(px);
const pend = Uint8Array.from(obj);
const d8 = [-1, 1, -W, W, -W - 1, -W + 1, W - 1, W + 1];
const prof = new Uint16Array(N); // pasada en que se rellenó: 1 = pegado al borde
let restantes = nFinal;
for (let pasada = 1; pasada <= 600 && restantes > 0; pasada++) {
  const hechos = [];
  for (let i = 0; i < N; i++) {
    if (!pend[i]) continue;
    let r = 0, g = 0, b = 0, n = 0;
    for (const d of d8) {
      const j = i + d;
      if (j < 0 || j >= N || pend[j]) continue;
      if (!tela[j]) continue; // el tono solo puede venir de la prenda
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
console.log(`repintados: ${nFinal - restantes}${restantes ? ` (${restantes} sin tela sana alrededor)` : ''}`);

// Los que quedan rodeados de piel por todos lados se dejan como están: un
// relleno plano sobre un área grande se ve como plastilina (probado en el
// arreglo inverso, quedaba peor que la mancha).
if (restantes) {
  for (let i = 0; i < N; i++) if (pend[i]) obj[i] = 0;
  console.log(`  ${restantes} px se dejan sin tocar`);
}

// ── 3b. desvanecer el borde, para que no se note dónde empieza el parche
const FUNDIDO = 3;
for (let i = 0; i < N; i++) {
  if (!obj[i] || !prof[i] || prof[i] > FUNDIDO) continue;
  const k = prof[i] / (FUNDIDO + 1);
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
  else if (tela[i]) { vis[p] = 50; vis[p + 1] = 90; vis[p + 2] = 190; }
  else { vis[p] = 26; vis[p + 1] = 30; vis[p + 2] = 38; }
}
await sharp(vis, { raw: { width: W, height: H, channels: 3 } })
  .resize({ width: 1024 }).png().toFile('test-results/personaje/mascara-piel-en-camiseta.png');
console.log('mascara -> test-results/personaje/mascara-piel-en-camiseta.png (rojo repintado, azul prenda)');
