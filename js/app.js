/* ------------------------------------------------------------------
 * Sound Pad — App orchestrator
 * Owns the shared transport, tempo/volume, instrument tabs, save/load,
 * and keyboard routing. Each instrument is a self-contained "view" that
 * implements the same interface; the transport plays them all together,
 * while the tabs just switch which editor is visible.
 * ------------------------------------------------------------------ */
(function () {
  const engine = new SoundPad.Engine();

  const views = {
    drums: new SoundPad.DrumView(engine, document.getElementById("drumsView")),
    bass: new SoundPad.BassView(engine, document.getElementById("bassView")),
  };
  const viewList = Object.values(views);
  let activeInst = "drums";
  let recordArmed = false;

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
  const instBtns = document.querySelectorAll(".inst[data-inst]");

  let currentSeqId = null;

  // --- Transport (drives every instrument together) ------------------

  engine.onStep = (step, time) => viewList.forEach((v) => v.onStep(step, time));

  async function togglePlay() {
    await engine.init();
    if (engine.isPlaying) {
      engine.stop();
      playBtn.textContent = "▶";
      playBtn.classList.remove("on");
      viewList.forEach((v) => v.clearPlayhead());
      lastDrawnStep = -1;
    } else {
      engine.start();
      playBtn.textContent = "■";
      playBtn.classList.add("on");
    }
  }

  function toggleRecord() {
    recordArmed = !recordArmed;
    recBtn.classList.toggle("on", recordArmed);
    // Only the instrument you're looking at records what you play.
    viewList.forEach((v) => (v.recordArmed = false));
    views[activeInst].recordArmed = recordArmed;
    statusHint.textContent = recordArmed
      ? `Recording ${activeInst} — play the pads/keys while it loops`
      : "Press ▶ or Space to start · Arm REC then play to record";
  }

  function clearActive() {
    views[activeInst].clear();
  }

  // --- Instrument tabs ----------------------------------------------

  function setActive(inst) {
    if (!views[inst]) return;
    activeInst = inst;
    instBtns.forEach((b) => b.classList.toggle("active", b.dataset.inst === inst));
    Object.entries(views).forEach(([name, v]) =>
      v.root.classList.toggle("hidden", name !== inst)
    );
    // Record arming follows the visible instrument.
    viewList.forEach((v) => (v.recordArmed = false));
    views[activeInst].recordArmed = recordArmed;
  }

  // --- Save / load ---------------------------------------------------

  async function saveCurrent() {
    const name = (seqNameInput.value || "").trim() || "Untitled beat";
    const record = await SoundPad.Store.save({
      name,
      bpm: engine.bpm,
      steps: engine.steps,
      instruments: {
        drums: views.drums.getPattern(),
        bass: views.bass.getPattern(),
      },
    });
    currentSeqId = record.id;
    seqNameInput.value = record.name;
    renderLibrary();
  }

  async function loadSequence(id) {
    const rec = await SoundPad.Store.get(id);
    if (!rec) return;

    // New format uses `instruments`; fall back to the old drums-only `pattern`.
    const inst = rec.instruments || { drums: rec.pattern || {}, bass: {} };
    views.drums.setPattern(inst.drums || {});
    views.bass.setPattern(inst.bass || {});

    engine.setBpm(rec.bpm || engine.bpm);
    bpmInput.value = engine.bpm;

    currentSeqId = rec.id;
    seqNameInput.value = rec.name;
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
      empty.textContent = "No saved sequences yet — build a beat and hit Save.";
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
      meta.textContent = `${rec.bpm} BPM`;

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
      viewList.forEach((v) => v.highlightColumn(step));
      lastDrawnStep = step;
    }
  }

  // --- Events --------------------------------------------------------

  playBtn.addEventListener("click", togglePlay);
  recBtn.addEventListener("click", toggleRecord);
  clearBtn.addEventListener("click", clearActive);
  instBtns.forEach((b) =>
    b.addEventListener("click", () => { if (!b.disabled) setActive(b.dataset.inst); })
  );

  bpmInput.addEventListener("change", () => {
    engine.setBpm(parseInt(bpmInput.value, 10));
    bpmInput.value = engine.bpm;
  });
  volumeInput.addEventListener("input", () => engine.setVolume(parseFloat(volumeInput.value)));

  saveBtn.addEventListener("click", saveCurrent);
  seqNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") saveCurrent(); });

  document.addEventListener("keydown", (e) => {
    if (e.repeat || e.target.tagName === "INPUT") return;
    const k = e.key.toLowerCase();
    if (k === " ") { e.preventDefault(); togglePlay(); return; }
    if (k === "r") { toggleRecord(); return; }
    if (views[activeInst].handleKey(k)) e.preventDefault();
  });

  // --- Init ----------------------------------------------------------

  document.documentElement.style.setProperty("--steps", engine.steps);
  storeNoteEl.textContent = SoundPad.Store.backendLabel();
  storeNoteEl.classList.toggle("warn", !SoundPad.Store.useServer);
  viewList.forEach((v) => v.build());
  setActive("drums");
  renderLibrary();
  drawLoop();
})();
