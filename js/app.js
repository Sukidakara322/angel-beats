/* ------------------------------------------------------------------
 * Sound Pad — App orchestrator
 * Owns the current Project and wires it to audio + UI:
 *   • for every track: a Channel (mixer strip: EQ, comp, chorus, sidechain,
 *     fader, pan, sends), an Instrument (from the registry) and an editor
 *     view, plus a tab in the top bar
 *   • "+ Add track", and the track bar (sound / rename / delete track)
 *   • the Song tab (timeline) and the Mixer tab. What plays follows the open
 *     tab: a track tab loops only its open part, Song / Mixer play the song
 *   • WAV export of the song
 *   • the shared transport (play / record / tempo / volume / position)
 *   • parts bar, save / load, keyboard routing, playhead drawing
 * The Player decides what to play on each step; views only edit data.
 *
 * Two kinds of projects, picked with the Patterns | Lines switch:
 *   Patterns — tracks with parts, arranged on the Song timeline (above)
 *   Lines    — every instrument is one line of notes on one timeline
 *              (SoundPad.Lines + LinesView): tabs Lines + Mixer, saved as
 *              its own kind of record
 * Each mode keeps its open project in memory, so switching loses nothing.
 * ------------------------------------------------------------------ */
(function () {
  const P = SoundPad.Project;
  const L = SoundPad.Lines;
  const engine = new SoundPad.Engine();
  const player = new SoundPad.Player(engine);
  engine.onStep = (step, time) => player.onStep(step, time);

  const SONG = "song";        // id of the Song tab (track tabs use track ids)
  const MIXER = "mixer";      // id of the Mixer tab
  const LINES = "lines";      // id of the Lines tab (Lines projects)

  let project = null;
  let rts = [];               // per-track runtime: { track, channel, instrument, view, root, tab } (Lines: no view/root/tab)
  let songView = null;
  let mixerView = null;
  let linesView = null;
  let active = null;          // track id, SONG, MIXER or LINES
  let recordArmed = false;
  let currentSeqId = null;
  let mode = "patterns";      // "patterns" | "lines" — the kind of the open project
  // The project each mode had open when you switched away: { project, seqId, active, name }.
  const parked = { patterns: null, lines: null };

  const isLines = () => mode === "lines";

  // DOM refs
  const $ = (id) => document.getElementById(id);
  const playBtn = $("playBtn");
  const recBtn = $("recBtn");
  const clearBtn = $("clearBtn");
  const bpmInput = $("bpm");
  const volumeInput = $("volume");
  const statusHint = $("statusHint");
  const posEl = $("position");
  const seqNameInput = $("seqName");
  const saveBtn = $("saveBtn");
  const libListEl = $("libList");
  const storeNoteEl = $("storeNote");
  const tabsEl = $("trackTabs");
  const songTab = $("songTab");
  const mixerTab = $("mixerTab");
  const viewsEl = $("views");
  const songRoot = $("songView");
  const mixerRoot = $("mixerView");
  const exportBtn = $("exportBtn");
  const stageEl = $("stage");
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
  const audioWarn = $("audioWarn");
  const audioWarnText = $("audioWarnText");
  const audioRestart = $("audioRestart");
  const linesTab = $("linesTab");
  const linesRoot = $("linesView");
  const modeBtns = [$("modePatterns"), $("modeLines")];

  const IDLE_HINT = "▶ / Space plays the open tab: a track's part, or the whole song";
  const LINES_HINT = "▶ / Space plays every line together · the keyboard plays the selected line";

  const rtOf = (trackId) => rts.find((rt) => rt.track.id === trackId);
  const activeRt = () => rtOf(active);

  // --- Mounting a project -------------------------------------------

  /**
   * Tear down the old project's tracks and build the new one's (either kind).
   * `want` = the tab to open (default: keep the one that was open).
   */
  function mountProject(next, want) {
    // Remember what was open so a rebuild/load keeps that tab.
    const prevActive = want ?? active;
    const prevType = rtOf(prevActive)?.track.type;

    rts.forEach((rt) => {
      if (rt.view) rt.view.destroy();
      if (rt.root) rt.root.remove();
      if (rt.tab) rt.tab.remove();
      rt.channel.dispose();
    });
    if (songView) songView.destroy();
    if (mixerView) mixerView.destroy();
    if (linesView) linesView.destroy();
    songView = linesView = null;

    project = next;
    mode = L.isLines(project) ? "lines" : "patterns";
    engine.setMix(project.mix);
    engine.setBpm(project.bpm);
    project.bpm = engine.bpm;
    bpmInput.value = engine.bpm;
    applyModeChrome();

    if (isLines()) return mountLines(prevActive);

    rts = project.tracks.map((track) => {
      const def = SoundPad.Instruments.get(track.type);
      const channel = new SoundPad.Channel(engine, track);   // reads the track's volume / pan / fx
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
      const view = new View({ engine, player, root: editorRoot, project, track, instrument, options });
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

    mixerView = new SoundPad.MixerView({
      root: mixerRoot,
      project,
      tracks: rts,
      engine,
      onChange: () => {},     // mute / solo: the Song lanes re-read them when shown
    });
    mixerView.build();

    player.setProject(project, rts);
    clearPlayheads();
    addTrackBtn.disabled = project.tracks.length >= P.MAX_TRACKS;

    if (prevActive === SONG || prevActive === MIXER) return setActive(prevActive);
    const keep = rtOf(prevActive) || rts.find((rt) => rt.track.type === prevType) || rts[0];
    setActive(keep.track.id);
  }

  /** A Lines project: a Channel + instrument per line, the Lines view and the Mixer. */
  function mountLines(prevActive) {
    rts = project.tracks.map((track) => {
      const def = SoundPad.Instruments.get(track.type);
      const channel = new SoundPad.Channel(engine, track);
      const instrument = def.create(engine, channel, track.preset, track.params);
      return { track, channel, instrument };
    });

    linesView = new SoundPad.LinesView({
      root: linesRoot,
      project,
      tracks: rts,
      engine,
      player,
      preview: (rt) => previewSound(rt),
      onAddLine: () => toggleAddMenu(true),
      onDeleteLine: (id) => {
        L.deleteLine(project, id);
        mountProject(project);
      },
    });
    linesView.build();

    mixerView = new SoundPad.MixerView({ root: mixerRoot, project, tracks: rts, engine, onChange: () => {} });
    mixerView.build();

    player.setProject(project, rts);
    clearPlayheads();
    addTrackBtn.disabled = project.tracks.length >= L.MAX_LINES;
    setActive(prevActive === MIXER ? MIXER : LINES);
  }

  /** Top bar for the open project's kind: track tabs + Song (Patterns), or the Lines tab (Lines). */
  function applyModeChrome() {
    const lines = isLines();
    modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    tabsEl.classList.toggle("hidden", lines);
    songTab.classList.toggle("hidden", lines);
    linesTab.classList.toggle("hidden", !lines);
    addTrackBtn.textContent = lines ? "+ Add line" : "+ Add track";
    addTrackBtn.title = lines ? "Add an instrument line" : "Add an instrument track";
  }

  /**
   * Patterns ⇄ Lines. The project you leave stays open in the background
   * (with its name, saved-file link and tab), so coming back loses nothing.
   */
  function switchMode(next) {
    if (next === mode) return;
    showStopped();
    toggleAddMenu(false);
    parked[mode] = { project, seqId: currentSeqId, active, name: seqNameInput.value };
    const back = parked[next];
    parked[next] = null;
    currentSeqId = back ? back.seqId : null;
    seqNameInput.value = back ? back.name : "";
    if (back) mountProject(back.project, back.active);
    else mountProject(next === "lines" ? L.create() : P.create(), next === "lines" ? LINES : "");
    renderLibrary();
  }

  // --- Tabs: tracks + song ------------------------------------------

  /** Show a track editor (its part loops), the Song timeline or the Mixer (both play the song). */
  function setActive(id) {
    active = id;
    const song = id === SONG, mixer = id === MIXER, lines = id === LINES, whole = song || mixer || lines;
    songTab.classList.toggle("active", song);
    mixerTab.classList.toggle("active", mixer);
    linesTab.classList.toggle("active", lines);
    stageEl.classList.toggle("wide", whole);     // timeline / lines / mixer use the full window width
    songRoot.classList.toggle("hidden", !song);
    linesRoot.classList.toggle("hidden", !lines);
    mixerRoot.classList.toggle("hidden", !mixer);
    partBarEl.classList.toggle("hidden", whole);
    viewsEl.classList.toggle("hidden", whole);
    clearBtn.disabled = mixer;                   // nothing to clear in the mixer
    rts.forEach((rt) => {
      if (!rt.tab) return;
      const on = rt.track.id === id;
      rt.tab.classList.toggle("active", on);
      rt.root.classList.toggle("hidden", !on);
    });
    // What plays follows the tab: a track tab loops only its open part, Song / Mixer play the song.
    // A Lines project always plays all its lines.
    if (isLines()) player.setMode("lines");
    else player.setMode(whole ? "song" : "pattern", whole ? null : id);
    clearPlayheads();
    if (song) songView.render();         // parts / mute / solo may have changed elsewhere
    else if (lines) linesView.render();
    else if (mixer) mixerView.render();
    else renderPartBar();
    applyRecordArm();      // record arming follows the visible track
  }

  /** Jump from a timeline cell to that part in its track editor. */
  function openPart(trackId, partId) {
    P.setCurrentPart(project, trackId, partId);
    setActive(trackId);
    rtOf(trackId).view.refresh();
  }

  // --- Audio problems ------------------------------------------------

  const PROBLEM_TEXT = {
    error: (m) => `A note failed to play (${m}). Playback goes on — if it sounds wrong, restart audio.`,
    suspended: (m) => `No sound: ${m}. Trying to resume — if it stays silent, restart audio.`,
    stalled: (m) => `No sound: ${m} (output device changed or busy?). Restart audio to get it back.`,
    invalid: (m) => `No sound: ${m}. Restart audio to get it back.`,
  };

  engine.onProblem = (kind, message) => {
    if (!kind) { audioWarn.classList.add("hidden"); return; }   // recovered on its own
    audioWarnText.textContent = (PROBLEM_TEXT[kind] || PROBLEM_TEXT.error)(message);
    audioWarn.classList.remove("hidden");
  };

  /** New audio context + every track's instrument rebuilt on it. The song itself is untouched. */
  async function restartAudio() {
    audioRestart.disabled = true;
    showStopped();
    await engine.restart();
    mountProject(project);
    audioWarn.classList.add("hidden");
    audioRestart.disabled = false;
    const rt = activeRt();
    if (rt) previewSound(rt);           // proof it's back
  }
  audioRestart.addEventListener("click", restartAudio);

  // Errors outside the scheduler (note previews, live keys…) are shown too, not just logged.
  window.addEventListener("error", (e) => {
    // Chrome's "ResizeObserver loop…" notice is harmless (a view resized itself while being measured).
    if (/ResizeObserver loop/.test(e.message || "")) return;
    engine._report("error", e.message || "script error");
  });
  window.addEventListener("unhandledrejection", (e) => engine._report("error", (e.reason && e.reason.message) || String(e.reason)));

  // --- Transport ----------------------------------------------------

  function showStopped() {
    engine.stop();
    playBtn.textContent = "▶";
    playBtn.classList.remove("on");
    clearPlayheads();
  }

  async function togglePlay() {
    await engine.init();
    if (engine.isPlaying) {
      showStopped();
    } else {
      player.sync();
      engine.start();
      playBtn.textContent = "■";
      playBtn.classList.add("on");
    }
  }

  function applyRecordArm() {
    rts.forEach((rt) => { if (rt.view) rt.view.recordArmed = recordArmed && rt.track.id === active; });
    if (linesView) linesView.recordArmed = recordArmed && active === LINES;
    const rt = activeRt();
    if (!recordArmed) statusHint.textContent = isLines() ? LINES_HINT : IDLE_HINT;
    else if (rt) statusHint.textContent = `Recording ${rt.track.name} — play the pads/keys while it loops`;
    else if (active === LINES) statusHint.textContent = "Recording into the selected line — play its keys while the song plays";
    else statusHint.textContent = isLines()
      ? "Recording works in the Lines tab — open it to record"
      : "Recording works in a track tab — open a track to record";
  }

  function toggleRecord() {
    recordArmed = !recordArmed;
    recBtn.classList.toggle("on", recordArmed);
    applyRecordArm();
  }

  function clearActive() {
    if (active === MIXER) return;
    if (active === LINES) { linesView.clearSelected(); return; }
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
    if (isLines()) {
      if (project.tracks.length >= L.MAX_LINES) return;
      const line = L.addLine(project, type, type === "drums" ? "Drums" : name, preset);
      SoundPad.LinesView.prefs.selected = line.id;      // the new line opens selected
      mountProject(project, LINES);
      previewSound(rtOf(line.id));
      return;
    }
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
    if (!rt || !rt.view) return;
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
    if (!rt || !rt.view) return;
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
    player.sync();                              // the loop is now this part's length
    if (!engine.isPlaying) showPosition(null);  // its name is in the position box
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
    // A Lines project is saved as its own kind of record: one entry per line.
    const record = await SoundPad.Store.save(isLines() ? L.toRecord(project) : project);
    currentSeqId = record.id;
    seqNameInput.value = record.name;
    renderLibrary();
  }

  /** Render the whole song offline and download it as a .wav (mix, effects and master included). */
  async function exportWav() {
    if (isLines() ? !L.end(project) : !P.songEnd(project)) {
      statusHint.textContent = isLines()
        ? "Nothing to export yet — write some notes in the lines first"
        : "Nothing to export yet — place parts on the Song timeline first";
      return;
    }
    const name = ((seqNameInput.value || project.name || "").trim() || "Sound Pad song").replace(/[\\/:*?"<>|]+/g, "_");
    exportBtn.disabled = true;
    const label = exportBtn.textContent;
    exportBtn.textContent = "Rendering…";
    try {
      const { blob, seconds, peak } = await SoundPad.Export.wav(project);
      SoundPad.Export.download(blob, `${name}.wav`);
      const m = Math.floor(seconds / 60), s = Math.round(seconds % 60);
      const peakDb = peak > 0 ? (20 * Math.log10(peak)).toFixed(1) : "−∞";
      statusHint.textContent = `Exported "${name}.wav" · ${m}:${String(s).padStart(2, "0")} · peak ${peakDb} dBFS`;
    } catch (err) {
      statusHint.textContent = `Export failed: ${err.message || err}`;
      console.error(err);
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = label;
    }
  }

  async function loadSequence(id) {
    const rec = await SoundPad.Store.get(id);
    if (!rec) return;
    // Loading the other kind switches mode; the project you had open there stays parked.
    const kind = L.isLines(rec) ? "lines" : "patterns";
    if (kind !== mode) {
      showStopped();
      parked[mode] = { project, seqId: currentSeqId, active, name: seqNameInput.value };
      parked[kind] = null;
    }
    mountProject(kind === "lines" ? L.fromRecord(rec) : P.fromRecord(rec), kind !== mode ? (kind === "lines" ? LINES : "") : undefined);
    currentSeqId = rec.id;
    seqNameInput.value = project.name;
    renderLibrary();
  }

  async function deleteSequence(id) {
    await SoundPad.Store.remove(id);
    if (currentSeqId === id) currentSeqId = null;
    Object.values(parked).forEach((w) => { if (w && w.seqId === id) w.seqId = null; });
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

      const lines = L.isLines(rec);
      const kind = document.createElement("span");
      kind.className = "kind " + (lines ? "lines" : "patterns");
      kind.textContent = lines ? "Lines" : "Patterns";
      kind.title = lines ? "Every instrument as one line" : "Parts arranged on the Song timeline";

      const meta = document.createElement("span");
      meta.className = "meta";
      if (lines) {
        const ls = Array.isArray(rec.lines) ? rec.lines : [];
        const notes = ls.reduce((a, l) => a + (Array.isArray(l.notes) ? l.notes.length : 0), 0);
        meta.textContent = `${rec.bpm} BPM · ${ls.length} lines · ${notes} notes`;
      } else {
        const tracks = Array.isArray(rec.tracks) ? rec.tracks.length : 0;
        const parts = Array.isArray(rec.parts) ? rec.parts.length : 0;
        meta.textContent = `${rec.bpm} BPM · ${tracks} tracks · ${parts} parts`;
      }

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

      li.append(kind, name, meta, spacer, loadBtn, delBtn);
      libListEl.appendChild(li);
    });
  }

  // --- Playhead + position (decoupled from audio clock) --------------

  /** "Song · Bar 5 · 2" or "Drums 1 · Bar 2 · 3" (the looping part) from the player's info (null = stopped). */
  function showPosition(info) {
    const song = player.whole;
    let step;
    if (info) step = info.songStep >= 0 ? info.songStep : info.step;
    else if (!song) step = 0;
    else step = (isLines() ? L.range(project) : P.songRange(project)).start;
    const bar = Math.floor(step / P.BAR) + 1;
    const beat = Math.floor((step % P.BAR) / 4) + 1;
    const what = isLines() ? "Lines" : song ? "Song" : player.patternPart()?.name || "Part";
    posEl.textContent = `${what} · Bar ${bar} · ${beat}`;
    posEl.title = isLines() ? "Playing every line together" : song ? "Playing the whole song" : `Playing only "${what}" (this track's open part)`;
  }

  function clearPlayheads() {
    rts.forEach((rt) => { if (rt.view) rt.view.clearPlayhead(); });
    if (songView) songView.clearPlayhead();
    if (linesView) linesView.clearPlayhead();
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
    rts.forEach((rt) => { if (rt.view) rt.view.highlightColumn(locals[rt.track.id] ?? -1); });
    if (songView) songView.setPlayhead(songStep);
    if (linesView) linesView.setPlayhead(songStep);
    showPosition(item.info);
  }

  // --- Events --------------------------------------------------------

  playBtn.addEventListener("click", togglePlay);
  recBtn.addEventListener("click", toggleRecord);
  clearBtn.addEventListener("click", clearActive);
  songTab.addEventListener("click", () => setActive(SONG));
  mixerTab.addEventListener("click", () => setActive(MIXER));
  linesTab.addEventListener("click", () => setActive(LINES));
  modeBtns.forEach((b) => b.addEventListener("click", () => switchMode(b.dataset.mode)));
  exportBtn.addEventListener("click", exportWav);

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
    if (active === LINES) { if (linesView.handleKey(k)) e.preventDefault(); return; }
    const rt = activeRt();
    if (rt && rt.view.handleKey(k)) e.preventDefault();
  });

  // --- Init ----------------------------------------------------------

  // Read-only handle for debugging in the browser console.
  SoundPad.app = {
    get project() { return project; },
    get songView() { return songView; },
    get linesView() { return linesView; },
    get mode() { return mode; },
    switchMode,
    get mixerView() { return mixerView; },
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
