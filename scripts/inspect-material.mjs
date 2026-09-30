/** Lista todos los meshes de escena.glb que usan un material dado. */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://localhost:5180/';
const MAT = process.argv[3] ?? 'Arbol_Hojas';

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  protocolTimeout: 600_000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 300)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  const out = await page.evaluate(async (matName) => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
    const { DRACOLoader } = await import('/node_modules/three/examples/jsm/loaders/DRACOLoader.js');
    const draco = new DRACOLoader().setDecoderPath(
      'https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/draco/gltf/',
    );
    const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync('/models/escena.glb');
    gltf.scene.updateMatrixWorld(true);

    const rows = [];
    const box = new THREE.Box3();
    const c = new THREE.Vector3();
    const s = new THREE.Vector3();
    gltf.scene.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      if (!mats.some((m) => (m?.name ?? '').includes(matName))) return;
      box.setFromObject(o);
      box.getCenter(c);
      box.getSize(s);
      rows.push({
        name: o.name,
        type: o.type,
        instances: o.isInstancedMesh ? o.count : null,
        parent: o.parent?.name ?? '',
        center: [+c.x.toFixed(1), +c.y.toFixed(1), +c.z.toFixed(1)],
        size: [+s.x.toFixed(1), +s.y.toFixed(1), +s.z.toFixed(1)],
      });
    });
    return rows;
  }, MAT);

  for (const r of out) {
    console.log(
      r.type.padEnd(14), r.name.padEnd(26), 'inst:', String(r.instances ?? '-').padStart(5),
      'padre:', r.parent.padEnd(22), 'tam:', String(r.size), 'centro:', String(r.center),
    );
  }
  console.log('total', out.length);
} finally {
  await browser.close();
}
