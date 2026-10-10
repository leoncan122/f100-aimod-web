/**
 * Controles del conductor, anclados a él en la escena.
 *
 * La pantalla queda limpia: no hay panel fijo. Al pulsar sobre el conductor
 * salen sus acciones en abanico sobre la cabeza, cada una con su icono. En
 * escritorio las teclas funcionan siempre, sin abrir nada ni apuntarle: al
 * pulsarlas el icono de esa acción parpadea sobre él, así se ve qué se activó.
 *
 * Hablar y la voz (grabar, subir, audios guardados) viven en una tarjeta que
 * se despliega desde el icono del bocadillo, porque necesitan un campo de texto
 * y una lista: no caben en un icono.
 *
 * El teclado de movimiento solo actúa a pie, así que no choca con los atajos de
 * la cinemática (Espacio, C) mientras conduce.
 */
import * as THREE from 'three';
import { createVoicePanel } from './voice';
import { resumeAudio } from './audio';
import { createActionMenu } from '../ui/action-menu';
import { icon } from '../ui/icons';
import type { Character, CharState } from './character';

export interface CharacterHudOptions {
  /** Capa libre de la interfaz: todo va anclado a la escena, no a una esquina. */
  layer: HTMLElement;
  canvas: HTMLCanvasElement;
  character: Character;
  /** Volver a la camioneta (arranca la película al sentarse). */
  onBoard: () => void;
}

const MOVE_KEYS: Record<string, 'f' | 'b' | 'l' | 'r'> = {
  KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r',
};

export function createCharacterHud(opts: CharacterHudOptions) {
  const { layer, canvas, character: ch } = opts;
  const onFoot = () => ch.state === 'foot';

  // ── tarjeta de habla y voz (se abre desde el icono del bocadillo)
  const card = document.createElement('div');
  card.className = 'sayCard';
  card.hidden = true;
  card.innerHTML = `
    <div class="sayHead">
      <b>Conductor</b>
      <button type="button" class="sayX" aria-label="Cerrar">${icon('close')}</button>
    </div>
    <form class="say" autocomplete="off">
      <input type="text" maxlength="160" placeholder="Escribe lo que dirá…" aria-label="Texto que dirá el conductor">
      <button type="submit" class="btn">Hablar</button>
    </form>
    <div class="voice"></div>
    <p class="sayHint"></p>`;
  layer.appendChild(card);

  const form = card.querySelector<HTMLFormElement>('.say')!;
  const text = form.querySelector('input')!;
  const hint = card.querySelector<HTMLParagraphElement>('.sayHint')!;

  const setCard = (v: boolean) => {
    card.hidden = !v;
    if (v) text.focus();
  };
  card.querySelector<HTMLButtonElement>('.sayX')!.onclick = () => setCard(false);

  form.onsubmit = (e) => {
    e.preventDefault();
    resumeAudio();
    ch.speak(text.value);
    text.value = '';
    text.blur();
  };
  const voice = createVoicePanel(card.querySelector<HTMLDivElement>('.voice')!, (s) => {
    ch.stopSpeech();
    say('(tu voz)', s * 1000 + 400);
  });
  ch.setVoice(() => voice.shape(), () => voice.onset());

  // ── menú de acciones sobre el conductor
  const headTmp = new THREE.Vector3();
  const menu = createActionMenu({
    layer,
    canvas,
    title: 'el conductor',
    // solo interactuable a pie: conduciendo va dentro de la cabina
    anchor: () => (onFoot() ? ch.head(headTmp).clone() : null),
    hitTest: (ray) => ch.hitTest(ray),
    actions: [
      {
        id: 'speak',
        icon: 'speak',
        label: 'Hablar',
        code: 'KeyH',
        keyLabel: 'H',
        run: () => setCard(card.hidden === true),
        active: () => !card.hidden,
      },
      { id: 'jump', icon: 'jump', label: 'Saltar', code: 'Space', keyLabel: '␣', run: () => ch.startJump() },
      {
        id: 'kneel', icon: 'kneel', label: 'Arrodillarse', activeLabel: 'Levantarse',
        code: 'KeyK', keyLabel: 'K', run: () => ch.toggleKneel(), active: () => ch.kneeling,
      },
      {
        id: 'gun', icon: 'gun', label: 'Sacar el arma', activeLabel: 'Enfundar',
        code: 'KeyG', keyLabel: 'G', run: () => ch.toggleGun(), active: () => ch.armed,
      },
      {
        id: 'fire', icon: 'fire', label: 'Disparar', code: 'KeyF', keyLabel: 'F',
        run: () => ch.fire(), enabled: () => ch.armed,
      },
      { id: 'wave', icon: 'wave', label: 'Saludar', code: 'KeyQ', keyLabel: 'Q', run: () => ch.wave() },
      { id: 'board', icon: 'board', label: 'Subir a la camioneta', code: 'KeyE', keyLabel: 'E', run: () => opts.onBoard() },
    ],
  });

  // ── teclado de movimiento (solo a pie)
  const keys = new Set<string>();
  let run = false;
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement | null)?.closest?.('input, textarea')) return;
    if (!onFoot()) return;
    const m = MOVE_KEYS[e.code];
    if (m) { keys.add(m); e.preventDefault(); }
    if (e.key === 'Shift') run = true;
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const m = MOVE_KEYS[e.code];
    if (m) keys.delete(m);
    if (e.key === 'Shift') run = false;
  };
  const onBlur = () => { keys.clear(); run = false; };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  // ── joystick táctil
  const stick = document.createElement('div');
  stick.id = 'charStick';
  stick.hidden = true;
  stick.innerHTML = '<i></i>';
  layer.appendChild(stick);
  const knob = stick.querySelector('i')!;

  const joy = { x: 0, y: 0, id: -1 };
  const joyMove = (e: PointerEvent) => {
    const r = stick.getBoundingClientRect();
    let dx = (e.clientX - r.left - r.width / 2) / (r.width / 2);
    let dy = (e.clientY - r.top - r.height / 2) / (r.height / 2);
    const l = Math.hypot(dx, dy);
    if (l > 1) { dx /= l; dy /= l; }
    joy.x = dx;
    joy.y = dy;
    knob.style.transform = `translate(${dx * 33}px, ${dy * 33}px)`;
  };
  stick.onpointerdown = (e) => { joy.id = e.pointerId; stick.setPointerCapture(e.pointerId); joyMove(e); };
  stick.onpointermove = (e) => { if (e.pointerId === joy.id) joyMove(e); };
  stick.onpointerup = stick.onpointercancel = (e) => {
    if (e.pointerId !== joy.id) return;
    joy.id = -1; joy.x = joy.y = 0; knob.style.transform = '';
  };

  // ── puntero: a dónde mira. El clic sobre él lo gestiona el menú de acciones,
  // así que aquí solo queda disparar cuando está apuntando.
  const ndc = new THREE.Vector2();
  let lastPointer = 0;
  let downAt: [number, number] | null = null;
  const ndcOf = (e: PointerEvent, out: THREE.Vector2) => {
    const r = canvas.getBoundingClientRect();
    return out.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  const onMove = (e: PointerEvent) => { ndcOf(e, ndc); lastPointer = performance.now(); };
  const onLeave = () => { lastPointer = 0; };
  const onDown = (e: PointerEvent) => { downAt = [e.clientX, e.clientY]; };
  const raycaster = new THREE.Raycaster();
  const onUp = (e: PointerEvent) => {
    if (!downAt || !onFoot()) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
    downAt = null;
    if (moved > 6) return;
    // apuntando, un clic en el escenario dispara; sobre él abre el menú
    if (ch.aiming && !menu.open) ch.fire();
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);

  // ── bocadillo de diálogo
  const bubble = document.createElement('div');
  bubble.id = 'charBubble';
  layer.appendChild(bubble);
  let bubbleUntil = 0;
  function say(t: string, ms: number) {
    bubble.textContent = t;
    bubbleUntil = performance.now() + ms;
  }

  let lastState: CharState | null = null;
  const camFwd = new THREE.Vector3(), camRight = new THREE.Vector3(), tmp = new THREE.Vector3();
  const plane = new THREE.Plane();

  return {
    say,
    /** Entrada de movimiento relativa a la cámara + punto de mirada. */
    input(camera: THREE.Camera) {
      camera.getWorldDirection(camFwd);
      camFwd.y = 0;
      camFwd.normalize();
      camRight.crossVectors(camFwd, THREE.Object3D.DEFAULT_UP).normalize();
      const move = new THREE.Vector3();
      if (keys.has('f')) move.add(camFwd);
      if (keys.has('b')) move.sub(camFwd);
      if (keys.has('r')) move.add(camRight);
      if (keys.has('l')) move.sub(camRight);
      if (joy.x || joy.y) move.addScaledVector(camRight, joy.x).addScaledVector(camFwd, -joy.y);
      if (move.lengthSq() > 1) move.normalize();
      // mira al cursor si se ha movido hace poco; si no, a la cámara
      let lookAt: THREE.Vector3 | null = camera.position.clone();
      if (lastPointer && performance.now() - lastPointer < 3500) {
        const head = ch.head(tmp).clone();
        raycaster.setFromCamera(ndc, camera);
        plane.setFromNormalAndCoplanarPoint(camFwd.clone().negate(), head);
        const hit = new THREE.Vector3();
        lookAt = raycaster.ray.intersectPlane(plane, hit) ? hit : lookAt;
      }
      return { move, run: run || Math.hypot(joy.x, joy.y) > 0.92, lookAt };
    },
    update(camera: THREE.Camera) {
      const st = ch.state;
      if (st !== lastState) {
        lastState = st;
        const foot = st === 'foot';
        stick.hidden = !foot || !matchMedia('(pointer: coarse)').matches;
        hint.textContent = foot
          ? 'WASD para caminar · Shift corre'
          : 'Pausa para que se baje de la camioneta';
        if (!foot) {
          keys.clear();
          run = false;
          setCard(false);
        }
      }
      menu.update(camera);

      // la tarjeta de habla sigue al conductor, justo debajo de sus acciones
      if (!card.hidden) {
        const p = ch.head(tmp).clone();
        p.project(camera);
        const x = (p.x * 0.5 + 0.5) * canvas.clientWidth;
        const y = (-p.y * 0.5 + 0.5) * canvas.clientHeight;
        card.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        card.classList.toggle('offscreen', p.z >= 1);
      }

      if (performance.now() < bubbleUntil) {
        const p = ch.head(tmp);
        p.y += 0.3;
        p.project(camera);
        const visible = p.z < 1;
        bubble.style.transform = `translate(${((p.x * 0.5 + 0.5) * canvas.clientWidth).toFixed(1)}px, ${((-p.y * 0.5 + 0.5) * canvas.clientHeight - 20).toFixed(1)}px)`;
        bubble.classList.toggle('on', visible);
      } else bubble.classList.remove('on');
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      menu.dispose();
      voice.dispose();
      card.remove();
      bubble.remove();
      stick.remove();
    },
  };
}
