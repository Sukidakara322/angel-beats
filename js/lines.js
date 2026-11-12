/* ------------------------------------------------------------------
 * Sound Pad — Lines project model
 * The other kind of project (next to the Patterns/Song one): no parts and
 * no timeline. Every instrument you pick is ONE line of notes that runs
 * from bar 1 for as long as its notes go, and all lines play together.
 * You write each instrument's melody straight on the shared timeline.
 *
 * In memory (what the views, Player, Mixer and WAV export use):
 *   { kind: "lines", version, name, bpm, mix, loop: { start, end, on } | null,
 *     (loop = the region to repeat; `on` false keeps it but plays the whole song)
 *     tracks: [{ id, name, type, preset, params, volume, pan, mute, solo, fx,
 *                size, notes: [{ step, len, key, vel }] }] }
 * A line has the same sound / mixer fields as a Patterns track, so Channels,
 * the Mixer and Project's track helpers (rename, preset, fx…) work on it.
 * `size` = how tall the line is drawn ("min" | "s" | "m" | "l").
 *
 * Saved (toRecord / fromRecord) — one entry per line:
 *   { kind: "lines", version, name, bpm, mix, loop, lines: [ …the lines… ] }
 *
 * Everything is in 16th-note steps (BAR = 16 steps, 4/4), like Project.
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.Lines = {
  KIND: "lines",
  VERSION: 1,
  BAR: 16,
  MAX_STEPS: 999 * 16,
  MAX_LINES: 32,
  SIZES: ["min", "s", "m", "l"],
  DEFAULT_SIZE: "m",

  get P() { return SoundPad.Project; },

  isLines(p) {
    return !!p && p.kind === this.KIND;
  },

  /** A fresh lines project: Drums, Bass guitar, Electric guitar. */
  create(name = "") {
    const p = {
      kind: this.KIND,
      version: this.VERSION,
      name,
      bpm: 120,
      mix: { ...this.P.MIX_DEFAULTS },
      loop: null,
      tracks: [],
    };
    this.addLine(p, "drums", "Drums", "hard");
    this.addLine(p, "bass-guitar", "Bass", this.P.DEFAULT_PRESETS["bass-guitar"]);
    this.addLine(p, "guitar", "Guitar", this.P.DEFAULT_PRESETS.guitar);
    return p;
  },

  // --- Lines ---------------------------------------------------------

  /** Add a line (an instrument with an empty melody) and return it. Names are made unique. */
  addLine(p, type, name, preset) {
    const P = this.P;
    const line = {
      id: P.uid("ln"),
      name: P._uniqueTrackName(p, name),
      type,
      preset: preset || P.DEFAULT_PRESETS[type] || null,
      params: {},
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      fx: { ...P.TRACK_FX_DEFAULTS },
      size: this.DEFAULT_SIZE,
      notes: [],
    };
    p.tracks.push(line);
    return line;
  },

  line(p, id) {
    return p.tracks.find((t) => t.id === id) || null;
  },

  /** Delete a line with its notes. The last line can't be deleted (returns false). */
  deleteLine(p, id) {
    if (p.tracks.length <= 1 || !this.line(p, id)) return false;
    p.tracks = p.tracks.filter((t) => t.id !== id);
    p.tracks.forEach((t) => { if (t.fx && t.fx.duckSource === id) t.fx = { ...t.fx, duckSource: "" }; });
    return true;
  },

  /** Move a line up (-1) or down (+1) in the list. */
  moveLine(p, id, dir) {
    const i = p.tracks.findIndex((t) => t.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= p.tracks.length) return false;
    [p.tracks[i], p.tracks[j]] = [p.tracks[j], p.tracks[i]];
    return true;
  },

  setSize(line, size) {
    if (this.SIZES.includes(size)) line.size = size;
  },

  // --- Length / playback range ----------------------------------------

  _ceilBar(steps) {
    return Math.ceil(steps / this.BAR) * this.BAR;
  },

  /** Step just past the last note of any line (0 = nothing written yet). */
  end(p) {
    let end = 0;
    for (const t of p.tracks) for (const n of t.notes) end = Math.max(end, n.step + n.len);
    return end;
  },

  /** How long the song is: the last note rounded up to a bar (min 1 bar). */
  length(p) {
    return Math.max(this.BAR, this._ceilBar(this.end(p)));
  },

  /** Is the loop region switched on (so playback repeats it)? */
  looping(p) {
    return !!(p.loop && p.loop.on);
  },

  /** Steps that play: the loop if it's on, else bar 1 → the end. */
  range(p) {
    if (this.looping(p)) return { start: p.loop.start, end: p.loop.end };
    return { start: 0, end: this.length(p) };
  },

  /** Set the loop region (either order); it keeps its on/off state, a new one starts on. */
  setLoop(p, start, end) {
    const s = Math.max(0, Math.round(Math.min(start, end)));
    const e = Math.min(this.MAX_STEPS, Math.round(Math.max(start, end)));
    if (e <= s) return;
    p.loop = { start: s, end: e, on: p.loop ? p.loop.on : true };
  },

  /** Slide the loop to a new start, same length. */
  moveLoop(p, start) {
    if (!p.loop) return;
    const len = p.loop.end - p.loop.start;
    const s = Math.max(0, Math.min(this.MAX_STEPS - len, Math.round(start)));
    p.loop = { ...p.loop, start: s, end: s + len };
  },

  /** Loop on / off. The region is kept while off; switching on without one loops bar 1 → the end. */
  setLoopOn(p, on) {
    if (on && !p.loop) p.loop = { start: 0, end: this.length(p), on: true };
    else if (p.loop) p.loop = { ...p.loop, on: !!on };
  },

  clearLoop(p) {
    p.loop = null;
  },

  /** Step → "3", "3.2" or "3.2.4" (bar.beat.step, all from 1). */
  fmtPos(step) {
    const bar = Math.floor(step / 16) + 1, beat = Math.floor((step % 16) / 4) + 1, st = step % 4;
    return st ? `${bar}.${beat}.${st + 1}` : beat > 1 ? `${bar}.${beat}` : `${bar}`;
  },

  /** "3", "3.2", "3.2.4" (also "3:2", "3 2") → step, or null if it isn't a position. */
  parsePos(text) {
    const parts = String(text || "").trim().split(/[.:,\s]+/).filter(Boolean).map(Number);
    if (!parts.length || parts.length > 3 || parts.some((n) => !Number.isInteger(n) || n < 1)) return null;
    const [bar, beat = 1, st = 1] = parts;
    if (beat > 4 || st > 4) return null;
    return Math.min(this.MAX_STEPS, (bar - 1) * 16 + (beat - 1) * 4 + (st - 1));
  },

  // --- Save / load -------------------------------------------------------

  /** What gets saved: every instrument as one line with its notes. */
  toRecord(p) {
    return {
      kind: this.KIND,
      version: this.VERSION,
      name: p.name,
      bpm: p.bpm,
      mix: { ...p.mix },
      loop: p.loop ? { ...p.loop } : null,
      lines: p.tracks.map((t) => ({
        id: t.id, name: t.name, type: t.type, preset: t.preset, params: { ...t.params },
        volume: t.volume, pan: t.pan, mute: t.mute, solo: t.solo, fx: { ...t.fx }, size: t.size,
        notes: t.notes.map((n) => ({ ...n })),
      })),
    };
  },

  /** A saved record → a valid lines project (fills anything missing). */
  fromRecord(rec) {
    const P = this.P, MAX = this.MAX_STEPS;
    const src = JSON.parse(JSON.stringify(rec || {}));
    const p = {
      kind: this.KIND,
      version: this.VERSION,
      name: src.name || "",
      bpm: src.bpm || 120,
      mix: { ...P.MIX_DEFAULTS, ...(src.mix && typeof src.mix === "object" ? src.mix : {}) },
      loop: null,
      tracks: [],
    };
    (Array.isArray(src.lines) ? src.lines : []).forEach((l) => {
      const type = P.DEFAULT_PRESETS[l.type] ? l.type : "synth";
      p.tracks.push({
        id: l.id || P.uid("ln"),
        name: P._uniqueTrackName(p, (l.name || "Line").slice(0, 30)),
        type,
        preset: l.preset || P.DEFAULT_PRESETS[type],
        params: l.params && typeof l.params === "object" && !Array.isArray(l.params) ? l.params : {},
        volume: l.volume ?? 1,
        pan: l.pan ?? 0,
        mute: !!l.mute,
        solo: !!l.solo,
        fx: { ...P.TRACK_FX_DEFAULTS, ...(l.fx && typeof l.fx === "object" ? l.fx : {}) },
        size: this.SIZES.includes(l.size) ? l.size : this.DEFAULT_SIZE,
        notes: (Array.isArray(l.notes) ? l.notes : [])
          .filter((n) => n && n.step >= 0 && n.step < MAX && n.key !== undefined)
          .map((n) => ({
            step: Math.round(n.step),
            len: Math.max(1, Math.min(Math.round(n.len || 1), MAX - n.step)),
            key: n.key,
            vel: n.vel ?? SoundPad.DEFAULT_VEL,
          })),
      });
    });
    // A sidechain source must be another line that exists.
    p.tracks.forEach((t) => {
      if (t.fx.duckSource && (t.fx.duckSource === t.id || !this.line(p, t.fx.duckSource))) t.fx.duckSource = "";
    });
    const loop = src.loop;
    p.loop = loop && loop.start >= 0 && loop.end > loop.start
      ? { start: loop.start, end: Math.min(MAX, loop.end), on: loop.on !== false } : null;
    if (!p.tracks.length) this.addLine(p, "drums", "Drums", "hard");
    return p;
  },
};
