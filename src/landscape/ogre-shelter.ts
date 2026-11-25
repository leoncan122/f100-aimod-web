import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Refugio del ogro: chabola fea junto a un pantano.
 *
 * Módulo independiente del paisaje que lo hospeda. No sabe nada de la
 * cinemática ni del terreno concreto: recibe dónde plantarse y una función de
 * altura, y devuelve un grupo listo para añadir a la escena más las mallas
 * sobre las que se puede caminar. Así vale igual para el modo cinemática que
 * para cualquier escenario futuro.
 *
 * Presupuesto: 9 draw calls (choza · tejado · chimenea · porquería · agua ·
 * juncos · árboles muertos · huesos · valla). Todo lo repetido es
 * InstancedMesh y el sombreado es Lambert salvo el agua.
 *
 * El criterio estético es "fea a propósito": nada de ángulos rectos, tablones
 * descolocados, tejado hundido, colores pardos y verdes enfermos.
 */

export interface OgreShelterOptions {
  /** Centro de la parcela, en coordenadas de mundo. */
  center: THREE.Vector3;
  /** Altura del terreno en (x, z). Se usa para apoyar cada pieza. */
  heightAt: (x: number, z: number) => number;
  /** Radio de la charca. El agua se dibuja hasta aquí. */
  swampRadius?: number;
  /**
   * Calado del agua sobre el fondo de la hoya, en metros.
   *
   * OJO al signo: `heightAt` ya devuelve el fondo EXCAVADO, así que el nivel se
   * obtiene SUMANDO. Restando (como estaba al principio) el disco de agua caía
   * por debajo del lecho y la charca no se veía.
   */
  swampDepth?: number;
  /** Semilla del generador: misma semilla, mismo refugio. */
  seed?: number;
}

export interface OgreShelter {
  group: THREE.Group;
  /** Suelo pisable que añade el refugio (la tarima de la entrada). */
  groundMeshes: THREE.Mesh[];
  /** Punto delante de la puerta, para mandar ahí al personaje. */
  doorway: THREE.Vector3;
  /** Centro y radio de la charca: quien camine por encima debe chapotear. */
  swamp: { center: THREE.Vector3; radius: number; level: number };
  stats: { triangles: number; drawCalls: number };
  dispose: () => void;
}

// ───────────────────────── paleta: todo pardo, verde enfermo y madera podrida
const COL_MADERA = 0x4a3a28;
const COL_MADERA_VIEJA = 0x5c4a33;
const COL_TEJADO = 0x3b3326;
const COL_PAJA = 0x6b5c33;
const COL_AGUA = 0x273118; // verde cenagoso casi negro, nunca azul
const COL_LODO = 0x3e3524;
const COL_JUNCO = 0x5a6234;
const COL_HUESO = 0xcfc7ac;
const COL_PIEDRA = 0x6e6a5e;
const COL_MUSGO = 0x4e6b2f;      // el tocón está cubierto de moho y hierba
const COL_MUSGO_OSC = 0x3a5122;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Pinta una geometría con un color por vértice y le quita las UV. */
function tint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r;
    a[i * 3 + 1] = c.g;
    a[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.deleteAttribute('uv');
  if (g.hasAttribute('normal')) g.computeVertexNormals();
  return g;
}

const lambert = (extra: THREE.MeshLambertMaterialParameters = {}) =>
  new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, ...extra });

export function createOgreShelter(opts: OgreShelterOptions): OgreShelter {
  const {
    center,
    heightAt,
    swampRadius = 13,
    swampDepth = 0.55,
    seed = 90210,
  } = opts;

  const rand = rng(seed);
  const group = new THREE.Group();
  group.name = 'RefugioOgro';
  const disposables: { dispose: () => void }[] = [];
  const keep = <T extends { dispose: () => void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  const y0 = heightAt(center.x, center.z);

  // La choza no va en el centro: el centro es la charca. La casa se aparta
  // hacia un lado y mira al agua, que es lo que hace que parezca un refugio
  // junto a un pantano y no una casa con un charco al lado.
  // A 1,45 radios: fuera del agua y del talud de la hoya. A 0,82 radios (el
  // primer intento) la casa caía dentro del vaso excavado y quedaba anegada.
  // A 1,62 radios. El compromiso es estrecho: el tocón mide ~15 m de diámetro,
  // así que a 1,45 metía las raíces en el agua y a 1,95 se iba a 33 m del
  // mirador, fuera del parche caminable de 32 m (menos 2 de margen) que se
  // construye al bajarse del coche. A 1,62 queda seco y visitable.
  const HUT_DIR = new THREE.Vector2(0.78, -0.62).normalize();
  const hutX = center.x + HUT_DIR.x * (swampRadius * 1.46);
  const hutZ = center.z + HUT_DIR.y * (swampRadius * 1.46);
  // Altura de apoyo: el punto MÁS BAJO bajo la huella del tocón, no el centro.
  //
  // Con 15 m de diámetro sobre terreno en pendiente, apoyar en la altura del
  // centro deja medio tocón en el aire — en la primera versión se veía flotar
  // con las raíces colgando. Se mide la huella y se usa el mínimo; las raíces
  // se alargan después hasta tocar el suelo de cada ángulo.
  let hutY = heightAt(hutX, hutZ);
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
    for (const rr of [4, 7.5]) {
      hutY = Math.min(hutY, heightAt(hutX + Math.cos(a) * rr, hutZ + Math.sin(a) * rr));
    }
  }
  /** Rumbo de la fachada: mirando hacia la charca. */
  const hutYaw = Math.atan2(center.x - hutX, center.z - hutZ);

  // ───────────────────────── la casa: tocón de árbol, como la de Shrek
  //
  // Referencia (WikiShrek / notas de producción de DreamWorks): no es una
  // cabaña de tablas, es un TOCÓN gigante y hueco, elevado sobre sus raíces
  // porque la erosión se llevó la tierra de alrededor. Encima lleva un techo
  // cónico de ramas y paja, y todo está cubierto de musgo. El interior es una
  // sola pieza que hace de cocina, comedor y dormitorio.
  //
  // Se construye por partes y se fusiona por material, para no gastar un draw
  // call por cada tabla: corteza · techo · madera de muebles · trastos.
  const W = 14.6; // diámetro del tocón (el doble que la chabola anterior)
  const D = 12.8;
  const H = 6.2;  // alto del cuerpo, sin contar el techo
  const RX = W / 2;
  const RZ = D / 2;

  const corteza: THREE.BufferGeometry[] = [];
  const techo: THREE.BufferGeometry[] = [];
  const mueble: THREE.BufferGeometry[] = [];
  const trasto: THREE.BufferGeometry[] = [];

  /** Hueco de la puerta, en ángulo alrededor del tocón (mira a la charca). */
  const PUERTA_W = 3.4;  // de ancho de arco
  const PUERTA_H = 4.3;
  const puertaAng = 0; // +Z local
  const medioArco = Math.atan2(PUERTA_W / 2, RZ);

  /** Ventana redonda en el costado, el otro hueco de la referencia. */
  const VENT_ANG = Math.PI * 0.62;
  const VENT_R = 1.15;
  const VENT_Y = H * 0.55;

  // ── pared del tocón: duelas verticales en elipse, con corteza irregular
  const DUELAS = 46;
  for (let i = 0; i < DUELAS; i++) {
    const a = (i / DUELAS) * Math.PI * 2;
    // separación angular de esta duela al centro de cada hueco
    const dPuerta = Math.abs(Math.atan2(Math.sin(a - puertaAng), Math.cos(a - puertaAng)));
    const dVent = Math.abs(Math.atan2(Math.sin(a - VENT_ANG), Math.cos(a - VENT_ANG)));
    const enPuerta = dPuerta < medioArco;

    const x = Math.sin(a) * RZ;
    const z = Math.cos(a) * RX;
    // altura: el borde superior del tocón es irregular, como partido
    const h = H * (0.9 + 0.22 * Math.sin(a * 3.1 + 1.2) + rand() * 0.1);

    if (enPuerta) {
      // sobre el dintel de la puerta queda pared
      const g = new THREE.BoxGeometry(0.95, h - PUERTA_H, 0.75);
      g.rotateY(-a);
      g.translate(x, PUERTA_H + (h - PUERTA_H) / 2, z);
      corteza.push(tint(g, rand() < 0.35 ? COL_MADERA_VIEJA : COL_MADERA));
      continue;
    }

    const g = new THREE.BoxGeometry(0.95, h, 0.75 + rand() * 0.35);
    g.rotateY(-a);
    g.rotateZ((rand() - 0.5) * 0.04);
    g.translate(x * (1 + (rand() - 0.5) * 0.03), h / 2, z * (1 + (rand() - 0.5) * 0.03));
    corteza.push(tint(g, rand() < 0.35 ? COL_MADERA_VIEJA : COL_MADERA));

    // hueco de la ventana: se parte la duela en dintel y antepecho
    if (dVent < Math.atan2(VENT_R, RZ)) {
      const corte = new THREE.BoxGeometry(1.05, VENT_R * 2, 0.95);
      corte.rotateY(-a);
      corte.translate(x * 1.02, VENT_Y, z * 1.02);
      // se marca el marco con dos travesaños en vez de recortar la geometría
      const arriba = new THREE.BoxGeometry(1.5, 0.22, 0.5);
      arriba.rotateY(-a);
      arriba.translate(x * 1.06, VENT_Y + VENT_R, z * 1.06);
      const abajo = new THREE.BoxGeometry(1.5, 0.26, 0.6);
      abajo.rotateY(-a);
      abajo.translate(x * 1.06, VENT_Y - VENT_R, z * 1.06);
      corteza.push(tint(arriba, COL_MADERA_VIEJA), tint(abajo, COL_MADERA_VIEJA));
      corte.dispose();
    }
  }

  // ── raíces: el tocón está levantado del suelo sobre ellas
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + rand() * 0.2;
    const px = Math.sin(a) * RZ * 0.92;
    const pz = Math.cos(a) * RX * 0.92;
    // cuánto hay desde la base del tocón hasta el suelo real en ese punto
    const wx = hutX + Math.sin(a + hutYaw) * RZ * 0.92;
    const wz = hutZ + Math.cos(a + hutYaw) * RX * 0.92;
    const caida = hutY - heightAt(wx, wz);         // >0 si el suelo queda abajo
    const largo = Math.max(1.6, 2.2 + caida) + rand() * 0.8;
    const g = new THREE.CylinderGeometry(0.3 + rand() * 0.25, 0.6 + rand() * 0.3, largo, 5);
    g.rotateZ(0.42 + rand() * 0.35);
    g.rotateY(-a);
    // se hunde media longitud para que nazca del tocón y entierre la punta
    g.translate(px, 0.45 - caida * 0.5, pz);
    corteza.push(tint(g, 0x40331f));
  }

  // Faldón de tierra: tapa el hueco entre la base del tocón y el terreno. Sin
  // esto se ve por debajo de la casa y parece levitar.
  {
    const falda = new THREE.CylinderGeometry(RX * 0.99, RX * 1.12, 2.4, 20, 1, true);
    falda.translate(0, -0.9, 0);
    corteza.push(tint(falda, 0x3a2f20));
  }

  // ── jambas y dintel de la puerta, bien gordos
  {
    const dintel = new THREE.BoxGeometry(PUERTA_W + 1.1, 0.42, 0.9);
    dintel.rotateZ(-0.03);
    dintel.translate(0, PUERTA_H, RX * 0.99);
    corteza.push(tint(dintel, COL_MADERA_VIEJA));
    for (const sx of [-1, 1]) {
      const j = new THREE.BoxGeometry(0.5, PUERTA_H, 0.85);
      j.rotateZ(sx * 0.02);
      j.translate(sx * (PUERTA_W / 2 + 0.2), PUERTA_H / 2, RX * 0.99);
      corteza.push(tint(j, COL_MADERA_VIEJA));
    }
    // puerta entreabierta, apoyada en una jamba
    const hoja = new THREE.BoxGeometry(PUERTA_W * 0.92, PUERTA_H * 0.95, 0.18);
    hoja.rotateY(-0.75);
    hoja.translate(-PUERTA_W * 0.62, PUERTA_H * 0.47, RX * 1.05);
    corteza.push(tint(hoja, 0x56442c));
  }

  // ── techo CÓNICO (triangular visto de frente), de ramas y paja
  {
    // cono principal: 8 lados para que se lea facetado y tosco
    const cono = new THREE.ConeGeometry(RX * 1.26, 5.6, 8, 1, true);
    cono.translate(0, H + 2.5, 0);
    techo.push(tint(cono, COL_TEJADO));
    // segundo faldón más bajo y ancho: alero volado
    const alero = new THREE.ConeGeometry(RX * 1.42, 1.8, 8, 1, true);
    alero.translate(0, H + 0.55, 0);
    techo.push(tint(alero, COL_TEJADO));
    // haces de paja desordenados pegados a la pendiente
    for (let i = 0; i < 26; i++) {
      const a = rand() * Math.PI * 2;
      const t = 0.12 + rand() * 0.72;              // altura relativa en el cono
      const r = RX * 1.26 * (1 - t) + 0.25;
      const g = new THREE.BoxGeometry(0.22 + rand() * 0.3, 1.5 + rand() * 1.4, 0.16);
      g.rotateX(-0.62 + (rand() - 0.5) * 0.25);
      g.rotateY(-a);
      g.translate(Math.sin(a) * r, H + 0.9 + t * 4.6, Math.cos(a) * r);
      techo.push(tint(g, rand() < 0.4 ? COL_PAJA : 0x55492a));
    }
    // remate: ramas cruzadas en la cumbrera
    for (let i = 0; i < 3; i++) {
      const g = new THREE.CylinderGeometry(0.1, 0.12, 2.2, 5);
      g.rotateZ(0.6 + rand() * 0.5);
      g.rotateY(rand() * Math.PI);
      g.translate((rand() - 0.5) * 0.5, H + 5.4, (rand() - 0.5) * 0.5);
      techo.push(tint(g, 0x3b3025));
    }
  }

  // ── musgo: parches verdes sobre la corteza y el techo (la referencia
  //    insiste en que todo está cubierto de moho y hierba)
  for (let i = 0; i < 30; i++) {
    const a = rand() * Math.PI * 2;
    const y = rand() * H;
    const g = new THREE.BoxGeometry(0.5 + rand() * 1.1, 0.3 + rand() * 0.7, 0.12);
    g.rotateY(-a);
    g.translate(Math.sin(a) * RZ * 1.03, y, Math.cos(a) * RX * 1.03);
    corteza.push(tint(g, rand() < 0.5 ? COL_MUSGO : COL_MUSGO_OSC));
  }

  // ───────────────────────── INTERIOR
  //
  // Lo que se ve por la puerta y la ventana, según la referencia: cama grande,
  // mesa con dos sillas, hogar encendido, estantería con tarros y trastos
  // colgados. No hay suelo de tablas: en la peli es tierra batida.
  // Cota del piso DENTRO del tocón.
  //
  // El grupo se apoya en el punto más bajo de la huella (ver arriba), así que
  // el terreno real asoma por encima del cero local y, con el piso a 0,12 m,
  // la hierba lo tapaba: desde dentro se veía césped en vez de tierra batida.
  // Se levanta por encima del punto más ALTO del terreno bajo la planta.
  let SUELO_Y = 0.35;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 10) {
    for (const rr of [2, 4.5, 6.5]) {
      const sx = hutX + Math.cos(a) * rr, sz = hutZ + Math.sin(a) * rr;
      SUELO_Y = Math.max(SUELO_Y, heightAt(sx, sz) - hutY + 0.3);
    }
  }

  // suelo de tierra batida (en la película no hay tarima: es tierra)
  {
    const g = new THREE.CylinderGeometry(RX * 0.97, RX * 0.97, 0.5, 20);
    g.translate(0, SUELO_Y - 0.25, 0);
    mueble.push(tint(g, 0x3a2f20));
  }

  // cama del ogro: jergón de paja sobre armazón de troncos
  {
    const marco = new THREE.BoxGeometry(4.6, 0.55, 3.0);
    marco.translate(-3.4, SUELO_Y + 0.5, -2.6);
    mueble.push(tint(marco, COL_MADERA_VIEJA));
    const jergon = new THREE.BoxGeometry(4.3, 0.5, 2.7);
    jergon.translate(-3.4, SUELO_Y + 1.0, -2.6);
    mueble.push(tint(jergon, COL_PAJA));
    // manta y almohada
    const manta = new THREE.BoxGeometry(4.35, 0.22, 1.7);
    manta.translate(-3.4, SUELO_Y + 1.3, -2.1);
    mueble.push(tint(manta, 0x6b3b2a));
    const almohada = new THREE.BoxGeometry(1.5, 0.35, 0.9);
    almohada.translate(-5.0, SUELO_Y + 1.4, -3.3);
    mueble.push(tint(almohada, 0x8a7a55));
    // cuatro patas de tronco
    for (const [px, pz] of [[-5.3, -3.8], [-1.6, -3.8], [-5.3, -1.4], [-1.6, -1.4]] as const) {
      const p = new THREE.CylinderGeometry(0.2, 0.24, 0.55, 6);
      p.translate(px, SUELO_Y + 0.28, pz);
      mueble.push(tint(p, 0x3f3220));
    }
  }

  // mesa y dos taburetes, delante del hogar
  {
    const tabla = new THREE.BoxGeometry(3.2, 0.26, 1.9);
    tabla.rotateY(0.12);
    tabla.translate(2.4, SUELO_Y + 1.35, 0.4);
    mueble.push(tint(tabla, COL_MADERA_VIEJA));
    for (const [px, pz] of [[1.2, -0.3], [3.5, -0.3], [1.2, 1.1], [3.5, 1.1]] as const) {
      const p = new THREE.CylinderGeometry(0.14, 0.17, 1.35, 6);
      p.translate(px, SUELO_Y + 0.68, pz);
      mueble.push(tint(p, 0x3f3220));
    }
    for (const [px, pz] of [[1.5, 2.2], [3.9, 1.6]] as const) {
      const as = new THREE.CylinderGeometry(0.5, 0.52, 0.22, 8);
      as.translate(px, SUELO_Y + 0.95, pz);
      mueble.push(tint(as, COL_MADERA_VIEJA));
      const pata = new THREE.CylinderGeometry(0.36, 0.42, 0.95, 7);
      pata.translate(px, SUELO_Y + 0.47, pz);
      mueble.push(tint(pata, 0x3f3220));
    }
    // cuenco y jarra sobre la mesa
    const cuenco = new THREE.SphereGeometry(0.34, 10, 6, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5);
    cuenco.translate(2.1, SUELO_Y + 1.5, 0.3);
    trasto.push(tint(cuenco, 0x6d5637));
    const jarra = new THREE.CylinderGeometry(0.2, 0.26, 0.6, 8);
    jarra.translate(3.1, SUELO_Y + 1.75, 0.7);
    trasto.push(tint(jarra, 0x5b4a33));
  }

  // hogar de piedra contra la pared, bajo la chimenea
  {
    for (let i = 0; i < 12; i++) {
      const s = 0.45 + rand() * 0.3;
      const g = new THREE.BoxGeometry(s, 0.34, s * 0.8);
      const a = -0.9 + (i / 12) * 1.8;
      g.rotateY(a);
      g.translate(Math.sin(a) * 2.2 + 4.6, SUELO_Y + 0.2 + (i % 3) * 0.33, Math.cos(a) * 2.2 - 3.4);
      mueble.push(tint(g, COL_PIEDRA));
    }
    // leña y fuego (emisivo: se ve desde fuera por la puerta)
    for (let i = 0; i < 5; i++) {
      const g = new THREE.CylinderGeometry(0.11, 0.13, 1.1, 5);
      g.rotateZ(Math.PI / 2);
      g.rotateY(rand() * Math.PI);
      g.translate(4.9 + (rand() - 0.5) * 0.4, SUELO_Y + 0.25 + i * 0.12, -3.5 + (rand() - 0.5) * 0.4);
      mueble.push(tint(g, 0x332a1c));
    }
  }

  // estantería con tarros (los "tarros de ojos" de la película)
  {
    for (let k = 0; k < 2; k++) {
      const balda = new THREE.BoxGeometry(3.4, 0.16, 0.7);
      balda.rotateY(-1.25);
      balda.translate(-1.2, SUELO_Y + 2.1 + k * 1.1, 4.2);
      mueble.push(tint(balda, COL_MADERA_VIEJA));
      for (let i = 0; i < 5; i++) {
        const t = new THREE.CylinderGeometry(0.17, 0.17, 0.42 + rand() * 0.18, 8);
        const u = -1.3 + i * 0.65;
        t.translate(-1.2 + Math.cos(-1.25) * u, SUELO_Y + 2.4 + k * 1.1, 4.2 - Math.sin(-1.25) * u);
        trasto.push(tint(t, k === 0 ? 0x6a7a4a : 0x7a6a4a));
      }
    }
  }

  // trastos colgados y tirados: cacharros, un caldero y huesos de adorno
  {
    const caldero = new THREE.SphereGeometry(0.75, 12, 8, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.58);
    caldero.translate(5.2, SUELO_Y + 0.6, -1.4);
    trasto.push(tint(caldero, 0x2e2a26));
    for (let i = 0; i < 7; i++) {
      const a = rand() * Math.PI * 2;
      const r = 2 + rand() * 3.4;
      const g = new THREE.BoxGeometry(0.3 + rand() * 0.3, 0.26, 0.3 + rand() * 0.3);
      g.rotateY(rand() * Math.PI);
      g.translate(Math.sin(a) * r, SUELO_Y + 0.25, Math.cos(a) * r);
      trasto.push(tint(g, 0x5a4a32));
    }
  }

  const hutGeo = keep(mergeGeometries(corteza)!);
  for (const p of corteza) p.dispose();
  const hut = new THREE.Mesh(hutGeo, keep(lambert()));
  hut.name = 'Ogro_Choza';
  hut.castShadow = true;
  hut.receiveShadow = true;

  const roofGeo = keep(mergeGeometries(techo)!);
  for (const p of techo) p.dispose();
  const roof = new THREE.Mesh(roofGeo, keep(lambert({ side: THREE.DoubleSide })));
  roof.name = 'Ogro_Tejado';
  roof.castShadow = true;

  const muebleGeo = keep(mergeGeometries(mueble)!);
  for (const p of mueble) p.dispose();
  const muebles = new THREE.Mesh(muebleGeo, keep(lambert()));
  muebles.name = 'Ogro_Muebles';
  muebles.receiveShadow = true;

  const trastoGeo = keep(mergeGeometries(trasto)!);
  for (const p of trasto) p.dispose();
  const trastos = new THREE.Mesh(trastoGeo, keep(lambert({ emissive: 0x151008 })));
  trastos.name = 'Ogro_Trastos';

  // lumbre del hogar: luz cálida que se escapa por la puerta y la ventana
  const fuego = new THREE.PointLight(0xff8c3a, 26, 16, 1.7);
  fuego.position.set(4.8, SUELO_Y + 0.9, -3.4);
  const brasas = new THREE.Mesh(
    keep(new THREE.SphereGeometry(0.55, 10, 8)),
    keep(new THREE.MeshBasicMaterial({ color: 0xff7a26 })),
  );
  brasas.position.copy(fuego.position);
  brasas.name = 'Ogro_Brasas';

  // ───────────────────────── chimenea de piedras mal apiladas
  const chimneyParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 13; i++) {
    const s = 0.62 + rand() * 0.3;
    const g = new THREE.BoxGeometry(s, 0.36, s * (0.8 + rand() * 0.4));
    g.rotateY(rand() * Math.PI);
    g.rotateZ((rand() - 0.5) * 0.16);
    g.translate(4.6 + (rand() - 0.5) * 0.24, H + 0.3 + i * 0.36, -3.4 + (rand() - 0.5) * 0.24);
    chimneyParts.push(tint(g, COL_PIEDRA));
  }
  const chimneyGeo = keep(mergeGeometries(chimneyParts)!);
  for (const p of chimneyParts) p.dispose();
  const chimney = new THREE.Mesh(chimneyGeo, keep(lambert()));
  chimney.name = 'Ogro_Chimenea';
  chimney.castShadow = true;

  // ───────────────────────── tarima de la entrada (esto SÍ se pisa)
  const deckGeo = keep(tint(new THREE.BoxGeometry(5.6, 0.26, 3.0), COL_MADERA_VIEJA));
  const deck = new THREE.Mesh(deckGeo, keep(lambert()));
  deck.name = 'Ogro_Tarima';
  deck.position.set(0, 0.13, RX + 1.3);
  deck.receiveShadow = true;

  // La casa entera, ya orientada y apoyada en el terreno
  const hutGroup = new THREE.Group();
  hutGroup.name = 'Ogro_Casa';
  hutGroup.add(hut, roof, muebles, trastos, chimney, deck, fuego, brasas);
  hutGroup.position.set(hutX, hutY, hutZ);
  hutGroup.rotation.y = hutYaw;
  group.add(hutGroup);

  // Punto delante de la puerta, en mundo: para mandar ahí al visitante.
  const doorway = new THREE.Vector3(0, 0, RX + 3.2)
    .applyAxisAngle(THREE.Object3D.DEFAULT_UP, hutYaw)
    .add(new THREE.Vector3(hutX, 0, hutZ));
  doorway.y = heightAt(doorway.x, doorway.z);

  // ───────────────────────── charca: agua estancada, verde y opaca
  // El agua se apoya sobre el fondo de la hoya, no bajo él.
  const level = y0 + swampDepth;

  /**
   * Radio del agua en cada dirección, hasta donde el terreno cruza el nivel.
   *
   * Un disco de radio fijo daba dos defectos a la vez: un óvalo perfecto que
   * parecía un cráter de molde, y agua dibujada sobre terreno que en realidad
   * está por encima del nivel — de ahí los juncos que parecían crecer dentro
   * de la charca. Buscando el cruce real por cada ángulo la orilla sale
   * irregular y el agua termina justo donde deja de haber hoya.
   */
  const SECTORES = 48;
  const radioEn = (ang: number) => {
    let r = 0.6;
    for (let d = 0.6; d <= swampRadius * 1.6; d += 0.25) {
      if (heightAt(center.x + Math.cos(ang) * d, center.z + Math.sin(ang) * d) >= level) break;
      r = d;
    }
    return r;
  };
  const radios: number[] = [];
  for (let i = 0; i < SECTORES; i++) radios.push(radioEn((i / SECTORES) * Math.PI * 2));
  const waterGeo = keep((() => {
    const g = new THREE.CircleGeometry(1, SECTORES).rotateX(-Math.PI / 2);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    // el vértice 0 es el centro; el resto, el borde en orden angular
    for (let i = 1; i < p.count; i++) {
      const ang = Math.atan2(p.getZ(i), p.getX(i));
      const k = ((Math.round((ang / (Math.PI * 2)) * SECTORES) % SECTORES) + SECTORES) % SECTORES;
      const rr = radios[k]! * 0.98; // un pelo por dentro: no se monta en la hierba
      const l = Math.hypot(p.getX(i), p.getZ(i)) || 1;
      p.setXYZ(i, (p.getX(i) / l) * rr, 0, (p.getZ(i) / l) * rr);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  })());
  // Agua estancada: NO MeshStandard.
  //
  // Con material estándar el cielo la lavaba a blanco por mucho que se bajara
  // `envMapIntensity`: la luz difusa del domo basta para reventar un color tan
  // oscuro. Lambert sin reflejo de entorno, con algo de emisivo para que no se
  // vaya a negro en sombra, da el verde opaco de agua podrida que se busca.
  const water = new THREE.Mesh(
    waterGeo,
    keep(new THREE.MeshLambertMaterial({
      color: COL_AGUA,
      emissive: 0x121a0c,
      reflectivity: 0,
    })),
  );
  water.name = 'Ogro_Charca';
  water.position.set(center.x, level + 0.04, center.z);
  water.receiveShadow = true;
  group.add(water);

  // Orla de lodo: anillo plano algo más ancho que el agua, para que la charca
  // no termine en un corte limpio contra la hierba.
  const mudGeo = keep((() => {
    const g = new THREE.RingGeometry(0.97, 1.14, SECTORES).rotateX(-Math.PI / 2);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const ang = Math.atan2(p.getZ(i), p.getX(i));
      const k = ((Math.round((ang / (Math.PI * 2)) * SECTORES) % SECTORES) + SECTORES) % SECTORES;
      const l = Math.hypot(p.getX(i), p.getZ(i)) || 1; // 0.9 interior, 1.3 exterior
      const rr = radios[k]! * l;
      p.setXYZ(i, (p.getX(i) / l) * rr, 0, (p.getZ(i) / l) * rr);
    }
    p.needsUpdate = true;
    g.computeVertexNormals();
    return tint(g, COL_LODO);
  })());
  const mud = new THREE.Mesh(mudGeo, keep(lambert()));
  mud.name = 'Ogro_Lodo';
  mud.position.set(center.x, level + 0.06, center.z);
  mud.receiveShadow = true;
  group.add(mud);

  // ───────────────────────── juncos en la orilla (InstancedMesh)
  const reedGeo = keep(tint(new THREE.ConeGeometry(0.06, 1.5, 4).translate(0, 0.75, 0), COL_JUNCO));
  const REEDS = 160;
  const reeds = new THREE.InstancedMesh(reedGeo, keep(lambert()), REEDS);
  reeds.name = 'Ogro_Juncos';
  reeds.castShadow = true;
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v3 = new THREE.Vector3();
  const col = new THREE.Color();
  let nReeds = 0;
  for (let i = 0; i < REEDS * 4 && nReeds < REEDS; i++) {
    const a = rand() * Math.PI * 2;
    const r = swampRadius * (0.8 + rand() * 0.45);
    const x = center.x + Math.cos(a) * r;
    const z = center.z + Math.sin(a) * r;
    // nada de juncos donde está la casa
    if (Math.hypot(x - hutX, z - hutZ) < 10) continue;
    // Solo en la franja mojada de la orilla, NUNCA bajo el agua.
    //
    // El margen de -0,45 m de la primera versión dejaba 34 juncos flotando en
    // mitad de la charca: un junco con el pie sumergido se ve nacer del agua.
    // La banda va del nivel del agua hacia arriba.
    const yj = heightAt(x, z);
    if (yj < level + 0.02 || yj > level + 0.75) continue;
    // ...y fuera del disco de agua de ESE ángulo, o se ven brotar del agua
    const ka = ((Math.round((a / (Math.PI * 2)) * SECTORES) % SECTORES) + SECTORES) % SECTORES;
    if (r < radios[ka]! * 1.02) continue;
    const s = 0.7 + rand() * 0.9;
    const jx = (rand() - 0.5) * 0.3, jz = (rand() - 0.5) * 0.3;
    q.setFromEuler(new THREE.Euler(jx, rand() * Math.PI * 2, jz));
    m4.compose(v3.set(x, heightAt(x, z) - 0.2 - 0.7 * s * Math.hypot(jx, jz), z), q, v3.clone().set(s, s * (0.7 + rand() * 0.8), s));
    reeds.setMatrixAt(nReeds, m4);
    reeds.setColorAt(nReeds, col.setHSL(0.22 + rand() * 0.07, 0.3 + rand() * 0.2, 0.26 + rand() * 0.16));
    nReeds++;
  }
  reeds.count = nReeds;
  reeds.instanceMatrix.needsUpdate = true;
  reeds.computeBoundingSphere();
  group.add(reeds);

  // ───────────────────────── árboles muertos: troncos pelados y torcidos
  const deadGeo = keep(
    mergeGeometries([
      tint(new THREE.CylinderGeometry(0.16, 0.34, 5.2, 6).translate(0, 2.6, 0), 0x3b3025),
      tint(new THREE.CylinderGeometry(0.07, 0.12, 1.9, 5).rotateZ(0.9).translate(0.7, 3.9, 0), 0x3b3025),
      tint(new THREE.CylinderGeometry(0.06, 0.1, 1.5, 5).rotateZ(-1.1).translate(-0.6, 3.3, 0.2), 0x3b3025),
    ])!,
  );
  const DEAD = 9;
  const dead = new THREE.InstancedMesh(deadGeo, keep(lambert()), DEAD);
  dead.name = 'Ogro_ArbolesMuertos';
  dead.castShadow = true;
  let nDead = 0;
  for (let i = 0; i < DEAD * 6 && nDead < DEAD; i++) {
    const a = rand() * Math.PI * 2;
    const r = swampRadius * (1.2 + rand() * 1.35);
    const x = center.x + Math.cos(a) * r;
    const z = center.z + Math.sin(a) * r;
    if (Math.hypot(x - hutX, z - hutZ) < 12) continue;
    // Nada de troncos flotando en mitad del agua: solo en tierra firme. El
    // radio nominal no basta — la hoya es más ancha que el disco de agua, así
    // que la condición se comprueba contra la ALTURA real del terreno.
    if (heightAt(x, z) < level + 0.25) continue;
    // 0,45–0,95 sobre un tronco base de 5,2 m -> 2,3–4,9 m de alto.
    // Con 1,15–1,9 salían de 6 a 10 m: dominaban la escena entera y la choza
    // (4,6 m de muro) parecía de juguete al lado.
    const s = 0.45 + rand() * 0.5;
    // Inclinación moderada y hundimiento proporcional al vuelco.
    //
    // Con ±0,5 rad y un hundimiento fijo de 0,2 m los troncos salían volando:
    // al inclinar un cilindro su base se levanta del suelo tanto más cuanto
    // mayor es el ángulo y la escala, así que el hundimiento tiene que
    // depender de ambos. Aquí el tronco mide 5,2 m: media altura por el seno
    // del vuelco es lo que hay que bajar para que el pie quede enterrado.
    const tiltX = (rand() - 0.5) * 0.34;
    const tiltZ = (rand() - 0.5) * 0.34;
    const vuelco = Math.hypot(tiltX, tiltZ);
    const hundir = 0.25 + 2.6 * s * Math.sin(vuelco);
    q.setFromEuler(new THREE.Euler(tiltX, rand() * Math.PI * 2, tiltZ));
    m4.compose(v3.set(x, heightAt(x, z) - hundir, z), q, v3.clone().set(s, s * (0.8 + rand() * 0.5), s));
    dead.setMatrixAt(nDead, m4);
    nDead++;
  }
  dead.count = nDead;
  dead.instanceMatrix.needsUpdate = true;
  dead.computeBoundingSphere();
  group.add(dead);

  // ───────────────────────── huesos tirados por el suelo
  const boneGeo = keep(
    mergeGeometries([
      tint(new THREE.CylinderGeometry(0.05, 0.05, 0.7, 5).rotateZ(Math.PI / 2), COL_HUESO),
      tint(new THREE.SphereGeometry(0.1, 6, 5).translate(0.36, 0, 0), COL_HUESO),
      tint(new THREE.SphereGeometry(0.1, 6, 5).translate(-0.36, 0, 0), COL_HUESO),
    ])!,
  );
  const BONES = 22;
  const bones = new THREE.InstancedMesh(boneGeo, keep(lambert()), BONES);
  bones.name = 'Ogro_Huesos';
  bones.castShadow = true;
  let nBones = 0;
  for (let i = 0; i < BONES * 5 && nBones < BONES; i++) {
    const a = rand() * Math.PI * 2;
    const r = 2.5 + rand() * (swampRadius * 1.25);
    const x = center.x + Math.cos(a) * r;
    const z = center.z + Math.sin(a) * r;
    // los huesos se amontonan cerca de la casa, no repartidos por el campo
    if (Math.hypot(x - hutX, z - hutZ) > swampRadius * 0.95) continue;
    if (heightAt(x, z) < level + 0.15) continue; // los huesos, en la orilla
    const s = 0.6 + rand() * 0.9;
    q.setFromEuler(new THREE.Euler(0, rand() * Math.PI * 2, (rand() - 0.5) * 0.3));
    m4.compose(v3.set(x, heightAt(x, z) + 0.05, z), q, v3.clone().setScalar(s));
    bones.setMatrixAt(nBones, m4);
    nBones++;
  }
  bones.count = nBones;
  bones.instanceMatrix.needsUpdate = true;
  bones.computeBoundingSphere();
  group.add(bones);

  // ───────────────────────── valla rota alrededor de la parcela
  const stakeGeo = keep(tint(new THREE.BoxGeometry(0.12, 1.5, 0.12).translate(0, 0.75, 0), COL_MADERA));
  const STAKES = 46;
  const stakes = new THREE.InstancedMesh(stakeGeo, keep(lambert()), STAKES);
  stakes.name = 'Ogro_Valla';
  stakes.castShadow = true;
  let nStakes = 0;
  const FENCE_R = swampRadius * 2.05;
  for (let i = 0; i < STAKES; i++) {
    const a = (i / STAKES) * Math.PI * 2;
    // una valla entera sería demasiado cuidada: faltan trozos
    if (rand() < 0.28) continue;
    const r = FENCE_R * (0.97 + rand() * 0.06);
    const x = center.x + Math.cos(a) * r;
    const z = center.z + Math.sin(a) * r;
    if (heightAt(x, z) < level + 0.2) continue; // ninguna estaca dentro del agua
    const s = 0.75 + rand() * 0.6;
    // igual que los troncos: al ladear una estaca su pie se despega del suelo
    const tx = (rand() - 0.5) * 0.26, tz = (rand() - 0.5) * 0.26;
    q.setFromEuler(new THREE.Euler(tx, rand() * Math.PI, tz));
    m4.compose(v3.set(x, heightAt(x, z) - 0.2 - 0.8 * s * Math.hypot(tx, tz), z), q, v3.clone().set(1, s, 1));
    stakes.setMatrixAt(nStakes, m4);
    nStakes++;
  }
  stakes.count = nStakes;
  stakes.instanceMatrix.needsUpdate = true;
  stakes.computeBoundingSphere();
  group.add(stakes);

  // ───────────────────────── recuento
  const meshes: THREE.Mesh[] = [hut, roof, chimney, deck, water, mud, reeds, dead, bones, stakes];
  let triangles = 0;
  for (const m of meshes) {
    const g = m.geometry;
    const t = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    const inst = m as THREE.InstancedMesh;
    triangles += t * (inst.isInstancedMesh ? inst.count : 1);
  }

  return {
    group,
    groundMeshes: [deck],
    doorway,
    swamp: { center: center.clone(), radius: swampRadius, level },
    stats: { triangles: Math.round(triangles), drawCalls: meshes.length },
    dispose() {
      for (const d of disposables) d.dispose();
      group.clear();
    },
  };
}
