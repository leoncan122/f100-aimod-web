/**
 * Compara el conductor ACTUAL contra el ORIGINAL del backup, lado a lado.
 *
 * Carga los dos .glb en la misma escena con la misma luz y cámara, y hace las
 * mismas tomas de cada uno. Sirve para decidir con evidencia si un cambio
 * (afinado de proporciones, repintado de textura) mejoró o empeoró.
 *
 * Necesita una copia del original servida por vite:
 *   cp ~/hermes-workspace/scratchpad/f100-backup/personaje.ORIGINAL.glb \
 *      public/models/_cmp-original.glb
 *
 * Uso: node scripts/compare-vs-original.mjs [baseUrl]
 */
import { DEFAULT_BASE, launch } from './lib/viewer.mjs';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const OUT = 'test-results/vs-original';
mkdirSync(OUT, { recursive: true });

const MODELOS = [
  { id: 'original', url: '/models/_cmp-original.glb' },
  { id: 'actual', url: '/models/personaje.glb' },
];

const TOMAS = [
  { n: 'frente', pos: [0, 1.25, 2.5], tgt: [0, 1.15, 0], fov: 32 },
  { n: 'torso', pos: [0, 1.3, 1.5], tgt: [0, 1.28, 0], fov: 30 },
  { n: 'cara', pos: [0, 1.62, 0.8], tgt: [0, 1.58, 0], fov: 26 },
  { n: 'hombro', pos: [1.35, 1.4, 1.2], tgt: [0.1, 1.33, 0], fov: 25 },
  { n: 'perfil', pos: [2.5, 1.25, 0], tgt: [0, 1.15, 0], fov: 32 },
];

// Una PÁGINA NUEVA por modelo, a propósito.
//
// Antes los dos modelos se cargaban en la misma escena, quitando el anterior
// con `scene.remove()`. No es suficiente: three.js conserva geometrías,
// materiales y texturas en GPU, y la segunda foto salía contaminada por la
// primera. Se añadió `dispose()` + `Cache.clear()` y SEGUÍA fallando.
//
// La prueba que lo demostró: renderizar el MISMO archivo en los dos lados.
// Si la comparación es honesta, las dos fotos deben ser idénticas píxel a
// píxel — y no lo eran. Ese control se mantiene abajo como verificación.
//
// Con una página por modelo no hay estado que compartir y el problema
// desaparece de raíz.
const SETUP = async () => {
  const THREE = await import('/node_modules/three/build/three.module.js');
  const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
  const { DRACOLoader } = await import('/node_modules/three/examples/jsm/loaders/DRACOLoader.js');
  const draco = new DRACOLoader().setDecoderPath(
    'https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/draco/gltf/',
  );
  document.body.innerHTML = '';
  document.body.style.margin = '0';
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(760, 950);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x6a6f75);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x555860, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(2, 3, 3);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.set(-2.5, 1.5, -1.5);
  scene.add(fill);
  const camera = new THREE.PerspectiveCamera(32, 760 / 950, 0.01, 50);

  window.__c = {
    THREE, renderer, scene, camera,
    loader: new GLTFLoader().setDRACOLoader(draco),
    async cargar(url) {
      const gltf = await window.__c.loader.loadAsync(url);
      scene.add(gltf.scene);
      let skin = null;
      gltf.scene.traverse((o) => { if (o.isSkinnedMesh && !skin) skin = o; });
      const P = skin.geometry.getAttribute('position');
      const franja = (y0, y1, maxZ) => {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < P.count; i++) {
          const y = P.getY(i);
          if (y < y0 || y > y1) continue;
          if (maxZ !== undefined && Math.abs(P.getZ(i)) > maxZ) continue;
          const x = P.getX(i);
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
        return +(hi - lo).toFixed(3);
      };
      let alto = -Infinity;
      for (let i = 0; i < P.count; i++) alto = Math.max(alto, P.getY(i));
      return { verts: P.count, cabeza: franja(1.62, 1.70), cuello: franja(1.45, 1.52), alto: +alto.toFixed(3) };
    },
    foto(p, tg, f) {
      camera.fov = f;
      camera.position.set(...p);
      camera.lookAt(...tg);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    },
  };
};

const browser = await launch();
try {
  const medidas = {};
  for (const m of MODELOS) {
    const page = await browser.newPage();
    await page.setViewport({ width: 760, height: 950 });
    page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 250)));
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.evaluate(SETUP);
    medidas[m.id] = await page.evaluate((u) => window.__c.cargar(u), m.url);
    for (const t of TOMAS) {
      await page.evaluate(([p, tg, f]) => window.__c.foto(p, tg, f), [t.pos, t.tgt, t.fov]);
      await page.screenshot({ path: `${OUT}/${m.id}-${t.n}.png` });
    }
    console.log(`${m.id}: ${JSON.stringify(medidas[m.id])}`);
    await page.close();
  }

  // ── verificación del propio comparador
  //
  // Si los dos .glb son el mismo archivo, las fotos deben ser idénticas. Si no
  // lo son, el comparador miente y cualquier conclusión sacada de él es basura.
  const sharpV = (await import('sharp')).default;
  {
    const difs = [];
    for (const t of TOMAS) {
      const [a, b] = await Promise.all(
        [`${OUT}/original-${t.n}.png`, `${OUT}/actual-${t.n}.png`]
          .map((f) => sharpV(f).removeAlpha().raw().toBuffer()),
      );
      let suma = 0;
      for (let i = 0; i < a.length; i++) suma += Math.abs(a[i] - b[i]);
      difs.push({ toma: t.n, media: +(suma / a.length).toFixed(2) });
    }
    console.log('\ndiferencia media por toma (0 = idénticas):');
    for (const d of difs) console.log(`  ${d.toma.padEnd(8)} ${d.media}`);
    if (process.env.CONTROL === '1') {
      const malas = difs.filter((d) => d.media > 0.01);
      console.log(malas.length
        ? `\n=> COMPARADOR ROTO: ${malas.length} tomas difieren con el mismo archivo.`
        : '\n=> comparador fiable: mismo archivo -> fotos idénticas.');
      process.exitCode = malas.length ? 1 : 0;
    }
  }

  // ── montar las parejas
  const sharp = (await import('sharp')).default;
  const lab = (t, w, c) => Buffer.from(
    `<svg width="${w}" height="46"><rect width="${w}" height="46" fill="#11141a"/>` +
    `<text x="${w / 2}" y="31" font-family="system-ui,sans-serif" font-size="21" font-weight="600" fill="${c}" text-anchor="middle">${t}</text></svg>`,
  );
  for (const t of TOMAS) {
    const w = 620;
    const [a, b] = await Promise.all(
      [`${OUT}/original-${t.n}.png`, `${OUT}/actual-${t.n}.png`]
        .map((f) => sharp(f).resize({ width: w }).toBuffer()),
    );
    const h = (await sharp(a).metadata()).height;
    await sharp({ create: { width: w * 2 + 12, height: h + 46, channels: 3, background: '#11141a' } })
      .composite([
        { input: lab('ORIGINAL (backup)', w, '#9aa4b2'), top: 0, left: 0 },
        { input: lab('ACTUAL (en el repo)', w, '#ff6b60'), top: 0, left: w + 12 },
        { input: a, top: 46, left: 0 },
        { input: b, top: 46, left: w + 12 },
      ])
      .png()
      .toFile(`${OUT}/cmp-${t.n}.png`);
  }
  console.log(`\ncomparaciones en ${OUT}/cmp-*.png`);
} finally {
  await browser.close();
}
