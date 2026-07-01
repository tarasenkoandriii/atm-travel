// reel.manifest.mjs — browser ESM port of the auto-montage manifest (from manifest.js).
// Same schema/logic; buildFilterComplex output feeds ffmpeg.wasm (filter uses input indices only).

export const SHOT_TYPES   = ['establishing', 'hero', 'human_detail', 'emotional_peak'];
export const SEGMENT_KIND = ['intro', 'clip', 'livecam'];
export const PROVIDERS    = ['mediarecorder', 'pexels', 'pixabay', 'coverr', 'mixkit', 'atm_livecam'];

// Dependency-free lint before ffmpeg.
export function validateManifest(m) {
  const errors = [];
  const req = (cond, msg) => { if (!cond) errors.push(msg); };
  req(m && typeof m === 'object', 'манифест не объект');
  if (!m) return errors;
  req(Array.isArray(m.render?.formats) && m.render.formats.length > 0, 'render.formats пуст');
  req(Array.isArray(m.audio?.beats) && m.audio.beats.length >= 2, 'audio.beats < 2');
  req(Array.isArray(m.timeline) && m.timeline.length > 0, 'timeline пуст');
  if (!Array.isArray(m.timeline)) return errors;
  let prevEnd = null;
  m.timeline.forEach((s, i) => {
    const at = `timeline[${i}]`;
    req(SEGMENT_KIND.includes(s.kind), `${at}: kind '${s.kind}' невалиден`);
    if (s.kind === 'clip') req(SHOT_TYPES.includes(s.shot), `${at}: clip без валидного shot`);
    req(PROVIDERS.includes(s.source?.provider), `${at}: provider невалиден`);
    req(s.outEnd > s.outStart, `${at}: outEnd <= outStart`);
    req(s.srcOut > s.srcIn, `${at}: srcOut <= srcIn`);
    const outDur = +(s.outEnd - s.outStart).toFixed(3);
    const srcDur = +(s.srcOut - s.srcIn).toFixed(3);
    req(outDur === srcDur, `${at}: длительность out(${outDur}) ≠ src(${srcDur})`);
    if (prevEnd !== null) req(Math.abs(s.outStart - prevEnd) < 1e-6, `${at}: разрыв ленты (${prevEnd} → ${s.outStart})`);
    prevEnd = s.outEnd;
  });
  return errors;
}

export function checkBeatAlignment(m, tolerance = 0.06) {
  const beats = m.audio.beats;
  const near = (t) => beats.some((b) => Math.abs(b - t) <= tolerance);
  const bad = [];
  m.timeline.forEach((s, i) => {
    if (!near(s.outStart)) bad.push({ seg: i, edge: 'start', t: s.outStart });
    if (!near(s.outEnd))   bad.push({ seg: i, edge: 'end',   t: s.outEnd });
  });
  return bad;
}

// Derive ffmpeg filter_complex for one crop. Filter references input indices only ([i:v], idx:a),
// so it is agnostic to the on-disk filenames ffmpeg.wasm uses. LUT optional (off by default in wasm).
export function buildFilterComplex(m, formatName, opts = {}) {
  const fmt = m.render.formats.find((f) => f.name === formatName);
  if (!fmt) throw new Error(`формат ${formatName} не найден`);
  const { w, h } = fmt;
  const fps = m.render.fps;
  const pix = m.render.pixelFormat || 'yuv420p';
  const useLut = opts.lut && m.render.lut;
  const lut = useLut ? `,lut3d=${m.render.lut}` : '';

  const inputs = m.timeline.map((s) => s.source.url || s.source.id);
  const hasOverlay = !!(m.overlay && m.overlay.source);
  const hasMusic = !!(m.audio && m.audio.track);
  // input indices computed from actual pushes (overlay/music are optional)
  let nextIdx = m.timeline.length;
  let overlayIdx = -1, musicIdx = -1;
  if (hasOverlay) { overlayIdx = nextIdx++; inputs.push(m.overlay.source); }
  if (hasMusic) { musicIdx = nextIdx++; inputs.push(m.audio.track); }

  const parts = [], labels = [];
  m.timeline.forEach((s, i) => {
    const l = `v${i}`;
    parts.push(
      `[${i}:v]trim=${s.srcIn}:${s.srcOut},setpts=PTS-STARTPTS,` +
      `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},` +
      `fps=${fps},format=${pix}${lut}[${l}]`
    );
    labels.push(`[${l}]`);
  });
  parts.push(`${labels.join('')}concat=n=${m.timeline.length}:v=1:a=0[base]`);

  let outLabel = '[base]';
  if (hasOverlay) {
    const oEnd = m.overlay.endAt ?? m.timeline[m.timeline.length - 1].outEnd;
    parts.push(
      `[${overlayIdx}:v]scale=${w}:${h},format=rgba[ovl];` +
      `[base][ovl]overlay=0:0:enable='between(t,${m.overlay.startAt},${oEnd})'[outv]`
    );
    outLabel = '[outv]';
  }

  const maps = ['-map', outLabel];
  if (hasMusic) maps.push('-map', `${musicIdx}:a`);
  const encode = ['-c:v', 'libx264', '-preset', opts.preset || 'veryfast', '-crf', String(m.render.crf ?? 20), '-pix_fmt', pix];
  if (hasMusic) { encode.push('-c:a', 'aac', '-b:a', '128k', '-shortest'); }

  return { inputs, filter: parts.join(';'), maps, encode, hasOverlay, hasMusic, overlayIdx, musicIdx, nextIdx, outLabel };
}

// ── Auto-build a manifest from simple inputs (for "everything automatic") ──
// clips: [{url, shot?, tags?, attribution?}], beats derived from bpm. Segments snap to the beat grid.
export function buildDefaultManifest({ destination, formats, fps = 30, bpm = 120, music = '', overlay = '',
  introSec = 2.5, clipSec = 2.0, liveSec = 2.0, clips = [], livecam = null, lut = '' }) {
  const beatDur = 60 / bpm;
  // build a dense beat grid up to a safe length
  const totalGuess = introSec + clips.length * clipSec + (livecam ? liveSec : 0) + 4;
  const beats = []; for (let t = 0; t <= totalGuess; t += beatDur) beats.push(+t.toFixed(3));

  const snap = (t) => beats.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a), beats[0]);
  const timeline = [];
  let cursor = 0;
  const push = (seg, wantDur) => {
    const start = snap(cursor);
    let end = snap(start + wantDur);
    if (end <= start) end = +(start + beatDur).toFixed(3);
    seg.outStart = start; seg.outEnd = end;
    seg.srcOut = seg.srcIn + +(end - start).toFixed(3);
    seg.beatIndex = beats.indexOf(start);
    timeline.push(seg); cursor = end;
  };

  push({ kind: 'intro', source: { provider: 'mediarecorder', id: 'globe-' + (destination.id || 'geo') }, srcIn: 0, transition: 'cut' }, introSec);
  const shots = ['establishing', 'hero', 'human_detail', 'emotional_peak'];
  clips.forEach((c, i) => push({
    kind: 'clip', shot: c.shot || shots[i % shots.length],
    source: { provider: c.provider || 'pexels', id: c.id || String(i), url: c.url, tags: c.tags || [], attribution: c.attribution || '' },
    srcIn: c.srcIn ?? 1.0, transition: 'cut',
  }, clipSec));
  if (livecam) push({
    kind: 'livecam',
    source: { provider: 'atm_livecam', id: livecam.id || 'cam', url: livecam.url },
    srcIn: 0, transition: 'cut',
  }, liveSec);

  return {
    version: '1.0',
    geo: { targets: ['UA'], language: 'uk' },
    destination,
    render: { fps, lut, pixelFormat: 'yuv420p', crf: 20, formats },
    audio: { track: music, bpm, offset: 0, gainDb: -3, beats },
    timeline,
    overlay: overlay ? { source: overlay, startAt: timeline[1]?.outStart ?? introSec, endAt: cursor } : { source: '', startAt: 0 },
  };
}
