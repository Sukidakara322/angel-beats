/* ------------------------------------------------------------------
 * Sound Pad — Drum view (editor for a drum track)
 * Pads + a step grid that is as long as the part plus one bar of room
 * to grow (hits placed there extend the part), a length ruler on top
 * and a velocity lane for the selected drum row underneath.
 * It edits the track's current part — it owns no pattern data itself.
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
    this.recordArmed = false;

    this.STEPS = 0;        // visible columns = part length + 1 bar
    this.cellEls = {};     // drumId -> [cell, ...]
    this.labelEls = {};    // drumId -> row label
    this.columns = [];     // step -> [cell, ...]  (for fast playhead updates)
    this.lastCol = -1;
    this.selected = this.kit.drums[0].id;   // row shown in the velocity lane
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
          <span class="seq-hint">Hits in the shaded bar extend the part · drag the ▼ marker to set its length · double-click the ruler for auto length</span>
        </div>
        <div class="drum-scroll" data-role="scroll">
          <div class="drum-inner">
            <div class="drum-strip"><div class="seq-label"></div><canvas class="len-ruler" data-role="ruler"></canvas></div>
            <div class="seq-grid" data-role="grid"></div>
            <div class="drum-strip vel-strip">
              <div class="seq-label vel-label">Velocity<b data-role="velName"></b></div>
              <canvas class="vel-lane" data-role="vel"></canvas>
            </div>
          </div>
        </div>
      </section>`;
    const q = (r) => this.root.querySelector(`[data-role="${r}"]`);
    this.padsEl = q("pads");
    this.gridEl = q("grid");
    this.titleEl = q("title");
    this.velNameEl = q("velName");
    this.velCanvas = q("vel");
    this.rulerCanvas = q("ruler");
    this._buildPads();

    const rect = (canvas, row) => (s) => {
      const cell = this.cellEls[row()][s];
      const cr = cell.getBoundingClientRect();
      return { x: cr.left - canvas.getBoundingClientRect().left, w: cr.width };
    };
    this.vel = new SoundPad.VelocityLane(this.velCanvas, {
      steps: () => this.STEPS,
      getNotes: () => this.part.notes.filter((n) => n.key === this.selected),
      columnRect: rect(this.velCanvas, () => this.selected),
      onChange: () => this._paintRow(this.selected),
    });
    this.ruler = new SoundPad.LengthRuler(this.rulerCanvas, {
      steps: () => this.STEPS,
      columnRect: rect(this.rulerCanvas, () => this.kit.drums[0].id),
      getPart: () => this.part,
      onChange: () => this.refresh(),
    });

    this._ro = new ResizeObserver(() => this._resizeStrips());
    this._ro.observe(this.gridEl);

    this.refresh();
    this.selectRow(this.selected);
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

  /** (Re)build the grid rows for the current number of visible steps. */
  _buildGrid() {
    this.gridEl.innerHTML = "";
    this.cellEls = {};
    this.labelEls = {};
    this.columns = Array.from({ length: this.STEPS }, () => []);
    this.lastCol = -1;
    this.root.style.setProperty("--steps", this.STEPS);

    this.kit.drums.forEach((d) => {
      this.cellEls[d.id] = [];
      const row = document.createElement("div");
      row.className = "seq-row";

      const label = document.createElement("div");
      label.className = "seq-label selectable" + (d.id === this.selected ? " selected" : "");
      label.textContent = d.name;
      label.title = "Show this drum in the velocity lane";
      label.addEventListener("click", () => this.selectRow(d.id));
      this.labelEls[d.id] = label;
      row.appendChild(label);

      const cells = document.createElement("div");
      cells.className = "seq-cells";
      for (let i = 0; i < this.STEPS; i++) {
        const cell = document.createElement("div");
        let cls = "cell";
        if (i % 4 === 0) cls += " beat";
        if (i % 16 === 0 && i !== 0) cls += " bar";
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

  _resizeStrips() {
    const firstCells = this.gridEl.querySelector(".seq-cells");
    if (!firstCells || !firstCells.offsetWidth) return; // hidden tab
    this.ruler.resize(firstCells.offsetWidth);
    this.vel.resize(firstCells.offsetWidth);
  }

  /** Edit the part and mirror it in the grid (the grid grows/shrinks with the part). */
  _setCell(id, step, on) {
    if (!SoundPad.Project.setNote(this.part, step, id, on)) return;
    if (this._wantedSteps() !== this.STEPS) { this.refresh(); return; }
    this._paintRow(id);
    this.ruler.draw();
    if (id === this.selected) this.vel.draw();
  }

  _wantedSteps() {
    const P = SoundPad.Project;
    return Math.min(P.MAX_PART_STEPS, P.partLength(this.part) + P.BAR);
  }

  /** Redraw one drum row from the part (on/off + velocity shading + past-the-end shading). */
  _paintRow(id) {
    const row = this.cellEls[id];
    const len = SoundPad.Project.partLength(this.part);
    row.forEach((c, i) => {
      c.classList.remove("on");
      c.style.removeProperty("--vel");
      c.classList.toggle("beyond", i >= len);
    });
    this.part.notes.forEach((n) => {
      if (n.key !== id || !row[n.step]) return;
      row[n.step].classList.add("on");
      row[n.step].style.setProperty("--vel", n.vel);
    });
  }

  selectRow(id) {
    this.selected = id;
    Object.entries(this.labelEls).forEach(([k, el]) => el.classList.toggle("selected", k === id));
    this.velNameEl.textContent = this.kit.byId[id].name;
    this.vel.draw();
  }

  // --- Editor interface ---------------------------------------------

  /** Redraw everything from the current part (rebuilding the grid if its length changed). */
  refresh() {
    const P = SoundPad.Project;
    const part = this.part;
    const bars = P.partLength(part) / P.BAR;
    this.titleEl.textContent = `${this.track.name} — ${part.name} · ${bars} bar${bars === 1 ? "" : "s"}`;
    const wanted = this._wantedSteps();
    if (wanted !== this.STEPS) {
      this.STEPS = wanted;
      this._buildGrid();
    }
    this.kit.drums.forEach((d) => this._paintRow(d.id));
    this._resizeStrips();
    this.ruler.draw();
    this.vel.draw();
  }

  async playLive(id) {
    await this.engine.init();
    const now = this.engine.ctx.currentTime;
    this.kit.trigger(id, now, 0);
    this._flashPad(id);
    if (this.recordArmed && this.engine.isPlaying) {
      const step = this.engine.quantizeToStep(now) % SoundPad.Project.partLength(this.part);
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
    if (this._ro) this._ro.disconnect();
    this.vel.destroy();
    this.root.innerHTML = "";
  }
};
