/* ------------------------------------------------------------------
 * Sound Pad — Mixing: the per-track channel strip + shared effect buses
 *
 * Channel (one per track) — what every instrument plays into:
 *
 *   input → low cut → EQ low/mid/high → compressor → chorus (dry + 2 voices)
 *         → duck (sidechain) → fader → pan → master
 *                                 └→ reverb send → Reverb bus ┐
 *                                 └→ delay send  → Delay bus  ┴→ master
 *
 * All values come from the track (track.volume, track.pan, track.fx), so
 * the same Channel works live and in the offline WAV render. Every effect
 * at its default value is transparent.
 *
 * Sidechain: a track ducks when its source track plays a note (for a drum
 * source: a kick). Note-triggered rather than audio-detected, so it is
 * sample-exact and identical in the export.
 *
 * Nodes are created lazily on first use (the AudioContext only exists
 * after the first user gesture).
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.Mix = {
  /** Linear gain ↔ dB for faders (0 gain ↔ the bottom of the fader). */
  FADER_MIN_DB: -60,
  toDb(g) { return g > 0 ? Math.max(this.FADER_MIN_DB, 20 * Math.log10(g)) : this.FADER_MIN_DB; },
  toGain(db) { return db <= this.FADER_MIN_DB + 0.05 ? 0 : Math.pow(10, db / 20); },

  /**
   * A synthetic room: stereo noise with an exponential decay (−60 dB at
   * `seconds`) that gets darker as it fades, plus a short pre-delay.
   */
  makeImpulse(ctx, seconds) {
    const sr = ctx.sampleRate;
    const pre = Math.round(sr * 0.012);
    const len = pre + Math.round(sr * seconds);
    const buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = pre; i < len; i++) {
        const x = (i - pre) / (len - pre);                  // 0 → 1 over the tail
        const env = Math.pow(0.001, x);                     // −60 dB at the end
        const a = 0.75 - 0.65 * x;                          // high end dies first
        lp += a * ((Math.random() * 2 - 1) - lp);
        d[i] = lp * env;
      }
    }
    return buf;
  },
};

/* ------------------------------------------------------------------ */

SoundPad.Channel = class Channel {
  /** @param track the project track (read live: volume, pan, fx) — or omit for a plain unity channel */
  constructor(engine, track) {
    this.engine = engine;
    this.track = track || { volume: 1, pan: 0, fx: {} };
    this.n = null;
  }

  /** The node instruments connect their voices to. */
  get input() {
    if (!this.n) this._build();
    return this.n.input;
  }

  get fx() {
    return { ...SoundPad.Project.TRACK_FX_DEFAULTS, ...(this.track.fx || {}) };
  }

  _build() {
    const ctx = this.engine.ctx, n = { lfos: [] };
    const bq = (type, freq, q = 0.707) => {
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      return f;
    };
    n.input = ctx.createGain();
    n.lowCut = bq("highpass", 20);
    n.eqLow = bq("lowshelf", 120);
    n.eqMid = bq("peaking", 1000, 0.9);
    n.eqHigh = bq("highshelf", 6000);
    n.comp = ctx.createDynamicsCompressor();
    n.comp.knee.value = 6;
    n.comp.attack.value = 0.005;
    n.comp.release.value = 0.2;
    n.makeup = ctx.createGain();
    n.input.connect(n.lowCut).connect(n.eqLow).connect(n.eqMid).connect(n.eqHigh).connect(n.comp).connect(n.makeup);

    // Chorus: the dry signal + two slowly wobbling short delays panned apart (width).
    n.dry = ctx.createGain();
    n.wet = ctx.createGain();
    n.duck = ctx.createGain();
    n.makeup.connect(n.dry).connect(n.duck);
    [[0.011, 0.53, -0.75], [0.017, 0.71, 0.75]].forEach(([base, rate, pan]) => {
      const d = ctx.createDelay(0.05);
      d.delayTime.value = base;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rate;
      const depth = ctx.createGain();
      depth.gain.value = 0.0025;
      lfo.connect(depth).connect(d.delayTime);
      lfo.start();
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      n.makeup.connect(d).connect(p).connect(n.wet);
      n.lfos.push(lfo);
    });
    n.wet.connect(n.duck);

    n.fader = ctx.createGain();
    n.pan = ctx.createStereoPanner();
    n.duck.connect(n.fader).connect(n.pan).connect(this.engine.master);

    // Post-fader sends to the shared buses.
    n.sendRev = ctx.createGain();
    n.sendDly = ctx.createGain();
    n.fader.connect(n.sendRev).connect(this.engine.buses.reverbIn);
    n.fader.connect(n.sendDly).connect(this.engine.buses.delayIn);

    if (!this.engine.offline) {            // level meter for the mixer
      n.meter = ctx.createAnalyser();
      n.meter.fftSize = 1024;
      n.pan.connect(n.meter);
      this._mbuf = new Float32Array(n.meter.fftSize);
    }
    this.n = n;
    this.update(true);
  }

  /** Apply the track's current volume / pan / effects (smoothly unless `immediate`). */
  update(immediate = false) {
    const n = this.n;
    if (!n) return;
    const f = this.fx, tr = this.track, t = this.engine.ctx.currentTime;
    const set = (param, v) => (immediate ? (param.value = v) : param.setTargetAtTime(v, t, 0.015));
    set(n.lowCut.frequency, f.lowCut);
    set(n.eqLow.gain, f.eqLow);
    set(n.eqMid.gain, f.eqMid);
    set(n.eqMid.frequency, f.eqMidFreq);
    set(n.eqHigh.gain, f.eqHigh);
    // Compressor: 0 = transparent (0 dB threshold, 1:1) … 1 = −30 dB, 8:1, +6 dB make-up.
    set(n.comp.threshold, -30 * f.comp);
    set(n.comp.ratio, 1 + 7 * f.comp);
    set(n.makeup.gain, Math.pow(10, (6 * f.comp) / 20));
    set(n.dry.gain, 1 - 0.35 * f.chorus);
    set(n.wet.gain, 0.6 * f.chorus);
    set(n.fader.gain, tr.volume ?? 1);
    set(n.pan.pan, tr.pan ?? 0);
    set(n.sendRev.gain, f.reverb);
    set(n.sendDly.gain, f.delay);
  }

  /** Sidechain: dip to (1 − amount) at `time`, then recover over `releaseSec`. */
  duck(time, amount, releaseSec) {
    if (!this.n) this._build();
    const g = this.n.duck.gain;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(time);
    else g.cancelScheduledValues(time);
    g.setTargetAtTime(1 - amount, time, 0.003);
    g.setTargetAtTime(1, time + 0.02, Math.max(0.01, releaseSec / 4));
  }

  /** Peak level (linear) right now, for the meter. 0 if nothing has played yet. */
  peak() {
    if (!this.n || !this.n.meter) return 0;
    this.n.meter.getFloatTimeDomainData(this._mbuf);
    let pk = 0;
    for (let i = 0; i < this._mbuf.length; i++) pk = Math.max(pk, Math.abs(this._mbuf[i]));
    return pk;
  }

  dispose() {
    const n = this.n;
    if (!n) return;
    n.lfos.forEach((l) => { try { l.stop(); } catch { /* already stopped */ } });
    [n.pan, n.sendRev, n.sendDly].forEach((x) => x.disconnect());
    this.n = null;
  }
};

/* ------------------------------------------------------------------
 * The shared effect buses: Reverb and (tempo-synced) Delay. Tracks feed
 * them through their send knobs; their returns go into the master.
 * ------------------------------------------------------------------ */
SoundPad.FxBuses = class FxBuses {
  constructor(engine) {
    const ctx = engine.ctx;
    this.engine = engine;
    this.ctx = ctx;

    this.reverbIn = ctx.createGain();
    this.reverb = ctx.createConvolver();
    this.reverbReturn = ctx.createGain();
    this.reverbIn.connect(this.reverb).connect(this.reverbReturn).connect(engine.master);

    // Delay with a darkening feedback loop (each repeat a little duller).
    this.delayIn = ctx.createGain();
    this.delay = ctx.createDelay(4);
    this.delayTone = ctx.createBiquadFilter();
    this.delayTone.type = "lowpass";
    this.delayTone.frequency.value = 3500;
    this.delayFb = ctx.createGain();
    this.delayReturn = ctx.createGain();
    this.delayIn.connect(this.delay).connect(this.delayTone);
    this.delayTone.connect(this.delayFb).connect(this.delay);
    this.delayTone.connect(this.delayReturn).connect(engine.master);

    if (!engine.offline) {
      this.reverbMeter = ctx.createAnalyser();
      this.delayMeter = ctx.createAnalyser();
      this.reverbReturn.connect(this.reverbMeter);
      this.delayReturn.connect(this.delayMeter);
    }
    this.irSeconds = null;
  }

  /** Apply the project's mix settings (`immediate` for a fresh graph / offline render). */
  apply(mix, bpm, immediate = false) {
    const t = this.ctx.currentTime;
    const set = (param, v) => (immediate ? (param.value = v) : param.setTargetAtTime(v, t, 0.02));
    set(this.reverbReturn.gain, mix.reverbReturn);
    set(this.delayReturn.gain, mix.delayReturn);
    set(this.delayFb.gain, Math.min(0.9, mix.delayFeedback));
    set(this.delay.delayTime, Math.min(4, (SoundPad.Project.delayBeats(mix.delayTime) * 60) / bpm));

    // A new room only when the size really changed (debounced while a slider drags).
    if (mix.reverbSize !== this.irSeconds) {
      clearTimeout(this._irTimer);
      const build = () => {
        this.irSeconds = mix.reverbSize;
        this.reverb.buffer = SoundPad.Mix.makeImpulse(this.ctx, mix.reverbSize);
      };
      if (immediate || this.irSeconds === null) build();
      else this._irTimer = setTimeout(build, 150);
    }
  }
};
