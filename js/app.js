/* ------------------------------------------------------------------
 * Sound Pad — App orchestrator
 * Owns the current Project and wires it to audio + UI:
 *   • for every track: a Channel (volume/pan), an Instrument (from the
 *     registry) and an editor view, plus a tab in the top bar
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
      const instrument = def.create(engine, channel);

      const root = document.createElement("div");
      root.className = "inst-view hidden";
      viewsEl.appendChild(root);
      const View = SoundPad[def.editor];
      const view = new View({ engine, root, project, track, instrument, options: def.options });
      view.build();

      const tab = document.createElement("button");
      tab.className = "inst";
      tab.textContent = track.name;
      tab.addEventListener("click", () => setActive(track.id));
      tabsEl.appendChild(tab);

      return { track, channel, instrument, view, root, tab };
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
    else statusHint.textContent = "Recording works in a track tab — open Drums or Bass to record";
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

  // --- Parts (per track) --------------------------------------------

  /** Chips for the active track's parts + enable/disable actions. */
  function renderPartBar() {
    const rt = activeRt();
    if (!rt) return;
    const track = rt.track;
    const parts = P.partsOf(project, track.id);
    pbTrackEl.textContent = `${track.name} parts`;
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

  storeNoteEl.textContent = SoundPad.Store.backendLabel();
  storeNoteEl.classList.toggle("warn", !SoundPad.Store.useServer);
  engine.setVolume(parseFloat(volumeInput.value));
  mountProject(P.create());
  renderLibrary();
  drawLoop();
})();
