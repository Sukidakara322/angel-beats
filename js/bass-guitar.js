/* ------------------------------------------------------------------
 * Sound Pad — Electric bass guitar
 *
 * Same physical string model as the guitar (js/guitar.js), tuned for a
 * bass: thick strings whose highs die quickly, bass pickup positions
 * (neck / both / bridge), and picked or finger-style attack.
 *
 * The bass AMP is where metal and grunge bass tones come from. Distorting
 * the whole bass turns the low end to mush, so real rigs SPLIT it:
 *
 *            ┌─ low end (below the crossover) — kept clean ─────────┐
 *   input → comp                                                     ├→ EQ → cab → volume
 *            └─ above the crossover → dirt (Grind or Fuzz) × Blend ──┘
 *
 *   Grind (metal)  — tight crossover (~250 Hz), mid-pushed, bright
 *                    "clank" (modern metal / djent bass).
 *   Fuzz (grunge)  — low crossover (~110 Hz) so more body gets fuzzed,
 *                    harder symmetric clipping, darker top, mild scoop.
 *
 * With distortion off the whole signal goes through a warm clean channel.
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

/** Sound controls for bass guitar tracks (rendered by ParamPanel). */
SoundPad.BASS_GUITAR_PARAMS = [
  { group: "Amp", id: "dist", label: "Distortion", type: "toggle" },
  { group: "Amp", id: "dirt", label: "Dirt type", type: "select", options: [["grind", "Grind"], ["fuzz", "Fuzz"]] },
  { group: "Amp", id: "drive", label: "Drive", type: "range", min: 0, max: 1, step: 0.01, unit: "%" },
  { group: "Amp", id: "blend", label: "Blend", type: "range", min: 0, max: 1, step: 0.01, unit: "%" },
  { group: "Amp", id: "comp", label: "Compressor", type: "range", min: 0, max: 1, step: 0.01, unit: "%" },
  { group: "Amp", id: "bass", label: "Bass", type: "range", min: -12, max: 12, step: 0.5, unit: "dB" },
  { group: "Amp", id: "mid", label: "Mid", type: "range", min: -12, max: 12, step: 0.5, unit: "dB" },
  { group: "Amp", id: "treble", label: "Treble", type: "range", min: -12, max: 12, step: 0.5, unit: "dB" },
  { group: "Amp", id: "level", label: "Volume", type: "range", min: 0, max: 1.5, step: 0.01, unit: "%" },
  { group: "Bass", id: "pickup", label: "Pickup", type: "select", options: [["neck", "Neck"], ["both", "Both"], ["bridge", "Bridge"]] },
  { group: "Bass", id: "style", label: "Play with", type: "select", options: [["pick", "Pick"], ["finger", "Fingers"]] },
  { group: "Bass", id: "bright", label: "Attack", type: "range", min: 0, max: 1, step: 0.01, unit: "%" },
  { group: "Bass", id: "sustain", label: "Sustain", type: "range", min: 0, max: 1, step: 0.01, unit: "%" },
  { group: "Playing", id: "mute", label: "Palm mute", type: "toggle" },
];

SoundPad.BASS_GUITAR_DEFAULTS = {
  dist: false, dirt: "grind", drive: 0.5, blend: 0.5, comp: 0.4,
  bass: 0, mid: 0, treble: 0, level: 1,
  pickup: "both", style: "pick", bright: 0.6, sustain: 0.6,
  mute: false, strum: 5, strumDir: "down",
};

SoundPad.BASS_GUITAR_PRESETS = [
  { id: "metal-bass", name: "Metal Bass", category: "Bass",
    params: { dist: true, dirt: "grind", drive: 0.7, blend: 0.55, comp: 0.6, bass: 3, mid: -2, treble: 4,
      pickup: "bridge", style: "pick", bright: 0.8, sustain: 0.6 } },
  { id: "grunge-bass", name: "Grunge Bass", category: "Bass",
    params: { dist: true, dirt: "fuzz", drive: 0.55, blend: 0.5, comp: 0.45, bass: 2, mid: 3, treble: -1,
      pickup: "neck", style: "pick", bright: 0.6, sustain: 0.7 } },
  { id: "sludge-bass", name: "Sludge Bass", category: "Bass",
    params: { dist: true, dirt: "fuzz", drive: 0.9, blend: 0.7, comp: 0.5, bass: 4, mid: -2, treble: -4, level: 0.88,
      pickup: "neck", style: "pick", bright: 0.5, sustain: 0.9 } },
  { id: "pick-bass", name: "Rock Pick Bass", category: "Bass",
    params: { dist: false, drive: 0.35, comp: 0.5, bass: 2, mid: 1, treble: 2,
      pickup: "both", style: "pick", bright: 0.65, sustain: 0.6 } },
  { id: "finger-bass", name: "Finger Bass", category: "Bass",
    params: { dist: false, drive: 0.2, comp: 0.4, bass: 3, mid: 0, treble: -2, level: 0.85,
      pickup: "neck", style: "finger", bright: 0.45, sustain: 0.65 } },
];

SoundPad.bassGuitarPreset = (id) =>
  SoundPad.BASS_GUITAR_PRESETS.find((p) => p.id === id) || SoundPad.BASS_GUITAR_PRESETS[0];

SoundPad.bassGuitarParams = (presetId, overrides) => ({
  ...SoundPad.BASS_GUITAR_DEFAULTS,
  ...SoundPad.bassGuitarPreset(presetId).params,
  ...(overrides || {}),
});

/** Bass pickups: comb positions (fraction of string length from the bridge) + resonance. */
SoundPad.BASS_PICKUPS = {
  neck:   { pos: [0.2],       res: [2400, 1.0] },
  both:   { pos: [0.2, 0.1],  res: [3000, 1.1] },
  bridge: { pos: [0.1],       res: [3600, 1.3] },
};

/** The two dirt circuits. */
SoundPad.BASS_DIRT = {
  grind: { xover: 250, preF: 1000, preQ: 0.7, preG: 6, postF: 500, postG: 0, lp: 5200, level: 0.42 },
  fuzz:  { xover: 110, preF: 300, preQ: 0.7, preG: 3, postF: 750, postG: -4, lp: 3000, level: 0.4 },
};

SoundPad.BassGuitar = class BassGuitar extends SoundPad.Guitar {
  constructor(engine, channel, presetId, overrides) {
    super(engine, channel, presetId, overrides);
    this.cacheMax = 48;           // bass notes are long buffers
  }

  _params(presetId, overrides) { return SoundPad.bassGuitarParams(presetId, overrides); }

  _stringOptions(p) {
    const pu = SoundPad.BASS_PICKUPS[p.pickup] || SoundPad.BASS_PICKUPS.both;
    const finger = p.style === "finger";
    return {
      pickups: pu.pos, res: pu.res,
      // The string is pulled into a triangle (strong fundamental). A pick near the
      // bridge = bright, clanky attack with some scrape; fingers further up = round and soft.
      shape: "pluck",
      pickPos: finger ? 0.22 : 0.08,
      grit: finger ? 0.04 : 0.1 + 0.3 * p.bright,
      soften: finger ? 400 + p.bright * 1600 : 1500 + p.bright * 6000,
      bright: finger ? p.bright * 0.55 : p.bright,
      // Thick strings: the highs die away much faster than on a guitar.
      loopLp: finger ? 900 + p.bright * 1800 : 2200 + p.bright * 4000,
      sustain: p.sustain, mute: p.mute,
      ring: 0.75, maxLen: 6,
    };
  }

  // --- The bass amp -------------------------------------------------------

  _buildAmp() {
    const ctx = this.ctx;
    const dest = this.channel ? this.channel.input : this.engine.master;
    const biquad = (type, freq, q = 0.707, gain = 0) => {
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q; f.gain.value = gain;
      return f;
    };
    const a = {};
    a.input = ctx.createGain();

    // Compressor first: evens out the picking so the low end sits steady.
    a.comp = ctx.createDynamicsCompressor();
    a.comp.knee.value = 8;
    a.comp.attack.value = 0.003;     // fast enough to catch pick transients
    a.comp.release.value = 0.15;
    a.compOut = ctx.createGain();

    // Distortion off: the whole bass through a warm clean channel.
    a.cleanShaper = ctx.createWaveShaper();
    a.cleanShaper.oversample = "2x";
    a.cleanMix = ctx.createGain();

    // Distortion on, path 1: the low end, kept clean. Two Butterworth stages =
    // Linkwitz–Riley crossover (Web Audio's low/high-pass Q is in dB: -3 dB = Butterworth).
    const BW = -3.01;
    a.lowLp1 = biquad("lowpass", 250, BW);
    a.lowLp2 = biquad("lowpass", 250, BW);
    a.lowMix = ctx.createGain();

    // Distortion on, path 2: everything above the crossover → dirt.
    a.dirtHp1 = biquad("highpass", 250, BW);
    a.dirtHp2 = biquad("highpass", 250, BW);
    a.dirtPre = biquad("peaking", 1000, 0.7, 6);
    a.dirtShaper = ctx.createWaveShaper();
    a.dirtShaper.oversample = "4x";
    a.dirtPost = biquad("peaking", 500, 0.8, 0);
    a.dirtLp = biquad("lowpass", 5200);
    a.dirtMix = ctx.createGain();

    // Tone stack.
    a.bass = biquad("lowshelf", 90);
    a.mid = biquad("peaking", 650, 0.8);
    a.treble = biquad("highshelf", 2500);

    // Bass cabinet (8x10-ish): subsonic cut, a little low thump, top roll-off.
    a.cabHp = biquad("highpass", 36);
    a.cabThump = biquad("peaking", 80, 1, 1.5);
    a.cabLp1 = biquad("lowpass", 4500, 0.8);
    a.cabLp2 = biquad("lowpass", 7500, 0.5);

    a.level = ctx.createGain();

    a.input.connect(a.comp).connect(a.compOut);
    a.compOut.connect(a.cleanShaper).connect(a.cleanMix).connect(a.bass);
    a.compOut.connect(a.lowLp1).connect(a.lowLp2).connect(a.lowMix).connect(a.bass);
    a.compOut.connect(a.dirtHp1).connect(a.dirtHp2).connect(a.dirtPre).connect(a.dirtShaper)
      .connect(a.dirtPost).connect(a.dirtLp).connect(a.dirtMix).connect(a.bass);
    a.bass.connect(a.mid).connect(a.treble)
      .connect(a.cabHp).connect(a.cabThump).connect(a.cabLp1).connect(a.cabLp2)
      .connect(a.level).connect(dest);

    this.amp = a;
    this._applyAmp(true);
  }

  /** Fuzz: hard, symmetric clipping with a sharp knee (lots of sustain). */
  _fuzzCurve(gain) {
    const key = `fuzz|${gain.toFixed(0)}`;
    if (!this.curves[key]) {
      const n = 4096, c = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = gain * ((i * 2) / n - 1);
        c[i] = x / Math.pow(1 + Math.pow(Math.abs(x), 4), 0.25);
      }
      this.curves[key] = c;
    }
    return this.curves[key];
  }

  _applyAmp(immediate = false) {
    const a = this.amp, p = this.p;
    const t = this.ctx.currentTime;
    const set = (param, v) => (immediate ? (param.value = v) : param.setTargetAtTime(v, t, 0.02));
    const d = SoundPad.BASS_DIRT[p.dirt] || SoundPad.BASS_DIRT.grind;

    // Compressor: more = lower threshold + higher ratio (+ make-up gain).
    set(a.comp.threshold, -p.comp * 30);
    set(a.comp.ratio, 1 + p.comp * 7);
    set(a.compOut.gain, Math.pow(10, (p.comp * 4) / 20));

    // Distortion switch = crossfade between the clean channel and the split rig.
    set(a.cleanMix.gain, p.dist ? 0 : 1);
    set(a.lowMix.gain, p.dist ? 1 : 0);
    set(a.dirtMix.gain, p.dist ? d.level * (0.5 + 0.9 * p.blend) : 0);
    a.cleanShaper.curve = this._curve(1 + p.drive * 2, 0.05);
    a.dirtShaper.curve = p.dirt === "fuzz"
      ? this._fuzzCurve(8 + p.drive * p.drive * 250)
      : this._curve(6 + p.drive * p.drive * 120, 0.15);

    // Dirt voicing.
    [a.lowLp1, a.lowLp2, a.dirtHp1, a.dirtHp2].forEach((f) => set(f.frequency, d.xover * (p.mute ? 1.3 : 1)));
    set(a.dirtPre.frequency, d.preF);
    a.dirtPre.Q.value = d.preQ;
    set(a.dirtPre.gain, d.preG);
    set(a.dirtPost.frequency, d.postF);
    set(a.dirtPost.gain, d.postG);
    set(a.dirtLp.frequency, d.lp);

    set(a.bass.gain, p.bass);
    set(a.mid.gain, p.mid);
    set(a.treble.gain, p.treble);
    set(a.cabLp1.frequency, p.dist ? 4500 : 5500);

    set(a.level.gain, p.level * 0.8);   // output trim: sits level with the other instruments
  }
};

SoundPad.Instruments.register("bass-guitar", {
  label: "Bass Guitar",
  editor: "PianoRollView",
  presets: SoundPad.BASS_GUITAR_PRESETS,
  defaultPreset: "metal-bass",
  menuRank: -1,                      // bass guitars first in the menu's Bass column
  params: SoundPad.BASS_GUITAR_PARAMS,
  effectiveParams: (track) => SoundPad.bassGuitarParams(track.preset, track.params),
  create: (engine, channel, preset, overrides) => new SoundPad.BassGuitar(engine, channel, preset, overrides),
  // B0 (5-string / drop tunings) … G4; keyboard starts at the low E string (E1).
  editorOptions: () => ({ low: 23, high: 67, base: 28 }),
});
