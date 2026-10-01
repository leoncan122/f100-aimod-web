/**
 * Verifica en el modo Desierto la iluminación de la zaga y el peek de cámara.
 *
 * Mide el brillo medio de la mitad inferior del encuadre (donde está la parte
 * trasera de la camioneta) y comprueba que al arrastrar el puntero la cámara se
 * desvía y que al soltar vuelve exactamente a la pose de partida.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5181/';
const OUT = 'test-results/desert-peek';
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  protocolTimeout: 600_000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const camPose = (page) =>
  page.evaluate(() => {
    const c = window.__camera;
    return c ? { pos: c.position.toArray(), rot: c.rotation.toArray().slice(0, 3) } : null;
  });

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 300)));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden'),
    { timeout: 240_000, polling: 300 },
  );
  await page.click('.tab[data-mode="desert"]');
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden')
       && document.querySelector('.tab[data-mode="desert"]')?.classList.contains('on'),
    { timeout: 240_000, polling: 300 },
  );
  await new Promise((r) => setTimeout(r, 2500));
  await page.click('#play'); // pausa

  const seekTo = async (sec) => {
    await page.evaluate((v) => {
      const s = document.getElementById('seek');
      s.value = String(v / 15);
      s.dispatchEvent(new Event('input'));
    }, sec);
    await new Promise((r) => setTimeout(r, 3000));
  };

  const waitFrames = (n) =>
    page.evaluate(
      (k) =>
        new Promise((res) => {
          let i = 0;
          // tope de seguridad: si rAF no avanza (pestaña oculta) no bloquear el test
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
  // La camara de persecucion interpola hacia su posicion objetivo durante varios
  // frames tras un salto en la barra. Hay que dejarla converger ANTES de tomar la
  // pose de referencia, o el test medira esa convergencia como error del peek.
  await seekTo(6);
  await waitFrames(45);
  await page.screenshot({ path: `${OUT}/01-reposo.png` });
  const before = await camPose(page);

  // ---- arrastre: mantener pulsado y mover a la derecha
  await page.mouse.move(640, 400);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(640 + i * 22, 400 - i * 6);
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: `${OUT}/02-arrastrando.png` });
  const during = await camPose(page);

  // ---- soltar: debe volver
  // El retorno se mide en FRAMES, no en milisegundos: con swiftshader el lienzo
  // avanza a pocos fps y una espera por reloj no garantiza que el bucle de
  // render haya corrido las veces necesarias para que converja el suavizado.
  await page.mouse.up();
  for (const n of [6, 20]) {
    await waitFrames(n);
    const now = await camPose(page);
    console.log('  tras', n, 'frames: err', Math.hypot(...now.pos.map((v, i) => v - before.pos[i])).toFixed(4), 'm');
  }
  await page.screenshot({ path: `${OUT}/03-soltado.png` });
  const after = await camPose(page);

  const dist = (a, b) => Math.hypot(...a.pos.map((v, i) => v - b.pos[i]));
  console.log('desvio al arrastrar :', dist(before, during).toFixed(3), 'm');
  console.log('error tras soltar   :', dist(before, after).toFixed(4), 'm');

  // Brillo de la zaga, medido sobre el PNG: el canvas WebGL no conserva el
  // buffer de dibujo, leerlo con drawImage devolveria negro.
  const sharp = (await import('sharp')).default;
  const region = { left: 384, top: 360, width: 512, height: 324 };
  for (const f of ['01-reposo', '03-soltado']) {
    const { data } = await sharp(`${OUT}/${f}.png`)
      .extract(region).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let sum = 0;
    for (let i = 0; i < data.length; i += 3) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    console.log(`brillo zaga ${f} (0-255):`, (sum / (data.length / 3)).toFixed(1));
  }
} finally {
  await browser.close();
}
