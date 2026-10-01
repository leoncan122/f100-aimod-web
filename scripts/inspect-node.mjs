/** Detalle de un nodo de escena.glb: jerarquía, tipo, instancias y material. */
import { DEFAULT_BASE, launch } from './lib/viewer.mjs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const NEEDLE = process.argv[3] ?? 'Paisaje_Terreno';

const browser = await launch();

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 300)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  const out = await page.evaluate(async (needle) => {
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
      if (!o.name.includes(needle)) return;
      box.setFromObject(o);
      const ok = isFinite(box.min.x);
      if (ok) { box.getCenter(c); box.getSize(s); }
      const chain = [];
      let q = o.parent;
      while (q) { chain.push(q.name || q.type); q = q.parent; }
      rows.push({
        name: o.name,
        type: o.type,
        instances: o.isInstancedMesh ? o.count : null,
        material: o.material?.name ?? null,
        tris: o.geometry ? (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 : null,
        children: o.children.length,
        chain: chain.join(' < '),
        center: ok ? [+c.x.toFixed(2), +c.y.toFixed(2), +c.z.toFixed(2)] : null,
        size: ok ? [+s.x.toFixed(2), +s.y.toFixed(2), +s.z.toFixed(2)] : null,
      });
    });
    return rows;
  }, NEEDLE);

  for (const r of out) {
    console.log(
      r.type.padEnd(14), r.name.padEnd(26),
      'inst:', String(r.instances ?? '-').padStart(5),
      'tris:', String(r.tris ?? '-').padStart(7),
      'hijos:', String(r.children).padStart(3),
      'mat:', String(r.material).padEnd(20),
      'tam:', String(r.size), 'centro:', String(r.center),
      '| padres:', r.chain,
    );
  }
  console.log('total', out.length);
} finally {
  await browser.close();
}
