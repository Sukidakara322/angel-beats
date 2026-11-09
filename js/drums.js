/* ------------------------------------------------------------------
 * Sound Pad — Drum Kit (synthesized, hard-hitting)
 * Each voice is built from oscillators + filtered noise, so there are
 * no audio files to load. Design goals: punchy transients, saturation,
 * and metallic cymbals built from stacked square oscillators (the real
 * TR-808/909 technique) rather than plain filtered noise.
 *
 * `DRUMS` is a data list: pads and sequencer rows are generated from it,
 * so adding a voice is a one-liner.
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.DrumKit = class DrumKit {
  constructor(engine) {
    this.engine = engine;
    this.driveCurve = this._shaperCurve(8); // reused saturation curve

    // id, display name, keyboard key, and a trigger(time) function.
    this.drums = [
      { id: "kick",  name: "Kick",     key: "Z", trigger: (t) => this._kick(t) },
      { id: "snare", name: "Snare",    key: "X", trigger: (t) => this._snare(t) },
      { id: "clap",  name: "Clap",     key: "C", trigger: (t) => this._clap(t) },
      { id: "hat",   name: "Closed Hat", key: "V", trigger: (t) => this._hat(t, 0.06) },
      { id: "open",  name: "Open Hat",   key: "B", trigger: (t) => this._hat(t, 0.4) },
      { id: "ltom",  name: "Low Tom",  key: "A", trigger: (t) => this._tom(t, 95) },
      { id: "mtom",  name: "Mid Tom",  key: "S", trigger: (t) => this._tom(t, 150) },
      { id: "htom",  name: "High Tom", key: "D", trigger: (t) => this._tom(t, 220) },
      { id: "rim",   name: "Rimshot",  key: "F", trigger: (t) => this._rim(t) },
      { id: "cow",   name: "Cowbell",  key: "G", trigger: (t) => this._cowbell(t) },
      { id: "ride",  name: "Ride",     key: "N", trigger: (t) => this._ride(t) },
      { id: "crash", name: "Crash",    key: "M", trigger: (t) => this._crash(t) },
    ];
  }

  get ctx() { return this.engine.ctx; }
  get out() { return this.engine.master; }

  trigger(id, time) {
    const d = this.drums.find((x) => x.id === id);
    if (d) d.trigger(time);
  }

  // --- Shared helpers ------------------------------------------------

  /** Soft-clip curve for saturation/drive (adds harmonics = "hardness"). */
  _shaperCurve(k) {
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  /**
   * Metallic tone: 6 detuned square oscillators through band/high-pass.
   * This is the core of realistic hats, ride and crash — a square wave's
   * rich harmonics, filtered high, give the clangy metal character.
   */
  _metal(t, { decay, bandpass, highpass, gain }) {
    const ctx = this.ctx;
    const fundamental = 40;
    const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = bandpass;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = highpass;
    const g = ctx.createGain();

    const oscs = ratios.map((r) => {
      const o = ctx.createOscillator();
      o.type = "square";
      o.frequency.value = fundamental * r;
      o.connect(bp);
      return o;
    });
    bp.connect(hp).connect(g).connect(this.out);

    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    oscs.forEach((o) => { o.start(t); o.stop(t + decay + 0.02); });
  }

  // --- Voices --------------------------------------------------------

  _kick(t) {
    const ctx = this.ctx;
    // Body: sine with a fast, deep pitch drop, driven through saturation.
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(165, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.09);
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.driveCurve;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(1.2, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    osc.connect(shaper).connect(gain).connect(this.out);
    osc.start(t);
    osc.stop(t + 0.5);

    // Click transient for beater attack (the "hard" part of the front).
    const click = ctx.createOscillator();
    click.type = "square";
    click.frequency.value = 1600;
    const cGain = ctx.createGain();
    cGain.gain.setValueAtTime(0.6, t);
    cGain.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
    click.connect(cGain).connect(this.out);
    click.start(t);
    click.stop(t + 0.03);
  }

  _snare(t) {
    const ctx = this.ctx;
    // Tuned two-oscillator body for weight and pitch.
    [180, 330].forEach((f, idx) => {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(idx === 0 ? 0.7 : 0.4, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
      osc.connect(g).connect(this.out);
      osc.start(t);
      osc.stop(t + 0.14);
    });

    // Bright noise snap = the snare wires.
    const noise = this.engine.noiseSource();
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1800;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 4000;
    bp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(1.1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    noise.connect(hp).connect(bp).connect(g).connect(this.out);
    noise.start(t);
    noise.stop(t + 0.22);
  }

  _hat(t, decay) {
    this._metal(t, { decay, bandpass: 10000, highpass: 7000, gain: 0.5 });
  }

  _ride(t) {
    // Longer metallic sustain plus a tonal "ping" bell.
    this._metal(t, { decay: 0.9, bandpass: 5000, highpass: 3000, gain: 0.28 });
    const ctx = this.ctx;
    const bell = ctx.createOscillator();
    bell.type = "square";
    bell.frequency.value = 820;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    bell.connect(g).connect(this.out);
    bell.start(t);
    bell.stop(t + 0.42);
  }

  _crash(t) {
    // Long metal wash + filtered noise splash.
    this._metal(t, { decay: 1.4, bandpass: 8000, highpass: 4000, gain: 0.32 });
    const noise = this.engine.noiseSource();
    const hp = this.ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 5000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
    noise.connect(hp).connect(g).connect(this.out);
    noise.start(t);
    noise.stop(t + 1.25);
  }

  _clap(t) {
    // Three quick noise bursts give the characteristic clap flam.
    const ctx = this.ctx;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1200;
    filter.Q.value = 1.2;
    const gain = ctx.createGain();
    filter.connect(gain).connect(this.out);

    const noise = this.engine.noiseSource();
    noise.connect(filter);

    [0, 0.01, 0.02].forEach((o) => {
      gain.gain.setValueAtTime(1.0, t + o);
      gain.gain.exponentialRampToValueAtTime(0.03, t + o + 0.02);
    });
    gain.gain.setValueAtTime(1.0, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    noise.start(t);
    noise.stop(t + 0.22);
  }

  _tom(t, freq) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq * 1.8, t);
    osc.frequency.exponentialRampToValueAtTime(freq, t + 0.1);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(1.0, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    osc.connect(gain).connect(this.out);
    osc.start(t);
    osc.stop(t + 0.42);
  }

  _rim(t) {
    // Sharp "tick": short tonal blip + a tight noise click.
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = 330;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.7, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    osc.connect(og).connect(this.out);
    osc.start(t);
    osc.stop(t + 0.04);

    const noise = this.engine.noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2000;
    bp.Q.value = 2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.8, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    noise.connect(bp).connect(ng).connect(this.out);
    noise.start(t);
    noise.stop(t + 0.04);
  }

  _cowbell(t) {
    // Two square oscillators (classic 808 cowbell ratio) through bandpass.
    const ctx = this.ctx;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2640;
    bp.Q.value = 1;
    const gain = ctx.createGain();
    bp.connect(gain).connect(this.out);

    [540, 800].forEach((f) => {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = f;
      osc.connect(bp);
      osc.start(t);
      osc.stop(t + 0.35);
    });
    gain.gain.setValueAtTime(0.45, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
  }
};
