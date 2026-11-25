
/**
 * ¿Se puede llegar caminando al refugio del ogro?
 *
 * Baja al conductor, pulsa la accion de visitar y comprueba que de verdad
 * acaba delante de la puerta. Es la prueba que importa: el refugio puede estar
 * perfecto y aun asi quedar fuera del parche de alturas de 32 m que se
 * construye al bajarse, en cuyo caso el personaje se queda clavado en el borde.
 */
import { DEFAULT_BASE, launch } from './lib/viewer.mjs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const browser = await launch();
let fallos = 0;
const ok = (c, etq, dato) => { console.log(`${c ? 'OK   ' : 'FALLO'} ${etq.padEnd(48)} ${dato}`); if (!c) fallos++; };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 720 });
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 250)));
  await page.goto(`${BASE}#cinematic-three`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction('window.__ogre && window.__driver && window.__cine', { timeout: 300_000 });
  await new Promise((r) => setTimeout(r, 1200));

  // Final de la pelicula: la camioneta ya esta parada en el mirador.
  //
  // El conductor se baja SOLO al llegar, pero hay que dejar correr el reloj:
  // con `hold(true)` puesto antes de tiempo la pelicula no avanza, no se
  // dispara la bajada y el test se queda esperando 'foot' para siempre.
  await page.evaluate(() => { window.__cine.hold(false); window.__cine.setTime(70.9); });
  await new Promise((r) => setTimeout(r, 2500));
  const estado0 = await page.evaluate(() => window.__driver.state);
  if (estado0 === 'drive') {
    // por si el disparo automatico no llego: bajarlo a mano
    await page.evaluate(() => window.__driver.exitVehicle());
  }
  await page.waitForFunction('window.__driver.state === "foot"', { timeout: 180_000 });
  await new Promise((r) => setTimeout(r, 800));
  await page.evaluate(() => { window.__cine.hold(true); });

  const antes = await page.evaluate(() => {
    const d = window.__driver, o = window.__ogre;
    const p = d.body();
    return {
      pos: { x: +p.x.toFixed(1), z: +p.z.toFixed(1) },
      puerta: { x: +o.doorway.x.toFixed(1), z: +o.doorway.z.toFixed(1) },
      dist: +Math.hypot(p.x - o.doorway.x, p.z - o.doorway.z).toFixed(1),
    };
  });
  console.log(`se baja en (${antes.pos.x}, ${antes.pos.z}) · la puerta del ogro esta a ${antes.dist} m\n`);

  // accion de visitar: por tecla, que es lo que usaria cualquiera en escritorio
  await page.keyboard.press('KeyR');
  // Caminar lleva MUCHO tiempo aqui.
  //
  // Bajo SwiftShader (render por software, sin GPU) la pagina va a pocos
  // fotogramas por segundo y el personaje avanza ~0,12 m por segundo de reloj
  // real en vez de a 1,4 m/s. Recorrer 18 m pide del orden de 3 minutos. Con
  // los 60 s del primer intento el test lo declaraba "clavado" cuando en
  // realidad seguia andando: un falso positivo del propio test.
  let ultimo = null, prev = null, quieto = 0;
  for (let i = 0; i < 420; i++) {
    await new Promise((r) => setTimeout(r, 500));
    ultimo = await page.evaluate(() => {
      const d = window.__driver, o = window.__ogre;
      const p = d.body();
      return {
        x: +p.x.toFixed(2), z: +p.z.toFixed(2),
        dist: +Math.hypot(p.x - o.doorway.x, p.z - o.doorway.z).toFixed(2),
        estado: d.state,
      };
    });
    if (ultimo.dist < 1.6) break;
    // si deja de avanzar de verdad (10 muestras sin moverse), no esperar mas
    if (i > 12 && ultimo.dist === prev?.dist) quieto++; else quieto = 0;
    prev = ultimo;
    if (quieto > 10) { console.log('  (deja de avanzar)'); break; }
  }
  console.log(`acaba en (${ultimo.x}, ${ultimo.z}) · a ${ultimo.dist} m de la puerta · estado ${ultimo.estado}`);
  ok(ultimo.dist < 2.5, 'llega caminando hasta la puerta', `${ultimo.dist} m`);
  // 'approach' no es un fallo: el personaje pasa a 'foot' cuando termina de
  // frenar (a 0,3 m del destino), y bajo SwiftShader ese ultimo tramo tarda.
  // Lo que importa es que no se quedo conduciendo ni atascado lejos.
  ok(ultimo.estado === 'foot' || ultimo.estado === 'approach',
     'sigue a pie (no ha vuelto al coche)', ultimo.estado);

  // ¿se ve la casa desde ahi?
  //
  // Va en try/catch: con el render por software este evaluate puede superar el
  // protocolTimeout de puppeteer, y perder la foto no invalida las medidas de
  // arriba, que son el objetivo del test.
  try {
  await page.evaluate(() => {
    const o = window.__ogre, d = window.__driver;
    const V = window.__land.group.position.constructor;
    const p = d.body();
    const casa = o.group.getObjectByName('Ogro_Casa');
    casa.updateWorldMatrix(true, false);
    const c = new V().setFromMatrixPosition(casa.matrixWorld);
    window.__cine.look(new V(p.x - 5.5, 26.6, p.z + 5.5), new V(c.x, c.y + 2.4, c.z));
  });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: 'test-results/ogro/visita.png' });
    console.log('\nfoto de la visita en test-results/ogro/visita.png');
  } catch (e) {
    console.log(`\n(sin foto: ${String(e).slice(0, 80)})`);
  }
} finally {
  await browser.close();
}
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nvisita correcta');
process.exitCode = fallos ? 1 : 0;
