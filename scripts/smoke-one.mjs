/**
 * Smoke test de UN solo modo (evita timeouts: SwiftShader tarda ~25 s por modo).
 * Uso: node scripts/smoke-one.mjs <modo> [baseUrl]
 */
import { DEFAULT_BASE, launch, openMode } from './lib/viewer.mjs';
import { mkdirSync } from 'node:fs';

const MODE = process.argv[2] ?? 'desert';
const BASE = process.argv[3] ?? DEFAULT_BASE;
const OUT = 'test-results';
mkdirSync(OUT, { recursive: true });

const browser = await launch(['--window-size=1100,620']);

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

  // Directo a la vista por hash: evita cargar la vista por defecto y pulsar la
  // pestaña, asi que loadMs mide solo la escena pedida.
  const loadMs = await openMode(page, BASE, MODE);

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
