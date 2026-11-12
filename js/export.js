/* ------------------------------------------------------------------
 * Sound Pad — WAV export
 * Renders the whole song (bar 1 → song end, ignoring the loop region)
 * offline, faster than real time, through exactly the same parts as live
 * playback: Player → instruments → Channels (EQ, comp, chorus, sidechain,
 * sends) → Reverb / Delay buses → master fader → limiter.
 * A Lines project renders every line from bar 1 to its last note's bar.
 * Mute / solo are respected (you export what you hear). The transport's
 * Volume slider is a monitor knob and is NOT part of the export.
 *
 *   const { blob, seconds } = await SoundPad.Export.wav(project)
 * ------------------------------------------------------------------ */
window.SoundPad = window.SoundPad || {};

SoundPad.Export = {
  SAMPLE_RATE: 44100,
  LEAD_IN: 0.02,      // s of silence before bar 1
  MAX_TAIL: 6,        // s rendered after the song end for reverb / delay tails (trimmed when silent)

  /** Render the song → { buffer: AudioBuffer, songEnd: seconds where the last bar ends }. */
  async render(project, sampleRate = this.SAMPLE_RATE) {
    const P = SoundPad.Project, L = SoundPad.Lines;
    const lines = L.isLines(project);   // a Lines project: every line from bar 1
    const last = lines ? L.end(project) : P.songEnd(project);
    if (!last) throw new Error(lines ? "Nothing to export — write some notes first." : "The song is empty — place some parts on the timeline first.");
    const end = P._ceilBar(last);

    const engine = new SoundPad.Engine();
    engine.setBpm(project.bpm);
    const sps = engine.secondsPerStep();
    const songEnd = this.LEAD_IN + end * sps;
    const ctx = new OfflineAudioContext(2, Math.ceil((songEnd + this.MAX_TAIL) * sampleRate), sampleRate);
    engine.initOffline(ctx, project.mix);

    const tracks = project.tracks.map((track) => {
      const def = SoundPad.Instruments.get(track.type);
      const channel = new SoundPad.Channel(engine, track);
      const instrument = def.create(engine, channel, track.preset, track.params);
      return { track, channel, instrument };
    });
    const player = new SoundPad.Player(engine);
    player.range = { start: 0, end };
    player.setProject(project, tracks);
    player.setMode(lines ? "lines" : "song");
    for (let s = 0; s < end; s++) player.onStep(s, this.LEAD_IN + s * sps);

    const buffer = await ctx.startRendering();
    return { buffer, songEnd };
  },

  /** Where the sound really ends: after the last bar, once the tails fall below −70 dB. */
  _endFrame(buffer, songEnd) {
    const min = Math.floor(songEnd * buffer.sampleRate);
    const chans = [...Array(buffer.numberOfChannels)].map((_, c) => buffer.getChannelData(c));
    for (let i = buffer.length - 1; i > min; i--) {
      if (chans.some((d) => Math.abs(d[i]) > 3e-4)) return Math.min(buffer.length, i + Math.round(buffer.sampleRate * 0.1));
    }
    return Math.min(buffer.length, min);
  },

  /** 16-bit stereo PCM WAV of the first `frames` frames (short fade-out at the end). */
  toWav(buffer, frames = buffer.length) {
    const ch = buffer.numberOfChannels, sr = buffer.sampleRate;
    const data = [...Array(ch)].map((_, c) => buffer.getChannelData(c));
    const bytes = frames * ch * 2;
    const view = new DataView(new ArrayBuffer(44 + bytes));
    const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
    str(0, "RIFF"); view.setUint32(4, 36 + bytes, true); str(8, "WAVE");
    str(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, ch, true);
    view.setUint32(24, sr, true); view.setUint32(28, sr * ch * 2, true); view.setUint16(32, ch * 2, true); view.setUint16(34, 16, true);
    str(36, "data"); view.setUint32(40, bytes, true);
    const fade = Math.min(frames, Math.round(sr * 0.05));
    let o = 44;
    for (let i = 0; i < frames; i++) {
      const g = i >= frames - fade ? (frames - i) / fade : 1;
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, data[c][i] * g));
        view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([view], { type: "audio/wav" });
  },

  /** Render + encode. → { blob, seconds, peak } */
  async wav(project) {
    const { buffer, songEnd } = await this.render(project);
    const frames = this._endFrame(buffer, songEnd);
    let peak = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(d[i]));
    }
    return { blob: this.toWav(buffer, frames), seconds: frames / buffer.sampleRate, peak };
  },

  /** Save a blob as a file (browser download). */
  download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  },
};
