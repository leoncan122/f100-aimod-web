/**
 * Verifica la UX de controles anclados a los personajes.
 *
 * Comprueba lo que se pidió, en el navegador real:
 *  1. la pantalla arranca limpia (ningún panel de acciones fijo),
 *  2. al pulsar sobre el personaje salen sus acciones en iconos sobre él,
 *  3. pulsando un icono se ejecuta la accion,
 *  4. en escritorio las teclas funcionan SIN clicar al personaje, y el icono
 *     correspondiente parpadea sobre él,
 *  5. conduciendo no hay acciones (ni por tecla: Espacio sigue siendo pausa).
 *
 * El clic se lanza en las coordenadas de pantalla del personaje, proyectando su
 * cabeza desde la escena viva: apuntar a un punto fijo del lienzo seria fragil.
 */
import { DEFAULT_BASE, launch, openMode, waitFrames } from './lib/viewer.mjs';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const OUT = 'test-results/acciones';
mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (label, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`${ok ? 'OK   ' : 'FALLA'} ${label.padEnd(50)} ${got}${ok ? '' : `  (esperado ${want})`}`);
};

/** Punto de pantalla de la cabeza del conductor (o null si no esta a pie). */
const driverAt = (page) =>
  page.evaluate(() => {
    const d = window.__driver;
    const cam = window.__camera;
    const c = document.querySelector('canvas');
    if (!d || !cam || !c || d.state !== 'foot') return null;
    const p = d.head().clone();
    p.y += 0.34;
    p.project(cam);
    const r = c.getBoundingClientRect();
    return { x: r.left + (p.x * 0.5 + 0.5) * r.width, y: r.top + (-p.y * 0.5 + 0.5) * r.height };
  });

/**
 * Estado visible de un menu de acciones, elegido por su etiqueta accesible.
 * Hay uno por personaje, asi que un `.actionMenu` a secas cogeria el primero
 * (Aitziber, que se monta antes) y el test mediria el personaje equivocado.
 */
const menuState = (page, who = 'el conductor') =>
  page.evaluate((w) => {
    const m = [...document.querySelectorAll('.actionMenu')]
      .find((n) => n.getAttribute('aria-label') === `Acciones de ${w}`);
    const btns = [...(m?.querySelectorAll('.amBtn') ?? [])];
    return {
      exists: !!m,
      open: !!m?.classList.contains('open'),
      // botones visibles de verdad (el abanico desplegado tiene opacidad 1)
      shown: btns.filter((b) => !b.hidden && getComputedStyle(b).opacity === '1').length,
      icons: btns.filter((b) => !b.hidden).map((b) => b.dataset.a),
      // iconos con el pulso de "accion disparada"
      flashing: btns.filter((b) => b.classList.contains('flash') || b.classList.contains('solo')).map((b) => b.dataset.a),
      // cada boton lleva su icono svg dibujado
      withSvg: btns.filter((b) => !b.hidden && b.querySelector('svg.icon')).length,
    };
  }, who);

/**
 * Espera a que el icono de `id` muestre el pulso de "accion disparada".
 *
 * El parpadeo dura ~0.9 s. Bajo swiftshader el lienzo avanza a pocos fps, asi
 * que esperar N frames y medir despues llega tarde y da un falso negativo:
 * hay que vigilar la clase en cuanto aparece.
 */
const waitFlash = (page, id, who = 'el conductor') =>
  page
    .waitForFunction(
      ([i, w]) => {
        const m = [...document.querySelectorAll('.actionMenu')]
          .find((n) => n.getAttribute('aria-label') === `Acciones de ${w}`);
        const b = m?.querySelector(`.amBtn[data-a="${i}"]`);
        return !!b && (b.classList.contains('solo') || b.classList.contains('flash'));
      },
      { timeout: 15_000, polling: 50 },
      [id, who],
    )
    .then(() => true)
    .catch(() => false);

/** Boton de una accion dentro del menu de un personaje concreto. */
const actionBox = (page, id, who = 'el conductor') =>
  page.evaluate(([i, w]) => {
    const m = [...document.querySelectorAll('.actionMenu')]
      .find((n) => n.getAttribute('aria-label') === `Acciones de ${w}`);
    const b = m?.querySelector(`.amBtn[data-a="${i}"]`);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, [id, who]);

/**
 * Espera a que el conductor cumpla una condicion.
 *
 * Sacar y enfundar el arma son transiciones animadas (reach -> raise -> aim y
 * aim -> lower -> holstered), asi que `armed` no cambia en el frame del clic:
 * esperar N frames a ojo da falsos negativos bajo swiftshader.
 */
const waitDriver = (page, expr, label) =>
  page
    .waitForFunction(`(() => { const d = window.__driver; return d && (${expr}); })()`, { timeout: 60_000, polling: 150 })
    .then(() => true)
    .catch(() => {
      console.log(`      (timeout esperando: ${label})`);
      return false;
    });

const browser = await launch();

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 200)));

  await openMode(page, BASE, 'cinematic-three', { waitMs: 3500 });

  // ── 5. conduciendo: ningun control de personaje responde
  const driving = await page.evaluate(() => ({
    panelesFijos: document.querySelectorAll('#charPanel, #aitziPanel').length,
    menuVisible: document.querySelector('.actionMenu')?.classList.contains('on') ?? false,
  }));
  check('arranca sin paneles fijos de acciones', driving.panelesFijos, 0);
  check('conduciendo: sin acciones sobre el personaje', driving.menuVisible, false);

  // Espacio conduciendo debe pausar la pelicula, no hacer saltar a nadie
  const playBefore = await page.$eval('#play', (e) => e.textContent.trim());
  await page.keyboard.press('Space');
  await waitFrames(page, 10);
  const playAfter = await page.$eval('#play', (e) => e.textContent.trim());
  check('Espacio conduciendo = pausa (no salto)', playBefore !== playAfter, true);

  // el conductor se baja al pausar
  await page.waitForFunction(() => window.__driver?.state === 'foot', { timeout: 120_000, polling: 300 });
  await waitFrames(page, 30);
  await page.screenshot({ path: `${OUT}/1-a-pie-limpio.png` });

  // ── 1. a pie y sin tocar nada: la pantalla sigue limpia (menu cerrado)
  let st = await menuState(page);
  check('a pie: el menu existe pero esta cerrado', `${st.exists}/${st.open}`, 'true/false');
  check('a pie: ningun boton de accion desplegado', st.shown, 0);

  // ── 2. clic sobre el personaje despliega sus acciones con iconos
  const at = await driverAt(page);
  if (!at) throw new Error('no se pudo proyectar al conductor');
  await page.mouse.move(at.x, at.y);
  await waitFrames(page, 6);
  await page.mouse.click(at.x, at.y);
  await waitFrames(page, 24);
  st = await menuState(page);
  await page.screenshot({ path: `${OUT}/2-menu-abierto.png` });
  check('clic en el personaje abre sus acciones', st.open, true);
  check('acciones desplegadas (iconos)', st.shown > 2, true);
  check('cada accion tiene su icono svg', st.withSvg, st.icons.length);
  console.log('      acciones ofrecidas:', st.icons.join(', '));

  // ── 3. pulsar un icono ejecuta la accion: el arma se desenfunda
  const armedBefore = await page.evaluate(() => window.__driver.armed);
  const gunBox = await actionBox(page, 'gun');
  if (!gunBox) throw new Error('no se encontro el icono del arma en el menu del conductor');
  await page.mouse.click(gunBox.x, gunBox.y);
  // espera a que la animacion de desenfunde acabe en 'aim'
  await waitDriver(page, "d.aiming", "arma apuntando");
  const armedAfter = await page.evaluate(() => window.__driver.armed);
  check('pulsar el icono del arma la desenfunda', `${armedBefore}->${armedAfter}`, 'false->true');
  await page.screenshot({ path: `${OUT}/3-arma-desenfundada.png` });

  // al estar armado aparece "disparar", que antes no se ofrecia
  st = await menuState(page);
  check('armado: aparece la accion de disparar', st.icons.includes('fire'), true);

  // cerrar el menu: clic fuera del personaje
  await page.mouse.click(60, 400);
  await waitFrames(page, 20);
  check('clic fuera cierra las acciones', (await menuState(page)).open, false);

  // ── 4. teclas sin clicar al personaje, con el menu CERRADO
  const kneelBefore = await page.evaluate(() => window.__driver.kneeling);
  const flashK = waitFlash(page, 'kneel'); // vigilar ANTES de pulsar
  await page.keyboard.press('KeyK');
  const sawFlash = await flashK;
  await page.screenshot({ path: `${OUT}/4-tecla-k-icono.png` });
  await waitDriver(page, 'd.kneeling', 'arrodillado');
  const kneelAfter = await page.evaluate(() => window.__driver.kneeling);
  st = await menuState(page);
  check('tecla K sin clic: se arrodilla', `${kneelBefore}->${kneelAfter}`, 'false->true');
  check('tecla K: su icono parpadea sobre el personaje', sawFlash, true);
  check('tecla K: el menu sigue cerrado', st.open, false);

  // la tecla del arma la vuelve a enfundar (misma accion, estado alterno)
  await page.keyboard.press('KeyG');
  await waitDriver(page, "!d.armed", "arma enfundada");
  check('tecla G enfunda el arma', await page.evaluate(() => window.__driver.armed), false);

  // ── Aitziber: mismo patron, con sus propias teclas
  const aitzi = await page.evaluate(() => {
    const a = window.__aitzi;
    return { existe: !!a, estado: a?.state ?? null };
  });
  if (aitzi.existe) {
    const menus = await page.evaluate(() => document.querySelectorAll('.actionMenu').length);
    check('Aitziber tambien tiene sus acciones ancladas', menus, 2);
    if (aitzi.estado === 'foot') {
      const flash1 = waitFlash(page, 'wave', 'Aitziber');
      await page.keyboard.press('Digit1');
      check('tecla 1: parpadea el icono de saludar de ella', await flash1, true);
    } else {
      console.log(`      (Aitziber en estado "${aitzi.estado}": no se prueba su gesto)`);
    }
  }

  await page.screenshot({ path: `${OUT}/5-final.png` });
  await page.close();

  // ── táctil: sin hover no hay forma de descubrir el menú, así que el anillo
  // debe verse siempre, y un toque sobre el personaje tiene que abrirlo.
  const m = await browser.newPage();
  await m.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  m.on('pageerror', (e) => console.log('[PAGEERROR movil]', e.message.slice(0, 200)));
  await openMode(m, BASE, 'cinematic-three', { waitMs: 3000 });
  await m.click('#play');
  await m.waitForFunction(() => window.__driver?.state === 'foot', { timeout: 120_000, polling: 300 });
  await waitFrames(m, 30);

  const ringVisible = await m.evaluate(() => {
    const r = [...document.querySelectorAll('.actionMenu')]
      .find((n) => n.getAttribute('aria-label') === 'Acciones de el conductor')
      ?.querySelector('.amRing');
    return r ? Number(getComputedStyle(r).opacity) > 0.5 : false;
  });
  check('tactil: el anillo se ve sin hover', ringVisible, true);

  const mAt = await driverAt(m);
  if (mAt) {
    await m.touchscreen.tap(mAt.x, mAt.y);
    await waitFrames(m, 24);
    const mst = await menuState(m);
    await m.screenshot({ path: `${OUT}/6-movil-menu.png` });
    check('tactil: un toque abre las acciones', mst.open, true);
    check('tactil: iconos desplegados', mst.shown > 2, true);
    // las teclas no se anuncian en táctil (no hay teclado)
    const keysShown = await m.evaluate(() =>
      [...document.querySelectorAll('.amKey')].some((k) => getComputedStyle(k).display !== 'none'),
    );
    check('tactil: no muestra atajos de teclado', keysShown, false);
  } else {
    console.log('      (no se pudo proyectar al conductor en movil)');
  }
  await m.screenshot({ path: `${OUT}/7-movil-final.png` });

  console.log(failures ? `\n${failures} comprobacion(es) con fallo` : '\nTodas las comprobaciones OK');
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
