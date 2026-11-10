/* ------------------------------------------------------------------
 * Sound Pad — Mixer view
 * One strip per track (+ the shared Reverb and Delay returns, + Master):
 * level meter, fader (dB), pan, mute / solo, and badges for the effects
 * in use. Click a strip to edit its effects below (EQ, compressor,
 * chorus, sends, sidechain — or the bus settings for Reverb / Delay).
 *
 *   double-click a fader → 0 dB · double-click a pan → centre
 *
 * Playback in the Mixer tab is the whole song (like the Song tab).
 * The view only edits the project; Channel.update() / engine.setMix()
 * push the change into the audio graph immediately.
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

/** The track-effects panel's controls (the sidechain list depends on the other tracks). */
SoundPad.trackFxSchema = (project, track) => [
  { group: "EQ", id: "lowCut", label: "Low cut", type: "range", min: 20, max: 500, step: 5, unit: "Hz" },
  { group: "EQ", id: "eqLow", label: "Low", type: "range", min: -12, max: 12, step: 0.5, unit: "dB" },
  { group: "EQ", id: "eqMid", label: "Mid", type: "range", min: -12, max: 12, step: 0.5, unit: "dB" },
  { group: "EQ", id: "eqMidFreq", label: "Mid freq", type: "range", min: 200, max: 5000, step: 50, unit: "Hz" },
  { group: "EQ", id: "eqHigh", label: "High", type: "range", min: -12, max: 12, step: 0.5, unit: "dB" },
  { group: "Dynamics & width", id: "comp", label: "Compressor", type: "range", min: 0, max: 1, step: 0.01, unit: "%" },
  { group: "Dynamics & width", id: "chorus", label: "Chorus", type: "range", min: 0, max: 1, step: 0.01, unit: "%" },
  { group: "Sends", id: "reverb", label: "Reverb", type: "range", min: 0, max: 1, step: 0.01, unit: "%" },
  { group: "Sends", id: "delay", label: "Delay", type: "range", min: 0, max: 1, step: 0.01, unit: "%" },
  { group: "Sidechain", id: "duckSource", label: "Duck by", type: "dropdown",
    options: [["", "Off"], ...project.tracks.filter((t) => t.id !== track.id)
      .map((t) => [t.id, t.type === "drums" ? `${t.name} (kick)` : t.name])] },
  { group: "Sidechain", id: "duck", label: "Amount", type: "range", min: 0, max: 1, step: 0.01, unit: "%" },
  { group: "Sidechain", id: "duckRelease", label: "Release", type: "range", min: 40, max: 600, step: 10, unit: "ms" },
];

SoundPad.MixerView = class MixerView {
  /**
   * @param {object} o
   * @param {HTMLElement} o.root
   * @param {object} o.project
   * @param {Array} o.tracks     [{ track, channel }] in order
   * @param {object} o.engine
   * @param {function} o.onChange  mute / solo changed (other views refresh)
   */
  constructor({ root, project, tracks, engine, onChange }) {
    this.root = root;
    this.project = project;
    this.tracks = tracks;
    this.engine = engine;
    this.onChange = onChange || (() => {});
    this.selected = tracks[0] ? tracks[0].track.id : "master";
    this.strips = [];      // { key, el, meter canvas, level fn, disp, hold, holdT, refresh() }
    this._raf = null;
  }

  get P() { return SoundPad.Project; }
  get M() { return SoundPad.Mix; }

  build() {
    this.root.innerHTML = `
      <section class="mixer">
        <div class="song-head">
          <h2>Mixer</h2>
          <span class="song-sel">plays the whole song</span>
        </div>
        <p class="song-hint">Click a strip to edit its effects below · double-click a fader to reset it to 0 dB, a pan to centre ·
          Reverb and Delay are shared: send any track to them with its Reverb / Delay knobs · Master = the level of the whole mix (and of the WAV export)</p>
        <div class="mx-strips" data-role="strips"></div>
        <section class="mx-detail" data-role="detail"></section>
      </section>`;
    this.stripsEl = this.root.querySelector('[data-role="strips"]');
    this.detailEl = this.root.querySelector('[data-role="detail"]');
  }

  // --- Strips --------------------------------------------------------

  /** Rebuild everything from the project (call when the tab is shown). */
  render() {
    if (!this.stripsEl) return;
    if (this.selected !== "reverb" && this.selected !== "delay" && this.selected !== "master" &&
        !this.P.track(this.project, this.selected)) {
      this.selected = this.tracks[0] ? this.tracks[0].track.id : "master";
    }
    this.stripsEl.innerHTML = "";
    this.strips = [];
    this.tracks.forEach((rt, i) => this._addTrackStrip(rt, SoundPad.PART_COLORS[i % SoundPad.PART_COLORS.length]));

    const gap = document.createElement("div");
    gap.className = "mx-gap";
    this.stripsEl.appendChild(gap);

    const mix = () => this.project.mix;
    const buses = () => this.engine.buses;
    this._addBusStrip("reverb", "Reverb", "shared · return", "#8fb3ff", () => mix().reverbReturn,
      (g) => this._setMix("reverbReturn", g), () => this._peakOf(buses() && buses().reverbMeter));
    this._addBusStrip("delay", "Delay", "shared · return", "#8fb3ff", () => mix().delayReturn,
      (g) => this._setMix("delayReturn", g), () => this._peakOf(buses() && buses().delayMeter));
    this._addBusStrip("master", "Master", "→ limiter → out", "#e6ebf2", () => mix().master,
      (g) => this._setMix("master", g), () => this.engine.masterPeak());

    this._renderStates();
    this._renderDetail();
    this._startMeters();
  }

  _setMix(id, value) {
    this.P.setMix(this.project, id, value);
    this.engine.setMix(this.project.mix);
  }

  _peakOf(an) {
    if (!an) return 0;
    if (!an._buf) an._buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(an._buf);
    let pk = 0;
    for (let i = 0; i < an._buf.length; i++) pk = Math.max(pk, Math.abs(an._buf[i]));
    return pk;
  }

  _stripShell(key, name, sub, color) {
    const el = document.createElement("div");
    el.className = "mx-strip";
    el.dataset.key = key;
    el.style.setProperty("--c", color);
    el.innerHTML = `
      <div class="mx-top"><div class="mx-name"></div><div class="mx-sub"></div></div>
      <div class="mx-badges"></div>
      <div class="mx-pan-row"></div>
      <div class="mx-fader-row">
        <canvas class="mx-meter"></canvas>
        <input type="range" class="mx-fader" min="${this.M.FADER_MIN_DB}" max="6" step="0.1" />
      </div>
      <div class="mx-db"></div>
      <div class="mx-ms"></div>`;
    el.querySelector(".mx-name").textContent = name;
    el.querySelector(".mx-name").title = name;
    el.querySelector(".mx-sub").textContent = sub;
    el.addEventListener("pointerdown", (e) => {
      if (e.target.closest("input, button, select")) return;
      this.select(key);
    });
    this.stripsEl.appendChild(el);
    return el;
  }

  /** Wire a fader (dB) to a linear gain getter/setter. */
  _wireFader(el, get, set) {
    const fader = el.querySelector(".mx-fader");
    const dbEl = el.querySelector(".mx-db");
    const show = () => {
      const g = get();
      dbEl.textContent = g > 0 ? `${this.M.toDb(g) > 0 ? "+" : ""}${this.M.toDb(g).toFixed(1)} dB` : "−∞ dB";
    };
    fader.value = this.M.toDb(get());
    show();
    fader.addEventListener("input", () => { set(this.M.toGain(parseFloat(fader.value))); show(); });
    fader.addEventListener("dblclick", () => { set(1); fader.value = 0; show(); });
    fader.title = "Level · double-click = 0 dB";
  }

  _addTrackStrip(rt, color) {
    const track = rt.track;
    const sound = SoundPad.Instruments.presetOf(track).name;
    const el = this._stripShell(track.id, track.name, sound !== track.name ? sound : "", color);

    // Pan.
    const panRow = el.querySelector(".mx-pan-row");
    const pan = document.createElement("input");
    pan.type = "range"; pan.className = "mx-pan"; pan.min = -1; pan.max = 1; pan.step = 0.01;
    pan.value = track.pan;
    pan.title = "Pan · double-click = centre";
    const panVal = document.createElement("span");
    panVal.className = "mx-pan-val";
    const showPan = () => {
      const v = Math.round(track.pan * 100);
      panVal.textContent = v === 0 ? "C" : v < 0 ? `L${-v}` : `R${v}`;
    };
    showPan();
    pan.addEventListener("input", () => { track.pan = parseFloat(pan.value); rt.channel.update(); showPan(); });
    pan.addEventListener("dblclick", () => { track.pan = 0; pan.value = 0; rt.channel.update(); showPan(); });
    panRow.append(pan, panVal);

    this._wireFader(el, () => track.volume, (g) => { track.volume = g; rt.channel.update(); });

    // Mute / solo (same switches as on the Song lanes).
    const ms = el.querySelector(".mx-ms");
    [["mute", "M", "Mute"], ["solo", "S", "Solo"]].forEach(([prop, text, title]) => {
      const b = document.createElement("button");
      b.className = `ms ${prop}`;
      b.textContent = text;
      b.title = title;
      b.addEventListener("click", () => { track[prop] = !track[prop]; this._renderStates(); this.onChange(); });
      ms.appendChild(b);
    });

    const strip = { key: track.id, el, track, level: () => rt.channel.peak(), disp: -90, hold: -90, holdT: 0 };
    strip.refreshBadges = () => this._renderBadges(el, track);
    strip.refreshBadges();
    this._addMeter(strip);
  }

  _addBusStrip(key, name, sub, color, get, set, level) {
    const el = this._stripShell(key, name, sub, color);
    el.classList.add("mx-bus");
    if (key === "master") el.classList.add("mx-master");
    this._wireFader(el, get, set);
    this._addMeter({ key, el, level, disp: -90, hold: -90, holdT: 0 });
  }

  _renderBadges(el, track) {
    const f = { ...this.P.TRACK_FX_DEFAULTS, ...track.fx };
    const sc = f.duckSource && this.P.track(this.project, f.duckSource);
    const badges = [
      ["EQ", f.lowCut > 20 || f.eqLow || f.eqMid || f.eqHigh, "EQ / low cut"],
      ["CMP", f.comp > 0, "Compressor"],
      ["CHO", f.chorus > 0, "Chorus"],
      ["REV", f.reverb > 0, `Reverb send ${Math.round(f.reverb * 100)}%`],
      ["DLY", f.delay > 0, `Delay send ${Math.round(f.delay * 100)}%`],
      ["SC", !!sc, sc ? `Ducked by ${sc.name}` : "Sidechain"],
    ];
    const box = el.querySelector(".mx-badges");
    box.innerHTML = "";
    badges.forEach(([text, on, title]) => {
      const b = document.createElement("span");
      b.textContent = text;
      b.title = title;
      b.classList.toggle("on", !!on);
      box.appendChild(b);
    });
  }

  _renderStates() {
    const anySolo = this.project.tracks.some((t) => t.solo);
    this.strips.forEach((s) => {
      s.el.classList.toggle("selected", s.key === this.selected);
      if (!s.track) return;
      s.el.querySelector(".ms.mute").classList.toggle("on", s.track.mute);
      s.el.querySelector(".ms.solo").classList.toggle("on", s.track.solo);
      s.el.classList.toggle("silent", s.track.mute || (anySolo && !s.track.solo));
    });
  }

  select(key) {
    if (this.selected === key) return;
    this.selected = key;
    this._renderStates();
    this._renderDetail();
  }

  // --- Detail: effects of the selected strip ----------------------------

  _renderDetail() {
    const P = this.P, key = this.selected;
    this.detailEl.innerHTML = "";
    const host = document.createElement("div");
    this.detailEl.appendChild(host);

    if (key === "master") {
      host.className = "param-panel mx-note";
      host.innerHTML = `<div class="pp-head"><h3>Master</h3></div>
        <p>Every track and both effect returns add up here, then go through a limiter that keeps the mix from clipping.
        The Master fader sets the level of the whole mix — including the WAV export. (The Volume slider in the transport
        only changes how loud you hear it.) If the master meter sits in the red a lot, pull some track faders down instead.</p>`;
      return;
    }

    if (key === "reverb" || key === "delay") {
      const schema = key === "reverb"
        ? [{ group: "Reverb", id: "reverbSize", label: "Room size", type: "range", min: 0.4, max: 6, step: 0.1, unit: "s" }]
        : [{ group: "Delay", id: "delayTime", label: "Time", type: "select", options: P.DELAY_TIMES.map(([k]) => [k, k]) },
           { group: "Delay", id: "delayFeedback", label: "Feedback", type: "range", min: 0, max: 0.9, step: 0.01, unit: "%" }];
      const ids = schema.map((s) => s.id);
      const panel = new SoundPad.ParamPanel(host, {
        title: key === "reverb" ? "Reverb (shared)" : "Delay (shared, synced to the tempo)",
        schema,
        values: () => this.project.mix,
        edited: () => ids.some((id) => this.project.mix[id] !== P.MIX_DEFAULTS[id]),
        texts: { edited: "edited — saved with the song", clean: "default", reset: "Reset" },
        onChange: (id, value, commit) => {
          this._setMix(id, value);
          if (commit) panel.render();
        },
        onReset: () => {
          ids.forEach((id) => P.setMix(this.project, id, P.MIX_DEFAULTS[id]));
          this.engine.setMix(this.project.mix);
          panel.render();
        },
      });
      panel.render();
      return;
    }

    const rt = this.tracks.find((r) => r.track.id === key);
    if (!rt) return;
    const strip = this.strips.find((s) => s.key === key);
    const panel = new SoundPad.ParamPanel(host, {
      title: `Effects — ${rt.track.name}`,
      schema: () => SoundPad.trackFxSchema(this.project, rt.track),
      values: () => rt.track.fx,
      edited: () => P.hasFx(rt.track),
      texts: { edited: "saved with this track", clean: "no effects", reset: "Reset effects" },
      onChange: (id, value, commit) => {
        P.setTrackFx(this.project, rt.track.id, id, value);
        rt.channel.update();
        if (commit) { panel.render(); strip.refreshBadges(); }
      },
      onReset: () => {
        P.resetTrackFx(this.project, rt.track.id);
        rt.channel.update();
        panel.render();
        strip.refreshBadges();
      },
    });
    panel.render();
  }

  // --- Meters ----------------------------------------------------------

  _addMeter(strip) {
    strip.canvas = strip.el.querySelector(".mx-meter");
    strip.g = strip.canvas.getContext("2d");
    this.strips.push(strip);
  }

  _startMeters() {
    if (this._raf) return;
    const tick = () => {
      // Stop when the tab is hidden; render() starts it again.
      if (!this.root.offsetParent) { this._raf = null; return; }
      this._raf = requestAnimationFrame(tick);
      this._drawMeters();
    };
    this._raf = requestAnimationFrame(tick);
  }

  _drawMeters() {
    const now = performance.now();
    const MIN = -60, MAX = 6;
    for (const s of this.strips) {
      const c = s.canvas;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth, h = c.clientHeight;
      if (!w || !h) continue;
      if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      const pk = this.engine.ctx ? s.level() : 0;
      const db = pk > 0 ? 20 * Math.log10(pk) : -90;
      s.disp = Math.max(db, s.disp - 0.9);                     // fast up, smooth fall
      if (db >= s.hold || now - s.holdT > 1200) { s.hold = db; s.holdT = now; }

      const y = (v) => h - (Math.min(MAX, Math.max(MIN, v)) - MIN) / (MAX - MIN) * h;
      const g = s.g;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = "#0b0e12";
      g.fillRect(0, 0, w, h);
      if (s.disp > MIN) {
        const top = y(s.disp);
        const grad = g.createLinearGradient(0, h, 0, 0);
        grad.addColorStop(0, "#4dd0a7");
        grad.addColorStop((-12 - MIN) / (MAX - MIN), "#4dd0a7");
        grad.addColorStop((-6 - MIN) / (MAX - MIN), "#e6d35a");
        grad.addColorStop((0 - MIN) / (MAX - MIN), "#ff5d5d");
        grad.addColorStop(1, "#ff5d5d");
        g.fillStyle = grad;
        g.fillRect(0, top, w, h - top);
      }
      // 0 dB mark + peak hold.
      g.fillStyle = "#39424f";
      g.fillRect(0, Math.round(y(0)), w, 1);
      if (s.hold > MIN) {
        g.fillStyle = s.hold > -0.5 ? "#ff5d5d" : "#e6ebf2";
        g.fillRect(0, Math.round(y(s.hold)), w, 2);
      }
    }
  }

  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.root.innerHTML = "";
  }
};
