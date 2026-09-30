/** Diagnóstico: clic en una pestaña y volcado de TODO lo que pase. */
import puppeteer from 'puppeteer-core';

const MODE = process.argv[2] ?? 'desert';
const BASE = process.argv[3] ?? 'http://127.0.0.1:5180/';

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  protocolTimeout: 600_000,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--window-size=900,520',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 520 });
  page.on('console', (m) => console.log(`[${m.type()}]`, m.text().slice(0, 500)));
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 800)));
  page.on('requestfailed', (r) => console.log('[REQFAIL]', r.url(), r.failure()?.errorText));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction(
    () => document.getElementById('loading')?.classList.contains('hidden'),
    { timeout: 240_000, polling: 300 },
  );
  console.log('>> modo inicial montado');

  if (MODE !== 'cinematic') {
    await page.click(`.tab[data-mode="${MODE}"]`);
    console.log('>> clic en', MODE);
  }

  // sondear el estado cada 5 s en vez de esperar ciegamente
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await page.evaluate(() => ({
      loading: document.getElementById('loading')?.className,
      msg: document.getElementById('msg')?.textContent,
      bar: document.querySelector('#bar > div')?.style.width,
      activeTab: document.querySelector('.tab.on')?.dataset.mode,
      stats: document.getElementById('stats')?.textContent,
    }));
    console.log(`t=${(i + 1) * 5}s`, JSON.stringify(st));
    if (st.loading?.includes('hidden') && st.activeTab === MODE) {
      console.log('>> OK montado');
      break;
    }
  }
  await page.screenshot({ path: `test-results/diag-${MODE}.png` });
} finally {
  await browser.close();
}
