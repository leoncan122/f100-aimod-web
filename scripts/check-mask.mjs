/**
 * ¿Está bien orientada la máscara de piel?
 *
 * El v3 del repintado destrozó la camiseta y lo atribuí a islas UV solapadas.
 * Antes de darlo por bueno hay que descartar la causa trivial: que la máscara
 * esté espejada en V. El atlas se guarda invertido respecto a las UV de glTF, y
 * si se invierte de más (o de menos) la máscara cae sobre el sitio equivocado —
 * exactamente el síntoma observado.
 *
 * Prueba: pintar la máscara COMO TEXTURA sobre el modelo. Si está bien, las
 * zonas marcadas coinciden con brazos, cuello y cabeza. Si está espejada, caen
 * sobre el torso.
 *
 * Uso: node scripts/check-mask.mjs [baseUrl]
 */
import { DEFAULT_BASE, launch } from './lib/viewer.mjs';
import { mkdirSync, readFileSync } from 'node:fs';
import sharp from 'sharp';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const OUT = 'test-results/personaje-mask';
mkdirSync(OUT, { recursive: true });

const SIZE = 2048;
const PARTE = process.argv[3] ?? 'piel';
const raw = readFileSync(`test-results/personaje/mask-${PARTE}.raw`);

// dos versiones: tal cual, y espejada en V
const comoEsta = await sharp(raw, { raw: { width: SIZE, height: SIZE, channels: 1 } })
  .png().toBuffer();
const espejada = await sharp(raw, { raw: { width: SIZE, height: SIZE, channels: 1 } })
  .flip().png().toBuffer();

const browser = await launch();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 1000 });
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 200)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
    const { DRACOLoader } = await import('/node_modules/three/examples/jsm/loaders/DRACOLoader.js');
    const draco = new DRACOLoader().setDecoderPath(
      'https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/draco/gltf/',
    );
    const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync('/models/personaje.glb');
    document.body.innerHTML = '';
    document.body.style.margin = '0';
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(800, 1000);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.body.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x202428);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 3));
    scene.add(gltf.scene);
    const camera = new THREE.PerspectiveCamera(32, 0.8, 0.01, 50);
    let skin = null;
    gltf.scene.traverse((o) => { if (o.isSkinnedMesh && !skin) skin = o; });
    // material plano: solo queremos ver dónde cae la máscara
    window.__m = { THREE, renderer, scene, camera, skin, flipY: skin.material.map.flipY };
    skin.material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  });

  const flipY = await page.evaluate(() => window.__m.flipY);
  console.log(`la textura original tiene flipY = ${flipY}`);

  const probar = async (nombre, b64) => {
    await page.evaluate(async (b64) => {
      const { THREE, skin } = window.__m;
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const t = new THREE.Texture(img);
      t.flipY = window.__m.flipY;
      t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      skin.material.map = t;
      skin.material.needsUpdate = true;
    }, b64);
    for (const [v, pos, target] of [
      ['frente', [0, 1.2, 2.5], [0, 1.15, 0]],
      ['torso', [0, 1.3, 1.4], [0, 1.3, 0]],
    ]) {
      await page.evaluate(([p, t]) => {
        const { renderer, scene, camera } = window.__m;
        camera.position.set(...p);
        camera.lookAt(...t);
        camera.updateProjectionMatrix();
        renderer.render(scene, camera);
      }, [pos, target]);
      await page.screenshot({ path: `${OUT}/${nombre}-${v}.png` });
    }
  };

  await probar(`${PARTE}-a-como-esta`, comoEsta.toString('base64'));
  await probar(`${PARTE}-b-espejada`, espejada.toString('base64'));
  console.log(`\nblanco = zona marcada como piel. Comparar en ${OUT}/`);
  console.log('si la version correcta marca brazos y cuello, la mascara sirve;');
  console.log('si ninguna lo hace limpiamente, las islas UV se solapan de verdad.');
} finally {
  await browser.close();
}
