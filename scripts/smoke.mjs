/**
 * Smoke test del visor: carga cada modo en Chrome real (WebGL vía ANGLE),
 * espera a que el modelo esté listo y reporta fps, draw calls, triángulos y
 * cualquier error de consola. Captura una screenshot por modo.
 *
 * Uso:  node scripts/smoke.mjs [baseUrl]
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5180/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'test-results';

mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--window-size=1280,800',
    '--no-sandbox',
  ],
});

const results = [];

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 300)}`));
  const failed = [];
  page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));

  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 120_000 });

  for (const mode of ['cinematic', 'orbit', 'desert']) {
    const before = errors.length;
    const start = Date.now();

    if (mode !== 'cinematic') {
      await page.click(`.tab[data-mode="${mode}"]`);
    }

    // el overlay de carga se oculta cuando el modo terminó de montar
    await page.waitForFunction(
      () => document.getElementById('loading')?.classList.contains('hidden'),
      { timeout: 180_000, polling: 250 },
    );
    const loadMs = Date.now() - start;

    // dejar correr la animación para medir fps estable
    await new Promise((r) => setTimeout(r, 6000));

    const stats = await page.$eval('#stats', (el) => el.textContent?.trim() ?? '');
    const hud = await page.$eval('#hud', (el) => el.innerText.replace(/\n/g, ' | '));
    const cam = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      return c ? { w: c.width, h: c.height } : null;
    });

    // regresión: en modo Modelo la camioneta no debe desplazarse (bbox estable,
    // ~2.1 x 2.1 x 5.0 m). Si un clip del rig raíz se cuela, el bbox explota.
    let bboxCheck = null;
    if (mode === 'orbit') {
      const dims = (hud.match(/([\d.]+) × ([\d.]+) × ([\d.]+) m/) ?? []).slice(1).map(Number);
      const maxDim = Math.max(...dims);
      bboxCheck = { dims, maxDim, pass: maxDim > 0 && maxDim < 8 };
    }

    // regresión de performance en Desierto: el escenario es procedural e
    // instanciado, así que las draw calls deben mantenerse acotadas.
    let budget = null;
    if (mode === 'desert') {
      const calls = Number((stats.match(/(\d+) draw calls/) ?? [])[1] ?? -1);
      const loop = await page.$eval('#time', (e) => e.textContent ?? '');
      budget = {
        drawCalls: calls,
        loopLabel: loop,
        pass: calls > 0 && calls < 420 && /\/ 15 s/.test(loop),
      };
    }

    const shot = `${OUT}/${mode}.png`;
    await page.screenshot({ path: shot });

    results.push({
      mode,
      ok: errors.length === before && (bboxCheck?.pass ?? true) && (budget?.pass ?? true),
      loadMs,
      stats,
      hud,
      canvas: cam,
      bboxCheck,
      budget,
      newErrors: errors.slice(before),
      screenshot: shot,
    });
  }

  console.log(JSON.stringify({ totalMs: Date.now() - t0, failedRequests: failed, results }, null, 2));
} finally {
  await browser.close();
}
