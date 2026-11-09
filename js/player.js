/* ------------------------------------------------------------------
 * Sound Pad — Player
 * Turns transport steps into notes. The engine only counts steps; the
 * player decides which part each track plays at that moment.
 *
 * Modes:
 *   "pattern" — every track loops its current (open-in-editor) part.
 *   "song"    — tracks play the part in the timeline slot under the
 *               playhead: slot = floor(songStep / partSteps). The song
 *               loops over the loop range, or over slots up to the last
 *               one that holds any part.
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
    if (!p) return 32;
    if (this.mode === "song") {
      const r = SoundPad.Project.songRange(p);
      return (r.end - r.start) * p.partSteps;
    }
    return p.partSteps;
  }

  /** Keep the engine's loop length in step with the mode / timeline. */
  sync() {
    const len = this.loopLength();
    if (this.engine.loopSteps !== len) this.engine.setLoopSteps(len);
  }

  /**
   * Called by the engine for every 16th-note step.
   * Returns { slot, local } for the playhead (slot is -1 in pattern mode).
   */
  onStep(step, time) {
    const p = this.project;
    if (!p) return null;
    const P = SoundPad.Project;

    // Timeline edits while playing can change the loop length: self-correct.
    const len = this.loopLength();
    if (this.engine.loopSteps !== len) {
      this.engine.setLoopSteps(len);
      step %= len;
    }

    let slot = -1;
    let local = step % p.partSteps;
    if (this.mode === "song") {
      const songStep = P.songRange(p).start * p.partSteps + step;
      slot = Math.floor(songStep / p.partSteps);
      local = songStep % p.partSteps;
    }

    const sps = this.engine.secondsPerStep();
    const anySolo = p.tracks.some((t) => t.solo);

    for (const { track, instrument } of this.tracks) {
      if (track.mute || (anySolo && !track.solo)) continue;
      const part = slot >= 0
        ? P.part(p, p.timeline.cells[track.id][slot])
        : P.currentPart(p, track);
      if (!part) continue;
      for (const n of part.notes) {
        if (n.step !== local) continue;
        // Gate slightly short of the full length so repeated notes re-articulate.
        const dur = n.len * sps - sps * 0.05;
        instrument.trigger(n.key, time, dur, n.vel);
      }
    }
    return { slot, local };
  }
};
