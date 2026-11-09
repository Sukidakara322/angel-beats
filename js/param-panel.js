/* ------------------------------------------------------------------
 * Sound Pad — Param panel ("Sound controls")
 * Renders an instrument's adjustable parameters from a plain schema, in
 * groups (e.g. Amp / Guitar / Playing):
 *
 *   { group, id, label, type: "toggle" }
 *   { group, id, label, type: "range", min, max, step, unit: "%"|"dB"|"ms" }
 *   { group, id, label, type: "select", options: [[value, label], …] }
 *
 *   new ParamPanel(host, {
 *     schema, values: () => effective values, edited: () => bool,
 *     onChange(id, value, commit),   // commit = false while a slider drags
 *     onReset()
 *   })
 * Any instrument that registers a `params` schema gets this panel.
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.ParamPanel = class ParamPanel {
  constructor(host, { schema, values, edited, onChange, onReset, title = "Sound controls" }) {
    this.host = host;
    this.schema = schema;
    this.values = values;
    this.edited = edited || (() => false);
    this.onChange = onChange;
    this.onReset = onReset || (() => {});
    this.title = title;
  }

  _fmt(item, v) {
    if (item.unit === "%") return Math.round(v * 100) + "%";
    if (item.unit === "dB") return (v > 0 ? "+" : "") + v + " dB";
    if (item.unit === "ms") return v + " ms";
    return String(v);
  }

  render() {
    const vals = this.values();
    this.host.innerHTML = "";
    this.host.classList.add("param-panel");

    const head = document.createElement("div");
    head.className = "pp-head";
    head.innerHTML = `<h3>${this.title}</h3><span class="pp-edited">${this.edited() ? "edited — saved with this track" : "preset values"}</span>`;
    const reset = document.createElement("button");
    reset.className = "tbtn small";
    reset.textContent = "Reset to preset";
    reset.disabled = !this.edited();
    reset.addEventListener("click", () => this.onReset());
    head.appendChild(reset);
    this.host.appendChild(head);

    const body = document.createElement("div");
    body.className = "pp-body";
    const groups = new Map();
    this.schema.forEach((item) => {
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
