/** Capturas de la cinemática en varios instantes + la camioneta desde varios ángulos. */
import { DEFAULT_BASE, launch } from './lib/viewer.mjs';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const OUT = 'test-results/frames';
mkdirSync(OUT, { recursive: true });

const browser = await launch(['--window-size=1600,900']);

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 120_000 });
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden'),
    { timeout: 180_000, polling: 250 },
  );

  // --- cinemática: pausar y saltar a varios puntos del timeline
  await page.click('#play'); // pausa
  const times = [3, 12, 25, 38, 50, 64];
  for (const t of times) {
    const dur = 70.83;
    await page.evaluate((v) => {
      const s = document.getElementById('seek');
      s.value = String(v);
      s.dispatchEvent(new Event('input'));
    }, t / dur);
    await new Promise((r) => setTimeout(r, 2500)); // dejar renderizar (SwiftShader es lento)
    await page.screenshot({ path: `${OUT}/cine-${String(t).padStart(2, '0')}s.png` });
    console.log(`cine ${t}s ->`, await page.$eval('#time', (e) => e.textContent));
  }

  // --- modelo: varios ángulos girando la órbita
  await page.click('.tab[data-mode="orbit"]');
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden'),
    { timeout: 180_000, polling: 250 },
  );
  await new Promise((r) => setTimeout(r, 3000));

  const canvas = await page.$('canvas');
  const box = await canvas.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const views = [
    { name: 'frontal', dx: 420, dy: 0 },
    { name: 'lateral', dx: 380, dy: 0 },
    { name: 'trasera', dx: 380, dy: 0 },
    { name: 'cenital', dx: 0, dy: -180 },
  ];
  for (const v of views) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + v.dx, cy + v.dy, { steps: 20 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 2500));
    await page.screenshot({ path: `${OUT}/modelo-${v.name}.png` });
    console.log('modelo', v.name, 'ok');
  }
} finally {
  await browser.close();
}
