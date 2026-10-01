/**
 * Utilidades compartidas por los scripts de puppeteer.
 *
 * Centraliza el arranque de Chrome y la apertura de una vista, que estaban
 * duplicados en una decena de scripts.
 */
import puppeteer from 'puppeteer-core';

export const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/** Puerto por defecto del dev server en los scripts. */
export const DEFAULT_BASE = 'http://localhost:5180/';

/**
 * Lanza Chrome con GL por software, para que funcione sin GPU (y en CI).
 *
 * `protocolTimeout` alto: SwiftShader rasteriza en CPU y bloquea el hilo del
 * renderer en escenas con mucho fill-rate.
 */
export function launch(extraArgs = []) {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    protocolTimeout: 600_000,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      ...extraArgs,
    ],
  });
}

/** Espera a que el overlay de carga se oculte (una vista acabó de montar). */
export function waitLoaded(page, timeout = 240_000) {
  return page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden'),
    { timeout, polling: 300 },
  );
}

/**
 * Abre una vista directamente por su hash y espera a que esté montada.
 *
 * Navegar a `#desert` evita cargar primero la vista por defecto para luego pulsar
 * la pestaña: ahorra una carga completa de escena (~12 s bajo SwiftShader) y
 * elimina el clic, que es la parte frágil — si se lanza antes de que la app monte
 * sus handlers se pierde en silencio y el script acaba midiendo la vista
 * equivocada mientras informa de éxito.
 *
 * Devuelve los ms que tardó en cargar.
 */
export async function openMode(page, base, mode, { waitMs = 0 } = {}) {
  const url = new URL(base);
  url.hash = mode;
  const start = Date.now();
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await waitLoaded(page);
  // Confirmar que de verdad se abrió la vista pedida y no la de por defecto: un
  // hash mal escrito cae al modo por defecto sin avisar.
  await page.waitForFunction(
    (m) => document.querySelector(`.tab[data-mode="${m}"]`)?.classList.contains('on'),
    { timeout: 240_000, polling: 300 },
    mode,
  );
  const loadMs = Date.now() - start;
  if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
  return loadMs;
}

/**
 * Espera N frames de requestAnimationFrame.
 *
 * Con SwiftShader el lienzo avanza a pocos fps, así que esperar por reloj no
 * garantiza que el bucle de render haya corrido lo suficiente para que converja
 * un valor suavizado. El tope evita colgarse si rAF está estrangulado (pestaña
 * en segundo plano).
 */
export function waitFrames(page, n, bailMs = 15_000) {
  return page.evaluate(
    ([k, bail]) =>
      new Promise((res) => {
        let i = 0;
        const t = setTimeout(() => res(i), bail);
        const tick = () => {
          if (++i >= k) {
            clearTimeout(t);
            return res(i);
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    [n, bailMs],
  );
}

/** Mueve la barra de scrub a `sec` de un total de `total` segundos. */
export async function seekTo(page, sec, total, settleMs = 3000) {
  await page.evaluate(
    ([v, d]) => {
      const s = document.getElementById('seek');
      s.value = String(v / d);
      s.dispatchEvent(new Event('input'));
    },
    [sec, total],
  );
  if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
}
