/* ------------------------------------------------------------------
 * Sound Pad — Bass view
 * A pitched instrument: a one-octave playable keyboard (mouse or computer
 * keys) plus a piano-roll step sequencer (rows = notes). Shares the same
 * instrument interface as DrumView so app.js treats both the same way.
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.BassView = class BassView {
  constructor(engine, root) {
    this.engine = engine;
    this.synth = new SoundPad.BassSynth(engine);
    this.root = root;
    this.STEPS = engine.steps;
    this.recordArmed = false;

    // Piano-roll range: E1 (MIDI 28) up to E3 (MIDI 52).
    this.LOW = 28;
    this.HIGH = 52;
    this.notes = SoundPad.noteRange(this.LOW, this.HIGH); // high → low

    // Playable computer-key octave (12 keys + top C).
    this.MIN_BASE = 28;
    this.MAX_BASE = 40;
    this.baseMidi = 28;
    this.keyMap = [
      ["z", 0], ["s", 1], ["x", 2], ["d", 3], ["c", 4], ["v", 5],
      ["g", 6], ["b", 7], ["h", 8], ["n", 9], ["j", 10], ["m", 11], [",", 12],
    ];

    // pattern[midi] = boolean[STEPS]
    this.pattern = {};
    this.notes.forEach((n) => (this.pattern[n.midi] = new Array(this.STEPS).fill(false)));

    this.cellEls = {};
    this.painting = false;
    this.paintValue = false;
    document.addEventListener("mouseup", () => (this.painting = false));
  }

  build() {
    this.root.innerHTML = `
      <section class="pads bass-keys" data-role="keys"></section>
      <div class="octave-ctrl">
        <button data-role="octDown" class="tbtn">Oct −</button>
        <span data-role="octLabel" class="oct-label"></span>
        <button data-role="octUp" class="tbtn">Oct +</button>
      </div>
      <section class="sequencer">
        <div class="seq-head">
          <h2>Bass Sequencer</h2>
          <div class="beat-numbers" data-role="beats"></div>
        </div>
        <div class="seq-grid piano" data-role="grid"></div>
      </section>`;
    this.keysEl = this.root.querySelector('[data-role="keys"]');
    this.beatsEl = this.root.querySelector('[data-role="beats"]');
    this.gridEl = this.root.querySelector('[data-role="grid"]');
    this.octLabel = this.root.querySelector('[data-role="octLabel"]');

    this.root.querySelector('[data-role="octDown"]').addEventListener("click", () => this.shiftOctave(-12));
    this.root.querySelector('[data-role="octUp"]').addEventListener("click", () => this.shiftOctave(12));

    this._buildKeys();
    this._buildBeats();
    this._buildGrid();
    this._updateOctaveLabel();
  }

  _buildKeys() {
    this.keysEl.innerHTML = "";
    this.keyMap.forEach(([key, semi]) => {
      const midi = this.baseMidi + semi;
      const natural = SoundPad.isNatural(midi);
      const btn = document.createElement("button");
      btn.className = "pad note-key" + (natural ? "" : " sharp");
      btn.dataset.midi = midi;
      btn.innerHTML = `${SoundPad.midiName(midi)}<span class="key">${key === "," ? "," : key.toUpperCase()}</span>`;
      btn.addEventListener("mousedown", () => this.playLive(midi));
      this.keysEl.appendChild(btn);
    });
  }

  _buildBeats() {
    for (let i = 0; i < this.STEPS; i++) {
      const s = document.createElement("span");
      s.textContent = i % 4 === 0 ? String(i / 4 + 1) : "";
      this.beatsEl.appendChild(s);
    }
  }

  _buildGrid() {
    this.notes.forEach((n) => {
      this.cellEls[n.midi] = [];
      const row = document.createElement("div");
      row.className = "seq-row note-row" + (n.natural ? "" : " sharp-row");

      const label = document.createElement("div");
      label.className = "seq-label note-label";
      label.textContent = n.name;
      row.appendChild(label);

      const cells = document.createElement("div");
      cells.className = "seq-cells";
      for (let i = 0; i < this.STEPS; i++) {
        const cell = document.createElement("div");
        let cls = "cell";
        if (i % 4 === 0) cls += " beat";
        if (i % 8 === 0 && i !== 0) cls += " bar";
        cell.className = cls;
        cell.addEventListener("mousedown", (e) => {
          e.preventDefault();
          this.painting = true;
          this.paintValue = !this.pattern[n.midi][i];
          this._setCell(n.midi, i, this.paintValue);
          if (this.paintValue) this._preview(n.freq);
        });
        cell.addEventListener("mouseenter", () => {
          if (this.painting) this._setCell(n.midi, i, this.paintValue);
        });
        cells.appendChild(cell);
        this.cellEls[n.midi].push(cell);
      }
      row.appendChild(cells);
      this.gridEl.appendChild(row);
    });
  }

  _setCell(midi, step, on) {
    this.pattern[midi][step] = on;
    this.cellEls[midi][step].classList.toggle("on", on);
  }

  async _preview(freq) {
    await this.engine.init();
    this.synth.note(freq, this.engine.ctx.currentTime, 0.18);
  }

  shiftOctave(delta) {
    const next = Math.min(this.MAX_BASE, Math.max(this.MIN_BASE, this.baseMidi + delta));
    if (next === this.baseMidi) return;
    this.baseMidi = next;
    this._buildKeys();
    this._updateOctaveLabel();
  }

  _updateOctaveLabel() {
    this.octLabel.textContent = `${SoundPad.midiName(this.baseMidi)} – ${SoundPad.midiName(this.baseMidi + 12)}`;
  }

  // --- Instrument interface -----------------------------------------

  onStep(step, time) {
    const dur = Math.max(0.12, this.engine.secondsPerStep() * 0.95);
    this.notes.forEach((n) => {
      if (this.pattern[n.midi][step]) this.synth.note(n.freq, time, dur);
    });
  }

  async playLive(midi) {
    await this.engine.init();
    const freq = SoundPad.midiToFreq(midi);
    this.synth.note(freq, this.engine.ctx.currentTime, 0.25);
    this._flashKey(midi);
    if (this.recordArmed && this.engine.isPlaying && this.pattern[midi]) {
      const step = this.engine.quantizeToStep(this.engine.ctx.currentTime);
      this._setCell(midi, step, true);
    }
  }

  handleKey(key) {
    if (key === "[") { this.shiftOctave(-12); return true; }
    if (key === "]") { this.shiftOctave(12); return true; }
    const entry = this.keyMap.find(([k]) => k === key);
    if (!entry) return false;
    this.playLive(this.baseMidi + entry[1]);
    return true;
  }

  _flashKey(midi) {
    const btn = this.keysEl.querySelector(`.note-key[data-midi="${midi}"]`);
    if (!btn) return;
    btn.classList.add("hit");
    setTimeout(() => btn.classList.remove("hit"), 90);
  }

  highlightColumn(step) {
    this.notes.forEach((n) =>
      this.cellEls[n.midi].forEach((c, i) => c.classList.toggle("playing", i === step))
    );
  }

  clearPlayhead() {
    this.notes.forEach((n) =>
      this.cellEls[n.midi].forEach((c) => c.classList.remove("playing"))
    );
  }

  getPattern() {
    const snap = {};
    this.notes.forEach((n) => (snap[n.midi] = this.pattern[n.midi].slice()));
    return snap;
  }

  setPattern(data) {
    data = data || {};
    this.notes.forEach((n) => {
      const row = data[n.midi] || [];
      for (let i = 0; i < this.STEPS; i++) this._setCell(n.midi, i, !!row[i]);
    });
  }

  clear() {
    this.notes.forEach((n) => {
      for (let i = 0; i < this.STEPS; i++) this._setCell(n.midi, i, false);
    });
  }
};
