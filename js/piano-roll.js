/* ------------------------------------------------------------------
 * Sound Pad — Piano roll (editor for any pitched track)
 * A playable keyboard (mouse or computer keys) plus a canvas piano roll
 * with real note lengths and a velocity lane.
 *
 * Mouse in the roll:
 *   click empty space   → add a note (last used length); drag to set length
 *   drag a note         → move it (time and pitch)
 *   drag a note's end   → resize it
 *   right-click / drag  → delete notes
 *   click a key label   → preview that pitch
 *
 * Shared editor interface (same as DrumView):
 *   build(), refresh(), playLive(key), handleKey(key),
 *   highlightColumn(step), clearPlayhead(), clear(), destroy()
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.PianoRollView = class PianoRollView {
  constructor({ engine, root, project, track, instrument, options = {} }) {
    this.engine = engine;
    this.root = root;
    this.project = project;
    this.track = track;
    this.synth = instrument;
    this.STEPS = project.partSteps;
    this.recordArmed = false;

    // Roll range (MIDI, inclusive) — rows are drawn high → low.
    this.LOW = options.low ?? 36;
    this.HIGH = options.high ?? 72;
    this.ROWS = this.HIGH - this.LOW + 1;
    this.ROW_H = 16;
    this.LABEL_W = 46;

    // Playable computer-key octave (12 keys + top C), shiftable with [ / ].
    this.MIN_BASE = this.LOW;
    this.MAX_BASE = this.HIGH - 12;
    this.baseMidi = Math.min(this.MAX_BASE, Math.max(this.MIN_BASE, options.base ?? this.LOW));
    this.keyMap = [
      ["z", 0], ["s", 1], ["x", 2], ["d", 3], ["c", 4], ["v", 5],
      ["g", 6], ["b", 7], ["h", 8], ["n", 9], ["j", 10], ["m", 11], [",", 12],
    ];

    this.W = 0;
    this.colW = 0;
    this.playStep = -1;
    this.lastLen = 1;      // new notes use the length you last drew/resized
    this.drag = null;
  }

  get part() {
    return SoundPad.Project.currentPart(this.project, this.track);
  }

  // --- Build ---------------------------------------------------------

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
          <h2 data-role="title"></h2>
          <span class="seq-hint">Click to add · drag to set length · drag a note to move · drag its end to resize · right-click to delete</span>
        </div>
        <div class="roll-scroll" data-role="scroll"><canvas class="roll" data-role="roll"></canvas></div>
        <div class="vel-head">Velocity <span>drag to set · applies to every note starting on that step</span></div>
        <canvas class="vel-lane" data-role="vel"></canvas>
      </section>`;
    const q = (r) => this.root.querySelector(`[data-role="${r}"]`);
    this.keysEl = q("keys");
    this.titleEl = q("title");
    this.octLabel = q("octLabel");
    this.scrollEl = q("scroll");
    this.canvas = q("roll");
    this.g = this.canvas.getContext("2d");

    q("octDown").addEventListener("click", () => this.shiftOctave(-12));
    q("octUp").addEventListener("click", () => this.shiftOctave(12));

    this.vel = new SoundPad.VelocityLane(q("vel"), {
      steps: this.STEPS,
      getNotes: () => this.part.notes,
      columnRect: (s) => ({ x: this.LABEL_W + s * this.colW, w: this.colW }),
      onChange: () => this.draw(),
    });

    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this._onDown(e));
    c.addEventListener("pointermove", (e) => this._onMove(e));
    c.addEventListener("pointerup", () => this._onUp());
    c.addEventListener("pointercancel", () => this._onUp());
    c.addEventListener("contextmenu", (e) => e.preventDefault());

    // Size the canvas to its container (also fires when the tab becomes visible).
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this.scrollEl);

    this._buildKeys();
    this._updateOctaveLabel();
    this.refresh();
  }

  _buildKeys() {
    this.keysEl.innerHTML = "";
    this.keyMap.forEach(([key, semi]) => {
      const midi = this.baseMidi + semi;
      const btn = document.createElement("button");
      btn.className = "pad note-key" + (SoundPad.isNatural(midi) ? "" : " sharp");
      btn.dataset.midi = midi;
      btn.innerHTML = `${SoundPad.midiName(midi)}<span class="key">${key === "," ? "," : key.toUpperCase()}</span>`;
      btn.addEventListener("mousedown", () => this.playLive(midi));
      this.keysEl.appendChild(btn);
    });
  }

  _resize() {
    const w = this.scrollEl.clientWidth;
    if (!w) return; // hidden tab
    const dpr = window.devicePixelRatio || 1;
    const h = this.ROWS * this.ROW_H;
    this.W = w;
    this.dpr = dpr;
    this.colW = (w - this.LABEL_W) / this.STEPS;
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    if (!this._scrolled) {
      this._scrollToBase();
      this._scrolled = true;
    }
    this.draw();
    this.vel.resize(w);
  }

  /** Scroll the roll so the playable octave is in view. */
  _scrollToBase() {
    const topMidi = Math.min(this.HIGH, this.baseMidi + 16);
    this.scrollEl.scrollTop = (this.HIGH - topMidi) * this.ROW_H;
  }

  // --- Drawing -------------------------------------------------------

  _rowY(midi) {
    return (this.HIGH - midi) * this.ROW_H;
  }

  draw() {
    if (!this.W) return;
    const g = this.g, W = this.W, RH = this.ROW_H, LW = this.LABEL_W, cw = this.colW;
    const H = this.ROWS * RH;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    // Rows: lane shading + piano-key labels.
    g.font = "10px Segoe UI, system-ui, sans-serif";
    g.textBaseline = "middle";
    for (let midi = this.HIGH; midi >= this.LOW; midi--) {
      const y = this._rowY(midi);
      const natural = SoundPad.isNatural(midi);
      g.fillStyle = natural ? "#1b212a" : "#151a21";
      g.fillRect(LW, y, W - LW, RH);
      g.fillStyle = "#11151b";
      g.fillRect(LW, y + RH - 1, W - LW, 1);

      g.fillStyle = natural ? "#cfd5de" : "#0d1015";
      g.fillRect(0, y, LW - 2, RH - 1);
      const isC = midi % 12 === 0;
      g.fillStyle = natural ? (isC ? "#0e1116" : "#5a6472") : "#6b7480";
      g.font = (isC ? "600 " : "") + "10px Segoe UI, system-ui, sans-serif";
      g.fillText(SoundPad.midiName(midi), 6, y + RH / 2);
      if (isC) {                       // octave boundary line
        g.fillStyle = "#39424f";
        g.fillRect(LW, y + RH - 1, W - LW, 1);
      }
    }

    // Vertical grid: steps, beats, bars.
    for (let s = 0; s <= this.STEPS; s++) {
      const x = Math.round(LW + s * cw);
      g.fillStyle = s % 16 === 0 ? "#4a5462" : s % 4 === 0 ? "#2f3844" : "#20262f";
      g.fillRect(x - (s % 16 === 0 ? 1 : 0), 0, s % 16 === 0 ? 2 : 1, H);
    }

    // Playhead column.
    if (this.playStep >= 0) {
      g.fillStyle = "rgba(77, 163, 255, 0.13)";
      g.fillRect(LW + this.playStep * cw, 0, cw, H);
    }

    // Notes.
    this.part.notes.forEach((n) => {
      if (n.key < this.LOW || n.key > this.HIGH) return;
      const x = LW + n.step * cw + 1;
      const y = this._rowY(n.key) + 1;
      const w = Math.max(3, n.len * cw - 2);
      const h = RH - 3;
      const playing = this.playStep >= n.step && this.playStep < n.step + n.len;
      g.fillStyle = `rgba(255, 180, 84, ${0.4 + 0.6 * n.vel})`;
      g.fillRect(x, y, w, h);
      g.strokeStyle = playing ? "#ffffff" : "#ffd59c";
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      // Resize grip on the right edge.
      if (w > 10) {
        g.fillStyle = "rgba(14, 17, 22, 0.45)";
        g.fillRect(x + w - 4, y + 2, 2, h - 4);
      }
    });
  }

  // --- Mouse editing -------------------------------------------------

  _hit(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const step = Math.min(this.STEPS - 1, Math.max(0, Math.floor((x - this.LABEL_W) / this.colW)));
    const midi = Math.min(this.HIGH, Math.max(this.LOW, this.HIGH - Math.floor(y / this.ROW_H)));
    return { x, y, step, midi, inLabel: x < this.LABEL_W };
  }

  /** Is x on the right-edge grip of a note? */
  _onEdge(note, x) {
    const right = this.LABEL_W + (note.step + note.len) * this.colW;
    return right - x <= Math.max(4, Math.min(9, this.colW * 0.4));
  }

  _onDown(e) {
    if (!this.colW) return;
    const P = SoundPad.Project;
    const h = this._hit(e);
    if (h.inLabel) { this._preview(h.midi); return; }
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }

    if (e.button === 2) {
      this.drag = { mode: "erase" };
      this._eraseAt(h);
      return;
    }
    if (e.button !== 0) return;

    const hit = P.noteAt(this.part, h.step, h.midi);
    if (hit && this._onEdge(hit, h.x)) {
      this.drag = { mode: "resize", note: hit, moved: true };
    } else if (hit) {
      this.drag = { mode: "move", note: hit, grab: h.step - hit.step };
      this.lastLen = hit.len;
      this._preview(hit.key, hit.vel);
    } else {
      const len = Math.min(this.lastLen, this.STEPS - h.step);
      const note = P.addNote(this.part, { step: h.step, key: h.midi, len });
      // A freshly drawn note keeps its default length until the mouse leaves its first cell.
      this.drag = { mode: "resize", note, moved: false, origin: h.step };
      this._preview(h.midi);
    }
    this.draw();
    this.vel.draw();
  }

  _onMove(e) {
    if (!this.colW) return;
    const h = this._hit(e);
    const d = this.drag;
    if (!d) { this._updateCursor(h); return; }

    if (d.mode === "erase") {
      this._eraseAt(h);
    } else if (d.mode === "resize") {
      if (!d.moved && h.step === d.origin) return;
      d.moved = true;
      const len = Math.min(this.STEPS - d.note.step, Math.max(1, h.step - d.note.step + 1));
      if (len !== d.note.len) {
        d.note.len = len;
        this.lastLen = len;
        this.draw();
      }
    } else if (d.mode === "move") {
      const step = Math.min(this.STEPS - d.note.len, Math.max(0, h.step - d.grab));
      if (step !== d.note.step || h.midi !== d.note.key) {
        if (h.midi !== d.note.key) this._preview(h.midi, d.note.vel);
        d.note.step = step;
        d.note.key = h.midi;
        this.draw();
        this.vel.draw();
      }
    }
  }

  _onUp() {
    const d = this.drag;
    this.drag = null;
    if (d && d.note) SoundPad.Project.dedupe(this.part, d.note);
    this.draw();
    this.vel.draw();
  }

  _eraseAt(h) {
    const note = SoundPad.Project.noteAt(this.part, h.step, h.midi);
    if (!note) return;
    SoundPad.Project.removeNote(this.part, note);
    this.draw();
    this.vel.draw();
  }

  _updateCursor(h) {
    let cursor = "crosshair";
    if (h.inLabel) cursor = "pointer";
    else {
      const note = SoundPad.Project.noteAt(this.part, h.step, h.midi);
      if (note) cursor = this._onEdge(note, h.x) ? "ew-resize" : "grab";
    }
    this.canvas.style.cursor = cursor;
  }

  async _preview(midi, vel = SoundPad.DEFAULT_VEL) {
    await this.engine.init();
    this.synth.trigger(midi, this.engine.ctx.currentTime, 0.18, vel);
  }

  // --- Keyboard / octave ---------------------------------------------

  shiftOctave(delta) {
    const next = Math.min(this.MAX_BASE, Math.max(this.MIN_BASE, this.baseMidi + delta));
    if (next === this.baseMidi) return;
    this.baseMidi = next;
    this._buildKeys();
    this._updateOctaveLabel();
    this._scrollToBase();
  }

  _updateOctaveLabel() {
    this.octLabel.textContent = `${SoundPad.midiName(this.baseMidi)} – ${SoundPad.midiName(this.baseMidi + 12)}`;
  }

  _flashKey(midi) {
    const btn = this.keysEl.querySelector(`.note-key[data-midi="${midi}"]`);
    if (!btn) return;
    btn.classList.add("hit");
    setTimeout(() => btn.classList.remove("hit"), 90);
  }

  // --- Editor interface ---------------------------------------------

  refresh() {
    this.titleEl.textContent = `${this.track.name} — ${this.part.name}`;
    this.draw();
    this.vel.draw();
  }

  async playLive(midi) {
    await this.engine.init();
    const now = this.engine.ctx.currentTime;
    this.synth.trigger(midi, now, 0.25);
    this._flashKey(midi);
    if (this.recordArmed && this.engine.isPlaying && midi >= this.LOW && midi <= this.HIGH) {
      const step = this.engine.quantizeToStep(now) % this.STEPS;
      SoundPad.Project.addNote(this.part, { step, key: midi, len: 1 });
      this.draw();
      this.vel.draw();
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

  highlightColumn(step) {
    if (step === this.playStep) return;
    this.playStep = step;
    this.draw();
  }

  clearPlayhead() {
    this.highlightColumn(-1);
  }

  clear() {
    SoundPad.Project.clearPart(this.part);
    this.refresh();
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
    this.vel.destroy();
    this.root.innerHTML = "";
  }
};
