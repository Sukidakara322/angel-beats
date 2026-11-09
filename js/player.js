/* ------------------------------------------------------------------
 * Sound Pad — Player
 * Turns transport steps into notes. The engine only counts steps; the
 * player decides which part each track plays at that moment.
 *
 * Modes:
 *   "pattern" — every track loops its current (open-in-editor) part.
 *   "song"    — (Phase 2) tracks play whatever part sits in the timeline
 *               slot under the playhead: slot = floor(step / partSteps).
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
    this.engine.setLoopSteps(this.loopLength());
  }

  /** How many steps the transport loops over in the current mode. */
  loopLength() {
    return this.project ? this.project.partSteps : 32;
  }

  /** Called by the engine for every 16th-note step. */
  onStep(step, time) {
    const p = this.project;
    if (!p) return;
    const P = SoundPad.Project;
    const sps = this.engine.secondsPerStep();
    const local = step % p.partSteps;
    const anySolo = p.tracks.some((t) => t.solo);

    for (const { track, instrument } of this.tracks) {
      if (track.mute || (anySolo && !track.solo)) continue;
      const part = P.currentPart(p, track);
      if (!part) continue;
      for (const n of part.notes) {
        if (n.step !== local) continue;
        // Gate slightly short of the full length so repeated notes re-articulate.
        const dur = n.len * sps - sps * 0.05;
        instrument.trigger(n.key, time, dur, n.vel);
      }
    }
  }
};
