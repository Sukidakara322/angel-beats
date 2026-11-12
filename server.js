/* ------------------------------------------------------------------
 * Sound Pad — local server (zero dependencies)
 * Serves the app AND stores saved sequences as real files in ./storage.
 * Run with:  node server.js   (or double-click start.bat)
 * Then open: http://localhost:5188
 * ------------------------------------------------------------------ */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const STORAGE = path.join(ROOT, "storage");
const PORT = process.env.PORT || 5188;

fs.mkdirSync(STORAGE, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

// --- Storage helpers -------------------------------------------------

function readAll() {
  return fs
    .readdirSync(STORAGE)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(STORAGE, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

function safeId() {
  return "seq_" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}

function saveSequence(seq) {
  const all = readAll();
  // Same name (and same kind: Patterns / Lines) overwrites in place, so re-saving updates one file.
  const kind = (s) => s.kind || "patterns";
  const existing = all.find((s) => s.name === seq.name && kind(s) === kind(seq));
  const record = Object.assign({}, seq, {
    id: existing ? existing.id : safeId(),
    savedAt: Date.now(),
  });
  fs.writeFileSync(path.join(STORAGE, record.id + ".json"), JSON.stringify(record, null, 2));
  return record;
}

function removeSequence(id) {
  // Only touch our own generated ids; never let a path escape ./storage.
  if (!/^seq_[a-z0-9]+$/i.test(id)) return;
  const file = path.join(STORAGE, id + ".json");
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

// --- Request helpers -------------------------------------------------

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 5e6) reject(new Error("payload too large")); // 5 MB guard
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { // block path traversal
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      // The app is edited while it runs: never let the browser reuse an old copy of a
      // file, or it can end up mixing old and new scripts (e.g. an old app.js with a new player.js).
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

// --- Server ----------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  // API: /api/sequences  and  /api/sequences/<id>
  if (url.startsWith("/api/sequences")) {
    try {
      if (req.method === "GET" && url === "/api/sequences") {
        return sendJson(res, 200, readAll());
      }
      if (req.method === "POST" && url === "/api/sequences") {
        const body = await readBody(req);
        const record = saveSequence(JSON.parse(body));
        return sendJson(res, 200, record);
      }
      if (req.method === "DELETE" && url.startsWith("/api/sequences/")) {
        removeSequence(url.slice("/api/sequences/".length));
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { error: "unknown endpoint" });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log("\n  🥁 Sound Pad running");
  console.log("  → open http://localhost:" + PORT);
  console.log("  → sequences are saved as files in ./storage\n");
});
