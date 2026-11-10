/* ------------------------------------------------------------------
 * Sound Pad — Param panel ("Sound controls")
 * Renders an instrument's adjustable parameters from a plain schema, in
 * groups (e.g. Amp / Guitar / Playing):
 *
 *   { group, id, label, type: "toggle" }
 *   { group, id, label, type: "range", min, max, step, unit: "%"|"dB"|"ms" }
 *   { group, id, label, type: "select", options: [[value, label], …] }     (buttons)
 *   { group, id, label, type: "dropdown", options: [[value, label], …] }   (a <select>, for long lists)
 *   range units: "%" | "dB" | "ms" | "Hz" | "s"
 *
 *   new ParamPanel(host, {
 *     schema (array, or () => array for options that change),
 *     values: () => effective values, edited: () => bool,
 *     onChange(id, value, commit),   // commit = false while a slider drags
 *     onReset(),
 *     title, texts: { edited, clean, reset }   // optional wording
 *   })
 * Any instrument that registers a `params` schema gets this panel; the
 * mixer uses it for track effects and the Reverb / Delay buses.
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.ParamPanel = class ParamPanel {
  constructor(host, { schema, values, edited, onChange, onReset, title = "Sound controls", texts = {} }) {
    this.host = host;
    this.schema = schema;
    this.values = values;
    this.edited = edited || (() => false);
    this.onChange = onChange;
    this.onReset = onReset || (() => {});
    this.title = title;
    this.texts = { edited: "edited — saved with this track", clean: "preset values", reset: "Reset to preset", ...texts };
  }

  _fmt(item, v) {
    if (item.unit === "%") return Math.round(v * 100) + "%";
    if (item.unit === "dB") return (v > 0 ? "+" : "") + v + " dB";
    if (item.unit === "ms") return v + " ms";
    if (item.unit === "Hz") return v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + " kHz" : v + " Hz";
    if (item.unit === "s") return v.toFixed(1) + " s";
    return String(v);
  }

  render() {
    const vals = this.values();
    const schema = typeof this.schema === "function" ? this.schema() : this.schema;
    this.host.innerHTML = "";
    this.host.classList.add("param-panel");

    const head = document.createElement("div");
    head.className = "pp-head";
    head.innerHTML = `<h3></h3><span class="pp-edited"></span>`;
    head.querySelector("h3").textContent = this.title;
    head.querySelector(".pp-edited").textContent = this.edited() ? this.texts.edited : this.texts.clean;
    const reset = document.createElement("button");
    reset.className = "tbtn small";
    reset.textContent = this.texts.reset;
    reset.disabled = !this.edited();
    reset.addEventListener("click", () => this.onReset());
    head.appendChild(reset);
    this.host.appendChild(head);

    const body = document.createElement("div");
    body.className = "pp-body";
    const groups = new Map();
    schema.forEach((item) => {
      if (!groups.has(item.group)) {
        const g = document.createElement("div");
        g.className = "pp-group";
        g.innerHTML = `<h4>${item.group}</h4>`;
        groups.set(item.group, g);
        body.appendChild(g);
      }
      groups.get(item.group).appendChild(this._control(item, vals[item.id]));
    });
    this.host.appendChild(body);
  }

  _control(item, value) {
    const row = document.createElement("div");
    row.className = "pp-row pp-" + item.type;
    row.dataset.param = item.id;
    const label = document.createElement("span");
    label.className = "pp-label";
    label.textContent = item.label;
    row.appendChild(label);

    if (item.type === "toggle") {
      const b = document.createElement("button");
      b.className = "pp-switch" + (value ? " on" : "");
      b.textContent = value ? "ON" : "OFF";
      b.addEventListener("click", () => this.onChange(item.id, !value, true));
      row.appendChild(b);
    } else if (item.type === "select") {
      const seg = document.createElement("div");
      seg.className = "pp-seg";
      item.options.forEach(([v, text]) => {
        const b = document.createElement("button");
        b.textContent = text;
        b.classList.toggle("on", v === value);
        b.addEventListener("click", () => { if (v !== value) this.onChange(item.id, v, true); });
        seg.appendChild(b);
      });
      row.appendChild(seg);
    } else if (item.type === "dropdown") {
      const sel = document.createElement("select");
      sel.className = "pp-select";
      item.options.forEach(([v, text]) => {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = text;
        sel.appendChild(o);
      });
      sel.value = value;
      sel.addEventListener("change", () => this.onChange(item.id, sel.value, true));
      row.appendChild(sel);
    } else {
      const input = document.createElement("input");
      input.type = "range";
      input.min = item.min; input.max = item.max; input.step = item.step;
      input.value = value;
      const out = document.createElement("span");
      out.className = "pp-value";
      out.textContent = this._fmt(item, value);
      input.addEventListener("input", () => {
        const v = parseFloat(input.value);
        out.textContent = this._fmt(item, v);
        this.onChange(item.id, v, false);
      });
      input.addEventListener("change", () => this.onChange(item.id, parseFloat(input.value), true));
      row.append(input, out);
    }
    return row;
  }
};
