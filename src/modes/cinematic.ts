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

  renderer.toneMappingExposure = 0.9;
  scene.fog = new THREE.Fog(0xb9c6d3, 120, 650);
  scene.background = null;

  // Cielo procedural: la iluminación de Cycles no se exporta en glTF, se recrea aquí.
  const sky = new Sky();
  sky.scale.setScalar(5000);
  scene.add(sky);

  const sun = new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(58),
    THREE.MathUtils.degToRad(200),
  );
  sky.material.uniforms.turbidity.value = 6;
  sky.material.uniforms.rayleigh.value = 1.6;
  sky.material.uniforms.mieCoefficient.value = 0.004;
  sky.material.uniforms.sunPosition.value.copy(sun);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(sky.clone());
  const envRT = pmrem.fromScene(envScene);
  scene.environment = envRT.texture;

  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x4a5a3a, 0.6);
  const dir = new THREE.DirectionalLight(0xfff1dc, 2.6);
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
  scene.add(hemi, dir, dir.target);

  onProgress(0, 'Cargando escena…');
  const [gltf, track] = await Promise.all([
    loadGLTF(MODELS.scene, (p) => onProgress(p, 'Cargando escena…')),
    loadJSON<CameraTrack>(MODELS.cameraTrack),
  ]);

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
    <button id="free" class="btn" title="Orbitar con el ratón">Cámara libre</button>
    <input id="seek" type="range" min="0" max="1" step="0.0001" value="0">
    <span id="time" class="time">0.0 s</span>
  `;
  const playBtn = hud.querySelector<HTMLButtonElement>('#play')!;
  const freeBtn = hud.querySelector<HTMLButtonElement>('#free')!;
  const seek = hud.querySelector<HTMLInputElement>('#seek')!;
  const timeEl = hud.querySelector<HTMLSpanElement>('#time')!;

  let playing = true;
  let free = false;
  let t = 0;

  playBtn.onclick = () => {
    playing = !playing;
    playBtn.textContent = playing ? '⏸ Pausa' : '▶ Play';
  };
  seek.oninput = () => {
    t = Number(seek.value) * duration;
  };
  freeBtn.onclick = () => {
    free = !free;
    freeBtn.classList.toggle('on', free);
    controls.enabled = free;
    if (free) {
      const p = new THREE.Vector3();
      (truck ?? gltf.scene).getWorldPosition(p);
      controls.target.copy(p);
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      e.preventDefault();
      playBtn.click();
    }
  };
  window.addEventListener('keydown', onKey);

  const tp = new THREE.Vector3();

  return {
    id: 'cinematic',
    update(dt) {
      if (playing) {
        t += dt;
        if (t > duration) t = 0;
      }
      mixer.setTime(t);
      if (free) controls.update();
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
      scene.remove(gltf.scene, sky, hemi, dir, dir.target);
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
