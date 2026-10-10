/**
 * Capturas de la interfaz (no de la escena) en los modos con interacción.
 *
 * Pausa la película para que el conductor se baje y se muestren todos los
 * controles a la vez: pestañas, HUD, panel del personaje, panel de Aitziber,
 * joystick y stats. Así se ve si algo se solapa o se sale de la pantalla.
 */
import { DEFAULT_BASE, launch, openMode } from './lib/viewer.mjs';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const MODES = (process.argv[3] ?? 'cinematic-three,cinematic').split(',');
const OUT = 'test-results/ui';
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 720, dsf: 1, mobile: false },
  { name: 'laptop', width: 1024, height: 600, dsf: 1, mobile: false },
  { name: 'tablet', width: 768, height: 1024, dsf: 1, mobile: true },
  { name: 'phone', width: 390, height: 844, dsf: 2, mobile: true },
  { name: 'phone-small', width: 320, height: 568, dsf: 2, mobile: true },
  { name: 'phone-land', width: 844, height: 390, dsf: 2, mobile: true },
];

const browser = await launch();

try {
  for (const mode of MODES) {
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage();
      await page.setViewport({
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: vp.dsf,
        isMobile: vp.mobile,
        hasTouch: vp.mobile,
      });
      page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 200)));

      await openMode(page, BASE, mode, { waitMs: 3000 });
      await page.screenshot({ path: `${OUT}/${mode}-${vp.name}-conduciendo.png` });

      // Pausar: el conductor se baja y aparecen las acciones a pie.
      await page.click('#play').catch(() => {});
      await new Promise((r) => setTimeout(r, 9000));
      await page.screenshot({ path: `${OUT}/${mode}-${vp.name}-a-pie.png` });

      // Medidas: ¿se sale algo de la pantalla o se solapa?
      const boxes = await page.evaluate(() => {
        const ids = ['tabs', 'stats', 'hud', 'charPanel', 'aitziPanel', 'charStick'];
        const out = {};
        for (const id of ids) {
          const el = document.getElementById(id);
          if (!el || el.hidden || getComputedStyle(el).display === 'none') continue;
          const r = el.getBoundingClientRect();
          out[id] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        }
        return { vw: innerWidth, vh: innerHeight, out };
      });
      const names = Object.keys(boxes.out);
      const over = [];
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const a = boxes.out[names[i]], b = boxes.out[names[j]];
          const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          if (ox > 2 && oy > 2) over.push(`${names[i]}×${names[j]} (${ox}×${oy}px)`);
        }
      }
      const off = names.filter((n) => {
        const r = boxes.out[n];
        return r.x < 0 || r.y < 0 || r.x + r.w > boxes.vw + 1 || r.y + r.h > boxes.vh + 1;
      });
      console.log(`${mode} ${vp.name} ${boxes.vw}x${boxes.vh}`);
      for (const n of names) {
        const r = boxes.out[n];
        console.log(`   ${n.padEnd(11)} x${r.x} y${r.y} ${r.w}x${r.h}`);
      }
      if (over.length) console.log('   SOLAPA:', over.join(', '));
      if (off.length) console.log('   FUERA :', off.join(', '));

      await page.close();
    }
  }
} finally {
  await browser.close();
}
