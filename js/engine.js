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

    // Audio health (see _watch): the app shows a warning + "Restart audio".
    this.onProblem = null;         // (kind, message) => void, set by app
    this._watchTimer = null;
  }

  /** Must be called from a user gesture (browsers block audio otherwise). */
  async init() {
    if (this.ctx) {
      if (this.ctx.state !== "running") await this.ctx.resume().catch(() => {});
      return;
    }
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
    // A tap on the output, only to check the signal is still valid (see _watch).
    this._tap = this.ctx.createAnalyser();
    this._tap.fftSize = 2048;
    this._tapBuf = new Float32Array(this._tap.fftSize);
    this.limiter.connect(this._tap);

    this._buildNoiseBuffer();
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
    this._lastClock = { t: this.ctx.currentTime, at: performance.now() };
    this._watchTimer = setInterval(() => this._watch(), 500);
  }

  /**
   * Throw the audio context away and start a new one (the app then rebuilds
   * every track's instrument on it). The cure for a dead output: a stalled
   * audio device, or an invalid (NaN) signal stuck in the limiter.
   */
  async restart() {
    this.stop();
    clearInterval(this._watchTimer);
    this._watchTimer = null;
    this._reported = new Set();
    this._suspendedKey = null;
    const old = this.ctx;
    this.ctx = this.master = this.limiter = this._tap = this.noiseBuffer = null;
    if (old) await old.close().catch(() => {});
    await this.init();
  }

  /** Tell the app about a problem — once per `key` (e.g. once per failing track) until a restart. */
  _report(kind, message, key = kind + message) {
    this._reported = this._reported || new Set();
    if (this._reported.has(key)) return;
    this._reported.add(key);
    if (kind === "suspended") this._suspendedKey = key;
    console.error(`[Sound Pad audio] ${kind}: ${message}`);
    if (this.onProblem) this.onProblem(kind, message);
  }

  /**
   * Audio health check, twice a second:
   *  • context suspended/interrupted (device change, OS) → try to resume
   *  • clock not moving although "running" → the output device stalled
   *  • NaN/Infinity in the output → a bad signal latched the limiter (silence)
   */
  _watch() {
    const ctx = this.ctx;
    if (!ctx || ctx.state === "closed") return;
    if (ctx.state !== "running") {
      ctx.resume().catch(() => {});
      if (this.isPlaying) this._report("suspended", `the browser paused audio output (state: ${ctx.state})`);
      return;
    }
    const now = performance.now();
    if (ctx.currentTime !== this._lastClock.t) this._lastClock = { t: ctx.currentTime, at: now };
    else if (now - this._lastClock.at > 1500 && !document.hidden) {
      this._report("stalled", "the audio device stopped responding");
      return;
    }
    this._tap.getFloatTimeDomainData(this._tapBuf);
    for (let i = 0; i < this._tapBuf.length; i += 8) {
      if (!Number.isFinite(this._tapBuf[i])) { this._report("invalid", "an invalid signal (NaN) reached the output"); return; }
    }
    if (this._suspendedKey) {             // resumed on its own: all clear
      this._reported.delete(this._suspendedKey);
      this._suspendedKey = null;
      if (this.onProblem) this.onProblem(null);
    }
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
      // An error must never stop the clock: without this, the same step would
      // be retried (and fail) forever and the whole app would go silent.
      let info = null;
      try {
        info = this.onStep ? this.onStep(this.currentStep, this.nextNoteTime) : null;
      } catch (err) {
        this._report("error", err && err.message ? err.message : String(err));
      }
      this.drawQueue.push({ step: this.currentStep, time: this.nextNoteTime, info });
      this.nextNoteTime += this.secondsPerStep();
      this.currentStep = (this.currentStep + 1) % this.loopSteps;
    }
  }

  /**
   * Snap a real-time moment (e.g. a live pad hit) to the nearest step index
   * within the loop. Used so recorded hits land cleanly on the grid.
   * Counts back from the next step the scheduler will play, so it stays
   * right even if the tempo or the loop length changed while playing.
   */
  quantizeToStep(atTime) {
    const back = Math.round((this.nextNoteTime - atTime) / this.secondsPerStep());
    let step = (this.currentStep - back) % this.loopSteps;
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
