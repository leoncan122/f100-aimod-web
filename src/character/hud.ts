import * as THREE from 'three';
import { createVoicePanel } from './voice';
import { resumeAudio } from './audio';
import type { Character, CharState } from './character';

/**
 * Controles del personaje en la cinemática: habla y voz (siempre), acciones a pie,
 * bocadillo sobre la cabeza y joystick táctil. El teclado solo actúa a pie, así
 * que no choca con los atajos de la cinemática (Espacio, C) mientras conduce.
 */
export interface CharacterHudOptions {
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  character: Character;
  /** Volver a la camioneta (arranca la película al sentarse). */
  onBoard: () => void;
}

const MOVE_KEYS: Record<string, 'f' | 'b' | 'l' | 'r'> = {
  KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r',
};

export function createCharacterHud(opts: CharacterHudOptions) {
  const { host, canvas, character: ch } = opts;

  const panel = document.createElement('div');
  panel.id = 'charPanel';
  panel.innerHTML = `
    <form class="say" autocomplete="off">
      <input type="text" maxlength="160" placeholder="Escribe lo que dirá…" aria-label="Texto que dirá el conductor">
      <button type="submit" class="btn">Hablar</button>
    </form>
    <div class="voice"></div>
    <div class="acts" hidden>
      <button type="button" class="btn" data-a="jump">Saltar <kbd>␣</kbd></button>
      <button type="button" class="btn" data-a="kneel" aria-pressed="false">Rodilla <kbd>K</kbd></button>
      <button type="button" class="btn" data-a="gun" aria-pressed="false">Arma <kbd>G</kbd></button>
      <button type="button" class="btn" data-a="fire">Disparar <kbd>F</kbd></button>
      <button type="button" class="btn" data-a="wave">Saludar</button>
      <button type="button" class="btn on" data-a="board">Subir <kbd>E</kbd></button>
    </div>
    <p class="hint" data-a="hint">Pausa para que se baje de la camioneta</p>`;
  host.appendChild(panel);

  const bubble = document.createElement('div');
  bubble.id = 'charBubble';
  host.appendChild(bubble);

  const stick = document.createElement('div');
  stick.id = 'charStick';
  stick.hidden = true;
  stick.innerHTML = '<i></i>';
  host.appendChild(stick);
  const knob = stick.querySelector('i')!;

  const form = panel.querySelector<HTMLFormElement>('.say')!;
  const text = form.querySelector('input')!;
  const acts = panel.querySelector<HTMLDivElement>('.acts')!;
  const hint = panel.querySelector<HTMLParagraphElement>('[data-a="hint"]')!;
  const btn = (a: string) => panel.querySelector<HTMLButtonElement>(`[data-a="${a}"]`)!;

  form.onsubmit = (e) => {
    e.preventDefault();
    resumeAudio();
    ch.speak(text.value);
    text.value = '';
    text.blur();
  };
  const voice = createVoicePanel(panel.querySelector<HTMLDivElement>('.voice')!, (s) => {
    ch.stopSpeech();
    say('(tu voz)', s * 1000 + 400);
  });
  ch.setVoice(() => voice.shape(), () => voice.onset());

  btn('jump').onclick = () => ch.startJump();
  btn('kneel').onclick = () => ch.toggleKneel();
  btn('gun').onclick = () => ch.toggleGun();
  btn('fire').onclick = () => ch.fire();
  btn('wave').onclick = () => ch.wave();
  btn('board').onclick = () => opts.onBoard();

  // ---- teclado (solo a pie)
  const keys = new Set<string>();
  let run = false;
  const onFoot = () => ch.state === 'foot';
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement | null)?.closest?.('input, textarea')) return;
    if (!onFoot()) return;
    const m = MOVE_KEYS[e.code];
    if (m) { keys.add(m); e.preventDefault(); }
    if (e.key === 'Shift') run = true;
    if (e.repeat) return;
    if (e.code === 'Space') { e.preventDefault(); ch.startJump(); }
    if (e.code === 'KeyK') ch.toggleKneel();
    if (e.code === 'KeyG') ch.toggleGun();
    if (e.code === 'KeyF') ch.fire();
    if (e.code === 'KeyE') opts.onBoard();
    if (e.code === 'KeyH') { resumeAudio(); ch.speak(text.value); text.value = ''; }
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

  // ---- joystick táctil
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

  // ---- puntero: a dónde mira, y clic sobre él para saludar (o disparar si apunta)
  const ndc = new THREE.Vector2();
  let lastPointer = 0;
  let downAt: [number, number] | null = null;
  let camRef: THREE.Camera | null = null;
  const ndcOf = (e: PointerEvent, out: THREE.Vector2) => {
    const r = canvas.getBoundingClientRect();
    return out.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  const onMove = (e: PointerEvent) => { ndcOf(e, ndc); lastPointer = performance.now(); };
  const onLeave = () => { lastPointer = 0; };
  const onDown = (e: PointerEvent) => { downAt = [e.clientX, e.clientY]; };
  const raycaster = new THREE.Raycaster();
  const onUp = (e: PointerEvent) => {
    if (!downAt || !onFoot() || !camRef) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
    downAt = null;
    if (moved > 6) return;
    if (ch.aiming) { ch.fire(); return; }
    raycaster.setFromCamera(ndcOf(e, new THREE.Vector2()), camRef);
    if (ch.hitTest(raycaster.ray)) ch.wave();
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);

  // ---- bocadillo
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
      camRef = camera;
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
        acts.hidden = !foot;
        stick.hidden = !foot || !matchMedia('(pointer: coarse)').matches;
        hint.textContent =
          st === 'drive' ? 'Pausa para que se baje de la camioneta'
          : st === 'exiting' ? 'Bajando…'
          : st === 'approach' || st === 'entering' ? 'Volviendo a la camioneta…'
          : 'WASD para caminar · Shift corre · clic sobre él para saludar';
        if (!foot) { keys.clear(); run = false; }
      }
      btn('kneel').setAttribute('aria-pressed', String(ch.kneeling));
      btn('gun').setAttribute('aria-pressed', String(ch.armed));
      btn('gun').firstChild!.textContent = ch.armed ? 'Enfundar ' : 'Arma ';
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
      voice.dispose();
      panel.remove();
      bubble.remove();
      stick.remove();
    },
  };
}
