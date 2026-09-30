import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { loadGLTF, disposeObject } from './../loaders';
import { extractVehicle } from '../vehicle';
import type { ViewerMode } from './../types';

export interface OrbitDeps {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  hud: HTMLElement;
  onProgress: (pct: number, label: string) => void;
}

/** Inspección orbital de la camioneta sola, con IBL de estudio. */
export async function createOrbitMode(deps: OrbitDeps): Promise<ViewerMode> {
  const { renderer, camera, scene, hud, onProgress } = deps;

  renderer.toneMappingExposure = 1.0;
  scene.background = new THREE.Color(0x11131a);
  scene.fog = null;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0005;
  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x2a2a2a, 0.6);
  scene.add(key, hemi);

  const grid = new THREE.GridHelper(40, 40, 0x445066, 0x222833);
  const gridMat = grid.material as THREE.Material;
  gridMat.transparent = true;
  gridMat.opacity = 0.35;
  scene.add(grid);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.ShadowMaterial({ opacity: 0.35 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.maxPolarAngle = Math.PI * 0.495;

  onProgress(0, 'Cargando camioneta…');
  const gltf = await loadGLTF('f100.glb', (p) => onProgress(p, 'Cargando camioneta…'));

  // f100.glb trae la escena completa (~843 m): se extrae solo el vehículo.
  const { root: model } = extractVehicle(gltf);

  function frame() {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    model.position.sub(center);
    model.position.y += size.y / 2;

    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    camera.fov = 45;
    const dist = maxDim / 2 / Math.tan((camera.fov * Math.PI) / 360);

    camera.position.set(dist * 1.1, maxDim * 0.65, dist * 1.4);
    camera.near = maxDim / 1000;
    camera.far = maxDim * 100;
    camera.updateProjectionMatrix();

    controls.target.set(0, size.y / 2, 0);
    controls.maxDistance = maxDim * 10;
    controls.update();

    grid.scale.setScalar(maxDim / 8);
    key.position.set(maxDim, maxDim * 2, maxDim);
    Object.assign(key.shadow.camera, {
      left: -maxDim,
      right: maxDim,
      top: maxDim,
      bottom: -maxDim,
      far: maxDim * 10,
    });
    key.shadow.camera.updateProjectionMatrix();
    return { size, maxDim };
  }

  const { size } = frame();
  scene.add(model);

  // En modo inspección solo interesan las piezas mecánicas girando en el sitio.
  // Los clips del nodo raíz (HandlerVehicle.005), la cámara y los controles de
  // carrocería trasladan el vehículo por el paisaje y rompen el encuadre.
  const MECH = /^(ROT_Rueda_|PIV_Dir_|Rueda_)/;
  const clips = gltf.animations.filter((c) => {
    const target = c.name || c.tracks[0]?.name?.split('.')[0] || '';
    return MECH.test(target);
  });
  const mixer = clips.length ? new THREE.AnimationMixer(model) : null;
  if (mixer) for (const clip of clips) mixer.clipAction(clip).play();

  hud.innerHTML = `
    <button id="rot" class="btn">Auto-rotar</button>
    <button id="wire" class="btn">Wireframe</button>
    <button id="fit" class="btn">Encuadrar (F)</button>
    <span id="dims" class="time"></span>
  `;
  const rotBtn = hud.querySelector<HTMLButtonElement>('#rot')!;
  const wireBtn = hud.querySelector<HTMLButtonElement>('#wire')!;
  const fitBtn = hud.querySelector<HTMLButtonElement>('#fit')!;
  hud.querySelector<HTMLSpanElement>('#dims')!.textContent =
    `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m`;

  controls.autoRotateSpeed = 1.2;
  rotBtn.onclick = () => {
    controls.autoRotate = !controls.autoRotate;
    rotBtn.classList.toggle('on', controls.autoRotate);
  };

  let wire = false;
  wireBtn.onclick = () => {
    wire = !wire;
    wireBtn.classList.toggle('on', wire);
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) (m as THREE.MeshStandardMaterial).wireframe = wire;
    });
  };
  fitBtn.onclick = () => frame();

  const onKey = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (k === 'f') frame();
    if (k === 'r') rotBtn.click();
  };
  window.addEventListener('keydown', onKey);

  return {
    id: 'orbit',
    update(dt) {
      mixer?.update(dt);
      controls.update();
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
      controls.dispose();
      scene.remove(model, grid, ground, key, hemi);
      disposeObject(model);
      grid.geometry.dispose();
      gridMat.dispose();
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
      envRT.texture.dispose();
      pmrem.dispose();
      scene.environment = null;
      hud.innerHTML = '';
    },
  };
}
