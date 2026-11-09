/* ------------------------------------------------------------------
 * Sound Pad — Audio Engine
 * The shared audio backbone: one AudioContext, a master bus, a shared
 * noise buffer, and a look-ahead step scheduler (the classic "two clocks"
 * pattern) that keeps timing tight regardless of UI jank.
 *
 * It is instrument-agnostic. It just calls `onStep(stepIndex, time)` for
 * every 16th-note, looping over `loopSteps`. The Player decides what that
 * step means (a step inside a part, or a position in the song).
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.Engine = class Engine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;

    // Transport
    this.bpm = 120;
    this.loopSteps = 32;           // 16th notes before the transport wraps
    this.isPlaying = false;
    this.currentStep = 0;          // next step to be scheduled
    this.nextNoteTime = 0;         // audio-clock time of that next step
    this.startTime = 0;            // audio-clock time of step 0 (for quantizing)

    // Scheduler tuning
    this.lookaheadMs = 25;         // how often the scheduler wakes up
    this.scheduleAheadSec = 0.1;   // how far ahead we schedule audio

    this._timer = null;
    this.onStep = null;            // (stepIndex, time) => info, set by app
    this.drawQueue = [];           // {step, time, info} pushed for UI playhead
  }

  /** Must be called from a user gesture (browsers block audio otherwise). */
  async init() {
    if (this.ctx) { await this.ctx.resume(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this._pendingVolume ?? 0.9;

    // Bus limiter: glues a fuller kit together and stops many simultaneous
    // hits from clipping harshly — part of what makes it sound "hard".
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;

    this.master.connect(this.limiter).connect(this.ctx.destination);
    this._buildNoiseBuffer();
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  setVolume(v) {
    this._pendingVolume = v;
    if (this.master) this.master.gain.value = v;
  }

  setBpm(bpm) {
    this.bpm = Math.min(240, Math.max(40, bpm | 0));
  }

  setLoopSteps(n) {
    this.loopSteps = Math.max(1, n | 0);
    this.currentStep %= this.loopSteps;
  }

  /** Seconds per 16th-note step at the current tempo. */
  secondsPerStep() {
    return (60 / this.bpm) / 4;
  }

  start() {
    if (this.isPlaying) return;
    this.currentStep = 0;
    this.nextNoteTime = this.ctx.currentTime + 0.06; // small lead-in
    this.startTime = this.nextNoteTime;
    this.isPlaying = true;
    this._timer = setInterval(() => this._scheduler(), this.lookaheadMs);
  }

  stop() {
    this.isPlaying = false;
    clearInterval(this._timer);
    this._timer = null;
    this.drawQueue.length = 0;
  }

  /** Look-ahead: schedule every step that falls inside the near future. */
  _scheduler() {
    while (this.nextNoteTime < this.ctx.currentTime + this.scheduleAheadSec) {
      // onStep may return position info for the UI (and may change loopSteps).
      const info = this.onStep ? this.onStep(this.currentStep, this.nextNoteTime) : null;
      this.drawQueue.push({ step: this.currentStep, time: this.nextNoteTime, info });
      this.nextNoteTime += this.secondsPerStep();
      this.currentStep = (this.currentStep + 1) % this.loopSteps;
    }
  }

  /**
   * Snap a real-time moment (e.g. a live pad hit) to the nearest step index
   * within the loop. Used so recorded hits land cleanly on the grid.
   * Tempo changes mid-play shift this slightly; fine for live recording.
   */
  quantizeToStep(atTime) {
    const pos = (atTime - this.startTime) / this.secondsPerStep();
    let step = Math.round(pos) % this.loopSteps;
    if (step < 0) step += this.loopSteps;
    return step;
  }

  /** One second of white noise, reused by snare / hats / clap. */
  _buildNoiseBuffer() {
    const len = this.ctx.sampleRate; // 1s
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;
  }

  /** Helper: a one-shot noise source node ready to connect/start. */
  noiseSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    return src;
  }
};

/* ------------------------------------------------------------------
 * Channel — one per track: input → volume → pan → master.
 * Nodes are created lazily on first use, because the AudioContext only
 * exists after the first user gesture.
 * ------------------------------------------------------------------ */
SoundPad.Channel = class Channel {
  constructor(engine) {
    this.engine = engine;
    this.volume = 1;
    this.pan = 0;
    this._gain = null;
    this._pan = null;
  }

  /** The node instruments connect their voices to. */
  get input() {
    if (!this._gain) this._build();
    return this._gain;
  }

  _build() {
    const ctx = this.engine.ctx;
    this._gain = ctx.createGain();
    this._gain.gain.value = this.volume;
    if (ctx.createStereoPanner) {
      this._pan = ctx.createStereoPanner();
      this._pan.pan.value = this.pan;
      this._gain.connect(this._pan).connect(this.engine.master);
    } else {
      this._gain.connect(this.engine.master);
    }
  }

  setVolume(v) {
    this.volume = v;
    if (this._gain) this._gain.gain.value = v;
  }

  setPan(p) {
    this.pan = p;
    if (this._pan) this._pan.pan.value = p;
  }

  dispose() {
    if (this._gain) this._gain.disconnect();
    if (this._pan) this._pan.disconnect();
    this._gain = this._pan = null;
  }
};
