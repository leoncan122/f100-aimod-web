/** Capturas del modo Desierto: varios instantes y cámaras. */
import { DEFAULT_BASE, launch, openMode } from './lib/viewer.mjs';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const OUT = 'test-results/desert';
mkdirSync(OUT, { recursive: true });

const browser = await launch(['--window-size=1280,720']);

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 300)));

  // Directo a la vista por hash: evita cargar la vista por defecto y pulsar la
  // pestaña (una carga de escena menos, ~12 s bajo SwiftShader).
  await openMode(page, BASE, 'desert');
  await new Promise((r) => setTimeout(r, 3000));

  await page.click('#play'); // pausa para capturas limpias

  const seekTo = async (sec) => {
    await page.evaluate((v) => {
      const s = document.getElementById('seek');
      s.value = String(v / 15);
      s.dispatchEvent(new Event('input'));
    }, sec);
    await new Promise((r) => setTimeout(r, 3500));
  };

  // persecución en varios instantes del bucle de 15 s
  for (const t of [2, 7, 13]) {
    await seekTo(t);
    await page.screenshot({ path: `${OUT}/persecucion-${t}s.png` });
    console.log('persecucion', t, await page.$eval('#time', (e) => e.textContent));
  }

  // resto de cámaras
  for (const label of ['lateral', 'capó', 'libre']) {
    await page.click('#cam');
    await seekTo(6);
    const name = label === 'capó' ? 'capo' : label;
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(name, await page.$eval('#cam', (e) => e.textContent));
  }

  console.log('stats:', await page.$eval('#stats', (e) => e.textContent));
} finally {
  await browser.close();
}
