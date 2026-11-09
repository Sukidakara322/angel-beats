/* ------------------------------------------------------------------
 * Sound Pad — Store
 * Two backends, chosen automatically:
 *   • Served from http(s) (the local server) → sequences are real files
 *     in ./storage via the /api/sequences endpoints. Durable + portable.
 *   • Opened as a file:// page (no server) → falls back to localStorage,
 *     which is convenient but fragile (can vanish between sessions).
 * All methods are async so callers don't care which backend is active.
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.Store = {
  KEY: "soundpad.sequences.v1",
  useServer: location.protocol === "http:" || location.protocol === "https:",

  /** Human-readable description of where saves are going. */
  backendLabel() {
    return this.useServer
      ? "Saving to the storage/ folder on disk"
      : "Saving to browser storage — run the server (start.bat) for durable file storage";
  },

  async all() {
    if (this.useServer) {
      try {
        const res = await fetch("/api/sequences");
        return await res.json();
      } catch {
        return [];
      }
    }
    try {
      return JSON.parse(localStorage.getItem(this.KEY) || "[]");
    } catch {
      return [];
    }
  },

  async get(id) {
    const list = await this.all();
    return list.find((s) => s.id === id) || null;
  },

  async save(seq) {
    if (this.useServer) {
      const res = await fetch("/api/sequences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(seq),
      });
      return await res.json();
    }
    return this._saveLocal(seq);
  },

  async remove(id) {
    if (this.useServer) {
      await fetch("/api/sequences/" + encodeURIComponent(id), { method: "DELETE" });
      return;
    }
    this._writeLocal(this._readLocal().filter((s) => s.id !== id));
  },

  // --- localStorage fallback ----------------------------------------

  _readLocal() {
    try {
      return JSON.parse(localStorage.getItem(this.KEY) || "[]");
    } catch {
      return [];
    }
  },

  _writeLocal(list) {
    localStorage.setItem(this.KEY, JSON.stringify(list));
  },

  _saveLocal(seq) {
    const list = this._readLocal();
    const record = Object.assign({}, seq, {
      id: "seq_" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
      savedAt: Date.now(),
    });
    const idx = list.findIndex((s) => s.name === seq.name);
    if (idx !== -1) {
      record.id = list[idx].id;
      list[idx] = record;
    } else {
      list.unshift(record);
    }
    this._writeLocal(list);
    return record;
  },
};
