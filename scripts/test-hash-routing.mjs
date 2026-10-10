/**
 * Verifica los enlaces compartibles por hash (#cinematic-three / #orbit / #desert).
 *
 * Cubre: carga directa por URL, hash desconocido, normalizacion al arrancar sin
 * hash, escritura del hash al pulsar una pestaña, y el boton atras/adelante.
 */
import puppeteer from 'puppeteer-core';
import { DEFAULT_BASE } from './lib/viewer.mjs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
// Debe coincidir con DEFAULT_MODE en src/types.ts.
const DEFAULT_MODE = 'cinematic-three';

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  protocolTimeout: 600_000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

let failures = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${label.padEnd(44)} ${got}${ok ? '' : `  (esperado ${want})`}`);
};

/** Espera a que una vista termine de montar y devuelve la pestaña activa. */
const activeTab = async (page) => {
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden')
       && document.querySelector('.tab.on'),
    { timeout: 240_000, polling: 300 },
  );
  return page.evaluate(() => document.querySelector('.tab.on')?.dataset.mode);
};
const hash = (page) => page.evaluate(() => location.hash);

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 600 });
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 300)));

  // 1. carga directa por hash: es el caso del enlace compartido
  for (const id of ['desert', 'orbit', DEFAULT_MODE]) {
    await page.goto(`${BASE}#${id}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    check(`carga directa #${id}`, await activeTab(page), id);
  }

  // 2. hash desconocido -> modo por defecto, y URL normalizada.
  // Importante: venimos del modo por defecto, asi que cambiar solo el hash es una
  // navegacion del MISMO documento y la pagina no se recarga. Es el caso de pegar
  // un hash a mano en una pestaña ya abierta, y no lo cubre el codigo de arranque.
  await page.goto(`${BASE}#asdf`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  check('hash invalido #asdf -> pestaña', await activeTab(page), DEFAULT_MODE);
  check('hash invalido #asdf -> URL normalizada', await hash(page), `#${DEFAULT_MODE}`);

  // 3. sin hash -> por defecto, con la URL normalizada para poder compartirla
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  check('sin hash -> pestaña', await activeTab(page), DEFAULT_MODE);
  check('sin hash -> URL normalizada', await hash(page), `#${DEFAULT_MODE}`);

  // 4. pegar un hash valido en la pestaña abierta (sin recarga) cambia de vista
  await page.evaluate(() => { location.hash = '#desert'; });
  check('hash pegado #desert -> pestaña', await activeTab(page), 'desert');
  await page.evaluate((m) => { location.hash = `#${m}`; }, DEFAULT_MODE);
  check(`hash pegado #${DEFAULT_MODE} -> pestaña`, await activeTab(page), DEFAULT_MODE);

  // 5. pulsar una pestaña escribe el hash
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await activeTab(page);
  await page.click('.tab[data-mode="desert"]');
  check('click en Desierto -> pestaña', await activeTab(page), 'desert');
  check('click en Desierto -> hash', await hash(page), '#desert');

  await page.click('.tab[data-mode="orbit"]');
  check('click en Modelo -> hash', await hash(page), '#orbit');
  await activeTab(page);

  // 6. atras: debe recorrer los modos visitados (pushState)
  await page.goBack();
  check('atras -> hash', await hash(page), '#desert');
  check('atras -> pestaña', await activeTab(page), 'desert');

  await page.goBack();
  check('atras x2 -> hash', await hash(page), `#${DEFAULT_MODE}`);
  check('atras x2 -> pestaña', await activeTab(page), DEFAULT_MODE);

  // 7. adelante
  await page.goForward();
  check('adelante -> hash', await hash(page), '#desert');
  check('adelante -> pestaña', await activeTab(page), 'desert');

  console.log(failures ? `\n${failures} comprobacion(es) con fallo` : '\nTodas las comprobaciones OK');
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
