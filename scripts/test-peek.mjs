/**
 * Verifica el modulo de peek de camara en los modos que lo usan.
 *
 * Para cada modo y cada camara: comprueba que arrastrando el puntero la camara
 * se desvia y que al soltar vuelve a la pose de partida. En el modo Desierto
 * mide ademas el brillo de la zaga de la camioneta (la zona que ilumina la luz
 * ambiente calida).
 *
 * El retorno se mide en FRAMES, no en milisegundos: con swiftshader el lienzo
 * avanza a pocos fps y una espera por reloj no garantiza que el bucle de render
 * haya corrido lo suficiente para que converja el suavizado.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5182/';
// Filtro opcional por etiqueta: permite correr un solo caso (swiftshader es lento).
const ONLY = process.argv[3] ?? null;
const OUT = 'test-results/peek';
mkdirSync(OUT, { recursive: true });

// Cada caso: modo, cuantas veces pulsar #cam antes de probar, y etiqueta.
const CASES = [
  { mode: 'desert', camClicks: 0, label: 'desierto-persecucion', seek: 6, total: 15 },
  { mode: 'cinematic', camClicks: 0, label: 'cinematica-track', seek: 20, total: 71 },
  { mode: 'cinematic', camClicks: 1, label: 'cinematica-trasera', seek: 20, total: 71 },
];

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  protocolTimeout: 600_000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const camPose = (page) =>
  page.evaluate(() => {
    const c = window.__camera;
    return c ? { pos: c.position.toArray() } : null;
  });

const waitFrames = (page, n) =>
  page.evaluate(
    (k) =>
      new Promise((res) => {
        let i = 0;
        const bail = setTimeout(() => res(i), 15_000);
        const tick = () => {
          if (++i >= k) {
            clearTimeout(bail);
            return res(i);
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    n,
  );

const dist = (a, b) => Math.hypot(...a.pos.map((v, i) => v - b.pos[i]));
let failures = 0;

try {
  for (const c of CASES.filter((c) => !ONLY || c.label.includes(ONLY))) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 300)));

    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction(
      () => document.getElementById('loading')?.classList.contains('hidden'),
      { timeout: 240_000, polling: 300 },
    );
    if (c.mode !== 'cinematic') {
      await page.click(`.tab[data-mode="${c.mode}"]`);
      await page.waitForFunction(
        (m) => document.getElementById('loading')?.classList.contains('hidden')
            && document.querySelector(`.tab[data-mode="${m}"]`)?.classList.contains('on'),
        { timeout: 240_000, polling: 300 },
        c.mode,
      );
    }
    await new Promise((r) => setTimeout(r, 2500));
    await page.click('#play'); // pausa
    for (let i = 0; i < c.camClicks; i++) await page.click('#cam');

    await page.evaluate(([v, d]) => {
      const s = document.getElementById('seek');
      s.value = String(v / d);
      s.dispatchEvent(new Event('input'));
    }, [c.seek, c.total]);

    // dejar converger la camara del modo ANTES de tomar la referencia
    await waitFrames(page, 45);
    await page.screenshot({ path: `${OUT}/${c.label}-1-reposo.png` });
    const before = await camPose(page);

    // arrastre
    await page.mouse.move(640, 400);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(640 + i * 22, 400 - i * 6);
      await new Promise((r) => setTimeout(r, 30));
    }
    await waitFrames(page, 12);
    await page.screenshot({ path: `${OUT}/${c.label}-2-arrastrando.png` });
    const during = await camPose(page);

    // soltar -> debe volver
    await page.mouse.up();
    await waitFrames(page, 30);
    await page.screenshot({ path: `${OUT}/${c.label}-3-soltado.png` });
    const after = await camPose(page);

    const desvio = dist(before, during);
    const err = dist(before, after);
    const ok = desvio > 1 && err < 0.25;
    if (!ok) failures++;
    console.log(
      `${ok ? 'OK  ' : 'FALLA'} ${c.label.padEnd(22)} desvio ${desvio.toFixed(2)} m · error tras soltar ${err.toFixed(4)} m`,
    );
    await page.close();
  }

  // brillo de la zaga en el desierto
  if (!ONLY || ONLY.includes('desierto')) {
  const sharp = (await import('sharp')).default;
  // recorte ajustado a la zaga de la camioneta en el encuadre de persecucion
  const region = { left: 560, top: 360, width: 160, height: 150 };
  const { data } = await sharp(`${OUT}/desierto-persecucion-1-reposo.png`)
    .extract(region).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < data.length; i += 3) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
  console.log('brillo zaga desierto (0-255):', (sum / (data.length / 3)).toFixed(1));
  }

  console.log(failures ? `\n${failures} caso(s) con fallo` : '\nTodos los casos OK');
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
