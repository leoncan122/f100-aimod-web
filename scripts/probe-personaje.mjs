/**
 * Prueba de viabilidad: ¿se puede afinar al conductor sin tocar el esqueleto?
 *
 * No modifica nada del repo. Carga el glb, aplica las correcciones EN MEMORIA y
 * fotografía antes/después para poder decidir con evidencia.
 *
 * Dos cosas distintas, con riesgos distintos:
 *
 * 1. BLANCO SOBRE LA PIEL. Primero hay que saber de dónde sale. Si es el
 *    filtrado de mipmaps mezclando islas UV vecinas del atlas, se quita
 *    desactivando mipmaps. Si persiste, está pintado en la textura (error de
 *    proyección del escaneo) y hay que retocar el mapa.
 *
 * 2. PROPORCIONES. La vía segura es mover los VÉRTICES en bind pose hacia el
 *    eje de su hueso dominante, sin tocar huesos ni pesos: el esqueleto, el IK,
 *    las poses y las animaciones siguen exactamente igual porque no cambia
 *    ninguna longitud ósea — solo el volumen de carne alrededor. Escalar huesos
 *    sí rompería la biomecánica, así que no se prueba.
 *
 * Uso: node scripts/probe-personaje.mjs [baseUrl]
 */
import { DEFAULT_BASE, launch } from './lib/viewer.mjs';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] ?? DEFAULT_BASE;
const OUT = 'test-results/personaje-probe';
mkdirSync(OUT, { recursive: true });

const browser = await launch();

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 1100 });
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 300)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  const setup = await page.evaluate(async () => {
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

    let skin = null;
    gltf.scene.traverse((o) => { if (o.isSkinnedMesh && !skin) skin = o; });
    const geo = skin.geometry;
    // copia intacta, para poder volver al original entre pruebas
    const original = geo.getAttribute('position').array.slice();

    window.__p = { THREE, renderer, scene, camera, gltf, skin, original };

    // ── nombre del hueso dominante de cada vértice
    const J = geo.getAttribute('joints') ?? geo.getAttribute('JOINTS_0') ?? geo.getAttribute('skinIndex');
    const W = geo.getAttribute('weights') ?? geo.getAttribute('WEIGHTS_0') ?? geo.getAttribute('skinWeight');
    const bones = skin.skeleton.bones.map((b) => b.name);
    const dom = new Uint16Array(J.count);
    for (let i = 0; i < J.count; i++) {
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = W.getComponent(i, k);
        if (w > bw) { bw = w; best = J.getComponent(i, k); }
      }
      dom[i] = best;
    }
    window.__p.dom = dom;
    window.__p.bones = bones;

    // cuántos vértices manda cada hueso (para saber con qué se trabaja)
    const count = {};
    for (let i = 0; i < dom.length; i++) {
      const n = bones[dom[i]] ?? '?';
      count[n] = (count[n] ?? 0) + 1;
    }
    return {
      bones,
      top: Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 18),
      verts: J.count,
    };
  });

  console.log('huesos con más vértices asignados:');
  for (const [n, c] of setup.top) console.log(`  ${n.padEnd(14)} ${c}`);

  // ── disparo 1: ¿el blanco es de mipmaps o está en la textura?
  const shot = async (name, camPos, target, fov = 32) => {
    await page.evaluate(([p, t, f]) => {
      const { renderer, scene, camera } = window.__p;
      camera.fov = f;
      camera.position.set(...p);
      camera.lookAt(...t);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    }, [camPos, target, fov]);
    await page.screenshot({ path: `${OUT}/${name}.png` });
  };

  await shot('a1-original-hombro', [1.5, 1.42, 1.3], [0.12, 1.36, 0], 24);
  await shot('a2-original-frente', [0, 1.25, 2.6], [0, 1.15, 0]);

  // sin mipmaps: si el blanco del hombro desaparece, era filtrado del atlas
  await page.evaluate(() => {
    const { THREE, skin } = window.__p;
    const m = skin.material;
    if (m.map) {
      m.map.generateMipmaps = false;
      m.map.minFilter = THREE.LinearFilter;
      m.map.magFilter = THREE.LinearFilter;
      m.map.anisotropy = 1;
      m.map.needsUpdate = true;
      m.needsUpdate = true;
    }
  });
  await shot('b1-sin-mipmaps-hombro', [1.5, 1.42, 1.3], [0.12, 1.36, 0], 24);

  // ── disparo 2: adelgazado por vértices (esqueleto intacto)
  const medidas = await page.evaluate(() => {
    const { THREE, skin, original, dom, bones } = window.__p;
    const geo = skin.geometry;
    const P = geo.getAttribute('position');
    P.array.set(original); // partir siempre del original

    skin.skeleton.pose(); // bind pose
    skin.updateMatrixWorld(true);

    // eje del hueso en espacio de la malla: de su cabeza a la del hijo
    const inv = skin.matrixWorld.clone().invert();
    const ejes = new Map();
    for (const b of skin.skeleton.bones) {
      const a = b.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
      const hijo = b.children.find((c) => c.isBone);
      const c = hijo ? hijo.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv) : a.clone().add(new THREE.Vector3(0, 0.1, 0));
      ejes.set(b.name, { a, d: c.clone().sub(a) });
    }

    /**
     * Acerca el vértice al eje de su hueso en un factor k (0.9 = 10% más fino).
     * Como el esqueleto no se toca, el IK y las animaciones no se enteran.
     */
    const apretar = (nombres, k) => {
      const v = new THREE.Vector3(), p = new THREE.Vector3();
      let tocados = 0;
      for (let i = 0; i < P.count; i++) {
        const nb = bones[dom[i]];
        if (!nombres.includes(nb)) continue;
        const e = ejes.get(nb);
        if (!e) continue;
        v.set(P.getX(i), P.getY(i), P.getZ(i));
        const len2 = e.d.lengthSq() || 1e-9;
        const t = Math.max(0, Math.min(1, v.clone().sub(e.a).dot(e.d) / len2));
        p.copy(e.a).addScaledVector(e.d, t); // punto del eje más cercano
        v.sub(p).multiplyScalar(k).add(p);
        P.setXYZ(i, v.x, v.y, v.z);
        tocados++;
      }
      return tocados;
    };

    const n1 = apretar(['spine004', 'spine005', 'neck', 'head'], 0.9);
    const n2 = apretar(['upper_armL', 'upper_armR', 'forearmL', 'forearmR'], 0.86);
    const n3 = apretar(['shoulderL', 'shoulderR'], 0.93);
    P.needsUpdate = true;
    geo.computeVertexNormals();

    // medir ancho de una franja (solo cabeza/cuello, sin brazos: |z| acotado)
    const franja = (y0, y1, maxAbsZ = 1) => {
      let a = 1e9, b = -1e9;
      for (let i = 0; i < P.count; i++) {
        const y = P.getY(i);
        if (y < y0 || y > y1) continue;
        if (Math.abs(P.getZ(i)) > maxAbsZ) continue;
        const x = P.getX(i);
        if (x < a) a = x;
        if (x > b) b = x;
      }
      return +(b - a).toFixed(3);
    };
    return { n1, n2, n3, cabeza: franja(1.6, 1.75, 0.2), cuello: franja(1.46, 1.54, 0.15) };
  });
  console.log(`\nvertices movidos: cabeza/cuello ${medidas.n1} · brazos ${medidas.n2} · hombros ${medidas.n3}`);
  console.log(`tras afinar: cabeza ${medidas.cabeza} m · cuello ${medidas.cuello} m`);

  await shot('c1-afinado-frente', [0, 1.25, 2.6], [0, 1.15, 0]);
  await shot('c2-afinado-cabeza', [0, 1.6, 0.85], [0, 1.56, 0], 26);
  await shot('c3-afinado-perfil', [2.6, 1.25, 0], [0, 1.15, 0]);
  await shot('c4-afinado-torso', [0, 1.25, 1.5], [0, 1.25, 0], 30);

  console.log(`\ntomas en ${OUT}/`);
} finally {
  await browser.close();
}
