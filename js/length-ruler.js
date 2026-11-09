/* ------------------------------------------------------------------
 * Sound Pad — Length ruler
 * A thin canvas strip above an editor grid: bar numbers + beat ticks,
 * the part's end marker, and the one-bar "room to grow" past the end.
 *
 *   drag the ▼ end marker  → set the part's length (whole bars; it can't
 *                            go shorter than the notes in it)
 *   double-click           → back to auto length (fits the content)
 *
 * Like the velocity lane, the owning editor tells it where columns are:
 *   new LengthRuler(canvas, {
 *     steps: () => visible steps, columnRect(step) -> {x, w},
 *     getPart: () => part, onChange()
 *   })
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.LengthRuler = class LengthRuler {
  constructor(canvas, { steps, columnRect, getPart, onChange, clipLeft = 0 }) {
    this.canvas = canvas;
    this.clipLeft = clipLeft;   // don't draw left of this x (e.g. piano-roll key labels)
    this.g = canvas.getContext("2d");
    this.getSteps = steps;
    this.columnRect = columnRect;
    this.getPart = getPart;
    this.onChange = onChange || (() => {});
    this.H = 24;
    this.W = 0;
    this.dragging = false;

    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !this.W) return;
      const x = this._x(e);
      const P = SoundPad.Project;
      const endX = this._boundaryX(P.partLength(this.getPart()));
      // Grab the marker, or click anywhere right of the content to move it there.
      if (Math.abs(x - endX) > 10 && x < this._boundaryX(P.autoLength(this.getPart()))) return;
      this.dragging = true;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      this._dragTo(x);
    });
    canvas.addEventListener("pointermove", (e) => {
      const x = this._x(e);
      if (this.dragging) { this._dragTo(x); return; }
      const endX = this.W ? this._boundaryX(SoundPad.Project.partLength(this.getPart())) : -99;
      canvas.style.cursor = Math.abs(x - endX) <= 10 ? "ew-resize" : "default";
    });
    const end = () => (this.dragging = false);
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("dblclick", () => {
      this.getPart().minLength = 0;
      this.onChange();
    });
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

  _x(e) {
    return e.clientX - this.canvas.getBoundingClientRect().left;
  }

  /** x of the line before `step` (between columns; step === steps → right edge). */
  _boundaryX(step) {
    const steps = this.getSteps();
    if (step <= 0) return this.columnRect(0).x;
    const prev = this.columnRect(Math.min(step, steps) - 1);
    const prevEnd = prev.x + prev.w;
    if (step >= steps) return prevEnd;
    return (prevEnd + this.columnRect(step).x) / 2;
  }

  /** Move the end marker to the bar line nearest x (never shorter than the content). */
  _dragTo(x) {
    const P = SoundPad.Project;
    const part = this.getPart();
    const steps = this.getSteps();
    let best = P.autoLength(part), bestD = Infinity;
    for (let s = P.autoLength(part); s <= Math.min(P.MAX_PART_STEPS, steps); s += P.BAR) {
      const d = Math.abs(this._boundaryX(s) - x);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (best !== P.partLength(part)) {
      P.setPartLength(part, best);
      this.onChange();
    }
  }

  draw() {
    if (!this.W) return;
    const P = SoundPad.Project;
    const g = this.g, H = this.H;
    const steps = this.getSteps();
    const part = this.getPart();
    const len = P.partLength(part);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.W, H);
    g.save();
    g.beginPath();
    g.rect(this.clipLeft, 0, this.W - this.clipLeft, H);
    g.clip();
    this._drawInner(g, H, steps, part, len);
    g.restore();
  }

  _drawInner(g, H, steps, part, len) {
    const P = SoundPad.Project;
    const left = this.columnRect(0).x;
    const endX = this._boundaryX(len);
    const right = this._boundaryX(steps);

    // Part area vs. room-to-grow area.
    g.fillStyle = "#1e242e";
    g.fillRect(left, 0, endX - left, H);
    g.fillStyle = "#12161c";
    g.fillRect(endX, 0, right - endX, H);

    // Ticks + bar numbers.
    g.font = "600 11px Segoe UI, system-ui, sans-serif";
    g.textBaseline = "middle";
    for (let s = 0; s < steps; s++) {
      if (s % 4) continue;
      const x = Math.round(this._boundaryX(s));
      const bar = s % P.BAR === 0;
      g.fillStyle = bar ? "#5a6472" : "#2f3844";
      g.fillRect(x, bar ? 0 : H - 7, 1, bar ? H : 7);
      if (bar && s !== len) {           // (the end marker's label sits at s === len)
        g.fillStyle = s < len ? "#c4ccd8" : "#5a6472";
        g.fillText(String(s / P.BAR + 1), x + 4, H / 2 - 2);
      }
    }

    // End marker.
    const fixed = P.isFixedLength(part);
    g.fillStyle = "#ffb454";
    g.fillRect(Math.round(endX) - 1, 0, 3, H);
    g.beginPath();
    g.moveTo(endX - 7, 0);
    g.lineTo(endX + 7, 0);
    g.lineTo(endX, 8);
    g.closePath();
    g.fill();

    const bars = len / P.BAR;
    const label = `${bars} bar${bars === 1 ? "" : "s"}${fixed ? " · fixed" : ""}`;
    g.font = "11px Segoe UI, system-ui, sans-serif";
    const tw = g.measureText(label).width;
    const lx = endX + 8 + tw < this.W ? endX + 8 : endX - 10 - tw;
    g.fillStyle = "#ffb454";
    g.fillText(label, lx, H / 2 + 3);
  }
};
