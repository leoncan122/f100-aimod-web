/**
 * ¿Por qué el repintado automático no arregla la lengüeta del hombro?
 *
 * Sospecha: en el borde visual piel/prenda, el hueso dominante NO coincide con
 * lo que se ve. Los píxeles de tono carne que caen sobre la camiseta estarían
 * dominados por `upper_arm`, así que entran en la máscara de PIEL y quedan
 * fuera de la de CAMISETA — ninguna de las dos los toca.
 *
 * Esto lo mide: para los vértices visualmente "de piel" (tono cálido en la
 * textura), cuenta qué hueso los domina y en qué máscara caen.
 *
 * Uso: node scripts/diag-hombro.mjs [baseUrl]
 */
import { DEFAULT_BASE, launch } from './lib/viewer.mjs';

const BASE = process.argv[2] ?? DEFAULT_BASE;

const browser = await launch();
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 200)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  const res = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
    const { DRACOLoader } = await import('/node_modules/three/examples/jsm/loaders/DRACOLoader.js');
    const draco = new DRACOLoader().setDecoderPath(
      'https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/draco/gltf/',
    );
    const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync('/models/personaje.glb');
    let skin = null;
    gltf.scene.traverse((o) => { if (o.isSkinnedMesh && !skin) skin = o; });

    const geo = skin.geometry;
    const P = geo.getAttribute('position');
    const UV = geo.getAttribute('uv');
    const J = geo.getAttribute('skinIndex'), W = geo.getAttribute('skinWeight');
    const limpia = (s) => String(s).replace(/[.\s]/g, '');
    const bones = skin.skeleton.bones.map((b) => limpia(b.name));

    // leer la textura a un canvas para muestrear el color de cada vértice
    const img = skin.material.map.image;
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const SZ = cv.width;

    const colorDe = (i) => {
      // flipY=false: la V no se invierte
      const x = Math.min(SZ - 1, Math.max(0, Math.round(UV.getX(i) * SZ)));
      const y = Math.min(SZ - 1, Math.max(0, Math.round(UV.getY(i) * SZ)));
      const q = (y * SZ + x) * 4;
      return [data[q], data[q + 1], data[q + 2]];
    };
    const esTonoPiel = ([r, g, b]) => {
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      return sat > 0.20 && r - b > 18;
    };

    // zona de interés: el entorno del hombro y la sisa
    const cuenta = {};
    let total = 0;
    for (let i = 0; i < P.count; i++) {
      const x = Math.abs(P.getX(i)), y = P.getY(i), z = P.getZ(i);
      if (y < 1.15 || y > 1.50) continue;      // franja del hombro
      if (x < 0.10 || x > 0.26) continue;       // del pecho al brazo
      if (Math.abs(z) > 0.20) continue;
      if (!esTonoPiel(colorDe(i))) continue;    // solo lo que SE VE como piel
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) { const w = W.getComponent(i, k); if (w > bw) { bw = w; best = J.getComponent(i, k); } }
      const nb = bones[best] ?? '?';
      cuenta[nb] = (cuenta[nb] ?? 0) + 1;
      total++;
    }
    return { cuenta, total };
  });

  console.log('Vertices que SE VEN como piel en la franja del hombro (y 1.15-1.50, |x| 0.10-0.26):');
  console.log(`total: ${res.total}\n`);
  const PIEL_MASK = ['upper_armL', 'upper_armR', 'forearmL', 'forearmR', 'handL', 'handR'];
  const TORSO = ['spine', 'spine001', 'spine002', 'spine003'];
  const orden = Object.entries(res.cuenta).sort((a, b) => b[1] - a[1]);
  for (const [nb, n] of orden) {
    let donde = 'NINGUNA mascara';
    if (PIEL_MASK.includes(nb)) donde = 'mascara PIEL (se protege, no se repinta)';
    else if (nb.startsWith('shoulder')) donde = 'hombro: depende del umbral |x|>0.16';
    else if (TORSO.includes(nb)) donde = 'mascara CAMISETA (si se repinta)';
    console.log(`  ${nb.padEnd(14)} ${String(n).padStart(6)}  -> ${donde}`);
  }
} finally {
  await browser.close();
}
