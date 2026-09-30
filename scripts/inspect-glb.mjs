/** Lista los nodos raíz de un .glb y el tamaño de su bounding box. */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5180/';
const FILE = process.argv[3] ?? 'f100.glb';

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

try {
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  const out = await page.evaluate(async (file) => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
    const { DRACOLoader } = await import('/node_modules/three/examples/jsm/loaders/DRACOLoader.js');
    const draco = new DRACOLoader().setDecoderPath(
      'https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/draco/gltf/',
    );
    const loader = new GLTFLoader().setDRACOLoader(draco);
    const gltf = await loader.loadAsync(`/models/${file}`);

    const nodes = [];
    gltf.scene.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh && o.children.length === 0) return;
      const b = new THREE.Box3().setFromObject(o);
      const s = b.getSize(new THREE.Vector3());
      const c = b.getCenter(new THREE.Vector3());
      nodes.push({
        name: o.name,
        type: o.type,
        depth: (() => { let d = 0, p = o; while ((p = p.parent)) d++; return d; })(),
        size: [+s.x.toFixed(2), +s.y.toFixed(2), +s.z.toFixed(2)],
        center: [+c.x.toFixed(2), +c.y.toFixed(2), +c.z.toFixed(2)],
      });
    });
    return { animations: gltf.animations.map((a) => a.name), nodes };
  }, FILE);

  const small = out.nodes.filter((n) => Math.max(...n.size) < 15 && Math.max(...n.size) > 1);
  console.log('ANIMACIONES:', out.animations.length);
  console.log('NODOS (depth<=2):');
  for (const n of out.nodes.filter((n) => n.depth <= 2)) console.log(' ', JSON.stringify(n));
  console.log('\nCANDIDATOS tamaño vehículo (1-15 m):', small.length);
  for (const n of small.slice(0, 40)) console.log(' ', JSON.stringify(n));
} finally {
  await browser.close();
}
