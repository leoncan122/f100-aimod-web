/**
 * Máscara UV de una parte del cuerpo, rasterizada desde la GEOMETRÍA.
 *
 * Decide qué píxeles del atlas pertenecen a una superficie concreta mirando qué
 * hueso domina cada vértice, no el color. Es lo único fiable aquí: en esta
 * textura piel y camiseta tienen tonos vecinos y cualquier umbral de color o se
 * come la prenda o deja la mancha.
 *
 * Dos máscaras:
 *   piel      brazos, deltoides exterior, cuello bajo la barbilla, dedos
 *   camiseta  torso y la parte del hombro que cubre el tirante
 *
 * Uso:
 *   node scripts/build-mask.mjs piel       [baseUrl]
 *   node scripts/build-mask.mjs camiseta   [baseUrl]
 *
 * Escribe test-results/personaje/mask-<parte>.raw y .png (blanco = dentro).
 */
import { DEFAULT_BASE, launch } from './lib/viewer.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const PARTE = process.argv[2];
if (PARTE !== 'piel' && PARTE !== 'camiseta') {
  console.error('Uso: node scripts/build-mask.mjs piel|camiseta [baseUrl]');
  process.exit(1);
}
const BASE = process.argv[3] ?? DEFAULT_BASE;
const OUT = 'test-results/personaje';
mkdirSync(OUT, { recursive: true });
const SIZE = 2048;

const browser = await launch();
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 200)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  const res = await page.evaluate(async ([SIZE, PARTE]) => {
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
    const idx = geo.index;
    // three.js sanea los nombres (spine.005 -> spine005) pero no en todas las
    // rutas de carga; se normaliza para no depender de ello.
    const limpia = (s) => String(s).replace(/[.\s]/g, '');
    const bones = skin.skeleton.bones.map((b) => limpia(b.name));

    const dom = new Uint16Array(P.count);
    for (let i = 0; i < P.count; i++) {
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) { const w = W.getComponent(i, k); if (w > bw) { bw = w; best = J.getComponent(i, k); } }
      dom[i] = best;
    }

    const BRAZO = ['upper_armL', 'upper_armR', 'forearmL', 'forearmR', 'handL', 'handR'];
    const CUELLO = ['spine004', 'spine005', 'neck'];
    const TORSO = ['spine', 'spine001', 'spine002', 'spine003'];
    /** Altura por debajo de la cual el cuello ya no es cara. */
    const BARBILLA = 1.5;
    /**
     * Frontera deltoides / tirante, medida a base de fallar: con |x| > 0.135 el
     * repintado de piel metía tono de carne encima del tirante; a partir de
     * 0.16 ya está fuera de la prenda. Los 2,5 cm de margen son todo lo que hay.
     */
    const HOMBRO = 0.16;

    const esPiel = (i) => {
      const nb = bones[dom[i]] ?? '';
      if (BRAZO.includes(nb)) return true;
      if (CUELLO.includes(nb)) return P.getY(i) < BARBILLA;
      if (nb === 'shoulderL' || nb === 'shoulderR') return Math.abs(P.getX(i)) > HOMBRO;
      return nb.startsWith('f_');
    };
    const esCamiseta = (i) => {
      const nb = bones[dom[i]] ?? '';
      // El torso por encima de la cintura: la camiseta de tirantes no llega más
      // abajo y por debajo empieza el pantalón, que no interesa.
      if (TORSO.includes(nb)) return P.getY(i) > 1.05;
      // La cara interna del hombro, que es donde se apoya el tirante.
      if (nb === 'shoulderL' || nb === 'shoulderR') return Math.abs(P.getX(i)) <= HOMBRO;
      return false;
    };
    const dentro = PARTE === 'piel' ? esPiel : esCamiseta;

    const mask = new Uint8Array(SIZE * SIZE);
    const n = idx ? idx.count : P.count;
    const get = (k) => (idx ? idx.getX(k) : k);
    let tris = 0;
    for (let k = 0; k < n; k += 3) {
      const a = get(k), b = get(k + 1), c = get(k + 2);
      if (!dentro(a) || !dentro(b) || !dentro(c)) continue;
      tris++;
      // SIN invertir V: esta textura trae flipY=false, así que la fila 0 del
      // atlas ya es v=0. Invertirla (la convención habitual de glTF) ponía la
      // máscara sobre el torso y el repintado destrozaba la camiseta.
      const ax = UV.getX(a) * SIZE, ay = UV.getY(a) * SIZE;
      const bx = UV.getX(b) * SIZE, by = UV.getY(b) * SIZE;
      const cx = UV.getX(c) * SIZE, cy = UV.getY(c) * SIZE;
      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const maxX = Math.min(SIZE - 1, Math.ceil(Math.max(ax, bx, cx)));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const maxY = Math.min(SIZE - 1, Math.ceil(Math.max(ay, by, cy)));
      const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(d) < 1e-12) continue;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5, py = y + 0.5;
          const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / d;
          const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / d;
          const w2 = 1 - w0 - w1;
          if (w0 < -0.002 || w1 < -0.002 || w2 < -0.002) continue;
          mask[y * SIZE + x] = 255;
        }
      }
    }
    return { mask: Array.from(mask), tris, total: n / 3 };
  }, [SIZE, PARTE]);

  const buf = Buffer.from(Uint8Array.from(res.mask));
  writeFileSync(`${OUT}/mask-${PARTE}.raw`, buf);
  await sharp(buf, { raw: { width: SIZE, height: SIZE, channels: 1 } })
    .png()
    .toFile(`${OUT}/mask-${PARTE}.png`);
  const cubierto = res.mask.reduce((a, v) => a + (v ? 1 : 0), 0);
  console.log(`triangulos de ${PARTE}: ${res.tris} de ${res.total}`);
  console.log(`cobertura: ${((cubierto / (SIZE * SIZE)) * 100).toFixed(1)}% del atlas`);
  console.log(`-> ${OUT}/mask-${PARTE}.png`);
} finally {
  await browser.close();
}
