/* ------------------------------------------------------------------
 * Sound Pad — Drum view (editor for a drum track)
 * Pads + step grid + a velocity lane for the selected drum row.
 * It edits the track's current part (sparse notes in the project) —
 * it doesn't own any pattern data itself.
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
          <div class="beat-numbers" data-role="beats"></div>
        </div>
        <div class="seq-grid" data-role="grid"></div>
        <div class="vel-head">Velocity — <b data-role="velName"></b> <span>click a row name to pick the drum · drag to set</span></div>
        <div class="drum-vel-row"><div class="seq-label"></div><canvas class="vel-lane" data-role="vel"></canvas></div>
      </section>`;
    const q = (r) => this.root.querySelector(`[data-role="${r}"]`);
    this.padsEl = q("pads");
    this.beatsEl = q("beats");
    this.gridEl = q("grid");
    this.titleEl = q("title");
    this.velNameEl = q("velName");
    this.velCanvas = q("vel");
    this._buildPads();
    this._buildBeats();
    this._buildGrid();

    this.vel = new SoundPad.VelocityLane(this.velCanvas, {
      steps: this.STEPS,
      getNotes: () => this.part.notes.filter((n) => n.key === this.selected),
      columnRect: (s) => this._columnRect(s),
      onChange: () => this._paintRow(this.selected),
    });
    this._ro = new ResizeObserver(() => this.vel.resize(this.velCanvas.parentElement.clientWidth - 90));
    this._ro.observe(this.gridEl);

    this.selectRow(this.selected);
    this.refresh();
  }

  /** Column position of a step, relative to the velocity canvas (matches the cells above). */
  _columnRect(step) {
    const cell = this.cellEls[this.selected][step];
    const cr = cell.getBoundingClientRect();
    const lr = this.velCanvas.getBoundingClientRect();
    return { x: cr.left - lr.left, w: cr.width };
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
      label.className = "seq-label selectable";
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
    if (!SoundPad.Project.setNote(this.part, step, id, on)) return;
    this._paintRow(id);
    if (id === this.selected) this.vel.draw();
  }

  /** Redraw one drum row from the part (on/off + velocity shading). */
  _paintRow(id) {
    const row = this.cellEls[id];
    row.forEach((c) => { c.classList.remove("on"); c.style.removeProperty("--vel"); });
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

  /** Redraw the grid from the current part's notes. */
  refresh() {
    this.titleEl.textContent = `${this.track.name} — ${this.part.name}`;
    this.kit.drums.forEach((d) => this._paintRow(d.id));
    this.vel.draw();
  }

  async playLive(id) {
    await this.engine.init();
    const now = this.engine.ctx.currentTime;
    this.kit.trigger(id, now, 0);
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
    if (this._ro) this._ro.disconnect();
    this.vel.destroy();
    this.root.innerHTML = "";
  }
};
