/**
 * Barrido de intensidad de la luz ambiente de la camioneta (modo Desierto).
 *
 * Ajusta la intensidad en vivo sobre la escena cargada y mide el brillo medio
 * del recorte de la zaga, para elegir el valor sin recompilar en cada prueba.
 */
import { DEFAULT_BASE, launch, openMode } from './lib/viewer.mjs';
import { mkdirSync } from 'node:fs';
import sharp from 'sharp';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const OUT = 'test-results/ambient-sweep';
mkdirSync(OUT, { recursive: true });

const VALUES = [0, 0.5, 0.8, 1.2, 1.8];
// zaga de la camioneta, y una zona de arena para vigilar que no se lave
const REGION = { left: 560, top: 360, width: 160, height: 150 };
const SAND = { left: 60, top: 420, width: 200, height: 160 };

const browser = await launch();

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 300)));
  // Directo a la vista por hash: evita cargar la vista por defecto y pulsar la
  // pestaña (una carga de escena menos, ~12 s bajo SwiftShader).
  await openMode(page, BASE, 'desert');
  await new Promise((r) => setTimeout(r, 2500));
  await page.click('#play');
  await page.evaluate(() => {
    const s = document.getElementById('seek');
    s.value = String(6 / 15);
    s.dispatchEvent(new Event('input'));
  });

  // comprobar que la luz existe y en que capa esta
  const info = await page.evaluate(() => {
    const out = [];
    window.__scene.traverse((o) => {
      if (o.isAmbientLight) out.push({ intensity: o.intensity, mask: o.layers.mask });
    });
    let truckMask = null;
    window.__scene.traverse((o) => {
      if (truckMask === null && o.isMesh && /rueda|carroc|cube/i.test(o.name)) truckMask = o.layers.mask;
    });
    return { ambients: out, truckMask };
  });
  console.log('ambientales:', JSON.stringify(info));

  const waitFrames = (n) =>
    page.evaluate((k) => new Promise((res) => {
      let i = 0;
      const bail = setTimeout(() => res(i), 15_000);
      const tick = () => (++i >= k ? (clearTimeout(bail), res(i)) : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    }), n);

  await waitFrames(45);

  for (const v of VALUES) {
    await page.evaluate((val) => {
      window.__scene.traverse((o) => {
        if (o.isAmbientLight) o.intensity = val;
      });
    }, v);
    await waitFrames(6);
    const file = `${OUT}/amb-${String(v).replace('.', '_')}.png`;
    await page.screenshot({ path: file });
    const mean = async (region) => {
      const { data } = await sharp(file).extract(region).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      let sum = 0;
      for (let i = 0; i < data.length; i += 3) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
      return sum / (data.length / 3);
    };
    console.log(
      `intensidad ${String(v).padStart(5)} -> zaga ${(await mean(REGION)).toFixed(1)} · arena ${(await mean(SAND)).toFixed(1)}`,
    );
  }
} finally {
  await browser.close();
}
