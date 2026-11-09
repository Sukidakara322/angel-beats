/* ------------------------------------------------------------------
 * Sound Pad — Drum view (editor for a drum track)
 * Pads + step grid. It edits the track's current part (sparse notes in
 * the project) — it doesn't own any pattern data itself.
 *
 * Shared editor interface used by app.js:
 *   build(), refresh(), playLive(key), handleKey(key),
 *   highlightColumn(step), clearPlayhead(), clear(), destroy()
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.DrumView = class DrumView {
  constructor({ engine, root, project, track, instrument }) {
    this.engine = engine;
    this.root = root;
    this.project = project;
    this.track = track;
    this.kit = instrument;
    this.STEPS = project.partSteps;
    this.recordArmed = false;

    this.cellEls = {};     // drumId -> [cell, ...]
    this.columns = [];     // step -> [cell, ...]  (for fast playhead updates)
    this.lastCol = -1;
    this.painting = false;
    this.paintValue = false;
    this._onMouseUp = () => (this.painting = false);
    document.addEventListener("mouseup", this._onMouseUp);
  }

  get part() {
    return SoundPad.Project.currentPart(this.project, this.track);
  }

  build() {
    this.root.innerHTML = `
      <section class="pads" data-role="pads"></section>
      <section class="sequencer">
        <div class="seq-head">
          <h2 data-role="title"></h2>
          <div class="beat-numbers" data-role="beats"></div>
        </div>
        <div class="seq-grid" data-role="grid"></div>
      </section>`;
    this.padsEl = this.root.querySelector('[data-role="pads"]');
    this.beatsEl = this.root.querySelector('[data-role="beats"]');
    this.gridEl = this.root.querySelector('[data-role="grid"]');
    this.titleEl = this.root.querySelector('[data-role="title"]');
    this._buildPads();
    this._buildBeats();
    this._buildGrid();
    this.refresh();
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
    for (let i = 0; i < this.STEPS; i++) this.columns.push([]);

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
          this.paintValue = !SoundPad.Project.findNote(this.part, i, d.id);
          this._setCell(d.id, i, this.paintValue);
        });
        cell.addEventListener("mouseenter", () => {
          if (this.painting) this._setCell(d.id, i, this.paintValue);
        });
        cells.appendChild(cell);
        this.cellEls[d.id].push(cell);
        this.columns[i].push(cell);
      }
      row.appendChild(cells);
      this.gridEl.appendChild(row);
    });
  }

  /** Edit the part and mirror it in the grid. */
  _setCell(id, step, on) {
    SoundPad.Project.setNote(this.part, step, id, on);
    this.cellEls[id][step].classList.toggle("on", on);
  }

  // --- Editor interface ---------------------------------------------

  /** Redraw the grid from the current part's notes. */
  refresh() {
    const part = this.part;
    this.titleEl.textContent = `${this.track.name} — ${part.name}`;
    Object.values(this.cellEls).forEach((row) => row.forEach((c) => c.classList.remove("on")));
    part.notes.forEach((n) => {
      const cell = this.cellEls[n.key] && this.cellEls[n.key][n.step];
      if (cell) cell.classList.add("on");
    });
  }

  async playLive(id) {
    await this.engine.init();
    const now = this.engine.ctx.currentTime;
    this.kit.trigger(id, now, 0, 1);
    this._flashPad(id);
    if (this.recordArmed && this.engine.isPlaying) {
      const step = this.engine.quantizeToStep(now) % this.STEPS;
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
    if (step === this.lastCol) return;
    if (this.columns[this.lastCol]) this.columns[this.lastCol].forEach((c) => c.classList.remove("playing"));
    if (this.columns[step]) this.columns[step].forEach((c) => c.classList.add("playing"));
    this.lastCol = step;
  }

  clearPlayhead() {
    this.highlightColumn(-1);
  }

  clear() {
    SoundPad.Project.clearPart(this.part);
    this.refresh();
  }

  destroy() {
    document.removeEventListener("mouseup", this._onMouseUp);
    this.root.innerHTML = "";
  }
};
