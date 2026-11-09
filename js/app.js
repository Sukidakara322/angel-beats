/* ------------------------------------------------------------------
 * Sound Pad — App orchestrator
 * Owns the current Project and wires it to audio + UI:
 *   • for every track: a Channel (volume/pan), an Instrument (from the
 *     registry) and an editor view, plus a tab in the top bar
 *   • the shared transport (play / record / tempo / volume)
 *   • save / load, keyboard routing, playhead drawing
 * The Player decides what to play on each step; views only edit parts.
 * ------------------------------------------------------------------ */
(function () {
  const P = SoundPad.Project;
  const engine = new SoundPad.Engine();
  const player = new SoundPad.Player(engine);
  engine.onStep = (step, time) => player.onStep(step, time);

  let project = null;
  let rts = [];               // per-track runtime: { track, channel, instrument, view, root, tab }
  let activeTrackId = null;
  let recordArmed = false;
  let currentSeqId = null;

  // DOM refs
  const playBtn = document.getElementById("playBtn");
  const recBtn = document.getElementById("recBtn");
  const clearBtn = document.getElementById("clearBtn");
  const bpmInput = document.getElementById("bpm");
  const volumeInput = document.getElementById("volume");
  const statusHint = document.getElementById("statusHint");
  const seqNameInput = document.getElementById("seqName");
  const saveBtn = document.getElementById("saveBtn");
  const libListEl = document.getElementById("libList");
  const storeNoteEl = document.getElementById("storeNote");
  const tabsEl = document.getElementById("trackTabs");
  const viewsEl = document.getElementById("views");

  const IDLE_HINT = "Press ▶ or Space to start · Arm REC then play to record";

  const activeRt = () => rts.find((rt) => rt.track.id === activeTrackId);

  // --- Mounting a project -------------------------------------------

  /** Tear down the old project's tracks and build the new one's. */
  function mountProject(next) {
    // Remember which kind of track was open so a load keeps that tab.
    const prevType = activeRt()?.track.type;

    rts.forEach((rt) => {
      rt.view.destroy();
      rt.root.remove();
      rt.tab.remove();
      rt.channel.dispose();
    });

    project = next;
    engine.setBpm(project.bpm);
    project.bpm = engine.bpm;
    bpmInput.value = engine.bpm;
    document.documentElement.style.setProperty("--steps", project.partSteps);

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
      const view = new View({ engine, root, project, track, instrument });
      view.build();

      const tab = document.createElement("button");
      tab.className = "inst";
      tab.textContent = track.name;
      tab.addEventListener("click", () => setActive(track.id));
      tabsEl.appendChild(tab);

      return { track, channel, instrument, view, root, tab };
    });

    player.setProject(project, rts);
    lastDrawnStep = -1;

    const keep = rts.find((rt) => rt.track.type === prevType) || rts[0];
    setActive(keep.track.id);
  }

  // --- Transport ----------------------------------------------------

  async function togglePlay() {
    await engine.init();
    if (engine.isPlaying) {
      engine.stop();
      playBtn.textContent = "▶";
      playBtn.classList.remove("on");
      rts.forEach((rt) => rt.view.clearPlayhead());
      lastDrawnStep = -1;
    } else {
      engine.start();
      playBtn.textContent = "■";
      playBtn.classList.add("on");
    }
  }

  function applyRecordArm() {
    rts.forEach((rt) => (rt.view.recordArmed = recordArmed && rt.track.id === activeTrackId));
    const rt = activeRt();
    statusHint.textContent = recordArmed && rt
      ? `Recording ${rt.track.name} — play the pads/keys while it loops`
      : IDLE_HINT;
  }

  function toggleRecord() {
    recordArmed = !recordArmed;
    recBtn.classList.toggle("on", recordArmed);
    applyRecordArm();
  }

  function clearActive() {
    const rt = activeRt();
    if (rt) rt.view.clear();
  }

  // --- Track tabs ----------------------------------------------------

  function setActive(trackId) {
    activeTrackId = trackId;
    rts.forEach((rt) => {
      const on = rt.track.id === trackId;
      rt.tab.classList.toggle("active", on);
      rt.root.classList.toggle("hidden", !on);
    });
    applyRecordArm();   // record arming follows the visible track
  }

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
      const trackCount = rec.tracks ? rec.tracks.length : 2;
      meta.textContent = `${rec.bpm} BPM · ${trackCount} tracks`;

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

  // --- Playhead animation (decoupled from audio clock) ---------------

  let lastDrawnStep = -1;
  function drawLoop() {
    requestAnimationFrame(drawLoop);
    const now = engine.ctx ? engine.ctx.currentTime : 0;
    let step = lastDrawnStep;
    while (engine.drawQueue.length && engine.drawQueue[0].time <= now) {
      step = engine.drawQueue.shift().step;
    }
    if (step !== lastDrawnStep && engine.isPlaying) {
      const local = step % project.partSteps;
      rts.forEach((rt) => rt.view.highlightColumn(local));
      lastDrawnStep = step;
    }
  }

  // --- Events --------------------------------------------------------

  playBtn.addEventListener("click", togglePlay);
  recBtn.addEventListener("click", toggleRecord);
  clearBtn.addEventListener("click", clearActive);

  bpmInput.addEventListener("change", () => {
    engine.setBpm(parseInt(bpmInput.value, 10));
    bpmInput.value = engine.bpm;
    project.bpm = engine.bpm;
  });
  volumeInput.addEventListener("input", () => engine.setVolume(parseFloat(volumeInput.value)));

  saveBtn.addEventListener("click", saveCurrent);
  seqNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveCurrent(); });

  document.addEventListener("keydown", (e) => {
    if (e.repeat || e.target.tagName === "INPUT") return;
    const k = e.key.toLowerCase();
    if (k === " ") { e.preventDefault(); togglePlay(); return; }
    if (k === "r") { toggleRecord(); return; }
    const rt = activeRt();
    if (rt && rt.view.handleKey(k)) e.preventDefault();
  });

  // --- Init ----------------------------------------------------------

  storeNoteEl.textContent = SoundPad.Store.backendLabel();
  storeNoteEl.classList.toggle("warn", !SoundPad.Store.useServer);
  engine.setVolume(parseFloat(volumeInput.value));
  mountProject(P.create());
  renderLibrary();
  drawLoop();
})();
