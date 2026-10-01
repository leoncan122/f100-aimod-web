/**
 * Regresión de apoyo: el hueco entre los neumáticos y el asfalto en el modo
 * Desierto debe mantenerse < 5 mm durante todo el bucle de 15 s.
 *
 * El contacto se calcula como (eje de giro − radio real del neumático), nunca
 * con un Box3: ese bbox lo define la suspensión (14 cm más abajo) y además
 * oscila al girar las ruedas.
 *
 * Uso: node scripts/test-grounding.mjs [baseUrl]   (requiere dev server)
 */
import { DEFAULT_BASE, launch, openMode } from './lib/viewer.mjs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const MAX_GAP = 0.005; // 5 mm
const SAMPLES = [0, 2, 4, 6, 8, 10, 12, 14.5];

const browser = await launch();

let failed = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 450 });
  page.on('pageerror', (e) => {
    console.log('[PAGEERROR]', e.message.slice(0, 300));
    failed = true;
  });

  // Directo a la vista por hash: evita cargar la vista por defecto y pulsar la
  // pestaña (una carga de escena menos, ~12 s bajo SwiftShader).
  await openMode(page, BASE, 'desert');
  await new Promise((r) => setTimeout(r, 2500));
  await page.click('#play'); // pausar

  const rows = [];
  for (const t of SAMPLES) {
    await page.evaluate((v) => {
      const s = document.getElementById('seek');
      s.value = String(v / 15);
      s.dispatchEvent(new Event('input'));
    }, t);
    await new Promise((r) => setTimeout(r, 1200));

    const gap = await page.evaluate(async () => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      const scene = window.__scene;
      const truck = scene?.getObjectByName('F100');
      if (!truck) return null;
      scene.updateMatrixWorld(true);

      // El asfalto se identifica por su GEOMETRIA, no por su color: el color del
      // material cambia cada vez que se retoca el look (al texturizarlo paso a
      // blanco, porque el tono lo aporta el mapa), y un test atado al hex se
      // rompe en silencio y deja de medir.
      // Criterio: el plano horizontal mas angosto en X (el suelo es ~1200 m de
      // ancho, la carretera ~8.4 m).
      let roadY = null;
      let narrowest = Infinity;
      scene.traverse((o) => {
        if (!o.isMesh || o.geometry?.type !== 'PlaneGeometry') return;
        const w = o.geometry.parameters?.width ?? Infinity;
        if (w < narrowest) {
          narrowest = w;
          roadY = o.position.y;
        }
      });

      const inv = new THREE.Matrix4();
      const wp = new THREE.Vector3();
      const p = new THREE.Vector3();
      let lowest = Infinity;
      truck.traverse((node) => {
        if (!/^ROT_Rueda_/.test(node.name)) return;
        node.getWorldPosition(wp);
        inv.copy(node.matrixWorld).invert();
        let rMax = 0;
        node.traverse((o) => {
          if (!o.isMesh) return;
          const pa = o.geometry?.attributes.position;
          if (!pa) return;
          for (let i = 0; i < pa.count; i++) {
            p.fromBufferAttribute(pa, i);
            o.localToWorld(p);
            p.applyMatrix4(inv);
            const r = Math.hypot(p.y, p.z);
            if (r > rMax) rMax = r;
          }
        });
        lowest = Math.min(lowest, wp.y - rMax);
      });
      return roadY === null ? null : lowest - roadY;
    });

    if (gap === null) {
      console.log(`t=${t}s  ERROR: no se pudo medir`);
      failed = true;
      continue;
    }
    const mm = gap * 1000;
    const ok = Math.abs(gap) <= MAX_GAP;
    if (!ok) failed = true;
    rows.push({ t, mm: +mm.toFixed(2), ok });
    console.log(`t=${String(t).padStart(4)}s  hueco=${mm.toFixed(2).padStart(7)} mm  ${ok ? 'OK' : 'FALLO'}`);
  }

  // Sin muestras no hay nada que comparar: avisar en vez de petar leyendo .mm de
  // undefined, que oculta la causa real (no se pudo localizar la escena).
  if (rows.length === 0) {
    console.log('\nninguna muestra medible: no se localizo el asfalto o el vehiculo');
    failed = true;
  } else {
    const worst = rows.reduce((a, b) => (Math.abs(b.mm) > Math.abs(a.mm) ? b : a), rows[0]);
    console.log(`\npeor caso: ${worst.mm} mm (límite ±${MAX_GAP * 1000} mm)`);
  }
  console.log(failed ? 'RESULTADO: FALLO' : 'RESULTADO: OK');
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
