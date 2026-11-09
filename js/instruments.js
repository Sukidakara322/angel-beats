/* ------------------------------------------------------------------
 * Sound Pad — Instrument registry
 * Every sound engine registers itself here under a type name. A track
 * only stores that type name; the app asks the registry to build the
 * instrument and to tell it which editor view to use.
 *
 * Instrument contract (all instruments implement it):
 *   new Instrument(engine, channel)
 *   trigger(key, time, durSec, vel)  — key is a drum id or a MIDI number
 *
 * Registry entry:
 *   { label, editor: "<SoundPad view class name>", options?, create(engine, channel) }
 *   `options` is passed to the editor (e.g. the piano-roll note range).
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

/**
 * Velocity: 0..1 per note. DEFAULT_VEL is "normal" and plays at unity
 * gain, which leaves headroom above it for accents.
 */
SoundPad.DEFAULT_VEL = 0.8;
SoundPad.velToGain = (vel) => Math.max(0, vel) / SoundPad.DEFAULT_VEL;

SoundPad.Instruments = {
  types: {},

  register(type, def) {
    this.types[type] = def;
  },

  get(type) {
    const def = this.types[type];
    if (!def) throw new Error(`Unknown instrument type "${type}"`);
    return def;
  },
};
