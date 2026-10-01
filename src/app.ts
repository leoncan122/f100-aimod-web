import * as THREE from 'three';
import { createCinematicMode } from './modes/cinematic';
import { createOrbitMode } from './modes/orbit';
import { createDesertMode } from './modes/desert';
import type { ModeId, ViewerMode } from './types';

export function createApp(root: HTMLElement) {
  root.innerHTML = `
    <div id="viewport"></div>
    <div id="tabs">
      <button class="tab on" data-mode="cinematic">Cinemática</button>
      <button class="tab" data-mode="orbit">Modelo</button>
      <button class="tab" data-mode="desert">Desierto</button>
    </div>
    <div id="stats"></div>
    <div id="hud"></div>
    <div id="loading"><div class="box"><div id="msg">Iniciando…</div><div id="bar"><div></div></div></div></div>
  `;

  const viewport = root.querySelector<HTMLDivElement>('#viewport')!;
  const hud = root.querySelector<HTMLDivElement>('#hud')!;
  const statsEl = root.querySelector<HTMLDivElement>('#stats')!;
  const loading = root.querySelector<HTMLDivElement>('#loading')!;
  const msg = root.querySelector<HTMLDivElement>('#msg')!;
  const bar = root.querySelector<HTMLDivElement>('#bar > div')!;

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  viewport.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 3000);
  let scene = new THREE.Scene();
  let mode: ViewerMode | null = null;
  let loadToken = 0;

  const onProgress = (pct: number, label: string) => {
    msg.textContent = label;
    bar.style.width = `${Math.round(pct * 100)}%`;
  };

  async function setMode(id: ModeId) {
    const token = ++loadToken;
    loading.classList.remove('hidden');
    bar.style.width = '0%';
    msg.textContent = 'Cargando…';

    mode?.dispose();
    mode = null;
    scene = new THREE.Scene();
    // Solo en dev: permite a los scripts de test medir la escena viva.
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      w.__scene = scene;
      w.__camera = camera;
    }

    const deps = { renderer, camera, scene, hud, onProgress };
    try {
      const factory =
        id === 'cinematic' ? createCinematicMode
        : id === 'orbit' ? createOrbitMode
        : createDesertMode;
      const next = await factory(deps);
      if (token !== loadToken) {
        next.dispose();
        return;
      }
      mode = next;
      loading.classList.add('hidden');
    } catch (err) {
      if (token !== loadToken) return;
      console.error(err);
      msg.textContent = `Error al cargar: ${(err as Error).message}`;
      bar.style.width = '0%';
    }

    for (const t of root.querySelectorAll<HTMLButtonElement>('.tab')) {
      t.classList.toggle('on', t.dataset.mode === id);
    }
  }

  for (const t of root.querySelectorAll<HTMLButtonElement>('.tab')) {
    t.onclick = () => setMode(t.dataset.mode as ModeId);
  }

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  const clock = new THREE.Clock();
  let acc = 0;
  let frames = 0;
  renderer.setAnimationLoop(() => {
    if (renderer.domElement.clientWidth !== window.innerWidth && window.innerWidth > 0) onResize();
    const dt = Math.min(clock.getDelta(), 0.1);
    mode?.update(dt);
    renderer.render(scene, camera);

    acc += dt;
    frames++;
    if (acc > 0.5) {
      const info = renderer.info.render;
      statsEl.textContent =
        `${Math.round(frames / acc)} fps · ${info.calls} draw calls · ${(info.triangles / 1000) | 0}k tris`;
      acc = 0;
      frames = 0;
    }
  });

  void setMode('cinematic');
}
