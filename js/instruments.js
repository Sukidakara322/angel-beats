/* ------------------------------------------------------------------
 * Sound Pad — Instrument registry
 * Every sound engine registers itself here under a type name. A track
 * only stores that type name; the app asks the registry to build the
 * instrument and to tell it which editor view to use.
 *
 * Instrument contract (all instruments implement it):
 *   new Instrument(engine, channel, presetId)
 *   trigger(key, time, durSec, vel)  — key is a drum id or a MIDI number
 *   setPreset(presetId)              — switch sound, same instrument
 *
 * Registry entry:
 *   { label, editor: "<SoundPad view class name>",
 *     presets: [{ id, name, category, … }], defaultPreset,
 *     create(engine, channel, presetId, paramOverrides),
 *     editorOptions?(track) → options passed to the editor (e.g. piano-roll range),
 *     params?: [schema]           → the track gets a "Sound controls" panel,
 *     effectiveParams?(track)     → preset values + the track's tweaks }
 *
 * Optional instrument extras: setParams(overrides), triggerChord(notes, time),
 * liveDur (how long a note rings when played from the keyboard).
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

  /** A preset's entry ({ id, name, category, … }) for a track. */
  presetOf(track) {
    const def = this.get(track.type);
    return def.presets.find((x) => x.id === track.preset) || def.presets[0];
  },

  /**
   * Everything that can become a track, grouped for menus:
   *   [{ category, items: [{ type, preset, name }] }]
   */
  catalog() {
    const groups = new Map();
    Object.entries(this.types).forEach(([type, def]) => {
      def.presets.forEach((pr) => {
        if (!groups.has(pr.category)) groups.set(pr.category, []);
        groups.get(pr.category).push({ type, preset: pr.id, name: pr.name, rank: def.menuRank || 0 });
      });
    });
    groups.forEach((items) => items.sort((a, b) => a.rank - b.rank));   // stable: keeps preset order
    const order = ["Drums", "Guitar", "Bass", "Lead", "Pad", "Keys", "FX"];
    return [...groups.entries()]
      .sort((a, b) => (order.indexOf(a[0]) + 99) % 99 - (order.indexOf(b[0]) + 99) % 99)
      .map(([category, items]) => ({ category, items }));
  },
};
