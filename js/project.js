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
 * `len` is in steps, `vel` is 0..1 (SoundPad.DEFAULT_VEL = normal).
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.Project = {
  VERSION: 2,
  DEFAULT_PART_STEPS: 32,          // 2 bars of 16th notes
  PART_LENGTHS: [16, 32, 64],      // 1, 2, 4 bars
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

  // --- Tracks --------------------------------------------------------

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

  track(p, id) {
    return p.tracks.find((t) => t.id === id) || null;
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
   * Delete a part. A track always keeps at least one part, so deleting the
   * last one is refused (returns false). Timeline cells using it are emptied.
   */
  deletePart(p, partId) {
    const part = this.part(p, partId);
    if (!part) return false;
    const siblings = this.partsOf(p, part.trackId);
    if (siblings.length <= 1) return false;

    const idx = siblings.indexOf(part);
    p.parts.splice(p.parts.indexOf(part), 1);
    const row = p.timeline.cells[part.trackId] || [];
    row.forEach((id, i) => { if (id === partId) row[i] = null; });

    const track = this.track(p, part.trackId);
    if (track.currentPartId === partId) {
      const next = siblings[idx + 1] || siblings[idx - 1];
      track.currentPartId = next.id;
    }
    return true;
  },

  // --- Part length (project-wide) -------------------------------------

  /** How many notes would be lost if parts were shortened to `steps`. */
  notesBeyond(p, steps) {
    return p.parts.reduce((sum, part) => sum + part.notes.filter((n) => n.step >= steps).length, 0);
  },

  /**
   * Change the length of every part. Shortening drops notes past the end
   * and trims long notes; lengthening adds silence, or repeats the existing
   * content to fill (repeat: true).
   */
  setPartSteps(p, steps, { repeat = false } = {}) {
    const old = p.partSteps;
    if (steps === old) return;
    p.parts.forEach((part) => {
      if (steps < old) {
        part.notes = part.notes.filter((n) => n.step < steps);
      } else if (repeat) {
        const base = part.notes.map((n) => ({ ...n }));
        for (let off = old; off < steps; off += old) {
          base.forEach((n) => {
            if (n.step + off < steps) part.notes.push({ ...n, step: n.step + off });
          });
        }
      }
      part.notes.forEach((n) => (n.len = Math.min(n.len, steps - n.step)));
    });
    p.partSteps = steps;
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
    p.version = this.VERSION;
    p.name = p.name || "";
    p.bpm = p.bpm || 120;
    p.partSteps = this.PART_LENGTHS.includes(p.partSteps) ? p.partSteps : this.DEFAULT_PART_STEPS;
    p.tracks = Array.isArray(p.tracks) ? p.tracks : [];
    p.parts = Array.isArray(p.parts) ? p.parts : [];
    p.timeline = p.timeline || { slots: this.DEFAULT_SLOTS, cells: {} };
    p.timeline.slots = p.timeline.slots || this.DEFAULT_SLOTS;
    p.timeline.cells = p.timeline.cells || {};

    p.parts.forEach((part) => {
      part.notes = (part.notes || [])
        .filter((n) => n.step >= 0 && n.step < p.partSteps)
        .map((n) => ({
          step: n.step,
          len: Math.max(1, Math.min(n.len || 1, p.partSteps - n.step)),
          key: n.key,
          vel: n.vel ?? SoundPad.DEFAULT_VEL,
        }));
    });

    p.tracks.forEach((t) => {
      t.volume = t.volume ?? 1;
      t.pan = t.pan ?? 0;
      t.mute = !!t.mute;
      t.solo = !!t.solo;
      if (!this.part(p, t.currentPartId)) {
        const first = this.partsOf(p, t.id)[0];
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
