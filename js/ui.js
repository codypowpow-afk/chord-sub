// UI: clip / one-shot library, chord strip, generator controls, piano roll, synth modules.
window.CS = window.CS || {};

(function (CS) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const E = CS.E;
  const DPR = () => window.devicePixelRatio || 1;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const copyNotes = (ns) => ns.map((n) => Object.assign({}, n));
  const flats = () => CS.useFlats(S.grid.key, S.grid.mode);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  const newGrid = () => ({ bpm: 120, bars: 4, offset: 0, key: 9, mode: 'min', segBeats: 4, chords: [] });
  const S = (CS.state = {
    clips: [], clip: null, shots: [], shotId: null,
    grid: newGrid(), melody: null,
    gen: Object.assign({}, CS.GEN_DEFAULT),
    synth: CS.patch({}), presetName: 'Pure Sine',
    notes: [], locks: new Set(), seedR: CS.newSeed(), seedN: CS.newSeed(),
    hist: [], histPos: -1, kept: [],
    mix: { mel: 0.8, sub: 0.9, melMute: false, subMute: false },
    sel: -1,
  });

  // ---------- settings ----------
  const LS = 'chordsub.v1', LSP = 'chordsub.presets';
  try {
    const saved = JSON.parse(localStorage.getItem(LS) || 'null');
    if (saved) {
      Object.assign(S.gen, saved.gen || {});
      S.synth = CS.patch(saved.synth || {});
      Object.assign(S.mix, saved.mix || {});
      if (saved.presetName) S.presetName = saved.presetName;
    }
  } catch (e) { /* first run or storage blocked */ }
  let saveT = 0;
  function saveSettings() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      try { localStorage.setItem(LS, JSON.stringify({ gen: S.gen, synth: S.synth, mix: S.mix, presetName: S.presetName })); } catch (e) { /* storage blocked */ }
    }, 300);
  }
  function userPresets() {
    try { return JSON.parse(localStorage.getItem(LSP) || '[]'); } catch (e) { return []; }
  }
  function setUserPresets(list) {
    try { localStorage.setItem(LSP, JSON.stringify(list)); } catch (e) { /* storage blocked */ }
  }

  const status = (msg) => { $('status').textContent = msg; };

  // ---------- chords / grid ----------
  function defaultChords(g) {
    const d = CS.diatonic(g.key, g.mode, false);
    const order = CS.SCALES[g.mode].rel === 'min' ? [0, 5, 2, 6] : [0, 4, 5, 3];
    const n = Math.ceil((g.bars * 4) / g.segBeats);
    g.chords = [];
    for (let i = 0; i < n; i++) g.chords.push(Object.assign({ alts: [] }, d[order[Math.floor((i * 4) / Math.max(1, n)) % 4]]));
  }

  // Grid (bpm / bars / offset / chord rate / key) changed: re-detect, refit notes, redraw.
  function gridChanged(oldTotal, keepEdits) {
    const g = S.grid, n = Math.ceil((g.bars * 4) / g.segBeats);
    if (S.clip) {
      const old = g.chords.slice();
      E.redetect(S.clip);
      if (keepEdits) old.forEach((c, i) => { if (c && c.edited && i < g.chords.length) g.chords[i] = c; });
      S.melody = S.clip.melody;
    } else {
      const old = g.chords.slice();
      if (!old.length) defaultChords(g);
      else { g.chords = []; for (let i = 0; i < n; i++) g.chords.push(old[i] || old[i % old.length]); }
    }
    const total = CS.totalSteps();
    if (oldTotal && total !== oldTotal && S.notes.length) {
      if (total > oldTotal) {
        const base = S.notes.filter((x) => x.step < oldTotal);
        for (let k = 1; k * oldTotal < total; k++) base.forEach((x) => S.notes.push(Object.assign({}, x, { step: x.step + k * oldTotal })));
      }
      S.notes = CS.normalize(S.notes, total);
      S.locks = new Set([...S.locks].filter((b) => b < g.bars));
      commit();
    }
    E.dirty = true;
    renderAll();
    E.restart();
  }

  // ---------- history ----------
  function commit() {
    S.hist = S.hist.slice(0, S.histPos + 1);
    S.hist.push(copyNotes(S.notes));
    if (S.hist.length > 80) S.hist.shift();
    S.histPos = S.hist.length - 1;
    E.dirty = true;
  }
  function undo() {
    if (S.histPos <= 0) return;
    S.histPos--; S.notes = copyNotes(S.hist[S.histPos]); S.sel = -1; E.dirty = true; drawRoll();
  }
  function redo() {
    if (S.histPos >= S.hist.length - 1) return;
    S.histPos++; S.notes = copyNotes(S.hist[S.histPos]); S.sel = -1; E.dirty = true; drawRoll();
  }

  // ---------- generation ----------
  function reroll(mode, only) {
    if (mode === 'all') { S.seedR = CS.newSeed(); S.seedN = CS.newSeed(); }
    else if (mode === 'rhythm') S.seedR = CS.newSeed();
    else if (mode === 'notes' || mode === 'mutate') S.seedN = CS.newSeed();
    regen(mode, only);
  }
  // Same seeds, current settings (sliders / style / chord edits).
  function regen(mode, only) {
    S.notes = CS.generate(S.gen, CS.context(), { seedR: S.seedR, seedN: S.seedN, mode: mode || 'all', prev: S.notes, locks: S.locks, only });
    S.sel = -1;
    commit();
    drawRoll(); renderSeeds();
    const ctx = CS.context(), clash = S.notes.filter((n) => CS.noteRole(ctx, n) === 'clash').length;
    status(`${S.notes.length} notes · ${CS.rhythmById(S.gen.rhythm).name} · ${clash ? clash + ' rub the melody' : 'no rubs with the melody'}`);
  }
  function renderSeeds() {
    $('seedInfo').textContent = `R ${S.seedR.toString(16).padStart(8, '0')} · N ${S.seedN.toString(16).padStart(8, '0')}`;
  }

  function keep() {
    if (S.kept.length >= 8) S.kept.shift();
    const used = new Set(S.kept.map((k) => k.label));
    const label = 'ABCDEFGHIJ'.split('').find((l) => !used.has(l));
    S.kept.push({ label, notes: copyNotes(S.notes) });
    renderKept();
    status(`Kept as ${label}`);
  }
  function renderKept() {
    const el = $('keptList');
    el.innerHTML = '';
    S.kept.forEach((k, i) => {
      const b = document.createElement('button');
      b.className = 'chipb';
      b.title = 'Recall this line';
      b.innerHTML = `<span>★ ${k.label}</span><span class="x" title="Remove">×</span>`;
      b.onclick = (e) => {
        if (e.target.classList.contains('x')) { S.kept.splice(i, 1); renderKept(); return; }
        S.notes = copyNotes(k.notes); S.sel = -1; commit(); drawRoll(); status(`Recalled ${k.label}`);
      };
      el.appendChild(b);
    });
  }

  // ---------- per-clip state ----------
  function stash() {
    const st = { notes: S.notes, locks: S.locks, hist: S.hist, histPos: S.histPos, kept: S.kept, seedR: S.seedR, seedN: S.seedN };
    if (S.clip) S.clip.st = st; else S.free = st;
  }
  function unstash(st) {
    Object.assign(S, st || { notes: [], locks: new Set(), hist: [], histPos: -1, kept: [], seedR: CS.newSeed(), seedN: CS.newSeed() });
    S.sel = -1;
  }
  function activate(clip) {
    stash();
    S.clip = clip;
    S.grid = clip ? clip.grid : (S.freeGrid || (S.freeGrid = newGrid()));
    if (!clip && !S.grid.chords.length) defaultChords(S.grid);
    S.melody = clip ? clip.melody : null;
    unstash(clip ? clip.st : S.free);
    E.dirty = true;
    E.stop(true); updatePlay();
    renderAll();
    if (!S.notes.length) reroll('all');
  }

  // ---------- loading ----------
  const busy = (on, text) => { $('busy').hidden = !on; if (text) $('busyText').textContent = text; };
  const isAudio = (f) => /^audio\//.test(f.type) || /\.(wav|aiff?|mp3|flac|ogg|m4a)$/i.test(f.name);

  async function addClip(name, buffer) {
    const clip = { id: uid(), name, buffer, grid: newGrid() };
    busy(true, 'ANALYZING');
    try {
      await E.analyzeClip(clip, (what, f) => busy(true, `${what} ${Math.round(f * 100)}%`));
    } finally { busy(false); }
    S.clips.push(clip);
    activate(clip);
    const d = clip.detected;
    status(`${name}: ${CS.pcName(d.key, CS.useFlats(d.key, d.mode))} ${CS.SCALES[d.mode].name.toLowerCase()} · ${d.bpm} BPM · ${d.bars} bar${d.bars > 1 ? 's' : ''}${d.loop ? '' : ' (not a clean loop — check BPM / bars)'}`);
  }

  async function loadClipFiles(files) {
    for (const f of files) {
      if (!isAudio(f)) continue;
      try {
        const buf = await E.decode(await f.arrayBuffer());
        await addClip(f.name.replace(/\.[^.]+$/, ''), buf);
      } catch (e) { status(`Could not read ${f.name}: ${e.message || e}`); }
    }
  }

  async function addShot(name, bytes, rec) {
    const buffer = await E.decode(bytes);
    const shot = { id: rec ? rec.id : 's' + uid(), name, buffer, root: rec ? rec.root : null, pool: rec ? rec.pool !== false : true };
    await E.analyzeShot(shot);
    S.shots.push(shot);
    if (!S.shotId) S.shotId = shot.id;
    if (!rec) CS.store.put({ id: shot.id, name, data: bytes, root: shot.root, pool: shot.pool });
    return shot;
  }
  const persistShot = (s) => CS.store.all().then((all) => {
    const r = all.find((x) => x.id === s.id);
    if (r) { r.root = s.root; r.pool = s.pool; r.name = s.name; CS.store.put(r); }
  });

  async function loadShotFiles(files) {
    const first = !S.shots.length;
    let n = 0;
    for (const f of files) {
      if (!isAudio(f)) continue;
      try {
        await addShot(f.name.replace(/\.[^.]+$/, ''), await f.arrayBuffer());
        n++;
      } catch (e) { status(`Could not read ${f.name}: ${e.message || e}`); }
    }
    if (n && first && S.synth.src === 'synth') { S.synth.src = 'sample'; renderModules(); saveSettings(); }
    renderShots(); drawRoll();
    if (n) status(`Loaded ${n} one-shot${n > 1 ? 's' : ''} · source: ${S.synth.src === 'synth' ? 'SYNTH (switch to ONE-SHOT or LAYER to hear them)' : S.synth.src.toUpperCase()}`);
  }

  // Renders the current synth patch at C2 into a one-shot.
  async function bouncePatch() {
    const sr = 44100, len = 1.6, ac = new OfflineAudioContext(1, sr * len, sr);
    const p = Object.assign({}, S.synth, { src: 'synth', lfoOn: S.synth.lfoOn });
    CS.voice(ac, ac.destination, p, { t0: 0, t1: len - Math.max(0.05, p.rel), vel: 1, segs: [{ t: 0, midi: 36 }] }, { bpm: S.grid.bpm, shot: null });
    const buf = await ac.startRendering();
    const d = buf.getChannelData(0);
    let pk = 1e-6;
    for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
    for (let i = 0; i < d.length; i++) d[i] *= 0.95 / pk;
    const bytes = CS.encodeWav([d], sr).buffer;
    const shot = await addShot(`${S.presetName} C2`, bytes);
    shot.root = 36; persistShot(shot);
    renderShots();
    status(`Bounced ${S.presetName} into a one-shot (root C2)`);
  }

  // ---------- rendering ----------
  function fit(cv, w, h) {
    const d = DPR();
    cv.width = Math.round(w * d); cv.height = Math.round(h * d);
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    const g = cv.getContext('2d');
    g.setTransform(d, 0, 0, d, 0, 0);
    return g;
  }

  function renderAll() {
    renderTransport(); renderClips(); renderKey(); renderDetected(); renderGridControls();
    renderChords(); renderGen(); drawWave(); drawRoll(); renderKept(); renderSeeds(); renderShots();
  }

  function renderTransport() {
    $('bpm').value = S.grid.bpm;
    $('bars').value = String(S.grid.bars);
    $('melVol').value = S.mix.mel; $('subVol').value = S.mix.sub;
    $('melMute').classList.toggle('on', S.mix.melMute);
    $('subMute').classList.toggle('on', S.mix.subMute);
  }
  function updatePlay() {
    $('playBtn').textContent = E.playing ? 'STOP' : 'PLAY';
    $('playBtn').classList.toggle('on', E.playing);
  }

  function renderClips() {
    const el = $('clipList');
    el.innerHTML = '';
    S.clips.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'chipb' + (c === S.clip ? ' on' : '');
      b.innerHTML = `<span></span><span class="x" title="Remove clip">×</span>`;
      b.firstChild.textContent = c.name;
      b.title = c.name;
      b.onclick = (e) => {
        if (e.target.classList.contains('x')) {
          S.clips = S.clips.filter((x) => x !== c);
          if (S.clip === c) { S.clip = null; activate(S.clips[S.clips.length - 1] || null); } else renderClips();
          return;
        }
        if (c !== S.clip) activate(c);
      };
      el.appendChild(b);
    });
    $('dropHint').hidden = !!S.clip;
  }

  function renderKey() {
    const ks = $('keySel'), ms = $('modeSel');
    if (!ks.options.length) {
      for (let k = 0; k < 12; k++) ks.add(new Option(CS.pcName(k, false) + (k === 1 || k === 3 || k === 6 || k === 8 || k === 10 ? '/' + CS.pcName(k, true) : ''), k));
      Object.keys(CS.SCALES).forEach((m) => ms.add(new Option(CS.SCALES[m].name, m)));
    }
    ks.value = S.grid.key; ms.value = S.grid.mode;
  }

  function renderDetected() {
    const c = S.clip;
    if (!c || !c.detected) { $('detInfo').textContent = 'no clip · chords are manual'; return; }
    const d = c.detected;
    $('detInfo').textContent = `${CS.pcName(d.key, CS.useFlats(d.key, d.mode))} ${d.mode === 'min' ? 'min' : 'maj'} · ${d.bpm} BPM · ${d.bars} bars ${d.loop ? '✓ loop' : '~ free'}`;
  }

  function renderGridControls() {
    const c = S.clip, g = S.grid;
    const o = $('offset');
    o.max = c ? Math.max(0.001, Math.min(c.buffer.duration - 0.05, CS.loopDur(g))) : 1;
    o.value = g.offset; o.disabled = !c;
    $('offsetOut').textContent = `${(g.offset * 1000).toFixed(0)} ms`;
    $('segBeats').querySelectorAll('button').forEach((b) => b.classList.toggle('on', +b.dataset.v === g.segBeats));
  }

  // ---------- chord strip ----------
  function chordOptions(sel, cur) {
    const f = flats(), g = S.grid;
    const add = (grp, ch) => grp.appendChild(new Option(`${CS.chordName(ch, f)}  ${CS.roman(ch, g.key, g.mode)}`, `${ch.root}:${ch.type}`));
    const grp = (label) => { const o = document.createElement('optgroup'); o.label = label; sel.appendChild(o); return o; };
    if (cur.alts && cur.alts.length) { const a = grp('Detected'); cur.alts.forEach((ch) => add(a, ch)); }
    const k = grp('In key');
    CS.diatonic(g.key, g.mode, false).concat(CS.diatonic(g.key, g.mode, true)).forEach((ch) => add(k, ch));
    for (let r = 0; r < 12; r++) {
      const o = grp(CS.pcName(r, f));
      CS.CHORD_TYPES.forEach((t) => add(o, { root: r, type: t.id }));
    }
    sel.value = `${cur.root}:${cur.type}`;
  }

  function renderChords() {
    const el = $('chordStrip'), g = S.grid, f = flats();
    el.innerHTML = '';
    const ss = CS.segSteps(), total = CS.totalSteps();
    const n = Math.ceil(total / ss);
    for (let i = 0; i < n; i++) {
      const ch = g.chords[i] || g.chords[g.chords.length - 1];
      if (!ch) continue;
      const d = document.createElement('div');
      d.className = 'chord' + (ch.edited ? ' edited' : '');
      d.style.flexGrow = Math.min(ss, total - i * ss);
      const bar = (i * ss) / 16 + 1;
      d.innerHTML = `<span class="bar">${Number.isInteger(bar) ? bar : bar.toFixed(1)}</span><span class="nm"></span><span class="rm"></span>`;
      d.querySelector('.nm').textContent = CS.chordName(ch, f);
      d.querySelector('.rm').textContent = CS.roman(ch, g.key, g.mode);
      const sel = document.createElement('select');
      sel.title = 'Change chord';
      chordOptions(sel, ch);
      sel.onchange = () => {
        const [root, type] = sel.value.split(':');
        g.chords[i] = { root: +root, type, alts: ch.alts, edited: true };
        // re-pitch the bars under this chord so the sub follows it
        const only = new Set();
        for (let s = i * ss; s < Math.min(total, (i + 1) * ss); s += 16) only.add(Math.floor(s / 16));
        renderChords(); drawWave();
        regen('notes', only);
      };
      d.appendChild(sel);
      el.appendChild(d);
    }
  }

  function snapChords() {
    const g = S.grid, scale = CS.scalePcs(g.key, g.mode);
    const inKey = (ch) => [...CS.chordPcs(ch)].every((p) => scale.has(p));
    const dia = CS.diatonic(g.key, g.mode, false);
    g.chords = g.chords.map((ch) => {
      if (inKey(ch)) return ch;
      const alt = (ch.alts || []).find(inKey);
      if (alt) return { root: alt.root, type: alt.type, alts: ch.alts, edited: true };
      const same = dia.find((d) => d.root === ch.root) || dia.reduce((b, d) => (Math.abs(d.root - ch.root) < Math.abs(b.root - ch.root) ? d : b));
      return { root: same.root, type: same.type, alts: ch.alts, edited: true };
    });
    renderChords(); drawWave();
    regen('notes');
  }

  // ---------- generator controls ----------
  function renderGen() {
    const p = S.gen;
    $('rhythmSel').value = p.rhythm;
    $('harmonySeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === p.harmony));
    document.querySelectorAll('[data-gen]').forEach((el) => {
      el.value = p[el.dataset.gen];
      const out = document.querySelector(`[data-out="${el.dataset.gen}"]`);
      if (out) out.textContent = Math.round(p[el.dataset.gen] * 100) + '%';
    });
    $('lowSel').value = p.low; $('spanSel').value = p.span;
    $('onChangeBtn').classList.toggle('on', p.onChange);
    $('shotModeSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === p.shotMode));
  }

  // ---------- waveform ----------
  let peaks = null;
  function drawWave(pos) {
    const cv = $('wave'), wrap = $('waveWrap');
    const W = Math.max(10, wrap.clientWidth - 4), H = Math.max(40, wrap.clientHeight - 4);
    const g = fit(cv, W, H);
    g.fillStyle = '#0a0d10'; g.fillRect(0, 0, W, H);
    const c = S.clip;
    if (!c) return;
    const dur = c.buffer.duration, gr = S.grid;
    if (!peaks || peaks.clip !== c || peaks.W !== W) {
      const d = CS.mono(c.buffer), mn = new Float32Array(W), mx = new Float32Array(W);
      for (let x = 0; x < W; x++) {
        const a = Math.floor((x * d.length) / W), b = Math.floor(((x + 1) * d.length) / W);
        let lo = 0, hi = 0;
        for (let i = a; i < b; i++) { if (d[i] < lo) lo = d[i]; if (d[i] > hi) hi = d[i]; }
        mn[x] = lo; mx[x] = hi;
      }
      peaks = { clip: c, W, mn, mx };
    }
    const tx = (t) => (t / dur) * W;
    const L = CS.loopDur(), a = gr.offset, b = Math.min(dur, a + L);
    const mid = (H - 22) / 2;
    g.fillStyle = '#1a2a22';
    for (let x = 0; x < W; x++) {
      const t = (x / W) * dur, inside = t >= a && t < b;
      g.fillStyle = inside ? '#3fbf7f' : '#24392f';
      g.fillRect(x, mid - peaks.mx[x] * mid, 1, Math.max(1, (peaks.mx[x] - peaks.mn[x]) * mid));
    }
    // bars + chord lane
    const sd = CS.stepDur(), ss = CS.segSteps(), total = CS.totalSteps(), f = flats();
    for (let s = 0; s <= total; s += 4) {
      const t = a + s * sd;
      if (t > dur) break;
      g.fillStyle = s % 16 === 0 ? 'rgba(255,178,31,0.55)' : 'rgba(255,255,255,0.08)';
      g.fillRect(Math.round(tx(t)), 0, 1, H - 22);
    }
    g.fillStyle = '#0f151b'; g.fillRect(0, H - 22, W, 22);
    g.font = '700 11px Consolas, monospace'; g.textBaseline = 'middle';
    for (let i = 0; i * ss < total; i++) {
      const t0 = a + i * ss * sd, t1 = a + Math.min(total, (i + 1) * ss) * sd;
      if (t0 >= dur) break;
      const ch = gr.chords[i];
      g.fillStyle = i % 2 ? '#16212a' : '#1b2833';
      g.fillRect(tx(t0) + 1, H - 21, Math.max(1, tx(Math.min(t1, dur)) - tx(t0) - 2), 20);
      g.fillStyle = ch && ch.edited ? '#ffb21f' : '#7dffb0';
      g.fillText(CS.chordName(ch, f), tx(t0) + 5, H - 11);
    }
    if (a > 0) { g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(0, 0, tx(a), H - 22); }
    if (pos != null && pos >= 0) {
      g.fillStyle = '#fff';
      g.fillRect(Math.round(tx(a + pos * sd)), 0, 2, H);
    }
  }

  // ---------- roll ----------
  const GUT = 38;
  let geo = null;
  function rollGeom() {
    const total = CS.totalSteps(), wrap = $('rollWrap');
    const avail = Math.max(200, wrap.clientWidth - 4);
    const W = Math.max(avail, GUT + total * 10);
    let lo = S.gen.low - 2, hi = S.gen.low + S.gen.span + 2;
    S.notes.forEach((n) => { lo = Math.min(lo, n.midi - 1); hi = Math.max(hi, n.midi + 1); });
    const H = 300, rows = hi - lo + 1, rh = H / rows, cw = (W - GUT) / total;
    return { W, H, lo, hi, rows, rh, cw, total, x: (s) => GUT + s * cw, y: (m) => (hi - m) * rh };
  }
  const ROLE_COL = { root: '#ffb21f', chord: '#3de0ff', key: '#7dffb0', out: '#b48cff', clash: '#ff4d6d' };
  const SHOT_COLS = ['#ffb21f', '#3de0ff', '#ff6fae', '#7dffb0', '#b48cff', '#ff8a3d', '#f4f16b', '#6fa8ff'];

  function drawRoll(pos) {
    const G = (geo = rollGeom());
    const cv = $('roll'), g = fit(cv, G.W, G.H);
    const ctx = CS.context(), ss = CS.segSteps(), f = flats();
    g.fillStyle = '#0a0d10'; g.fillRect(0, 0, G.W, G.H);
    // chord-tinted rows per segment
    for (let i = 0; i * ss < G.total; i++) {
      const ch = ctx.chordAt(i * ss), pcs = CS.chordPcs(ch);
      const x0 = G.x(i * ss), x1 = G.x(Math.min(G.total, (i + 1) * ss));
      for (let m = G.lo; m <= G.hi; m++) {
        const pc = m % 12;
        let col = null;
        if (pc === ch.root) col = 'rgba(255,178,31,0.16)';
        else if (pcs.has(pc)) col = 'rgba(61,224,255,0.08)';
        else if (!ctx.scale.has(pc)) col = 'rgba(0,0,0,0.5)';
        else col = 'rgba(255,255,255,0.025)';
        g.fillStyle = col;
        g.fillRect(x0, G.y(m), x1 - x0, G.rh);
      }
      g.fillStyle = 'rgba(125,255,176,0.35)';
      g.font = '700 10px Consolas, monospace'; g.textBaseline = 'top';
      g.fillText(CS.chordName(ch, f), x0 + 4, 3);
    }
    for (let m = G.lo; m <= G.hi; m++) if (m % 12 === 0) { g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(GUT, G.y(m) + G.rh - 1, G.W - GUT, 1); }
    for (let s = 0; s <= G.total; s++) {
      const x = Math.round(G.x(s));
      if (s % 16 === 0) g.fillStyle = 'rgba(255,178,31,0.5)';
      else if (s % 4 === 0) g.fillStyle = 'rgba(255,255,255,0.13)';
      else if (G.cw > 7) g.fillStyle = 'rgba(255,255,255,0.04)';
      else continue;
      g.fillRect(x, 0, 1, G.H);
    }
    S.locks.forEach((b) => {
      const x0 = G.x(b * 16), x1 = G.x(Math.min(G.total, b * 16 + 16));
      g.fillStyle = 'rgba(255,178,31,0.06)'; g.fillRect(x0, 0, x1 - x0, G.H);
      g.strokeStyle = 'rgba(255,178,31,0.5)'; g.setLineDash([4, 4]); g.strokeRect(x0 + 1, 1, x1 - x0 - 2, G.H - 2); g.setLineDash([]);
    });
    // notes
    const shotIdx = {};
    S.shots.forEach((s, i) => { shotIdx[s.id] = i; });
    S.notes.forEach((n, i) => {
      const x = G.x(n.step) + 1, y = G.y(n.midi) + 1, w = Math.max(2, n.len * G.cw - 2), h = Math.max(2, G.rh - 2);
      const role = CS.noteRole(ctx, n);
      if (n.slide && i > 0) {
        const p = S.notes[i - 1];
        g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(G.x(p.step + p.len) - 2, G.y(p.midi) + G.rh / 2); g.lineTo(x + 3, y + h / 2); g.stroke();
      }
      g.globalAlpha = 0.55 + 0.45 * (n.vel || 1);
      g.fillStyle = ROLE_COL[role];
      g.fillRect(x, y, w, h);
      g.globalAlpha = 1;
      if (i === S.sel) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(x - 1, y - 1, w + 2, h + 2); }
      g.fillStyle = 'rgba(0,0,0,0.75)';
      if (h >= 9 && w >= 22) {
        g.font = `700 ${Math.min(10, h - 1)}px Consolas, monospace`; g.textBaseline = 'middle';
        g.fillText(CS.midiName(n.midi, f), x + 3, y + h / 2 + 0.5);
      }
      if (n.shot && S.gen.shotMode !== 'one' && shotIdx[n.shot] != null && S.synth.src !== 'synth') {
        const k = shotIdx[n.shot];
        g.fillStyle = SHOT_COLS[k % SHOT_COLS.length];
        g.fillRect(x + w - 6, y, 5, h);
      }
    });
    // gutter
    for (let m = G.lo; m <= G.hi; m++) {
      const black = [1, 3, 6, 8, 10].includes(m % 12);
      g.fillStyle = black ? '#15191e' : '#262c34';
      g.fillRect(0, G.y(m), GUT - 2, G.rh - 0.5);
      if (m % 12 === 0 || (G.rh >= 9 && m % 12 === ctx.chordAt(0).root)) {
        g.fillStyle = m % 12 === 0 ? '#c8cfd8' : '#ffb21f';
        g.font = `700 ${Math.min(10, G.rh)}px Consolas, monospace`; g.textBaseline = 'middle';
        g.fillText(CS.midiName(m, f), 3, G.y(m) + G.rh / 2);
      }
    }
    if (pos != null && pos >= 0) { g.fillStyle = '#fff'; g.fillRect(Math.round(G.x(pos)), 0, 2, G.H); }
    drawMel(pos);
    renderBars();
  }

  function drawMel(pos) {
    const G = geo, cv = $('melLane'), H = 64, g = fit(cv, G.W, H);
    g.fillStyle = '#0c1014'; g.fillRect(0, 0, G.W, H);
    const mel = CS.context().melody;
    let lo = 127, hi = 0;
    mel.forEach((m) => { if (!isNaN(m)) { lo = Math.min(lo, Math.round(m)); hi = Math.max(hi, Math.round(m)); } });
    g.fillStyle = '#4c5866'; g.font = '700 9px Consolas, monospace'; g.textBaseline = 'middle';
    g.fillText('MEL', 6, H / 2);
    if (hi < lo) {
      g.fillText(S.clip ? 'no clear melody detected' : 'load a clip to see its melody here', GUT + 8, H / 2);
      return;
    }
    lo -= 1; hi += 1;
    const rh = (H - 6) / (hi - lo + 1), y = (m) => 3 + (hi - m) * rh;
    for (let s = 0; s <= G.total; s += 16) { g.fillStyle = 'rgba(255,178,31,0.3)'; g.fillRect(Math.round(G.x(s)), 0, 1, H); }
    let s = 0;
    const f = flats();
    while (s < G.total) {
      if (isNaN(mel[s])) { s++; continue; }
      const m = Math.round(mel[s]);
      let e = s + 1;
      while (e < G.total && !isNaN(mel[e]) && Math.round(mel[e]) === m) e++;
      const x = G.x(s) + 1, w = (e - s) * G.cw - 2, yy = y(m);
      g.fillStyle = '#ff6fae';
      g.fillRect(x, yy, Math.max(2, w), Math.max(3, rh));
      if (w > 24) { g.fillStyle = 'rgba(255,255,255,0.75)'; g.font = '700 9px Consolas, monospace'; g.textBaseline = 'bottom'; g.fillText(CS.midiName(m, f), x + 1, yy - 1); }
      s = e;
    }
    if (pos != null && pos >= 0) { g.fillStyle = '#fff'; g.fillRect(Math.round(G.x(pos)), 0, 2, H); }
  }

  function renderBars() {
    const el = $('barStrip'), G = geo;
    el.style.width = G.W + 'px';
    el.style.paddingLeft = GUT + 'px';
    if (el.childElementCount !== S.grid.bars) {
      el.innerHTML = '';
      for (let b = 0; b < S.grid.bars; b++) {
        const d = document.createElement('div');
        d.className = 'bar-cell';
        d.innerHTML = `<b>${b + 1}</b><button class="lk" title="Lock this bar (rerolls keep it)">🔒</button><button class="rr" title="Reroll only this bar">⟳</button>`;
        d.querySelector('.lk').onclick = () => {
          if (S.locks.has(b)) S.locks.delete(b); else S.locks.add(b);
          drawRoll();
        };
        d.querySelector('.rr').onclick = () => { S.seedR = CS.newSeed(); S.seedN = CS.newSeed(); regen('all', new Set([b])); };
        el.appendChild(d);
      }
    }
    [...el.children].forEach((d, b) => d.querySelector('.lk').classList.toggle('on', S.locks.has(b)));
  }

  // roll mouse editing
  let drag = null, lastLen = 2;
  function rollHit(e) {
    const r = $('roll').getBoundingClientRect(), G = geo;
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const step = clamp(Math.floor((x - GUT) / G.cw), 0, G.total - 1);
    const midi = clamp(G.hi - Math.floor(y / G.rh), G.lo, G.hi);
    const i = S.notes.findIndex((n) => n.midi === midi && step >= n.step && step < n.step + n.len);
    return { x, y, step, midi, i };
  }
  function onRollDown(e) {
    const h = rollHit(e);
    if (h.x < GUT) { E.audition(h.midi, 4); return; }
    if (e.button === 2) {
      if (h.i >= 0) { S.notes.splice(h.i, 1); S.sel = -1; commit(); drawRoll(); }
      return;
    }
    if (e.button !== 0) return;
    $('roll').setPointerCapture(e.pointerId);
    if (h.i >= 0) {
      const n = S.notes[h.i];
      if (e.altKey) {
        CS.rerollNote(S.gen, CS.context(), S.notes, h.i, CS.newSeed());
        S.sel = h.i; commit(); drawRoll(); E.audition(n.midi, n.len);
        return;
      }
      S.sel = h.i;
      const edge = geo.x(n.step + n.len) - h.x;
      drag = edge <= Math.max(5, geo.cw * 0.35) ? { type: 'len', n } : { type: 'move', n, dStep: h.step - n.step, midi: n.midi };
      E.audition(n.midi, Math.min(4, n.len));
    } else {
      const n = { step: h.step, len: lastLen, midi: h.midi, vel: 0.9, slide: false };
      S.notes.push(n);
      S.sel = S.notes.length - 1;
      drag = { type: 'len', n, fresh: true };
      E.audition(n.midi, 2);
    }
    drawRoll();
  }
  function onRollMove(e) {
    if (!drag) {
      const h = rollHit(e);
      const n = h.i >= 0 ? S.notes[h.i] : null;
      $('roll').style.cursor = h.x < GUT ? 'pointer' : n && geo.x(n.step + n.len) - h.x <= Math.max(5, geo.cw * 0.35) ? 'ew-resize' : n ? 'grab' : 'crosshair';
      return;
    }
    const h = rollHit(e), n = drag.n;
    if (drag.type === 'len') n.len = Math.max(1, h.step - n.step + 1);
    else {
      n.step = clamp(h.step - drag.dStep, 0, geo.total - n.len);
      if (h.midi !== n.midi) { n.midi = h.midi; E.audition(n.midi, 2); }
    }
    drawRoll();
  }
  function onRollUp() {
    if (!drag) return;
    const n = drag.n;
    if (drag.type === 'len') lastLen = n.len;
    S.notes = S.notes.filter((x) => x !== n).concat([n]);
    S.notes = CS.normalize(S.notes, CS.totalSteps());
    S.sel = S.notes.indexOf(n);
    drag = null;
    commit(); drawRoll();
  }
  function onRollDbl(e) {
    const h = rollHit(e);
    if (h.i <= 0) return;
    const n = S.notes[h.i], p = S.notes[h.i - 1];
    n.slide = !n.slide;
    if (n.slide && p.step + p.len !== n.step) p.len = n.step - p.step;
    S.notes = CS.normalize(S.notes, CS.totalSteps());
    commit(); drawRoll();
  }

  // ---------- synth modules ----------
  const WAVES = [['sine', 'SINE'], ['triangle', 'TRI'], ['sawtooth', 'SAW'], ['square', 'SQUARE']];
  const pct = (v) => Math.round(v * 100) + '%';
  const sec = (v) => (v < 1 ? Math.round(v * 1000) + 'ms' : v.toFixed(2) + 's');
  const sgn = (v) => (v > 0 ? '+' : '') + v;
  const MODS = [
    { t: 'OSC 1', on: 'o1On', synth: true, ctl: [
      { k: 'o1Type', l: 'WAVE', sel: WAVES }, { k: 'o1Oct', l: 'OCTAVE', min: -2, max: 2, step: 1, f: sgn },
      { k: 'o1Semi', l: 'SEMI', min: -12, max: 12, step: 1, f: sgn }, { k: 'o1Lvl', l: 'LEVEL', min: 0, max: 1, step: 0.01, f: pct }] },
    { t: 'OSC 2', note: 'detuned pair', on: 'o2On', synth: true, ctl: [
      { k: 'o2Type', l: 'WAVE', sel: WAVES }, { k: 'o2Oct', l: 'OCTAVE', min: -1, max: 2, step: 1, f: sgn },
      { k: 'o2Det', l: 'DETUNE', min: 0, max: 50, step: 1, f: (v) => v + 'ct' }, { k: 'o2Lvl', l: 'LEVEL', min: 0, max: 1, step: 0.01, f: pct }] },
    { t: 'SUB OSC', note: 'sine −1 oct', on: 'subOn', synth: true, ctl: [{ k: 'subLvl', l: 'LEVEL', min: 0, max: 1, step: 0.01, f: pct }] },
    { t: 'NOISE', note: 'attack click', on: 'noiseOn', synth: true, ctl: [
      { k: 'noiseLvl', l: 'LEVEL', min: 0, max: 1, step: 0.01, f: pct }, { k: 'noiseDec', l: 'DECAY', min: 0.005, max: 0.5, step: 0.005, f: sec }] },
    { t: 'ONE-SHOT', note: 'pitched sample', sample: true, ctl: [
      { k: 'smpLvl', l: 'LEVEL', min: 0, max: 1.5, step: 0.01, f: pct }, { k: 'smpTune', l: 'TUNE', min: -12, max: 12, step: 0.1, f: (v) => sgn(+(+v).toFixed(1)) + 'st' },
      { k: 'smpLoop', l: 'LOOP', chk: 'Loop tail for long notes' }] },
    { t: 'DRIVE', on: 'driveOn', ctl: [
      { k: 'driveType', l: 'TYPE', sel: [['soft', 'SOFT'], ['hard', 'HARD CLIP'], ['fold', 'FOLD']] }, { k: 'drive', l: 'AMOUNT', min: 0, max: 1, step: 0.01, f: pct }] },
    { t: 'FILTER', on: 'filterOn', ctl: [
      { k: 'fType', l: 'TYPE', sel: [['lowpass', 'LOW PASS'], ['bandpass', 'BAND PASS'], ['highpass', 'HIGH PASS']] },
      { k: 'cutoff', l: 'CUTOFF', min: 30, max: 12000, log: true, f: (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v)) },
      { k: 'res', l: 'RES', min: 0, max: 20, step: 0.1, f: (v) => (+v).toFixed(1) }, { k: 'fEnv', l: 'ENV', min: 0, max: 1, step: 0.01, f: pct },
      { k: 'fDecay', l: 'ENV DEC', min: 0.01, max: 1.5, step: 0.01, f: sec }, { k: 'fKey', l: 'KEY TRK', min: 0, max: 1, step: 0.01, f: pct }] },
    { t: 'AMP ENV', ctl: [
      { k: 'atk', l: 'ATTACK', min: 0.001, max: 0.5, log: true, f: sec }, { k: 'dec', l: 'DECAY', min: 0.02, max: 3, log: true, f: sec },
      { k: 'sus', l: 'SUSTAIN', min: 0, max: 1, step: 0.01, f: pct }, { k: 'rel', l: 'RELEASE', min: 0.005, max: 2, log: true, f: sec }] },
    { t: 'PITCH DROP', note: '808 punch', on: 'pitchOn', ctl: [
      { k: 'pAmt', l: 'AMOUNT', min: 0, max: 36, step: 1, f: (v) => v + 'st' }, { k: 'pDec', l: 'TIME', min: 0.005, max: 0.4, log: true, f: sec }] },
    { t: 'GLIDE', note: 'slide time', ctl: [{ k: 'glide', l: 'TIME', min: 0.01, max: 0.5, log: true, f: sec }] },
    { t: 'LFO', note: 'tempo synced', on: 'lfoOn', ctl: [
      { k: 'lfoDest', l: 'TARGET', sel: [['cutoff', 'CUTOFF'], ['pitch', 'PITCH'], ['amp', 'VOLUME']] },
      { k: 'lfoShape', l: 'SHAPE', sel: [['sine', 'SINE'], ['triangle', 'TRI'], ['square', 'SQUARE'], ['sawtooth', 'SAW']] },
      { k: 'lfoDiv', l: 'RATE', sel: Object.keys(CS.LFO_DIVS).map((d) => [d, d]) }, { k: 'lfoDepth', l: 'DEPTH', min: 0, max: 1, step: 0.01, f: pct }] },
    { t: 'OUTPUT', ctl: [{ k: 'level', l: 'LEVEL', min: 0, max: 1.2, step: 0.01, f: pct }] },
  ];
  const toSlider = (c, v) => (c.log ? Math.round((Math.log(v / c.min) / Math.log(c.max / c.min)) * 1000) : v);
  const fromSlider = (c, v) => (c.log ? c.min * Math.pow(c.max / c.min, v / 1000) : +v);

  function synthChanged(rename) {
    if (rename && !/\*$/.test(S.presetName)) { S.presetName += ' *'; renderPresets(); }
    saveSettings();
    syncModules();
  }

  function buildModules() {
    const el = $('modules');
    el.innerHTML = '';
    MODS.forEach((m) => {
      const d = document.createElement('div');
      d.className = 'mod';
      m.el = d;
      d.innerHTML = `<div class="mod-head">${m.on ? '<button class="pw" title="Module on / off"></button>' : ''}<span class="t">${m.t}</span><span class="k">${m.note || ''}</span></div><div class="ctl"></div>`;
      if (m.on) d.querySelector('.pw').onclick = () => { S.synth[m.on] = !S.synth[m.on]; synthChanged(true); };
      const ctl = d.querySelector('.ctl');
      m.ctl.forEach((c) => {
        const lab = document.createElement('label'); lab.textContent = c.l; ctl.appendChild(lab);
        if (c.sel) {
          const s = document.createElement('select');
          c.sel.forEach(([v, t]) => s.add(new Option(t, v)));
          s.onchange = () => { S.synth[c.k] = s.value; synthChanged(true); };
          c.el = s; ctl.appendChild(s);
        } else if (c.chk) {
          const w = document.createElement('label'); w.className = 'chk';
          w.innerHTML = '<input type="checkbox"> ' + c.chk;
          const i = w.querySelector('input');
          i.onchange = () => { S.synth[c.k] = i.checked; synthChanged(true); };
          c.el = i; ctl.appendChild(w);
        } else {
          const i = document.createElement('input');
          i.type = 'range';
          i.min = c.log ? 0 : c.min; i.max = c.log ? 1000 : c.max; i.step = c.log ? 1 : c.step;
          const o = document.createElement('output');
          i.oninput = () => { S.synth[c.k] = fromSlider(c, i.value); o.textContent = c.f(S.synth[c.k]); };
          i.onchange = () => synthChanged(true);
          c.el = i; c.out = o;
          ctl.appendChild(i); ctl.appendChild(o);
        }
      });
      el.appendChild(d);
    });
  }

  function syncModules() {
    const p = S.synth;
    MODS.forEach((m) => {
      const pw = m.el.querySelector('.pw');
      if (pw) pw.classList.toggle('on', !!p[m.on]);
      const inactive = (m.on && !p[m.on]) || (m.synth && p.src === 'sample' && S.shots.length) || (m.sample && p.src === 'synth');
      m.el.classList.toggle('off', !!inactive);
      m.ctl.forEach((c) => {
        if (c.sel) c.el.value = p[c.k];
        else if (c.chk) c.el.checked = !!p[c.k];
        else { c.el.value = toSlider(c, p[c.k]); c.out.textContent = c.f(p[c.k]); }
      });
    });
    $('srcSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === p.src));
  }
  function renderModules() { syncModules(); renderPresets(); }

  function renderPresets() {
    const s = $('presetSel');
    s.innerHTML = '';
    const cur = new Option(S.presetName, '', true, true);
    cur.hidden = true;
    s.add(cur);
    const f = document.createElement('optgroup'); f.label = 'Factory';
    CS.PRESETS.forEach((p, i) => f.appendChild(new Option(p.name, 'f' + i)));
    s.appendChild(f);
    const list = userPresets();
    if (list.length) {
      const u = document.createElement('optgroup'); u.label = 'Saved';
      list.forEach((p, i) => u.appendChild(new Option(p.name, 'u' + i)));
      s.appendChild(u);
    }
    s.value = '';
    $('delPresetBtn').disabled = !list.some((p) => p.name === S.presetName);
  }

  function applyPreset(v) {
    const fac = v[0] === 'f', list = fac ? CS.PRESETS : userPresets(), pr = list[+v.slice(1)];
    if (!pr) return;
    const src = S.synth.src;
    S.synth = CS.patch(pr.p);
    if (!pr.p.src) S.synth.src = src;
    S.presetName = pr.name;
    renderModules(); saveSettings();
    if (!E.playing) testNote();
  }

  function testNote() {
    const ch = CS.context().chordAt(0);
    let m = S.gen.low + ((ch.root - S.gen.low) % 12 + 12) % 12;
    if (m < 33 && m + 12 <= S.gen.low + S.gen.span) m += 12;
    E.audition(m, 8);
  }

  // ---------- one-shots ----------
  function renderShots() {
    const el = $('shotList');
    if (!S.shots.length) {
      el.innerHTML = '<div class="empty">No one-shots yet — load 808s, subs or bass hits (or BOUNCE PATCH) and set the source to ONE-SHOT or LAYER.</div>';
      return;
    }
    el.innerHTML = '';
    S.shots.forEach((s, k) => {
      const d = document.createElement('div');
      d.className = 'shot' + (s.id === S.shotId ? ' on' : '');
      d.innerHTML = `<button class="sel" title="Use this one-shot"></button><span class="nm"></span>
        <span class="tag" style="background:${SHOT_COLS[k % SHOT_COLS.length]}">${k + 1}</span>
        <canvas></canvas>
        <div class="ctrls"><span class="glabel">ROOT</span><select class="root" title="Pitch of the one-shot (auto-detected)"></select>
        <button class="btn pool" title="Rerolls may pick this one-shot when ONE-SHOTS PER is BAR or NOTE">POOL</button>
        <button class="btn raw" title="Play the file as-is">▶</button>
        <button class="btn tst" title="Play through the sub chain at the chord root">▶ SUB</button>
        <button class="btn del" title="Remove from the library">×</button></div>`;
      d.querySelector('.nm').textContent = s.name;
      d.querySelector('.nm').title = s.name + (s.detected != null ? ` · detected ${CS.midiName(s.detected)} ${s.detected - Math.round(s.detected) >= 0 ? '+' : ''}${Math.round((s.detected - Math.round(s.detected)) * 100)}ct` : ' · no clear pitch detected');
      const rs = d.querySelector('.root');
      for (let m = 12; m <= 72; m++) rs.add(new Option(CS.midiName(m), m));
      rs.value = Math.round(s.root);
      rs.onchange = () => { s.root = +rs.value; persistShot(s); E.auditionShot(s); };
      const pool = d.querySelector('.pool');
      pool.classList.toggle('on', s.pool);
      pool.onclick = () => { s.pool = !s.pool; pool.classList.toggle('on', s.pool); persistShot(s); };
      d.querySelector('.sel').onclick = () => {
        S.shotId = s.id;
        if (S.synth.src === 'synth') { S.synth.src = 'sample'; syncModules(); saveSettings(); }
        renderShots(); testNote();
      };
      d.querySelector('.raw').onclick = () => E.auditionShot(s);
      d.querySelector('.tst').onclick = () => { const prev = S.shotId; S.shotId = s.id; testNote(); S.shotId = prev; };
      d.querySelector('.del').onclick = () => {
        S.shots = S.shots.filter((x) => x !== s);
        if (S.shotId === s.id) S.shotId = S.shots[0] ? S.shots[0].id : null;
        CS.store.del(s.id);
        renderShots(); drawRoll(); syncModules();
      };
      el.appendChild(d);
      requestAnimationFrame(() => {
        const cv = d.querySelector('canvas'), W = cv.clientWidth || 230, H = 26, g = fit(cv, W, H);
        const x = s.buffer.getChannelData(0);
        g.fillStyle = '#3de0ff';
        for (let i = 0; i < W; i++) {
          const a = Math.floor((i * x.length) / W), b = Math.floor(((i + 1) * x.length) / W);
          let pk = 0;
          for (let j = a; j < b; j++) pk = Math.max(pk, Math.abs(x[j]));
          g.fillRect(i, H / 2 - pk * (H / 2), 1, Math.max(1, pk * H));
        }
      });
    });
  }

  async function restoreShots() {
    const recs = await CS.store.all();
    for (const r of recs || []) {
      try { await addShot(r.name, r.data, r); } catch (e) { /* skip unreadable */ }
    }
    if (S.shots.length) { renderShots(); syncModules(); }
  }

  // ---------- export ----------
  const baseName = () => (S.clip ? S.clip.name : 'chord-sub').replace(/[^\w\- ]+/g, '').trim() || 'chord-sub';
  async function exportWav(which) {
    status('Rendering…');
    const loops = +$('loopsSel').value;
    const buf = await E.render(loops, which);
    const data = CS.encodeWav([buf.getChannelData(0), buf.getChannelData(1)], buf.sampleRate);
    const key = CS.pcName(S.grid.key, flats()) + (S.grid.mode === 'maj' ? '' : 'm');
    CS.download(new Blob([data], { type: 'audio/wav' }), `${baseName()} - sub ${which === 'mix' ? 'mix ' : ''}${key} ${S.grid.bpm}bpm.wav`);
    status(`Exported ${loops} loop${loops > 1 ? 's' : ''} (${which === 'mix' ? 'melody + sub' : 'sub only'})`);
  }
  function exportMidi() {
    const loops = +$('loopsSel').value, total = CS.totalSteps(), ss = CS.segSteps(), ctx = CS.context();
    const sub = [], chords = [], mel = [];
    for (let k = 0; k < loops; k++) {
      const o = k * total;
      S.notes.forEach((n) => sub.push({ step: o + n.step, len: n.len, note: n.midi, vel: n.vel || 0.9 }));
      for (let s = 0; s < total; s += ss) {
        const ch = ctx.chordAt(s), len = Math.min(ss, total - s);
        CS.chordType(ch.type).ints.forEach((iv) => chords.push({ step: o + s, len, note: 48 + ch.root + iv, vel: 0.7 }));
      }
      let s = 0;
      while (s < total) {
        if (isNaN(ctx.melody[s])) { s++; continue; }
        const m = Math.round(ctx.melody[s]);
        let e = s + 1;
        while (e < total && !isNaN(ctx.melody[e]) && Math.round(ctx.melody[e]) === m) e++;
        mel.push({ step: o + s, len: e - s, note: m, vel: 0.8 });
        s = e;
      }
    }
    const tracks = [{ name: 'Sub', channel: 0, events: sub }, { name: 'Chords', channel: 1, events: chords }];
    if (mel.length) tracks.push({ name: 'Melody (detected)', channel: 2, events: mel });
    CS.download(new Blob([CS.encodeMidi(tracks, S.grid.bpm, loops * total)], { type: 'audio/midi' }), `${baseName()} - sub.mid`);
    status('Exported MIDI: sub, chords' + (mel.length ? ', detected melody' : ''));
  }

  // ---------- wiring ----------
  function wire() {
    $('playBtn').onclick = () => { if (E.playing) E.stop(); else E.play(); updatePlay(); };
    CS.onStop = () => { updatePlay(); drawRoll(); drawWave(); };
    $('bpm').onchange = () => {
      const v = clamp(+$('bpm').value || 120, 50, 220);
      S.grid.bpm = v; gridChanged(CS.totalSteps(), true);
    };
    $('bars').innerHTML = '';
    for (let b = 1; b <= 16; b++) $('bars').add(new Option(b, b));
    $('bars').onchange = () => { const old = CS.totalSteps(); S.grid.bars = +$('bars').value; gridChanged(old, false); };
    $('halfBtn').onclick = () => {
      if (S.grid.bars < 2) return;
      const old = CS.totalSteps(); S.grid.bpm = Math.round(S.grid.bpm * 50) / 100; S.grid.bars = Math.round(S.grid.bars / 2); gridChanged(old, false);
    };
    $('dblBtn').onclick = () => {
      if (S.grid.bars > 8) return;
      const old = CS.totalSteps(); S.grid.bpm = Math.round(S.grid.bpm * 200) / 100; S.grid.bars *= 2; gridChanged(old, false);
    };
    const mixIn = (id, k) => { $(id).oninput = () => { S.mix[k] = +$(id).value; E.applyMix(); saveSettings(); }; };
    mixIn('melVol', 'mel'); mixIn('subVol', 'sub');
    $('melMute').onclick = () => { S.mix.melMute = !S.mix.melMute; E.applyMix(); renderTransport(); saveSettings(); };
    $('subMute').onclick = () => { S.mix.subMute = !S.mix.subMute; E.applyMix(); renderTransport(); saveSettings(); };

    $('loadClipBtn').onclick = () => $('clipInput').click();
    $('clipInput').onchange = (e) => { loadClipFiles([...e.target.files]); e.target.value = ''; };
    $('demoBtn').onclick = async () => { E.init(); addClip('Demo loop (Am F C G)', await CS.makeDemo(E.ac.sampleRate)); };
    $('loadShotBtn').onclick = () => $('shotInput').click();
    $('shotInput').onchange = (e) => { loadShotFiles([...e.target.files]); e.target.value = ''; };
    $('demoShotBtn').onclick = bouncePatch;

    const dropZone = (el, fn) => {
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag'); });
      el.addEventListener('dragleave', () => el.classList.remove('drag'));
      el.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.remove('drag'); fn([...e.dataTransfer.files]); });
    };
    dropZone($('waveWrap'), loadClipFiles);
    dropZone($('shotList'), loadShotFiles);
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => { e.preventDefault(); loadClipFiles([...e.dataTransfer.files]); });

    $('keySel').onchange = () => { S.grid.key = +$('keySel').value; gridChanged(0, true); regen('notes'); };
    $('modeSel').onchange = () => { S.grid.mode = $('modeSel').value; gridChanged(0, true); regen('notes'); };
    let offT = 0;
    $('offset').oninput = () => {
      S.grid.offset = +$('offset').value;
      $('offsetOut').textContent = `${(S.grid.offset * 1000).toFixed(0)} ms`;
      drawWave();
      clearTimeout(offT);
      offT = setTimeout(() => gridChanged(0, true), 120);
    };
    const nudge = (d) => {
      if (!S.clip) return;
      S.grid.offset = clamp(S.grid.offset + d * CS.stepDur(), 0, +$('offset').max);
      gridChanged(0, true);
    };
    $('nudgeL').onclick = () => nudge(-1);
    $('nudgeR').onclick = () => nudge(1);
    $('segBeats').querySelectorAll('button').forEach((b) => { b.onclick = () => { S.grid.segBeats = +b.dataset.v; gridChanged(0, false); regen('notes'); }; });
    $('redetectBtn').onclick = () => { gridChanged(0, false); regen('notes'); };
    $('diatonicBtn').onclick = snapChords;

    const rs = $('rhythmSel');
    CS.RHYTHMS.forEach((r) => rs.add(new Option(r.name, r.id)));
    rs.onchange = () => { S.gen.rhythm = rs.value; saveSettings(); regen('all'); };
    const hs = $('harmonySeg');
    CS.HARMONY.forEach((h) => {
      const b = document.createElement('button');
      b.dataset.v = h.id; b.textContent = h.name; b.title = h.title;
      b.onclick = () => { S.gen.harmony = h.id; renderGen(); saveSettings(); regen('notes'); };
      hs.appendChild(b);
    });
    document.querySelectorAll('[data-gen]').forEach((el) => {
      const k = el.dataset.gen;
      el.oninput = () => { S.gen[k] = +el.value; document.querySelector(`[data-out="${k}"]`).textContent = Math.round(S.gen[k] * 100) + '%'; };
      el.onchange = () => { saveSettings(); regen(['density'].includes(k) ? 'all' : ['movement', 'fit', 'counter', 'octave', 'anchor'].includes(k) ? 'notes' : 'all'); };
    });
    for (let m = 16; m <= 48; m++) $('lowSel').add(new Option('from ' + CS.midiName(m), m));
    [7, 12, 15, 19, 24, 31, 36].forEach((s) => $('spanSel').add(new Option(`+${s} st`, s)));
    $('lowSel').onchange = () => { S.gen.low = +$('lowSel').value; saveSettings(); regen('notes'); };
    $('spanSel').onchange = () => { S.gen.span = +$('spanSel').value; saveSettings(); regen('notes'); };
    $('onChangeBtn').onclick = () => { S.gen.onChange = !S.gen.onChange; renderGen(); saveSettings(); regen('all'); };
    $('shotModeSeg').querySelectorAll('button').forEach((b) => { b.onclick = () => { S.gen.shotMode = b.dataset.v; renderGen(); saveSettings(); regen('notes'); }; });

    $('rerollBtn').onclick = () => reroll('all');
    $('rerollNotesBtn').onclick = () => reroll('notes');
    $('rerollRhythmBtn').onclick = () => reroll('rhythm');
    $('mutateBtn').onclick = () => reroll('mutate');
    $('undoBtn').onclick = undo;
    $('redoBtn').onclick = redo;
    $('clearBtn').onclick = () => { S.notes = S.notes.filter((n) => S.locks.has(Math.floor(n.step / 16))); S.sel = -1; commit(); drawRoll(); };
    $('keepBtn').onclick = keep;

    const roll = $('roll');
    roll.addEventListener('pointerdown', onRollDown);
    roll.addEventListener('pointermove', onRollMove);
    roll.addEventListener('pointerup', onRollUp);
    roll.addEventListener('dblclick', onRollDbl);
    roll.addEventListener('contextmenu', (e) => e.preventDefault());

    $('srcSeg').querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        S.synth.src = b.dataset.v; synthChanged(false); drawRoll();
        if (b.dataset.v !== 'synth' && !S.shots.length) status('No one-shots loaded yet — load some below (or BOUNCE PATCH). Until then the synth plays.');
        else testNote();
      };
    });
    $('presetSel').onchange = () => { const v = $('presetSel').value; if (v) applyPreset(v); };
    $('savePresetBtn').onclick = () => {
      const name = (prompt('Preset name', S.presetName.replace(/ \*$/, '')) || '').trim();
      if (!name) return;
      const list = userPresets().filter((p) => p.name !== name);
      const p = Object.assign({}, S.synth); delete p.src;
      list.push({ name, p });
      setUserPresets(list);
      S.presetName = name; renderPresets(); saveSettings();
      status(`Saved preset “${name}”`);
    };
    $('delPresetBtn').onclick = () => {
      setUserPresets(userPresets().filter((p) => p.name !== S.presetName));
      S.presetName += ' *'; renderPresets(); saveSettings();
    };
    $('randPatchBtn').onclick = () => {
      S.synth = CS.randomPatch(CS.rng(CS.newSeed()), S.synth.src);
      S.presetName = 'Random *'; renderModules(); saveSettings(); testNote();
    };
    $('testNoteBtn').onclick = testNote;

    $('wavSubBtn').onclick = () => exportWav('sub');
    $('wavMixBtn').onclick = () => exportWav('mix');
    $('midiBtn').onclick = exportMidi;

    document.addEventListener('keydown', (e) => {
      if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range') return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); } else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
        return;
      }
      if (k === ' ') { e.preventDefault(); $('playBtn').click(); } else if (k === 'r') reroll('all');
      else if (k === 'n') reroll('notes');
      else if (k === 't') reroll('rhythm');
      else if (k === 'm') reroll('mutate');
      else if (k === 'k') keep();
      else if ((k === 'delete' || k === 'backspace') && S.sel >= 0) { S.notes.splice(S.sel, 1); S.sel = -1; commit(); drawRoll(); } else if ((k === 'arrowup' || k === 'arrowdown') && S.sel >= 0) {
        e.preventDefault();
        const n = S.notes[S.sel];
        n.midi = clamp(n.midi + (k === 'arrowup' ? 1 : -1) * (e.shiftKey ? 12 : 1), 12, 84);
        commit(); drawRoll(); E.audition(n.midi, 2);
      }
    });
    let rz = 0;
    window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { peaks = null; drawWave(); drawRoll(); renderShots(); }, 100); });
  }

  // playhead + current chord
  let lastSeg = -1;
  function frame() {
    if (E.playing) {
      const pos = E.position();
      drawRoll(pos); drawWave(pos);
      const seg = pos < 0 ? -1 : Math.floor(pos / CS.segSteps());
      if (seg !== lastSeg) {
        [...$('chordStrip').children].forEach((c, i) => c.classList.toggle('now', i === seg));
        lastSeg = seg;
      }
    } else if (lastSeg !== -1) {
      [...$('chordStrip').children].forEach((c) => c.classList.remove('now'));
      lastSeg = -1;
    }
    requestAnimationFrame(frame);
  }

  // ---------- boot ----------
  async function boot() {
    wire();
    buildModules();
    S.freeGrid = S.grid;
    defaultChords(S.grid);
    renderModules();
    renderAll();
    reroll('all');
    status('Load a melody clip or loop (or DEMO LOOP) — Chord Sub finds its key, chords and melody and writes a sub line to fit.');
    requestAnimationFrame(frame);
    restoreShots();
    const q = new URLSearchParams(location.search);
    if (q.has('demo')) $('demoBtn').click();
    for (const u of (q.get('load') || '').split(',').filter(Boolean)) {
      try { const r = await fetch(u); await addClip(u.replace(/^.*\/|\.[^.]+$/g, ''), await E.decode(await r.arrayBuffer())); } catch (e) { status('Could not load ' + u); }
    }
  }
  boot();
})(window.CS);
