/* ------------------------------------------------------------------
 * Sound Pad — Velocity lane
 * A small canvas under a grid: one bar per note, height = velocity.
 * Click or drag across it to set the velocity of the notes that start
 * at each step (all notes of a chord at once).
 *
 * The owning editor tells the lane where its columns are, so the bars
 * line up with any grid layout:
 *   new VelocityLane(canvas, {
 *     steps, getNotes(), columnRect(step) -> {x, w}, onChange()
 *   })
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.VelocityLane = class VelocityLane {
  constructor(canvas, { steps, getNotes, columnRect, onChange }) {
    this.canvas = canvas;
    this.g = canvas.getContext("2d");
    this.steps = steps;
    this.getNotes = getNotes;
    this.columnRect = columnRect;
    this.onChange = onChange || (() => {});
    this.H = 56;
    this.PAD = 4;
    this.W = 0;
    this.dragging = false;

    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      this._apply(e);
    });
    canvas.addEventListener("pointermove", (e) => { if (this.dragging) this._apply(e); });
    const end = () => (this.dragging = false);
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }

  resize(width) {
    if (!width) return;
    const dpr = window.devicePixelRatio || 1;
    this.W = width;
    this.dpr = dpr;
    this.canvas.style.width = width + "px";
    this.canvas.style.height = this.H + "px";
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(this.H * dpr);
    this.draw();
  }

  draw() {
    if (!this.W) return;
    const g = this.g;
    const H = this.H, PAD = this.PAD;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.W, H);

    const first = this.columnRect(0);
    const last = this.columnRect(this.steps - 1);
    if (!first || !last) return;
    const left = first.x, right = last.x + last.w;

    // Background + guide lines at "normal" velocity and max.
    g.fillStyle = "#141920";
    g.fillRect(left, 0, right - left, H);
    const yOf = (v) => H - PAD - v * (H - PAD * 2);
    g.strokeStyle = "#2a323d";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(left, Math.round(yOf(SoundPad.DEFAULT_VEL)) + 0.5);
    g.lineTo(right, Math.round(yOf(SoundPad.DEFAULT_VEL)) + 0.5);
    g.stroke();

    // Beat separators.
    for (let s = 4; s < this.steps; s += 4) {
      const { x } = this.columnRect(s);
      g.fillStyle = s % 16 === 0 ? "#39424f" : "#222932";
      g.fillRect(Math.round(x) - 1, 0, 1, H);
    }

    // One bar per note (loudest drawn last so it stays visible in chords).
    const notes = this.getNotes().slice().sort((a, b) => a.vel - b.vel);
    notes.forEach((n) => {
      const { x, w } = this.columnRect(n.step);
      const bw = Math.max(3, w * 0.45);
      const bx = x + (w - bw) / 2;
      const y = yOf(n.vel);
      g.fillStyle = `rgba(255, 180, 84, ${0.45 + 0.55 * n.vel})`;
      g.fillRect(bx, y, bw, H - PAD - y);
      g.fillStyle = "#ffd59c";
      g.fillRect(bx - 1, y - 1, bw + 2, 3);
    });
  }

  _apply(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    // Nearest column (so dragging across gaps between cells still works).
    let step = -1, best = Infinity;
    for (let s = 0; s < this.steps; s++) {
      const c = this.columnRect(s);
      const d = Math.abs(x - (c.x + c.w / 2));
      if (d < best) { best = d; step = s; }
    }
    const first = this.columnRect(0), last = this.columnRect(this.steps - 1);
    if (step < 0 || x < first.x - 4 || x > last.x + last.w + 4) return;
    const v = 1 - (y - this.PAD) / (this.H - this.PAD * 2);
    const vel = Math.round(Math.min(1, Math.max(0.05, v)) * 100) / 100;
    let changed = false;
    this.getNotes().forEach((n) => {
      if (n.step === step && n.vel !== vel) { n.vel = vel; changed = true; }
    });
    if (changed) {
      this.draw();
      this.onChange();
    }
  }

  destroy() {
    this.dragging = false;
  }
};
