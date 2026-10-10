/**
 * Menú de acciones anclado a un personaje en la escena.
 *
 * La pantalla queda limpia: los controles no están puestos de antemano, salen
 * al pulsar sobre el personaje y se colocan en arco alrededor de su cabeza, cada
 * acción con su icono. En escritorio no hace falta abrirlo: las teclas siguen
 * funcionando siempre, y al pulsarlas el icono correspondiente parpadea sobre
 * el personaje para que se vea qué se ha activado.
 *
 * Es genérico: no sabe nada del conductor ni de Aitziber. Recibe una lista de
 * acciones (icono, etiqueta, tecla, qué hacer) y una función que devuelve el
 * punto de anclaje en mundo; sirve para cualquier personaje u objeto
 * interactivo que se añada después.
 */
import * as THREE from 'three';
import { icon } from './icons';
import type { IconId } from './icons';

export interface MenuAction {
  id: string;
  icon: IconId;
  /** Texto accesible y de la etiqueta flotante. */
  label: string;
  /** Tecla física (`KeyboardEvent.code`), p. ej. 'KeyK'. Opcional. */
  code?: string;
  /** Cómo se muestra la tecla al usuario ('K', '␣'). */
  keyLabel?: string;
  run: () => void;
  /** Si existe, el botón se marca pulsado cuando devuelve true. */
  active?: () => boolean;
  /** Etiqueta alternativa cuando `active()` es true ('Enfundar'). */
  activeLabel?: string;
  /** Si devuelve false la acción no se ofrece ni responde a la tecla. */
  enabled?: () => boolean;
}

export interface ActionMenuOptions {
  /** Capa libre de la interfaz (posicionamiento absoluto). */
  layer: HTMLElement;
  canvas: HTMLCanvasElement;
  /** Nombre del personaje, para el encabezado del menú. */
  title: string;
  /** Punto de anclaje en mundo (la cabeza) o null si no se puede interactuar. */
  anchor: () => THREE.Vector3 | null;
  /** True si el puntero apunta al personaje (prueba de clic del propio modelo). */
  hitTest: (ray: THREE.Ray) => boolean;
  actions: MenuAction[];
  /** Radio mínimo del arco en px. Crece solo si hacen falta más huecos. */
  radius?: number;
}

/**
 * Apertura del abanico y cuánto se eleva sobre la cabeza.
 *
 * Con un arco cercano a 180° los botones de los extremos caen a la altura del
 * anillo y se amontonan contra él; 112° más un empuje vertical los deja todos
 * claramente por encima del personaje, sin taparle la cara.
 */
const ARC = Math.PI * 0.62;
const LIFT = 28;
const FLASH_MS = 900;
/** Diámetro del botón (.amBtn en el CSS) más el aire mínimo entre dos. */
const BTN = 44, PAD = 8;

export function createActionMenu(opts: ActionMenuOptions) {
  const { layer, canvas, anchor, hitTest } = opts;
  const radius = opts.radius ?? 86;

  const wrap = document.createElement('div');
  wrap.className = 'actionMenu';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', `Acciones de ${opts.title}`);

  // Pista para descubrir el menú: un anillo sobre el personaje cuando el
  // puntero está encima. Sin esto no hay forma de saber que es pulsable.
  const ring = document.createElement('button');
  ring.type = 'button';
  ring.className = 'amRing';
  ring.setAttribute('aria-label', `Acciones de ${opts.title}`);
  ring.setAttribute('aria-expanded', 'false');
  ring.innerHTML = '<span class="amDots"><i></i><i></i><i></i></span>';

  const fan = document.createElement('div');
  fan.className = 'amFan';

  const tip = document.createElement('div');
  tip.className = 'amTip';

  wrap.append(ring, fan, tip);
  layer.appendChild(wrap);

  type Slot = { a: MenuAction; btn: HTMLButtonElement; flashUntil: number };
  const slots: Slot[] = opts.actions.map((a) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'amBtn';
    btn.dataset.a = a.id;
    btn.innerHTML = icon(a.icon);
    btn.setAttribute('aria-label', a.label);
    btn.title = a.keyLabel ? `${a.label} (${a.keyLabel})` : a.label;
    if (a.keyLabel) {
      const k = document.createElement('span');
      k.className = 'amKey';
      k.textContent = a.keyLabel;
      k.setAttribute('aria-hidden', 'true');
      btn.appendChild(k);
    }
    btn.onpointerdown = (e) => e.stopPropagation();
    btn.onclick = (e) => {
      e.stopPropagation();
      trigger(a);
      btn.blur();
    };
    btn.onpointerenter = () => showTip(a);
    btn.onpointerleave = () => hideTip();
    fan.appendChild(btn);
    return { a, btn, flashUntil: 0 };
  });

  let open = false;
  let hover = false;
  /** Último punto de pantalla del ancla, para colocar el menú. */
  const at = { x: 0, y: 0, visible: false };
  let tipUntil = 0;

  const enabledOf = (a: MenuAction) =>
    // sin ancla el personaje no es interactuable (va dentro de la cabina): no
    // debe responder ni al clic ni a la tecla, o Espacio saltaría conduciendo
    anchor() !== null && a.enabled?.() !== false;

  function setOpen(v: boolean) {
    if (open === v) return;
    open = v;
    wrap.classList.toggle('open', open);
    ring.setAttribute('aria-expanded', String(open));
    if (!open) hideTip();
    if (open) layout();
  }

  function showTip(a: MenuAction) {
    const on = a.active?.() === true;
    tip.textContent = (on && a.activeLabel) || a.label;
    tip.classList.add('on');
    tipUntil = Infinity;
  }
  function hideTip() {
    tip.classList.remove('on');
    tipUntil = 0;
  }
  /** Etiqueta breve que se desvanece sola (al usar una tecla). */
  function flashTip(text: string) {
    tip.textContent = text;
    tip.classList.add('on');
    tipUntil = performance.now() + FLASH_MS;
  }

  /** Ejecuta una acción y hace parpadear su icono sobre el personaje. */
  function trigger(a: MenuAction) {
    if (!enabledOf(a)) return;
    a.run();
    const s = slots.find((s) => s.a === a);
    if (s) {
      s.flashUntil = performance.now() + FLASH_MS;
      s.btn.classList.remove('flash');
      // reinicia la animación aunque se repita la misma acción
      void s.btn.offsetWidth;
      s.btn.classList.add('flash');
    }
    flashTip((a.active?.() === true && a.activeLabel) || a.label);
  }

  /** Reparte los botones disponibles en abanico sobre la cabeza. */
  function layout() {
    const vis = slots.filter((s) => enabledOf(s.a));
    for (const s of slots) s.btn.hidden = !enabledOf(s.a);
    const n = vis.length;
    if (!n) return;
    // de izquierda a derecha, centrado en la vertical del personaje
    const step = n > 1 ? ARC / (n - 1) : 0;
    const start = -ARC / 2;
    // El radio crece con el número de acciones: con uno fijo, al pasar de 5 a 6
    // botones la cuerda entre centros baja de 44 px y los iconos se pisan.
    const r = n > 1 ? Math.max(radius, (BTN + PAD) / (2 * Math.sin(step / 2))) : radius;
    vis.forEach((s, i) => {
      const ang = n > 1 ? start + step * i : 0;
      const x = Math.sin(ang) * r;
      const y = -(Math.cos(ang) * r * 0.74 + LIFT);
      s.btn.style.setProperty('--x', `${x.toFixed(1)}px`);
      s.btn.style.setProperty('--y', `${y.toFixed(1)}px`);
      s.btn.style.setProperty('--d', `${(i * 22).toFixed(0)}ms`);
    });
  }

  // ── teclado: siempre activo, no exige abrir el menú ni apuntar al personaje
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    // no robar teclas mientras se escribe
    if ((e.target as HTMLElement | null)?.closest?.('input, textarea, [contenteditable]')) return;
    if (e.code === 'Escape' && open) { setOpen(false); return; }
    const a = opts.actions.find((a) => a.code === e.code);
    if (!a || !enabledOf(a)) return;
    e.preventDefault();
    trigger(a);
  };
  window.addEventListener('keydown', onKeyDown);

  // ── puntero sobre el lienzo: detectar el personaje y abrir/cerrar
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let camRef: THREE.Camera | null = null;
  let down: { x: number; y: number; onChar: boolean } | null = null;

  const ndcOf = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  const pointsAtChar = (e: PointerEvent) => {
    if (!camRef || !anchor()) return false;
    ray.setFromCamera(ndcOf(e), camRef);
    return hitTest(ray.ray);
  };

  const onMove = (e: PointerEvent) => {
    // en táctil no hay hover: el anillo solo aparece con ratón
    if (e.pointerType !== 'mouse') return;
    hover = pointsAtChar(e);
    wrap.classList.toggle('near', hover);
    canvas.style.cursor = hover ? 'pointer' : '';
  };
  const onLeave = () => {
    hover = false;
    wrap.classList.remove('near');
    canvas.style.cursor = '';
  };
  const onDown = (e: PointerEvent) => {
    down = { x: e.clientX, y: e.clientY, onChar: pointsAtChar(e) };
  };
  const onUp = (e: PointerEvent) => {
    const d = down;
    down = null;
    if (!d) return;
    // un arrastre es un giro de cámara, no un clic
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
    if (d.onChar) setOpen(!open);
    else setOpen(false); // clic fuera cierra
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);

  // el anillo también abre (es el objetivo grande en táctil)
  ring.onpointerdown = (e) => e.stopPropagation();
  ring.onclick = (e) => {
    e.stopPropagation();
    setOpen(!open);
  };

  return {
    /** True si el menú está desplegado (para no tragarse el clic de otra cosa). */
    get open() { return open; },
    close: () => setOpen(false),
    /** Dispara una acción por id, como si se hubiera pulsado su botón. */
    trigger(id: string) {
      const a = opts.actions.find((a) => a.id === id);
      if (a) trigger(a);
    },
    /** Cada frame: proyecta el ancla y refresca estados. */
    update(camera: THREE.Camera) {
      camRef = camera;
      const p = anchor();
      const now = performance.now();

      if (!p) {
        at.visible = false;
        wrap.classList.remove('on');
        setOpen(false);
        return;
      }
      const v = p.clone();
      v.y += 0.34; // un poco por encima de la cabeza
      v.project(camera);
      at.visible = v.z < 1;
      at.x = (v.x * 0.5 + 0.5) * canvas.clientWidth;
      at.y = (-v.y * 0.5 + 0.5) * canvas.clientHeight;
      wrap.classList.toggle('on', at.visible);
      wrap.style.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px)`;
      if (!at.visible) setOpen(false);

      // estado de los botones (arma enfundada/desenfundada, rodilla…)
      for (const s of slots) {
        const on = s.a.active?.() === true;
        s.btn.setAttribute('aria-pressed', String(on));
        s.btn.classList.toggle('on', on);
        const lbl = (on && s.a.activeLabel) || s.a.label;
        s.btn.setAttribute('aria-label', lbl);
        s.btn.title = s.a.keyLabel ? `${lbl} (${s.a.keyLabel})` : lbl;
        if (s.flashUntil && now > s.flashUntil) {
          s.flashUntil = 0;
          s.btn.classList.remove('flash');
        }
        // el icono parpadea sobre el personaje aunque el menú esté cerrado
        s.btn.classList.toggle('solo', !open && s.flashUntil > now);
      }
      if (tipUntil && now > tipUntil) hideTip();
      if (open) layout();
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.style.cursor = '';
      wrap.remove();
    },
  };
}

export type ActionMenu = ReturnType<typeof createActionMenu>;
