export interface CameraTrack {
  fps: number;
  start: number;
  end: number;
  /** [px, py, pz, qx, qy, qz, qw, hfovRadians] por frame */
  frames: number[][];
}

export type ModeId = 'cinematic' | 'cinematic-three' | 'orbit' | 'desert';

/** Modos validos en tiempo de ejecucion, para validar el hash de la URL. */
export const MODE_IDS = ['cinematic', 'cinematic-three', 'orbit', 'desert'] as const satisfies readonly ModeId[];

/** Modo que se abre si la URL no trae hash o trae uno desconocido. */
export const DEFAULT_MODE: ModeId = 'cinematic';

/** True si `v` es un ModeId conocido. Narrowing para datos externos (hash, query). */
export function isModeId(v: unknown): v is ModeId {
  return typeof v === 'string' && (MODE_IDS as readonly string[]).includes(v);
}

export interface ViewerMode {
  id: ModeId;
  /** Se llama cada frame. dt en segundos. */
  update: (dt: number) => void;
  dispose: () => void;
}
