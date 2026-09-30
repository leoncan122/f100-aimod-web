import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadGLTF } from '../loaders';
import { extractVehicle } from '../vehicle';
import type { ViewerMode } from '../types';

export interface DesertDeps {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  hud: HTMLElement;
  onProgress: (pct: number, label: string) => void;
}

const DURATION = 15; // s — duración exacta del bucle
const SPEED = 22; // m/s (~80 km/h)
const DISTANCE = DURATION * SPEED; // 330 m de recta
const ROAD_HALF = 4.2; // semiancho del asfalto
const CURB_W = 0.9;
const MARGIN = 160; // holgura de terreno delante y detrás
const ROAD_Y = 0.02; // el asfalto va 2 cm sobre el terreno (evita z-fighting)

const COL_SAND = 0x8a3a1c;
const COL_SAND_DARK = 0x51200f;
const COL_ASPHALT = 0x101018;
const COL_CURB = 0x8d8275;
const COL_CACTUS = 0x3d6236;

/**
 * Recta de desierto al anochecer, generada íntegramente con three.js.
 * Del glb solo se usa la camioneta (módulo compartido `extractVehicle`).
 *
 * Presupuesto de escenario: cielo 1 · estrellas 1 · luna 2 · suelo 1 ·
 * asfalto 1 · líneas 1 · bordillos 1 · cactus 1 · piedras 1 = 10 draw calls.
 * Sin objetos duplicados: cactus, piedras y bordillos son InstancedMesh que
 * comparten una geometría y un material.
 */
export async function createDesertMode(deps: DesertDeps): Promise<ViewerMode> {
  const { renderer, camera, scene, hud, onProgress } = deps;

  renderer.toneMappingExposure = 1.15;
  scene.background = new THREE.Color(0x0b1026);
  scene.fog = new THREE.Fog(0x241d3a, 70, 340);

  const junk: { dispose: () => void }[] = [];
  const keep = <T extends { dispose: () => void }>(x: T): T => {
    junk.push(x);
    return x;
  };

  // ───────────────────────── cielo del anochecer (gradiente en shader)
  const sky = new THREE.Mesh(
    keep(new THREE.SphereGeometry(900, 32, 16)),
    keep(
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          cTop: { value: new THREE.Color(0x05081a) },
          cMid: { value: new THREE.Color(0x2b2350) },
          cBot: { value: new THREE.Color(0x8c4a3a) },
        },
        vertexShader: [
          'varying float vH;',
          'void main() {',
          '  vec4 wp = modelMatrix * vec4(position, 1.0);',
          '  vH = normalize(wp.xyz).y;',
          '  gl_Position = projectionMatrix * viewMatrix * wp;',
          '}',
        ].join('\n'),
        fragmentShader: [
          'uniform vec3 cTop, cMid, cBot;',
          'varying float vH;',
          'void main() {',
          '  float h = clamp(vH, -1.0, 1.0);',
          '  vec3 c = h > 0.06',
          '    ? mix(cMid, cTop, smoothstep(0.06, 0.55, h))',
          '    : mix(cBot, cMid, smoothstep(-0.25, 0.06, h));',
          '  gl_FragColor = vec4(c, 1.0);',
          '}',
        ].join('\n'),
      }),
    ),
  );
  sky.renderOrder = -2;
  scene.add(sky);

  // ───────────────────────── estrellas (un solo Points)
  const STARS = 800;
  const starPos = new Float32Array(STARS * 3);
  for (let i = 0; i < STARS; i++) {
    const u = Math.random() * Math.PI * 2;
    const v = Math.acos(Math.random() * 0.9 + 0.05);
    starPos[i * 3] = 820 * Math.sin(v) * Math.cos(u);
    starPos[i * 3 + 1] = 820 * Math.cos(v) * 0.85 + 40;
    starPos[i * 3 + 2] = 820 * Math.sin(v) * Math.sin(u);
  }
  const starGeo = keep(new THREE.BufferGeometry());
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(
    starGeo,
    keep(
      new THREE.PointsMaterial({
        color: 0xcfe0ff,
        size: 2.2,
        sizeAttenuation: false,
        fog: false,
      }),
    ),
  );
  stars.renderOrder = -2;
  scene.add(stars);

  // ───────────────────────── luna grande y redonda + halo
  const MOON_DIR = new THREE.Vector3(-0.45, 0.26, -1).normalize();
  const moonPos = MOON_DIR.clone().multiplyScalar(640);

  const moon = new THREE.Mesh(
    keep(new THREE.SphereGeometry(48, 48, 32)),
    keep(new THREE.MeshBasicMaterial({ color: 0xf6f3e6, fog: false })),
  );
  moon.position.copy(moonPos);
  moon.renderOrder = -1;
  scene.add(moon);

  const halo = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(340, 340)),
    keep(
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
        uniforms: { tint: { value: new THREE.Color(0x9fb6ff) } },
        vertexShader: [
          'varying vec2 vUv;',
          'void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        ].join('\n'),
        fragmentShader: [
          'uniform vec3 tint; varying vec2 vUv;',
          'void main(){',
          '  float d = length(vUv - 0.5) * 2.0;',
          '  gl_FragColor = vec4(tint, pow(max(0.0, 1.0 - d), 3.0) * 0.5);',
          '}',
        ].join('\n'),
      }),
    ),
  );
  halo.position.copy(moonPos);
  halo.renderOrder = -1;
  scene.add(halo);

  // ───────────────────────── luces
  const moonLight = new THREE.DirectionalLight(0xbcd2ff, 3.2);
  moonLight.position.copy(MOON_DIR).multiplyScalar(90);
  moonLight.castShadow = true;
  moonLight.shadow.mapSize.set(1024, 1024);
  const sc = moonLight.shadow.camera;
  sc.left = -16;
  sc.right = 16;
  sc.top = 16;
  sc.bottom = -16;
  sc.near = 1;
  sc.far = 220;
  sc.updateProjectionMatrix();
  moonLight.shadow.bias = -0.0006;
  moonLight.shadow.normalBias = 0.02;
  scene.add(moonLight, moonLight.target);

  // Rebote suave: cielo frío arriba, tierra roja abajo. Intensidad contenida
  // para no lavar el asfalto — el protagonismo es de la luna.
  const bounce = new THREE.HemisphereLight(0x3a4a86, COL_SAND_DARK, 0.6);
  scene.add(bounce);

  // último rescoldo del ocaso, opuesto a la luna
  const dusk = new THREE.DirectionalLight(0xff8f5a, 0.55);
  dusk.position.set(60, 7, 70);
  scene.add(dusk, dusk.target);

  // ───────────────────────── suelo: tierra roja
  const ground = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(1200, DISTANCE + MARGIN * 2, 1, 1)),
    keep(
      new THREE.MeshStandardMaterial({
        color: COL_SAND,
        roughness: 0.96,
        metalness: 0,
      }),
    ),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.z = -DISTANCE / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // ───────────────────────── asfalto
  const road = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(ROAD_HALF * 2, DISTANCE + MARGIN * 2)),
    keep(new THREE.MeshStandardMaterial({ color: COL_ASPHALT, roughness: 0.72, metalness: 0.05 })),
  );
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, 0.02, -DISTANCE / 2);
  road.receiveShadow = true;
  scene.add(road);

  // ───────────────────────── líneas discontinuas centrales
  // Una sola geometría fusionada manualmente: N segmentos -> 1 draw call.
  const DASH_LEN = 3;
  const DASH_GAP = 5;
  const totalLen = DISTANCE + MARGIN * 2;
  const dashCount = Math.floor(totalLen / (DASH_LEN + DASH_GAP));
  const dashPos = new Float32Array(dashCount * 6 * 3);
  const dashUv = new Float32Array(dashCount * 6 * 2);
  const hw = 0.12;
  for (let i = 0; i < dashCount; i++) {
    const z0 = MARGIN - i * (DASH_LEN + DASH_GAP);
    const z1 = z0 - DASH_LEN;
    const quad = [
      [-hw, z0], [hw, z0], [hw, z1],
      [-hw, z0], [hw, z1], [-hw, z1],
    ];
    for (let k = 0; k < 6; k++) {
      const o = (i * 6 + k) * 3;
      dashPos[o] = quad[k]![0]!;
      dashPos[o + 1] = 0;
      dashPos[o + 2] = quad[k]![1]!;
      dashUv[(i * 6 + k) * 2] = 0;
      dashUv[(i * 6 + k) * 2 + 1] = 0;
    }
  }
  const dashGeo = keep(new THREE.BufferGeometry());
  dashGeo.setAttribute('position', new THREE.BufferAttribute(dashPos, 3));
  dashGeo.setAttribute('uv', new THREE.BufferAttribute(dashUv, 2));
  dashGeo.computeVertexNormals();
  const dashes = new THREE.Mesh(
    dashGeo,
    keep(
      new THREE.MeshStandardMaterial({
        color: 0xd8d2b8,
        roughness: 0.85,
        emissive: 0x2a2616,
      }),
    ),
  );
  dashes.position.set(0, 0.035, -DISTANCE / 2 + 0);
  dashes.position.z = 0;
  scene.add(dashes);

  // ───────────────────────── acera / bordillo (InstancedMesh, ambos lados)
  const CURB_SEG = 4; // longitud de cada bloque
  const curbPerSide = Math.ceil(totalLen / CURB_SEG);
  const curbCount = curbPerSide * 2;
  const curbGeo = keep(new THREE.BoxGeometry(CURB_W, 0.28, CURB_SEG * 0.97));
  const curbMat = keep(
    new THREE.MeshStandardMaterial({ color: COL_CURB, roughness: 0.9, metalness: 0 }),
  );
  const curbs = new THREE.InstancedMesh(curbGeo, curbMat, curbCount);
  curbs.castShadow = true;
  curbs.receiveShadow = true;
  const m4 = new THREE.Matrix4();
  for (let s = 0; s < 2; s++) {
    const x = (s === 0 ? -1 : 1) * (ROAD_HALF + CURB_W / 2);
    for (let i = 0; i < curbPerSide; i++) {
      const z = MARGIN - i * CURB_SEG - CURB_SEG / 2;
      m4.makeTranslation(x, 0.14, z);
      curbs.setMatrixAt(s * curbPerSide + i, m4);
    }
  }
  curbs.instanceMatrix.needsUpdate = true;
  scene.add(curbs);

  // ───────────────────────── cactus (una geometría, InstancedMesh)
  // Saguaro: tronco + dos brazos, fusionados en un único BufferGeometry.
  function buildCactusGeometry(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const trunk = new THREE.CylinderGeometry(0.26, 0.32, 3.6, 10, 1);
    trunk.translate(0, 1.8, 0);
    parts.push(trunk);

    const arm = (side: number, lift: number) => {
      const out: THREE.BufferGeometry[] = [];
      const h = new THREE.CylinderGeometry(0.15, 0.17, 0.95, 8, 1);
      h.rotateZ(Math.PI / 2);
      h.translate(side * 0.55, 1.9 + lift, 0);
      out.push(h);
      const up = new THREE.CylinderGeometry(0.14, 0.16, 1.25, 8, 1);
      up.translate(side * 1.0, 2.5 + lift, 0);
      out.push(up);
      const cap = new THREE.SphereGeometry(0.14, 8, 6);
      cap.translate(side * 1.0, 3.12 + lift, 0);
      out.push(cap);
      return out;
    };
    parts.push(...arm(1, 0.15), ...arm(-0.85, -0.25));

    const top = new THREE.SphereGeometry(0.26, 10, 8);
    top.translate(0, 3.6, 0);
    parts.push(top);

    // Fusión manual: primero desindexar, LUEGO medir (toNonIndexed expande el
    // número de vértices; dimensionar con el conteo indexado desborda el buffer).
    const flat = parts.map((p) => {
      const n = p.toNonIndexed();
      p.dispose();
      return n;
    });
    let vTotal = 0;
    for (const f of flat) vTotal += f.attributes.position!.count;

    const pos = new Float32Array(vTotal * 3);
    const nor = new Float32Array(vTotal * 3);
    let off = 0;
    for (const f of flat) {
      const pa = f.attributes.position! as THREE.BufferAttribute;
      const na = f.attributes.normal! as THREE.BufferAttribute;
      pos.set(pa.array as Float32Array, off * 3);
      nor.set(na.array as Float32Array, off * 3);
      off += pa.count;
      f.dispose();
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.computeBoundingSphere();
    return g;
  }

  const cactusGeo = keep(buildCactusGeometry());
  const cactusMat = keep(
    new THREE.MeshStandardMaterial({ color: COL_CACTUS, roughness: 0.85, metalness: 0 }),
  );
  const CACTI = 90;
  const cacti = new THREE.InstancedMesh(cactusGeo, cactusMat, CACTI);
  cacti.castShadow = true;
  cacti.receiveShadow = true;

  // PRNG con semilla: reproducible entre recargas (y entre capturas de test).
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const q = new THREE.Quaternion();
  const sv = new THREE.Vector3();
  const pv = new THREE.Vector3();
  for (let i = 0; i < CACTI; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const off = ROAD_HALF + CURB_W + 2.5 + rnd() * 26;
    const s = 0.65 + rnd() * 0.85;
    const sy = s * (0.85 + rnd() * 0.4);
    // -0.15 hunde ligeramente la base: evita que floten sobre el terreno
    pv.set(side * off, -0.15, MARGIN - rnd() * (totalLen - 4));
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
    sv.set(s, sy, s);
    m4.compose(pv, q, sv);
    cacti.setMatrixAt(i, m4);
  }
  cacti.instanceMatrix.needsUpdate = true;
  scene.add(cacti);

  // ───────────────────────── piedras dispersas (InstancedMesh)
  const rockGeo = keep(new THREE.DodecahedronGeometry(0.5, 0));
  const rockMat = keep(
    new THREE.MeshStandardMaterial({ color: 0x5b3a2a, roughness: 1, metalness: 0 }),
  );
  const ROCKS = 140;
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, ROCKS);
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  for (let i = 0; i < ROCKS; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const off = ROAD_HALF + CURB_W + 0.6 + rnd() * 34;
    pv.set(side * off, 0.05, MARGIN - rnd() * (totalLen - 4));
    q.setFromEuler(new THREE.Euler(rnd() * 3, rnd() * 3, rnd() * 3));
    const s = 0.2 + rnd() * 0.5;
    sv.set(s, s * 0.7, s);
    m4.compose(pv, q, sv);
    rocks.setMatrixAt(i, m4);
  }
  rocks.instanceMatrix.needsUpdate = true;
  scene.add(rocks);

  // ───────────────────────── IBL nocturno
  // Sin envMap, metalness alto se ve negro: los metales solo reflejan el
  // entorno. Se genera una vez desde el propio domo de cielo + luna con PMREM
  // (una sola textura compartida por todos los materiales, coste puntual).
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(sky.geometry, sky.material);
  const envMoon = new THREE.Mesh(moon.geometry, moon.material);
  envMoon.position.copy(moonPos);
  envScene.add(envSky, envMoon);
  const envRT = pmrem.fromScene(envScene, 0.1);
  scene.environment = envRT.texture;
  envScene.clear();

  // ───────────────────────── camioneta
  onProgress(0, 'Cargando camioneta…');
  const gltf = await loadGLTF('f100.glb', (p) => onProgress(p, 'Cargando camioneta…'));
  const { root: truck, wheels, wheelRadius } = extractVehicle(gltf);

  // Realce nocturno: la chapa debe captar el brillo de la luna.
  truck.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const m = mat as THREE.MeshStandardMaterial;
      if (!m || !m.isMeshStandardMaterial) continue;
      m.envMapIntensity = 1.6;
      // pintura y cromados más especulares bajo la luz lunar
      if (/Pintura|Chrome/i.test(m.name)) {
        m.roughness = Math.min(m.roughness, /Chrome/i.test(m.name) ? 0.12 : 0.28);
        m.metalness = Math.max(m.metalness, /Chrome/i.test(m.name) ? 0.95 : 0.55);
      }
    }
  });
  truck.rotation.y = 0; // el modelo mira hacia -Z, que es el sentido de marcha
  scene.add(truck);

  // Faros: dos conos de luz. SpotLight sin sombras (coste bajo) + dos discos
  // emisivos como "cristal" encendido, instanciados en una sola malla.
  const makeHeadlight = (x: number) => {
    const sp = new THREE.SpotLight(0xffe7c2, 26, 55, Math.PI / 7, 0.45, 1.4);
    sp.position.set(x, 0.85, -2.25);
    sp.target.position.set(x * 1.2, 0.1, -22);
    truck.add(sp, sp.target);
    return sp;
  };
  const hlL = makeHeadlight(-0.62);
  const hlR = makeHeadlight(0.62);

  const glowGeo = keep(new THREE.CircleGeometry(0.17, 16));
  const glowMat = keep(
    new THREE.MeshBasicMaterial({ color: 0xfff0d0, fog: false, side: THREE.DoubleSide }),
  );
  const glows = new THREE.InstancedMesh(glowGeo, glowMat, 2);
  for (let i = 0; i < 2; i++) {
    m4.makeTranslation(i === 0 ? -0.62 : 0.62, 0.86, -2.3);
    glows.setMatrixAt(i, m4);
  }
  glows.instanceMatrix.needsUpdate = true;
  truck.add(glows);

  // Pilotos traseros
  const tailGeo = keep(new THREE.CircleGeometry(0.11, 12));
  const tailMat = keep(new THREE.MeshBasicMaterial({ color: 0xff2a1a, fog: false }));
  const tails = new THREE.InstancedMesh(tailGeo, tailMat, 2);
  for (let i = 0; i < 2; i++) {
    m4.makeTranslation(i === 0 ? -0.72 : 0.72, 0.92, 2.42);
    m4.multiply(new THREE.Matrix4().makeRotationY(Math.PI));
    tails.setMatrixAt(i, m4);
  }
  tails.instanceMatrix.needsUpdate = true;
  truck.add(tails);

  // ───────────────────────── controles / cámara
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.enabled = false;

  camera.fov = 42;
  camera.near = 0.2;
  camera.far = 2000;
  camera.updateProjectionMatrix();

  type CamId = 'persecucion' | 'lateral' | 'cofre' | 'libre';
  let cam: CamId = 'persecucion';

  // ───────────────────────── animación
  let t = 0;
  let playing = true;
  // Circunferencia a partir del radio REAL medido en el rig (≈0.37 m), no de
  // una constante: con un radio inflado las ruedas patinan visiblemente.
  const wheelCirc = 2 * Math.PI * wheelRadius;

  const truckPos = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const desired = new THREE.Vector3();

  hud.innerHTML = [
    '<button id="play" class="btn">⏸ Pausa</button>',
    '<button id="cam" class="btn">Cámara: persecución</button>',
    '<input id="seek" type="range" min="0" max="1" step="0.0001" value="0">',
    '<span id="time" class="time">0.0 / 15 s</span>',
  ].join('');
  const playBtn = hud.querySelector<HTMLButtonElement>('#play')!;
  const camBtn = hud.querySelector<HTMLButtonElement>('#cam')!;
  const seek = hud.querySelector<HTMLInputElement>('#seek')!;
  const timeEl = hud.querySelector<HTMLSpanElement>('#time')!;

  const CAMS: CamId[] = ['persecucion', 'lateral', 'cofre', 'libre'];
  const CAM_LABEL: Record<CamId, string> = {
    persecucion: 'persecución',
    lateral: 'lateral',
    cofre: 'capó',
    libre: 'libre',
  };
  playBtn.onclick = () => {
    playing = !playing;
    playBtn.textContent = playing ? '⏸ Pausa' : '▶ Play';
  };
  seek.oninput = () => {
    t = Number(seek.value) * DURATION;
  };
  camBtn.onclick = () => {
    cam = CAMS[(CAMS.indexOf(cam) + 1) % CAMS.length]!;
    camBtn.textContent = `Cámara: ${CAM_LABEL[cam]}`;
    controls.enabled = cam === 'libre';
    if (cam === 'libre') controls.target.copy(truckPos);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      e.preventDefault();
      playBtn.click();
    }
    if (e.key.toLowerCase() === 'c') camBtn.click();
  };
  window.addEventListener('keydown', onKey);

  return {
    id: 'desert',
    update(dt) {
      if (playing) {
        t += dt;
        if (t >= DURATION) t -= DURATION; // bucle exacto de 15 s
      }

      // Recorrido: de +MARGIN/2 hacia -DISTANCE, velocidad constante.
      const z = MARGIN * 0.5 - (t / DURATION) * DISTANCE;
      // bamboleo sutil de suspensión; ROAD_Y apoya los neumáticos sobre el
      // asfalto (está 2 cm por encima del terreno), no sobre el terreno.
      // Bamboleo de suspensión: oscila en [0, 4 mm] — nunca negativo (hundiría
      // los neumáticos) y de amplitud pequeña, o el coche parece flotar.
      const bob = ((Math.sin(t * 7.3) + Math.sin(t * 3.1) * 0.6) * 0.5 + 0.8) * 0.0025;
      truck.position.set(0, ROAD_Y + bob, z);
      // Balanceo lateral mínimo. Cada radián inclina el eje (ancho ~2.1 m), lo
      // que eleva una rueda ~1.05 m·sen(θ); con 0.0025 rad son 2.6 mm, dentro
      // del margen del bamboleo, así que ninguna rueda despega del asfalto.
      truck.rotation.z = Math.sin(t * 2.7) * 0.0025;
      truckPos.copy(truck.position);

      // ruedas: giro real según distancia recorrida
      const spin = ((t * SPEED) / wheelCirc) * Math.PI * 2;
      for (const w of wheels) w.rotation.x = -spin;

      // la sombra sigue al coche (shadow camera pequeña = sombras nítidas)
      moonLight.position.set(truckPos.x, 0, truckPos.z).addScaledVector(MOON_DIR, 90);
      moonLight.target.position.copy(truckPos);
      dusk.position.set(truckPos.x + 60, 7, truckPos.z + 70);
      dusk.target.position.copy(truckPos);

      // el domo y la luna acompañan a la cámara: horizonte siempre lejano
      sky.position.set(0, 0, truckPos.z);
      stars.position.set(0, 0, truckPos.z);
      moon.position.copy(moonPos).add(new THREE.Vector3(0, 0, truckPos.z));
      halo.position.copy(moon.position);
      halo.quaternion.copy(camera.quaternion);

      switch (cam) {
        case 'persecucion':
          desired.set(0, 3.4, truckPos.z + 13.5);
          camera.position.lerp(desired, 1 - Math.pow(0.0015, dt));
          lookAt.set(0, 1.0, truckPos.z - 12);
          camera.lookAt(lookAt);
          break;
        case 'lateral':
          desired.set(9.5, 1.5, truckPos.z + 1.5);
          camera.position.lerp(desired, 1 - Math.pow(0.002, dt));
          lookAt.copy(truckPos).setY(1.0);
          camera.lookAt(lookAt);
          break;
        case 'cofre':
          camera.position.set(0.55, 1.62, truckPos.z - 1.1);
          lookAt.set(0.1, 1.15, truckPos.z - 18);
          camera.lookAt(lookAt);
          break;
        case 'libre':
          controls.target.lerp(truckPos, 1 - Math.pow(0.001, dt));
          controls.update();
          break;
      }

      seek.value = String(t / DURATION);
      timeEl.textContent = `${t.toFixed(1)} / ${DURATION} s`;
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
      controls.dispose();
      scene.remove(sky, stars, moon, halo, ground, road, dashes, curbs, cacti, rocks, truck);
      scene.remove(moonLight, moonLight.target, bounce, dusk, dusk.target);
      hlL.dispose?.();
      hlR.dispose?.();
      truck.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry?.dispose();
        for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          if (!mat) continue;
          for (const v of Object.values(mat)) {
            if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
          }
          mat.dispose();
        }
      });
      curbs.dispose();
      cacti.dispose();
      rocks.dispose();
      glows.dispose();
      tails.dispose();
      envRT.texture.dispose();
      pmrem.dispose();
      scene.environment = null;
      for (const d of junk) d.dispose();
      scene.fog = null;
      hud.innerHTML = '';
    },
  };
}

// duración del bucle, expuesta para tests
export const DESERT_DURATION = DURATION;
