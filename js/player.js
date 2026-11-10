/* ------------------------------------------------------------------
 * Sound Pad — Player
 * Turns transport steps into notes. The engine only counts steps; the
 * player decides what each track plays at that moment.
 *
 * What plays follows the open tab (there is no separate mode switch):
 *   "pattern" — a track tab: ONLY that track's open part loops, at the
 *               part's own length. Nothing else plays, so you hear just
 *               the part you are writing. (Mute / solo are song controls
 *               and don't apply here.)
 *   "song"    — the Song tab: every track plays the clip under the
 *               playhead on its lane (repeating the part if the clip is
 *               longer than it). The song loops over the loop region, or
 *               0 → song end.
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.Player = class Player {
  constructor(engine) {
    this.engine = engine;
    this.project = null;
    this.tracks = [];      // [{ track, instrument }]
    this.mode = "pattern";
    this.trackId = null;   // pattern mode: the track whose open part plays
  }

  setProject(project, tracks) {
    this.project = project;
    this.tracks = tracks;
    this.sync();
  }

  /**
   * Switch what plays: setMode("song") or setMode("pattern", trackId).
   * A real change while playing starts the new loop from its beginning.
   */
  setMode(mode, trackId = null) {
    const next = mode === "song" ? "song" : "pattern";
    const id = next === "pattern" ? trackId : null;
    const changed = next !== this.mode || id !== this.trackId;
    this.mode = next;
    this.trackId = id;
    this.sync();
    if (changed && this.engine.isPlaying) this.engine.currentStep = 0;
  }

  /** The open part that plays in pattern mode (null in song mode). */
  patternPart() {
    const p = this.project;
    if (!p || this.mode !== "pattern") return null;
    const track = SoundPad.Project.track(p, this.trackId);
    return track ? SoundPad.Project.currentPart(p, track) : null;
  }

  /** How many steps the transport loops over: the open part, or the song range. */
  loopLength() {
    const p = this.project;
    const P = SoundPad.Project;
    if (!p) return P.BAR;
    if (this.mode === "song") {
      const r = P.songRange(p);
      return r.end - r.start;
    }
    const part = this.patternPart();
    return part ? P.partLength(part) : P.BAR;
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
    const range = song ? P.songRange(p) : null;
    const songStep = song ? range.start + step : -1;
    const sps = this.engine.secondsPerStep();
    const anySolo = p.tracks.some((t) => t.solo);
    const locals = {};

    for (const { track, instrument } of this.tracks) {
      // room = steps until this part stops sounding here (notes are cut there,
      // so a long note can't ring over the next clip or past the loop's wrap).
      let part = null, local = -1, room = len - step;
      if (song) {
        const clip = P.clipAt(p, track.id, songStep);
        if (clip && !track.mute && !(anySolo && !track.solo)) {
          part = P.part(p, clip.partId);
          local = (songStep - clip.start) % P.partLength(part);
          room = Math.min(P.clipStopAt(p, clip, songStep), range.end) - songStep;
        }
      } else if (track.id === this.trackId) {
        part = P.currentPart(p, track);
        if (part) local = step;            // the loop IS the part
      }
      locals[track.id] = part && part.id === track.currentPartId ? local : -1;
      if (!part) continue;

      // Gate slightly short of the full length so repeated notes re-articulate.
      const gate = (n) => Math.min(n.len, room) * sps - sps * 0.05;
      const starts = part.notes.filter((n) => n.step === local);
      if (!starts.length) continue;
      try {
        if (starts.length > 1 && instrument.triggerChord) {
          // Instruments that care (guitar strums) get the whole chord at once.
          instrument.triggerChord(starts.map((n) => ({ key: n.key, dur: gate(n), vel: n.vel })), time);
        } else {
          for (const n of starts) instrument.trigger(n.key, time, gate(n), n.vel);
        }
      } catch (err) {
        // One track's bad note must not silence the others (or stop the clock).
        const n = starts[0];
        this.engine._report("error", `${track.name} › ${part.name}: ${err.message || err} (note ${n.key} at step ${n.step}, len ${n.len}, vel ${n.vel})`,
          `error:${track.id}:${err.message}`);
      }
    }
    return { step, songStep, locals };
  }

  /**
   * Where a note played live at transport `step` lands inside the track's
   * open part (for recording), or -1 if that part isn't the one looping.
   */
  localStep(track, step) {
    if (this.mode !== "pattern" || track.id !== this.trackId) return -1;
    const part = SoundPad.Project.currentPart(this.project, track);
    return part ? step % SoundPad.Project.partLength(part) : -1;
  }
};
