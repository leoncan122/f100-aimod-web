/**
 * Comprueba qué vistas publica el tablero y qué hace un hash de una vista oculta.
 *
 * Se corre contra el build (`vite preview`), no contra el dev server: las vistas
 * marcadas `hidden` en MODES solo desaparecen en producción, así que medirlo en
 * dev daría un falso negativo.
 *
 * Uso: node scripts/test-visible-modes.mjs [baseUrl] [modo-por-defecto]
 */
import { launch } from './lib/viewer.mjs';

const BASE = process.argv[2] ?? 'http://localhost:5190/';
const DEFAULT_MODE = process.argv[3] ?? 'cinematic-three';
// Lo que debe salir en las pestañas del sitio publicado, en orden.
const EXPECTED = ['cinematic-three', 'orbit', 'desert'];
// Vistas que siguen en el código pero no se publican.
const HIDDEN = ['cinematic'];

let failures = 0;
const check = (label, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${label.padEnd(46)} ${got}${ok ? '' : `  (esperado ${want})`}`);
};

const settled = async (page) => {
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden') && document.querySelector('.tab.on'),
    { timeout: 240_000, polling: 300 },
  );
  return page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tab')].map((t) => t.dataset.mode),
    labels: [...document.querySelectorAll('.tab')].map((t) => t.textContent.trim()),
    active: document.querySelector('.tab.on')?.dataset.mode,
    hash: location.hash,
  }));
};

const browser = await launch();

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 700 });
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 200)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const s = await settled(page);
  console.log('pestañas publicadas:', s.labels.join(' · '));
  check('pestañas del tablero', s.tabs.join(','), EXPECTED.join(','));
  check('vista por defecto', s.active, DEFAULT_MODE);

  // Un enlace viejo a una vista oculta no debe romper: cae a la vista por
  // defecto y normaliza la URL, como cualquier hash desconocido.
  for (const h of HIDDEN) {
    await page.goto(`${BASE}#${h}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    const r = await settled(page);
    check(`#${h} oculto -> pestaña`, r.active, DEFAULT_MODE);
    check(`#${h} oculto -> URL normalizada`, r.hash, `#${DEFAULT_MODE}`);
    check(`#${h} oculto -> sin pestaña propia`, r.tabs.includes(h), 'false');
  }

  console.log(failures ? `\n${failures} comprobacion(es) con fallo` : '\nTodas las comprobaciones OK');
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
