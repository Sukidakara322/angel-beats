/* ------------------------------------------------------------------
 * Sound Pad — Electric guitar
 *
 * Two parts, like the real thing:
 *
 * 1. The STRING (per note) — a physical "plucked string" model
 *    (Karplus–Strong): a short burst of noise (the pick) circulates in a
 *    tuned delay loop with a gentle filter, so it rings at the note's
 *    pitch and decays like a string. On top of that:
 *      • pick position  — comb filter on the pluck (where you pick)
 *      • pickup position — comb filter on the output (neck = warm,
 *        bridge = bright/thin)
 *      • palm mute       — very short decay + darker loop filter
 *    Each note is computed once in JS (a few ms) and cached (3 slightly
 *    different takes per note, so repeated notes don't sound robotic).
 *
 * 2. The AMP (one per track, shared by all notes) — so chords distort
 *    together, like a real amp:
 *      input → clean/drive stage (switchable distortion) → bass/mid/
 *      treble → speaker cabinet → volume → track channel
 *
 * Chords are strummed: notes starting together are spread a few ms
 * apart (down / up / alternating), low strings first on a down-strum.
 * Playing the same pitch again cuts the previous one (same string).
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

/** Sound controls for guitar tracks (rendered by ParamPanel). */
SoundPad.GUITAR_PARAMS = [
  { group: "Amp", id: "dist", label: "Distortion", type: "toggle" },
  { group: "Amp", id: "drive", label: "Drive", type: "range", min: 0, max: 1, step: 0.01, unit: "%" },
  { group: "Amp", id: "bass", label: "Bass", type: "range", min: -12, max: 12, step: 0.5, unit: "dB" },
  { group: "Amp", id: "mid", label: "Mid", type: "range", min: -12, max: 12, step: 0.5, unit: "dB" },
  { group: "Amp", id: "treble", label: "Treble", type: "range", min: -12, max: 12, step: 0.5, unit: "dB" },
  { group: "Amp", id: "level", label: "Volume", type: "range", min: 0, max: 1.5, step: 0.01, unit: "%" },
  { group: "Guitar", id: "pickup", label: "Pickup", type: "select", options: [["neck", "Neck"], ["middle", "Middle"], ["bridge", "Bridge"]] },
  { group: "Guitar", id: "bright", label: "Pick attack", type: "range", min: 0, max: 1, step: 0.01, unit: "%" },
  { group: "Guitar", id: "sustain", label: "Sustain", type: "range", min: 0, max: 1, step: 0.01, unit: "%" },
  { group: "Playing", id: "mute", label: "Palm mute", type: "toggle" },
  { group: "Playing", id: "strum", label: "Strum speed", type: "range", min: 0, max: 40, step: 1, unit: "ms" },
  { group: "Playing", id: "strumDir", label: "Strum", type: "select", options: [["down", "Down"], ["up", "Up"], ["alt", "Alternate"]] },
];

SoundPad.GUITAR_DEFAULTS = {
  dist: false, drive: 0.3, bass: 0, mid: 0, treble: 0, level: 1,
  pickup: "middle", bright: 0.55, sustain: 0.6,
  mute: false, strum: 12, strumDir: "down",
};

SoundPad.GUITAR_PRESETS = [
  { id: "clean", name: "Clean Guitar", category: "Guitar",
    params: { dist: false, drive: 0.25, bass: 1, mid: 0, treble: 2, pickup: "middle", bright: 0.55, sustain: 0.6, strum: 12 } },
  { id: "funk", name: "Funk Guitar", category: "Guitar",
    params: { dist: false, drive: 0.15, bass: -2, mid: -1, treble: 5, pickup: "bridge", bright: 0.8, sustain: 0.3, strum: 8 } },
  { id: "jazz", name: "Jazz Guitar", category: "Guitar",
    params: { dist: false, drive: 0.1, bass: 3, mid: 1, treble: -5, pickup: "neck", bright: 0.3, sustain: 0.55, strum: 16 } },
  { id: "crunch", name: "Crunch Guitar", category: "Guitar",
    params: { dist: true, drive: 0.42, bass: 2, mid: 2, treble: 1, pickup: "bridge", bright: 0.6, sustain: 0.7, strum: 10 } },
  { id: "rock-lead", name: "Rock Lead", category: "Guitar",
    params: { dist: true, drive: 0.75, bass: 0, mid: 4, treble: 1, pickup: "neck", bright: 0.65, sustain: 0.95, strum: 0 } },
  { id: "metal", name: "Metal Rhythm", category: "Guitar",
    params: { dist: true, drive: 0.95, bass: 4, mid: -5, treble: 3, pickup: "bridge", bright: 0.75, sustain: 0.7, mute: true, strum: 6 } },
];

SoundPad.guitarPreset = (id) =>
  SoundPad.GUITAR_PRESETS.find((p) => p.id === id) || SoundPad.GUITAR_PRESETS[0];

/** Preset params + the track's own tweaks (+ defaults for anything missing). */
SoundPad.guitarParams = (presetId, overrides) => ({
  ...SoundPad.GUITAR_DEFAULTS,
  ...SoundPad.guitarPreset(presetId).params,
  ...(overrides || {}),
});

SoundPad.Guitar = class Guitar {
  constructor(engine, channel, presetId, overrides) {
    this.engine = engine;
    this.channel = channel || null;
    this.cache = new Map();        // note buffers (LRU)
    this.takes = 0;                // round-robin counter for note variations
    this.voices = new Map();       // midi → { src, gain } (same pitch cuts the previous note)
    this.curves = {};
    this.amp = null;               // amp nodes, built on first use
    this.altUp = false;            // alternate-strum state
    this.liveDur = 1.2;            // how long a note rings when played live from the keyboard
    this.presetId = presetId;
    this.overrides = overrides || {};
    this.p = SoundPad.guitarParams(presetId, this.overrides);
  }

  get ctx() { return this.engine.ctx; }

  setPreset(id) {
    this.presetId = id;
    this.overrides = {};
    this._paramsChanged();
  }

  /** The track's tweaks on top of its preset (live — works while playing). */
  setParams(overrides) {
    this.overrides = overrides || {};
    this._paramsChanged();
  }

  _paramsChanged() {
    this.p = SoundPad.guitarParams(this.presetId, this.overrides);
    if (this.amp) this._applyAmp();
  }

  // --- Playing ---------------------------------------------------------

  /** Instrument contract: one note. */
  trigger(midi, time, durSec, vel = SoundPad.DEFAULT_VEL) {
    this._pluck(midi, time, durSec, vel);
  }

  /** Several notes starting together → a strum. */
  triggerChord(notes, time) {
    const p = this.p;
    let dir = p.strumDir;
    if (dir === "alt") { dir = this.altUp ? "up" : "down"; this.altUp = !this.altUp; }
    const sorted = notes.slice().sort((a, b) => (dir === "up" ? b.key - a.key : a.key - b.key));
    const gap = p.strum / 1000;
    sorted.forEach((n, i) => {
      const jitter = gap ? (Math.random() - 0.5) * gap * 0.3 : 0;   // human timing
      const t = time + i * gap + Math.max(0, jitter);
      this._pluck(n.key, t, Math.max(0.05, n.dur - i * gap), n.vel * (1 - i * 0.03));
    });
  }

  _pluck(midi, time, dur, vel) {
    const ctx = this.ctx;
    const buffer = this._noteBuffer(midi, vel);

    // Same pitch again → the previous note on that "string" stops.
    const prev = this.voices.get(midi);
    if (prev) {
      prev.gain.gain.setTargetAtTime(0, time, 0.008);
      try { prev.src.stop(time + 0.06); } catch { /* already stopped */ }
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = SoundPad.velToGain(vel);
    // Note off = the fretting hand lets go: a quick (not clicky) fade.
    const end = time + Math.max(0.04, dur);
    g.gain.setValueAtTime(g.gain.value, end);
    g.gain.setTargetAtTime(0, end, 0.03);
    src.connect(g).connect(this._ampIn());
    src.start(time);
    src.stop(Math.min(time + buffer.duration, end + 0.25));
    const voice = { src, gain: g };
    this.voices.set(midi, voice);
    src.onended = () => { if (this.voices.get(midi) === voice) this.voices.delete(midi); };
  }

  // --- The string (Karplus–Strong) --------------------------------------

  /** Cached note buffer for the current string settings (3 takes per note). */
  _noteBuffer(midi, vel) {
    const p = this.p;
    const take = this.takes++ % 3;
    const velBucket = Math.round(vel * 3);
    const sr = this.ctx.sampleRate;
    const key = [midi, velBucket, take, p.pickup, p.bright, p.sustain, p.mute, sr].join("|");
    let buf = this.cache.get(key);
    if (buf) {
      this.cache.delete(key);       // refresh LRU position
      this.cache.set(key, buf);
      return buf;
    }
    const data = SoundPad.Guitar.renderString({
      freq: SoundPad.midiToFreq(midi), sr, vel: velBucket / 3,
      pickup: p.pickup, bright: p.bright, sustain: p.sustain, mute: p.mute,
    });
    buf = this.ctx.createBuffer(1, data.length, sr);
    buf.getChannelData(0).set(data);
    this.cache.set(key, buf);
    if (this.cache.size > 72) this.cache.delete(this.cache.keys().next().value);
    return buf;
  }

  /**
   * Render one plucked note into a Float32Array.
   * Pure function (no audio context) — easy to test and reuse.
   */
  static renderString({ freq, sr, vel = 0.8, pickup = "middle", bright = 0.55, sustain = 0.6, mute = false }) {
    const P = sr / freq;                                   // period in samples
    // Ring time (to -60 dB): longer for low strings, much shorter when palm-muted.
    const t60 = mute
      ? 0.2 + sustain * 0.35
      : (0.8 + sustain * 7) * Math.pow(110 / freq, 0.45);
    const len = Math.ceil(sr * (Math.min(7, t60 * 0.85) + 0.05));
    const out = new Float32Array(len);

    // Loop filter: weighted 2-tap average. s → 1 = less damping (brighter ring).
    const s = mute ? 0.5 : 0.5 + 0.42 * (0.35 + 0.65 * bright) * (0.6 + 0.4 * sustain);
    const D = P - (1 - s);                                 // compensate the filter's delay → in tune
    const g = Math.pow(0.001, 1 / (t60 * freq));           // per-period loss for the chosen ring time

    // Excitation: one period of noise, darker for soft picking / low brightness,
    // then a comb at the pick position (picking near the bridge = brighter).
    const n = Math.max(2, Math.round(P));
    const exc = new Float32Array(n);
    const c = Math.min(0.97, 0.15 + 0.8 * bright * (0.55 + 0.45 * vel)) * (mute ? 0.55 : 1);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      lp += c * ((Math.random() * 2 - 1) - lp);
      exc[i] = lp;
    }
    const pick = Math.max(1, Math.round(P * 0.13));
    for (let i = n - 1; i >= pick; i--) exc[i] -= exc[i - pick];

    // The string loop (fractional delay with linear interpolation → accurate tuning).
    const read = (t) => {
      if (t < 0) return 0;
      const i0 = Math.floor(t), f = t - i0;
      return out[i0] * (1 - f) + (i0 + 1 < len ? out[i0 + 1] : 0) * f;
    };
    // Extra one-pole low-pass inside the loop when palm-muted (thuddy, short).
    let mlp = 0;
    const mc = 0.35;
    for (let i = 0; i < len; i++) {
      let fb = g * (s * read(i - D) + (1 - s) * read(i - D - 1));
      if (mute) { mlp += mc * (fb - mlp); fb = mlp; }
      out[i] = (i < n ? exc[i] : 0) + fb;
    }

    // Pickup position: comb on the output (which harmonics the pickup "sees")…
    const pu = { neck: 0.27, middle: 0.17, bridge: 0.09 }[pickup] || 0.17;
    const k = Math.max(1, Math.round(P * pu));
    for (let i = len - 1; i >= k; i--) out[i] -= out[i - k];
    for (let i = k - 1; i >= 0; i--) out[i] = 0.5 * out[i];

    // …and the pickup's own electrical resonance: a resonant low-pass that sits
    // low for the neck pickup (warm) and high for the bridge pickup (bright).
    const res = { neck: [2300, 1.1], middle: [3400, 1.3], bridge: [5200, 1.6] }[pickup] || [3400, 1.3];
    SoundPad.Guitar._lowpass(out, sr, res[0], res[1]);

    // Normalise: same loudness across the neck (RMS of the first ~60 ms).
    const win = Math.min(len, Math.round(sr * 0.06));
    let sum = 0;
    for (let i = 0; i < win; i++) sum += out[i] * out[i];
    const rms = Math.sqrt(sum / win) || 1;
    const norm = 0.22 / rms;
    for (let i = 0; i < len; i++) out[i] *= norm;
    // Tiny fade-out at the very end so the buffer never stops with a click.
    const fade = Math.min(len, Math.round(sr * 0.02));
    for (let i = 0; i < fade; i++) out[len - 1 - i] *= i / fade;
    return out;
  }

  /** In-place 2-pole resonant low-pass (RBJ biquad) over a Float32Array. */
  static _lowpass(x, sr, freq, q) {
    const w = (2 * Math.PI * Math.min(freq, sr * 0.45)) / sr;
    const alpha = Math.sin(w) / (2 * q), cos = Math.cos(w);
    const a0 = 1 + alpha;
    const b0 = (1 - cos) / 2 / a0, b1 = (1 - cos) / a0, b2 = b0;
    const a1 = (-2 * cos) / a0, a2 = (1 - alpha) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
      x[i] = y;
    }
  }

  // --- The amp ----------------------------------------------------------

  _ampIn() {
    if (!this.amp) this._buildAmp();
    return this.amp.input;
  }

  _buildAmp() {
    const ctx = this.ctx;
    const dest = this.channel ? this.channel.input : this.engine.master;
    const biquad = (type, freq, q = 0.7, gain = 0) => {
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q; f.gain.value = gain;
      return f;
    };
    const a = {};
    a.input = ctx.createGain();

    // Clean channel: a touch of warmth that breaks up a little when pushed.
    a.cleanShaper = ctx.createWaveShaper();
    a.cleanShaper.oversample = "2x";
    a.cleanMix = ctx.createGain();

    // Drive channel: tighten lows → mid hump (like a TS pedal) → hard clip → tame fizz.
    a.tight = biquad("highpass", 110, 0.7);
    a.hump = biquad("peaking", 720, 0.9, 5);
    a.distShaper = ctx.createWaveShaper();
    a.distShaper.oversample = "4x";
    a.fizz = biquad("lowpass", 6500, 0.6);
    a.distMix = ctx.createGain();

    // Tone stack.
    a.bass = biquad("lowshelf", 120);
    a.mid = biquad("peaking", 800, 0.8);
    a.treble = biquad("highshelf", 3000);

    // Speaker cabinet (4x12-ish): low cut, a little thump and presence, steep top roll-off.
    a.cabHp = biquad("highpass", 75, 0.7);
    a.cabThump = biquad("peaking", 110, 1, 2.5);
    a.cabPresence = biquad("peaking", 2400, 1.2, 3);
    a.cabLp1 = biquad("lowpass", 5000, 0.9);
    a.cabLp2 = biquad("lowpass", 6500, 0.5);

    a.level = ctx.createGain();

    a.input.connect(a.cleanShaper).connect(a.cleanMix).connect(a.bass);
    a.input.connect(a.tight).connect(a.hump).connect(a.distShaper).connect(a.fizz).connect(a.distMix).connect(a.bass);
    a.bass.connect(a.mid).connect(a.treble)
      .connect(a.cabHp).connect(a.cabThump).connect(a.cabPresence).connect(a.cabLp1).connect(a.cabLp2)
      .connect(a.level).connect(dest);

    this.amp = a;
    this._applyAmp(true);
  }

  /** Soft-clip curve with a little asymmetry (even harmonics, like a tube). */
  _curve(drive, bias) {
    const key = `${drive.toFixed(1)}|${bias}`;
    if (!this.curves[key]) {
      const n = 4096, c = new Float32Array(n);
      const off = Math.tanh(bias);
      let max = 0;
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        c[i] = Math.tanh(drive * x + bias) - off;
        max = Math.max(max, Math.abs(c[i]));
      }
      for (let i = 0; i < n; i++) c[i] /= max;
      this.curves[key] = c;
    }
    return this.curves[key];
  }

  _applyAmp(immediate = false) {
    const a = this.amp, p = this.p;
    const t = this.ctx.currentTime;
    const set = (param, v) => (immediate ? (param.value = v) : param.setTargetAtTime(v, t, 0.02));

    // Distortion switch = crossfade between the two channels.
    set(a.cleanMix.gain, p.dist ? 0 : 1);
    set(a.distMix.gain, p.dist ? 0.44 : 0);           // ≈ same loudness as clean, so the switch doesn't jump
    a.cleanShaper.curve = this._curve(1 + p.drive * 2.5, 0.05);
    a.distShaper.curve = this._curve(4 + p.drive * p.drive * 140, 0.2);
    set(a.tight.frequency, p.mute ? 170 : 110);          // palm mute = tighter low end

    set(a.bass.gain, p.bass);
    set(a.mid.gain, p.mid);
    set(a.treble.gain, p.treble);
    set(a.cabLp1.frequency, p.dist ? 5000 : 6800);        // clean amps sound a bit more open

    set(a.level.gain, p.level * (p.dist ? 1 : 1.1));
  }
};

SoundPad.Instruments.register("guitar", {
  label: "Guitar",
  editor: "PianoRollView",
  presets: SoundPad.GUITAR_PRESETS,
  defaultPreset: "clean",
  params: SoundPad.GUITAR_PARAMS,
  effectiveParams: (track) => SoundPad.guitarParams(track.preset, track.params),
  create: (engine, channel, preset, overrides) => new SoundPad.Guitar(engine, channel, preset, overrides),
  // Guitar range (A1 for drop tunings … F#6); keyboard starts at the low E string.
  editorOptions: () => ({ low: 33, high: 90, base: 40 }),
});
