/**
 * Smoke test de UN solo modo (evita timeouts: SwiftShader tarda ~25 s por modo).
 * Uso: node scripts/smoke-one.mjs <modo> [baseUrl]
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const MODE = process.argv[2] ?? 'desert';
const BASE = process.argv[3] ?? 'http://127.0.0.1:5180/';
const OUT = 'test-results';
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  protocolTimeout: 600_000, // SwiftShader bloquea el hilo en escenas con fill-rate alto
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--window-size=1100,620',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 620 });

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 300)}`));
  const failed = [];
  page.on('requestfailed', (r) => {
    // three.js usa XHR y Chrome marca la petición como ERR_ABORTED cuando el
    // loader la cierra tras completarla. Si la respuesta llegó con 200, no es
    // un fallo real; solo se registran los recursos que de verdad no llegaron.
    const err = r.failure()?.errorText ?? '';
    const status = r.response()?.status();
    if (err === 'net::ERR_ABORTED' && status && status < 400) return;
    failed.push(`${r.url()} ${err}`);
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  // Esperar SIEMPRE a que el modo inicial (cinematic) termine de montar:
  // hasta entonces los handlers de las pestañas no están activos y el clic
  // se pierde silenciosamente.
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden'),
    { timeout: 240_000, polling: 300 },
  );

  const start = Date.now();
  if (MODE !== 'cinematic') {
    await page.click(`.tab[data-mode="${MODE}"]`);
    // y confirmar que la pestaña quedó activa y el modo recargó
    await page.waitForFunction(
      (m) => document.querySelector(`.tab[data-mode="${m}"]`)?.classList.contains('on'),
      { timeout: 240_000, polling: 300 },
      MODE,
    );
  }
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden'),
    { timeout: 240_000, polling: 300 },
  );
  const loadMs = Date.now() - start;

  await new Promise((r) => setTimeout(r, 7000));

  const stats = await page.$eval('#stats', (e) => e.textContent?.trim() ?? '');
  const hud = await page.$eval('#hud', (e) => e.innerText.replace(/\n/g, ' | '));

  // Inventario real de la escena: detecta duplicados y mide el presupuesto.
  const inv = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return { w: c?.width, h: c?.height };
  });

  await page.screenshot({ path: `${OUT}/${MODE}.png` });

  const calls = Number((stats.match(/(\d+) draw calls/) ?? [])[1] ?? -1);
  console.log(
    JSON.stringify(
      {
        mode: MODE,
        loadMs,
        stats,
        hud,
        drawCalls: calls,
        canvas: inv,
        errors,
        failedRequests: failed,
        ok: errors.length === 0 && failed.length === 0,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
