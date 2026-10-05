/**
 * Comparativa del ajuste de encuadre (FIT_WEIGHT) en movil, modo Cinematica.
 *
 * Fuerza distintos pesos en vivo sobre la escena cargada y captura el mismo
 * instante con cada uno, para poder elegir el valor mirando las imagenes en vez
 * de a ciegas.
 *
 * 0 = conserva el FOV horizontal de autoria (gran angular, todo lejos)
 * 1 = conserva el vertical (muy cerrado, sin paisaje)
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { DEFAULT_BASE, launch, openMode, waitFrames, seekTo } from './lib/viewer.mjs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const OUT = 'test-results/fit-weight';
mkdirSync(OUT, { recursive: true });

const WEIGHTS = [0, 0.4, 0.55, 0.7];
const ASPECT = 390 / 844;
const SHOTS = [12, 38]; // instantes del track con paisaje y con vehiculo cerca
const TOTAL = 70.83;

// hfov de autoria por frame, leido del mismo track que usa la app
const track = JSON.parse(readFileSync('public/models/camara.json', 'utf8'));
const hfovAt = (sec) => {
  const i = Math.min(track.frames.length - 1, Math.round(sec * track.fps));
  return track.frames[i][7];
};

const browser = await launch();

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 300)));

  await openMode(page, BASE, 'cinematic');
  await new Promise((r) => setTimeout(r, 3000));
  await page.click('#play'); // pausa

  for (const t of SHOTS) {
    await seekTo(page, t, TOTAL, 2500);
    for (const w of WEIGHTS) {
      // Se recalcula el fov con el peso pedido a partir del hfov de autoria, que
      // se reconstruye del fov actual invirtiendo el ajuste vigente.
      // applyCam() recalcula el fov en cada frame, asi que fijar camera.fov desde
      // fuera no tiene efecto: se cambia el PESO que usa el calculo, via el
      // override de dev.
      await page.evaluate((weight) => {
        window.__fitWeight = weight;
      }, w);
      const hfov = hfovAt(t);
      const vKeepH = 2 * Math.atan(Math.tan(hfov / 2) / ASPECT);
      const vKeepV = 2 * Math.atan(Math.tan(hfov / 2) / (16 / 9));
      const v = Math.exp((1 - w) * Math.log(vKeepH) + w * Math.log(vKeepV));
      const info = {
        vfov: +((v * 180) / Math.PI).toFixed(1),
        hfovEfectivo: +((2 * Math.atan(Math.tan(v / 2) * ASPECT) * 180) / Math.PI).toFixed(1),
      };
      await waitFrames(page, 4);
      await page.screenshot({ path: `${OUT}/t${t}s-w${String(w).replace('.', '_')}.png` });
      console.log(
        `t=${String(t).padStart(2)}s w=${String(w).padEnd(4)} ` +
          `hfov autoria ${(hfovAt(t) * 180 / Math.PI).toFixed(1).padStart(5)}° -> ` +
          `vfov ${String(info.vfov).padStart(5)}° · hfov ${String(info.hfovEfectivo).padStart(5)}°`,
      );
    }
  }
} finally {
  await browser.close();
}
