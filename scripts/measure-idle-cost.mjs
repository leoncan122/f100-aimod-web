/**
 * Mide el consumo de la pagina en reposo: pestaña visible vs. pestaña en segundo
 * plano (otra pestaña al frente, que es el caso real que preguntaba el usuario).
 *
 * Reporta, en cada estado:
 *  - frames de requestAnimationFrame por segundo (si el bucle sigue corriendo)
 *  - tiempo de CPU consumido por la pagina, via CDP Performance.getMetrics
 *  - heap de JS en uso (requiere --enable-precise-memory-info)
 *  - recursos vivos del renderer de three.js (geometrias y texturas)
 */
import { DEFAULT_BASE, launch, openMode } from './lib/viewer.mjs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const MODE = process.argv[3] ?? 'desert';
const WINDOW_S = 20; // duracion de cada ventana de medicion

const browser = await launch(['--enable-precise-memory-info']);

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 300)));

  const cdp = await page.target().createCDPSession();
  await cdp.send('Performance.enable');

  // Directo a la vista por hash: una carga de escena menos.
  await openMode(page, BASE, MODE);
  await new Promise((r) => setTimeout(r, 5000)); // dejar que se estabilice

  // Contador de frames instalado en la pagina: es la prueba directa de si el
  // bucle de render sigue vivo cuando la pestaña no se ve.
  await page.evaluate(() => {
    window.__frames = 0;
    const tick = () => {
      window.__frames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const cpuMs = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const get = (n) => metrics.find((m) => m.name === n)?.value ?? 0;
    // TaskDuration es acumulado, en segundos
    return get('TaskDuration') * 1000;
  };

  const snapshot = () =>
    page.evaluate(() => ({
      frames: window.__frames,
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      visibility: document.visibilityState,
    }));

  /** Mide una ventana de WINDOW_S segundos y devuelve las tasas. */
  const measure = async (label) => {
    const c0 = await cpuMs();
    const s0 = await snapshot();
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, WINDOW_S * 1000));
    const c1 = await cpuMs();
    const s1 = await snapshot();
    const secs = (Date.now() - t0) / 1000;
    console.log(
      `${label.padEnd(26)} visibilidad=${s1.visibility.padEnd(7)} ` +
        `fps=${((s1.frames - s0.frames) / secs).toFixed(2).padStart(6)} ` +
        `cpu=${(((c1 - c0) / (secs * 1000)) * 100).toFixed(1).padStart(5)}% ` +
        `heap=${String(s1.heapMB).padStart(6)} MB`,
    );
    return { fps: (s1.frames - s0.frames) / secs, cpu: (c1 - c0) / (secs * 1000) };
  };

  // Recursos vivos de la escena (no se liberan al ocultar la pestaña). Se cuentan
  // recorriendo window.__scene, que la app expone solo en dev.
  const gpu = await page.evaluate(() => {
    const geos = new Set();
    const texs = new Set();
    let meshes = 0;
    window.__scene?.traverse((o) => {
      if (o.geometry) {
        geos.add(o.geometry.uuid);
        meshes++;
      }
      for (const m of [o.material].flat().filter(Boolean)) {
        for (const v of Object.values(m)) {
          if (v && v.isTexture) texs.add(v.uuid);
        }
      }
    });
    return { meshes, geometrias: geos.size, texturas: texs.size };
  });

  console.log(`modo: ${MODE} · ventanas de ${WINDOW_S} s\n`);
  await measure('1. pestaña VISIBLE');

  // ---- pasar a segundo plano: otra pestaña al frente
  const other = await browser.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await new Promise((r) => setTimeout(r, 2000));
  await measure('2. pestaña EN SEGUNDO PLANO');

  // ---- volver al frente
  await page.bringToFront();
  await new Promise((r) => setTimeout(r, 2000));
  await measure('3. de vuelta al frente');

  console.log('\nrecursos vivos del renderer:', JSON.stringify(gpu));
  console.log('(geometrias/texturas siguen reservadas mientras la pestaña exista)');
} finally {
  await browser.close();
}
