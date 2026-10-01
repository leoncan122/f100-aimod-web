import * as THREE from 'three';

/**
 * Módulo de "peek" de cámara: arrastrar para asomarse, soltar para volver.
 *
 * Es independiente del modo. Cada modo crea su instancia y la engancha en dos
 * puntos de su `update()`:
 *
 * - `begin()` al principio, ANTES de mover la cámara.
 * - `apply(dt)` al final, cuando la cámara ya está colocada.
 *
 * El módulo toma la pose del modo como anclaje y le superpone una órbita
 * temporal alrededor de un pivote; al soltar el puntero el desvío se amortigua
 * a cero y la cámara regresa exactamente a donde la ponga el modo.
 *
 * Los dos puntos de enganche son necesarios porque muchos modos posicionan la
 * cámara de forma RELATIVA a su posición actual (`camera.position.lerp(...)`).
 * Si leyeran la pose ya desviada, el desvío se realimentaría: el modo arrastra
 * la cámara tras el peek, el peek vuelve a desviarse sobre eso, y al soltar
 * nunca se recupera el encuadre original. `begin()` restaura la pose limpia del
 * frame anterior, así que el modo siempre calcula desde su propia referencia y
 * el peek queda como una capa puramente visual, sin deriva acumulada.
 *
 * Soporta ratón y táctil (Pointer Events). Con dos dedos, el pinch añade un
 * acercamiento que también se deshace al soltar.
 *
 * Uso:
 * ```ts
 * const peek = createCameraPeek({
 *   camera, domElement: renderer.domElement,
 *   pivot: () => truck.position,
 * });
 *
 * update(dt) {
 *   peek.begin();        // antes de tocar la cámara
 *   ...coloca la cámara como haga el modo...
 *   peek.apply(dt);      // al final
 * }
 *
 * dispose() { peek.dispose(); }
 * ```
 */
export interface CameraPeekOptions {
  camera: THREE.PerspectiveCamera;
  /** Elemento que captura el puntero (normalmente `renderer.domElement`). */
  domElement: HTMLElement;
  /**
   * Punto alrededor del que orbita. Si se omite (o devuelve null) se usa un
   * punto a `pivotDistance` metros delante de la cámara.
   */
  pivot?: () => THREE.Vector3 | null | undefined;
  /** Distancia del pivote por defecto, en metros. */
  pivotDistance?: number;
  /** Giro horizontal máximo, en radianes. */
  maxYaw?: number;
  /** Giro vertical máximo, en radianes. */
  maxPitch?: number;
  /** Radianes de giro por píxel arrastrado. */
  sensitivity?: number;
  /** Acercamiento máximo por pinch, como fracción del radio (0.4 = 40 %). */
  maxDolly?: number;
  /** Suavizado al arrastrar: fracción de error restante tras 1 s (menor = más directo). */
  followDamping?: number;
  /** Suavizado al soltar: fracción restante tras 1 s (menor = vuelve más rápido). */
  returnDamping?: number;
  /** Altura mínima de la cámara sobre el pivote, en metros (evita colarse bajo el suelo). */
  minHeight?: number;
}

export interface CameraPeek {
  /**
   * Restaura la pose sin desviar. Llamar al PRINCIPIO del `update()` del modo,
   * antes de tocar la cámara, para que los modos que interpolan desde su
   * posición actual no realimenten el desvío.
   */
  begin: () => void;
  /** Aplica el desvío. Llamar al final del `update()` del modo. */
  apply: (dt: number) => void;
  /**
   * Activa o desactiva el módulo. Al desactivar se suelta el puntero y el
   * desvío se amortigua a cero, así que la transición sigue siendo suave.
   * Imprescindible en cámaras con OrbitControls, para que no se estorben.
   */
  setEnabled: (on: boolean) => void;
  /** true mientras el usuario mantiene pulsado. */
  readonly dragging: boolean;
  dispose: () => void;
}

const UP = new THREE.Vector3(0, 1, 0);

export function createCameraPeek(opts: CameraPeekOptions): CameraPeek {
  const {
    camera,
    domElement,
    pivot,
    pivotDistance = 12,
    maxYaw = 0.55,
    maxPitch = 0.3,
    sensitivity = 0.0032,
    maxDolly = 0.35,
    followDamping = 1e-6,
    returnDamping = 1e-4,
    minHeight = 0.4,
  } = opts;

  let enabled = true;

  // desvío actual (suavizado) y objetivo (lo que pide el puntero)
  let yaw = 0;
  let pitch = 0;
  let dolly = 0;
  let yawTarget = 0;
  let pitchTarget = 0;
  let dollyTarget = 0;

  /** Punteros activos sobre el lienzo, por id: permite detectar el pinch. */
  const pointers = new Map<number, { x: number; y: number }>();
  let startX = 0;
  let startY = 0;
  let startYaw = 0;
  let startPitch = 0;
  let pinchStartDist = 0;
  let startDolly = 0;

  const clamp = THREE.MathUtils.clamp;
  const pinchDistance = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const onPointerDown = (e: PointerEvent) => {
    // Solo gestos que nacen en el lienzo: así los botones del HUD siguen
    // funcionando con normalidad.
    if (!enabled || e.target !== domElement) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      startX = e.clientX;
      startY = e.clientY;
      startYaw = yaw;
      startPitch = pitch;
      domElement.setPointerCapture?.(e.pointerId);
    } else if (pointers.size === 2) {
      pinchStartDist = pinchDistance();
      startDolly = dolly;
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;

    if (pointers.size >= 2) {
      // pinch: separar los dedos acerca la cámara al pivote
      const d = pinchDistance();
      if (pinchStartDist > 0 && d > 0) {
        dollyTarget = clamp(startDolly + (d / pinchStartDist - 1) * 0.6, -maxDolly, maxDolly);
      }
      return;
    }

    yawTarget = clamp(startYaw - (e.clientX - startX) * sensitivity, -maxYaw, maxYaw);
    pitchTarget = clamp(startPitch - (e.clientY - startY) * sensitivity, -maxPitch, maxPitch);
  };

  const release = (e?: PointerEvent) => {
    if (e) {
      pointers.delete(e.pointerId);
      domElement.releasePointerCapture?.(e.pointerId);
    } else {
      pointers.clear();
    }
    if (pointers.size === 0) {
      // soltar = volver a la pose del modo
      yawTarget = 0;
      pitchTarget = 0;
      dollyTarget = 0;
    } else if (pointers.size === 1) {
      // al levantar un dedo del pinch, rearmar el arrastre desde donde está
      const [only] = [...pointers.values()];
      startX = only!.x;
      startY = only!.y;
      startYaw = yaw;
      startPitch = pitch;
      dollyTarget = 0;
    }
  };

  domElement.addEventListener('pointerdown', onPointerDown);
  // en window: si el puntero se suelta fuera del lienzo también hay que volver
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  // perder el foco con el botón pulsado nunca entrega un pointerup
  const onBlur = () => release();
  window.addEventListener('blur', onBlur);

  // vectores reutilizados: nada de asignaciones por frame
  const base = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const pivotPos = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const right = new THREE.Vector3();

  // Pose limpia (sin desvío) del frame anterior, para poder devolvérsela al modo.
  const cleanPos = new THREE.Vector3();
  const cleanQuat = new THREE.Quaternion();
  let hasClean = false;

  return {
    get dragging() {
      return pointers.size > 0;
    },
    begin() {
      if (!hasClean) return;
      camera.position.copy(cleanPos);
      camera.quaternion.copy(cleanQuat);
    },
    setEnabled(on: boolean) {
      enabled = on;
      if (!on) {
        release();
        // la referencia deja de ser válida: otro control manda la cámara
        hasClean = false;
      }
    },
    apply(dt: number) {
      const dragging = pointers.size > 0;
      // Suavizado exponencial independiente del framerate: al arrastrar sigue al
      // puntero casi al instante; al soltar regresa con una curva más blanda.
      const k = 1 - Math.pow(dragging ? followDamping : returnDamping, dt);
      yaw += (yawTarget - yaw) * k;
      pitch += (pitchTarget - pitch) * k;
      dolly += (dollyTarget - dolly) * k;

      // La pose que acaba de fijar el modo es la referencia limpia.
      cleanPos.copy(camera.position);
      cleanQuat.copy(camera.quaternion);
      hasClean = true;

      // Ya centrada: no tocar la cámara. Evita sobrescribir la pose del modo
      // (y su `up`) cuando el módulo está en reposo.
      if (Math.abs(yaw) < 1e-4 && Math.abs(pitch) < 1e-4 && Math.abs(dolly) < 1e-4) {
        yaw = pitch = dolly = 0;
        return;
      }

      base.copy(camera.position);
      const p = pivot?.();
      if (p) pivotPos.copy(p);
      else pivotPos.copy(base).addScaledVector(camera.getWorldDirection(fwd), pivotDistance);

      offset.copy(base).sub(pivotPos);
      if (offset.lengthSq() < 1e-6) return;

      offset.applyAxisAngle(UP, yaw);
      // El eje de cabeceo es perpendicular al radio: así el horizonte no rota.
      right.copy(UP).cross(offset);
      if (right.lengthSq() > 1e-6) offset.applyAxisAngle(right.normalize(), pitch);
      offset.multiplyScalar(1 - dolly);

      // la cámara nunca baja por debajo del pivote más el margen
      if (offset.y < minHeight) offset.y = minHeight;

      camera.position.copy(pivotPos).add(offset);
      camera.up.copy(UP);
      camera.lookAt(pivotPos);
    },
    dispose() {
      domElement.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', onBlur);
      pointers.clear();
    },
  };
}
