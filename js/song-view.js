/* ------------------------------------------------------------------
 * Sound Pad — Song view (the timeline / playlist)
 * One continuous timeline with a lane per track. Parts are placed on
 * their track's lane as clips, anywhere on the snap grid (finest grid:
 * one 16th-note step — the engine's timing resolution).
 *
 * Snap: Auto follows the zoom (bar → beat → step as you zoom in), or
 * fixed Bar / Beat / Off (= every 16th). Holding Alt bypasses snap.
 * A ghost outline shows where a click will drop the clip.
 *
 *   click an empty spot     → drop the lane's selected part there
 *   Shift + click           → drop it even on top of another clip
 *   drag a clip             → move it
 *   drag a clip's right edge→ repeat the part (longer) or cut it (shorter)
 *   Ctrl + drag a clip      → copy it
 *   Alt (while doing any)   → ignore snap, place on the exact 16th
 *   right-click / drag      → delete clips
 *   double-click a clip     → open its part in the editor
 *   clicking a clip         → also makes its part the lane's selected part
 *   drag on the ruler       → set the loop region; click it to clear
 *   Shift + wheel / scrollbar → scroll · Ctrl + wheel / − + → zoom
 *
 * Overlapping clips in one lane: the one that starts later plays.
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.PART_COLORS = ["#ffb454", "#4dd0a7", "#4da3ff", "#c38bff", "#ff7a90", "#e6d35a", "#5ee0e0", "#ff9f5a"];

/** A part's colour: by its position in its track's part list. */
SoundPad.partColor = (project, partId) => {
  const P = SoundPad.Project;
  const part = P.part(project, partId);
  if (!part) return "#5a6472";
  const idx = P.partsOf(project, part.trackId).indexOf(part);
  return SoundPad.PART_COLORS[idx % SoundPad.PART_COLORS.length];
};

SoundPad.SongView = class SongView {
  /**
   * @param {object} o
   * @param {HTMLElement} o.root
   * @param {object} o.project
   * @param {Array} o.tracks   [{ track, instrument }] in lane order
   * @param {function} o.onOpenPart(trackId, partId)
   * @param {function} o.onPickPart(trackId)  the lane's selected part changed
   */
  constructor({ root, project, tracks, onOpenPart, onPickPart }) {
    this.root = root;
    this.project = project;
    this.tracks = tracks;
    this.onOpenPart = onOpenPart || (() => {});
    this.onPickPart = onPickPart || (() => {});

    this.RULER_H = 30;
    this.LANE_H = 60;
    this.ZOOMS = [1, 1.5, 2, 3, 4, 6, 8, 12];   // pixels per step
    this.zoomIdx = 4;
    this.snap = "auto";      // "auto" (follows zoom) or a fixed step count: 16 bar, 4 beat, 1 step
    this.scrollX = 0;
    this.W = 0;
    this.playStep = -1;
    this.drag = null;
    this.hover = null;       // ghost of where a click would drop a clip
  }

  get P() { return SoundPad.Project; }
  get pps() { return this.ZOOMS[this.zoomIdx]; }

  /** Snap unit in steps for the current zoom when snap is Auto: the finest grid that's ≥ 8 px wide. */
  get autoSnap() {
    if (this.pps >= 8) return 1;
    if (this.pps * 4 >= 8) return 4;
    return 16;
  }

  /** Snap unit for this pointer event (Alt = no snap → single steps). */
  _unit(e) {
    if (e && e.altKey) return 1;
    return this.snap === "auto" ? this.autoSnap : this.snap;
  }

  _snapName(unit) {
    return unit === 16 ? "Bar" : unit === 4 ? "Beat" : "1/16";
  }

  build() {
    this.root.innerHTML = `
      <section class="song">
        <div class="song-head">
          <h2>Song</h2>
          <span class="song-sel" data-role="status"></span>
          <div class="song-tools">
            <label class="mini-ctrl" title="Where clips can start and end. Hold Alt to ignore snap.">Snap
              <select data-role="snap">
                <option value="auto" data-role="autoOpt">Auto</option>
                <option value="16">Bar</option>
                <option value="4">Beat</option>
                <option value="1">Off · 1/16</option>
              </select>
            </label>
            <div class="zoom">
              <button class="tbtn small" data-act="zoomOut" title="Zoom out (Ctrl + wheel)">−</button>
              <button class="tbtn small" data-act="zoomIn" title="Zoom in (Ctrl + wheel)">+</button>
            </div>
            <button class="tbtn small" data-act="unloop" title="Play the whole song">Clear loop</button>
          </div>
        </div>
        <p class="song-hint">Click a lane to drop its selected part (Shift+click drops on top of another clip) · drag a clip to move it · drag its right edge to repeat or shorten · Ctrl+drag to copy · hold Alt to ignore snap · right-click to delete · double-click to edit · drag on the ruler to loop (click it to clear)</p>
        <div class="tl-wrap">
          <div class="tl-heads" data-role="heads"></div>
          <div class="tl-main" data-role="main">
            <canvas class="tl-canvas" data-role="canvas"></canvas>
            <div class="hbar" data-role="hbar"><div data-role="hbarInner"></div></div>
          </div>
        </div>
      </section>`;
    const q = (r) => this.root.querySelector(`[data-role="${r}"]`);
    this.statusEl = q("status");
    this.headsEl = q("heads");
    this.mainEl = q("main");
    this.canvas = q("canvas");
    this.g = this.canvas.getContext("2d");
    this.hbar = q("hbar");
    this.hbarInner = q("hbarInner");

    const snapSel = q("snap");
    this.autoOpt = q("autoOpt");
    snapSel.value = String(this.snap);
    snapSel.addEventListener("change", () => {
      this.snap = snapSel.value === "auto" ? "auto" : parseInt(snapSel.value, 10);
      this.draw();
    });
    this._updateAutoLabel();
    this.root.querySelector('[data-act="zoomIn"]').addEventListener("click", () => this.zoom(1));
    this.root.querySelector('[data-act="zoomOut"]').addEventListener("click", () => this.zoom(-1));
    this.unloopBtn = this.root.querySelector('[data-act="unloop"]');
    this.unloopBtn.addEventListener("click", () => { this.P.clearLoop(this.project); this.render(); });

    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this._onDown(e));
    c.addEventListener("pointermove", (e) => this._onMove(e));
    c.addEventListener("pointerup", () => this._onUp());
    c.addEventListener("pointercancel", () => this._onUp());
    c.addEventListener("pointerleave", () => { if (this.hover) { this.hover = null; this.draw(); } });
    c.addEventListener("dblclick", (e) => this._onDblClick(e));
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
    this.hbar.addEventListener("scroll", () => {
      this.scrollX = this.hbar.scrollLeft;
      this.draw();
    });

    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this.mainEl);
    this.render();
  }

  // --- Layout --------------------------------------------------------

  /** Full refresh: lane headers, sizes, status, canvas. */
  render() {
    this._renderHeads();
    this._resize();
    this._renderStatus();
  }

  _resize() {
    const w = this.mainEl.clientWidth;
    if (!w) return; // hidden tab
    const dpr = window.devicePixelRatio || 1;
    const h = this.RULER_H + this.tracks.length * this.LANE_H;
    this.W = w;
    this.dpr = dpr;
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this._layout();
    this.draw();
  }

  /** Scrollable width: the song (or loop) plus 16 empty bars to build into. */
  _layout() {
    if (!this.W) return;
    const P = this.P, p = this.project;
    const used = Math.max(P.songEnd(p), p.timeline.loop ? p.timeline.loop.end : 0);
    const steps = Math.max(P._ceilBar(used) + 16 * P.BAR, Math.ceil(this.W / this.pps));
    this.contentSteps = steps;
    this.hbarInner.style.width = steps * this.pps + "px";
    const max = Math.max(0, steps * this.pps - this.W);
    if (this.scrollX > max) this.scrollX = max;
    if (Math.abs(this.hbar.scrollLeft - this.scrollX) > 0.5) this._scrollTo(this.scrollX);
  }

  /** Scroll programmatically (keeps scrollX in sync right away; the scroll event is async). */
  _scrollTo(x) {
    this.hbar.scrollLeft = Math.max(0, x);
    this.scrollX = this.hbar.scrollLeft;
  }

  zoom(dir, anchorX = this.W / 2) {
    const next = Math.min(this.ZOOMS.length - 1, Math.max(0, this.zoomIdx + dir));
    if (next === this.zoomIdx) return;
    const stepAtAnchor = (this.scrollX + anchorX) / this.pps;
    this.zoomIdx = next;
    this.scrollX = Math.max(0, stepAtAnchor * this.pps - anchorX);
    this._layout();
    this._scrollTo(this.scrollX);
    this._updateAutoLabel();
    this.draw();
  }

  /** "Auto · Beat" — shows what Auto snap currently means at this zoom. */
  _updateAutoLabel() {
    if (this.autoOpt) this.autoOpt.textContent = `Auto · ${this._snapName(this.autoSnap)}`;
  }

  // --- Lane headers (DOM, left of the canvas) ------------------------

  _renderHeads() {
    this.headsEl.innerHTML = "";
    const spacer = document.createElement("div");
    spacer.className = "tl-head-spacer";
    spacer.style.height = this.RULER_H + "px";
    spacer.textContent = "Bars";
    this.headsEl.appendChild(spacer);

    this.tracks.forEach(({ track }) => {
      const head = document.createElement("div");
      head.className = "tl-lane-head";
      head.style.height = this.LANE_H + "px";
      head.dataset.track = track.id;

      const name = document.createElement("div");
      name.className = "tl-track-name";
      name.textContent = track.name;
      const soundName = SoundPad.Instruments.presetOf(track).name;
      if (soundName !== track.name) {      // "Bass · Growl Bass", but not "Warm Pad · Warm Pad"
        const sound = document.createElement("span");
        sound.className = "tl-track-preset";
        sound.textContent = soundName;
        name.appendChild(sound);
      }

      const pick = document.createElement("select");
      pick.className = "tl-pick";
      pick.title = "Part to drop with a click";
      this.P.partsOf(this.project, track.id).forEach((part) => {
        const opt = document.createElement("option");
        opt.value = part.id;
        opt.textContent = part.name;
        pick.appendChild(opt);
      });
      pick.value = track.currentPartId;
      pick.style.borderLeftColor = SoundPad.partColor(this.project, track.currentPartId);
      pick.addEventListener("change", () => {
        this.P.setCurrentPart(this.project, track.id, pick.value);
        pick.style.borderLeftColor = SoundPad.partColor(this.project, pick.value);
        this.onPickPart(track.id);
      });

      const mute = document.createElement("button");
      mute.className = "ms mute";
      mute.textContent = "M";
      mute.title = "Mute";
      mute.addEventListener("click", () => { track.mute = !track.mute; this._renderLaneStates(); });

      const solo = document.createElement("button");
      solo.className = "ms solo";
      solo.textContent = "S";
      solo.title = "Solo";
      solo.addEventListener("click", () => { track.solo = !track.solo; this._renderLaneStates(); });

      const ctrls = document.createElement("div");
      ctrls.className = "tl-lane-ctrls";
      ctrls.append(pick, mute, solo);
      head.append(name, ctrls);
      this.headsEl.appendChild(head);
    });
    this._renderLaneStates();
  }

  /** Reflect a lane's selected part in its picker (after clicking a clip). */
  _syncPicker(track) {
    const head = this.headsEl.querySelector(`.tl-lane-head[data-track="${track.id}"]`);
    if (!head) return;
    const pick = head.querySelector(".tl-pick");
    pick.value = track.currentPartId;
    pick.style.borderLeftColor = SoundPad.partColor(this.project, track.currentPartId);
  }

  _renderLaneStates() {
    const anySolo = this.project.tracks.some((t) => t.solo);
    this.tracks.forEach(({ track }) => {
      const head = this.headsEl.querySelector(`.tl-lane-head[data-track="${track.id}"]`);
      if (!head) return;
      head.querySelector(".ms.mute").classList.toggle("on", track.mute);
      head.querySelector(".ms.solo").classList.toggle("on", track.solo);
      head.classList.toggle("silent", track.mute || (anySolo && !track.solo));
    });
    this.draw();
  }

  _fmt(step) {
    const bar = Math.floor(step / 16) + 1, beat = Math.floor((step % 16) / 4) + 1, st = step % 4;
    return st ? `${bar}.${beat}.${st + 1}` : beat > 1 ? `${bar}.${beat}` : `${bar}`;
  }

  _renderStatus() {
    const P = this.P, p = this.project;
    const end = P.songEnd(p);
    const bars = Math.ceil(end / P.BAR);
    let text = end ? `${bars} bar${bars === 1 ? "" : "s"} · ${p.timeline.clips.length} clips` : "Empty — click a lane to drop a part";
    const loop = p.timeline.loop;
    if (loop) text += ` · looping ${this._fmt(loop.start)} → ${this._fmt(loop.end)}`;
    this.statusEl.textContent = text;
    this.unloopBtn.disabled = !loop;
  }

  // --- Drawing -------------------------------------------------------

  _x(step) {
    return step * this.pps - this.scrollX;
  }

  draw() {
    if (!this.W) return;
    const P = this.P, p = this.project;
    const g = this.g, W = this.W, RH = this.RULER_H, LH = this.LANE_H, pps = this.pps;
    const H = RH + this.tracks.length * LH;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    // Lanes.
    this.tracks.forEach((_, i) => {
      g.fillStyle = i % 2 ? "#151a21" : "#181d25";
      g.fillRect(0, RH + i * LH, W, LH);
    });

    // Past the song end (what doesn't play when nothing is looped).
    const range = P.songRange(p);
    if (!p.timeline.loop) {
      const ex = this._x(range.end);
      if (ex < W) {
        g.fillStyle = "rgba(8, 10, 14, 0.35)";
        g.fillRect(Math.max(0, ex), RH, W - ex, H - RH);
      }
    }

    // Loop region.
    const loop = p.timeline.loop;
    if (loop) {
      g.fillStyle = "rgba(77, 163, 255, 0.07)";
      g.fillRect(this._x(loop.start), RH, (loop.end - loop.start) * pps, H - RH);
    }

    // Grid lines: bars, beats and single steps (each when there is room); numbers on the ruler.
    const firstStep = Math.max(0, Math.floor(this.scrollX / pps));
    const lastStep = Math.ceil((this.scrollX + W) / pps);
    const beatPx = 4 * pps, barPx = 16 * pps;
    const labelEvery = Math.max(1, Math.ceil(34 / barPx));
    g.fillStyle = "#11151b";
    g.fillRect(0, 0, W, RH);
    g.font = "600 11px Segoe UI, system-ui, sans-serif";
    g.textBaseline = "middle";
    for (let s = firstStep; s <= lastStep; s++) {
      const isBar = s % 16 === 0, isBeat = s % 4 === 0;
      if (!isBar && !(isBeat && beatPx >= 9) && pps < 6) continue;
      const x = Math.round(this._x(s));
      g.fillStyle = isBar ? "#2f3844" : isBeat ? "#1f252e" : "#1a1f27";
      g.fillRect(x, RH, 1, H - RH);
      if (!isBar && isBeat && pps >= 6) {        // beat ticks on the ruler when zoomed in
        g.fillStyle = "#2f3844";
        g.fillRect(x, RH - 6, 1, 6);
      }
      if (isBar) {
        const bar = s / 16;
        g.fillStyle = "#39424f";
        g.fillRect(x, bar % labelEvery === 0 ? 8 : 18, 1, RH);
        if (bar % labelEvery === 0) {
          g.fillStyle = "#8a94a3";
          g.fillText(String(bar + 1), x + 4, RH / 2);
        }
      }
    }
    g.fillStyle = "#2a323d";
    g.fillRect(0, RH - 1, W, 1);

    // Loop bracket on the ruler.
    if (loop) {
      const lx = this._x(loop.start), lw = (loop.end - loop.start) * pps;
      g.fillStyle = "rgba(77, 163, 255, 0.35)";
      g.fillRect(lx, RH - 9, lw, 8);
      g.fillStyle = "#4da3ff";
      g.fillRect(lx, RH - 9, 2, 8);
      g.fillRect(lx + lw - 2, RH - 9, 2, 8);
    }

    // Clips (earlier first, so later clips are drawn on top — they also win in playback).
    const anySolo = p.tracks.some((t) => t.solo);
    this.tracks.forEach(({ track, instrument }, i) => {
      const y = RH + i * LH;
      P.clipsOf(p, track.id)
        .sort((a, b) => a.start - b.start)
        .forEach((clip) => this._drawClip(clip, instrument, y));
      if (track.mute || (anySolo && !track.solo)) {
        g.fillStyle = "rgba(14, 17, 22, 0.6)";
        g.fillRect(0, y, W, LH);
      }
    });

    // Ghost: where a click would drop the lane's selected part.
    const gh = this.hover;
    if (gh && !this.drag) {
      const gx = this._x(gh.start), gy = RH + gh.lane * LH + 3;
      g.globalAlpha = 0.18;
      g.fillStyle = gh.color;
      g.fillRect(gx, gy, gh.len * pps, LH - 6);
      g.globalAlpha = 1;
      g.setLineDash([4, 3]);
      g.strokeStyle = gh.color;
      g.lineWidth = 1;
      g.strokeRect(gx + 0.5, gy + 0.5, gh.len * pps - 1, LH - 7);
      g.setLineDash([]);
      g.fillStyle = gh.color;
      g.font = "600 11px Segoe UI, system-ui, sans-serif";
      g.textBaseline = "top";
      g.fillText(`${gh.name} @ ${this._fmt(gh.start)}`, gx + 6, gy + 4);
    }

    // Playhead.
    if (this.playStep >= 0) {
      const x = this._x(this.playStep);
      g.fillStyle = "#4da3ff";
      g.fillRect(Math.round(x) - 1, 0, 2, H);
      g.beginPath();
      g.moveTo(x - 6, 0);
      g.lineTo(x + 6, 0);
      g.lineTo(x, 8);
      g.closePath();
      g.fill();
    }
  }

  _drawClip(clip, instrument, laneY) {
    const P = this.P, p = this.project, g = this.g;
    const part = P.part(p, clip.partId);
    if (!part) return;
    const len = P.clipLength(p, clip);
    const partLen = P.partLength(part);
    const x = this._x(clip.start), w = len * this.pps;
    if (x > this.W || x + w < 0) return;
    const y = laneY + 3, h = this.LANE_H - 6;
    const color = SoundPad.partColor(p, part.id);

    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();

    g.fillStyle = "#141920";
    g.fillRect(x, y, w, h);
    g.globalAlpha = 0.24;
    g.fillStyle = color;
    g.fillRect(x, y, w, h);
    g.globalAlpha = 1;

    // Repeats of the part inside a stretched clip.
    g.fillStyle = color;
    for (let r = partLen; r < len; r += partLen) {
      const rx = Math.round(this._x(clip.start + r));
      for (let dy = y + 2; dy < y + h; dy += 6) g.fillRect(rx, dy, 1, 3);
    }

    // Mini note preview, repeated like playback.
    const top = y + 18, ph = h - 22;
    g.globalAlpha = 0.85;
    g.fillStyle = "#e6ebf2";
    const drums = instrument.drums ? instrument.drums.map((d) => d.id) : null;
    let lo = 0, hi = 0;
    if (!drums && part.notes.length) {
      const keys = part.notes.map((n) => n.key);
      lo = Math.min(...keys); hi = Math.max(...keys);
      if (hi - lo < 6) { const mid = (hi + lo) / 2; lo = mid - 3; hi = mid + 3; }
    }
    for (let off = 0; off < len; off += partLen) {
      for (const n of part.notes) {
        const s = off + n.step;
        if (s >= len) continue;
        const nx = this._x(clip.start + s);
        if (drums) {
          const r = drums.indexOf(n.key);
          if (r < 0) continue;
          const rh = ph / drums.length;
          g.fillRect(nx, top + r * rh, Math.max(1.5, this.pps * 0.7), Math.max(1.5, rh * 0.8));
        } else {
          const rh = ph / (hi - lo + 1);
          const nw = Math.min(n.len, len - s) * this.pps;
          g.fillRect(nx, top + (hi - n.key) * rh, Math.max(1.5, nw - 0.5), Math.max(1.5, rh));
        }
      }
    }
    g.globalAlpha = 1;

    // Name (+ repeat count).
    const reps = len / partLen;
    const label = part.name + (reps > 1.001 ? ` ×${Number.isInteger(reps) ? reps : reps.toFixed(1)}` : "");
    g.font = "600 11px Segoe UI, system-ui, sans-serif";
    g.textBaseline = "top";
    g.fillStyle = color;
    g.fillText(label, x + 6, y + 4);
    g.restore();

    // Border + right-edge grip.
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    if (w > 14) {
      g.fillStyle = color;
      g.fillRect(x + w - 5, y + h / 2 - 8, 2, 16);
    }
  }

  // --- Mouse ---------------------------------------------------------

  _hit(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const step = Math.max(0, (x + this.scrollX) / this.pps);
    const lane = y < this.RULER_H ? -1 : Math.floor((y - this.RULER_H) / this.LANE_H);
    return { x, y, step, lane, rt: lane >= 0 ? this.tracks[lane] : null };
  }

  _snapFloor(s, unit) { return Math.floor(s / unit) * unit; }
  _snapRound(s, unit) { return Math.round(s / unit) * unit; }

  /** Topmost (latest-starting) clip under a point in a lane. */
  _clipUnder(trackId, step) {
    let hit = null;
    for (const c of this.P.clipsOf(this.project, trackId)) {
      if (c.start <= step && step < c.start + this.P.clipLength(this.project, c) && (!hit || c.start >= hit.start)) hit = c;
    }
    return hit;
  }

  _onEdge(clip, x) {
    const right = this._x(clip.start + this.P.clipLength(this.project, clip));
    return x <= right + 2 && right - x <= 7;
  }

  _onDown(e) {
    if (!this.W) return;
    const P = this.P, p = this.project;
    const h = this._hit(e);
    const unit = this._unit(e);
    this.hover = null;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }

    if (h.lane === -1) {
      if (e.button !== 0) return;
      this.drag = { mode: "loop", anchor: this._snapRound(h.step, unit), moved: false };
      return;
    }
    if (!h.rt) return;
    const track = h.rt.track;

    if (e.button === 2) {
      this.drag = { mode: "erase", trackId: track.id };
      this._eraseAt(h);
      return;
    }
    if (e.button !== 0) return;

    // Shift+click always drops a new clip — even on top of another (e.g. a fill over a long beat).
    let clip = e.shiftKey ? null : this._clipUnder(track.id, h.step);
    if (clip) {
      // Clicking a clip also picks its part for this lane.
      if (track.currentPartId !== clip.partId) {
        P.setCurrentPart(p, track.id, clip.partId);
        this._syncPicker(track);
        this.onPickPart(track.id);
      }
      if (this._onEdge(clip, h.x)) {
        this.drag = { mode: "resize", clip };
      } else {
        if (e.ctrlKey || e.metaKey) clip = P.addClip(p, clip.partId, clip.start, clip.length);
        this.drag = { mode: "move", clip, grab: h.step - clip.start };
      }
    } else {
      const start = this._snapFloor(h.step, unit);
      clip = P.addClip(p, track.currentPartId, start);
      this.drag = { mode: "move", clip, grab: h.step - start };
    }
    this._edited();
  }

  _onMove(e) {
    if (!this.W) return;
    const P = this.P, p = this.project;
    const h = this._hit(e);
    const d = this.drag;
    const unit = this._unit(e);
    this._shift = e.shiftKey;
    if (!d) { this._updateCursor(h); this._updateHover(h, unit, e.shiftKey); return; }

    // Auto-scroll while dragging near the edges.
    if (d.mode !== "erase") {
      if (h.x > this.W - 30) this._scrollTo(this.scrollX + 4 * this.pps);
      else if (h.x < 20) this._scrollTo(this.scrollX - 4 * this.pps);
    }

    if (d.mode === "loop") {
      const cur = this._snapRound(h.step, unit);
      if (cur === d.anchor && !d.moved) return;
      d.moved = true;
      P.setLoop(p, d.anchor, cur);
      this._edited();
    } else if (d.mode === "erase") {
      this._eraseAt(h);
    } else if (d.mode === "move") {
      const start = Math.max(0, this._snapRound(h.step - d.grab, unit));
      if (start !== d.clip.start) {
        d.clip.start = start;
        this._edited();
      }
    } else if (d.mode === "resize") {
      // The clip's END snaps to the grid (so an off-grid clip can still end on a bar line).
      const end = this._snapRound(h.step, unit);
      const len = Math.max(end - d.clip.start, Math.min(unit, P.clipLength(p, d.clip)), 1);
      if (len !== P.clipLength(p, d.clip)) {
        P.setClipLength(p, d.clip, len);
        this._edited();
      }
    }
  }

  _onUp() {
    const d = this.drag;
    this.drag = null;
    if (d && d.mode === "loop" && !d.moved) this.P.clearLoop(this.project);
    if (d) this._edited();
  }

  _onDblClick(e) {
    const h = this._hit(e);
    if (!h.rt) return;
    const clip = this._clipUnder(h.rt.track.id, h.step);
    if (clip) this.onOpenPart(clip.trackId, clip.partId);
  }

  _onWheel(e) {
    if (e.ctrlKey) {
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      this.zoom(e.deltaY < 0 ? 1 : -1, e.clientX - r.left);
      return;
    }
    const dx = e.shiftKey ? e.deltaY : e.deltaX;
    if (!dx || (!e.shiftKey && Math.abs(e.deltaX) < Math.abs(e.deltaY))) return;
    e.preventDefault();
    this._scrollTo(this.scrollX + dx);
    this.draw();
  }

  _eraseAt(h) {
    if (!h.rt || h.rt.track.id !== this.drag.trackId) return;
    const clip = this._clipUnder(h.rt.track.id, h.step);
    if (!clip) return;
    this.P.removeClip(this.project, clip);
    this._edited();
  }

  _edited() {
    this._layout();
    this.draw();
    this._renderStatus();
  }

  /** Ghost outline of the clip a click would drop (empty spot, or anywhere with Shift). */
  _updateHover(h, unit, shift) {
    let next = null;
    if (h.rt && (shift || !this._clipUnder(h.rt.track.id, h.step))) {
      const part = this.P.currentPart(this.project, h.rt.track);
      if (part) {
        next = {
          lane: h.lane,
          start: this._snapFloor(h.step, unit),
          len: this.P.partLength(part),
          color: SoundPad.partColor(this.project, part.id),
          name: part.name,
        };
      }
    }
    const same = (a, b) => a === b || (a && b && a.lane === b.lane && a.start === b.start && a.len === b.len && a.name === b.name);
    if (!same(next, this.hover)) {
      this.hover = next;
      this.draw();
    }
  }

  _updateCursor(h) {
    let cursor = "default";
    if (h.lane === -1) cursor = "pointer";
    else if (h.rt) {
      const clip = this._clipUnder(h.rt.track.id, h.step);
      cursor = clip && !this._shift ? (this._onEdge(clip, h.x) ? "ew-resize" : "grab") : "copy";
    }
    this.canvas.style.cursor = cursor;
  }

  // --- Playhead ------------------------------------------------------

  setPlayhead(step) {
    if (step === this.playStep) return;
    this.playStep = step;
    // Follow the playhead when it leaves the view (not while dragging).
    if (step >= 0 && this.W && !this.drag) {
      const x = this._x(step);
      if (x > this.W - 20 || x < 0) this._scrollTo(step * this.pps - 40);
    }
    this.draw();
  }

  clearPlayhead() {
    this.setPlayhead(-1);
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
    this.root.innerHTML = "";
  }
};
