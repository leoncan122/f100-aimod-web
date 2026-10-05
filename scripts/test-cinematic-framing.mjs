/**
 * Regresion del encuadre del track cinematico segun la relacion de aspecto.
 *
 * El track trae el FOV horizontal por frame, animado para 16:9. En apaisado debe
 * reproducirse EXACTAMENTE como se animo; solo en encuadres mas estrechos que el
 * de autoria se aplica la mezcla que acerca el sujeto.
 */
import { DEFAULT_BASE, launch, openMode, seekTo, waitFrames } from './lib/viewer.mjs';
import { readFileSync } from 'node:fs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const AUTHORED = 16 / 9;
const FIT_WEIGHT = 0.4; // debe coincidir con src/modes/cinematic.ts
const AT = 38;
const TOTAL = 70.83;

const track = JSON.parse(readFileSync('public/models/camara.json', 'utf8'));
const hfovAt = (sec) => track.frames[Math.min(track.frames.length - 1, Math.round(sec * track.fps))][7];

const deg = (r) => (r * 180) / Math.PI;
const vKeepH = (h, a) => 2 * Math.atan(Math.tan(h / 2) / a);

const CASES = [
  { label: 'escritorio 1280x720', w: 1280, h: 720, dsf: 1 },
  { label: 'movil 390x844', w: 390, h: 844, dsf: 2 },
];

let failures = 0;
const check = (label, got, want, tol = 0.15) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(
    `${ok ? 'OK   ' : 'FALLA'} ${label.padEnd(42)} ${got.toFixed(2)}°${ok ? '' : ` (esperado ${want.toFixed(2)}°)`}`,
  );
};

const browser = await launch();
try {
  for (const c of CASES) {
    const page = await browser.newPage();
    await page.setViewport({ width: c.w, height: c.h, deviceScaleFactor: c.dsf });
    await openMode(page, BASE, 'cinematic');
    await new Promise((r) => setTimeout(r, 2500));
    await page.click('#play');
    await seekTo(page, AT, TOTAL, 1500);
    await waitFrames(page, 6);

    const { fov, aspect } = await page.evaluate(() => ({
      fov: window.__camera.fov,
      aspect: window.__camera.aspect,
    }));

    const hfov = hfovAt(AT);
    let want;
    if (aspect >= AUTHORED) {
      // apaisado: el track se respeta tal cual
      want = deg(vKeepH(hfov, aspect));
    } else {
      const a = vKeepH(hfov, aspect);
      const b = vKeepH(hfov, AUTHORED);
      want = deg(Math.exp((1 - FIT_WEIGHT) * Math.log(a) + FIT_WEIGHT * Math.log(b)));
    }
    check(`${c.label} vfov`, fov, want);

    // y el encuadre movil debe quedar claramente mas cerrado que el anterior
    if (aspect < AUTHORED) {
      const antes = deg(vKeepH(hfov, aspect));
      const mejora = antes / fov;
      const ok = mejora > 1.3;
      if (!ok) failures++;
      console.log(
        `${ok ? 'OK   ' : 'FALLA'} ${'movil mas cerrado que antes'.padEnd(42)} ${antes.toFixed(1)}° -> ${fov.toFixed(1)}° (x${mejora.toFixed(2)})`,
      );
    }
    await page.close();
  }
  console.log(failures ? `\n${failures} fallo(s)` : '\nTodas las comprobaciones OK');
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
