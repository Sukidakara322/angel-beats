/* ------------------------------------------------------------------
 * Sound Pad — Project model
 * Pure data + helpers (no audio, no DOM). A project is what gets saved.
 *
 *   Project {
 *     version: 3, name, bpm,
 *     tracks:   [{ id, name, type, preset, params, volume, pan, mute, solo, currentPartId }],
 *               type = instrument engine ("drums" | "synth" | "guitar" | "bass-guitar"),
 *               preset = its sound, params = this track's tweaks on top of the preset
 *     parts:    [{ id, trackId, name, minLength, notes: [{ step, len, key, vel }] }],
 *     timeline: { clips: [{ id, trackId, partId, start, length }],
 *                 loop: { start, end } | null }
 *   }
 *
 * Everything is measured in 16th-note steps (BAR = 16 steps, 4/4).
 *
 * Parts have no fixed length: a part is as long as its content, rounded
 * up to whole bars (min 1 bar). `minLength` (0 = auto) lets you keep it
 * longer, e.g. to leave an empty bar at the end.
 *
 * The timeline is free: a clip places a part on its track's lane at any
 * `start`. `length` null = the clip follows the part's length; a number
 * = the clip repeats the part (longer) or cuts it short (shorter).
 * If clips overlap in a lane, the one that starts later wins.
 *
 * Notes: `key` is a drum id ("kick") or a MIDI number (33), `len` is in
 * steps, `vel` is 0..1 (SoundPad.DEFAULT_VEL = normal).
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.Project = {
  VERSION: 3,
  BAR: 16,
  MAX_PART_STEPS: 32 * 16,        // 32 bars
  MAX_SONG_STEPS: 999 * 16,
  MAX_TRACKS: 32,
  DEFAULT_PRESETS: { drums: "hard", synth: "growl-bass", guitar: "clean", "bass-guitar": "metal-bass" },

  uid(prefix) {
    return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  },

  /** A fresh project with the default Drums + Bass tracks. */
  create(name = "") {
    const p = {
      version: this.VERSION,
      name,
      bpm: 120,
      tracks: [],
      parts: [],
      timeline: { clips: [], loop: null },
    };
    this.addTrack(p, "drums", "Drums", "hard");
    this.addTrack(p, "synth", "Bass", "growl-bass");
    return p;
  },

  // --- Tracks --------------------------------------------------------

  /** Add a track (with one empty part) and return it. Names are made unique ("Pad", "Pad 2"). */
  addTrack(p, type, name, preset) {
    const track = {
      id: this.uid("trk"),
      name: this._uniqueTrackName(p, name),
      type,
      preset: preset || this.DEFAULT_PRESETS[type] || null,
      params: {},
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      currentPartId: null,
    };
    p.tracks.push(track);
    this.addPart(p, track.id);
    return track;
  },

  track(p, id) {
    return p.tracks.find((t) => t.id === id) || null;
  },

  _uniqueTrackName(p, base, exceptId) {
    const names = new Set(p.tracks.filter((t) => t.id !== exceptId).map((t) => t.name));
    if (!names.has(base)) return base;
    for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
  },

  renameTrack(p, trackId, name) {
    const track = this.track(p, trackId);
    const clean = (name || "").trim().slice(0, 30);
    if (track && clean) track.name = this._uniqueTrackName(p, clean, trackId);
  },

  /** Change a track's sound (same engine type keeps all its parts playable). Tweaks reset. */
  setTrackPreset(p, trackId, preset) {
    const track = this.track(p, trackId);
    if (!track) return;
    track.preset = preset;
    track.params = {};
  },

  /** Tweak one sound control of a track (stored on top of its preset). */
  setTrackParam(p, trackId, id, value) {
    const track = this.track(p, trackId);
    if (track) track.params = { ...track.params, [id]: value };
  },

  resetTrackParams(p, trackId) {
    const track = this.track(p, trackId);
    if (track) track.params = {};
  },

  /**
   * Delete a track with all its parts and clips. The last track can't be
   * deleted (returns false).
   */
  deleteTrack(p, trackId) {
    if (p.tracks.length <= 1 || !this.track(p, trackId)) return false;
    p.tracks = p.tracks.filter((t) => t.id !== trackId);
    p.parts = p.parts.filter((x) => x.trackId !== trackId);
    p.timeline.clips = p.timeline.clips.filter((c) => c.trackId !== trackId);
    return true;
  },

  // --- Parts ---------------------------------------------------------

  part(p, id) {
    return p.parts.find((x) => x.id === id) || null;
  },

  partsOf(p, trackId) {
    return p.parts.filter((x) => x.trackId === trackId);
  },

  /** The part currently open in a track's editor (and looped in pattern mode). */
  currentPart(p, track) {
    return this.part(p, track.currentPartId);
  },

  setCurrentPart(p, trackId, partId) {
    const part = this.part(p, partId);
    if (part && part.trackId === trackId) this.track(p, trackId).currentPartId = partId;
  },

  /** "Drums 1", "Drums 2"… — first name not already used on this track. */
  _uniqueName(p, trackId, base, numbered) {
    const names = new Set(this.partsOf(p, trackId).map((x) => x.name));
    if (!numbered && !names.has(base)) return base;
    for (let n = numbered ? 1 : 2; ; n++) {
      const candidate = `${base} ${n}`;
      if (!names.has(candidate)) return candidate;
    }
  },

  /** Add an empty part to a track and make it the current part. */
  addPart(p, trackId, name) {
    const track = this.track(p, trackId);
    const part = {
      id: this.uid("prt"),
      trackId,
      name: name || this._uniqueName(p, trackId, track.name, true),
      minLength: 0,
      notes: [],
    };
    p.parts.push(part);
    track.currentPartId = part.id;
    return part;
  },

  /** Copy a part (notes included), place it right after the original, make it current. */
  duplicatePart(p, partId) {
    const src = this.part(p, partId);
    if (!src) return null;
    const copy = {
      id: this.uid("prt"),
      trackId: src.trackId,
      name: this._uniqueName(p, src.trackId, `${src.name} copy`, false),
      minLength: src.minLength || 0,
      notes: src.notes.map((n) => ({ ...n })),
    };
    p.parts.splice(p.parts.indexOf(src) + 1, 0, copy);
    this.track(p, src.trackId).currentPartId = copy.id;
    return copy;
  },

  renamePart(p, partId, name) {
    const part = this.part(p, partId);
    const clean = (name || "").trim().slice(0, 40);
    if (part && clean) part.name = clean;
  },

  /**
   * Delete a part and every clip that uses it. A track always keeps at
   * least one part, so deleting the last one is refused (returns false).
   */
  deletePart(p, partId) {
    const part = this.part(p, partId);
    if (!part) return false;
    const siblings = this.partsOf(p, part.trackId);
    if (siblings.length <= 1) return false;

    const idx = siblings.indexOf(part);
    p.parts.splice(p.parts.indexOf(part), 1);
    p.timeline.clips = p.timeline.clips.filter((c) => c.partId !== partId);

    const track = this.track(p, part.trackId);
    if (track.currentPartId === partId) {
      const next = siblings[idx + 1] || siblings[idx - 1];
      track.currentPartId = next.id;
    }
    return true;
  },

  // --- Part length ---------------------------------------------------

  _ceilBar(steps) {
    return Math.ceil(steps / this.BAR) * this.BAR;
  },

  /** Step just past the last note's end (0 for an empty part). */
  contentEnd(part) {
    let end = 0;
    for (const n of part.notes) end = Math.max(end, n.step + n.len);
    return end;
  },

  /** Shortest length the part can have: its content rounded up to a bar (min 1 bar). */
  autoLength(part) {
    return Math.min(this.MAX_PART_STEPS, Math.max(this.BAR, this._ceilBar(this.contentEnd(part))));
  },

  /** The part's length in steps: content (rounded to bars) or its fixed minimum, whichever is longer. */
  partLength(part) {
    return Math.min(this.MAX_PART_STEPS, Math.max(this.autoLength(part), part.minLength || 0));
  },

  /** Is the part longer than its content on purpose? */
  isFixedLength(part) {
    return (part.minLength || 0) > this.autoLength(part);
  },

  /**
   * Set the length (rounded to bars). It can't be shorter than the
   * content; setting it to the content length (or 0) means "auto".
   */
  setPartLength(part, steps) {
    const want = Math.min(this.MAX_PART_STEPS, this._ceilBar(Math.max(0, steps)));
    part.minLength = want > this.autoLength(part) ? want : 0;
  },

  // --- Timeline (song) ----------------------------------------------

  clipsOf(p, trackId) {
    return p.timeline.clips.filter((c) => c.trackId === trackId);
  },

  /** How long a clip is on the timeline (its own length, or its part's). */
  clipLength(p, clip) {
    if (clip.length) return clip.length;
    const part = this.part(p, clip.partId);
    return part ? this.partLength(part) : this.BAR;
  },

  /** Place a part on its track's lane. */
  addClip(p, partId, start, length = null) {
    const part = this.part(p, partId);
    if (!part) return null;
    const clip = {
      id: this.uid("clp"),
      trackId: part.trackId,
      partId,
      start: Math.max(0, Math.round(start)),
      length: length ? Math.max(1, Math.round(length)) : null,
    };
    p.timeline.clips.push(clip);
    return clip;
  },

  removeClip(p, clip) {
    const i = p.timeline.clips.indexOf(clip);
    if (i !== -1) p.timeline.clips.splice(i, 1);
  },

  /** Set a clip's length; matching its part's length switches back to "follow the part". */
  setClipLength(p, clip, steps) {
    const part = this.part(p, clip.partId);
    const len = Math.max(1, Math.round(steps));
    clip.length = part && len === this.partLength(part) ? null : len;
  },

  /** The clip sounding at `step` in a lane (later-starting clips win overlaps). */
  clipAt(p, trackId, step) {
    let hit = null;
    for (const c of p.timeline.clips) {
      if (c.trackId !== trackId || c.start > step) continue;
      if (step < c.start + this.clipLength(p, c) && (!hit || c.start >= hit.start)) hit = c;
    }
    return hit;
  },

  /**
   * Song step where `clip` stops sounding, seen from `step` (a step it is
   * playing): its own end, or where a later-starting clip on the same lane
   * takes over — whichever comes first. Notes are cut there.
   */
  clipStopAt(p, clip, step) {
    let stop = clip.start + this.clipLength(p, clip);
    for (const c of p.timeline.clips) {
      if (c !== clip && c.trackId === clip.trackId && c.start > step && c.start < stop) stop = c.start;
    }
    return stop;
  },

  /** Step just past the end of the last clip (0 for an empty song). */
  songEnd(p) {
    let end = 0;
    for (const c of p.timeline.clips) end = Math.max(end, c.start + this.clipLength(p, c));
    return end;
  },

  /** Step range the song plays: the loop if set, else 0 → song end rounded up to a bar (min 1 bar). */
  songRange(p) {
    const loop = p.timeline.loop;
    if (loop) return { start: loop.start, end: loop.end };
    return { start: 0, end: Math.max(this.BAR, this._ceilBar(this.songEnd(p))) };
  },

  setLoop(p, start, end) {
    const s = Math.max(0, Math.round(Math.min(start, end)));
    const e = Math.min(this.MAX_SONG_STEPS, Math.round(Math.max(start, end)));
    p.timeline.loop = e > s ? { start: s, end: e } : null;
  },

  clearLoop(p) {
    p.timeline.loop = null;
  },

  clearTimeline(p) {
    p.timeline.clips = [];
    p.timeline.loop = null;
  },

  // --- Notes ---------------------------------------------------------

  /** Note that starts exactly at (step, key). */
  findNote(part, step, key) {
    return part.notes.find((n) => n.step === step && n.key === key) || null;
  },

  /** Note of `key` that is sounding at `step` (covers it), latest start wins. */
  noteAt(part, step, key) {
    let hit = null;
    for (const n of part.notes) {
      if (n.key === key && n.step <= step && step < n.step + n.len && (!hit || n.step > hit.step)) hit = n;
    }
    return hit;
  },

  /** Add a note, replacing any note that starts at the same step & key. */
  addNote(part, { step, key, len = 1, vel = SoundPad.DEFAULT_VEL }) {
    part.notes = part.notes.filter((n) => !(n.step === step && n.key === key));
    const note = { step, len, key, vel };
    part.notes.push(note);
    return note;
  },

  removeNote(part, note) {
    const i = part.notes.indexOf(note);
    if (i !== -1) part.notes.splice(i, 1);
  },

  /** After a move/resize: drop other notes that now start at the same step & key. */
  dedupe(part, keep) {
    part.notes = part.notes.filter((n) => n === keep || !(n.step === keep.step && n.key === keep.key));
  },

  /** Turn the note at (step, key) on or off. Returns true if anything changed. */
  setNote(part, step, key, on, { len = 1, vel = SoundPad.DEFAULT_VEL } = {}) {
    const existing = this.findNote(part, step, key);
    if (on && !existing) {
      part.notes.push({ step, len, key, vel });
      return true;
    }
    if (!on && existing) {
      this.removeNote(part, existing);
      return true;
    }
    return false;
  },

  clearPart(part) {
    part.notes.length = 0;
  },

  // --- Loading -------------------------------------------------------

  /** Turn a saved record into a valid project (fills missing fields). */
  fromRecord(rec) {
    return this._normalize(JSON.parse(JSON.stringify(rec || {})));
  },

  _normalize(p) {
    const MAX = this.MAX_PART_STEPS;
    p.version = this.VERSION;
    p.name = p.name || "";
    p.bpm = p.bpm || 120;
    p.tracks = Array.isArray(p.tracks) ? p.tracks : [];
    p.parts = Array.isArray(p.parts) ? p.parts : [];

    p.parts.forEach((part) => {
      part.notes = (part.notes || [])
        .filter((n) => n.step >= 0 && n.step < MAX)
        .map((n) => ({
          step: n.step,
          len: Math.max(1, Math.min(n.len || 1, MAX - n.step)),
          key: n.key,
          vel: n.vel ?? SoundPad.DEFAULT_VEL,
        }));
      part.minLength = Math.min(MAX, this._ceilBar(Math.max(0, part.minLength || 0)));
    });

    p.tracks.forEach((t) => {
      if (t.type === "bass") { t.type = "synth"; t.preset = "growl-bass"; }   // pre-Phase-3 bass track
      if (!this.DEFAULT_PRESETS[t.type]) t.type = "synth";
      t.preset = t.preset || this.DEFAULT_PRESETS[t.type];
      t.params = t.params && typeof t.params === "object" && !Array.isArray(t.params) ? t.params : {};
      t.volume = t.volume ?? 1;
      t.pan = t.pan ?? 0;
      t.mute = !!t.mute;
      t.solo = !!t.solo;
    });

    // Timeline: keep only clips whose part exists on the same track.
    const tl = p.timeline && Array.isArray(p.timeline.clips) ? p.timeline : { clips: [], loop: p.timeline?.loop };
    p.timeline = tl;
    tl.clips = tl.clips
      .filter((c) => {
        const part = this.part(p, c.partId);
        return part && part.trackId === c.trackId && this.track(p, c.trackId) && c.start >= 0;
      })
      .map((c) => ({
        id: c.id || this.uid("clp"),
        trackId: c.trackId,
        partId: c.partId,
        start: Math.round(c.start),
        length: c.length ? Math.max(1, Math.round(c.length)) : null,
      }));
    const loop = tl.loop;
    tl.loop = loop && loop.start >= 0 && loop.end > loop.start ? { start: loop.start, end: loop.end } : null;
    delete tl.slots;
    delete tl.cells;
    delete p.partSteps;

    if (!p.tracks.length) {
      this.addTrack(p, "drums", "Drums", "hard");
      this.addTrack(p, "synth", "Bass", "growl-bass");
    }
    p.tracks.forEach((t) => {
      if (!this.part(p, t.currentPartId)) {
        const first = this.partsOf(p, t.id)[0];
        if (first) t.currentPartId = first.id;
        else this.addPart(p, t.id);
      }
    });
    return p;
  },
};
