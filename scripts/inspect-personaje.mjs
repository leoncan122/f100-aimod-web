/**
 * Primeros planos del conductor para diagnosticar su aspecto.
 *
 * Lo carga aislado (sin la escena ni la camioneta), con luz neutra y la pose en
 * reposo, y lo fotografía de frente, de perfil y de tres cuartos, más un detalle
 * de cabeza/cuello y otro de brazos. Sirve para juzgar proporciones y para ver
 * dónde invade el blanco de la camiseta la piel.
 *
 * También vuelca la textura baseColor a PNG: el sangrado de color suele estar
 * en el mapa, no en la geometría, y conviene mirarlo aparte.
 *
 * Uso: node scripts/inspect-personaje.mjs [baseUrl]
 */
import { DEFAULT_BASE, launch } from './lib/viewer.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const OUT = 'test-results/personaje';
mkdirSync(OUT, { recursive: true });

const browser = await launch();

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1100, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 300)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  // Visor propio: el personaje solo, luz suave de estudio y fondo gris medio
  // (ni blanco ni negro, para ver bien dónde acaba la camiseta).
  const info = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
    const { DRACOLoader } = await import('/node_modules/three/examples/jsm/loaders/DRACOLoader.js');
    const draco = new DRACOLoader().setDecoderPath(
      'https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/draco/gltf/',
    );
    const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync('/models/personaje.glb');

    document.body.innerHTML = '';
    document.body.style.margin = '0';
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(900, 1100);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    document.body.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x6a6f75);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x555860, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(2, 3, 3);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-2.5, 1.5, -1.5);
    scene.add(fill);
    scene.add(gltf.scene);

    const camera = new THREE.PerspectiveCamera(32, 900 / 1100, 0.01, 50);
    window.__rig = { THREE, renderer, scene, camera, gltf };

    // medidas de la malla en reposo, por franjas de altura
    let skin = null;
    gltf.scene.traverse((o) => { if (o.isSkinnedMesh && !skin) skin = o; });
    const pos = skin.geometry.getAttribute('position');
    const band = (y0, y1) => {
      let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9, n = 0;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (y < y0 || y > y1) continue;
        const x = pos.getX(i), z = pos.getZ(i);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        n++;
      }
      return { ancho: +(maxX - minX).toFixed(3), fondo: +(maxZ - minZ).toFixed(3), verts: n };
    };
    // media anchura del brazo a la altura del bíceps, solo el lado +X
    const brazo = (y0, y1) => {
      let minX = 1e9, maxX = -1e9;
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i), x = pos.getX(i);
        if (y < y0 || y > y1 || x < 0.12) continue;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
      }
      return { desde: +minX.toFixed(3), hasta: +maxX.toFixed(3), grosor: +(maxX - minX).toFixed(3) };
    };
    const huesos = [];
    gltf.scene.traverse((o) => { if (o.isBone) huesos.push(o.name); });

    return {
      huesos: huesos.length,
      nombresHueso: huesos.slice(0, 40),
      verts: pos.count,
      // franjas aproximadas sobre una figura de 1.80 m
      cabeza: band(1.54, 1.78),
      cuello: band(1.44, 1.54),
      hombros: band(1.36, 1.46),
      pecho: band(1.15, 1.36),
      cintura: band(0.98, 1.12),
      bicepsDer: brazo(1.18, 1.34),
      antebrazoDer: brazo(0.95, 1.1),
    };
  });

  console.log('malla:', info.verts, 'vertices ·', info.huesos, 'huesos');
  console.log('\nmedidas en reposo (metros, figura de 1.80 m):');
  for (const k of ['cabeza', 'cuello', 'hombros', 'pecho', 'cintura']) {
    const b = info[k];
    console.log(`  ${k.padEnd(9)} ancho ${b.ancho}  fondo ${b.fondo}`);
  }
  console.log(`  biceps    grosor ${info.bicepsDer.grosor} (de x=${info.bicepsDer.desde} a ${info.bicepsDer.hasta})`);
  console.log(`  antebrazo grosor ${info.antebrazoDer.grosor}`);
  console.log('\nhuesos:', info.nombresHueso.join(' '));

  // referencias anatómicas para comparar
  const r = info;
  console.log('\nproporciones (referencia humana entre parentesis):');
  console.log(`  ancho cabeza / altura   ${(r.cabeza.ancho / 1.8).toFixed(3)}  (~0.085)`);
  console.log(`  ancho cuello / cabeza   ${(r.cuello.ancho / r.cabeza.ancho).toFixed(2)}   (~0.72)`);
  console.log(`  ancho hombros / cabeza  ${(r.hombros.ancho / r.cabeza.ancho).toFixed(2)}   (~2.6 con brazos)`);

  // ── tomas
  const shots = [
    { name: '1-frente', pos: [0, 1.25, 2.6], target: [0, 1.15, 0], fov: 32 },
    { name: '2-perfil', pos: [2.6, 1.25, 0], target: [0, 1.15, 0], fov: 32 },
    { name: '3-tres-cuartos', pos: [1.8, 1.3, 1.9], target: [0, 1.15, 0], fov: 32 },
    { name: '4-cabeza-cuello', pos: [0, 1.6, 0.85], target: [0, 1.56, 0], fov: 26 },
    { name: '5-cabeza-perfil', pos: [0.85, 1.6, 0.1], target: [0, 1.56, 0], fov: 26 },
    { name: '6-torso-brazos', pos: [0, 1.25, 1.5], target: [0, 1.25, 0], fov: 30 },
    { name: '7-espalda', pos: [0, 1.25, -2.6], target: [0, 1.15, 0], fov: 32 },
  ];
  for (const s of shots) {
    await page.evaluate((s) => {
      const { renderer, scene, camera } = window.__rig;
      camera.fov = s.fov;
      camera.position.set(...s.pos);
      camera.lookAt(...s.target);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    }, s);
    await page.screenshot({ path: `${OUT}/${s.name}.png` });
  }

  // ── textura baseColor a PNG, para mirar el mapa aparte
  const tex = await page.evaluate(() => {
    let img = null;
    window.__rig.gltf.scene.traverse((o) => {
      const m = o.material;
      if (m?.map?.image && !img) img = m.map.image;
    });
    if (!img) return null;
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return { w: img.width, h: img.height, data: c.toDataURL('image/png') };
  });
  if (tex) {
    writeFileSync(`${OUT}/textura.png`, Buffer.from(tex.data.split(',')[1], 'base64'));
    console.log(`\ntextura baseColor: ${tex.w}x${tex.h} -> ${OUT}/textura.png`);
  }
  console.log(`tomas en ${OUT}/`);
} finally {
  await browser.close();
}
