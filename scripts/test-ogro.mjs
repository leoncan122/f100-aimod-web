
/**
 * Verifica el refugio del ogro con numeros, no a ojo.
 *
 * Comprueba cuatro cosas que ya fallaron alguna vez:
 *   1. la hoya tiene vaso de verdad (el terreno baja bajo el nivel del agua),
 *   2. nada esta plantado dentro del agua (troncos, estacas, huesos flotando),
 *   3. la casa esta en seco y de pie sobre el terreno,
 *   4. la parcela entera cae dentro del radio caminable desde la puerta del
 *      coche, o no se podria visitar.
 */
import { DEFAULT_BASE, launch } from './lib/viewer.mjs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const browser = await launch();
let fallos = 0;
const ok = (cond, etiqueta, dato) => {
  console.log(`${cond ? 'OK   ' : 'FALLO'} ${etiqueta.padEnd(52)} ${dato}`);
  if (!cond) fallos++;
};

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 620 });
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 200)));
  await page.goto(`${BASE}#cinematic-three`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForFunction('window.__ogre && window.__land', { timeout: 300_000 });

  const r = await page.evaluate(() => {
    const land = window.__land, o = window.__ogre;
    const c = o.swamp.center, lvl = o.swamp.level, R = o.swamp.radius;

    // 1. perfil del vaso
    let calado = -Infinity;
    for (let a = 0; a < 360; a += 30) {
      const rad = (a * Math.PI) / 180;
      for (let d = 0; d <= R; d += 1) {
        const y = land.heightAt(c.x + Math.cos(rad) * d, c.z + Math.sin(rad) * d);
        calado = Math.max(calado, lvl - y);
      }
    }

    // 2. instancias dentro del agua
    const M = new (land.group.position.constructor === Object ? Object : window.Object)();
    const sumergidos = {};
    const tmp = o.group.children.filter((n) => n.isInstancedMesh);
    const mat = new (o.group.matrixWorld.constructor)();
    const pos = new (o.group.position.constructor)();
    for (const inst of tmp) {
      let n = 0;
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, mat);
        pos.setFromMatrixPosition(mat).applyMatrix4(inst.matrixWorld);
        if (land.heightAt(pos.x, pos.z) < lvl - 0.05) n++;
      }
      if (n) sumergidos[inst.name] = n;
    }

    // 2b. nada flotando: la base real de cada instancia contra el terreno.
    //
    // Mirar solo el ORIGEN de la matriz no basta — un tronco inclinado tiene
    // el origen enterrado y el pie en el aire. Se transforma la caja de la
    // geometria y se compara su minimo con el suelo.
    const flotando = {};
    for (const inst of tmp) {
      if (!inst.geometry.boundingBox) inst.geometry.computeBoundingBox();
      const bb = inst.geometry.boundingBox;
      let peor = 0, n = 0;
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, mat);
        const caja = bb.clone().applyMatrix4(mat).applyMatrix4(inst.matrixWorld);
        const centro = caja.getCenter(new (o.group.position.constructor)());
        const suelo = land.heightAt(centro.x, centro.z);
        const hueco = caja.min.y - suelo;   // >0 = flotando
        if (hueco > 0.12) { n++; peor = Math.max(peor, hueco); }
      }
      if (n) flotando[inst.name] = { n, peor: +peor.toFixed(2) };
    }

    // 2c. altura real de cada tipo de instancia y forma de la charca.
    //
    // Dos defectos que solo se veian a ojo y ninguna prueba medía: troncos de
    // 10 m que empequeñecian la choza, y una hoya tan redonda que parecia un
    // crater de molde.
    const alturas = {};
    for (const inst of tmp) {
      if (!inst.geometry.boundingBox) inst.geometry.computeBoundingBox();
      const bb = inst.geometry.boundingBox;
      let alto = 0;
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, mat);
        const caja = bb.clone().applyMatrix4(mat).applyMatrix4(inst.matrixWorld);
        alto = Math.max(alto, caja.max.y - caja.min.y);
      }
      alturas[inst.name] = +alto.toFixed(1);
    }
    // irregularidad: cuanto varia el radio del agua segun el angulo
    const rr = [];
    for (let a = 0; a < 360; a += 10) {
      const rad = (a * Math.PI) / 180;
      let r0 = 0;
      for (let d = 0.5; d <= R * 1.8; d += 0.2) {
        if (land.heightAt(c.x + Math.cos(rad) * d, c.z + Math.sin(rad) * d) >= lvl) break;
        r0 = d;
      }
      rr.push(r0);
    }
    const rMed = rr.reduce((a, b) => a + b, 0) / rr.length;
    const variacion = Math.sqrt(rr.reduce((a, b) => a + (b - rMed) ** 2, 0) / rr.length) / (rMed || 1);

    // 3. la casa
    const casa = o.group.getObjectByName('Ogro_Casa');
    casa.updateWorldMatrix(true, false);
    const cp = new (o.group.position.constructor)().setFromMatrixPosition(casa.matrixWorld);
    const casaSuelo = land.heightAt(cp.x, cp.z);

    // ¿apoya en toda su huella o cuelga por un lado?
    //
    // Con 15 m de diametro sobre terreno en pendiente la casa puede apoyar en
    // el centro y quedar flotando por el lado que cae. Se mide el hueco bajo
    // la base en un anillo de puntos, no solo en el centro.
    let huecoMax = -Infinity;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
      for (const rr of [4, 6.5]) {
        huecoMax = Math.max(huecoMax, cp.y - land.heightAt(cp.x + Math.cos(a) * rr, cp.z + Math.sin(a) * rr));
      }
    }

    // 3b. el piso interior debe quedar POR ENCIMA del terreno en toda la
    // planta, o la hierba lo atraviesa y desde dentro se ve cesped.
    const piso = o.group.getObjectByName('Ogro_Muebles');
    piso.updateWorldMatrix(true, false);
    if (!piso.geometry.boundingBox) piso.geometry.computeBoundingBox();
    const cajaPiso = piso.geometry.boundingBox.clone().applyMatrix4(piso.matrixWorld);
    const pisoY = cajaPiso.min.y + 0.5;   // cara superior aproximada del disco
    let hierbaDentro = 0;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 10) {
      for (const rr of [1.5, 3.5, 5.5]) {
        const sx = cp.x + Math.cos(a) * rr, sz = cp.z + Math.sin(a) * rr;
        if (land.heightAt(sx, sz) > pisoY) hierbaDentro++;
      }
    }

    // 4. alcance desde la parada
    const stop = { x: -114.95, z: -237.9 };
    const distPuerta = Math.hypot(cp.x - stop.x, cp.z - stop.z);
    const distCharca = Math.hypot(c.x - stop.x, c.z - stop.z);
    const distVisita = Math.hypot(o.doorway.x - stop.x, o.doorway.z - stop.z);

    return {
      calado: +calado.toFixed(2), sumergidos, flotando, alturas,
      variacion: +variacion.toFixed(3), rMed: +rMed.toFixed(1), stats: o.stats,
      huecoMax: +huecoMax.toFixed(2), hierbaDentro,
      casa: { x: +cp.x.toFixed(1), z: +cp.z.toFixed(1), suelo: +casaSuelo.toFixed(2), sobreAgua: +(casaSuelo - lvl).toFixed(2) },
      distPuerta: +distPuerta.toFixed(1), distCharca: +distCharca.toFixed(1),
      distVisita: +distVisita.toFixed(1),
      doorway: { x: +o.doorway.x.toFixed(1), y: +o.doorway.y.toFixed(2), z: +o.doorway.z.toFixed(1) },
    };
  });

  console.log(`refugio: ${r.stats.triangles} triangulos · ${r.stats.drawCalls} draw calls\n`);
  ok(r.calado > 0.4, 'la hoya tiene vaso (calado maximo)', `${r.calado} m`);
  const totalSum = Object.values(r.sumergidos).reduce((a, b) => a + b, 0);
  ok(totalSum === 0, 'nada plantado dentro del agua', totalSum ? JSON.stringify(r.sumergidos) : '0');
  const totalFlo = Object.values(r.flotando).reduce((a, b) => a + b.n, 0);
  ok(totalFlo === 0, 'nada flotando sobre el terreno', totalFlo ? JSON.stringify(r.flotando) : '0');
  const hTronco = r.alturas.Ogro_ArbolesMuertos ?? 0;
  ok(hTronco > 2 && hTronco < 6, 'troncos de altura creible (2-6 m)', `${hTronco} m`);
  ok(r.variacion > 0.07, 'la charca no es un circulo de molde', `variacion del radio ${(r.variacion * 100).toFixed(0)}% (radio medio ${r.rMed} m)`);
  ok(r.casa.sobreAgua > 0.3, 'la casa esta en seco', `${r.casa.sobreAgua} m sobre el agua`);
  ok(r.huecoMax < 2.6, 'la casa no flota (hueco bajo su huella)', `${r.huecoMax} m`);
  ok(r.hierbaDentro === 0, 'el piso interior es tierra, no hierba', `${r.hierbaDentro} puntos con terreno por encima`);
  // Lo que de verdad limita es el PUNTO DE VISITA, no el centro de la casa.
  //
  // El parche de alturas que se construye al bajarse cubre 32 m de semilado y
  // el personaje se frena 2 m antes del borde, asi que el destino tiene que
  // caer dentro de 30 m. El centro del tocon puede quedar mas lejos sin
  // problema: nadie camina hasta ahi, se camina hasta la puerta.
  ok(r.distVisita < 29, 'el punto de visita entra en el radio caminable', `${r.distVisita} m del mirador`);
  ok(r.distPuerta < 38, 'la casa queda cerca del mirador', `${r.distPuerta} m (centro del tocon)`);
  ok(r.distCharca < 30, 'la charca entra en el radio caminable', `${r.distCharca} m del mirador`);
  console.log(`\npunto de visita (delante de la puerta): ${JSON.stringify(r.doorway)}`);
} finally {
  await browser.close();
}
console.log(fallos ? `\n${fallos} FALLO(S)` : '\nrefugio correcto');
process.exitCode = fallos ? 1 : 0;
