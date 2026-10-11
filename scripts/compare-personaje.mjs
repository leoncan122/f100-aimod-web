/**
 * Monta las comparaciones antes/después del conductor en una sola imagen y
 * cuantifica cuánta piel está pintada de blanco en la textura.
 *
 * Uso: node scripts/compare-personaje.mjs
 */
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const A = 'test-results/personaje';
const B = 'test-results/personaje-probe';
const OUT = 'test-results/personaje-compare';
mkdirSync(OUT, { recursive: true });

const etiqueta = (texto, w) =>
  Buffer.from(
    `<svg width="${w}" height="46"><rect width="${w}" height="46" fill="#11141a"/>` +
      `<text x="${w / 2}" y="30" font-family="system-ui,Segoe UI,sans-serif" font-size="20" ` +
      `fill="#e8ecf1" text-anchor="middle">${texto}</text></svg>`,
  );

/** Dos tomas una al lado de la otra, con rótulo. */
async function par(nombre, izq, der, tIzq, tDer) {
  const w = 620;
  const [a, b] = await Promise.all(
    [izq, der].map((f) => sharp(f).resize({ width: w }).toBuffer()),
  );
  const h = (await sharp(a).metadata()).height;
  await sharp({ create: { width: w * 2 + 12, height: h + 46, channels: 3, background: '#11141a' } })
    .composite([
      { input: etiqueta(tIzq, w), top: 0, left: 0 },
      { input: etiqueta(tDer, w), top: 0, left: w + 12 },
      { input: a, top: 46, left: 0 },
      { input: b, top: 46, left: w + 12 },
    ])
    .png()
    .toFile(`${OUT}/${nombre}.png`);
  console.log(`-> ${OUT}/${nombre}.png`);
}

await par('1-cabeza', `${A}/4-cabeza-cuello.png`, `${B}/c2-afinado-cabeza.png`, 'AHORA', 'AFINADO (cabeza y cuello -10%)');
await par('2-torso', `${A}/6-torso-brazos.png`, `${B}/c4-afinado-torso.png`, 'AHORA', 'AFINADO (brazos -14%)');
await par('3-frente', `${A}/1-frente.png`, `${B}/c1-afinado-frente.png`, 'AHORA', 'AFINADO');
await par('4-perfil', `${A}/2-perfil.png`, `${B}/c3-afinado-perfil.png`, 'AHORA', 'AFINADO');

// ── cuánto blanco hay en la textura (píxeles casi blancos y sin saturación)
const img = sharp(`${A}/textura.png`);
const { width, height } = await img.metadata();
const raw = await img.removeAlpha().raw().toBuffer();
let blancos = 0, total = width * height;
for (let i = 0; i < raw.length; i += 3) {
  const r = raw[i], g = raw[i + 1], b = raw[i + 2];
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (min > 205 && max - min < 22) blancos++;
}
console.log(`\ntextura ${width}x${height}: ${((blancos / total) * 100).toFixed(1)}% de pixeles casi blancos`);
