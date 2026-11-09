/* ------------------------------------------------------------------
 * Sound Pad — Drum view
 * Owns the drum pads + step-sequencer UI and the drum pattern.
 * Implements the shared instrument interface used by app.js:
 *   build(), onStep(step,time), playLive(id), handleKey(key),
 *   highlightColumn(step), clearPlayhead(), getPattern(), setPattern(), clear()
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.DrumView = class DrumView {
  constructor(engine, root) {
    this.engine = engine;
    this.kit = new SoundPad.DrumKit(engine);
    this.root = root;
    this.STEPS = engine.steps;
    this.recordArmed = false;

    this.pattern = {};
    this.kit.drums.forEach((d) => (this.pattern[d.id] = new Array(this.STEPS).fill(false)));

    this.cellEls = {};
    this.painting = false;
    this.paintValue = false;
    document.addEventListener("mouseup", () => (this.painting = false));
  }

  build() {
    this.root.innerHTML = `
      <section class="pads" data-role="pads"></section>
      <section class="sequencer">
        <div class="seq-head">
          <h2>Drum Sequencer</h2>
          <div class="beat-numbers" data-role="beats"></div>
        </div>
        <div class="seq-grid" data-role="grid"></div>
      </section>`;
    this.padsEl = this.root.querySelector('[data-role="pads"]');
    this.beatsEl = this.root.querySelector('[data-role="beats"]');
    this.gridEl = this.root.querySelector('[data-role="grid"]');
    this._buildPads();
    this._buildBeats();
    this._buildGrid();
  }

  _buildPads() {
    this.kit.drums.forEach((d) => {
      const pad = document.createElement("button");
      pad.className = "pad";
      pad.dataset.id = d.id;
      pad.innerHTML = `${d.name}<span class="key">${d.key}</span>`;
      pad.addEventListener("mousedown", () => this.playLive(d.id));
      this.padsEl.appendChild(pad);
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
    this.kit.drums.forEach((d) => {
      this.cellEls[d.id] = [];
      const row = document.createElement("div");
      row.className = "seq-row";

      const label = document.createElement("div");
      label.className = "seq-label";
      label.textContent = d.name;
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
          this.paintValue = !this.pattern[d.id][i];
          this._setCell(d.id, i, this.paintValue);
        });
        cell.addEventListener("mouseenter", () => {
          if (this.painting) this._setCell(d.id, i, this.paintValue);
        });
        cells.appendChild(cell);
        this.cellEls[d.id].push(cell);
      }
      row.appendChild(cells);
      this.gridEl.appendChild(row);
    });
  }

  _setCell(id, step, on) {
    this.pattern[id][step] = on;
    this.cellEls[id][step].classList.toggle("on", on);
  }

  // --- Instrument interface -----------------------------------------

  onStep(step, time) {
    this.kit.drums.forEach((d) => {
      if (this.pattern[d.id][step]) this.kit.trigger(d.id, time);
    });
  }

  async playLive(id) {
    await this.engine.init();
    this.kit.trigger(id, this.engine.ctx.currentTime);
    this._flashPad(id);
    if (this.recordArmed && this.engine.isPlaying) {
      const step = this.engine.quantizeToStep(this.engine.ctx.currentTime);
      this._setCell(id, step, true);
    }
  }

  handleKey(key) {
    const d = this.kit.drums.find((x) => x.key.toLowerCase() === key);
    if (!d) return false;
    this.playLive(d.id);
    return true;
  }

  _flashPad(id) {
    const pad = this.padsEl.querySelector(`.pad[data-id="${id}"]`);
    if (!pad) return;
    pad.classList.add("hit");
    setTimeout(() => pad.classList.remove("hit"), 90);
  }

  highlightColumn(step) {
    this.kit.drums.forEach((d) =>
      this.cellEls[d.id].forEach((c, i) => c.classList.toggle("playing", i === step))
    );
  }

  clearPlayhead() {
    this.kit.drums.forEach((d) =>
      this.cellEls[d.id].forEach((c) => c.classList.remove("playing"))
    );
  }

  getPattern() {
    const snap = {};
    this.kit.drums.forEach((d) => (snap[d.id] = this.pattern[d.id].slice()));
    return snap;
  }

  setPattern(data) {
    data = data || {};
    this.kit.drums.forEach((d) => {
      const row = data[d.id] || [];
      for (let i = 0; i < this.STEPS; i++) this._setCell(d.id, i, !!row[i]);
    });
  }

  clear() {
    this.kit.drums.forEach((d) => {
      for (let i = 0; i < this.STEPS; i++) this._setCell(d.id, i, false);
    });
  }
};
