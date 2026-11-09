/* ------------------------------------------------------------------
 * Sound Pad — App orchestrator
 * Owns the current Project and wires it to audio + UI:
 *   • for every track: a Channel (volume/pan), an Instrument (from the
 *     registry) and an editor view, plus a tab in the top bar
 *   • "+ Add track", and the track bar (sound / rename / delete track)
 *   • the Song tab (timeline) and the Pattern / Song play mode
 *   • the shared transport (play / record / tempo / volume / position)
 *   • parts bar, save / load, keyboard routing, playhead drawing
 * The Player decides what to play on each step; views only edit data.
 * ------------------------------------------------------------------ */
(function () {
  const P = SoundPad.Project;
  const engine = new SoundPad.Engine();
  const player = new SoundPad.Player(engine);
  engine.onStep = (step, time) => player.onStep(step, time);

  const SONG = "song";        // id of the Song tab (track tabs use track ids)

  let project = null;
  let rts = [];               // per-track runtime: { track, channel, instrument, view, root, tab }
  let songView = null;
  let active = null;          // track id or SONG
  let recordArmed = false;
  let currentSeqId = null;

  // DOM refs
  const $ = (id) => document.getElementById(id);
  const playBtn = $("playBtn");
  const recBtn = $("recBtn");
  const clearBtn = $("clearBtn");
  const bpmInput = $("bpm");
  const volumeInput = $("volume");
  const statusHint = $("statusHint");
  const posEl = $("position");
  const modeBtns = document.querySelectorAll(".mode-toggle [data-mode]");
  const seqNameInput = $("seqName");
  const saveBtn = $("saveBtn");
  const libListEl = $("libList");
  const storeNoteEl = $("storeNote");
  const tabsEl = $("trackTabs");
  const songTab = $("songTab");
  const viewsEl = $("views");
  const songRoot = $("songView");
  const partBarEl = $("partBar");
  const pbTrackEl = $("pbTrack");
  const pbChipsEl = $("pbChips");
  const pbNew = $("pbNew");
  const pbDup = $("pbDup");
  const pbRename = $("pbRename");
  const pbDelete = $("pbDelete");
  const tbNameEl = $("tbName");
  const tbPreset = $("tbPreset");
  const tbRename = $("tbRename");
  const tbDelete = $("tbDelete");
  const addTrackBtn = $("addTrackBtn");
  const addMenu = $("addMenu");

  const IDLE_HINT = "Press ▶ or Space to start · Arm REC then play to record";

  const rtOf = (trackId) => rts.find((rt) => rt.track.id === trackId);
  const activeRt = () => rtOf(active);

  // --- Mounting a project -------------------------------------------

  /** Tear down the old project's tracks and build the new one's. */
  function mountProject(next) {
    // Remember what was open so a rebuild/load keeps that tab.
    const prevActive = active;
    const prevType = activeRt()?.track.type;

    rts.forEach((rt) => {
      rt.view.destroy();
      rt.root.remove();
      rt.tab.remove();
      rt.channel.dispose();
    });
    if (songView) songView.destroy();

    project = next;
    engine.setBpm(project.bpm);
    project.bpm = engine.bpm;
    bpmInput.value = engine.bpm;

    rts = project.tracks.map((track) => {
      const def = SoundPad.Instruments.get(track.type);
      const channel = new SoundPad.Channel(engine);
      channel.setVolume(track.volume);
      channel.setPan(track.pan);
      const instrument = def.create(engine, channel, track.preset, track.params);

      const root = document.createElement("div");
      root.className = "inst-view hidden";
      viewsEl.appendChild(root);

      // Instruments with adjustable sound get a "Sound controls" panel above the editor.
      let panel = null;
      if (def.params) {
        const host = document.createElement("section");
        root.appendChild(host);
        panel = new SoundPad.ParamPanel(host, {
          schema: def.params,
          values: () => def.effectiveParams(track),
          edited: () => Object.keys(track.params).length > 0,
          onChange: (id, value, commit) => {
            P.setTrackParam(project, track.id, id, value);
            instrument.setParams(track.params);
            if (commit) { panel.render(); previewSound(rtOf(track.id)); }
          },
          onReset: () => {
            P.resetTrackParams(project, track.id);
            instrument.setParams(track.params);
            panel.render();
            previewSound(rtOf(track.id));
          },
        });
        panel.render();
      }

      const editorRoot = document.createElement("div");
      editorRoot.className = "inst-editor";
      root.appendChild(editorRoot);
      const View = SoundPad[def.editor];
      const options = def.editorOptions ? def.editorOptions(track) : {};
      const view = new View({ engine, root: editorRoot, project, track, instrument, options });
      view.build();

      const tab = document.createElement("button");
      tab.className = "inst";
      tab.textContent = track.name;
      tab.title = `${SoundPad.Instruments.presetOf(track).name} · double-click to rename`;
      tab.addEventListener("click", () => setActive(track.id));
      tab.addEventListener("dblclick", () => renameTrack(track.id));
      tabsEl.appendChild(tab);

      return { track, channel, instrument, view, root, tab, panel };
    });

    songView = new SoundPad.SongView({
      root: songRoot,
      project,
      tracks: rts,
      onOpenPart: openPart,
      onPickPart: (trackId) => rtOf(trackId).view.refresh(),
    });
    songView.build();

    player.setProject(project, rts);
    clearPlayheads();
    addTrackBtn.disabled = project.tracks.length >= P.MAX_TRACKS;

    if (prevActive === SONG) return setActive(SONG);
    const keep = rtOf(prevActive) || rts.find((rt) => rt.track.type === prevType) || rts[0];
    setActive(keep.track.id);
  }

  // --- Tabs: tracks + song ------------------------------------------

  /** Show a track editor (Pattern mode) or the Song timeline (Song mode). */
  function setActive(id) {
    active = id;
    const song = id === SONG;
    songTab.classList.toggle("active", song);
    songRoot.classList.toggle("hidden", !song);
    partBarEl.classList.toggle("hidden", song);
    viewsEl.classList.toggle("hidden", song);
    rts.forEach((rt) => {
      const on = rt.track.id === id;
      rt.tab.classList.toggle("active", on);
      rt.root.classList.toggle("hidden", !on);
    });
    if (song) {
      songView.render();   // parts may have been added/renamed in the editors
      setMode("song");
    } else {
      renderPartBar();
      setMode("pattern");
    }
    applyRecordArm();      // record arming follows the visible track
  }

  /** Jump from a timeline cell to that part in its track editor. */
  function openPart(trackId, partId) {
    P.setCurrentPart(project, trackId, partId);
    setActive(trackId);
    rtOf(trackId).view.refresh();
  }

  function setMode(mode) {
    player.setMode(mode);
    modeBtns.forEach((b) => b.classList.toggle("on", b.dataset.mode === player.mode));
    if (!engine.isPlaying) showPosition(null);
  }

  // --- Transport ----------------------------------------------------

  async function togglePlay() {
    await engine.init();
    if (engine.isPlaying) {
      engine.stop();
      playBtn.textContent = "▶";
      playBtn.classList.remove("on");
      clearPlayheads();
    } else {
      player.sync();
      engine.start();
      playBtn.textContent = "■";
      playBtn.classList.add("on");
    }
  }

  function applyRecordArm() {
    rts.forEach((rt) => (rt.view.recordArmed = recordArmed && rt.track.id === active));
    const rt = activeRt();
    if (!recordArmed) statusHint.textContent = IDLE_HINT;
    else if (rt) statusHint.textContent = `Recording ${rt.track.name} — play the pads/keys while it loops`;
    else statusHint.textContent = "Recording works in a track tab — open a track to record";
  }

  function toggleRecord() {
    recordArmed = !recordArmed;
    recBtn.classList.toggle("on", recordArmed);
    applyRecordArm();
  }

  function clearActive() {
    if (active === SONG) {
      if (!confirm("Remove every clip from the song timeline? (The parts themselves are kept.)")) return;
      P.clearTimeline(project);
      songView.render();
      return;
    }
    const rt = activeRt();
    if (rt) rt.view.clear();
  }

  // --- Tracks: add / sound / rename / delete -------------------------

  /** Build the "+ Add track" menu from every instrument preset, by category. */
  function buildAddMenu() {
    addMenu.innerHTML = "";
    SoundPad.Instruments.catalog().forEach(({ category, items }) => {
      const col = document.createElement("div");
      col.className = "am-col";
      const h = document.createElement("h3");
      h.textContent = category;
      col.appendChild(h);
      items.forEach((it) => {
        const b = document.createElement("button");
        b.className = "am-item";
        b.textContent = it.name;
        b.addEventListener("click", () => addTrack(it));
        col.appendChild(b);
      });
      addMenu.appendChild(col);
    });
  }

  function toggleAddMenu(open = addMenu.classList.contains("hidden")) {
    addMenu.classList.toggle("hidden", !open);
    addTrackBtn.classList.toggle("active", open);
  }

  function addTrack({ type, preset, name }) {
    toggleAddMenu(false);
    if (project.tracks.length >= P.MAX_TRACKS) return;
    const trackName = type === "drums" ? "Drums" : name;
    const track = P.addTrack(project, type, trackName, preset);
    mountProject(project);
    setActive(track.id);
    previewSound(rtOf(track.id));
  }

  /** A short sample of a track's sound (after picking or changing it). */
  async function previewSound(rt) {
    await engine.init();
    const t = engine.ctx.currentTime + 0.02;
    if (rt.track.type === "drums") {
      rt.instrument.trigger("kick", t, 0);
      rt.instrument.trigger("hat", t + 0.18, 0);
      rt.instrument.trigger("snare", t + 0.36, 0);
    } else if (rt.track.type === "guitar") {
      // Distorted: an E5 power chord · clean: an open E major chord.
      const keys = rt.instrument.p.dist ? [40, 47, 52] : [40, 47, 52, 56, 59, 64];
      rt.instrument.triggerChord(keys.map((key) => ({ key, dur: 1.4, vel: SoundPad.DEFAULT_VEL })), t);
    } else if (rt.track.type === "bass-guitar") {
      // A short riff on the low E: E1 · E1 · G1 · E2.
      [[28, 0, 0.2], [28, 0.22, 0.2], [31, 0.44, 0.2], [40, 0.66, 0.7]].forEach(([key, at, dur]) =>
        rt.instrument.trigger(key, t + at, dur));
    } else {
      const base = SoundPad.synthPreset(rt.track.preset).base;
      const root = base < 40 ? base + 12 : base;
      rt.instrument.trigger(root, t, 0.6);
    }
  }

  function changePreset(preset) {
    const rt = activeRt();
    P.setTrackPreset(project, rt.track.id, preset);    // also resets the track's tweaks
    rt.instrument.setPreset(preset);
    if (rt.panel) rt.panel.render();
    const def = SoundPad.Instruments.get(rt.track.type);
    if (def.editorOptions && rt.view.setBase) rt.view.setBase(def.editorOptions(rt.track).base);
    rt.tab.title = `${SoundPad.Instruments.presetOf(rt.track).name} · double-click to rename`;
    previewSound(rt);
  }

  function renameTrack(trackId) {
    const rt = rtOf(trackId);
    const name = prompt("Rename track", rt.track.name);
    if (name === null) return;
    P.renameTrack(project, trackId, name);
    rt.tab.textContent = rt.track.name;
    rt.view.refresh();
    renderPartBar();
  }

  function deleteTrack() {
    const rt = activeRt();
    const parts = P.partsOf(project, rt.track.id).length;
    const clips = P.clipsOf(project, rt.track.id).length;
    if (!confirm(`Delete the track "${rt.track.name}" with its ${parts} part(s)${clips ? ` and ${clips} clip(s) in the song` : ""}?`)) return;
    P.deleteTrack(project, rt.track.id);
    active = null;
    mountProject(project);
  }

  addTrackBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleAddMenu(); });
  addMenu.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => toggleAddMenu(false));
  tbPreset.addEventListener("change", () => changePreset(tbPreset.value));
  tbRename.addEventListener("click", () => renameTrack(active));
  tbDelete.addEventListener("click", deleteTrack);

  // --- Parts (per track) --------------------------------------------

  /** Track bar (sound, rename, delete) + chips for the active track's parts. */
  function renderPartBar() {
    const rt = activeRt();
    if (!rt) return;
    const track = rt.track;
    const parts = P.partsOf(project, track.id);

    tbNameEl.textContent = track.name;
    const def = SoundPad.Instruments.get(track.type);
    tbPreset.innerHTML = "";
    const groups = {};
    def.presets.forEach((pr) => {
      if (!groups[pr.category]) {
        groups[pr.category] = document.createElement("optgroup");
        groups[pr.category].label = pr.category;
        tbPreset.appendChild(groups[pr.category]);
      }
      const opt = document.createElement("option");
      opt.value = pr.id;
      opt.textContent = pr.name;
      groups[pr.category].appendChild(opt);
    });
    tbPreset.value = track.preset;
    tbDelete.disabled = project.tracks.length <= 1;

    pbTrackEl.textContent = "Parts";
    pbChipsEl.innerHTML = "";
    parts.forEach((part) => {
      const chip = document.createElement("button");
      chip.className = "chip" + (part.id === track.currentPartId ? " active" : "");
      chip.style.setProperty("--c", SoundPad.partColor(project, part.id));
      chip.textContent = part.name;
      chip.title = "Click to edit · double-click to rename";
      chip.addEventListener("click", () => selectPart(part.id));
      chip.addEventListener("dblclick", () => renamePart(part.id));
      pbChipsEl.appendChild(chip);
    });
    pbDelete.disabled = parts.length <= 1;
  }

  /** Something changed which part the active track has open. */
  function partChanged() {
    activeRt().view.refresh();
    renderPartBar();
  }

  function selectPart(partId) {
    P.setCurrentPart(project, active, partId);
    partChanged();
  }

  function renamePart(partId) {
    const part = P.part(project, partId);
    const name = prompt("Rename part", part.name);
    if (name === null) return;
    P.renamePart(project, partId, name);
    partChanged();
  }

  pbNew.addEventListener("click", () => { P.addPart(project, active); partChanged(); });
  pbDup.addEventListener("click", () => {
    P.duplicatePart(project, activeRt().track.currentPartId);
    partChanged();
  });
  pbRename.addEventListener("click", () => renamePart(activeRt().track.currentPartId));
  pbDelete.addEventListener("click", () => {
    const part = P.currentPart(project, activeRt().track);
    const used = project.timeline.clips.filter((c) => c.partId === part.id).length;
    const warn = [];
    if (part.notes.length) warn.push(`its ${part.notes.length} notes`);
    if (used) warn.push(`${used} clip(s) in the song`);
    if (warn.length && !confirm(`Delete "${part.name}"? This removes ${warn.join(" and ")}.`)) return;
    P.deletePart(project, part.id);
    partChanged();
  });

  // --- Save / load ---------------------------------------------------

  async function saveCurrent() {
    project.name = (seqNameInput.value || "").trim() || "Untitled song";
    const record = await SoundPad.Store.save(project);
    currentSeqId = record.id;
    seqNameInput.value = record.name;
    renderLibrary();
  }

  async function loadSequence(id) {
    const rec = await SoundPad.Store.get(id);
    if (!rec) return;
    mountProject(P.fromRecord(rec));
    currentSeqId = rec.id;
    seqNameInput.value = project.name;
    renderLibrary();
  }

  async function deleteSequence(id) {
    await SoundPad.Store.remove(id);
    if (currentSeqId === id) currentSeqId = null;
    renderLibrary();
  }

  async function renderLibrary() {
    const list = await SoundPad.Store.all();
    libListEl.innerHTML = "";

    if (!list.length) {
      const empty = document.createElement("li");
      empty.className = "lib-empty";
      empty.textContent = "No saved projects yet — make something and hit Save.";
      libListEl.appendChild(empty);
      return;
    }

    list.forEach((rec) => {
      const li = document.createElement("li");
      li.className = "lib-item" + (rec.id === currentSeqId ? " current" : "");

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = rec.name;

      const meta = document.createElement("span");
      meta.className = "meta";
      const tracks = Array.isArray(rec.tracks) ? rec.tracks.length : 0;
      const parts = Array.isArray(rec.parts) ? rec.parts.length : 0;
      meta.textContent = `${rec.bpm} BPM · ${tracks} tracks · ${parts} parts`;

      const spacer = document.createElement("span");
      spacer.className = "spacer";

      const loadBtn = document.createElement("button");
      loadBtn.className = "load";
      loadBtn.textContent = "Load";
      loadBtn.addEventListener("click", () => loadSequence(rec.id));

      const delBtn = document.createElement("button");
      delBtn.className = "del";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => deleteSequence(rec.id));

      li.append(name, meta, spacer, loadBtn, delBtn);
      libListEl.appendChild(li);
    });
  }

  // --- Playhead + position (decoupled from audio clock) --------------

  /** "Song · Bar 5 · 2" from the player's info (null = stopped). */
  function showPosition(info) {
    const song = player.mode === "song";
    let step;
    if (info) step = info.songStep >= 0 ? info.songStep : info.step;
    else step = song ? P.songRange(project).start : 0;
    const bar = Math.floor(step / P.BAR) + 1;
    const beat = Math.floor((step % P.BAR) / 4) + 1;
    posEl.textContent = `${song ? "Song" : "Pattern"} · Bar ${bar} · ${beat}`;
  }

  function clearPlayheads() {
    rts.forEach((rt) => rt.view.clearPlayhead());
    if (songView) songView.clearPlayhead();
    showPosition(null);
  }

  function drawLoop() {
    requestAnimationFrame(drawLoop);
    if (!engine.isPlaying) return;
    const now = engine.ctx.currentTime;
    let item = null;
    while (engine.drawQueue.length && engine.drawQueue[0].time <= now) item = engine.drawQueue.shift();
    if (!item || !item.info) return;
    const { songStep, locals } = item.info;
    // Each editor lights up its own position (or nothing if its part isn't playing).
    rts.forEach((rt) => rt.view.highlightColumn(locals[rt.track.id] ?? -1));
    songView.setPlayhead(songStep);
    showPosition(item.info);
  }

  // --- Events --------------------------------------------------------

  playBtn.addEventListener("click", togglePlay);
  recBtn.addEventListener("click", toggleRecord);
  clearBtn.addEventListener("click", clearActive);
  songTab.addEventListener("click", () => setActive(SONG));
  modeBtns.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

  bpmInput.addEventListener("change", () => {
    engine.setBpm(parseInt(bpmInput.value, 10));
    bpmInput.value = engine.bpm;
    project.bpm = engine.bpm;
  });
  volumeInput.addEventListener("input", () => engine.setVolume(parseFloat(volumeInput.value)));

  saveBtn.addEventListener("click", saveCurrent);
  seqNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveCurrent(); });

  document.addEventListener("keydown", (e) => {
    if (e.repeat || ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === " ") { e.preventDefault(); togglePlay(); return; }
    if (k === "r") { toggleRecord(); return; }
    const rt = activeRt();
    if (rt && rt.view.handleKey(k)) e.preventDefault();
  });

  // --- Init ----------------------------------------------------------

  // Read-only handle for debugging in the browser console.
  SoundPad.app = {
    get project() { return project; },
    get songView() { return songView; },
    get tracks() { return rts; },
    player,
    engine,
  };

  buildAddMenu();
  storeNoteEl.textContent = SoundPad.Store.backendLabel();
  storeNoteEl.classList.toggle("warn", !SoundPad.Store.useServer);
  engine.setVolume(parseFloat(volumeInput.value));
  mountProject(P.create());
  renderLibrary();
  drawLoop();
})();
