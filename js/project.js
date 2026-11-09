/* ------------------------------------------------------------------
 * Sound Pad — Project model
 * Pure data + helpers (no audio, no DOM). A project is what gets saved.
 *
 *   Project {
 *     version: 2, name, bpm,
 *     partSteps,                 // every part in the project has this length
 *     tracks:   [{ id, name, type, volume, pan, mute, solo, currentPartId }],
 *     parts:    [{ id, trackId, name, notes: [{ step, len, key, vel }] }],
 *     timeline: { slots, cells: { [trackId]: [partId | null, ...] } }
 *   }
 *
 * Notes are sparse: only notes that exist are stored. `key` is a drum id
 * ("kick") for drum tracks or a MIDI number (33) for pitched tracks.
 * `len` is in steps, `vel` is 0..1.
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.Project = {
  VERSION: 2,
  DEFAULT_PART_STEPS: 32,   // 2 bars of 16th notes
  DEFAULT_SLOTS: 8,

  uid(prefix) {
    return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  },

  /** A fresh project with the default Drums + Bass tracks. */
  create(name = "") {
    const p = {
      version: this.VERSION,
      name,
      bpm: 120,
      partSteps: this.DEFAULT_PART_STEPS,
      tracks: [],
      parts: [],
      timeline: { slots: this.DEFAULT_SLOTS, cells: {} },
    };
    this.addTrack(p, "drums", "Drums");
    this.addTrack(p, "bass", "Bass");
    return p;
  },

  // --- Tracks & parts ------------------------------------------------

  /** Add a track (with one empty part) and return it. */
  addTrack(p, type, name) {
    const track = {
      id: this.uid("trk"),
      name,
      type,
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      currentPartId: null,
    };
    p.tracks.push(track);
    p.timeline.cells[track.id] = new Array(p.timeline.slots).fill(null);
    this.addPart(p, track.id);
    return track;
  },

  /** Add an empty part to a track, make it the track's current part. */
  addPart(p, trackId, name) {
    const track = this.track(p, trackId);
    const count = p.parts.filter((x) => x.trackId === trackId).length;
    const part = {
      id: this.uid("prt"),
      trackId,
      name: name || `${track.name} ${count + 1}`,
      notes: [],
    };
    p.parts.push(part);
    track.currentPartId = part.id;
    return part;
  },

  track(p, id) {
    return p.tracks.find((t) => t.id === id) || null;
  },

  part(p, id) {
    return p.parts.find((x) => x.id === id) || null;
  },

  /** The part currently open in a track's editor. */
  currentPart(p, track) {
    return this.part(p, track.currentPartId);
  },

  // --- Notes ---------------------------------------------------------

  findNote(part, step, key) {
    return part.notes.find((n) => n.step === step && n.key === key) || null;
  },

  /** Turn the note at (step, key) on or off. Returns true if anything changed. */
  setNote(part, step, key, on, { len = 1, vel = 1 } = {}) {
    const existing = this.findNote(part, step, key);
    if (on && !existing) {
      part.notes.push({ step, len, key, vel });
      return true;
    }
    if (!on && existing) {
      part.notes.splice(part.notes.indexOf(existing), 1);
      return true;
    }
    return false;
  },

  clearPart(part) {
    part.notes.length = 0;
  },

  // --- Loading / migration -------------------------------------------

  /** Turn any saved record (old or new format) into a valid v2 project. */
  fromRecord(rec) {
    const copy = JSON.parse(JSON.stringify(rec || {}));
    const p = copy.version === this.VERSION ? copy : this._migrateV1(copy);
    return this._normalize(p);
  },

  /**
   * v1 saves stored one loop per instrument as dense booleans:
   *   { name, bpm, steps, instruments: { drums: {kick:[bool..]}, bass: {"33":[bool..]} } }
   * (even older: drums-only `pattern`). Each becomes a track with one part,
   * placed in the first timeline slot.
   */
  _migrateV1(rec) {
    const p = {
      version: this.VERSION,
      name: rec.name || "",
      bpm: rec.bpm || 120,
      partSteps: rec.steps || this.DEFAULT_PART_STEPS,
      tracks: [],
      parts: [],
      timeline: { slots: this.DEFAULT_SLOTS, cells: {} },
    };
    const inst = rec.instruments || { drums: rec.pattern || {}, bass: {} };

    const convert = (type, name, grid, keyOf) => {
      const track = this.addTrack(p, type, name);
      const part = this.currentPart(p, track);
      Object.entries(grid || {}).forEach(([rawKey, row]) => {
        (row || []).forEach((on, step) => {
          if (on && step < p.partSteps) part.notes.push({ step, len: 1, key: keyOf(rawKey), vel: 1 });
        });
      });
      p.timeline.cells[track.id][0] = part.id;
    };
    convert("drums", "Drums", inst.drums, (k) => k);
    convert("bass", "Bass", inst.bass, (k) => Number(k));
    return p;
  },

  /** Fill in missing fields so the rest of the app can trust the shape. */
  _normalize(p) {
    p.version = this.VERSION;
    p.name = p.name || "";
    p.bpm = p.bpm || 120;
    p.partSteps = p.partSteps || this.DEFAULT_PART_STEPS;
    p.tracks = p.tracks || [];
    p.parts = p.parts || [];
    p.timeline = p.timeline || { slots: this.DEFAULT_SLOTS, cells: {} };
    p.timeline.slots = p.timeline.slots || this.DEFAULT_SLOTS;
    p.timeline.cells = p.timeline.cells || {};

    p.parts.forEach((part) => {
      part.notes = (part.notes || [])
        .filter((n) => n.step >= 0 && n.step < p.partSteps)
        .map((n) => ({ step: n.step, len: n.len || 1, key: n.key, vel: n.vel ?? 1 }));
    });

    p.tracks.forEach((t) => {
      t.volume = t.volume ?? 1;
      t.pan = t.pan ?? 0;
      t.mute = !!t.mute;
      t.solo = !!t.solo;
      if (!this.part(p, t.currentPartId)) {
        const first = p.parts.find((x) => x.trackId === t.id);
        if (first) t.currentPartId = first.id;
        else this.addPart(p, t.id);
      }
      const row = p.timeline.cells[t.id] || [];
      p.timeline.cells[t.id] = Array.from({ length: p.timeline.slots }, (_, i) => row[i] ?? null);
    });

    if (!p.tracks.length) {
      this.addTrack(p, "drums", "Drums");
      this.addTrack(p, "bass", "Bass");
    }
    return p;
  },
};
