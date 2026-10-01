/**
 * Mide el desfase entre el handler animado del vehículo y la caja real de su
 * carrocería, para poder encuadrar la cámara trasera sobre el camión visible
 * y no sobre el pivote del rig.
 */
import { DEFAULT_BASE, launch } from './lib/viewer.mjs';

const BASE = process.argv[2] ?? DEFAULT_BASE;

const browser = await launch();

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
    const dur = Math.max(...gltf.animations.map((a) => a.duration));

    const rows = [];
    const hp = new THREE.Vector3();
    for (const t of [0, dur * 0.25, dur * 0.5, dur * 0.75]) {
      mixer.setTime(t);
      gltf.scene.updateMatrixWorld(true);
      truck.getWorldPosition(hp);
      const box = new THREE.Box3().setFromObject(truck);
      const c = box.getCenter(new THREE.Vector3());
      const s = box.getSize(new THREE.Vector3());
      // rumbo local del handler
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(truck.getWorldQuaternion(new THREE.Quaternion()));
      rows.push({
        t: +t.toFixed(1),
        handler: hp.toArray().map((n) => +n.toFixed(2)),
        boxCenter: c.toArray().map((n) => +n.toFixed(2)),
        boxSize: s.toArray().map((n) => +n.toFixed(2)),
        offset: c.clone().sub(hp).toArray().map((n) => +n.toFixed(2)),
        localFwd: fwd.toArray().map((n) => +n.toFixed(2)),
      });
    }
    return rows;
  });

  for (const r of out) console.log(JSON.stringify(r));
} finally {
  await browser.close();
}
