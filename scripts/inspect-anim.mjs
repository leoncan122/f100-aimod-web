/** Reproduce el pipeline del modo orbit y mide dispersión ANTES y DESPUÉS de animar. */
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
    gltf.scene.updateMatrixWorld(true);

    const model = new THREE.Group();
    model.attach(v);

    const bbox = (label) => {
      model.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(model);
      const s = b.getSize(new THREE.Vector3());
      return { label, size: [+s.x.toFixed(2), +s.y.toFixed(2), +s.z.toFixed(2)] };
    };

    const before = bbox('antes de animar');

    const names = new Set();
    model.traverse((o) => names.add(o.name));
    const clips = gltf.animations.filter((c) =>
      c.tracks.some((t) => names.has(t.name.split('.')[0] ?? '')),
    );
    const mixer = new THREE.AnimationMixer(model);
    for (const c of clips) mixer.clipAction(c).play();
    mixer.setTime(6);
    const after = bbox('tras 6 s de animación');

    // qué mesh se fue lejos
    model.updateMatrixWorld(true);
    const c0 = new THREE.Box3().setFromObject(v).getCenter(new THREE.Vector3());
    const far = [];
    model.traverse((o) => {
      if (!o.isMesh) return;
      const c = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
      const d = c.distanceTo(c0);
      if (d > 4) far.push({ name: o.name, parent: o.parent?.name, dist: +d.toFixed(1) });
    });
    far.sort((a, b) => b.dist - a.dist);

    return {
      clipsTotal: gltf.animations.length,
      clipsAplicados: clips.length,
      nombresClips: clips.map((c) => c.name).slice(0, 15),
      before,
      after,
      lejos: far.slice(0, 15),
    };
  });
  console.log(JSON.stringify(out, null, 1));
} finally {
  await browser.close();
}
