import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { loadGLTF, loadJSON, disposeObject, MODELS } from '../loaders';
import type { CameraTrack, ViewerMode } from '../types';

export interface CinematicDeps {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  hud: HTMLElement;
  onProgress: (pct: number, label: string) => void;
}

/**
 * Escena completa con la animación horneada desde Blender y el track de cámara
 * (posición, rotación y FOV horizontal por frame) leído de camara.json.
 */
export async function createCinematicMode(deps: CinematicDeps): Promise<ViewerMode> {
  const { renderer, camera, scene, hud, onProgress } = deps;

  renderer.toneMappingExposure = 1.0;
  // Neblina cálida de tarde: a contraluz el aire tira a dorado, no a gris azul.
  scene.fog = new THREE.Fog(0xdcb489, 130, 680);
  scene.background = null;

  // Cielo procedural: la iluminación de Cycles no se exporta en glTF, se recrea aquí.
  const sky = new Sky();
  sky.scale.setScalar(5000);
  scene.add(sky);

  // Golden hour de verano: el sol a ~7° sobre el horizonte (ángulo polar 83°).
  // A esa altura la luz atraviesa mucha más atmósfera, el azul se dispersa y
  // queda el naranja — de ahí la turbidez y el Mie altos.
  const SUN_ELEVATION = 11;
  const sun = new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - SUN_ELEVATION),
    THREE.MathUtils.degToRad(200),
  );
  sky.material.uniforms.turbidity.value = 7;
  sky.material.uniforms.rayleigh.value = 1.9;
  sky.material.uniforms.mieCoefficient.value = 0.008;
  sky.material.uniforms.mieDirectionalG.value = 0.84;
  sky.material.uniforms.sunPosition.value.copy(sun);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(sky.clone());
  const envRT = pmrem.fromScene(envScene);
  scene.environment = envRT.texture;

  // Rebote: cielo todavía azulado en el cenit, suelo devolviendo tono cálido.
  const hemi = new THREE.HemisphereLight(0xc6dbff, 0x5c5a32, 0.55);
  // Sol rasante y ámbar: la clave del look golden hour. Sin pasarse de
  // saturación, o el verde del paisaje desaparece bajo el naranja.
  const dir = new THREE.DirectionalLight(0xffc27a, 3.1);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  Object.assign(dir.shadow.camera, {
    left: -18,
    right: 18,
    top: 18,
    bottom: -18,
    near: 1,
    far: 120,
  });
  dir.shadow.camera.updateProjectionMatrix();
  dir.shadow.bias = -0.0004;
  dir.shadow.normalBias = 0.03;
  // Relleno frío desde el lado opuesto: evita que las sombras se vuelvan negras
  // al bajar tanto el sol, manteniendo el contraste cálido/frío de la hora dorada.
  const fill = new THREE.DirectionalLight(0x9ec0f0, 0.5);
  fill.position.copy(sun).multiplyScalar(-60).setY(35);
  scene.add(hemi, dir, dir.target, fill);

  onProgress(0, 'Cargando escena…');
  const [gltf, track] = await Promise.all([
    loadGLTF(MODELS.scene, (p) => onProgress(p, 'Cargando escena…')),
    loadJSON<CameraTrack>(MODELS.cameraTrack),
  ]);

  // Los prototipos de árbol de Geometry Nodes se exportan también como mallas
  // sueltas en el origen (0,0,0), que en esta escena cae justo sobre la
  // carretera: se veía un pino plantado en medio del asfalto. Las copias
  // distribuidas del bosque son otras mallas, así que borrar los prototipos no
  // quita vegetación del paisaje.
  gltf.scene.updateMatrixWorld(true);
  const strays: THREE.Object3D[] = [];
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const isTree = mats.some((m) => /Arbol/i.test((m as THREE.Material | undefined)?.name ?? ''));
    if (!isTree) return;
    const p = new THREE.Vector3();
    o.getWorldPosition(p);
    if (Math.hypot(p.x, p.z) < 2) strays.push(o);
  });
  for (const o of strays) {
    o.removeFromParent();
    disposeObject(o);
  }

  scene.add(gltf.scene);

  let truck: THREE.Object3D | null = null;
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh || (o as THREE.InstancedMesh).isInstancedMesh) {
      const big = o.name.startsWith('Paisaje') || o.name.startsWith('Lago');
      o.castShadow = !big;
      o.receiveShadow = true;
      const mat = mesh.material as THREE.MeshPhysicalMaterial | undefined;
      if (mat && !mat.transparent && (mat.transmission ?? 0) > 0) mat.transparent = true;
    }
    if (o.name === 'HandlerVehicle005' || o.name === 'HandlerVehicle.005') truck = o;
    // El agua procedural de Blender no se exporta: material físico equivalente.
    if (mesh.isMesh && o.name.startsWith('Lago')) {
      mesh.material = new THREE.MeshPhysicalMaterial({
        color: 0x1f5a7a,
        roughness: 0.3,
        metalness: 0,
        envMapIntensity: 0.45,
      });
    }
  });

  // Cada objeto trae su acción horneada como clip independiente: todos en una línea de tiempo.
  const mixer = new THREE.AnimationMixer(gltf.scene);
  for (const clip of gltf.animations) mixer.clipAction(clip).play();

  const { fps, frames } = track;
  const nf = frames.length;
  const duration = nf / fps;

  // ────────── recorrido del camión, muestreado una sola vez
  // La cámara trasera necesita el rumbo del vehículo. Derivarlo del movimiento
  // fotograma a fotograma falla en pausa (delta 0) y se invierte al arrastrar la
  // barra hacia atrás, así que el camino se muestrea aquí y luego solo se
  // consulta: estable en reproducción, en pausa y al hacer scrub.
  const PATH_SAMPLES = 480;
  const path: THREE.Vector3[] = [];
  if (truck) {
    const tmp = new THREE.Vector3();
    for (let i = 0; i <= PATH_SAMPLES; i++) {
      mixer.setTime((i / PATH_SAMPLES) * duration);
      gltf.scene.updateMatrixWorld(true);
      (truck as THREE.Object3D).getWorldPosition(tmp);
      path.push(tmp.clone());
    }
    mixer.setTime(0);
  }

  /** Rumbo horizontal normalizado del camión en el instante `time`. */
  const headingAt = (time: number, out: THREE.Vector3) => {
    if (path.length < 2) return out.set(0, 0, 1);
    const f = THREE.MathUtils.clamp(time / duration, 0, 1) * PATH_SAMPLES;
    const i = THREE.MathUtils.clamp(Math.round(f), 1, PATH_SAMPLES - 1);
    out.copy(path[i + 1]!).sub(path[i - 1]!);
    out.y = 0;
    return out.lengthSq() < 1e-8 ? out.set(0, 0, 1) : out.normalize();
  };

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enabled = false;
  controls.enableDamping = true;

  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();

  function applyCam(t: number) {
    const fr = Math.min(nf - 1.0001, Math.max(0, t * fps));
    const i = Math.floor(fr);
    const k = fr - i;
    const a = frames[i]!;
    const b = frames[Math.min(nf - 1, i + 1)]!;
    pa.set(a[0]!, a[1]!, a[2]!);
    pb.set(b[0]!, b[1]!, b[2]!);
    camera.position.lerpVectors(pa, pb, k);
    qa.set(a[3]!, a[4]!, a[5]!, a[6]!);
    qb.set(b[3]!, b[4]!, b[5]!, b[6]!);
    camera.quaternion.slerpQuaternions(qa, qb, k);
    const hfov = a[7]! + (b[7]! - a[7]!) * k;
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / camera.aspect));
    camera.updateProjectionMatrix();
  }

  // ---- HUD
  hud.innerHTML = `
    <button id="play" class="btn">⏸ Pausa</button>
    <button id="cam" class="btn" title="Cambiar cámara (tecla C)">Cámara: cinemática</button>
    <input id="seek" type="range" min="0" max="1" step="0.0001" value="0">
    <span id="time" class="time">0.0 s</span>
  `;
  const playBtn = hud.querySelector<HTMLButtonElement>('#play')!;
  const camBtn = hud.querySelector<HTMLButtonElement>('#cam')!;
  const seek = hud.querySelector<HTMLInputElement>('#seek')!;
  const timeEl = hud.querySelector<HTMLSpanElement>('#time')!;

  type CamId = 'cinematica' | 'trasera' | 'libre';
  const CAMS: CamId[] = ['cinematica', 'trasera', 'libre'];
  const CAM_LABEL: Record<CamId, string> = {
    cinematica: 'cinemática',
    trasera: 'trasera',
    libre: 'libre',
  };
  let cam: CamId = 'cinematica';

  let playing = true;
  let t = 0;

  playBtn.onclick = () => {
    playing = !playing;
    playBtn.textContent = playing ? '⏸ Pausa' : '▶ Play';
  };
  seek.oninput = () => {
    t = Number(seek.value) * duration;
  };
  camBtn.onclick = () => {
    cam = CAMS[(CAMS.indexOf(cam) + 1) % CAMS.length]!;
    camBtn.textContent = `Cámara: ${CAM_LABEL[cam]}`;
    camBtn.classList.toggle('on', cam !== 'cinematica');
    controls.enabled = cam === 'libre';
    if (cam === 'libre') {
      const p = new THREE.Vector3();
      (truck ?? gltf.scene).getWorldPosition(p);
      controls.target.copy(p);
    }
    if (cam === 'trasera') {
      // al entrar, colocar la cámara ya en su sitio (sin barrido desde el track)
      chaseInit = true;
      // el track cinemático manipula el FOV; la trasera usa el suyo propio
      camera.fov = CHASE_FOV;
      camera.updateProjectionMatrix();
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      e.preventDefault();
      playBtn.click();
    }
    if (e.key.toLowerCase() === 'c') camBtn.click();
  };
  window.addEventListener('keydown', onKey);

  const tp = new THREE.Vector3();

  // ────────── cámara trasera recta
  // Mismo planteamiento que la "persecución" del modo Desierto: detrás y algo
  // por encima del vehículo, mirando en su mismo sentido de marcha. Aquí el
  // camino curva, así que la posición se toma sobre el rumbo muestreado y se
  // suaviza con lerp para que los giros no den tirones.
  const CHASE_BACK = 9.5; // m por detrás del camión
  const CHASE_UP = 3.2; // m por encima
  const CHASE_AHEAD = 12; // m por delante, hacia donde mira
  const CHASE_FOV = 46;
  const CHASE_SNAP_DIST = 18; // m: por encima de esto se recoloca sin suavizar
  let chaseInit = false;
  const heading = new THREE.Vector3();
  const chasePos = new THREE.Vector3();
  const chaseLook = new THREE.Vector3();

  const applyChase = (dt: number) => {
    if (!truck) return;
    (truck as THREE.Object3D).getWorldPosition(tp);
    headingAt(t, heading);
    chasePos.copy(tp).addScaledVector(heading, -CHASE_BACK).setY(tp.y + CHASE_UP);
    // El suavizado solo tiene sentido en reproducción continua. Al arrastrar la
    // barra el camión salta decenas de metros y el lerp se queda rezagado (y en
    // pausa nunca llega a alcanzarlo), así que ante cualquier salto grande — o
    // estando en pausa — la cámara se coloca de golpe.
    const jumped = camera.position.distanceToSquared(chasePos) > CHASE_SNAP_DIST ** 2;
    if (chaseInit || jumped || !playing) {
      camera.position.copy(chasePos);
      chaseInit = false;
    } else {
      // suavizado independiente del framerate
      camera.position.lerp(chasePos, 1 - Math.pow(0.0008, dt));
    }
    chaseLook.copy(tp).addScaledVector(heading, CHASE_AHEAD).setY(tp.y + 1.1);
    camera.lookAt(chaseLook);
    if (camera.fov !== CHASE_FOV) {
      camera.fov = CHASE_FOV;
      camera.updateProjectionMatrix();
    }
  };

  return {
    id: 'cinematic',
    update(dt) {
      if (playing) {
        t += dt;
        if (t > duration) t = 0;
      }
      mixer.setTime(t);
      if (cam === 'libre') controls.update();
      else if (cam === 'trasera') applyChase(dt);
      else applyCam(t);

      if (truck) {
        (truck as THREE.Object3D).getWorldPosition(tp);
        dir.position.copy(tp).addScaledVector(sun, 60);
        dir.target.position.copy(tp);
      }
      seek.value = String(t / duration);
      timeEl.textContent = `${t.toFixed(1)} / ${duration.toFixed(0)} s`;
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
      controls.dispose();
      mixer.stopAllAction();
      scene.remove(gltf.scene, sky, hemi, dir, dir.target, fill);
      disposeObject(gltf.scene);
      sky.geometry.dispose();
      (sky.material as THREE.Material).dispose();
      envRT.texture.dispose();
      pmrem.dispose();
      scene.environment = null;
      scene.fog = null;
      hud.innerHTML = '';
    },
  };
}
