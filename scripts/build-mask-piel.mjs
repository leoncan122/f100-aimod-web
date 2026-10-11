/**
 * Máscara UV de "esto es piel desnuda", construida desde la GEOMETRÍA.
 *
 * Los intentos por color fallan en los bordes: la camiseta y el brazo tienen
 * tonos vecinos en el atlas y cualquier umbral o se come la prenda o deja la
 * mancha. Pero sí sabemos con certeza qué TRIÁNGULOS son brazo, hombro o cuello
 * desnudos: lo dice el esqueleto (hueso dominante) más la altura del vértice.
 *
 * Así que se rasterizan esos triángulos en espacio UV. El resultado es una
 * máscara exacta: dentro de ella, cualquier píxel blanquecino es derrame del
 * escaneo, sin ambigüedad, porque esa zona del atlas es piel por construcción.
 *
 * Escribe test-results/personaje/mask-piel.png (blanco = piel desnuda).
 *
 * Uso: node scripts/build-mask-piel.mjs [baseUrl]
 */
import { DEFAULT_BASE, launch } from './lib/viewer.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const OUT = 'test-results/personaje';
mkdirSync(OUT, { recursive: true });
const SIZE = 2048;

const browser = await launch();
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 200)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  const res = await page.evaluate(async (SIZE) => {
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
    // rutas de carga: se normaliza aqui para no depender de ello.
    const limpia = (s) => String(s).replace(/[.\s]/g, '');
    const bones = skin.skeleton.bones.map((b) => b.name);

    const dom = new Uint16Array(P.count);
    for (let i = 0; i < P.count; i++) {
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) { const w = W.getComponent(i, k); if (w > bw) { bw = w; best = J.getComponent(i, k); } }
      dom[i] = best;
    }

    // Piel desnuda: brazos y antebrazos enteros, hombro por debajo del tirante,
    // y cuello/cabeza. El torso NO entra: ahí la camiseta es legítima.
    const BRAZO = ['upper_armL', 'upper_armR', 'forearmL', 'forearmR', 'handL', 'handR'];
    // La cabeza entera NO entra: los labios son rosados y poco saturados, caen
    // dentro del criterio de "descolorido" y el repintado se los come. Solo
    // cuello y nuca, que es donde el escaneo derramó blanco de la camiseta.
    const CUELLO = ['spine004', 'spine005', 'neck'];
    /** Altura por debajo de la cual el cuello ya no es cara. */
    const BARBILLA = 1.5;
    const esPielVert = (i) => {
      const nb = limpia(bones[dom[i]] ?? '');
      if (BRAZO.includes(nb)) return true;
      if (CUELLO.includes(nb)) return P.getY(i) < BARBILLA;
      // Deltoides: el hueso `shoulder` cubre a la vez el hombro desnudo y el
      // tirante de la camiseta, así que hay que recortarlo por posición.
      //
      // El umbral es delicado y está medido, no elegido a ojo: con |x| > 0.135
      // entra el tirante y el repintado le mete tono de piel encima (peor que
      // el blanco original); con |x| > 0.16 cae ya fuera de la prenda y solo
      // coge el deltoides. Ese margen de 2,5 cm es todo el que hay.
      if (nb === 'shoulderL' || nb === 'shoulderR') return Math.abs(P.getX(i)) > 0.16;
      if (nb.startsWith('f_')) return true; // dedos
      return false;
    };

    // rasterizar en UV los triángulos cuyos tres vértices son piel
    const mask = new Uint8Array(SIZE * SIZE);
    const n = idx ? idx.count : P.count;
    const get = (k) => (idx ? idx.getX(k) : k);
    let tris = 0;
    for (let k = 0; k < n; k += 3) {
      const a = get(k), b = get(k + 1), c = get(k + 2);
      if (!esPielVert(a) || !esPielVert(b) || !esPielVert(c)) continue;
      tris++;
      // Coordenadas en píxeles. SIN invertir V: esta textura trae flipY=false,
      // así que la fila 0 del atlas ya corresponde a v=0. Invertirla (el reflejo
      // de copiar la convención habitual de glTF) colocaba la máscara sobre el
      // torso y el repintado destrozaba la camiseta.
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
  }, SIZE);

  const buf = Buffer.from(Uint8Array.from(res.mask));
  writeFileSync(`${OUT}/mask-piel.raw`, buf);
  const sharp = (await import('sharp')).default;
  await sharp(buf, { raw: { width: SIZE, height: SIZE, channels: 1 } })
    .png()
    .toFile(`${OUT}/mask-piel.png`);
  const cubierto = res.mask.reduce((a, v) => a + (v ? 1 : 0), 0);
  console.log(`triangulos de piel: ${res.tris} de ${res.total}`);
  console.log(`cobertura de la mascara: ${((cubierto / (SIZE * SIZE)) * 100).toFixed(1)}% del atlas`);
  console.log(`-> ${OUT}/mask-piel.png`);
} finally {
  await browser.close();
}
