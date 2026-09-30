/**
 * Compara los .glb optimizados con los originales: cuenta nodos clave,
 * animaciones y mide el bbox del vehículo. Falla si algo se perdió.
 *
 * Uso: node scripts/verify-models.mjs [baseUrl]
 */
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5180/';

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  protocolTimeout: 600_000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

let failed = false;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    console.log('[PAGEERROR]', e.message.slice(0, 300));
    failed = true;
  });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  const probe = async (url) =>
    page.evaluate(async (u) => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
      const { DRACOLoader } = await import('/node_modules/three/examples/jsm/loaders/DRACOLoader.js');
      const draco = new DRACOLoader().setDecoderPath(
        'https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/draco/gltf/',
      );
      try {
        const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync(u);
        let meshes = 0;
        let tris = 0;
        const named = [];
        gltf.scene.traverse((o) => {
          if (o.isMesh) {
            meshes++;
            const g = o.geometry;
            tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
          }
          if (/^(ROT_Rueda_|PIV_Dir_|HandlerVehicle)/.test(o.name)) named.push(o.name);
        });
        const v = gltf.scene.getObjectByName('HandlerVehicle005')
               ?? gltf.scene.getObjectByName('HandlerVehicle.005');
        let vbox = null;
        if (v) {
          gltf.scene.updateMatrixWorld(true);
          const b = new THREE.Box3().setFromObject(v);
          const s = b.getSize(new THREE.Vector3());
          vbox = [+s.x.toFixed(2), +s.y.toFixed(2), +s.z.toFixed(2)];
        }
        const sbox = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3());
        return {
          ok: true,
          meshes,
          tris: Math.round(tris),
          animations: gltf.animations.length,
          rigNodes: named.sort(),
          vehicleSize: vbox,
          sceneSize: [+sbox.x.toFixed(1), +sbox.y.toFixed(1), +sbox.z.toFixed(1)],
        };
      } catch (e) {
        return { ok: false, error: String(e).slice(0, 300) };
      }
    }, url);

  const pairs = [
    ['CAMIONETA', '/models/f100.glb', '/models-opt/f100-truck.glb'],
    ['ESCENA', '/models/escena.glb', '/models-opt/escena.glb'],
  ];

  for (const [label, origUrl, optUrl] of pairs) {
    console.log(`\n=== ${label} ===`);
    const a = await probe(origUrl);
    const b = await probe(optUrl);
    console.log('  original :', JSON.stringify(a));
    console.log('  optimizado:', JSON.stringify(b));

    if (!b.ok) {
      console.log('  FALLO: el optimizado no carga');
      failed = true;
      continue;
    }
    if (label === 'CAMIONETA') {
      // el rig del vehículo debe sobrevivir intacto
      const need = ['ROT_Rueda_DD', 'ROT_Rueda_DI', 'ROT_Rueda_TD', 'ROT_Rueda_TI'];
      const missing = need.filter((n) => !b.rigNodes.includes(n));
      if (missing.length) {
        console.log('  FALLO: faltan nodos del rig:', missing);
        failed = true;
      }
      if (!b.vehicleSize) {
        console.log('  FALLO: no se encuentra HandlerVehicle005');
        failed = true;
      } else {
        const d = a.vehicleSize.map((v, i) => Math.abs(v - b.vehicleSize[i]));
        if (Math.max(...d) > 0.05) {
          console.log('  FALLO: el bbox del vehículo cambió', a.vehicleSize, '->', b.vehicleSize);
          failed = true;
        } else {
          console.log('  OK bbox del vehículo idéntico:', b.vehicleSize);
        }
      }
    }
    if (label === 'ESCENA') {
      if (b.animations !== a.animations) {
        console.log(`  FALLO: animaciones ${a.animations} -> ${b.animations}`);
        failed = true;
      } else {
        console.log(`  OK ${b.animations} animaciones conservadas`);
      }
      // Tolerancia relativa: weld() fusiona vértices casi coincidentes, así
      // que el bbox puede variar unas décimas de porcentaje. Un fallo real
      // (geometría perdida) mueve el bbox mucho más que un 1 %.
      const rel = a.sceneSize.map((v, i) => Math.abs(v - b.sceneSize[i]) / Math.max(v, 1));
      if (Math.max(...rel) > 0.01) {
        console.log('  FALLO: bbox de escena cambió', a.sceneSize, '->', b.sceneSize);
        failed = true;
      } else {
        const pct = (Math.max(...rel) * 100).toFixed(2);
        console.log(`  OK bbox de escena conservado (desvío máx. ${pct} %)`);
      }
    }
  }

  console.log(failed ? '\nRESULTADO: FALLO' : '\nRESULTADO: OK');
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
