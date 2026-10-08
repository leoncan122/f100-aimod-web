/** Contexto de audio compartido y sonidos sintetizados (sin archivos). */

let ctx: AudioContext | null = null;

/** Crea el AudioContext la primera vez. El navegador lo deja suspendido hasta un gesto. */
export function audio(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      ctx = null;
    }
  }
  return ctx;
}

export function resumeAudio() {
  void audio()?.resume();
}

export function gunshotSound() {
  const a = audio();
  if (!a) return;
  const t = a.currentTime, len = 0.5;
  const buf = a.createBuffer(1, Math.floor(a.sampleRate * len), a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (a.sampleRate * 0.06));
  const src = a.createBufferSource();
  src.buffer = buf;
  const lp = a.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(6000, t);
  lp.frequency.exponentialRampToValueAtTime(600, t + 0.25);
  const g = a.createGain();
  g.gain.setValueAtTime(0.9, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + len);
  src.connect(lp).connect(g).connect(a.destination);
  src.start(t);
  // golpe grave del disparo
  const o = a.createOscillator(), og = a.createGain();
  o.frequency.setValueAtTime(140, t);
  o.frequency.exponentialRampToValueAtTime(38, t + 0.16);
  og.gain.setValueAtTime(0.8, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  o.connect(og).connect(a.destination);
  o.start(t);
  o.stop(t + 0.22);
}

/** Tintineo metálico del casquillo al rebotar. */
export function clinkSound(vol: number) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime, o = a.createOscillator(), g = a.createGain();
  o.type = 'triangle';
  o.frequency.setValueAtTime(4200 + Math.random() * 900, t);
  g.gain.setValueAtTime(0.05 * vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + 0.13);
}
