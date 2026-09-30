/** Capturas del modo Cinemática: las tres cámaras, en escritorio y móvil. */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5180/';
const OUT = 'test-results/cinematic';
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 720, dsf: 1 },
  { name: 'mobile', width: 390, height: 844, dsf: 2 },
];

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  protocolTimeout: 600_000,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

try {
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage();
    await page.setViewport({
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.dsf,
      isMobile: vp.name === 'mobile',
    });
    page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 300)));

    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction(
      () => document.getElementById('loading')?.classList.contains('hidden'),
      { timeout: 240_000, polling: 300 },
    );
    await new Promise((r) => setTimeout(r, 4000));
    await page.click('#play'); // pausa

    const dur = await page.$eval('#time', (e) => Number(e.textContent.split('/')[1].trim().replace(' s', '')));
    const seekTo = async (sec) => {
      await page.evaluate(([v, d]) => {
        const s = document.getElementById('seek');
        s.value = String(v / d);
        s.dispatchEvent(new Event('input'));
      }, [sec, dur]);
      await new Promise((r) => setTimeout(r, 3500));
    };

    // cinemática (track horneado)
    for (const t of [2, 20]) {
      await seekTo(t);
      await page.screenshot({ path: `${OUT}/${vp.name}-cinematica-${t}s.png` });
    }

    // trasera
    await page.click('#cam');
    for (const t of [2, 20, 45]) {
      await seekTo(t);
      await page.screenshot({ path: `${OUT}/${vp.name}-trasera-${t}s.png` });
    }
    console.log(vp.name, 'boton:', await page.$eval('#cam', (e) => e.textContent));

    // libre
    await page.click('#cam');
    await seekTo(20);
    await page.screenshot({ path: `${OUT}/${vp.name}-libre.png` });
    console.log(vp.name, 'boton:', await page.$eval('#cam', (e) => e.textContent));

    await page.close();
  }
} finally {
  await browser.close();
}
