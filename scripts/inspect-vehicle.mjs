/** Analiza qué hay dentro del subárbol del vehículo en f100.glb. */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5180/';

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

try {
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const out = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
    const { DRACOLoader } = await import('/node_modules/three/examples/jsm/loaders/DRACOLoader.js');
    const draco = new DRACOLoader().setDecoderPath(
      'https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/draco/gltf/',
    );
    const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync('/models/f100.glb');
    const v = gltf.scene.getObjectByName('HandlerVehicle005');

    const meshes = [];
    v.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry;
      const tris = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      const b = new THREE.Box3().setFromObject(o);
      const s = b.getSize(new THREE.Vector3());
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      meshes.push({
        name: o.name,
        tris: Math.round(tris),
        size: [+s.x.toFixed(2), +s.y.toFixed(2), +s.z.toFixed(2)],
        mat: mats.map((m) => m?.name || m?.type).join(','),
        visible: o.visible,
      });
    });
    meshes.sort((a, b) => b.tris - a.tris);
    return {
      totalMeshes: meshes.length,
      totalTris: meshes.reduce((a, m) => a + m.tris, 0),
      top: meshes.slice(0, 25),
      // objetos NO mesh que podrían pintar líneas
      others: (() => {
        const r = [];
        v.traverse((o) => {
          if (o.isLine || o.isLineSegments || o.isPoints || o.isSprite) r.push({ n: o.name, t: o.type });
        });
        return r;
      })(),
    };
  });
  console.log(JSON.stringify(out, null, 1));
} finally {
  await browser.close();
}
