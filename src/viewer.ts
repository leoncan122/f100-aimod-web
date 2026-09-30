import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export interface ViewerHandle {
  dispose: () => void;
}

const MODEL_URL = `${import.meta.env.BASE_URL}models/f100-aimod_web.glb`;

export function createViewer(container: HTMLElement, statusEl: HTMLElement): ViewerHandle {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x11131a);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(
    45,
    container.clientWidth / container.clientHeight,
    0.01,
    2000,
  );
  camera.position.set(6, 3, 8);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.maxPolarAngle = Math.PI * 0.495;

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(5, 10, 7);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0005;
  scene.add(key);
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x2a2a2a, 0.6));

  const grid = new THREE.GridHelper(40, 40, 0x445066, 0x222833);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.35;
  scene.add(grid);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.ShadowMaterial({ opacity: 0.35 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  let model: THREE.Object3D | null = null;

  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);

  statusEl.textContent = 'Cargando modelo…';
  loader.load(
    MODEL_URL,
    (gltf) => {
      model = gltf.scene;
      model.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        }
      });
      frameObject(model);
      scene.add(model);
      statusEl.textContent = '';
      statusEl.classList.add('hidden');
    },
    (evt) => {
      if (evt.total) {
        statusEl.textContent = `Cargando modelo… ${Math.round((evt.loaded / evt.total) * 100)}%`;
      } else {
        statusEl.textContent = `Cargando modelo… ${(evt.loaded / 1024 / 1024).toFixed(1)} MB`;
      }
    },
    (err) => {
      console.error(err);
      statusEl.textContent =
        'No se pudo cargar public/models/f100-aimod_web.glb. Exporta el .blend a glTF y colócalo ahí.';
    },
  );

  function frameObject(obj: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    obj.position.sub(center);
    obj.position.y += size.y / 2;

    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const dist = (maxDim / 2) / Math.tan((camera.fov * Math.PI) / 360);

    camera.position.set(dist * 1.1, maxDim * 0.65, dist * 1.4);
    camera.near = maxDim / 1000;
    camera.far = maxDim * 100;
    camera.updateProjectionMatrix();

    controls.target.set(0, size.y / 2, 0);
    controls.maxDistance = maxDim * 10;
    controls.update();

    grid.scale.setScalar(maxDim / 8);
    key.position.set(maxDim, maxDim * 2, maxDim);
    key.shadow.camera.left = -maxDim;
    key.shadow.camera.right = maxDim;
    key.shadow.camera.top = maxDim;
    key.shadow.camera.bottom = -maxDim;
    key.shadow.camera.far = maxDim * 10;
    key.shadow.camera.updateProjectionMatrix();
  }

  let autoRotate = false;
  const onKey = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() === 'r') {
      autoRotate = !autoRotate;
      controls.autoRotate = autoRotate;
      controls.autoRotateSpeed = 1.2;
    }
    if (e.key.toLowerCase() === 'f' && model) frameObject(model);
  };
  window.addEventListener('keydown', onKey);

  const onResize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  window.addEventListener('resize', onResize);

  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    controls.update();
    renderer.render(scene, camera);
  };
  tick();

  return {
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      controls.dispose();
      draco.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
