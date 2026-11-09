/* ------------------------------------------------------------------
 * Sound Pad — Bass synth + note helpers
 * A hard, real-world-ish bass voice: saw + square + sub-sine through a
 * plucky low-pass filter and saturation. Monophonic in feel but each
 * note() call is self-contained, so overlaps are fine.
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

// Musical helpers ----------------------------------------------------
SoundPad.NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

SoundPad.midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
SoundPad.midiName = (m) => SoundPad.NAMES[m % 12] + (Math.floor(m / 12) - 1);
SoundPad.isNatural = (m) => !SoundPad.NAMES[m % 12].includes("#");

/** Build an inclusive list of note descriptors from high MIDI down to low. */
SoundPad.noteRange = (lowMidi, highMidi) => {
  const notes = [];
  for (let m = highMidi; m >= lowMidi; m--) {
    notes.push({
      midi: m,
      name: SoundPad.midiName(m),
      freq: SoundPad.midiToFreq(m),
      natural: SoundPad.isNatural(m),
    });
  }
  return notes;
};

SoundPad.BassSynth = class BassSynth {
  constructor(engine, channel) {
    this.engine = engine;
    this.channel = channel || null;
    this.driveCurve = this._shaperCurve(6);
  }

  get ctx() { return this.engine.ctx; }
  get out() { return this.channel ? this.channel.input : this.engine.master; }

  /** Instrument contract: key is a MIDI note number. */
  trigger(midi, time, durSec, vel = SoundPad.DEFAULT_VEL) {
    this.note(SoundPad.midiToFreq(midi), time, Math.max(0.12, durSec), vel);
  }

  _shaperCurve(k) {
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }

  /**
   * Play a bass note.
   * @param {number} freq  fundamental in Hz
   * @param {number} time  audio-clock start time
   * @param {number} dur   note length in seconds
   * @param {number} vel   velocity 0..1 (scales the amp envelope)
   */
  note(freq, time, dur = 0.22, vel = SoundPad.DEFAULT_VEL) {
    const ctx = this.ctx;
    const end = time + dur;
    const v = Math.max(0.01, SoundPad.velToGain(vel));

    // Plucky low-pass: opens bright on attack, closes toward the fundamental.
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 6;
    filter.frequency.setValueAtTime(Math.min(freq * 9, 4500), time);
    filter.frequency.exponentialRampToValueAtTime(Math.max(freq * 2.2, 180), time + 0.14);

    const shaper = ctx.createWaveShaper();
    shaper.curve = this.driveCurve;

    const amp = ctx.createGain();
    shaper.connect(filter).connect(amp).connect(this.out);

    // Growl: sawtooth + slightly detuned square.
    const saw = ctx.createOscillator();
    saw.type = "sawtooth";
    saw.frequency.value = freq;
    const sq = ctx.createOscillator();
    sq.type = "square";
    sq.frequency.value = freq;
    sq.detune.value = -8;
    const sawG = ctx.createGain(); sawG.gain.value = 0.55;
    const sqG = ctx.createGain(); sqG.gain.value = 0.25;
    saw.connect(sawG).connect(shaper);
    sq.connect(sqG).connect(shaper);

    // Clean sub-sine one octave down for weight (bypasses drive/filter).
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = freq / 2;
    const subG = ctx.createGain(); subG.gain.value = 0.7;
    sub.connect(subG).connect(amp);

    // Amp envelope: fast pluck attack, short decay to sustain, quick release.
    amp.gain.setValueAtTime(0.0001, time);
    amp.gain.exponentialRampToValueAtTime(0.95 * v, time + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.55 * v, time + 0.12);
    amp.gain.setValueAtTime(0.55 * v, Math.max(time + 0.12, end - 0.05));
    amp.gain.exponentialRampToValueAtTime(0.0001, end);

    [saw, sq, sub].forEach((o) => { o.start(time); o.stop(end + 0.03); });
  }
};

SoundPad.Instruments.register("bass", {
  label: "Bass",
  editor: "PianoRollView",
  options: { low: 24, high: 60, base: 28 },   // C1–C4 roll, keyboard starts at E1
  create: (engine, channel) => new SoundPad.BassSynth(engine, channel),
});
