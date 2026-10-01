/** Capturas del modo Desierto en escritorio y móvil (verificación visual). */
import { DEFAULT_BASE, launch, openMode } from './lib/viewer.mjs';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const OUT = 'test-results/desert';
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 720, dsf: 1 },
  { name: 'mobile', width: 390, height: 844, dsf: 2 },
];

const browser = await launch();

try {
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage();
    await page.setViewport({
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.dsf,
      isMobile: vp.name === 'mobile',
      hasTouch: vp.name === 'mobile',
    });
    page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 300)));

    // Directo a la vista por hash: una carga de escena menos por viewport.
    await openMode(page, BASE, 'desert');
    await new Promise((r) => setTimeout(r, 4000));
    await page.click('#play'); // pausa

    const seekTo = async (sec) => {
      await page.evaluate((v) => {
        const s = document.getElementById('seek');
        s.value = String(v / 15);
        s.dispatchEvent(new Event('input'));
      }, sec);
      await new Promise((r) => setTimeout(r, 3500));
    };

    for (const t of [3, 9]) {
      await seekTo(t);
      await page.screenshot({ path: `${OUT}/${vp.name}-persecucion-${t}s.png` });
    }

    // cámara lateral: se ven bien los bordes de la carretera
    await page.click('#cam');
    await seekTo(6);
    await page.screenshot({ path: `${OUT}/${vp.name}-lateral.png` });

    console.log(vp.name, 'ok');
    await page.close();
  }
} finally {
  await browser.close();
}
