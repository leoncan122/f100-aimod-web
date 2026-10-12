/**
 * Previsualiza al conductor con la textura repintada y el afinado de
 * proporciones, sin tocar el repo. Todo se aplica en memoria.
 *
 * Genera las tomas de "antes" y "después" para poder decidir mirando.
 *
 * Uso: node scripts/preview-personaje.mjs [baseUrl]
 */
import { DEFAULT_BASE, launch } from './lib/viewer.mjs';
import { mkdirSync, readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const OUT = 'test-results/personaje-preview';
mkdirSync(OUT, { recursive: true });

// la textura arreglada viaja al navegador como data URL
const TEX = process.argv[3] ?? 'test-results/personaje/textura-fix.png';
const fix = readFileSync(TEX).toString('base64');
// El afinado de proporciones ya esta dentro del .glb desde el commit 69c0b24;
// volver a aplicarlo aqui lo duplicaria y daria una vista enganosa.
const AFINAR = process.argv.includes('--afinar');

const browser = await launch();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1100 });
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 300)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  await page.evaluate(async (AFINAR_FLAG) => {
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
    renderer.setSize(900, 1100);
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
    scene.add(gltf.scene);
    const camera = new THREE.PerspectiveCamera(32, 900 / 1100, 0.01, 50);

    let skin = null;
    gltf.scene.traverse((o) => { if (o.isSkinnedMesh && !skin) skin = o; });
    const geo = skin.geometry;
    window.__v = {
      THREE, renderer, scene, camera, skin, afinar: AFINAR_FLAG,
      original: geo.getAttribute('position').array.slice(),
      texOriginal: skin.material.map,
    };

    const J = geo.getAttribute('skinIndex'), W = geo.getAttribute('skinWeight');
    const bones = skin.skeleton.bones.map((b) => b.name);
    const dom = new Uint16Array(J.count);
    for (let i = 0; i < J.count; i++) {
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) { const w = W.getComponent(i, k); if (w > bw) { bw = w; best = J.getComponent(i, k); } }
      dom[i] = best;
    }
    window.__v.dom = dom;
    window.__v.bones = bones;
  }, AFINAR);

  const shot = async (name, pos, target, fov = 32) => {
    await page.evaluate(([p, t, f]) => {
      const { renderer, scene, camera } = window.__v;
      camera.fov = f;
      camera.position.set(...p);
      camera.lookAt(...t);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    }, [pos, target, fov]);
    await page.screenshot({ path: `${OUT}/${name}.png` });
  };

  const TOMAS = [
    ['hombro', [1.45, 1.42, 1.25], [0.12, 1.36, 0], 24],
    ['escote', [0, 1.45, 1.0], [0, 1.4, 0], 26],
    ['frente', [0, 1.25, 2.6], [0, 1.15, 0], 32],
    ['brazo', [1.3, 1.15, 1.4], [0.22, 1.15, 0], 26],
  ];

  for (const [n, p, t, f] of TOMAS) await shot(`antes-${n}`, p, t, f);

  // ── aplicar textura repintada + afinado
  await page.evaluate(async (b64) => {
    const { THREE, skin, original, dom, bones } = window.__v;

    // textura
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const tex = new THREE.Texture(img);
    tex.flipY = window.__v.texOriginal.flipY;
    tex.colorSpace = window.__v.texOriginal.colorSpace;
    tex.wrapS = window.__v.texOriginal.wrapS;
    tex.wrapT = window.__v.texOriginal.wrapT;
    tex.needsUpdate = true;
    skin.material.map = tex;
    skin.material.needsUpdate = true;

    if (!window.__v.afinar) return;
    // afinado por vértices (esqueleto intacto)
    const geo = skin.geometry;
    const P = geo.getAttribute('position');
    P.array.set(original);
    skin.skeleton.pose();
    skin.updateMatrixWorld(true);
    const inv = skin.matrixWorld.clone().invert();
    const ejes = new Map();
    for (const b of skin.skeleton.bones) {
      const a = b.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
      const h = b.children.find((c) => c.isBone);
      const c = h ? h.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv) : a.clone().add(new THREE.Vector3(0, 0.1, 0));
      ejes.set(b.name, { a, d: c.clone().sub(a) });
    }
    const apretar = (nombres, k) => {
      const v = new THREE.Vector3(), p = new THREE.Vector3();
      for (let i = 0; i < P.count; i++) {
        const nb = bones[dom[i]];
        if (!nombres.includes(nb)) continue;
        const e = ejes.get(nb);
        if (!e) continue;
        v.set(P.getX(i), P.getY(i), P.getZ(i));
        const t = Math.max(0, Math.min(1, v.clone().sub(e.a).dot(e.d) / (e.d.lengthSq() || 1e-9)));
        p.copy(e.a).addScaledVector(e.d, t);
        v.sub(p).multiplyScalar(k).add(p);
        P.setXYZ(i, v.x, v.y, v.z);
      }
    };
    apretar(['spine004', 'spine005', 'neck', 'head'], 0.9);
    apretar(['upper_armL', 'upper_armR', 'forearmL', 'forearmR'], 0.86);
    apretar(['shoulderL', 'shoulderR'], 0.93);
    P.needsUpdate = true;
    geo.computeVertexNormals();
  }, fix);

  for (const [n, p, t, f] of TOMAS) await shot(`despues-${n}`, p, t, f);

  console.log(`tomas en ${OUT}/`);
} finally {
  await browser.close();
}
