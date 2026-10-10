/**
 * Reproduce el bloqueo de Aitziber contra la puerta abierta.
 *
 * Al bajarse del coche sale justo detrás de su puerta abierta y camina hacia el
 * conductor. `routeAround` solo esquiva la carrocería, así que la trayectoria
 * recta atraviesa la puerta: `collide` la empuja fuera cada frame y ella vuelve
 * a empujar, quedándose trabada contra la hoja.
 *
 * La medida es la del síntoma, no la de la implementación: se la deja caminar y
 * se mira si LLEGA a su sitio junto al conductor y si ha pasado tiempo pegada a
 * una puerta sin avanzar.
 *
 * Uso: node scripts/test-aitzi-puerta.mjs [baseUrl]
 */
import { DEFAULT_BASE, launch, openMode, waitFrames } from './lib/viewer.mjs';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const OUT = 'test-results/aitzi-puerta';
mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (label, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${label.padEnd(48)} ${got}${ok ? '' : `  (esperado ${want})`}`);
};

/** Instantánea del estado de los dos personajes y de las puertas. */
const snap = (page) =>
  page.evaluate(() => {
    const a = window.__aitzi, d = window.__driver, doors = window.__doors ?? [];
    if (!a || !d) return null;
    const ap = a.root.position, dp = d.root.position;
    // distancia de ella a la hoja de cada puerta abierta (en planta)
    const toDoors = doors
      .filter((x) => x.k >= 0.15 && x.node)
      .map((x) => {
        x.node.updateWorldMatrix(true, false);
        // posicion y borde de la hoja leidos de la matriz de mundo, sin
        // importar three en la pagina (el modulo no se resuelve por nombre)
        const me = x.node.matrixWorld.elements;
        const o = { x: me[12], z: me[14] };
        const ex = x.edge;
        const e = {
          x: me[0] * ex.x + me[4] * ex.y + me[8] * ex.z + me[12],
          z: me[2] * ex.x + me[6] * ex.y + me[10] * ex.z + me[14],
        };
        // punto más cercano del segmento puerta
        const abx = e.x - o.x, abz = e.z - o.z;
        const l2 = abx * abx + abz * abz || 1e-9;
        const t = Math.max(0, Math.min(1, ((ap.x - o.x) * abx + (ap.z - o.z) * abz) / l2));
        return Math.hypot(ap.x - (o.x + abx * t), ap.z - (o.z + abz * t));
      });
    return {
      estado: a.state,
      label: a.label,
      pos: [ap.x, ap.z],
      aDist: Math.hypot(ap.x - dp.x, ap.z - dp.z),
      puertasAbiertas: toDoors.length,
      aPuerta: toDoors.length ? Math.min(...toDoors) : Infinity,
    };
  });

const browser = await launch();

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 200)));

  await openMode(page, BASE, 'cinematic-three', { waitMs: 3500 });

  // pausar: los dos se bajan
  await page.click('#play');
  await page.waitForFunction(() => window.__driver?.state === 'foot', { timeout: 120_000, polling: 200 });
  await page.waitForFunction(() => window.__aitzi?.state === 'foot', { timeout: 120_000, polling: 200 });

  // abrir las dos puertas: es el caso que bloquea
  await page.keyboard.press('KeyO');
  await page.keyboard.press('KeyP');
  await waitFrames(page, 40);
  const abiertas = (await snap(page)).puertasAbiertas;
  check('puertas abiertas para la prueba', abiertas > 0, true);

  // alejar al conductor para que ella tenga que cruzar: camina un rato
  await page.keyboard.down('KeyW');
  await waitFrames(page, 110);
  await page.keyboard.up('KeyW');
  await waitFrames(page, 20);
  await page.screenshot({ path: `${OUT}/1-el-se-aleja.png` });

  // ── dejarla caminar y vigilar si se queda trabada contra una puerta
  const muestras = [];
  for (let i = 0; i < 70; i++) {
    await waitFrames(page, 4);
    const s = await snap(page);
    if (s) muestras.push(s);
  }
  await page.screenshot({ path: `${OUT}/2-tras-caminar.png` });

  const ult = muestras[muestras.length - 1];
  const dists = muestras.map((m) => m.aDist);
  const minDoor = Math.min(...muestras.map((m) => m.aPuerta));
  // trabada = pegada a una hoja (<0.45 m) y sin acercarse a él
  let trabada = 0;
  for (let i = 1; i < muestras.length; i++) {
    const m = muestras[i], p = muestras[i - 1];
    const avanza = p.aDist - m.aDist > 0.004;
    const movida = Math.hypot(m.pos[0] - p.pos[0], m.pos[1] - p.pos[1]) > 0.004;
    if (m.aPuerta < 0.45 && !avanza && !movida) trabada++;
  }

  console.log(`      distancia a el: ${dists[0].toFixed(2)} m -> ${ult.aDist.toFixed(2)} m`);
  console.log(`      minima distancia a una puerta: ${minDoor.toFixed(2)} m`);
  console.log(`      frames trabada contra la puerta: ${trabada}/${muestras.length - 1}`);
  console.log(`      estado final: ${ult.estado} (${ult.label})`);

  // Llega a su sitio: a su lado es ~0.95 m, se da margen
  check('llega junto al conductor', ult.aDist < 1.45, true);
  check('no se queda trabada contra la puerta', trabada < 6, true);

  // ── y con un gesto cercano, que exige cruzar hasta tocarle
  await page.keyboard.press('Digit4'); // abrazarle
  const llego = await page
    .waitForFunction(() => window.__aitzi?.label?.startsWith('Abraz'), { timeout: 45_000, polling: 150 })
    .then(() => true)
    .catch(() => false);
  await page.screenshot({ path: `${OUT}/3-abrazo.png` });
  check('un gesto cercano llega a ejecutarse', llego, true);

  console.log(failures ? `\n${failures} comprobacion(es) con fallo` : '\nTodas las comprobaciones OK');
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
