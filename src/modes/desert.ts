import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadGLTF, MODELS } from '../loaders';
import { extractVehicle } from '../vehicle';
import { createCameraPeek } from '../camera-peek';
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
const SHOULDER = 0.9; // banquina: separación mínima de la vegetación al asfalto
const EDGE_INSET = 0.3; // distancia del borde del asfalto a la línea blanca
const EDGE_W = 0.18; // ancho de la línea blanca lateral
const MARGIN = 160; // holgura de terreno delante y detrás
const ROAD_Y = 0.02; // el asfalto va 2 cm sobre el terreno (evita z-fighting)

const COL_SAND = 0x8a3a1c;
const COL_SAND_DARK = 0x51200f;
const COL_ASPHALT = 0x3c3936; // asfalto viejo, gris parduzco (no negro brillante)
const COL_CACTUS = 0x3d6236;

/**
 * Texturas procedurales de asfalto viejo (albedo + rugosidad + normales).
 *
 * Se generan en un canvas 512×512 sin ficheros externos: grano grueso, parches
 * de bacheo, grietas y roderas desgastadas. La rugosidad se deriva del mismo
 * grano y se mantiene muy alta (0.82–1.0) para que el camino NO brille: un
 * asfalto envejecido es prácticamente lambertiano.
 */
function buildAsphaltTextures(repeatY: number): {
  map: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
} {
  const S = 512;
  // PRNG con semilla propia: textura idéntica en cada recarga y en los tests.
  let s = 20260101;
  const r = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  const make = () => {
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    return { c, x: c.getContext('2d')! };
  };

  // ── albedo
  const { c: albedo, x: a } = make();
  // El tono del asfalto lo define la textura (el material va en blanco), así
  // que el gris base es ya el color final: hormigón asfáltico envejecido.
  a.fillStyle = `#${COL_ASPHALT.toString(16).padStart(6, '0')}`;
  a.fillRect(0, 0, S, S);

  // parches de bacheo (rectángulos algo más claros/oscuros, bordes difusos)
  for (let i = 0; i < 26; i++) {
    const w = 40 + r() * 150;
    const h = 30 + r() * 120;
    const l = 24 + r() * 26;
    a.globalAlpha = 0.16 + r() * 0.22;
    a.fillStyle = `rgb(${l},${l - 2},${l - 4})`;
    a.fillRect(r() * S - w / 2, r() * S - h / 2, w, h);
  }
  a.globalAlpha = 1;

  // grano: piedrecillas del árido
  const img = a.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * 38;
    d[i] = Math.max(0, Math.min(255, d[i]! + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1]! + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2]! + n * 0.9));
  }
  a.putImageData(img, 0, 0);

  // roderas: dos bandas desgastadas y algo más claras donde pasan las ruedas
  for (const cx of [S * 0.3, S * 0.7]) {
    const g = a.createLinearGradient(cx - 46, 0, cx + 46, 0);
    g.addColorStop(0, 'rgba(120,114,105,0)');
    g.addColorStop(0.5, 'rgba(120,114,105,0.16)');
    g.addColorStop(1, 'rgba(120,114,105,0)');
    a.fillStyle = g;
    a.fillRect(cx - 46, 0, 92, S);
  }

  // grietas: polilíneas oscuras, algunas ramificadas
  a.lineCap = 'round';
  for (let i = 0; i < 34; i++) {
    a.strokeStyle = `rgba(14,13,12,${0.35 + r() * 0.45})`;
    a.lineWidth = 0.7 + r() * 1.9;
    let px = r() * S;
    let py = r() * S;
    a.beginPath();
    a.moveTo(px, py);
    const steps = 4 + Math.floor(r() * 8);
    for (let k = 0; k < steps; k++) {
      px += (r() - 0.5) * 60;
      py += (r() - 0.5) * 60;
      a.lineTo(px, py);
    }
    a.stroke();
  }

  // ── rugosidad: SOLO valores altos. Three.js lee el canal verde y lo
  // multiplica por `roughness`; pintar aquí el albedo (oscuro) bajaría la
  // rugosidad y convertiría el camino en un espejo — justo lo que hay que
  // evitar. Rango 235–255 → roughness 0.92–1.0: mate en toda la superficie.
  const { c: rough, x: q } = make();
  const rImg = q.createImageData(S, S);
  const rd = rImg.data;
  for (let i = 0; i < rd.length; i += 4) {
    const v = 235 + Math.floor(r() * 21);
    rd[i] = rd[i + 1] = rd[i + 2] = v;
    rd[i + 3] = 255;
  }
  q.putImageData(rImg, 0, 0);

  // ── normales: Sobel sobre la luminancia del albedo (relieve del árido)
  const { c: normal, x: n } = make();
  const nImg = n.createImageData(S, S);
  const nd = nImg.data;
  const lum = (px: number, py: number) => {
    const i = ((py & (S - 1)) * S + (px & (S - 1))) * 4;
    return (d[i]! * 0.3 + d[i + 1]! * 0.59 + d[i + 2]! * 0.11) / 255;
  };
  const STRENGTH = 2.2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (lum(x + 1, y) - lum(x - 1, y)) * STRENGTH;
      const dy = (lum(x, y + 1) - lum(x, y - 1)) * STRENGTH;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * S + x) * 4;
      nd[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      nd[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      nd[i + 2] = (1 / len) * 0.5 * 255 + 127.5;
      nd[i + 3] = 255;
    }
  }
  n.putImageData(nImg, 0, 0);

  const tex = (canvas: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1, repeatY);
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };

  return {
    map: tex(albedo, true),
    roughnessMap: tex(rough, false),
    normalMap: tex(normal, false),
  };
}

/**
 * Recta de desierto al anochecer, generada íntegramente con three.js.
 * Del glb solo se usa la camioneta (módulo compartido `extractVehicle`).
 *
 * Presupuesto de escenario: cielo 1 · estrellas 1 · luna 2 · suelo 1 ·
 * asfalto 1 · líneas centrales 1 · líneas de borde 1 · cactus 1 · piedras 1 =
 * 10 draw calls. Sin objetos duplicados: cactus y piedras son InstancedMesh
 * que comparten una geometría y un material; las líneas se fusionan a mano.
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
  // La dirección horizontal de la luna se adapta al encuadre: en móvil el FOV
  // horizontal se estrecha muchísimo (la vertical es la fija), así que un
  // offset X fijo la empujaba fuera de cuadro. Se calcula como una fracción
  // del semiángulo horizontal real para que quede siempre dentro, desplazada
  // hacia la izquierda pero visible.
  const MOON_DIST = 640;
  const MOON_R = 48; // radio de la geometría; en pantallas estrechas se escala
  const MOON_Y = 0.26; // altura deseada sobre el horizonte (tangente)
  // Las cámaras fijas miran algo hacia abajo (~0.1 rad), lo que sube la luna en
  // pantalla; se descuenta al calcular cuánto sitio queda por arriba.
  const MOON_PITCH = 0.1;
  const MOON_PAD = 0.03; // margen libre entre el disco y el borde del encuadre
  const moonPos = new THREE.Vector3();
  const MOON_DIR = new THREE.Vector3(-0.3, MOON_Y, -1).normalize();
  let moonScale = 1;

  /**
   * Reencuadra la luna según la relación de aspecto actual.
   *
   * En móvil el FOV horizontal se estrecha mucho (el fijo es el vertical), así
   * que el desplazamiento fijo en X la sacaba de cuadro por el lateral. Aquí
   * tanto el desplazamiento como el tamaño del disco se expresan como fracción
   * del semiángulo horizontal real: la luna queda siempre entera y a la
   * izquierda, más pequeña cuanto más estrecho es el encuadre.
   */
  const updateMoonDir = () => {
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const tanH = tanV * camera.aspect;
    const x = tanH * 0.45;
    // el disco ocupa como mucho el 30 % del semiancho visible
    moonScale = Math.min(1, (tanH * MOON_DIST * 0.3) / MOON_R);
    // ...y su borde superior nunca rebasa el encuadre (radio angular incluido)
    const angR = (MOON_R * moonScale) / MOON_DIST;
    const y = Math.max(0.08, Math.min(MOON_Y, tanV - angR - MOON_PAD - MOON_PITCH));
    MOON_DIR.set(-x, y, -1).normalize();
    moonPos.copy(MOON_DIR).multiplyScalar(MOON_DIST);
  };
  // el fov definitivo se fija más abajo; se recalcula allí y en cada resize
  updateMoonDir();

  const moon = new THREE.Mesh(
    keep(new THREE.SphereGeometry(MOON_R, 48, 32)),
    keep(new THREE.MeshBasicMaterial({ color: 0xf6f3e6, fog: false })),
  );
  moon.position.copy(moonPos);
  moon.scale.setScalar(moonScale);
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
  halo.scale.setScalar(moonScale);
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
  const bounce = new THREE.HemisphereLight(0x3a4a86, COL_SAND_DARK, 0.25);
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

  // ───────────────────────── asfalto viejo
  // La textura se repite a lo largo de Z una vez cada 8 m: a esa escala el
  // grano queda del tamaño real del árido sin que se note el tiling.
  const ROAD_LEN = DISTANCE + MARGIN * 2;
  const asphalt = buildAsphaltTextures(ROAD_LEN / 8);
  keep(asphalt.map);
  keep(asphalt.roughnessMap);
  keep(asphalt.normalMap);
  const road = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(ROAD_HALF * 2, ROAD_LEN)),
    keep(
      new THREE.MeshStandardMaterial({
        // Blanco: el tono lo aporta íntegramente la textura de asfalto viejo.
        color: 0xffffff,
        map: asphalt.map,
        roughnessMap: asphalt.roughnessMap,
        normalMap: asphalt.normalMap,
        normalScale: new THREE.Vector2(0.45, 0.45),
        // Asfalto envejecido: mate y sin componente metálica, y con el reflejo
        // del entorno anulado — antes el camino espejeaba la luna y el cielo.
        roughness: 1,
        metalness: 0,
        envMapIntensity: 0,
      }),
    ),
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

  // ───────────────────────── líneas blancas continuas de borde
  // Sustituyen a los antiguos bloques/bordillos laterales: solo dos franjas
  // planas que delimitan el asfalto. Ambas van en una única geometría → 1 draw
  // call, y a 0.5 cm sobre el asfalto para evitar z-fighting.
  const edgePos = new Float32Array(2 * 6 * 3);
  const edgeUv = new Float32Array(2 * 6 * 2);
  const z0 = MARGIN;
  const z1 = MARGIN - totalLen;
  for (let s = 0; s < 2; s++) {
    const cx = (s === 0 ? -1 : 1) * (ROAD_HALF - EDGE_INSET - EDGE_W / 2);
    const xa = cx - EDGE_W / 2;
    const xb = cx + EDGE_W / 2;
    const quad = [
      [xa, z0], [xb, z0], [xb, z1],
      [xa, z0], [xb, z1], [xa, z1],
    ];
    for (let k = 0; k < 6; k++) {
      const o = (s * 6 + k) * 3;
      edgePos[o] = quad[k]![0]!;
      edgePos[o + 1] = 0;
      edgePos[o + 2] = quad[k]![1]!;
    }
  }
  const edgeGeo = keep(new THREE.BufferGeometry());
  edgeGeo.setAttribute('position', new THREE.BufferAttribute(edgePos, 3));
  edgeGeo.setAttribute('uv', new THREE.BufferAttribute(edgeUv, 2));
  edgeGeo.computeVertexNormals();
  const edgeLines = new THREE.Mesh(
    edgeGeo,
    keep(
      new THREE.MeshStandardMaterial({
        color: 0xe8e4d6,
        roughness: 0.92,
        metalness: 0,
        emissive: 0x26231a,
        envMapIntensity: 0.1,
      }),
    ),
  );
  edgeLines.position.y = 0.035;
  scene.add(edgeLines);

  const m4 = new THREE.Matrix4();

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
    const off = ROAD_HALF + SHOULDER + 2.5 + rnd() * 26;
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
    const off = ROAD_HALF + SHOULDER + 0.6 + rnd() * 34;
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
  const gltf = await loadGLTF(MODELS.truck, (p) => onProgress(p, 'Cargando camioneta…'));
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
  // Intensidad alta y penumbra baja: el haz debe llegar lejos y marcarse sobre
  // el asfalto mate, que ya no devuelve brillo especular.
  const makeHeadlight = (x: number) => {
    const sp = new THREE.SpotLight(0xffe9c8, 95, 110, Math.PI / 5.6, 0.32, 1.1);
    sp.position.set(x, 0.85, -2.25);
    sp.target.position.set(x * 1.2, 0.1, -30);
    truck.add(sp, sp.target);
    return sp;
  };
  const hlL = makeHeadlight(-0.62);
  const hlR = makeHeadlight(0.62);

  // Derrame cercano: ilumina el asfalto justo delante del paragolpes, donde el
  // cono de los faros aún no ha abierto.
  const hlFill = new THREE.PointLight(0xffe3b4, 14, 16, 1.6);
  hlFill.position.set(0, 0.7, -3.4);
  truck.add(hlFill);

  const glowGeo = keep(new THREE.CircleGeometry(0.17, 16));
  const glowMat = keep(
    new THREE.MeshBasicMaterial({ color: 0xfffaf0, fog: false, side: THREE.DoubleSide }),
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

  // ───────────────────────── iluminación ambiente de la camioneta
  // La cámara de persecución mira la trasera del vehículo, que es la cara
  // opuesta a la luna: sin esto queda casi en silueta.
  //
  // Luz ambiente de la misma tonalidad cálida que los faros: baña el modelo por
  // igual desde todas las direcciones, así que levanta la zaga y los bajos sin
  // brillos ni una dirección de luz que compita con la luna.
  //
  // OJO: no se puede confinar con `layers`. three.js descarta las luces
  // comparándolas con las capas de la CÁMARA, no con las de cada objeto, así que
  // una luz fuera de la capa de la cámara no ilumina nada en absoluto. Al ser
  // global hay que compensar: el rebote hemisférico baja para que la arena y las
  // sombras del desierto conserven el contraste nocturno.
  const truckAmbient = new THREE.AmbientLight(0xffe3b4, 0.8);
  scene.add(truckAmbient);

  // ───────────────────────── controles / cámara
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.enabled = false;

  // Asomarse arrastrando: orbita alrededor de la camioneta mientras se mantiene
  // pulsado y vuelve al encuadre al soltar. En la cámara libre se desactiva,
  // porque ahí manda OrbitControls.
  const peek = createCameraPeek({
    camera,
    domElement: renderer.domElement,
    pivot: () => truckPeekTarget,
    minHeight: 0.6,
  });

  camera.fov = 42;
  camera.near = 0.2;
  camera.far = 2000;
  camera.updateProjectionMatrix();
  updateMoonDir();
  moon.scale.setScalar(moonScale);
  halo.scale.setScalar(moonScale);
  let lastAspect = camera.aspect;

  type CamId = 'persecucion' | 'lateral' | 'cofre' | 'libre';
  let cam: CamId = 'persecucion';

  // ───────────────────────── animación
  let t = 0;
  let playing = true;
  // Circunferencia a partir del radio REAL medido en el rig (≈0.37 m), no de
  // una constante: con un radio inflado las ruedas patinan visiblemente.
  const wheelCirc = 2 * Math.PI * wheelRadius;

  const truckPos = new THREE.Vector3();
  // pivote del peek: centro aproximado de la camioneta, no sus ruedas
  const truckPeekTarget = new THREE.Vector3();
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
    peek.setEnabled(cam !== 'libre');
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
      // Devuelve la cámara a su pose sin desviar antes de recalcularla: las
      // cámaras de este modo interpolan desde su posición actual, así que leer la
      // pose ya desviada por el peek realimentaría el desvío.
      peek.begin();

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
      // si cambia el encuadre (resize / rotar el móvil) se reencuadra la luna
      if (camera.aspect !== lastAspect) {
        lastAspect = camera.aspect;
        updateMoonDir();
        moon.scale.setScalar(moonScale);
        halo.scale.setScalar(moonScale);
      }
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

      // El peek va al final, cuando la cámara ya está colocada: toma esa pose
      // como base y le superpone el desvío del arrastre.
      truckPeekTarget.copy(truckPos).setY(truckPos.y + 1.1);
      peek.apply(dt);

      seek.value = String(t / DURATION);
      timeEl.textContent = `${t.toFixed(1)} / ${DURATION} s`;
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
      peek.dispose();
      controls.dispose();
      scene.remove(sky, stars, moon, halo, ground, road, dashes, edgeLines, cacti, rocks, truck);
      scene.remove(moonLight, moonLight.target, bounce, dusk, dusk.target);
      scene.remove(truckAmbient);
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
