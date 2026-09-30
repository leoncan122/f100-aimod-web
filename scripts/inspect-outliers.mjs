/** Meshes del vehículo ordenados por distancia al centro (detecta helpers sueltos). */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
try {
  const page = await browser.newPage();
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:5180/', { waitUntil: 'domcontentloaded' });
  const out = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
    const { DRACOLoader } = await import('/node_modules/three/examples/jsm/loaders/DRACOLoader.js');
    const draco = new DRACOLoader().setDecoderPath(
      'https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/draco/gltf/',
    );
    const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync('/models/f100.glb');
    const v = gltf.scene.getObjectByName('HandlerVehicle005');
    v.updateMatrixWorld(true);
    const vb = new THREE.Box3().setFromObject(v);
    const vc = vb.getCenter(new THREE.Vector3());

    const rows = [];
    v.traverse((o) => {
      if (!o.isMesh) return;
      const b = new THREE.Box3().setFromObject(o);
      const c = b.getCenter(new THREE.Vector3());
      const s = b.getSize(new THREE.Vector3());
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      rows.push({
        name: o.name,
        parent: o.parent?.name,
        dist: +c.distanceTo(vc).toFixed(2),
        size: [+s.x.toFixed(2), +s.y.toFixed(2), +s.z.toFixed(2)],
        mat: mats.map((m) => m?.name || '').join(','),
        color: mats.map((m) => (m?.color ? '#' + m.color.getHexString() : '')).join(','),
      });
    });
    rows.sort((a, b) => b.dist - a.dist);
    return rows.slice(0, 20);
  });
  for (const r of out) console.log(JSON.stringify(r));
} finally {
  await browser.close();
}
