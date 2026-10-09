import { audio, resumeAudio } from './audio';

/**
 * Tu voz: grabaciones del micrófono y audios subidos, guardados en IndexedDB
 * (por navegador). Al reproducir uno, un AnalyserNode da cada frame la forma de
 * la boca: el volumen abre la mandíbula, los graves la redondean (o, u) y los
 * agudos la estiran (e, i).
 */

export interface Clip {
  id: string;
  name: string;
  duration: number;
  mime: string;
  createdAt: number;
}
interface StoredClip extends Clip {
  data: ArrayBuffer;
}

const DB_NAME = 'f100-personaje-voces';

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('clips', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (os: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((res, rej) => {
    const t = db.transaction('clips', mode);
    const req = fn(t.objectStore('clips'));
    t.oncomplete = () => {
      db.close();
      res(req ? req.result : undefined);
    };
    t.onerror = () => rej(t.error);
  });
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export interface VoicePlayer {
  /** Forma de boca [mandíbula, ancha, redonda] mientras suena un audio; null si no suena. */
  shape(): [number, number, number] | null;
  /** True en el frame en que arranca una sílaba (para cabecear). */
  onset(): boolean;
  stop(): void;
  dispose(): void;
}

/**
 * Monta el panel de voz dentro de `host` y devuelve el reproductor.
 * `onPlay` avisa al personaje (bocadillo, cortar la síntesis de voz).
 */
export function createVoicePanel(host: HTMLElement, onPlay: (seconds: number) => void): VoicePlayer {
  host.innerHTML = `
    <div class="vrow">
      <button type="button" class="btn" data-v="rec" aria-pressed="false"><span class="rec"></span><span data-v="recLabel">Grabar</span></button>
      <button type="button" class="btn" data-v="pick">Subir audio</button>
      <input type="file" accept="audio/*" hidden data-v="file">
    </div>
    <div class="vstatus" data-v="status">Graba tu voz y él lo dice</div>
    <ul class="clips" data-v="list" aria-label="Audios guardados"></ul>`;
  const q = <T extends HTMLElement>(k: string) => host.querySelector<T>(`[data-v="${k}"]`)!;
  const status = q<HTMLDivElement>('status');
  const list = q<HTMLUListElement>('list');
  const recBtn = q<HTMLButtonElement>('rec');
  const recLabel = q<HTMLSpanElement>('recLabel');
  const fileInput = q<HTMLInputElement>('file');

  const decoded = new Map<string, AudioBuffer>();
  let clips: Clip[] = [];
  let canSave = true;

  const st = {
    src: null as AudioBufferSourceNode | null,
    an: null as AnalyserNode | null,
    time: new Float32Array(1024),
    freq: new Uint8Array(512),
    on: false,
    peak: 0.05,
    prev: 0,
    onsetFlag: false,
    playingId: null as string | null,
  };

  async function refresh() {
    try {
      const all = (await tx<StoredClip[]>('readonly', (os) => os.getAll() as IDBRequest<StoredClip[]>)) ?? [];
      clips = all.map(({ id, name, duration, mime, createdAt }) => ({ id, name, duration, mime, createdAt }))
        .sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      canSave = false;
      status.textContent = 'Este navegador no deja guardar audios aquí.';
    }
    render();
  }

  function render() {
    list.replaceChildren(...clips.map((c) => {
      const li = document.createElement('li');
      if (c.id === st.playingId && st.on) li.className = 'playing';
      const n = document.createElement('span');
      n.className = 'cn';
      n.textContent = c.name || 'Audio';
      const d = document.createElement('span');
      d.className = 'cd';
      d.textContent = fmt(c.duration || 0);
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'btn';
      play.textContent = 'Reproducir';
      play.onclick = async () => {
        resumeAudio();
        try {
          play_(await load(c), c.id);
        } catch {
          status.textContent = 'No se pudo abrir ese audio.';
        }
      };
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn';
      del.textContent = 'Borrar';
      del.setAttribute('aria-label', `Borrar ${c.name || 'audio'}`);
      del.onclick = async () => {
        // confirmación en dos pulsaciones: borrar no tiene deshacer
        if (del.dataset.armed !== '1') {
          del.dataset.armed = '1';
          del.textContent = '¿Seguro?';
          setTimeout(() => { del.dataset.armed = ''; del.textContent = 'Borrar'; }, 2500);
          return;
        }
        await tx('readwrite', (os) => { os.delete(c.id); });
        decoded.delete(c.id);
        await refresh();
      };
      li.append(n, d, play, del);
      return li;
    }));
  }

  async function load(c: Clip): Promise<AudioBuffer> {
    const cached = decoded.get(c.id);
    if (cached) return cached;
    const rec = await tx<StoredClip>('readonly', (os) => os.get(c.id) as IDBRequest<StoredClip>);
    const a = audio();
    if (!rec || !a) throw new Error('missing');
    const buf = await a.decodeAudioData(rec.data.slice(0));
    decoded.set(c.id, buf);
    return buf;
  }

  async function add(blob: Blob, name: string) {
    const a = audio();
    if (!a) {
      status.textContent = 'Este navegador no puede reproducir audio aquí.';
      return;
    }
    let buf: AudioBuffer;
    const data = await blob.arrayBuffer();
    try {
      buf = await a.decodeAudioData(data.slice(0));
    } catch {
      status.textContent = 'No se pudo leer ese audio. Prueba con MP3, WAV, M4A u OGG.';
      return;
    }
    play_(buf, null);
    if (!canSave) {
      status.textContent = `${name} (sin guardar)`;
      return;
    }
    const createdAt = Date.now();
    const id = `v${createdAt.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const meta: Clip = { id, name, duration: +buf.duration.toFixed(2), mime: blob.type || 'audio/webm', createdAt };
    try {
      await tx('readwrite', (os) => { os.put({ ...meta, data } satisfies StoredClip); });
      decoded.set(id, buf);
      st.playingId = id;
      status.textContent = `Guardado: ${name}`;
      await refresh();
    } catch {
      status.textContent = 'Se reproduce, pero no se pudo guardar (¿sin espacio?).';
    }
  }

  function play_(buf: AudioBuffer, id: string | null) {
    const a = audio();
    if (!a) return;
    resumeAudio();
    stop();
    const src = a.createBufferSource();
    src.buffer = buf;
    const an = a.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0.35;
    src.connect(an);
    an.connect(a.destination);
    st.time = new Float32Array(an.fftSize);
    st.freq = new Uint8Array(an.frequencyBinCount);
    Object.assign(st, { src, an, on: true, peak: 0.05, playingId: id });
    src.onended = () => {
      if (st.src === src) {
        st.on = false;
        render();
      }
    };
    src.start();
    onPlay(buf.duration);
    render();
  }

  function stop() {
    try {
      st.src?.stop();
    } catch {
      /* ya parado */
    }
    st.on = false;
  }

  // ---- subir archivo
  q<HTMLButtonElement>('pick').onclick = () => {
    resumeAudio();
    fileInput.click();
  };
  fileInput.onchange = () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (f) void add(f, f.name.replace(/\.[^.]+$/, ''));
  };

  // ---- grabar con el micrófono (GitHub Pages sirve por HTTPS, así que el navegador lo permite)
  const rec = { mr: null as MediaRecorder | null, chunks: [] as Blob[], t0: 0, timer: 0 };
  recBtn.onclick = async () => {
    resumeAudio();
    if (rec.mr) {
      rec.mr.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      status.textContent = 'Este navegador no permite grabar.';
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      status.textContent = 'Sin acceso al micrófono. Permítelo en el navegador y vuelve a intentarlo.';
      return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t));
    const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    rec.mr = mr;
    rec.chunks = [];
    rec.t0 = performance.now();
    mr.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
    mr.onstop = () => {
      for (const t of stream.getTracks()) t.stop();
      clearInterval(rec.timer);
      rec.mr = null;
      recBtn.setAttribute('aria-pressed', 'false');
      recLabel.textContent = 'Grabar';
      const blob = new Blob(rec.chunks, { type: (mr.mimeType || 'audio/webm').split(';')[0] });
      const when = new Date().toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      if (blob.size) void add(blob, `Grabación ${when}`);
    };
    mr.start();
    recBtn.setAttribute('aria-pressed', 'true');
    recLabel.textContent = 'Detener 0:00';
    status.textContent = 'Grabando…';
    rec.timer = window.setInterval(() => {
      recLabel.textContent = `Detener ${fmt((performance.now() - rec.t0) / 1000)}`;
    }, 250);
  };

  void refresh();

  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  return {
    shape() {
      const a = audio();
      if (!st.on || !st.an || !a) return null;
      const an = st.an;
      an.getFloatTimeDomainData(st.time);
      an.getByteFrequencyData(st.freq);
      let sum = 0;
      for (const v of st.time) sum += v * v;
      const rms = Math.sqrt(sum / st.time.length);
      st.peak = Math.max(st.peak * 0.997, rms, 0.02); // ganancia automática
      const hz = a.sampleRate / an.fftSize;
      const band = (lo: number, hi: number) => {
        let t = 0, n = 0;
        for (let i = Math.floor(lo / hz); i <= Math.ceil(hi / hz) && i < st.freq.length; i++) { t += st.freq[i]!; n++; }
        return t / Math.max(1, n) / 255;
      };
      const low = band(250, 900), mid = band(900, 2200), high = band(2500, 5000);
      const lvl = rms / st.peak;
      const jaw = clamp01((lvl - 0.12) * 1.25);
      const wide = clamp01((high / (low + 0.02)) * 1.1 - 0.25) * Math.min(1, jaw * 1.5);
      const round = clamp01((low / (mid + 0.02) - 1.5) * 0.7) * jaw;
      st.onsetFlag = lvl > 0.45 && st.prev < 0.3;
      st.prev = lvl;
      return [jaw, wide, round];
    },
    onset() {
      const f = st.onsetFlag;
      st.onsetFlag = false;
      return f;
    },
    stop,
    dispose() {
      stop();
      if (rec.mr) rec.mr.stop();
      clearInterval(rec.timer);
      host.innerHTML = '';
    },
  };
}
