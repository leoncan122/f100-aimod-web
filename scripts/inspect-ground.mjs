/** Mide el apoyo real del vehículo: bbox global vs fondo de las ruedas. */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  protocolTimeout: 600_000,
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
    gltf.scene.updateMatrixWorld(true);
    const root = new THREE.Group();
    root.attach(v);
    root.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(root);
    const inner = root.children[0];
    inner.position.y -= box.min.y;
    root.updateMatrixWorld(true);

    const after = new THREE.Box3().setFromObject(root);

    // ¿qué mesh define el punto más bajo?
    let lowest = null;
    let lowestY = Infinity;
    const wheelBottoms = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      const b = new THREE.Box3().setFromObject(o);
      if (b.min.y < lowestY) {
        lowestY = b.min.y;
        lowest = o.name;
      }
      if (/Rueda|Neumatico|Llanta|Tire|Wheel/i.test(o.name)) {
        wheelBottoms.push({ name: o.name, minY: +b.min.y.toFixed(3) });
      }
    });
    wheelBottoms.sort((a, b) => a.minY - b.minY);

    return {
      bboxTrasCentrar: { minY: +after.min.y.toFixed(3), maxY: +after.max.y.toFixed(3) },
      meshMasBajo: { name: lowest, minY: +lowestY.toFixed(3) },
      ruedas: wheelBottoms.slice(0, 8),
    };
  });
  console.log(JSON.stringify(out, null, 1));
} finally {
  await browser.close();
}
