import * as THREE from 'three';
import { createCinematicMode } from './modes/cinematic';
import { createOrbitMode } from './modes/orbit';
import { createDesertMode } from './modes/desert';
import { DEFAULT_MODE, isModeId } from './types';
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
  // Modo pedido (no necesariamente ya cargado): es la referencia para no recargar
  // ni apilar historial de mas.
  let currentMode: ModeId | null = null;

  const onProgress = (pct: number, label: string) => {
    msg.textContent = label;
    bar.style.width = `${Math.round(pct * 100)}%`;
  };

  async function setMode(id: ModeId) {
    currentMode = id;
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
      // avanza n frames a mano (la pestaña oculta no recibe requestAnimationFrame)
      w.__step = (n: number, dt = 1 / 30) => {
        for (let i = 0; i < n; i++) mode?.update(dt);
        renderer.render(scene, camera);
      };
    }

    const deps = { renderer, camera, scene, hud, onProgress };
    try {
      // Mapa explicito: antes era un ternario sin rama por defecto real, asi que
      // cualquier id desconocido caia silenciosamente en el desierto.
      const factories: Record<ModeId, (d: typeof deps) => Promise<ViewerMode>> = {
        cinematic: createCinematicMode,
        orbit: createOrbitMode,
        desert: createDesertMode,
      };
      const next = await factories[id](deps);
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

  // ───────────────────────── enlace compartible via hash (#desert)
  // Se usa el hash y no una ruta real porque el sitio se publica en GitHub Pages:
  // el hash no llega al servidor, asi que un enlace directo funciona sin
  // configuracion. Con rutas (/desert) Pages responderia 404.

  /** Modo pedido por la URL. Un hash desconocido cae al modo por defecto. */
  const modeFromHash = (): ModeId => {
    const raw = decodeURIComponent(location.hash.replace(/^#/, '')).trim().toLowerCase();
    return isModeId(raw) ? raw : DEFAULT_MODE;
  };

  /**
   * Deja la URL mostrando el modo que realmente se ve.
   *
   * Hace falta tanto al arrancar como en cada hashchange: cambiar solo el hash de
   * una pestaña ya abierta es una navegacion del mismo documento, asi que la
   * pagina NO se recarga y el codigo de arranque no vuelve a ejecutarse. Sin esto
   * un `#asdf` pegado a mano se queda en la barra mostrando la vista por defecto,
   * y al copiar ese enlace se comparte un hash que no corresponde.
   */
  const normalizeHash = (id: ModeId) => {
    if (location.hash.replace(/^#/, '') !== id) history.replaceState(null, '', `#${id}`);
  };

  for (const t of root.querySelectorAll<HTMLButtonElement>('.tab')) {
    t.onclick = () => {
      const id = t.dataset.mode as ModeId;
      if (id === currentMode) return; // no apilar historial al repulsar la activa
      // pushState: el boton atras recorre los modos visitados. No dispara
      // hashchange, por eso se llama a setMode() a mano justo despues.
      history.pushState(null, '', `#${id}`);
      void setMode(id);
    };
  }

  // Atras/adelante del navegador y URLs pegadas en la misma pestaña.
  window.addEventListener('hashchange', () => {
    const id = modeFromHash();
    normalizeHash(id);
    if (id !== currentMode) void setMode(id);
  });

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

  // Arranque: respeta el hash si lo hay. Si viene vacio o invalido se normaliza la
  // URL con replaceState, para que no quede un #asdf enlazable que no corresponde
  // a lo que se esta viendo.
  const initial = modeFromHash();
  normalizeHash(initial);
  void setMode(initial);
}
