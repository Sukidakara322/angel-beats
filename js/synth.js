/* ------------------------------------------------------------------
 * Sound Pad — Synth (one engine, many presets) + note helpers
 *
 * Every pitched track uses this instrument; a preset is plain data that
 * picks one of three voice engines and sets its parameters:
 *
 *   "sub"       subtractive: oscillators (with unison/detune/stereo
 *               spread) + sub-osc + noise → drive → filter (with its own
 *               sweep) → amp envelope. Bass, leads, pads, plucks, FX.
 *   "fm"        2-operator FM (+ optional extra "tine" modulator):
 *               electric piano, bells, mallets, glassy pads.
 *   "additive"  stacked sine partials: organ.
 *
 * Shared preset fields:
 *   amp: { a, d, s, r }  envelope (seconds; s = sustain level 0..1;
 *                        a: "note" = attack lasts the whole note)
 *   vibrato: { rate, depth (cents), delay }
 *   pitch:   { from (semitones), time }   pitch drop at note start
 *   gain:    loudness trim so presets sit at similar levels
 *   base:    MIDI note the playable keyboard starts on
 *
 * Every note is its own voice, so the synth is fully polyphonic.
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

// --- Musical helpers ------------------------------------------------
SoundPad.NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
SoundPad.midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
SoundPad.midiName = (m) => SoundPad.NAMES[m % 12] + (Math.floor(m / 12) - 1);
SoundPad.isNatural = (m) => !SoundPad.NAMES[m % 12].includes("#");

// --- Presets ----------------------------------------------------------
// Filter "from"/"to" are multiples of the note frequency when keyTrack
// is true, otherwise Hz. time: "note" = sweep across the whole note.
SoundPad.SYNTH_PRESETS = [
  // ---- Bass ----
  {
    id: "growl-bass", name: "Growl Bass", category: "Bass", base: 28, engine: "sub", gain: 1,
    osc: [{ type: "sawtooth", gain: 0.55 }, { type: "square", gain: 0.25, detune: -8 }],
    sub: 0.7, drive: 6,
    filter: { type: "lowpass", q: 6, from: 9, to: 2.2, time: 0.14, keyTrack: true, min: 180, max: 4500 },
    amp: { a: 0.008, d: 0.12, s: 0.58, r: 0.06 },
  },
  {
    id: "sub-bass", name: "Sub Bass", category: "Bass", base: 28, engine: "sub", gain: 0.9,
    osc: [{ type: "sine", gain: 0.9 }, { type: "sine", gain: 0.12, octave: 1 }],
    drive: 1.5,
    amp: { a: 0.006, d: 0.2, s: 0.9, r: 0.08 },
  },
  {
    id: "808-bass", name: "808 Bass", category: "Bass", base: 28, engine: "sub", gain: 1,
    osc: [{ type: "sine", gain: 1 }],
    pitch: { from: 7, time: 0.07 }, drive: 4,
    amp: { a: 0.002, d: 1.4, s: 0.55, r: 0.3 },
  },
  {
    id: "reese-bass", name: "Reese Bass", category: "Bass", base: 28, engine: "sub", gain: 0.95,
    osc: [{ type: "sawtooth", gain: 0.5, unison: 2, spread: 24 }, { type: "sawtooth", gain: 0.25, octave: -1 }],
    sub: 0.4, drive: 3,
    filter: { type: "lowpass", q: 2, from: 700, to: 420, time: 0.4 },
    amp: { a: 0.01, d: 0.3, s: 0.9, r: 0.1 },
  },
  {
    id: "acid-bass", name: "Acid Bass", category: "Bass", base: 33, engine: "sub", gain: 0.85,
    osc: [{ type: "sawtooth", gain: 0.8 }],
    drive: 5,
    filter: { type: "lowpass", q: 14, from: 14, to: 1.6, time: 0.18, keyTrack: true, min: 120, max: 6000 },
    amp: { a: 0.003, d: 0.2, s: 0.7, r: 0.05 },
  },
  {
    id: "pluck-bass", name: "Pluck Bass", category: "Bass", base: 28, engine: "sub", gain: 1.05,
    osc: [{ type: "square", gain: 0.45 }, { type: "sawtooth", gain: 0.35, detune: 6 }],
    sub: 0.5,
    filter: { type: "lowpass", q: 4, from: 14, to: 1.2, time: 0.09, keyTrack: true, min: 120, max: 5000 },
    amp: { a: 0.002, d: 0.25, s: 0.2, r: 0.08 },
  },

  // ---- Lead ----
  {
    id: "saw-lead", name: "Saw Lead", category: "Lead", base: 60, engine: "sub", gain: 1.8,
    osc: [{ type: "sawtooth", gain: 0.5, unison: 2, spread: 14 }],
    filter: { type: "lowpass", q: 3, from: 9, to: 5, time: 0.3, keyTrack: true, max: 12000 },
    vibrato: { rate: 5.5, depth: 14, delay: 0.25 },
    amp: { a: 0.01, d: 0.2, s: 0.8, r: 0.15 },
  },
  {
    id: "square-lead", name: "Square Lead", category: "Lead", base: 60, engine: "sub", gain: 1,
    osc: [{ type: "square", gain: 0.5 }, { type: "square", gain: 0.2, octave: -1, detune: 4 }],
    filter: { type: "lowpass", q: 1, from: 7, to: 4, time: 0.25, keyTrack: true, max: 10000 },
    vibrato: { rate: 5.5, depth: 12, delay: 0.3 },
    amp: { a: 0.01, d: 0.15, s: 0.85, r: 0.12 },
  },
  {
    id: "supersaw", name: "Supersaw", category: "Lead", base: 60, engine: "sub", gain: 2,
    osc: [{ type: "sawtooth", gain: 0.7, unison: 7, spread: 34, stereo: 0.8 }],
    filter: { type: "lowpass", q: 0.8, from: 12, to: 8, time: 0.4, keyTrack: true, max: 14000 },
    amp: { a: 0.012, d: 0.3, s: 0.85, r: 0.3 },
  },
  {
    id: "whistle-lead", name: "Whistle Lead", category: "Lead", base: 72, engine: "sub", gain: 0.9,
    osc: [{ type: "sine", gain: 0.7 }, { type: "triangle", gain: 0.15, octave: 1 }],
    vibrato: { rate: 5, depth: 20, delay: 0.2 },
    amp: { a: 0.04, d: 0.1, s: 0.9, r: 0.2 },
  },

  // ---- Pad ----
  {
    id: "warm-pad", name: "Warm Pad", category: "Pad", base: 48, engine: "sub", gain: 1.5,
    osc: [{ type: "sawtooth", gain: 0.55, unison: 3, spread: 22, stereo: 0.7 }, { type: "triangle", gain: 0.3, octave: -1 }],
    filter: { type: "lowpass", q: 0.7, from: 1.5, to: 5, time: 1.4, keyTrack: true, min: 200, max: 8000 },
    amp: { a: 0.6, d: 1, s: 0.8, r: 1.2 },
  },
  {
    id: "dark-pad", name: "Dark Pad", category: "Pad", base: 48, engine: "sub", gain: 1.4,
    osc: [{ type: "triangle", gain: 0.5, unison: 2, spread: 12, stereo: 0.6 }, { type: "sawtooth", gain: 0.25, octave: -1 }],
    filter: { type: "lowpass", q: 1.5, from: 350, to: 1100, time: 2.5 },
    amp: { a: 1, d: 1, s: 0.9, r: 1.6 },
  },
  {
    id: "strings", name: "String Ensemble", category: "Pad", base: 55, engine: "sub", gain: 2,
    osc: [{ type: "sawtooth", gain: 0.6, unison: 5, spread: 18, stereo: 0.8 }],
    filter: { type: "lowpass", q: 0.5, from: 3.5, to: 3, time: 0.5, keyTrack: true, max: 9000 },
    vibrato: { rate: 5, depth: 7, delay: 0.3 },
    amp: { a: 0.25, d: 0.5, s: 0.9, r: 0.6 },
  },
  {
    id: "glass-pad", name: "Glass Pad", category: "Pad", base: 60, engine: "fm", gain: 0.85,
    fm: { ratio: 2, index: 1.4, indexEnd: 0.6, indexTime: 1.5, detune: 7 },
    amp: { a: 0.4, d: 1, s: 0.7, r: 1.5 },
  },

  // ---- Keys & plucks ----
  {
    id: "e-piano", name: "Electric Piano", category: "Keys", base: 60, engine: "fm", gain: 0.7,
    fm: { ratio: 1, index: 2.2, indexEnd: 0.25, indexTime: 1.2, velIndex: true, tine: { ratio: 14, index: 0.5, time: 0.06 } },
    amp: { a: 0.002, d: 2, s: 0.25, r: 0.35 },
  },
  {
    id: "soft-keys", name: "Soft Keys", category: "Keys", base: 60, engine: "sub", gain: 1.45,
    osc: [{ type: "triangle", gain: 0.6 }, { type: "sine", gain: 0.25, octave: 1 }, { type: "sawtooth", gain: 0.06, detune: 3 }],
    filter: { type: "lowpass", q: 0.5, from: 12, to: 3, time: 0.6, keyTrack: true, max: 9000 },
    amp: { a: 0.003, d: 1.6, s: 0.15, r: 0.3 },
  },
  {
    id: "organ", name: "Organ", category: "Keys", base: 60, engine: "additive", gain: 1.2,
    partials: [[0.5, 0.6], [1, 0.8], [2, 0.6], [3, 0.3], [4, 0.35], [6, 0.12], [8, 0.18]],
    vibrato: { rate: 6.5, depth: 6, delay: 0 },
    amp: { a: 0.005, d: 0.05, s: 1, r: 0.06 },
  },
  {
    id: "bell", name: "Bell", category: "Keys", base: 72, engine: "fm", gain: 0.65,
    fm: { ratio: 3.5, index: 5, indexEnd: 0.05, indexTime: 2.5 },
    amp: { a: 0.001, d: 3.5, s: 0, r: 1.2 },
  },
  {
    id: "mallet", name: "Mallet", category: "Keys", base: 60, engine: "fm", gain: 0.8,
    fm: { ratio: 4, index: 3, indexEnd: 0.05, indexTime: 0.08 },
    amp: { a: 0.001, d: 0.6, s: 0, r: 0.2 },
  },
  {
    id: "pluck", name: "Pluck", category: "Keys", base: 60, engine: "sub", gain: 1.05,
    osc: [{ type: "sawtooth", gain: 0.5 }, { type: "square", gain: 0.25, detune: 7 }],
    filter: { type: "lowpass", q: 2, from: 16, to: 1.2, time: 0.12, keyTrack: true, max: 12000 },
    amp: { a: 0.002, d: 0.35, s: 0, r: 0.1 },
  },

  // ---- FX ----
  {
    id: "riser", name: "Noise Riser", category: "FX", base: 60, engine: "sub", gain: 1.7, minDur: 0.5,
    osc: [{ type: "sawtooth", gain: 0.12 }], noise: 0.9,
    filter: { type: "bandpass", q: 2.5, from: 300, to: 9000, time: "note" },
    pitch: { from: -12, time: "note" },
    amp: { a: "note", d: 0.1, s: 1, r: 0.1 },
  },
  {
    id: "downlifter", name: "Downlifter", category: "FX", base: 60, engine: "sub", gain: 0.8, minDur: 0.5,
    noise: 1,
    filter: { type: "lowpass", q: 4, from: 9000, to: 150, time: "note" },
    amp: { a: 0.01, d: 0.1, s: 1, r: 0.3 },
  },
];

SoundPad.synthPreset = (id) =>
  SoundPad.SYNTH_PRESETS.find((p) => p.id === id) || SoundPad.SYNTH_PRESETS[0];

// --- Instrument -------------------------------------------------------
SoundPad.Synth = class Synth {
  constructor(engine, channel, presetId) {
    this.engine = engine;
    this.channel = channel || null;
    this.curves = {};
    this.setPreset(presetId);
  }

  get ctx() { return this.engine.ctx; }
  get out() { return this.channel ? this.channel.input : this.engine.master; }

  setPreset(id) {
    this.preset = SoundPad.synthPreset(id);
  }

  /** Instrument contract: key is a MIDI note number. */
  trigger(midi, time, durSec, vel = SoundPad.DEFAULT_VEL) {
    const p = this.preset;
    const dur = Math.max(p.minDur || 0.08, durSec);
    const v = {
      ctx: this.ctx,
      t: time,
      dur,
      freq: SoundPad.midiToFreq(midi),
      vel,
      peak: SoundPad.velToGain(vel) * (p.gain ?? 1),
    };
    if (p.engine === "fm") this._fm(p, v);
    else if (p.engine === "additive") this._additive(p, v);
    else this._subtractive(p, v);
  }

  // --- Building blocks ---------------------------------------------

  /** Amp envelope on a gain param; returns when the voice can be stopped. */
  _ampEnv(param, v, env) {
    const t = v.t, end = t + v.dur;
    const a = env.a === "note" ? v.dur * 0.9 : Math.max(0.001, Math.min(env.a ?? 0.005, v.dur));
    const s = env.s ?? 1, d = env.d ?? 0.1, r = env.r ?? 0.05;
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(v.peak, t + a);
    if (s < 1) param.setTargetAtTime(v.peak * s, t + a, Math.max(0.002, d / 4));
    const off = Math.max(end, t + a);
    param.setTargetAtTime(0, off, Math.max(0.002, r / 4));
    return off + r * 1.5 + 0.02;
  }

  _filter(p, v) {
    const f = p.filter;
    if (!f) return null;
    const node = v.ctx.createBiquadFilter();
    node.type = f.type || "lowpass";
    node.Q.value = f.q ?? 0.7;
    const hz = (x) => Math.min(f.max ?? 18000, Math.max(f.min ?? 20, f.keyTrack ? x * v.freq : x));
    const from = hz(f.from), to = hz(f.to ?? f.from);
    const time = f.time === "note" ? v.dur : f.time ?? 0.1;
    node.frequency.setValueAtTime(from, v.t);
    if (to !== from) node.frequency.exponentialRampToValueAtTime(to, v.t + time);
    return node;
  }

  _shaper(k) {
    if (!this.curves[k]) {
      const n = 1024, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
      }
      this.curves[k] = curve;
    }
    const s = this.ctx.createWaveShaper();
    s.curve = this.curves[k];
    return s;
  }

  /** Vibrato LFO (cents) shared by a voice's oscillators; null if the preset has none. */
  _vibrato(p, v, sources) {
    const vb = p.vibrato;
    if (!vb) return null;
    const lfo = v.ctx.createOscillator();
    lfo.frequency.value = vb.rate;
    const depth = v.ctx.createGain();
    depth.gain.setValueAtTime(0, v.t);
    depth.gain.linearRampToValueAtTime(vb.depth, v.t + Math.max(0.01, vb.delay || 0.01));
    lfo.connect(depth);
    sources.push(lfo);
    return depth;
  }

  /** Pitch drop/rise at the note start, applied to an oscillator's frequency. */
  _pitchEnv(p, v, param, freq) {
    if (!p.pitch) { param.value = freq; return; }
    const time = p.pitch.time === "note" ? v.dur : p.pitch.time;
    param.setValueAtTime(freq * Math.pow(2, p.pitch.from / 12), v.t);
    param.exponentialRampToValueAtTime(freq, v.t + time);
  }

  _start(sources, t, stop) {
    sources.forEach((s) => { s.start(t); s.stop(stop); });
  }

  // --- Engines ---------------------------------------------------------

  _subtractive(p, v) {
    const ctx = v.ctx, sources = [];
    const amp = ctx.createGain();
    amp.connect(this.out);

    // oscillators → pre → [drive] → [filter] → amp
    const pre = ctx.createGain();
    let node = pre;
    if (p.drive) { const sh = this._shaper(p.drive); node.connect(sh); node = sh; }
    const filt = this._filter(p, v);
    if (filt) { node.connect(filt); node = filt; }
    node.connect(amp);

    const vib = this._vibrato(p, v, sources);
    (p.osc || []).forEach((o) => {
      const n = o.unison || 1;
      const f = v.freq * Math.pow(2, (o.octave || 0) + (o.semi || 0) / 12);
      for (let u = 0; u < n; u++) {
        const spreadPos = n > 1 ? u / (n - 1) - 0.5 : 0;     // -0.5 … 0.5
        const osc = ctx.createOscillator();
        osc.type = o.type || "sawtooth";
        this._pitchEnv(p, v, osc.frequency, f);
        osc.detune.value = (o.detune || 0) + spreadPos * (o.spread || 0);
        if (vib) vib.connect(osc.detune);
        const g = ctx.createGain();
        g.gain.value = (o.gain ?? 0.5) / Math.sqrt(n);
        osc.connect(g);
        if (o.stereo && n > 1 && ctx.createStereoPanner) {
          const pan = ctx.createStereoPanner();
          pan.pan.value = spreadPos * 2 * o.stereo;
          g.connect(pan).connect(pre);
        } else {
          g.connect(pre);
        }
        sources.push(osc);
      }
    });

    if (p.sub) {   // clean sine an octave down, bypasses drive + filter
      const sub = ctx.createOscillator();
      sub.type = "sine";
      this._pitchEnv(p, v, sub.frequency, v.freq / 2);
      const g = ctx.createGain();
      g.gain.value = p.sub;
      sub.connect(g).connect(amp);
      sources.push(sub);
    }

    if (p.noise) {
      const src = this.engine.noiseSource();
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = p.noise;
      src.connect(g).connect(pre);
      sources.push(src);
    }

    const stop = this._ampEnv(amp.gain, v, p.amp || {});
    this._start(sources, v.t, stop);
  }

  _fm(p, v) {
    const ctx = v.ctx, sources = [], fm = p.fm;
    const amp = ctx.createGain();
    amp.connect(this.out);
    const vib = this._vibrato(p, v, sources);
    const velScale = fm.velIndex ? 0.5 + 0.7 * v.vel : 1;
    const detunes = fm.detune ? [-fm.detune / 2, fm.detune / 2] : [0];

    detunes.forEach((cents) => {
      const car = ctx.createOscillator();
      car.type = "sine";
      car.frequency.value = v.freq;
      car.detune.value = cents;
      if (vib) vib.connect(car.detune);

      const addMod = (ratio, index, indexEnd, time) => {
        const mod = ctx.createOscillator();
        mod.frequency.value = v.freq * ratio;
        mod.detune.value = cents;
        const depth = ctx.createGain();
        const hz = v.freq * ratio;
        depth.gain.setValueAtTime(index * hz * velScale, v.t);
        depth.gain.exponentialRampToValueAtTime(Math.max(0.01, indexEnd * hz * velScale), v.t + time);
        mod.connect(depth).connect(car.frequency);
        sources.push(mod);
      };
      addMod(fm.ratio, fm.index, fm.indexEnd ?? fm.index, fm.indexTime ?? 1);
      if (fm.tine) addMod(fm.tine.ratio, fm.tine.index, 0.001, fm.tine.time);

      const g = ctx.createGain();
      g.gain.value = 1 / detunes.length;
      car.connect(g).connect(amp);
      sources.push(car);
    });

    const stop = this._ampEnv(amp.gain, v, p.amp || {});
    this._start(sources, v.t, stop);
  }

  _additive(p, v) {
    const ctx = v.ctx, sources = [];
    const amp = ctx.createGain();
    amp.connect(this.out);
    const vib = this._vibrato(p, v, sources);
    const total = p.partials.reduce((s, [, g]) => s + g, 0);
    p.partials.forEach(([ratio, gain]) => {
      const f = v.freq * ratio;
      if (f > 16000) return;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      if (vib) vib.connect(osc.detune);
      const g = ctx.createGain();
      g.gain.value = gain / total;
      osc.connect(g).connect(amp);
      sources.push(osc);
    });
    const stop = this._ampEnv(amp.gain, v, p.amp || {});
    this._start(sources, v.t, stop);
  }
};

SoundPad.Instruments.register("synth", {
  label: "Synth",
  editor: "PianoRollView",
  presets: SoundPad.SYNTH_PRESETS,
  defaultPreset: "growl-bass",
  create: (engine, channel, preset) => new SoundPad.Synth(engine, channel, preset),
  // Wide roll (C1–C7) for every preset; the keyboard starts where the preset sits.
  editorOptions: (track) => ({ low: 24, high: 96, base: SoundPad.synthPreset(track.preset).base }),
});
