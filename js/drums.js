/* ------------------------------------------------------------------
 * Sound Pad — Drum Kit (synthesized, several kits)
 * Each voice is built from oscillators + filtered noise, so there are
 * no audio files to load. Metallic cymbals use stacked square
 * oscillators (the real TR-808/909 technique).
 *
 * Kits are data: every kit has the same 12 pads (so patterns carry over
 * when you switch kits) and only overrides the voice settings it wants
 * to change from the default "Hard" kit, plus an optional tone stage
 * on the whole kit (low-pass / bit-crush for Lo-Fi, …).
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

/** Voice settings of the default (Hard) kit. Other kits override parts of this. */
SoundPad.DRUM_DEFAULTS = {
  kick:  { start: 165, end: 45, sweep: 0.09, decay: 0.5, level: 1.2, drive: 8, click: 0.6, clickFreq: 1600, clickDecay: 0.02 },
  snare: { tones: [180, 330], toneLevels: [0.7, 0.4], toneDecay: 0.13, hp: 1800, bp: 4000, bpQ: 0.6, noise: 1.1, noiseDecay: 0.2 },
  clap:  { freq: 1200, q: 1.2, level: 1.0, tail: 0.2 },
  hat:   { bp: 10000, hp: 7000, level: 0.5, closed: 0.06, open: 0.4 },
  tom:   { ltom: 95, mtom: 150, htom: 220, bend: 1.8, decay: 0.4, level: 1.0 },
  rim:   { freq: 330, level: 0.7, noise: 0.8, decay: 0.03 },
  cow:   { freqs: [540, 800], bp: 2640, level: 0.45, decay: 0.32 },
  ride:  { decay: 0.9, bp: 5000, hp: 3000, level: 0.28, bell: 820, bellLevel: 0.18 },
  crash: { decay: 1.4, bp: 8000, hp: 4000, level: 0.32, noise: 0.5, noiseHp: 5000 },
};

SoundPad.DRUM_KITS = [
  { id: "hard", name: "Hard Kit", category: "Drums", voices: {} },
  {
    id: "909", name: "909 Kit", category: "Drums",
    voices: {
      kick:  { start: 230, end: 52, sweep: 0.05, decay: 0.35, drive: 10, click: 0.8, clickFreq: 2400, clickDecay: 0.012 },
      snare: { tones: [190, 345], toneDecay: 0.1, hp: 2600, bp: 5200, noise: 1.2, noiseDecay: 0.17 },
      clap:  { freq: 1500, q: 1.5, tail: 0.17 },
      hat:   { bp: 11500, hp: 8500, level: 0.45, closed: 0.045, open: 0.35 },
      tom:   { ltom: 110, mtom: 170, htom: 250, bend: 1.5, decay: 0.32 },
      crash: { decay: 1.7, bp: 9000 },
    },
  },
  {
    id: "trap", name: "Trap Kit", category: "Drums",
    voices: {
      kick:  { start: 120, end: 42, sweep: 0.06, decay: 1.1, level: 1.3, drive: 4, click: 0.35, clickFreq: 1200 },
      snare: { tones: [210, 400], toneLevels: [0.55, 0.3], toneDecay: 0.09, hp: 2400, bp: 6000, bpQ: 0.8, noise: 1.0, noiseDecay: 0.14 },
      clap:  { freq: 1350, q: 1.0, level: 1.2, tail: 0.28 },
      hat:   { bp: 12000, hp: 9000, level: 0.42, closed: 0.035, open: 0.3 },
      rim:   { freq: 420, decay: 0.025 },
    },
  },
  {
    id: "lofi", name: "Lo-Fi Kit", category: "Drums",
    tone: { lowpass: 5200, crush: 5 },
    voices: {
      kick:  { start: 120, end: 48, sweep: 0.08, decay: 0.42, drive: 2, click: 0.25 },
      snare: { tones: [170, 300], toneDecay: 0.15, hp: 1200, bp: 2600, noise: 0.85, noiseDecay: 0.22 },
      clap:  { freq: 1000, tail: 0.25 },
      // hats/cymbals sit lower so they survive the kit's low-pass
      hat:   { bp: 6500, hp: 4200, level: 0.85, closed: 0.07, open: 0.45 },
      ride:  { bp: 4200, hp: 2600, level: 0.4 },
      crash: { bp: 5000, hp: 3000, level: 0.45, noiseHp: 3500, decay: 1.2 },
    },
  },
];

SoundPad.drumKit = (id) => SoundPad.DRUM_KITS.find((k) => k.id === id) || SoundPad.DRUM_KITS[0];

SoundPad.DrumKit = class DrumKit {
  constructor(engine, channel, kitId) {
    this.engine = engine;
    this.channel = channel || null;
    this.curves = {};
    this.toneIn = null;      // first node of the kit's tone stage (if any)

    // id, display name, keyboard key, and a play(time, out) function.
    this.drums = [
      { id: "kick",  name: "Kick",       key: "Z", play: (t, o) => this._kick(t, o) },
      { id: "snare", name: "Snare",      key: "X", play: (t, o) => this._snare(t, o) },
      { id: "clap",  name: "Clap",       key: "C", play: (t, o) => this._clap(t, o) },
      { id: "hat",   name: "Closed Hat", key: "V", play: (t, o) => this._hat(t, o, this.v.hat.closed) },
      { id: "open",  name: "Open Hat",   key: "B", play: (t, o) => this._hat(t, o, this.v.hat.open) },
      { id: "ltom",  name: "Low Tom",    key: "A", play: (t, o) => this._tom(t, o, this.v.tom.ltom) },
      { id: "mtom",  name: "Mid Tom",    key: "S", play: (t, o) => this._tom(t, o, this.v.tom.mtom) },
      { id: "htom",  name: "High Tom",   key: "D", play: (t, o) => this._tom(t, o, this.v.tom.htom) },
      { id: "rim",   name: "Rimshot",    key: "F", play: (t, o) => this._rim(t, o) },
      { id: "cow",   name: "Cowbell",    key: "G", play: (t, o) => this._cowbell(t, o) },
      { id: "ride",  name: "Ride",       key: "N", play: (t, o) => this._ride(t, o) },
      { id: "crash", name: "Crash",      key: "M", play: (t, o) => this._crash(t, o) },
    ];
    this.byId = Object.fromEntries(this.drums.map((d) => [d.id, d]));
    this.setPreset(kitId);
  }

  get ctx() { return this.engine.ctx; }

  /** Where voices go: the kit's tone stage if it has one, else the track channel. */
  get out() {
    const dest = this.channel ? this.channel.input : this.engine.master;
    if (!this.kit.tone) return dest;
    if (!this.toneIn) this._buildTone(dest);
    return this.toneIn;
  }

  /** Switch kit (same pads, different sound). */
  setPreset(id) {
    this.kit = SoundPad.drumKit(id);
    const v = {};
    Object.entries(SoundPad.DRUM_DEFAULTS).forEach(([voice, defaults]) => {
      v[voice] = { ...defaults, ...(this.kit.voices[voice] || {}) };
    });
    this.v = v;
    if (this.toneNodes) this.toneNodes.forEach((n) => n.disconnect());
    this.toneIn = null;
    this.toneNodes = null;
  }

  _buildTone(dest) {
    const ctx = this.ctx, tone = this.kit.tone, nodes = [];
    if (tone.crush) {
      const crush = ctx.createWaveShaper();
      crush.curve = this._crushCurve(tone.crush);
      nodes.push(crush);
    }
    if (tone.lowpass) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = tone.lowpass;
      lp.Q.value = 0.5;
      nodes.push(lp);
    }
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    nodes[nodes.length - 1].connect(dest);
    this.toneNodes = nodes;
    this.toneIn = nodes[0];
  }

  /** Instrument contract. Drums ignore duration (one-shots). */
  trigger(id, time, durSec, vel = SoundPad.DEFAULT_VEL) {
    const d = this.byId[id];
    if (!d) return;
    let out = this.out;
    const gain = SoundPad.velToGain(vel);
    if (gain !== 1) {
      const g = this.ctx.createGain();
      g.gain.value = gain;
      g.connect(out);
      out = g;
    }
    d.play(time, out);
  }

  // --- Shared helpers ------------------------------------------------

  /** Soft-clip curve for saturation/drive (adds harmonics = "hardness"). */
  _driveCurve(k) {
    const key = "d" + k;
    if (!this.curves[key]) {
      const n = 1024, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
      }
      this.curves[key] = curve;
    }
    return this.curves[key];
  }

  /** Stair-step curve: fewer amplitude levels = gritty "bit-crushed" sound. */
  _crushCurve(bits) {
    const key = "c" + bits;
    if (!this.curves[key]) {
      const n = 4096, levels = Math.pow(2, bits), curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        curve[i] = Math.round(x * levels) / levels;
      }
      this.curves[key] = curve;
    }
    return this.curves[key];
  }

  /**
   * Metallic tone: 6 detuned square oscillators through band/high-pass.
   * This is the core of realistic hats, ride and crash — a square wave's
   * rich harmonics, filtered high, give the clangy metal character.
   */
  _metal(t, out, { decay, bandpass, highpass, gain }) {
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
    bp.connect(hp).connect(g).connect(out);

    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    oscs.forEach((o) => { o.start(t); o.stop(t + decay + 0.02); });
  }

  // --- Voices --------------------------------------------------------

  _kick(t, out) {
    const ctx = this.ctx, k = this.v.kick;
    // Body: sine with a fast, deep pitch drop, driven through saturation.
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(k.start, t);
    osc.frequency.exponentialRampToValueAtTime(k.end, t + k.sweep);
    const shaper = ctx.createWaveShaper();
    shaper.curve = this._driveCurve(k.drive);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(k.level, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + k.decay);
    osc.connect(shaper).connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + k.decay);

    // Click transient for beater attack (the "hard" part of the front).
    if (!k.click) return;
    const click = ctx.createOscillator();
    click.type = "square";
    click.frequency.value = k.clickFreq;
    const cGain = ctx.createGain();
    cGain.gain.setValueAtTime(k.click, t);
    cGain.gain.exponentialRampToValueAtTime(0.001, t + k.clickDecay);
    click.connect(cGain).connect(out);
    click.start(t);
    click.stop(t + k.clickDecay + 0.01);
  }

  _snare(t, out) {
    const ctx = this.ctx, s = this.v.snare;
    // Tuned two-oscillator body for weight and pitch.
    s.tones.forEach((f, idx) => {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(s.toneLevels[idx] ?? 0.4, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + s.toneDecay);
      osc.connect(g).connect(out);
      osc.start(t);
      osc.stop(t + s.toneDecay + 0.01);
    });

    // Bright noise snap = the snare wires.
    const noise = this.engine.noiseSource();
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = s.hp;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = s.bp;
    bp.Q.value = s.bpQ;
    const g = ctx.createGain();
    g.gain.setValueAtTime(s.noise, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + s.noiseDecay);
    noise.connect(hp).connect(bp).connect(g).connect(out);
    noise.start(t);
    noise.stop(t + s.noiseDecay + 0.02);
  }

  _hat(t, out, decay) {
    const h = this.v.hat;
    this._metal(t, out, { decay, bandpass: h.bp, highpass: h.hp, gain: h.level });
  }

  _ride(t, out) {
    const r = this.v.ride;
    // Longer metallic sustain plus a tonal "ping" bell.
    this._metal(t, out, { decay: r.decay, bandpass: r.bp, highpass: r.hp, gain: r.level });
    const ctx = this.ctx;
    const bell = ctx.createOscillator();
    bell.type = "square";
    bell.frequency.value = r.bell;
    const g = ctx.createGain();
    g.gain.setValueAtTime(r.bellLevel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    bell.connect(g).connect(out);
    bell.start(t);
    bell.stop(t + 0.42);
  }

  _crash(t, out) {
    const c = this.v.crash;
    // Long metal wash + filtered noise splash.
    this._metal(t, out, { decay: c.decay, bandpass: c.bp, highpass: c.hp, gain: c.level });
    const noise = this.engine.noiseSource();
    noise.loop = true;
    const hp = this.ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = c.noiseHp;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(c.noise, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + c.decay * 0.85);
    noise.connect(hp).connect(g).connect(out);
    noise.start(t);
    noise.stop(t + c.decay * 0.85 + 0.05);
  }

  _clap(t, out) {
    const ctx = this.ctx, c = this.v.clap;
    // Three quick noise bursts give the characteristic clap flam.
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = c.freq;
    filter.Q.value = c.q;
    const gain = ctx.createGain();
    filter.connect(gain).connect(out);

    const noise = this.engine.noiseSource();
    noise.connect(filter);

    [0, 0.01, 0.02].forEach((o) => {
      gain.gain.setValueAtTime(c.level, t + o);
      gain.gain.exponentialRampToValueAtTime(0.03, t + o + 0.02);
    });
    gain.gain.setValueAtTime(c.level, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.001, t + c.tail);
    noise.start(t);
    noise.stop(t + c.tail + 0.02);
  }

  _tom(t, out, freq) {
    const ctx = this.ctx, m = this.v.tom;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq * m.bend, t);
    osc.frequency.exponentialRampToValueAtTime(freq, t + 0.1);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(m.level, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + m.decay);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + m.decay + 0.02);
  }

  _rim(t, out) {
    const ctx = this.ctx, r = this.v.rim;
    // Sharp "tick": short tonal blip + a tight noise click.
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = r.freq;
    const og = ctx.createGain();
    og.gain.setValueAtTime(r.level, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + r.decay);
    osc.connect(og).connect(out);
    osc.start(t);
    osc.stop(t + r.decay + 0.01);

    const noise = this.engine.noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2000;
    bp.Q.value = 2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(r.noise, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + r.decay);
    noise.connect(bp).connect(ng).connect(out);
    noise.start(t);
    noise.stop(t + r.decay + 0.01);
  }

  _cowbell(t, out) {
    const ctx = this.ctx, c = this.v.cow;
    // Two square oscillators (classic 808 cowbell ratio) through bandpass.
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = c.bp;
    bp.Q.value = 1;
    const gain = ctx.createGain();
    bp.connect(gain).connect(out);

    c.freqs.forEach((f) => {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = f;
      osc.connect(bp);
      osc.start(t);
      osc.stop(t + c.decay + 0.03);
    });
    gain.gain.setValueAtTime(c.level, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + c.decay);
  }
};

SoundPad.Instruments.register("drums", {
  label: "Drum Kit",
  editor: "DrumView",
  presets: SoundPad.DRUM_KITS,
  defaultPreset: "hard",
  create: (engine, channel, preset) => new SoundPad.DrumKit(engine, channel, preset),
});
