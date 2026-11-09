/* ------------------------------------------------------------------
 * Sound Pad — Player
 * Turns transport steps into notes. The engine only counts steps; the
 * player decides what each track plays at that moment.
 *
 * Modes:
 *   "pattern" — every track loops its current (open-in-editor) part at
 *               the part's own length; the transport loops over the
 *               longest of them.
 *   "song"    — each track plays the clip under the playhead on its lane
 *               (repeating the part if the clip is longer than it). The
 *               song loops over the loop region, or 0 → song end.
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.Player = class Player {
  constructor(engine) {
    this.engine = engine;
    this.project = null;
    this.tracks = [];   // [{ track, instrument }]
    this.mode = "pattern";
  }

  setProject(project, tracks) {
    this.project = project;
    this.tracks = tracks;
    this.sync();
  }

  setMode(mode) {
    this.mode = mode === "song" ? "song" : "pattern";
    this.sync();
  }

  /** How many steps the transport loops over in the current mode. */
  loopLength() {
    const p = this.project;
    const P = SoundPad.Project;
    if (!p) return P.BAR;
    if (this.mode === "song") {
      const r = P.songRange(p);
      return r.end - r.start;
    }
    let len = P.BAR;
    for (const t of p.tracks) {
      const part = P.currentPart(p, t);
      if (part) len = Math.max(len, P.partLength(part));
    }
    return len;
  }

  /** Keep the engine's loop length in step with the mode / content. */
  sync() {
    const len = this.loopLength();
    if (this.engine.loopSteps !== len) this.engine.setLoopSteps(len);
  }

  /**
   * Called by the engine for every 16th-note step. Returns, for the UI:
   *   { step, songStep, locals: { trackId: step inside its open part, or -1 } }
   * songStep is -1 in pattern mode.
   */
  onStep(step, time) {
    const p = this.project;
    if (!p) return null;
    const P = SoundPad.Project;

    // Edits while playing can change the loop length: self-correct.
    const len = this.loopLength();
    if (this.engine.loopSteps !== len) {
      this.engine.setLoopSteps(len);
      step %= len;
    }

    const song = this.mode === "song";
    const songStep = song ? P.songRange(p).start + step : -1;
    const sps = this.engine.secondsPerStep();
    const anySolo = p.tracks.some((t) => t.solo);
    const locals = {};

    for (const { track, instrument } of this.tracks) {
      let part = null, local = -1;
      if (song) {
        const clip = P.clipAt(p, track.id, songStep);
        if (clip) {
          part = P.part(p, clip.partId);
          local = (songStep - clip.start) % P.partLength(part);
        }
      } else {
        part = P.currentPart(p, track);
        if (part) local = step % P.partLength(part);
      }
      locals[track.id] = part && part.id === track.currentPartId ? local : -1;

      if (!part || track.mute || (anySolo && !track.solo)) continue;
      for (const n of part.notes) {
        if (n.step !== local) continue;
        // Gate slightly short of the full length so repeated notes re-articulate.
        instrument.trigger(n.key, time, n.len * sps - sps * 0.05, n.vel);
      }
    }
    return { step, songStep, locals };
  }
};
