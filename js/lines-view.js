/* ------------------------------------------------------------------
 * Sound Pad — Lines view (the editor of a Lines project)
 * Every instrument is one line on a shared timeline (same bars, zoom and
 * horizontal scroll for all), and every line is editable in place:
 *   • pitched instruments: a compact piano roll (scroll inside the line
 *     for more pitches — wheel over it, or its thin scrollbar)
 *   • drums: one row per drum
 *
 * Mouse in a line:
 *   click empty space   → add a note (last used length); drag to set length
 *                         (drums: click toggles a hit, drag paints)
 *   drag a note         → move it (time and pitch)
 *   drag a note's end   → resize it
 *   right-click / drag  → delete notes
 *   click a row label   → hear that pitch / drum (drums: also shows it in the velocity strip)
 * Clicking a line selects it: the computer keyboard and recording go to it,
 * the velocity strip pinned under the lines edits it, and its Sound
 * controls show below.
 * A line's −/+ buttons make it shorter / taller (smallest = a one-row overview).
 *
 * Select / copy / paste (inside one line):
 *   Ctrl + drag          → select the notes in a box (Shift + Ctrl + drag adds) · Ctrl + click = one note
 *   Shift + click a note → add it to / take it out of the selection · Ctrl + A = whole line
 *   drag a selected note → move the whole selection (time and pitch)
 *   Ctrl + C / X / V / D → copy / cut / paste / duplicate · Delete → delete · Esc → deselect
 *   Paste goes right after the selected block (the box you drew, silence included —
 *   or the notes rounded out to beats), so pressing Ctrl + V again keeps extending
 *   it. The pasted notes become the selection. Select another line of the same kind
 *   to paste there (same position in time).
 *
 * Loop (play only a part, over and over):
 *   drag on the ruler          → draw a loop (and switch looping on)
 *   drag its edge handles      → move its start / end · drag its middle → slide it
 *   from / to fields           → type the positions ("3", "3.2", "3.2.4")
 *   ⟲ Loop button / L key      → looping on / off (the region is kept while off)
 * Snap: beats when zoomed in, bars when far out; hold Alt for single steps.
 * Shift + wheel / scrollbar → scroll · Fit = whole song.
 * Zoom ↔ (Ctrl + wheel): 3…96 px per step · Zoom ↕ (Alt + wheel): 12…32 px per
 * pitch row — zoomed in, note names show inside the notes.
 *
 * The view edits the project only; the Player reads the lines live.
 * View settings (zoom, scroll, selected line…) live in LinesView.prefs, so
 * they survive the rebuild that happens when a line is added or deleted.
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.LinesView = class LinesView {
  /**
   * @param {object} o
   * @param {HTMLElement} o.root
   * @param {object} o.project        a Lines project
   * @param {Array} o.tracks          [{ track, channel, instrument }] in line order (shared with the app)
   * @param {object} o.engine
   * @param {object} o.player
   * @param {function} o.preview(rt)  play a short sample of a line's sound
   * @param {function} o.onAddLine()  open the "add line" menu
   * @param {function} o.onDeleteLine(id)
   */
  constructor({ root, project, tracks, engine, player, preview, onAddLine, onDeleteLine }) {
    this.root = root;
    this.project = project;
    this.tracks = tracks;
    this.engine = engine;
    this.player = player;
    this.preview = preview || (() => {});
    this.onAddLine = onAddLine || (() => {});
    this.onDeleteLine = onDeleteLine || (() => {});
    this.recordArmed = false;

    this.RULER_H = 28;
    this.LABEL_W = 62;                                   // row labels (pitches / drum names) inside each line
    this.ROWS = { s: 9, m: 15, l: 27 };                  // visible rows per line size
    this.MIN_H = 30;                                     // "min" = a one-row overview
    this.ZOOMS = [3, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96];   // horizontal: pixels per step
    this.ROW_ZOOMS = [12, 14, 16, 20, 24, 28, 32];                            // vertical: pixels per pitch row
    this.keyMap = [
      ["z", 0], ["s", 1], ["x", 2], ["d", 3], ["c", 4], ["v", 5],
      ["g", 6], ["b", 7], ["h", 8], ["n", 9], ["j", 10], ["m", 11], [",", 12],
    ];

    const pr = SoundPad.LinesView.prefs;
    const z = this.ZOOMS.indexOf(pr.zoom);
    this.zoomIdx = z >= 0 ? z : this.ZOOMS.indexOf(12);
    const rz = this.ROW_ZOOMS.indexOf(pr.rowZoom);
    this.rowZoomIdx = rz >= 0 ? rz : 0;
    this.scrollX = pr.scrollX || 0;
    this.selectedId = this.tracks.some((rt) => rt.track.id === pr.selected) ? pr.selected : this.tracks[0]?.track.id;

    this.W = 0;
    this.rows = [];          // per line: { rt, el, canvas, g, vbar, vbarInner, keys, rowH, scrollY, base, velKey, … }
    this.playStep = -1;
    this.lastLen = 1;        // new notes use the length you last drew / resized
    this.drag = null;
    this.vel = null;
    this._lastLength = SoundPad.Lines.length(project);
    // Selected notes: always inside ONE line. `region` = the block they stand for (what Copy copies,
    // silence included), in steps — from the box you drew, or rounded out to beats around the notes.
    this.sel = { trackId: null, notes: new Set(), region: null };
  }

  /** Copied notes (kept across rebuilds of the view, e.g. after adding a line). */
  get clipboard() { return SoundPad.LinesView.prefs.clipboard; }
  set clipboard(v) { SoundPad.LinesView.prefs.clipboard = v; }

  get P() { return SoundPad.Project; }
  get L() { return SoundPad.Lines; }
  get pps() { return this.ZOOMS[this.zoomIdx]; }
  get selectedRow() { return this.rows.find((r) => r.rt.track.id === this.selectedId) || null; }

  /** Row height for the current vertical zoom (drum rows a bit taller: there are few of them). */
  _rowH(drums) {
    return this.ROW_ZOOMS[this.rowZoomIdx] + (drums ? 2 : 0);
  }

  _savePrefs() {
    const pr = SoundPad.LinesView.prefs;
    pr.zoom = this.pps;
    pr.rowZoom = this.ROW_ZOOMS[this.rowZoomIdx];
    pr.scrollX = this.scrollX;
    pr.selected = this.selectedId;
    try { localStorage.setItem("soundpad.linesView", JSON.stringify({ zoom: pr.zoom, rowZoom: pr.rowZoom })); } catch { /* storage blocked */ }
  }

  // --- Build ---------------------------------------------------------

  build() {
    this.root.innerHTML = `
      <section class="lines">
        <div class="song-head">
          <h2>Lines</h2>
          <span class="song-sel" data-role="status"></span>
          <div class="song-tools">
            <button class="tbtn small" data-act="add" title="Add an instrument line">+ Add line</button>
            <div class="zoom" title="Horizontal zoom — wider steps (Ctrl + wheel)">
              <span class="zoom-label">↔</span>
              <button class="tbtn small" data-act="zoomOut">−</button>
              <span class="zoom-val" data-role="zoomVal"></span>
              <button class="tbtn small" data-act="zoomIn">+</button>
            </div>
            <div class="zoom" title="Vertical zoom — taller note rows (Alt + wheel)">
              <span class="zoom-label">↕</span>
              <button class="tbtn small" data-act="rowsOut">−</button>
              <span class="zoom-val" data-role="rowVal"></span>
              <button class="tbtn small" data-act="rowsIn">+</button>
            </div>
            <button class="tbtn small" data-act="fit" title="Zoom to show the whole song">Fit song</button>
            <div class="loop-ctrl" title="Loop a part of the song: playback repeats from → to. Drag on the ruler to draw it, its edges to resize, its middle to move it.">
              <button class="tbtn small loop-toggle" data-act="loop" title="Loop on / off (L) — the region is kept while off">⟲ Loop</button>
              <label>from <input class="loop-in" data-role="loopFrom" placeholder="1" spellcheck="false" title="Where the loop starts: bar, or bar.beat (3.2), or bar.beat.step"></label>
              <label>to <input class="loop-in" data-role="loopTo" placeholder="—" spellcheck="false" title="Where the loop ends (it plays up to here): bar, bar.beat or bar.beat.step — e.g. 5 = the start of bar 5"></label>
              <span class="loop-len" data-role="loopLen"></span>
            </div>
          </div>
        </div>
        <p class="song-hint">Every instrument is one line, all on the same timeline — write each melody right where it plays ·
          click to add a note, drag to set its length · drag a note to move it, its end to resize · right-click to delete ·
          click a line to play it with the keyboard (and record into it) · loop a part: drag on the ruler (or type from / to), drag its edges to adjust, L = loop on/off</p>
        <div class="ln-editbar">
          <span class="ln-eb-label">Selection</span>
          <span class="ln-sel-info" data-role="selInfo"></span>
          <div class="ln-eb-btns">
            <button class="tbtn small" data-act="selAll" title="Select every note of the selected line (Ctrl + A)">Select all</button>
            <button class="tbtn small" data-act="copy" title="Copy the selected notes (Ctrl + C)">Copy</button>
            <button class="tbtn small" data-act="cut" title="Copy and remove them (Ctrl + X)">Cut</button>
            <button class="tbtn small" data-act="paste" title="Paste right after the selection / the last paste (Ctrl + V) — press again to keep going">Paste</button>
            <button class="tbtn small" data-act="dup" title="Copy + paste right after it, in one go (Ctrl + D)">Duplicate</button>
            <button class="tbtn small danger" data-act="del" title="Delete the selected notes (Delete)">Delete</button>
          </div>
          <span class="ln-clip-info" data-role="clipInfo"></span>
        </div>
        <div class="ln-stack" data-role="stack">
          <div class="ln-grid ln-ruler-row">
            <div class="ln-gutter">Bars</div>
            <div class="ln-cell" data-role="rulerCell"><canvas class="ln-ruler" data-role="ruler"></canvas></div>
            <div></div>
          </div>
          <div class="ln-rows" data-role="rows"></div>
          <div class="ln-bottom">
            <div class="ln-grid ln-vel-row" data-role="velRow">
              <div class="ln-vel-label">Velocity<b data-role="velName"></b></div>
              <div class="ln-cell"><canvas class="vel-lane" data-role="vel"></canvas></div>
              <div></div>
            </div>
            <div class="ln-grid ln-hbar-row">
              <div></div>
              <div class="ln-cell"><div class="hbar" data-role="hbar"><div data-role="hbarInner"></div></div></div>
              <div></div>
            </div>
          </div>
          <div class="ln-playhead hidden" data-role="playhead"></div>
        </div>
        <section class="ln-detail" data-role="detail"></section>
      </section>`;
    const q = (r) => this.root.querySelector(`[data-role="${r}"]`);
    this.statusEl = q("status");
    this.stackEl = q("stack");
    this.rowsEl = q("rows");
    this.rulerCell = q("rulerCell");
    this.ruler = q("ruler");
    this.rg = this.ruler.getContext("2d");
    this.hbar = q("hbar");
    this.hbarInner = q("hbarInner");
    this.playheadEl = q("playhead");
    this.detailEl = q("detail");

    // One velocity strip, pinned under the lines: it always edits the selected line
    // (a drum line: the drum last clicked). It never moves, so selecting a line
    // doesn't shift the layout under the mouse.
    this.velRow = q("velRow");
    this.velNameEl = q("velName");
    this.vel = new SoundPad.VelocityLane(q("vel"), {
      steps: () => this.contentSteps || this.L.BAR,
      getNotes: () => {
        const row = this.selectedRow;
        if (!row) return [];
        const notes = row.rt.track.notes;
        return row.drums ? notes.filter((n) => n.key === row.velKey) : notes;
      },
      columnRect: (s) => ({ x: this.LABEL_W + s * this.pps - this.scrollX, w: this.pps }),
      clipLeft: this.LABEL_W,
      onChange: () => { const row = this.selectedRow; if (row) this._drawRow(row); },
    });
    this.vel.H = 44;

    const act = (name, fn) => this.root.querySelector(`[data-act="${name}"]`).addEventListener("click", fn);
    act("add", (e) => { e.stopPropagation(); this.onAddLine(); });
    act("zoomIn", () => this.zoom(1));
    act("zoomOut", () => this.zoom(-1));
    act("rowsIn", () => this.zoomRows(1));
    act("rowsOut", () => this.zoomRows(-1));
    act("selAll", () => this.selectAll());
    act("copy", () => this.copy());
    act("cut", () => this.cut());
    act("paste", () => this.paste());
    act("dup", () => this.duplicate());
    act("del", () => this.deleteSelection());
    this.selInfoEl = q("selInfo");
    this.clipInfoEl = q("clipInfo");
    this.zoomValEl = q("zoomVal");
    this.rowValEl = q("rowVal");
    this._renderZoom();
    act("fit", () => this.fitSong());
    // Loop: on/off + typed start / end.
    this.loopBtn = this.root.querySelector('[data-act="loop"]');
    this.loopBtn.addEventListener("click", () => this.toggleLoop());
    this.loopFrom = q("loopFrom");
    this.loopTo = q("loopTo");
    this.loopLenEl = q("loopLen");
    [this.loopFrom, this.loopTo].forEach((input) => {
      input.addEventListener("change", () => this._typedLoop());
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") input.blur();          // blur → change
        if (e.key === "Escape") { this._renderLoop(); input.blur(); }
      });
    });

    const r = this.ruler;
    r.addEventListener("pointerdown", (e) => this._rulerDown(e));
    r.addEventListener("pointermove", (e) => this._rulerMove(e));
    r.addEventListener("pointerup", () => this._rulerUp());
    r.addEventListener("pointercancel", () => this._rulerUp());
    r.addEventListener("wheel", (e) => this._onWheel(e, null), { passive: false });
    this.hbar.addEventListener("scroll", () => {
      this.scrollX = this.hbar.scrollLeft;
      SoundPad.LinesView.prefs.scrollX = this.scrollX;
      this._drawAll();
    });

    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this.rulerCell);
    this.render();
  }

  /** Full refresh (when the tab is shown, or after lines changed). */
  render() {
    this._buildRows();
    this._renderDetail();
    this._resize();
    this._renderStatus();
  }

  // --- Rows ----------------------------------------------------------

  _lineColor(i) {
    return SoundPad.PART_COLORS[i % SoundPad.PART_COLORS.length];
  }

  /** Rows of a line, top → bottom: drum ids, or MIDI numbers high → low. */
  _keysOf(rt) {
    if (rt.instrument.drums) return rt.instrument.drums.map((d) => d.id);
    const def = SoundPad.Instruments.get(rt.track.type);
    const o = def.editorOptions ? def.editorOptions(rt.track) : {};
    const low = o.low ?? 36, high = o.high ?? 72;
    const keys = [];
    for (let k = high; k >= low; k--) keys.push(k);
    return keys;
  }

  _defaultBase(rt) {
    const def = SoundPad.Instruments.get(rt.track.type);
    const o = def.editorOptions ? def.editorOptions(rt.track) : {};
    return o.base ?? 48;
  }

  _buildRows() {
    const pr = SoundPad.LinesView.prefs;
    this.rowsEl.innerHTML = "";
    if (!this.tracks.some((rt) => rt.track.id === this.selectedId)) this.selectedId = this.tracks[0]?.track.id;

    this.rows = this.tracks.map((rt, i) => {
      const track = rt.track;
      const drums = !!rt.instrument.drums;
      const keys = this._keysOf(rt);
      const row = {
        rt, drums, keys,
        color: this._lineColor(i),
        rowH: this._rowH(drums),
        scrollY: pr.scrollY[track.id] ?? null,
        base: pr.base[track.id] ?? this._defaultBase(rt),
        velKey: drums ? (pr.velKey[track.id] || keys[0]) : null,
      };
      this._clampBase(row);

      const el = document.createElement("div");
      el.className = "ln-grid ln-row";
      el.dataset.id = track.id;
      el.style.setProperty("--c", row.color);
      el.innerHTML = `
        <div class="ln-head">
          <div class="ln-head-top">
            <span class="ln-name" title="Double-click to rename"></span>
            <button class="ms mute" title="Mute">M</button>
            <button class="ms solo" title="Solo">S</button>
          </div>
          <select class="ln-preset" title="The line's sound — its notes stay as they are"></select>
          <div class="ln-tools">
            <button class="ms" data-t="up" title="Move the line up">↑</button>
            <button class="ms" data-t="down" title="Move the line down">↓</button>
            <button class="ms" data-t="smaller" title="Make the line shorter">−</button>
            <button class="ms" data-t="bigger" title="Make the line taller">+</button>
            <span class="ln-tools-gap"></span>
            <button class="ms del" data-t="delete" title="Delete this line">×</button>
          </div>
          <div class="ln-keys"></div>
        </div>
        <div class="ln-cell"><canvas class="ln-canvas"></canvas></div>
        <div class="ln-vbar"><div></div></div>`;
      row.el = el;
      row.canvas = el.querySelector(".ln-canvas");
      row.g = row.canvas.getContext("2d");
      row.vbar = el.querySelector(".ln-vbar");
      row.vbarInner = row.vbar.firstElementChild;
      row.keysEl = el.querySelector(".ln-keys");
      row.nameEl = el.querySelector(".ln-name");
      this._fillHead(row);
      this._wireRow(row);
      this.rowsEl.appendChild(el);
      return row;
    });
    this._applySizes();
    this._renderStates();
    this._updateVelocity();
  }

  _fillHead(row) {
    const track = row.rt.track;
    row.nameEl.textContent = track.name;
    const def = SoundPad.Instruments.get(track.type);
    const sel = row.el.querySelector(".ln-preset");
    sel.innerHTML = "";
    const groups = {};
    def.presets.forEach((pr) => {
      if (!groups[pr.category]) {
        groups[pr.category] = document.createElement("optgroup");
        groups[pr.category].label = pr.category;
        sel.appendChild(groups[pr.category]);
      }
      const opt = document.createElement("option");
      opt.value = pr.id;
      opt.textContent = pr.name;
      groups[pr.category].appendChild(opt);
    });
    sel.value = track.preset;
    row.el.querySelector('[data-t="delete"]').disabled = this.tracks.length <= 1;
    this._renderKeysHint(row);
  }

  _renderKeysHint(row) {
    if (row.drums) {
      row.keysEl.textContent = "Keys: the letter of each drum";
    } else {
      row.keysEl.textContent = `Keys Z…, = ${SoundPad.midiName(row.base)}–${SoundPad.midiName(row.base + 12)} · [ ] octave`;
    }
  }

  _wireRow(row) {
    const track = row.rt.track, el = row.el;
    const head = el.querySelector(".ln-head");
    head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, select")) return;
      this.select(track.id);
    });
    row.nameEl.addEventListener("dblclick", () => this._rename(row));
    el.querySelector(".ms.mute").addEventListener("click", () => { track.mute = !track.mute; this._renderStates(); });
    el.querySelector(".ms.solo").addEventListener("click", () => { track.solo = !track.solo; this._renderStates(); });
    el.querySelector(".ln-preset").addEventListener("change", (e) => this._changePreset(row, e.target.value));
    el.querySelector('[data-t="up"]').addEventListener("click", () => this._move(row, -1));
    el.querySelector('[data-t="down"]').addEventListener("click", () => this._move(row, 1));
    el.querySelector('[data-t="smaller"]').addEventListener("click", () => this._grow(row, -1));
    el.querySelector('[data-t="bigger"]').addEventListener("click", () => this._grow(row, 1));
    el.querySelector('[data-t="delete"]').addEventListener("click", () => this._delete(row));

    const c = row.canvas;
    c.addEventListener("pointerdown", (e) => this._onDown(e, row));
    c.addEventListener("pointermove", (e) => this._onMove(e, row));
    c.addEventListener("pointerup", () => this._onUp(row));
    c.addEventListener("pointercancel", () => this._onUp(row));
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("wheel", (e) => this._onWheel(e, row), { passive: false });
    row.vbar.addEventListener("scroll", () => {
      row.scrollY = row.vbar.scrollTop;
      SoundPad.LinesView.prefs.scrollY[track.id] = row.scrollY;
      this._drawRow(row);
    });
  }

  /** Each line's height from its size; a pitched line opens around its notes (or its keyboard octave). */
  _applySizes() {
    this.rows.forEach((row) => {
      const size = row.rt.track.size;
      row.el.classList.toggle("min", size === "min");
      if (size === "min") {
        row.visRows = 0;
        row.h = this.MIN_H;
      } else {
        row.visRows = Math.min(row.keys.length, this.ROWS[size] || this.ROWS.m);
        row.h = row.visRows * row.rowH;
      }
      row.vbar.style.height = row.h + "px";
      row.vbarInner.style.height = (size === "min" ? row.h : row.keys.length * row.rowH) + "px";
      row.vbar.classList.toggle("idle", size === "min" || row.visRows >= row.keys.length);
      const maxY = Math.max(0, row.keys.length * row.rowH - row.h);
      if (row.scrollY === null) row.scrollY = this._initialScrollY(row);
      row.scrollY = Math.min(maxY, Math.max(0, row.scrollY));
      row.vbar.scrollTop = row.scrollY;
      row.el.querySelector('[data-t="smaller"]').disabled = size === "min";
      row.el.querySelector('[data-t="bigger"]').disabled = size === "l";
    });
  }

  _initialScrollY(row) {
    if (row.drums) return 0;
    const notes = row.rt.track.notes;
    let mid;
    if (notes.length) {
      const keys = notes.map((n) => n.key);
      mid = (Math.min(...keys) + Math.max(...keys)) / 2;
    } else {
      mid = row.base + 6;
    }
    const idx = row.keys[0] - mid;                 // row index of the middle key
    return Math.round(idx * row.rowH - row.h / 2);
  }

  _clampBase(row) {
    if (row.drums) return;
    const low = row.keys[row.keys.length - 1], high = row.keys[0];
    row.base = Math.min(high - 12, Math.max(low, row.base));
  }

  _renderStates() {
    const anySolo = this.project.tracks.some((t) => t.solo);
    this.rows.forEach((row) => {
      const t = row.rt.track;
      row.el.querySelector(".ms.mute").classList.toggle("on", t.mute);
      row.el.querySelector(".ms.solo").classList.toggle("on", t.solo);
      row.silent = t.mute || (anySolo && !t.solo);
      row.el.classList.toggle("silent", row.silent);
      row.el.classList.toggle("selected", t.id === this.selectedId);
      this._drawRow(row);
    });
  }

  // --- Line actions --------------------------------------------------

  select(id) {
    if (id === this.selectedId) return;
    if (this.sel.trackId && this.sel.trackId !== id) this.clearSelection();   // a selection lives in one line
    this.selectedId = id;
    this._savePrefs();
    this.rows.forEach((row) => {
      row.el.classList.toggle("selected", row.rt.track.id === id);
      if (row.drums) this._drawRow(row);        // its velocity-drum label is highlighted only when selected
    });
    this._updateVelocity();
    this._renderDetail();
  }

  _rename(row) {
    const name = prompt("Rename line", row.rt.track.name);
    if (name === null) return;
    this.P.renameTrack(this.project, row.rt.track.id, name);
    row.nameEl.textContent = row.rt.track.name;
    this._renderDetail();
  }

  _changePreset(row, preset) {
    const rt = row.rt;
    this.P.setTrackPreset(this.project, rt.track.id, preset);    // also resets the line's tweaks
    rt.instrument.setPreset(preset);
    if (!row.drums) {
      row.base = this._defaultBase(rt);
      this._clampBase(row);
      this._renderKeysHint(row);
    }
    if (rt.track.id === this.selectedId) this._renderDetail();
    this.preview(rt);
  }

  _move(row, dir) {
    const id = row.rt.track.id;
    if (!this.L.moveLine(this.project, id, dir)) return;
    // Keep the shared runtime list (Mixer, Player) in the project's order.
    const order = this.project.tracks.map((t) => t.id);
    this.tracks.sort((a, b) => order.indexOf(a.track.id) - order.indexOf(b.track.id));
    this.render();
  }

  _grow(row, dir) {
    const sizes = this.L.SIZES;
    const t = row.rt.track;
    const next = sizes[Math.min(sizes.length - 1, Math.max(0, sizes.indexOf(t.size) + dir))];
    if (next === t.size) return;
    this.L.setSize(t, next);
    this._applySizes();
    this._resize();
  }

  _delete(row) {
    const t = row.rt.track;
    if (this.tracks.length <= 1) return;
    if (t.notes.length && !confirm(`Delete the line "${t.name}" with its ${t.notes.length} notes?`)) return;
    this.onDeleteLine(t.id);
  }

  /** Clear button: remove every note of the selected line. */
  clearSelected() {
    const row = this.selectedRow;
    if (!row || !row.rt.track.notes.length) return;
    if (!confirm(`Remove all ${row.rt.track.notes.length} notes of "${row.rt.track.name}"?`)) return;
    row.rt.track.notes.length = 0;
    this._edited(row, true);
  }

  // --- Velocity strip (pinned under the lines, for the selected line) -

  _updateVelocity() {
    const row = this.selectedRow;
    if (!this.velRow || !row) return;
    this.velRow.style.setProperty("--c", row.color);
    const drum = row.drums ? row.rt.instrument.byId[row.velKey]?.name || "" : "";
    this.velNameEl.textContent = row.rt.track.name + (drum ? ` · ${drum}` : "");
    this.velNameEl.title = row.drums ? "Click a drum's name in the line to show it here" : "";
    this.vel.draw();
  }

  // --- Sound controls of the selected line ---------------------------

  _renderDetail() {
    this.detailEl.innerHTML = "";
    const row = this.selectedRow;
    if (!row) return;
    const rt = row.rt, track = rt.track;
    const def = SoundPad.Instruments.get(track.type);
    const host = document.createElement("div");
    this.detailEl.appendChild(host);
    if (!def.params) {
      host.className = "param-panel mx-note";
      host.innerHTML = `<div class="pp-head"><h3></h3></div>
        <p>A drum kit has no sound controls — pick another kit in the line's sound menu.
        EQ, compressor, reverb, delay and sidechain for every line are in the Mixer tab.</p>`;
      host.querySelector("h3").textContent = `Sound — ${track.name}`;
      return;
    }
    const panel = new SoundPad.ParamPanel(host, {
      title: `Sound controls — ${track.name}`,
      schema: def.params,
      values: () => def.effectiveParams(track),
      edited: () => Object.keys(track.params).length > 0,
      texts: { edited: "edited — saved with this line" },
      onChange: (id, value, commit) => {
        this.P.setTrackParam(this.project, track.id, id, value);
        rt.instrument.setParams(track.params);
        if (commit) { panel.render(); this.preview(rt); }
      },
      onReset: () => {
        this.P.resetTrackParams(this.project, track.id);
        rt.instrument.setParams(track.params);
        panel.render();
        this.preview(rt);
      },
    });
    panel.render();
  }

  // --- Layout --------------------------------------------------------

  _resize() {
    const w = this.rulerCell.clientWidth;
    if (!w) return; // hidden tab
    const dpr = window.devicePixelRatio || 1;
    this.W = w;
    this.dpr = dpr;
    const size = (canvas, h) => {
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    };
    size(this.ruler, this.RULER_H);
    this.rows.forEach((row) => size(row.canvas, row.h));
    this.hbar.style.width = w + "px";
    if (this.vel) this.vel.resize(w);
    // Where the lines' canvases start inside the stack (for the playhead overlay).
    this.bodyLeft = this.rulerCell.getBoundingClientRect().left - this.stackEl.getBoundingClientRect().left;
    this._layout();
    this._drawAll();
  }

  /** Scrollable width: the song (or loop) plus 16 empty bars to write into. */
  _layout() {
    if (!this.W) return;
    const L = this.L, p = this.project;
    const used = Math.max(L.end(p), p.loop ? p.loop.end : 0);
    const view = this.W - this.LABEL_W;
    const steps = Math.min(L.MAX_STEPS, Math.max(L._ceilBar(used) + 16 * L.BAR, Math.ceil(view / this.pps)));
    this.contentSteps = steps;
    this.hbarInner.style.width = this.LABEL_W + steps * this.pps + "px";
    this.hbar.classList.toggle("idle", steps * this.pps <= view + 1);
    const max = Math.max(0, steps * this.pps - view);
    if (this.scrollX > max) this.scrollX = max;
    if (Math.abs(this.hbar.scrollLeft - this.scrollX) > 0.5) this._scrollTo(this.scrollX);
  }

  _scrollTo(x) {
    this.hbar.scrollLeft = Math.max(0, x);
    this.scrollX = this.hbar.scrollLeft;
    SoundPad.LinesView.prefs.scrollX = this.scrollX;
  }

  zoom(dir, anchorX = (this.W - this.LABEL_W) / 2) {
    const next = Math.min(this.ZOOMS.length - 1, Math.max(0, this.zoomIdx + dir));
    if (next === this.zoomIdx) return;
    const stepAtAnchor = (this.scrollX + anchorX) / this.pps;
    this.zoomIdx = next;
    this.scrollX = Math.max(0, stepAtAnchor * this.pps - anchorX);
    this._layout();
    this._scrollTo(this.scrollX);
    this._savePrefs();
    this._renderZoom();
    this._drawAll();
  }

  /** Vertical zoom: taller rows (lines grow with them). Each line keeps the same pitches in view. */
  zoomRows(dir) {
    const next = Math.min(this.ROW_ZOOMS.length - 1, Math.max(0, this.rowZoomIdx + dir));
    if (next === this.rowZoomIdx) return;
    const centers = this.rows.map((row) => (row.scrollY + row.h / 2) / row.rowH);
    this.rowZoomIdx = next;
    this.rows.forEach((row, i) => {
      row.rowH = this._rowH(row.drums);
      row.scrollY = Math.round(centers[i] * row.rowH - (Math.min(row.keys.length, this.ROWS[row.rt.track.size] || 0) * row.rowH) / 2);
    });
    this._applySizes();          // new heights + clamps scrollY
    this._savePrefs();
    this._renderZoom();
    this._resize();
  }

  /** Zoom readouts in % (100% = the default 12 px per step / per row). */
  _renderZoom() {
    if (!this.zoomValEl) return;
    const fmt = (v) => Math.round(v * 100) + "%";
    this.zoomValEl.textContent = fmt(this.pps / 12);
    this.rowValEl.textContent = fmt(this.ROW_ZOOMS[this.rowZoomIdx] / 12);
    this.root.querySelector('[data-act="zoomIn"]').disabled = this.zoomIdx >= this.ZOOMS.length - 1;
    this.root.querySelector('[data-act="zoomOut"]').disabled = this.zoomIdx <= 0;
    this.root.querySelector('[data-act="rowsIn"]').disabled = this.rowZoomIdx >= this.ROW_ZOOMS.length - 1;
    this.root.querySelector('[data-act="rowsOut"]').disabled = this.rowZoomIdx <= 0;
  }

  /** Zoom so the whole song (and loop) fits, and scroll to bar 1. */
  fitSong() {
    if (!this.W) return;
    const L = this.L, p = this.project;
    const end = Math.max(L.length(p), p.loop ? p.loop.end : 0);
    let idx = 0;
    this.ZOOMS.forEach((z, i) => { if (end * z <= this.W - this.LABEL_W - 8) idx = i; });
    this.zoomIdx = idx;
    this._layout();
    this._scrollTo(0);
    this._savePrefs();
    this._renderZoom();
    this._drawAll();
  }

  _renderStatus() {
    const L = this.L, p = this.project;
    const end = L.end(p);
    const notes = p.tracks.reduce((a, t) => a + t.notes.length, 0);
    const n = p.tracks.length;
    let text = `${n} line${n === 1 ? "" : "s"} · `;
    const bars = L.length(p) / L.BAR;
    text += end ? `${bars} bar${bars === 1 ? "" : "s"} · ${notes} note${notes === 1 ? "" : "s"}` : "empty — click in a line to write notes";
    if (L.looping(p)) text += ` · looping ${this._fmt(p.loop.start)} → ${this._fmt(p.loop.end)}`;
    this.statusEl.textContent = text;
    this._renderLoop();
    this._renderSel();
  }

  // --- Loop controls -------------------------------------------------

  /** Show the loop's state in the header (toggle, from / to, length). */
  _renderLoop() {
    if (!this.loopBtn) return;
    const L = this.L, loop = this.project.loop, on = L.looping(this.project);
    this.loopBtn.classList.toggle("on", on);
    this.loopBtn.textContent = on ? "⟲ Loop on" : "⟲ Loop";
    const typing = (el) => document.activeElement === el;
    if (!typing(this.loopFrom)) this.loopFrom.value = loop ? L.fmtPos(loop.start) : "";
    if (!typing(this.loopTo)) this.loopTo.value = loop ? L.fmtPos(loop.end) : "";
    this.loopFrom.classList.toggle("off", !!loop && !on);
    this.loopTo.classList.toggle("off", !!loop && !on);
    this.loopFrom.classList.remove("bad");
    this.loopTo.classList.remove("bad");
    let len = "";
    if (loop) {
      const steps = loop.end - loop.start;
      const bars = steps / L.BAR;
      len = Number.isInteger(bars) ? `${bars} bar${bars === 1 ? "" : "s"}`
        : steps % 4 === 0 ? `${steps / 4} beats` : `${steps} steps`;
    }
    this.loopLenEl.textContent = len;
  }

  /** L / the toggle: loop on ⇄ off (the region stays). */
  toggleLoop() {
    const p = this.project;
    this.L.setLoopOn(p, !this.L.looping(p));
    this._edited(null, true);
  }

  /** From / to typed in: "3", "3.2" or "3.2.4". A typed loop switches looping on. */
  _typedLoop() {
    const L = this.L, p = this.project;
    const from = L.parsePos(this.loopFrom.value);
    const to = L.parsePos(this.loopTo.value);
    const badFrom = this.loopFrom.value.trim() !== "" && from === null;
    const badTo = this.loopTo.value.trim() !== "" && to === null;
    const start = from ?? (p.loop ? p.loop.start : 0);
    const end = to ?? (p.loop ? p.loop.end : start + L.BAR);
    if (badFrom || badTo || end <= start) {
      // Not a valid region: show which field is wrong, keep the loop as it was.
      this.loopFrom.classList.toggle("bad", badFrom || (!badTo && end <= start));
      this.loopTo.classList.toggle("bad", badTo || (!badFrom && end <= start));
      return;
    }
    L.setLoop(p, start, end);
    L.setLoopOn(p, true);
    this._edited(null, true);
  }

  _fmt(step) {
    const bar = Math.floor(step / 16) + 1, beat = Math.floor((step % 16) / 4) + 1, st = step % 4;
    return st ? `${bar}.${beat}.${st + 1}` : beat > 1 ? `${bar}.${beat}` : `${bar}`;
  }

  // --- Drawing -------------------------------------------------------

  _x(step) {
    return this.LABEL_W + step * this.pps - this.scrollX;
  }

  _drawAll() {
    this._drawRuler();
    this.rows.forEach((row) => this._drawRow(row));
    if (this.vel) this.vel.draw();
    this._placePlayhead();
  }

  /** Vertical grid (bars / beats / steps, each when there's room) in [top, top + h). */
  _grid(g, top, h) {
    const pps = this.pps, W = this.W;
    const first = Math.max(0, Math.floor(this.scrollX / pps));
    const last = Math.ceil((this.scrollX + W - this.LABEL_W) / pps);
    for (let s = first; s <= last; s++) {
      const isBar = s % 16 === 0, isBeat = s % 4 === 0;
      if (!isBar && !(isBeat && pps * 4 >= 10) && pps < 8) continue;
      const x = Math.round(this._x(s));
      if (x < this.LABEL_W) continue;
      g.fillStyle = isBar ? "#3a4452" : isBeat ? "#262d37" : "#1c222a";
      g.fillRect(x, top, 1, h);
    }
  }

  _drawRuler() {
    if (!this.W) return;
    const L = this.L, p = this.project;
    const g = this.rg, W = this.W, H = this.RULER_H, pps = this.pps, LW = this.LABEL_W;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = "#11151b";
    g.fillRect(LW, 0, W - LW, H);

    const first = Math.max(0, Math.floor(this.scrollX / pps));
    const last = Math.ceil((this.scrollX + W - LW) / pps);
    const barPx = 16 * pps;
    const need = Math.ceil(34 / barPx);
    const labelEvery = [1, 2, 4, 8, 16, 32].find((n) => n >= need) || 32;
    g.font = "600 11px Segoe UI, system-ui, sans-serif";
    g.textBaseline = "middle";
    // Zoomed in: beats get numbers ("3.2") and single steps get ticks.
    const beatLabels = pps * 4 >= 44, stepTicks = pps >= 16;
    const every = stepTicks ? 1 : 4;
    for (let s = first - (first % every); s <= last; s += every) {
      const x = Math.round(this._x(s));
      if (x < LW) continue;
      if (s % 16 === 0) {
        const bar = s / 16;
        g.fillStyle = "#39424f";
        g.fillRect(x, bar % labelEvery === 0 ? 6 : 16, 1, H);
        if (bar % labelEvery === 0) {
          g.fillStyle = "#8a94a3";
          g.font = "600 11px Segoe UI, system-ui, sans-serif";
          g.fillText(String(bar + 1), x + 4, H / 2 - 1);
        }
      } else if (s % 4 === 0) {
        if (pps * 4 < 10) continue;
        g.fillStyle = "#2f3844";
        g.fillRect(x, beatLabels ? 12 : H - 6, 1, beatLabels ? H - 12 : 6);
        if (beatLabels) {
          g.fillStyle = "#5f6977";
          g.font = "10px Segoe UI, system-ui, sans-serif";
          g.fillText(`${Math.floor(s / 16) + 1}.${(s % 16) / 4 + 1}`, x + 4, H / 2 - 1);
        }
      } else {
        g.fillStyle = "#262d37";
        g.fillRect(x, H - 4, 1, 4);
      }
    }

    // Song end (what plays when nothing is looped).
    const ex = this._x(L.length(p));
    if (ex >= LW && ex <= W) {
      g.fillStyle = "#ffb454";
      g.fillRect(Math.round(ex) - 1, 0, 2, H);
    }
    // Loop region: a band over the whole ruler with a handle at each end
    // (blue = looping, grey = kept but off).
    if (p.loop) {
      const on = L.looping(p);
      const lx = this._x(p.loop.start), rx = this._x(p.loop.end);
      const hot = this._loopHover;
      g.save();
      g.beginPath();
      g.rect(LW, 0, W - LW, H);
      g.clip();
      g.fillStyle = on ? "rgba(77, 163, 255, 0.2)" : "rgba(138, 148, 163, 0.12)";
      g.fillRect(lx, 0, rx - lx, H);
      g.fillStyle = on ? "#4da3ff" : "#5a6472";
      g.fillRect(lx, 0, rx - lx, 4);                       // top bar
      const handle = (x, which) => {
        const wide = hot === which || (this.loopDrag && this.loopDrag.mode === which);
        g.fillStyle = on ? (wide ? "#9fcbff" : "#4da3ff") : (wide ? "#8a94a3" : "#5a6472");
        g.fillRect(x - (wide ? 3 : 2), 0, wide ? 6 : 4, H);
      };
      handle(lx, "start");
      handle(rx, "end");
      g.restore();
    }
    g.fillStyle = "#2a323d";
    g.fillRect(LW, H - 1, W - LW, 1);
  }

  _drawRow(row) {
    if (!this.W || !row.canvas.width) return;
    const g = row.g, W = this.W, H = row.h, LW = this.LABEL_W;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (row.rt.track.size === "min") this._drawOverview(row);
    else this._drawRoll(row);

    // Past the song end, or (looping) the loop region.
    const p = this.project;
    if (!this.L.looping(p)) {
      const ex = this._x(this.L.length(p));
      if (ex < W) {
        g.fillStyle = "rgba(8, 10, 14, 0.38)";
        g.fillRect(Math.max(LW, ex), 0, W - Math.max(LW, ex), H);
      }
    } else {
      const lx = Math.max(LW, this._x(p.loop.start)), rx = Math.min(W, this._x(p.loop.end));
      if (rx > lx) {
        g.fillStyle = "rgba(77, 163, 255, 0.07)";
        g.fillRect(lx, 0, rx - lx, H);
      }
      // Outside the loop doesn't play: dim it a little, and mark the edges.
      g.fillStyle = "rgba(8, 10, 14, 0.22)";
      if (lx > LW) g.fillRect(LW, 0, lx - LW, H);
      if (rx < W) g.fillRect(rx, 0, W - rx, H);
      g.fillStyle = "rgba(77, 163, 255, 0.55)";
      if (this._x(p.loop.start) >= LW) g.fillRect(Math.round(this._x(p.loop.start)), 0, 1, H);
      if (this._x(p.loop.end) <= W) g.fillRect(Math.round(this._x(p.loop.end)) - 1, 0, 1, H);
    }
    if (row.silent) {
      g.fillStyle = "rgba(14, 17, 22, 0.6)";
      g.fillRect(LW, 0, W - LW, H);
    }
  }

  /** The editable roll: rows (pitches or drums), grid, notes, row labels. */
  _drawRoll(row) {
    const g = row.g, W = this.W, H = row.h, LW = this.LABEL_W, RH = row.rowH, pps = this.pps;
    const keys = row.keys;
    const firstRow = Math.max(0, Math.floor(row.scrollY / RH));
    const lastRow = Math.min(keys.length - 1, Math.ceil((row.scrollY + H) / RH));
    const yOf = (i) => i * RH - row.scrollY;

    // Row backgrounds.
    for (let i = firstRow; i <= lastRow; i++) {
      const key = keys[i], y = yOf(i);
      if (row.drums) g.fillStyle = i % 2 ? "#161b22" : "#1a2028";
      else g.fillStyle = SoundPad.isNatural(key) ? "#1b212a" : "#151a21";
      g.fillRect(LW, y, W - LW, RH);
      g.fillStyle = !row.drums && key % 12 === 0 ? "#39424f" : "#11151b";
      g.fillRect(LW, y + RH - 1, W - LW, 1);
    }
    this._grid(g, 0, H);

    // The selected block (what Copy takes, silence included).
    const selHere = this.sel.trackId === row.rt.track.id && this.sel.notes.size > 0;
    const region = selHere ? this._selRegion() : null;
    if (region) {
      const rx0 = Math.max(LW, this._x(region.start)), rx1 = Math.min(W, this._x(region.end));
      if (rx1 > rx0) {
        g.fillStyle = "rgba(255, 255, 255, 0.05)";
        g.fillRect(rx0, 0, rx1 - rx0, H);
        g.fillStyle = "rgba(255, 255, 255, 0.45)";
        if (this._x(region.start) >= LW) g.fillRect(Math.round(rx0), 0, 1, H);
        if (this._x(region.end) <= W) g.fillRect(Math.round(rx1) - 1, 0, 1, H);
      }
    }

    // Notes, in the line's colour (brightness = velocity); selected ones bright with a white frame.
    const color = row.color;
    const index = row.drums ? new Map(keys.map((k, i) => [k, i])) : null;
    const top = keys[0];
    let above = 0, below = 0;
    g.lineWidth = 1;
    for (const n of row.rt.track.notes) {
      const i = row.drums ? index.get(n.key) : top - n.key;
      if (i === undefined || i < 0 || i >= keys.length) continue;
      if (i < firstRow) { above++; continue; }
      if (i > lastRow) { below++; continue; }
      const x = this._x(n.step) + 1;
      // A drum hit fills its whole step cell (a note: its whole length).
      const w = Math.max(3, (row.drums ? 1 : n.len) * pps - 2);
      if (x + w < LW || x > W) continue;
      const y = yOf(i) + 1, h = RH - 3;
      const picked = selHere && this.sel.notes.has(n);
      g.globalAlpha = picked ? 1 : 0.35 + 0.65 * n.vel;
      g.fillStyle = color;
      g.fillRect(x, y, w, h);
      g.globalAlpha = 1;
      if (picked) {
        g.lineWidth = 2;
        g.strokeStyle = "#ffffff";
        g.strokeRect(x + 1, y + 1, w - 2, h - 2);
        g.lineWidth = 1;
      } else {
        g.strokeStyle = "rgba(255, 255, 255, 0.55)";
        g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      }
      if (!row.drums && w > 12) {          // resize grip on the right edge
        g.fillStyle = "rgba(14, 17, 22, 0.5)";
        g.fillRect(x + w - 4, y + 2, 2, h - 4);
      }
      if (!row.drums && w >= 30 && h >= 11) {    // zoomed in: the note's name inside it
        g.save();
        g.beginPath();
        g.rect(Math.max(LW, x), y, w - 6, h);
        g.clip();
        g.fillStyle = "#0e1116";
        g.font = `600 ${Math.min(13, h - 2)}px Segoe UI, system-ui, sans-serif`;
        g.textBaseline = "middle";
        g.fillText(SoundPad.midiName(n.key), Math.max(LW, x) + 4, y + h / 2 + 0.5);
        g.restore();
      }
    }

    // The selection box being dragged.
    const d = this.drag;
    if (d && d.mode === "marquee" && d.row === row) {
      const bx0 = this._x(Math.min(d.s0, d.s1)), bx1 = this._x(Math.max(d.s0, d.s1));
      const by0 = Math.min(d.r0, d.r1) * RH - row.scrollY, by1 = Math.max(d.r0, d.r1) * RH - row.scrollY;
      g.fillStyle = "rgba(255, 255, 255, 0.08)";
      g.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
      g.setLineDash([4, 3]);
      g.strokeStyle = "#ffffff";
      g.strokeRect(bx0 + 0.5, by0 + 0.5, bx1 - bx0 - 1, by1 - by0 - 1);
      g.setLineDash([]);
    }

    // Row labels (stay put while the grid scrolls); the text grows with the rows.
    g.fillStyle = "#0e1116";
    g.fillRect(0, 0, LW, H);
    g.textBaseline = "middle";
    const fs = Math.max(9, Math.min(13, RH - 4));
    for (let i = firstRow; i <= lastRow; i++) {
      const key = keys[i], y = yOf(i);
      if (row.drums) {
        const sel = key === row.velKey && row.rt.track.id === this.selectedId;
        g.fillStyle = sel ? "#232a35" : "#141920";
        g.fillRect(0, y, LW - 2, RH - 1);
        g.fillStyle = sel ? row.color : "#8a94a3";
        g.font = (sel ? "600 " : "") + Math.min(12, fs + 1) + "px Segoe UI, system-ui, sans-serif";
        g.fillText(row.rt.instrument.byId[key]?.name || key, 5, y + RH / 2, LW - 9);
      } else {
        const natural = SoundPad.isNatural(key), isC = key % 12 === 0;
        g.fillStyle = natural ? "#cfd5de" : "#0d1015";
        g.fillRect(0, y, LW - 2, RH - 1);
        if (natural || RH >= 12) {
          g.fillStyle = natural ? (isC ? "#0e1116" : "#5a6472") : "#6b7480";
          g.font = (isC ? "600 " : "") + fs + "px Segoe UI, system-ui, sans-serif";
          g.fillText(SoundPad.midiName(key), 5, y + RH / 2);
        }
      }
    }
    // Notes hidden above / below: a marker on the label column.
    g.fillStyle = row.color;
    g.font = "600 9px Segoe UI, system-ui, sans-serif";
    if (above) { g.fillRect(0, 0, LW - 2, 2); }
    if (below) { g.fillRect(0, H - 2, LW - 2, 2); }
  }

  /** "min" size: the whole line squeezed into one strip (click it to open). */
  _drawOverview(row) {
    const g = row.g, W = this.W, H = row.h, LW = this.LABEL_W, pps = this.pps;
    g.fillStyle = "#171c24";
    g.fillRect(LW, 0, W - LW, H);
    this._grid(g, 0, H);
    const notes = row.rt.track.notes;
    if (notes.length) {
      let lo, hi, rowOf;
      if (row.drums) {
        const index = new Map(row.keys.map((k, i) => [k, i]));
        lo = 0; hi = row.keys.length - 1;
        rowOf = (n) => index.get(n.key) ?? 0;
      } else {
        const ks = notes.map((n) => n.key);
        lo = Math.min(...ks); hi = Math.max(...ks);
        if (hi - lo < 12) { const mid = (hi + lo) / 2; lo = mid - 6; hi = mid + 6; }
        rowOf = (n) => hi - n.key;
      }
      const rh = (H - 6) / (hi - lo + 1), bh = Math.max(1.5, Math.min(rh * 0.8, 4));
      g.fillStyle = row.color;
      g.globalAlpha = 0.9;
      for (const n of notes) {
        const x = this._x(n.step);
        const w = Math.max(1.5, (row.drums ? 1 : n.len) * pps - 0.5);
        if (x + w < LW || x > W) continue;
        g.fillRect(Math.max(LW, x), 3 + rowOf(n) * rh + (rh - bh) / 2, w, bh);
      }
      g.globalAlpha = 1;
    }
    g.fillStyle = "#0e1116";
    g.fillRect(0, 0, LW, H);
    g.fillStyle = "#5a6472";
    g.font = "10px Segoe UI, system-ui, sans-serif";
    g.textBaseline = "middle";
    g.fillText("click to open", 4, H / 2);
  }

  // --- Selection / clipboard -------------------------------------------

  _rowOf(trackId) {
    return this.rows.find((r) => r.rt.track.id === trackId) || null;
  }

  /** The selected notes that still exist (edits elsewhere may have removed some). */
  _selNotes() {
    const row = this._rowOf(this.sel.trackId);
    if (!row || !this.sel.notes.size) return [];
    const live = row.rt.track.notes.filter((n) => this.sel.notes.has(n));
    if (live.length !== this.sel.notes.size) this.sel.notes = new Set(live);
    return live;
  }

  _isSel(row, note) {
    return this.sel.trackId === row.rt.track.id && this.sel.notes.has(note);
  }

  /** Select `notes` of `row` (region = the block they stand for, or null = around the notes). */
  _setSel(row, notes, region = null) {
    const prev = this._rowOf(this.sel.trackId);
    this.sel = { trackId: row ? row.rt.track.id : null, notes: new Set(notes), region };
    if (prev && prev !== row) this._drawRow(prev);
    if (row) this._drawRow(row);
    this._renderSel();
  }

  clearSelection() {
    if (!this.sel.trackId && !this.sel.notes.size) return;
    this._setSel(null, []);
  }

  /** The selected block in steps: the drawn box, or the notes rounded out to whole beats. */
  _selRegion() {
    const notes = this._selNotes();
    if (!notes.length) return null;
    if (this.sel.region) return this.sel.region;
    const start = Math.min(...notes.map((n) => n.step));
    const end = Math.max(...notes.map((n) => n.step + n.len));
    return { start: Math.floor(start / 4) * 4, end: Math.max(Math.ceil(end / 4) * 4, Math.floor(start / 4) * 4 + 4) };
  }

  /** Ctrl + A: every note of the selected line (the block = bar 1 → its last bar). */
  selectAll() {
    const row = this.selectedRow;
    if (!row || !row.rt.track.notes.length) return;
    const end = Math.max(...row.rt.track.notes.map((n) => n.step + n.len));
    this._setSel(row, row.rt.track.notes, { start: 0, end: this.L._ceilBar(end) });
  }

  /** Ctrl + C: remember the selected notes, relative to the start of their block. */
  copy() {
    const notes = this._selNotes();
    const row = this._rowOf(this.sel.trackId);
    if (!notes.length || !row) return false;
    const region = this._selRegion();
    this.clipboard = {
      drums: row.drums,
      from: row.rt.track.name,
      start: region.start,
      span: region.end - region.start,
      notes: notes.map((n) => ({ d: n.step - region.start, key: n.key, len: n.len, vel: n.vel })),
      next: { [row.rt.track.id]: region.end },     // per line: where the next paste goes
    };
    this._renderSel();
    return true;
  }

  cut() {
    if (this.copy()) this.deleteSelection();
  }

  /**
   * Ctrl + V into the selected line: right after the selected block (so pasting
   * again and again keeps extending it), or after the last paste / where it was
   * copied. The pasted notes become the selection — drag them anywhere.
   */
  paste() {
    const cb = this.clipboard, row = this.selectedRow;
    if (!cb || !row) return;
    if (cb.drums !== row.drums) {
      this.selInfoEl.textContent = cb.drums ? "Drum hits can only be pasted into a drum line" : "Notes can't be pasted into a drum line";
      return;
    }
    const id = row.rt.track.id, MAX = this.L.MAX_STEPS;
    const selHere = this.sel.trackId === id && this._selNotes().length;
    const at = selHere ? this._selRegion().end : (cb.next[id] ?? cb.start);
    if (at >= MAX) return;
    const keys = new Set(row.keys);
    const fresh = cb.notes
      .filter((n) => keys.has(n.key) && at + n.d < MAX)
      .map((n) => ({ step: at + n.d, key: n.key, len: Math.min(n.len, MAX - at - n.d), vel: n.vel }));
    // Pasted notes replace notes that start on the same step + pitch.
    const taken = new Set(fresh.map((n) => n.step + "|" + n.key));
    row.rt.track.notes = row.rt.track.notes.filter((n) => !taken.has(n.step + "|" + n.key)).concat(fresh);
    cb.next[id] = at + cb.span;
    this._setSel(row, fresh, { start: at, end: at + cb.span });
    // Bring the pasted block into view.
    const x0 = this._x(at), x1 = this._x(at + cb.span);
    if (x1 > this.W || x0 < this.LABEL_W) this._scrollTo(Math.max(0, at * this.pps - 40));
    this._edited(row, true);
  }

  /** Ctrl + D: copy + paste right after, in one go. */
  duplicate() {
    if (this.copy()) this.paste();
  }

  deleteSelection() {
    const notes = this._selNotes();
    const row = this._rowOf(this.sel.trackId);
    if (!notes.length || !row) return;
    const gone = new Set(notes);
    row.rt.track.notes = row.rt.track.notes.filter((n) => !gone.has(n));
    this._setSel(row, [], null);
    this._edited(row, true);
  }

  /** The edit bar: what's selected, what's copied, which buttons work. */
  _renderSel() {
    if (!this.selInfoEl) return;
    const notes = this._selNotes();
    const row = this._rowOf(this.sel.trackId);
    const L = this.L, cb = this.clipboard;
    if (notes.length && row) {
      const r = this._selRegion();
      this.selInfoEl.textContent = `${notes.length} note${notes.length === 1 ? "" : "s"} in ${row.rt.track.name} · ${L.fmtPos(r.start)} → ${L.fmtPos(r.end)}`;
      this.selInfoEl.classList.add("on");
    } else {
      this.selInfoEl.textContent = "Ctrl + drag in a line to select notes · Shift + click adds one · Ctrl + A = whole line";
      this.selInfoEl.classList.remove("on");
    }
    const has = notes.length > 0;
    const btn = (a) => this.root.querySelector(`[data-act="${a}"]`);
    ["copy", "cut", "dup", "del"].forEach((a) => (btn(a).disabled = !has));
    btn("paste").disabled = !cb;
    btn("selAll").disabled = !this.selectedRow || !this.selectedRow.rt.track.notes.length;
    if (cb) {
      const bars = cb.span / L.BAR;
      const span = Number.isInteger(bars) ? `${bars} bar${bars === 1 ? "" : "s"}` : `${cb.span / 4} beats`;
      this.clipInfoEl.textContent = `Copied: ${cb.notes.length} note${cb.notes.length === 1 ? "" : "s"} · ${span} (${cb.from})`;
    } else this.clipInfoEl.textContent = "";
  }

  // --- Mouse: notes --------------------------------------------------

  _hit(e, row) {
    const r = row.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const raw = Math.floor((x - this.LABEL_W + this.scrollX) / this.pps);
    const step = Math.min(this.L.MAX_STEPS - 1, Math.max(0, raw));
    const i = Math.min(row.keys.length - 1, Math.max(0, Math.floor((y + row.scrollY) / row.rowH)));
    return {
      x, y, step, key: row.keys[i], idx: i, inLabel: x < this.LABEL_W,
      fs: Math.max(0, (x - this.LABEL_W + this.scrollX) / this.pps),     // unrounded step (selection box)
      fr: Math.max(0, (y + row.scrollY) / row.rowH),                      // unrounded row
    };
  }

  /** Note under (step, key) — for drums, a hit only covers its own step. */
  _noteAt(row, step, key) {
    const notes = { notes: row.rt.track.notes };
    return row.drums ? this.P.findNote(notes, step, key) : this.P.noteAt(notes, step, key);
  }

  /** Which drum of a drum line the velocity strip shows. */
  _setVelKey(row, key) {
    row.velKey = key;
    SoundPad.LinesView.prefs.velKey[row.rt.track.id] = key;
    this._drawRow(row);
    this._updateVelocity();
  }

  _onEdge(note, x) {
    const right = this._x(note.step + note.len);
    return right - x <= Math.max(4, Math.min(9, this.pps * 0.4));
  }

  _onDown(e, row) {
    if (!this.W) return;
    const P = this.P, track = row.rt.track;
    const line = track;                       // a line holds its notes like a part does
    const h = this._hit(e, row);              // before anything can change the layout
    this.select(track.id);
    if (track.size === "min") {               // an overview opens on click
      this.L.setSize(track, "m");
      this._applySizes();
      this._resize();
      return;
    }
    if (h.inLabel) {
      if (row.drums) this._setVelKey(row, h.key);
      this._sound(row, h.key);
      return;
    }
    try { row.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }

    if (e.button === 2) {
      this.drag = { mode: "erase", row };
      this._eraseAt(row, h);
      return;
    }
    if (e.button !== 0) return;

    // Ctrl + drag: select the notes inside a box (Shift + Ctrl adds to the selection).
    if (e.ctrlKey || e.metaKey) {
      const keep = e.shiftKey && this.sel.trackId === track.id ? this._selNotes() : [];
      this.drag = { mode: "marquee", row, s0: h.fs, r0: h.fr, s1: h.fs, r1: h.fr, keep, alt: e.altKey };
      this._marqueeSelect(this.drag);          // Ctrl + click on a note selects just that note
      return;
    }
    const hit = this._noteAt(row, h.step, h.key);
    // Shift + click a note: add it to / take it out of the selection.
    if (e.shiftKey && hit) {
      const notes = this.sel.trackId === track.id ? this._selNotes() : [];
      const next = notes.includes(hit) ? notes.filter((n) => n !== hit) : notes.concat(hit);
      this._setSel(row, next, null);
      return;
    }
    // Drag a selected note: the whole selection moves with it.
    if (hit && this._isSel(row, hit) && (row.drums || !this._onEdge(hit, h.x))) {
      const notes = this._selNotes();
      this.drag = {
        mode: "moveSel", row, s0: h.step, i0: h.idx, grabbed: hit, moved: false,
        base: notes.map((n) => ({ n, step: n.step, i: row.keys.indexOf(n.key) })),
        region: this.sel.region ? { ...this.sel.region } : null,
      };
      this._sound(row, hit.key, hit.vel);
      return;
    }
    // With a selection, a click elsewhere just deselects (no note is added by accident).
    if (this._selNotes().length) {
      this.clearSelection();
      if (!hit) return;
    }

    if (row.drums) {
      const on = !P.findNote(line, h.step, h.key);
      P.setNote(line, h.step, h.key, on);
      if (on) {
        this._sound(row, h.key);
        if (row.velKey !== h.key) this._setVelKey(row, h.key);
      }
      this.drag = { mode: "paint", row, on };
      this._edited(row);
      return;
    }

    if (hit && this._onEdge(hit, h.x)) {
      this.drag = { mode: "resize", row, note: hit, moved: true };
    } else if (hit) {
      this.drag = { mode: "move", row, note: hit, grab: h.step - hit.step };
      this.lastLen = hit.len;
      this._sound(row, hit.key, hit.vel);
    } else {
      const len = Math.min(this.lastLen, this.L.MAX_STEPS - h.step);
      const note = P.addNote(line, { step: h.step, key: h.key, len });
      // A freshly drawn note keeps its default length until the mouse leaves its first cell.
      this.drag = { mode: "resize", row, note, moved: false, origin: h.step };
      this._sound(row, h.key);
    }
    this._edited(row);
  }

  _onMove(e, row) {
    if (!this.W) return;
    const d = this.drag;
    if (row.rt.track.size === "min") { row.canvas.style.cursor = "pointer"; return; }
    const h = this._hit(e, row);
    if (!d || d.row !== row) { this._updateCursor(row, h); return; }
    const P = this.P, line = row.rt.track, MAX = this.L.MAX_STEPS;

    // Dragging near the edges scrolls, so notes can be pulled past what's in view.
    if (d.mode !== "erase") {
      if (h.x > this.W - 24) this._scrollTo(this.scrollX + this.pps / 2);
      else if (h.x < this.LABEL_W + 10 && this.scrollX > 0) this._scrollTo(this.scrollX - this.pps / 2);
    }

    if (d.mode === "marquee") {
      d.s1 = h.fs;
      d.r1 = h.fr;
      d.alt = e.altKey;
      this._marqueeSelect(d);
    } else if (d.mode === "moveSel") {
      this._moveSelection(d, h);
    } else if (d.mode === "erase") {
      this._eraseAt(row, h);
    } else if (d.mode === "paint") {
      if (h.inLabel) return;
      if (P.setNote(line, h.step, h.key, d.on)) this._edited(row);
    } else if (d.mode === "resize") {
      if (!d.moved && h.step === d.origin) return;
      d.moved = true;
      const len = Math.min(MAX - d.note.step, Math.max(1, h.step - d.note.step + 1));
      if (len !== d.note.len) {
        d.note.len = len;
        this.lastLen = len;
        this._edited(row);
      }
    } else if (d.mode === "move") {
      const step = Math.min(MAX - d.note.len, Math.max(0, h.step - d.grab));
      if (step !== d.note.step || h.key !== d.note.key) {
        if (h.key !== d.note.key) this._sound(row, h.key, d.note.vel);
        d.note.step = step;
        d.note.key = h.key;
        this._edited(row);
      }
    }
  }

  _onUp(row) {
    const d = this.drag;
    this.drag = null;
    if (d && d.note) this.P.dedupe(row.rt.track, d.note);
    if (d && d.mode === "marquee") {
      // A Ctrl + click without dragging selects nothing (and clears the selection).
      if (!this.sel.notes.size) this.clearSelection();
      this._drawRow(row);
      return;
    }
    if (d && d.mode === "moveSel" && d.moved) {
      // Moved notes replace the notes they landed on (same step + pitch).
      const moved = new Set(d.base.map((b) => b.n));
      const taken = new Set(d.base.map((b) => b.n.step + "|" + b.n.key));
      row.rt.track.notes = row.rt.track.notes.filter((n) => moved.has(n) || !taken.has(n.step + "|" + n.key));
    }
    if (d) this._edited(row, true);
  }

  /** The box's block in steps (snapped like the ruler: beats zoomed in, bars far out, steps with Alt). */
  _boxRegion(d) {
    const unit = d.alt ? 1 : this.pps * 4 >= 16 ? 4 : 16;
    const a = Math.min(d.s0, d.s1), b = Math.max(d.s0, d.s1);
    const start = Math.floor(a / unit) * unit;
    return { start, end: Math.max(start + unit, Math.ceil(b / unit) * unit) };
  }

  /** Select what's inside the box: notes overlapping its time span, on the rows it covers. */
  _marqueeSelect(d) {
    const row = d.row;
    const a = Math.min(d.s0, d.s1), b = Math.max(d.s0, d.s1);
    const r0 = Math.floor(Math.min(d.r0, d.r1)), r1 = Math.floor(Math.max(d.r0, d.r1));
    const inBox = row.rt.track.notes.filter((n) => {
      const i = row.keys.indexOf(n.key);
      const len = row.drums ? 1 : n.len;
      return i >= r0 && i <= r1 && n.step < b && n.step + len > a;
    });
    const notes = [...new Set(d.keep.concat(inBox))];
    this._setSel(row, notes, notes.length && !d.keep.length ? this._boxRegion(d) : null);
  }

  /** Drag the selection: every selected note moves by the same steps / rows (kept inside the line). */
  _moveSelection(d, h) {
    const row = d.row, MAX = this.L.MAX_STEPS;
    let dS = h.step - d.s0, dI = h.idx - d.i0;
    const minStep = Math.min(...d.base.map((b) => b.step));
    const maxEnd = Math.max(...d.base.map((b) => b.step + b.n.len));
    const minI = Math.min(...d.base.map((b) => b.i)), maxI = Math.max(...d.base.map((b) => b.i));
    dS = Math.max(-minStep, Math.min(MAX - maxEnd, dS));
    dI = Math.max(-minI, Math.min(row.keys.length - 1 - maxI, dI));
    const cur = d.grabbed.step - (d.base.find((b) => b.n === d.grabbed).step);
    const curI = row.keys.indexOf(d.grabbed.key) - d.base.find((b) => b.n === d.grabbed).i;
    if (dS === cur && dI === curI) return;
    d.moved = true;
    d.base.forEach((b) => {
      b.n.step = b.step + dS;
      b.n.key = row.keys[b.i + dI];
    });
    if (d.region) this.sel.region = { start: d.region.start + dS, end: d.region.end + dS };
    if (dI !== curI && !row.drums) this._sound(row, d.grabbed.key, d.grabbed.vel);
    this._edited(row);
    this._renderSel();
  }

  _eraseAt(row, h) {
    if (h.inLabel) return;
    const note = this._noteAt(row, h.step, h.key);
    if (!note) return;
    this.P.removeNote(row.rt.track, note);
    this._edited(row);
  }

  _updateCursor(row, h) {
    let cursor = "crosshair";
    const hit = h.inLabel ? null : this._noteAt(row, h.step, h.key);
    if (h.inLabel) cursor = "pointer";
    else if (hit && this._isSel(row, hit) && (row.drums || !this._onEdge(hit, h.x))) cursor = "move";
    else if (!row.drums) {
      const note = this._noteAt(row, h.step, h.key);
      if (note) cursor = this._onEdge(note, h.x) ? "ew-resize" : "grab";
    } else cursor = "pointer";
    row.canvas.style.cursor = cursor;
  }

  /** Notes changed in `row`: redraw it; if the song's length changed, everything. */
  _edited(row, full = false) {
    const len = this.L.length(this.project);
    const grown = len !== this._lastLength;
    this._lastLength = len;
    if (grown || full || !row) {
      this._layout();
      this._drawAll();
    } else {
      this._drawRow(row);
      this._drawRuler();
      if (this.vel && row.rt.track.id === this.selectedId) this.vel.draw();
    }
    this._renderStatus();
  }

  _onWheel(e, row) {
    if (e.altKey && e.deltaY) {             // Alt + wheel: taller / shorter rows
      e.preventDefault();
      this.zoomRows(e.deltaY < 0 ? 1 : -1);
      return;
    }
    if (e.ctrlKey) {
      e.preventDefault();
      const r = (row ? row.canvas : this.ruler).getBoundingClientRect();
      this.zoom(e.deltaY < 0 ? 1 : -1, Math.max(0, e.clientX - r.left - this.LABEL_W));
      return;
    }
    const dx = e.shiftKey ? e.deltaY : e.deltaX;
    if (dx && (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))) {
      e.preventDefault();
      this._scrollTo(this.scrollX + dx);
      this._drawAll();
      return;
    }
    // Vertical wheel over a line scrolls its pitches (the page scrolls once the line is at its end).
    if (!row || row.rt.track.size === "min" || !e.deltaY) return;
    const maxY = Math.max(0, row.keys.length * row.rowH - row.h);
    const next = Math.min(maxY, Math.max(0, row.scrollY + e.deltaY * 0.5));
    if (next === row.scrollY) return;
    e.preventDefault();
    row.scrollY = next;
    row.vbar.scrollTop = next;
    SoundPad.LinesView.prefs.scrollY[row.rt.track.id] = next;
    this._drawRow(row);
  }

  // --- Mouse: ruler (loop) -------------------------------------------

  /** Snap unit on the ruler: beats when zoomed in, bars when far out, single steps with Alt. */
  _rulerUnit(e) {
    return e.altKey ? 1 : this.pps * 4 >= 16 ? 4 : 16;
  }

  _rulerX(e) {
    return e.clientX - this.ruler.getBoundingClientRect().left;
  }

  /** Song step under the pointer (unsnapped). */
  _rulerRaw(e) {
    return Math.max(0, (this._rulerX(e) - this.LABEL_W + this.scrollX) / this.pps);
  }

  _rulerStep(e) {
    const unit = this._rulerUnit(e);
    return Math.round(this._rulerRaw(e) / unit) * unit;
  }

  /** What part of the loop is under the pointer: "start" / "end" handle, "move" (inside), or null. */
  _loopPart(e) {
    const loop = this.project.loop;
    const x = this._rulerX(e);
    if (!loop || x < this.LABEL_W) return null;
    const lx = this._x(loop.start), rx = this._x(loop.end);
    const grip = Math.min(8, Math.max(4, (rx - lx) / 4));
    if (Math.abs(x - rx) <= grip) return "end";       // end first: a short loop's handles overlap
    if (Math.abs(x - lx) <= grip) return "start";
    if (x > lx && x < rx) return "move";
    return null;
  }

  _rulerDown(e) {
    if (e.button !== 0 || !this.W || this._rulerX(e) < this.LABEL_W) return;
    try { this.ruler.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    const part = this._loopPart(e);
    const loop = this.project.loop;
    if (part === "move") this.loopDrag = { mode: "move", grab: this._rulerRaw(e) - loop.start, moved: false };
    else if (part) this.loopDrag = { mode: part, moved: false };
    else this.loopDrag = { mode: "new", anchor: this._rulerStep(e), moved: false };
  }

  _rulerMove(e) {
    const d = this.loopDrag;
    if (!d) {
      const part = this._loopPart(e);
      this.ruler.style.cursor = part === "move" ? "grab" : part ? "ew-resize" : "crosshair";
      if (part !== this._loopHover) { this._loopHover = part; this._drawRuler(); }
      return;
    }
    const L = this.L, p = this.project, unit = this._rulerUnit(e);
    const cur = this._rulerStep(e);
    if (d.mode === "new") {
      if (cur === d.anchor && !d.moved) return;
      d.moved = true;
      L.setLoop(p, d.anchor, cur);
      L.setLoopOn(p, true);                    // drawing a loop means "loop this"
    } else if (d.mode === "start") {
      const start = Math.min(cur, p.loop.end - 1);
      if (start === p.loop.start) return;
      d.moved = true;
      L.setLoop(p, start, p.loop.end);
    } else if (d.mode === "end") {
      const end = Math.max(cur, p.loop.start + 1);
      if (end === p.loop.end) return;
      d.moved = true;
      L.setLoop(p, p.loop.start, end);
    } else if (d.mode === "move") {
      const start = Math.max(0, Math.round((this._rulerRaw(e) - d.grab) / unit) * unit);
      if (start === p.loop.start) return;
      d.moved = true;
      L.moveLoop(p, start);
      this.ruler.style.cursor = "grabbing";
    }
    this._edited(null, true);
  }

  _rulerUp() {
    // A plain click doesn't change the loop (switch it off with ⟲ Loop or L).
    this.loopDrag = null;
    this._drawRuler();
  }

  // --- Sound / keyboard ------------------------------------------------

  async _sound(row, key, vel = SoundPad.DEFAULT_VEL) {
    await this.engine.init();
    const inst = row.rt.instrument, t = this.engine.ctx.currentTime;
    if (row.drums) inst.trigger(key, t, 0, vel);
    else inst.trigger(key, t, inst.liveDur ? 0.6 : 0.2, vel);
  }

  /** Computer keyboard → the selected line. Returns true if the key was used. */
  handleKey(k, e = {}) {
    // Editing shortcuts. Any other Ctrl combination is left alone (and never plays a note).
    if (e.ctrlKey || e.metaKey) {
      const cmd = { a: () => this.selectAll(), c: () => this.copy(), x: () => this.cut(),
                    v: () => this.paste(), d: () => this.duplicate() }[k];
      if (!cmd) return false;
      cmd();
      return true;
    }
    if (k === "delete" || k === "backspace") {
      if (!this._selNotes().length) return false;
      this.deleteSelection();
      return true;
    }
    if (k === "escape") {
      if (!this._selNotes().length) return false;
      this.clearSelection();
      return true;
    }
    if (k === "l") { this.toggleLoop(); return true; }
    const row = this.selectedRow;
    if (!row) return false;
    if (row.drums) {
      const d = row.rt.instrument.drums.find((x) => x.key.toLowerCase() === k);
      if (!d) return false;
      this.playLive(row, d.id);
      return true;
    }
    if (k === "[" || k === "]") {
      row.base += k === "[" ? -12 : 12;
      this._clampBase(row);
      SoundPad.LinesView.prefs.base[row.rt.track.id] = row.base;
      this._renderKeysHint(row);
      return true;
    }
    const entry = this.keyMap.find(([key]) => key === k);
    if (!entry) return false;
    this.playLive(row, row.base + entry[1]);
    return true;
  }

  /** Play a note live (and, when recording while playing, write it at the playhead). */
  async playLive(row, key) {
    await this.engine.init();
    const inst = row.rt.instrument, now = this.engine.ctx.currentTime;
    if (row.drums) inst.trigger(key, now, 0);
    else inst.trigger(key, now, inst.liveDur || 0.25);
    if (this.recordArmed && this.engine.isPlaying && row.keys.includes(key)) {
      const step = this.player.localStep(row.rt.track, this.engine.quantizeToStep(now));
      if (step >= 0) {
        if (row.drums) this.P.setNote(row.rt.track, step, key, true);
        else this.P.addNote(row.rt.track, { step, key, len: 1 });
        this._edited(row);
      }
    }
  }

  // --- Playhead ------------------------------------------------------

  setPlayhead(step) {
    if (step === this.playStep) return;
    this.playStep = step;
    // Follow the playhead when it leaves the view (not while editing).
    if (step >= 0 && this.W && !this.drag) {
      const x = this._x(step);
      if (x > this.W - 20 || x < this.LABEL_W) {
        this._scrollTo(step * this.pps - 40);
        this._drawAll();
        return;
      }
    }
    this._placePlayhead();
  }

  _placePlayhead() {
    const el = this.playheadEl;
    if (!el) return;
    const x = this._x(this.playStep);
    const show = this.playStep >= 0 && this.W && x >= this.LABEL_W && x <= this.W;
    el.classList.toggle("hidden", !show);
    if (show) el.style.transform = `translateX(${Math.round(this.bodyLeft + x - 1)}px)`;
  }

  clearPlayhead() {
    this.setPlayhead(-1);
  }

  destroy() {
    // (prefs are saved as they change — the app may have picked the next selected line already)
    if (this._ro) this._ro.disconnect();
    if (this.vel) this.vel.destroy();
    this.root.innerHTML = "";
  }
};

/** Zoom / scroll / selected line / per-line scroll + octave, shared by every LinesView (rebuilt when lines change). */
SoundPad.LinesView.prefs = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("soundpad.linesView")) || {}; } catch { /* storage blocked */ }
  return { zoom: saved.zoom, rowZoom: saved.rowZoom, scrollX: 0, selected: null, scrollY: {}, base: {}, velKey: {} };
})();
