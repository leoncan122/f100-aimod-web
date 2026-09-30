export interface CameraTrack {
  fps: number;
  start: number;
  end: number;
  /** [px, py, pz, qx, qy, qz, qw, hfovRadians] por frame */
  frames: number[][];
}

export type ModeId = 'cinematic' | 'orbit' | 'desert';

export interface ViewerMode {
  id: ModeId;
  /** Se llama cada frame. dt en segundos. */
  update: (dt: number) => void;
  dispose: () => void;
}
