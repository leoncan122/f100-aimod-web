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
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5180/';
const MAX_GAP = 0.005; // 5 mm
const SAMPLES = [0, 2, 4, 6, 8, 10, 12, 14.5];

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  protocolTimeout: 600_000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

let failed = false;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 450 });
  page.on('pageerror', (e) => {
    console.log('[PAGEERROR]', e.message.slice(0, 300));
    failed = true;
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden'),
    { timeout: 240_000, polling: 300 },
  );
  await page.click('.tab[data-mode="desert"]');
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden')
       && document.querySelector('.tab[data-mode="desert"]')?.classList.contains('on'),
    { timeout: 240_000, polling: 300 },
  );
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

      let roadY = null;
      scene.traverse((o) => {
        if (o.isMesh && o.geometry?.type === 'PlaneGeometry' && o.material?.color) {
          if (o.material.color.getHexString() === '101018') roadY = o.position.y;
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

  const worst = rows.reduce((a, b) => (Math.abs(b.mm) > Math.abs(a.mm) ? b : a), rows[0]);
  console.log(`\npeor caso: ${worst.mm} mm (límite ±${MAX_GAP * 1000} mm)`);
  console.log(failed ? 'RESULTADO: FALLO' : 'RESULTADO: OK');
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
