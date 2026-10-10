/** Captura del tablero publicado (build), para revisar las pestañas visibles. */
import { launch } from './lib/viewer.mjs';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5190/';
const OUT = 'test-results/tablero';
mkdirSync(OUT, { recursive: true });

const browser = await launch();
try {
  for (const vp of [
    { name: 'desktop', width: 1280, height: 720, dsf: 1, mobile: false },
    { name: 'phone', width: 390, height: 844, dsf: 2, mobile: true },
  ]) {
    const page = await browser.newPage();
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.dsf, isMobile: vp.mobile, hasTouch: vp.mobile });
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('hidden'), { timeout: 240_000, polling: 300 });
    await new Promise((r) => setTimeout(r, 4000));
    console.log(vp.name, await page.evaluate(() => [...document.querySelectorAll('.tab')].map((t) => t.textContent.trim()).join(' | ')));
    await page.screenshot({ path: `${OUT}/${vp.name}.png` });
    await page.close();
  }
} finally {
  await browser.close();
}
