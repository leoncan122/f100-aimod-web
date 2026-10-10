export interface CameraTrack {
  fps: number;
  start: number;
  end: number;
  /** [px, py, pz, qx, qy, qz, qw, hfovRadians] por frame */
  frames: number[][];
}

export type ModeId = 'cinematic' | 'cinematic-three' | 'orbit' | 'desert';

export interface ModeInfo {
  id: ModeId;
  /** Texto de la pestaña. */
  label: string;
  /**
   * Fuera del tablero publicado. La vista sigue entera en el repo y se puede
   * abrir en desarrollo (los scripts de medición la usan); solo desaparece del
   * sitio. Para volver a publicarla basta quitar este `hidden`.
   */
  hidden?: boolean;
}

/**
 * Modos del visor, en el orden en que salen las pestañas.
 *
 * Única fuente: de aquí salen el tablero y la validación del hash, así que
 * añadir, ocultar o renombrar una vista es cambiar una línea.
 */
export const MODES: readonly ModeInfo[] = [
  // La cinemática horneada en Blender se mantiene como referencia interna para
  // comparar con la versión three.js, pero no se publica.
  { id: 'cinematic', label: 'Cinemática (Blender)', hidden: true },
  { id: 'cinematic-three', label: 'Cinemática', },
  { id: 'orbit', label: 'Modelo' },
  { id: 'desert', label: 'Desierto' },
];

/** Modos que se muestran y se pueden enlazar. Los ocultos solo en desarrollo. */
export const VISIBLE_MODES: readonly ModeInfo[] = MODES.filter(
  (m) => !m.hidden || import.meta.env.DEV,
);

/** Modos validos en tiempo de ejecucion, para validar el hash de la URL. */
export const MODE_IDS: readonly ModeId[] = VISIBLE_MODES.map((m) => m.id);

/** Modo que se abre si la URL no trae hash o trae uno desconocido. */
export const DEFAULT_MODE: ModeId = 'cinematic-three';

/** True si `v` es un ModeId publicado. Narrowing para datos externos (hash, query). */
export function isModeId(v: unknown): v is ModeId {
  return typeof v === 'string' && (MODE_IDS as readonly string[]).includes(v);
}

export interface ViewerMode {
  id: ModeId;
  /** Se llama cada frame. dt en segundos. */
  update: (dt: number) => void;
  dispose: () => void;
}
