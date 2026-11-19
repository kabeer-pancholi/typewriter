let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;
let master: GainNode | null = null;

function audio(): AudioContext {
  const c = (ctx ??= new AudioContext());
  if (c.state === 'suspended') void c.resume();
  if (!noise) {
    noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (!master) {
    const comp = c.createDynamicsCompressor();
    master = c.createGain();
    master.gain.value = 0.9;
    master.connect(comp).connect(c.destination);
  }
  return c;
}

interface Burst { type: BiquadFilterType; freq: number; q: number; dur: number; vol: number }

/** Filtered noise burst with an instant attack and exponential decay. */
function burst(c: AudioContext, t: number, o: Burst) {
  const src = c.createBufferSource();
  src.buffer = noise!;
  src.playbackRate.value = 0.9 + Math.random() * 0.2;
  const f = c.createBiquadFilter();
  f.type = o.type;
  f.frequency.value = o.freq;
  f.Q.value = o.q;
  const g = c.createGain();
  g.gain.setValueAtTime(o.vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  src.connect(f).connect(g).connect(master!);
  src.start(t, Math.random() * 0.5);
  src.stop(t + o.dur + 0.01);
}

/** Low sine thump: the frame absorbing the blow. */
function thud(c: AudioContext, t: number, f0: number, f1: number, dur: number, vol: number) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master!);
  o.start(t);
  o.stop(t + dur + 0.01);
}

/** Manual typewriter: key strike, space bar or carriage return. */
export function click(kind: boolean | 'space' = false) {
  try {
    const c = audio();
    const t = c.currentTime + 0.001;
    const v = 0.85 + Math.random() * 0.3;

    if (kind === true) {
      // Carriage return: lever thunk, ratchet run, hard stop.
      thud(c, t, 90, 50, 0.1, 0.5);
      burst(c, t, { type: 'bandpass', freq: 600, q: 1.5, dur: 0.06, vol: 0.4 });
      for (let i = 0; i < 20; i++) {
        burst(c, t + 0.06 + i * 0.019, {
          type: 'bandpass', freq: 3000 + Math.random() * 2000, q: 4, dur: 0.008, vol: 0.13 + Math.random() * 0.05,
        });
      }
      const e = t + 0.5;
      burst(c, e, { type: 'bandpass', freq: 900, q: 1.8, dur: 0.05, vol: 0.6 });
      burst(c, e, { type: 'highpass', freq: 3000, q: 0.7, dur: 0.012, vol: 0.35 });
      thud(c, e, 100, 45, 0.12, 0.5);
      return;
    }

    if (kind === 'space') {
      thud(c, t, 110, 55, 0.08, 0.4 * v);
      burst(c, t, { type: 'bandpass', freq: 700 + Math.random() * 200, q: 1.5, dur: 0.04, vol: 0.3 * v });
      burst(c, t + 0.045, { type: 'bandpass', freq: 4500, q: 4, dur: 0.008, vol: 0.14 });
      return;
    }

    burst(c, t, { type: 'highpass', freq: 3500, q: 0.7, dur: 0.012, vol: 0.5 * v });
    burst(c, t, { type: 'bandpass', freq: 1100 + Math.random() * 500, q: 2.5, dur: 0.03, vol: 0.55 * v });
    thud(c, t, 150, 65, 0.06, 0.35 * v);
    burst(c, t + 0.045, { type: 'bandpass', freq: 5000, q: 4, dur: 0.008, vol: 0.18 });
  } catch {
    /* audio unavailable */
  }
}

/** Margin bell. Not wired in by default. */
export function bell() {
  try {
    const c = audio();
    const t = c.currentTime;
    for (const [f, vol] of [[2350, 0.12], [3170, 0.07], [5000, 0.03]] as const) {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      o.connect(g).connect(master!);
      o.start(t);
      o.stop(t + 1.45);
    }
  } catch {
    /* audio unavailable */
  }
}