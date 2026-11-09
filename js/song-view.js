/* ------------------------------------------------------------------
 * Sound Pad — Song view (the timeline)
 * One lane per track, one column per slot (each slot = one part long).
 *
 *   lane picker      → which part you paint with (also the part open in
 *                       that track's editor)
 *   click / drag     → place that part in slots
 *   right-click/drag → empty slots
 *   ✎ in a cell      → open that part in its editor
 *   slot numbers     → click / drag to select slots; the selection loops,
 *                       and Duplicate / Insert / Delete act on it
 *   M / S            → mute / solo the track
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.PART_COLORS = ["#ffb454", "#4dd0a7", "#4da3ff", "#c38bff", "#ff7a90", "#e6d35a", "#5ee0e0", "#ff9f5a"];

SoundPad.SongView = class SongView {
  /**
   * @param {object} o
   * @param {HTMLElement} o.root
   * @param {object} o.project
   * @param {Array} o.tracks   [{ track, instrument }] in lane order
   * @param {function} o.onOpenPart(trackId, partId)
   * @param {function} o.onPickPart(trackId)  lane picker changed the current part
   */
  constructor({ root, project, tracks, onOpenPart, onPickPart }) {
    this.root = root;
    this.project = project;
    this.tracks = tracks;
    this.onOpenPart = onOpenPart || (() => {});
    this.onPickPart = onPickPart || (() => {});
    this.paint = null;        // { trackId, value } while dragging in a lane
    this.rulerDrag = null;    // { from, prevLoop, moved } while dragging on the ruler
    this.nowSlot = -1;
    this._onMouseUp = () => this._endDrags();
    document.addEventListener("mouseup", this._onMouseUp);
  }

  get P() { return SoundPad.Project; }
  get tl() { return this.project.timeline; }

  build() {
    this.root.innerHTML = `
      <section class="song">
        <div class="song-head">
          <h2>Song</h2>
          <span class="song-sel" data-role="sel"></span>
          <div class="song-tools">
            <button class="tbtn small" data-act="dup" title="Copy the selected slots and insert the copy after them">Duplicate</button>
            <button class="tbtn small" data-act="ins" title="Insert an empty slot before the selection">Insert empty</button>
            <button class="tbtn small danger" data-act="del" title="Remove the selected slots">Delete slots</button>
            <button class="tbtn small" data-act="unloop" title="Select nothing: play the whole song">Clear selection</button>
            <button class="tbtn small" data-act="add" title="Add an empty slot at the end">+ Slot</button>
          </div>
        </div>
        <p class="song-hint">Pick a part in a lane, then click or drag across slots to place it · right-click to empty a slot · ✎ opens the part · click or drag the slot numbers to select &amp; loop them</p>
        <div class="tl-scroll"><div class="tl-body" data-role="body"></div></div>
      </section>`;
    this.bodyEl = this.root.querySelector('[data-role="body"]');
    this.selEl = this.root.querySelector('[data-role="sel"]');
    this.tools = {};
    this.root.querySelectorAll("[data-act]").forEach((b) => {
      this.tools[b.dataset.act] = b;
      b.addEventListener("click", () => this._tool(b.dataset.act));
    });
    this.render();
  }

  // --- Rendering -----------------------------------------------------

  render() {
    const tl = this.tl;
    this.bodyEl.innerHTML = "";
    this.bodyEl.style.setProperty("--slots", tl.slots);
    this.rulerCells = [];
    this.cellEls = {};   // trackId -> [cell]

    // Ruler: slot numbers + bar ranges.
    const ruler = this._row("tl-row tl-ruler");
    ruler.label.innerHTML = `<span class="tl-ruler-title">Slots</span>`;
    const barsPerSlot = this.project.partSteps / 16;
    for (let i = 0; i < tl.slots; i++) {
      const c = document.createElement("div");
      c.className = "tl-slot";
      const firstBar = i * barsPerSlot + 1;
      const lastBar = firstBar + barsPerSlot - 1;
      c.innerHTML = `<b>${i + 1}</b><span>${barsPerSlot === 1 ? `bar ${firstBar}` : `bars ${firstBar}–${lastBar}`}</span>`;
      c.addEventListener("mousedown", (e) => this._rulerDown(e, i));
      c.addEventListener("mouseenter", () => this._rulerEnter(i));
      ruler.cells.appendChild(c);
      this.rulerCells.push(c);
    }

    // One lane per track.
    this.tracks.forEach(({ track, instrument }) => {
      const lane = this._row("tl-row tl-lane");
      lane.row.dataset.track = track.id;
      lane.label.appendChild(this._laneLabel(track));
      this.cellEls[track.id] = [];
      for (let i = 0; i < tl.slots; i++) {
        const c = document.createElement("div");
        c.className = "tl-cell";
        c.addEventListener("mousedown", (e) => this._cellDown(e, track.id, i));
        c.addEventListener("mouseenter", () => this._cellEnter(track.id, i));
        c.addEventListener("contextmenu", (e) => e.preventDefault());
        lane.cells.appendChild(c);
        this.cellEls[track.id].push(c);
        this._renderCell(track, instrument, i);
      }
    });

    this.playheadEl = document.createElement("div");
    this.playheadEl.className = "tl-playhead";
    this.bodyEl.appendChild(this.playheadEl);

    this._renderLaneStates();
    this._renderRuler();
    this.nowSlot = -1;
  }

  _row(cls) {
    const row = document.createElement("div");
    row.className = cls;
    const label = document.createElement("div");
    label.className = "tl-label";
    const cells = document.createElement("div");
    cells.className = "tl-cells";
    row.append(label, cells);
    this.bodyEl.appendChild(row);
    return { row, label, cells };
  }

  _laneLabel(track) {
    const wrap = document.createElement("div");
    wrap.className = "tl-lane-head";

    const name = document.createElement("div");
    name.className = "tl-track-name";
    name.textContent = track.name;

    const pick = document.createElement("select");
    pick.className = "tl-pick";
    pick.title = "Part to place with a click";
    this.P.partsOf(this.project, track.id).forEach((part, idx) => {
      const opt = document.createElement("option");
      opt.value = part.id;
      opt.textContent = part.name;
      opt.style.color = SoundPad.PART_COLORS[idx % SoundPad.PART_COLORS.length];
      pick.appendChild(opt);
    });
    pick.value = track.currentPartId;
    pick.addEventListener("change", () => {
      this.P.setCurrentPart(this.project, track.id, pick.value);
      this._paintPickSwatch(pick, track);
      this.onPickPart(track.id);
    });
    this._paintPickSwatch(pick, track);

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
    wrap.append(name, ctrls);
    return wrap;
  }

  _paintPickSwatch(pick, track) {
    pick.style.borderColor = this._partColor(track.currentPartId);
  }

  _partColor(partId) {
    const part = this.P.part(this.project, partId);
    if (!part) return "transparent";
    const idx = this.P.partsOf(this.project, part.trackId).indexOf(part);
    return SoundPad.PART_COLORS[idx % SoundPad.PART_COLORS.length];
  }

  _renderCell(track, instrument, slot) {
    const cell = this.cellEls[track.id][slot];
    const partId = this.tl.cells[track.id][slot];
    const part = partId && this.P.part(this.project, partId);
    cell.innerHTML = "";
    cell.classList.toggle("filled", !!part);
    cell.style.removeProperty("--c");
    if (!part) return;

    cell.style.setProperty("--c", this._partColor(part.id));
    const name = document.createElement("span");
    name.className = "tl-part-name";
    name.textContent = part.name;

    const edit = document.createElement("button");
    edit.className = "tl-edit";
    edit.textContent = "✎";
    edit.title = `Open "${part.name}" in the ${track.name} editor`;
    edit.addEventListener("mousedown", (e) => e.stopPropagation());
    edit.addEventListener("click", (e) => { e.stopPropagation(); this.onOpenPart(track.id, part.id); });

    const preview = document.createElement("canvas");
    preview.className = "tl-preview";
    preview.width = 120;
    preview.height = 26;
    this._drawPreview(preview, part, instrument);

    cell.append(name, edit, preview);
  }

  /** Tiny picture of the part's notes so cells are recognisable at a glance. */
  _drawPreview(canvas, part, instrument) {
    const g = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height, steps = this.project.partSteps;
    g.clearRect(0, 0, W, H);
    g.fillStyle = "rgba(255,255,255,0.85)";
    if (!part.notes.length) return;

    if (instrument.drums) {
      const order = instrument.drums.map((d) => d.id);
      const rowH = H / order.length;
      part.notes.forEach((n) => {
        const r = order.indexOf(n.key);
        if (r < 0) return;
        g.fillRect((n.step / steps) * W, r * rowH, Math.max(1.5, (W / steps) * 0.7), Math.max(1.5, rowH * 0.9));
      });
    } else {
      const keys = part.notes.map((n) => n.key);
      let lo = Math.min(...keys), hi = Math.max(...keys);
      if (hi - lo < 6) { const mid = (hi + lo) / 2; lo = mid - 3; hi = mid + 3; }
      const span = hi - lo + 1;
      const rowH = H / span;
      part.notes.forEach((n) => {
        g.fillRect((n.step / steps) * W, (hi - n.key) * rowH, Math.max(1.5, (n.len / steps) * W - 0.5), Math.max(1.5, rowH));
      });
    }
  }

  _renderLaneStates() {
    const anySolo = this.project.tracks.some((t) => t.solo);
    this.tracks.forEach(({ track }) => {
      const row = this.bodyEl.querySelector(`.tl-lane[data-track="${track.id}"]`);
      if (!row) return;
      row.querySelector(".ms.mute").classList.toggle("on", track.mute);
      row.querySelector(".ms.solo").classList.toggle("on", track.solo);
      row.classList.toggle("silent", track.mute || (anySolo && !track.solo));
    });
  }

  /** Ruler highlights: selection/loop, and which slots the song actually plays. */
  _renderRuler() {
    const tl = this.tl;
    const loop = tl.loop;
    const range = this.P.songRange(this.project);
    this.rulerCells.forEach((c, i) => {
      const inLoop = !!loop && i >= loop.start && i < loop.end;
      c.classList.toggle("in-loop", inLoop);
      c.classList.toggle("loop-first", inLoop && i === loop.start);
      c.classList.toggle("loop-last", inLoop && i === loop.end - 1);
      c.classList.toggle("unplayed", i < range.start || i >= range.end);
    });

    const one = (n) => `slot${n === 1 ? "" : "s"}`;
    if (loop) {
      const n = loop.end - loop.start;
      this.selEl.textContent = n === 1
        ? `Looping slot ${loop.start + 1}`
        : `Looping slots ${loop.start + 1}–${loop.end}`;
    } else {
      const end = this.P.songEnd(this.project);
      this.selEl.textContent = end
        ? `Playing the whole song · ${end} ${one(end)}`
        : "Empty song — place some parts";
    }
    const t = this.tools;
    t.dup.disabled = !loop || tl.slots + (loop.end - loop.start) > this.P.MAX_SLOTS;
    t.ins.disabled = !loop || tl.slots >= this.P.MAX_SLOTS;
    t.del.disabled = !loop || tl.slots - (loop.end - loop.start) < 1;
    t.unloop.disabled = !loop;
    t.add.disabled = tl.slots >= this.P.MAX_SLOTS;
  }

  // --- Lane painting -------------------------------------------------

  _cellDown(e, trackId, slot) {
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    const track = this.P.track(this.project, trackId);
    const value = e.button === 2 ? null : track.currentPartId;
    this.paint = { trackId, value };
    this._setCell(trackId, slot, value);
  }

  _cellEnter(trackId, slot) {
    if (this.paint && this.paint.trackId === trackId) this._setCell(trackId, slot, this.paint.value);
  }

  _setCell(trackId, slot, value) {
    if (!this.P.setCell(this.project, trackId, slot, value)) return;
    const rt = this.tracks.find((x) => x.track.id === trackId);
    this._renderCell(rt.track, rt.instrument, slot);
    this._renderRuler();
  }

  // --- Ruler selection -----------------------------------------------

  _rulerDown(e, i) {
    if (e.button !== 0) return;
    e.preventDefault();
    const prev = this.tl.loop;
    this.rulerDrag = { from: i, prevLoop: prev && { ...prev }, moved: false };
    this.P.setLoop(this.project, i, i + 1);
    this._renderRuler();
  }

  _rulerEnter(i) {
    const d = this.rulerDrag;
    if (!d) return;
    d.moved = d.moved || i !== d.from;
    this.P.setLoop(this.project, Math.min(d.from, i), Math.max(d.from, i) + 1);
    this._renderRuler();
  }

  _endDrags() {
    const d = this.rulerDrag;
    // Clicking the single selected slot again clears the selection.
    if (d && !d.moved && d.prevLoop && d.prevLoop.start === d.from && d.prevLoop.end === d.from + 1) {
      this.P.clearLoop(this.project);
      this._renderRuler();
    }
    this.rulerDrag = null;
    this.paint = null;
  }

  // --- Toolbar -------------------------------------------------------

  _tool(act) {
    const P = this.P, p = this.project, loop = this.tl.loop;
    if (act === "add") P.addSlot(p);
    else if (act === "unloop") P.clearLoop(p);
    else if (!loop) return;
    else if (act === "dup") P.duplicateSlots(p, loop.start, loop.end);
    else if (act === "ins") P.insertSlots(p, loop.start, 1);
    else if (act === "del") P.deleteSlots(p, loop.start, loop.end);
    this.render();
  }

  // --- Playhead ------------------------------------------------------

  setPlayhead(slot, frac) {
    const ref = this.rulerCells[slot];
    if (!ref) { this.clearPlayhead(); return; }
    this.playheadEl.style.display = "block";
    this.playheadEl.style.left = ref.offsetLeft + frac * ref.offsetWidth + "px";
    if (slot !== this.nowSlot) {
      if (this.rulerCells[this.nowSlot]) this.rulerCells[this.nowSlot].classList.remove("now");
      ref.classList.add("now");
      this.nowSlot = slot;
    }
  }

  clearPlayhead() {
    if (this.playheadEl) this.playheadEl.style.display = "none";
    if (this.rulerCells && this.rulerCells[this.nowSlot]) this.rulerCells[this.nowSlot].classList.remove("now");
    this.nowSlot = -1;
  }

  destroy() {
    document.removeEventListener("mouseup", this._onMouseUp);
    this.root.innerHTML = "";
  }
};
