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
 *   { label, editor: "<SoundPad view class name>", create(engine, channel) }
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

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
