/* ------------------------------------------------------------------
 * Sound Pad — Audio Engine
 * The shared audio backbone: one AudioContext, a master bus, a shared
 * noise buffer, and a look-ahead step scheduler (the classic "two clocks"
 * pattern) that keeps timing tight regardless of UI jank.
 *
 * It is instrument-agnostic. It just calls `onStep(stepIndex, time)` for
 * every 16th-note; the app decides what to trigger.
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.Engine = class Engine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;

    // Transport
    this.bpm = 120;
    this.steps = 32;               // 16th notes in the loop (2 bars)
    this.isPlaying = false;
    this.currentStep = 0;          // next step to be scheduled
    this.nextNoteTime = 0;         // audio-clock time of that next step
    this.startTime = 0;            // audio-clock time of step 0 (for quantizing)

    // Scheduler tuning
    this.lookaheadMs = 25;         // how often the scheduler wakes up
    this.scheduleAheadSec = 0.1;   // how far ahead we schedule audio

    this._timer = null;
    this.onStep = null;            // (stepIndex, time) => void, set by app
    this.drawQueue = [];           // {step, time} pushed for UI playhead
  }

  /** Must be called from a user gesture (browsers block audio otherwise). */
  async init() {
    if (this.ctx) { await this.ctx.resume(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;

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
    if (this.master) this.master.gain.value = v;
  }

  setBpm(bpm) {
    this.bpm = Math.min(240, Math.max(40, bpm | 0));
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
      if (this.onStep) this.onStep(this.currentStep, this.nextNoteTime);
      this.drawQueue.push({ step: this.currentStep, time: this.nextNoteTime });
      this.nextNoteTime += this.secondsPerStep();
      this.currentStep = (this.currentStep + 1) % this.steps;
    }
  }

  /**
   * Snap a real-time moment (e.g. a live pad hit) to the nearest step index.
   * Used so recorded hits land cleanly on the grid.
   */
  quantizeToStep(atTime) {
    const pos = (atTime - this.startTime) / this.secondsPerStep();
    let step = Math.round(pos) % this.steps;
    if (step < 0) step += this.steps;
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
