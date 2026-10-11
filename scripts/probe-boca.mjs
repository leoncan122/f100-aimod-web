/**
 * ¿El afinado por vértices rompe la boca o el hit-test?
 *
 * `character.ts` selecciona los vértices de la boca con coordenadas ABSOLUTAS
 * (`y < 1.44`, `|x| > 0.13`, `MOUTH.y = 1.579`) y el hit-test usa un cilindro
 * de radio 0.28 m. Si al adelgazar la cabeza esos vértices se salen de las
 * ventanas, los morphs dejarían de coger la boca y el personaje hablaría sin
 * mover los labios. Esto lo mide antes de tocar el repo.
 *
 * Uso: node scripts/probe-boca.mjs [baseUrl]
 */
import { DEFAULT_BASE, launch } from './lib/viewer.mjs';

const BASE = process.argv[2] ?? DEFAULT_BASE;

const browser = await launch();
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[PAGEERROR]', e.message.slice(0, 200)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  const out = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js');
    const { GLTFLoader } = await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
    const { DRACOLoader } = await import('/node_modules/three/examples/jsm/loaders/DRACOLoader.js');
    const draco = new DRACOLoader().setDecoderPath(
      'https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/libs/draco/gltf/',
    );
    const gltf = await new GLTFLoader().setDRACOLoader(draco).loadAsync('/models/personaje.glb');
    let skin = null;
    gltf.scene.traverse((o) => { if (o.isSkinnedMesh && !skin) skin = o; });
    const geo = skin.geometry;
    const P = geo.getAttribute('position');
    const orig = P.array.slice();

    const J = geo.getAttribute('skinIndex'), W = geo.getAttribute('skinWeight');
    const bones = skin.skeleton.bones.map((b) => b.name);
    const dom = new Uint16Array(J.count);
    for (let i = 0; i < J.count; i++) {
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) { const w = W.getComponent(i, k); if (w > bw) { bw = w; best = J.getComponent(i, k); } }
      dom[i] = best;
    }

    // mismos criterios que character.ts para la boca
    const MOUTH_Y = 1.579;
    const contarBoca = () => {
      let enVentana = 0, conPeso = 0;
      for (let i = 0; i < P.count; i++) {
        const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
        if (y < 1.44 || z < 0 || Math.abs(x) > 0.13) continue;
        enVentana++;
        // el peso wj del morph 'jaw' (la parte que de verdad abre la mandibula)
        const ss = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
        const ax = Math.abs(x - 0.006);
        const wj = ss(MOUTH_Y + 0.0015, MOUTH_Y - 0.004, y) * ss(0.03, 0.075, z) * (1 - ss(0.07, 0.095, ax)) * ss(1.475, 1.52, y);
        if (wj > 0.01) conPeso++;
      }
      return { enVentana, conPeso };
    };
    const radioMax = () => {
      let r = 0;
      for (let i = 0; i < P.count; i++) {
        const d = Math.hypot(P.getX(i), P.getZ(i));
        if (d > r) r = d;
      }
      return +r.toFixed(3);
    };
    const alturaOjos = () => {
      // punto mas alto de la cabeza, para ver que no se hunde
      let y = -1e9;
      for (let i = 0; i < P.count; i++) y = Math.max(y, P.getY(i));
      return +y.toFixed(4);
    };

    const antes = { ...contarBoca(), alto: alturaOjos(), radio: radioMax() };

    // aplicar el mismo afinado de la prueba
    skin.skeleton.pose();
    skin.updateMatrixWorld(true);
    const inv = skin.matrixWorld.clone().invert();
    const ejes = new Map();
    for (const b of skin.skeleton.bones) {
      const a = b.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
      const h = b.children.find((c) => c.isBone);
      const c = h ? h.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv) : a.clone().add(new THREE.Vector3(0, 0.1, 0));
      ejes.set(b.name, { a, d: c.clone().sub(a) });
    }
    const apretar = (nombres, k) => {
      const v = new THREE.Vector3(), p = new THREE.Vector3();
      for (let i = 0; i < P.count; i++) {
        const nb = bones[dom[i]];
        if (!nombres.includes(nb)) continue;
        const e = ejes.get(nb);
        if (!e) continue;
        v.set(P.getX(i), P.getY(i), P.getZ(i));
        const t = Math.max(0, Math.min(1, v.clone().sub(e.a).dot(e.d) / (e.d.lengthSq() || 1e-9)));
        p.copy(e.a).addScaledVector(e.d, t);
        v.sub(p).multiplyScalar(k).add(p);
        P.setXYZ(i, v.x, v.y, v.z);
      }
    };
    apretar(['spine004', 'spine005', 'neck', 'head'], 0.9);
    apretar(['upper_armL', 'upper_armR', 'forearmL', 'forearmR'], 0.86);
    apretar(['shoulderL', 'shoulderR'], 0.93);
    P.needsUpdate = true;

    const despues = { ...contarBoca(), alto: alturaOjos(), radio: radioMax() };
    P.array.set(orig);
    return { antes, despues };
  });

  const { antes, despues } = out;
  const pct = (a, b) => `${(((b - a) / (a || 1)) * 100).toFixed(1)}%`;
  console.log('vertices de la boca dentro de la ventana de character.ts:');
  console.log(`  en ventana (y>1.44, z>0, |x|<0.13):  ${antes.enVentana} -> ${despues.enVentana}  (${pct(antes.enVentana, despues.enVentana)})`);
  console.log(`  con peso real de mandibula (wj>.01): ${antes.conPeso} -> ${despues.conPeso}  (${pct(antes.conPeso, despues.conPeso)})`);
  console.log(`altura total: ${antes.alto} -> ${despues.alto} m`);
  console.log(`radio maximo en planta: ${antes.radio} -> ${despues.radio} m  (hit-test usa 0.28)`);

  const ok = despues.conPeso > antes.conPeso * 0.85;
  console.log(ok
    ? '\nOK: la boca conserva sus vertices, los morphs siguen funcionando'
    : '\nATENCION: se pierden vertices de boca; habria que reajustar MOUTH en character.ts');
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
