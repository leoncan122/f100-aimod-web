
/**
 * Fotos del refugio del ogro desde varios angulos.
 *
 * La pelicula se deja al final (camioneta en el mirador) y se usa la camara
 * libre. OJO: las alturas de las tomas son ABSOLUTAS en mundo (el terreno de
 * la zona esta a y~25.5); calcularlas sumando a swamp.center.y, que vale 0,
 * dejaba la camara enterrada.
 */
import { DEFAULT_BASE, launch } from './lib/viewer.mjs';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const OUT = 'test-results/ogro';
mkdirSync(OUT, { recursive: true });

const browser = await launch();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 620 });
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 250)));
  await page.goto(`${BASE}#cinematic-three`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction('window.__ogre && window.__cine && window.__land', { timeout: 300_000 });

  const info = await page.evaluate(() => {
    window.__cine.setTime(70.9);
    window.__cine.hold(true);
    const o = window.__ogre;
    const land = window.__land;
    const c = o.swamp.center;
    return {
      stats: o.stats,
      doorway: { x: +o.doorway.x.toFixed(2), y: +o.doorway.y.toFixed(2), z: +o.doorway.z.toFixed(2) },
      centro: { x: +c.x.toFixed(2), z: +c.z.toFixed(2) },
      nivelAgua: +o.swamp.level.toFixed(2),
      suelo: +land.heightAt(c.x, c.z).toFixed(2),
    };
  });
  console.log('refugio :', JSON.stringify(info.stats));
  console.log('puerta  :', JSON.stringify(info.doorway));
  console.log('charca  : centro', JSON.stringify(info.centro), '· agua', info.nivelAgua, '· fondo', info.suelo);

  const { x: cx, z: cz } = info.centro;
  const Y = info.doorway.y; // cota del terreno de la parcela
  const TOMAS = [
    { n: 'general', eye: [cx + 24, Y + 11, cz + 22], at: [cx, Y + 1.5, cz] },
    { n: 'fachada', eye: [cx + 14, Y + 3.2, cz + 1],  at: [cx + 7.0, Y + 1.8, cz - 5.6] },
    { n: 'charca',  eye: [cx - 13, Y + 4.0, cz + 11], at: [cx + 1, Y - 0.4, cz - 1] },
    { n: 'aereo',   eye: [cx + 3,  Y + 30, cz + 10], at: [cx + 1, Y, cz - 3] },
    { n: 'puerta',  eye: [info.doorway.x + 3.2, Y + 2.0, info.doorway.z + 2.6], at: [cx + 7.2, Y + 1.6, cz - 5.8] },
    // interior: camara dentro del tocon, mirando al hogar y la cama
    { n: 'interior', dentro: true },
    { n: 'interior2', dentro: true, ojo: [2.5, 3.0, 2.2], mira: [-3.4, 1.2, -2.6] },
  ];
  for (const t of TOMAS) {
    if (t.dentro) {
      // la camara se coloca en coordenadas LOCALES de la casa y se transforma:
      // el tocon esta rotado hacia la charca, a ojo no se acierta
      // OJO: aqui NO vale `__cine.look`.
      //
      // Esa ayuda pasa por OrbitControls, que al actualizarse reencuadra
      // respetando su `minDistance` y empuja la camara fuera del objetivo: con
      // el objetivo a 2-3 m la expulsa del tocon y la foto del "interior" sale
      // desde el jardin. `freeze` fija la pose despues de camaras, controles y
      // peek, que es la unica forma de quedarse dentro.
      await page.evaluate(([oj, mi]) => {
        const casa = window.__ogre.group.getObjectByName('Ogro_Casa');
        casa.updateWorldMatrix(true, false);
        const V = window.__land.group.position.constructor;
        const a = oj ?? [-0.5, 3.0, 3.4];
        const b = mi ?? [3.2, 1.3, -2.8];
        window.__cine.freeze(
          new V(a[0], a[1], a[2]).applyMatrix4(casa.matrixWorld),
          new V(b[0], b[1], b[2]).applyMatrix4(casa.matrixWorld),
        );
      }, [t.ojo ?? null, t.mira ?? null]);
      await new Promise((r) => setTimeout(r, 450));
      await page.screenshot({ path: `${OUT}/${t.n}.png` });
      continue;
    }
    await page.evaluate(([e, a]) => {
      const V = window.__land.group.position.constructor; // THREE.Vector3
      window.__cine.unfreeze?.();
      window.__cine.look(new V(e[0], e[1], e[2]), new V(a[0], a[1], a[2]));
    }, [t.eye, t.at]);
    await new Promise((r) => setTimeout(r, 500));
    await page.screenshot({ path: `${OUT}/${t.n}.png` });
  }
  console.log(`\nfotos en ${OUT}/`);
} finally {
  await browser.close();
}
