/**
 * Localiza objetos de escena.glb que quedan sobre la trayectoria del vehículo.
 *
 * Reconstruye el recorrido muestreando la animación horneada del handler del
 * camión y mide, para cada objeto de la escena, su distancia horizontal mínima
 * a esa polilínea. Lo que aparece a pocos metros del centro está literalmente
 * en medio de la carretera.
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://localhost:5180/';

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

  const out = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
    const { DRACOLoader } = await import('/node_modules/three/examples/jsm/loaders/DRACOLoader.js');
    const draco = new DRACOLoader().setDecoderPath(
      'https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/draco/gltf/',
    );
    const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync('/models/escena.glb');

    const mixer = new THREE.AnimationMixer(gltf.scene);
    for (const c of gltf.animations) mixer.clipAction(c).play();

    let truck = null;
    gltf.scene.traverse((o) => {
      if (o.name === 'HandlerVehicle005' || o.name === 'HandlerVehicle.005') truck = o;
    });
    if (!truck) return { error: 'no se encontró el handler del vehículo' };

    // muestreo del recorrido
    const dur = Math.max(...gltf.animations.map((a) => a.duration));
    const path = [];
    const p = new THREE.Vector3();
    for (let i = 0; i <= 400; i++) {
      mixer.setTime((i / 400) * dur);
      gltf.scene.updateMatrixWorld(true);
      truck.getWorldPosition(p);
      path.push([p.x, p.y, p.z]);
    }

    const distToPath = (x, z) => {
      let best = Infinity;
      for (const q of path) {
        const d = Math.hypot(x - q[0], z - q[2]);
        if (d < best) best = d;
      }
      return best;
    };

    mixer.setTime(0);
    gltf.scene.updateMatrixWorld(true);

    const hits = [];
    const box = new THREE.Box3();
    const c = new THREE.Vector3();
    const s = new THREE.Vector3();
    gltf.scene.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      box.setFromObject(o);
      if (!isFinite(box.min.x)) return;
      box.getCenter(c);
      box.getSize(s);
      const d = distToPath(c.x, c.z);
      // solo objetos altos (>3 m) y no piezas del propio vehículo
      const isVehiclePart = (() => {
        let q = o;
        while (q) { if (q === truck) return true; q = q.parent; }
        return false;
      })();
      if (d < 14 && s.y > 2.5 && !isVehiclePart) {
        hits.push({
          name: o.name,
          parent: o.parent?.name ?? '',
          type: o.type,
          dist: +d.toFixed(2),
          center: [+c.x.toFixed(2), +c.y.toFixed(2), +c.z.toFixed(2)],
          size: [+s.x.toFixed(2), +s.y.toFixed(2), +s.z.toFixed(2)],
        });
      }
    });
    hits.sort((a, b) => a.dist - b.dist);
    return { duration: dur, count: hits.length, hits: hits.slice(0, 60) };
  });

  if (out.error) { console.log(out.error); } else {
  console.log('duracion', out.duration.toFixed(1), 's · candidatos', out.count);
  for (const h of out.hits) {
    console.log(
      String(h.dist).padStart(6), 'm |', h.name.padEnd(28),
      '| padre:', (h.parent || '-').padEnd(22),
      '| tam', h.size.join('x'), '| centro', h.center.join(','),
    );
  }
}
} finally {
  await browser.close();
}
