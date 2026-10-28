// Audio engine: clip / one-shot loading and analysis, the loop transport (melody clip + sub
// phrases scheduled with a look-ahead timer), offline rendering and the one-shot library store.
window.CS = window.CS || {};

(function (CS) {
  'use strict';

  const E = (CS.E = {
    ac: null, bus: null, playing: false, t0: 0, next: 0, timer: null, live: [], melSrcs: [],
  });

  function buses(ac, mix) {
    const master = ac.createGain();
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -6; comp.knee.value = 6; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.12;
    master.connect(comp); comp.connect(ac.destination);
    const mel = ac.createGain(), sub = ac.createGain();
    mel.connect(master); sub.connect(master);
    const b = { master, mel, sub };
    applyMix(b, mix);
    return b;
  }
  function applyMix(b, mix) {
    b.mel.gain.value = mix.melMute ? 0 : mix.mel;
    b.sub.gain.value = mix.subMute ? 0 : mix.sub;
  }

  E.init = function () {
    if (E.ac) return E.ac;
    E.ac = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    E.bus = buses(E.ac, CS.state.mix);
    return E.ac;
  };
  E.applyMix = () => { if (E.bus) applyMix(E.bus, CS.state.mix); };

  // ---------- grid helpers ----------
  CS.grid = () => CS.state.grid;
  CS.stepDur = (g) => 15 / (g || CS.grid()).bpm;
  CS.loopDur = (g) => { g = g || CS.grid(); return (g.bars * 240) / g.bpm; };
  CS.totalSteps = (g) => (g || CS.grid()).bars * 16;
  CS.segSteps = (g) => (g || CS.grid()).segBeats * 4;

  // Generator / colouring context for the current grid.
  CS.context = function () {
    const S = CS.state, g = S.grid, total = CS.totalSteps(g), ss = CS.segSteps(g);
    const nSeg = Math.ceil(total / ss);
    const chords = [];
    for (let i = 0; i < nSeg; i++) chords.push(g.chords[i] || g.chords[g.chords.length - 1] || { root: g.key, type: 'min' });
    const segOf = (s) => Math.min(nSeg - 1, Math.floor(s / ss));
    const pool = S.shots.filter((s) => s.pool).map((s) => s.id);
    return {
      bars: g.bars, total, segOf,
      chordAt: (s) => chords[segOf(s)],
      melody: S.melody && S.melody.length === total ? S.melody : new Float32Array(total).fill(NaN),
      scale: CS.scalePcs(g.key, g.mode),
      shotIds: pool,
    };
  };

  // ---------- loading ----------
  E.decode = async function (arrayBuffer) {
    E.init();
    return E.ac.decodeAudioData(arrayBuffer.slice(0));
  };

  // Full analysis of a melody clip: pitch track, chroma, tempo and key.
  E.analyzeClip = async function (clip, onProgress) {
    const buf = clip.buffer;
    const yin = await CS.track(buf, (f) => onProgress && onProgress('PITCH', f));
    const mono = CS.monophony(yin);
    // solo lines track best with YIN; chords + melody need the polyphonic estimate
    const tr = mono > 0.55 ? yin : await CS.salience(buf, (f) => onProgress && onProgress('MELODY', f));
    const ch = await CS.chroma(buf, (f) => onProgress && onProgress('HARMONY', f));
    const tempo = CS.tempo(buf);
    clip.an = { track: tr, chroma: ch, tempo, mono };
    const g = clip.grid;
    g.bpm = tempo.bpm; g.bars = tempo.bars; g.offset = 0;
    const mel = CS.melodySteps(tr, 0, (CS.stepDur(g) * buf.sampleRate), CS.totalSteps(g));
    const k = CS.keyFromAnalysis(ch, mel);
    g.key = k.key; g.mode = k.mode;
    E.redetect(clip);
    // relative major / minor share a scale: pick the one whose tonic chord the progression leans on
    const rel = k.mode === 'maj' ? { key: (k.key + 9) % 12, mode: 'min', q: 'min' } : { key: (k.key + 3) % 12, mode: 'maj', q: 'maj' };
    const weight = (root, q) => g.chords.reduce((s, c, i) => s + (c.root === root && CS.chordType(c.type).ints[1] === (q === 'min' ? 3 : 4) ? (i === 0 ? 1.5 : 1) : 0), 0);
    if (weight(rel.key, rel.q) > weight(k.key, k.mode === 'maj' ? 'maj' : 'min')) {
      g.key = rel.key; g.mode = rel.mode;
      E.redetect(clip);
    }
    clip.detected = { key: g.key, mode: g.mode, bpm: tempo.bpm, bars: tempo.bars, loop: tempo.loop };
  };

  // Chords + melody for the clip's current grid.
  E.redetect = function (clip) {
    const g = clip.grid, sr = clip.buffer.sampleRate;
    const start = g.offset * sr, stepLen = CS.stepDur(g) * sr, total = CS.totalSteps(g), ss = CS.segSteps(g);
    const segs = [];
    for (let s = 0; s < total; s += ss) segs.push([start + s * stepLen, start + Math.min(total, s + ss) * stepLen]);
    g.chords = CS.detectChords(clip.an.chroma, segs, g.key, g.mode);
    clip.melody = CS.melodySteps(clip.an.track, start, stepLen, total);
  };

  E.analyzeShot = async function (shot) {
    const root = await CS.detectRoot(shot.buffer);
    shot.detected = root;
    if (shot.root == null) shot.root = root == null ? 36 : Math.round(root * 10) / 10;
  };

  // ---------- phrases ----------
  // Notes joined by slides become one voice whose pitch glides between them.
  CS.phrases = function (notes) {
    const out = [];
    notes.forEach((n) => {
      const last = out[out.length - 1];
      if (n.slide && last && last.end === n.step) {
        last.segs.push({ step: n.step, midi: n.midi });
        last.end = n.step + n.len;
      } else out.push({ step: n.step, end: n.step + n.len, vel: n.vel, shot: n.shot, segs: [{ step: n.step, midi: n.midi }] });
    });
    return out;
  };

  function shotFor(ph) {
    const S = CS.state;
    if (S.synth.src === 'synth') return null;
    const find = (id) => S.shots.find((s) => s.id === id);
    const s = (S.gen.shotMode !== 'one' && ph.shot && find(ph.shot)) || find(S.shotId) || S.shots[0];
    return s ? { buffer: s.buffer, root: s.root } : null;
  }

  // Schedules phrase `ph` of a loop starting at time `base`. `nextStart` is the next phrase's
  // start time (it chokes this one, like a mono 808).
  function playPhrase(ac, dest, ph, base, nextStart) {
    const sd = CS.stepDur();
    const segs = ph.segs.map((s) => ({ t: base + s.step * sd, midi: s.midi }));
    return CS.voice(ac, dest, CS.state.synth, {
      t0: segs[0].t, t1: base + ph.end * sd - 0.002, kill: nextStart, vel: ph.vel, segs,
    }, { bpm: CS.grid().bpm, shot: shotFor(ph) });
  }

  // ---------- transport ----------
  E.play = function () {
    E.init();
    if (E.ac.state === 'suspended') E.ac.resume();
    E.stop(true);
    E.playing = true;
    E.t0 = E.ac.currentTime + 0.06;
    E.next = 0;
    E.timer = setInterval(E.tick, 25);
    E.tick();
  };

  E.stop = function (quiet) {
    clearInterval(E.timer); E.timer = null;
    const now = E.ac ? E.ac.currentTime : 0;
    E.live.forEach((v) => v.srcs.forEach((s) => { try { s.stop(now + 0.01); } catch (e) { /* already stopped */ } }));
    E.melSrcs.forEach((s) => { try { s.stop(now + 0.01); } catch (e) { /* already stopped */ } });
    E.live = []; E.melSrcs = [];
    E.playing = false;
    if (!quiet && CS.onStop) CS.onStop();
  };

  // Restart the loop from bar 1 on the next tick (after grid changes).
  E.restart = function () { if (E.playing) E.play(); };

  E.position = function () {
    if (!E.playing) return -1;
    const s = (E.ac.currentTime - E.t0) / CS.stepDur();
    return s < 0 ? -1 : s % CS.totalSteps();
  };

  function melodyAt(ac, dest, clip, t, dur) {
    const g = CS.grid();
    const src = ac.createBufferSource(), env = ac.createGain();
    src.buffer = clip.buffer;
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(1, t + 0.004);
    env.gain.setValueAtTime(1, t + dur - 0.006); env.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(env); env.connect(dest);
    const off = Math.max(0, g.offset);
    if (off < clip.buffer.duration) src.start(t, off, dur);
    return src;
  }

  E.tick = function () {
    const ac = E.ac, sd = CS.stepDur(), total = CS.totalSteps();
    const horizon = ac.currentTime + 0.15;
    E.live = E.live.filter((v) => v.end > ac.currentTime);
    if (E.dirty || !E.ph) { E.ph = CS.phrases(CS.state.notes); E.dirty = false; }
    const ph = E.ph;
    while (E.t0 + E.next * sd < horizon) {
      const g = E.next, s = g % total, base = E.t0 + (g - s) * sd;
      if (s === 0 && CS.state.clip) E.melSrcs.push(melodyAt(ac, E.bus.mel, CS.state.clip, base, total * sd));
      ph.forEach((p, i) => {
        if (p.step !== s) return;
        const nx = ph[i + 1];
        const nextStart = nx ? base + nx.step * sd : ph.length ? base + (total + ph[0].step) * sd : Infinity;
        E.live.push(playPhrase(ac, E.bus.sub, p, base, nextStart));
      });
      E.next++;
    }
    E.melSrcs = E.melSrcs.filter((s, i, a) => i >= a.length - 2);
  };

  // One note now (piano-roll audition).
  E.audition = function (midi, steps) {
    E.init();
    if (E.ac.state === 'suspended') E.ac.resume();
    const t = E.ac.currentTime + 0.01, dur = (steps || 2) * CS.stepDur();
    const v = CS.voice(E.ac, E.bus.sub, CS.state.synth, { t0: t, t1: t + dur, vel: 0.95, segs: [{ t, midi }] },
      { bpm: CS.grid().bpm, shot: shotFor({}) });
    E.live.push(v);
  };

  E.auditionShot = function (shot) {
    E.init();
    if (E.ac.state === 'suspended') E.ac.resume();
    const src = E.ac.createBufferSource();
    src.buffer = shot.buffer; src.connect(E.bus.sub); src.start();
  };

  // ---------- offline render ----------
  // which: 'sub' | 'mix'
  E.render = async function (loops, which) {
    const S = CS.state, sr = 44100, sd = CS.stepDur(), total = CS.totalSteps(), L = total * sd;
    const len = Math.ceil((loops * L + 1.5) * sr);
    const ac = new OfflineAudioContext(2, len, sr);
    const b = buses(ac, Object.assign({}, S.mix, which === 'sub' ? { melMute: true, subMute: false } : {}));
    const ph = CS.phrases(S.notes);
    for (let k = 0; k < loops; k++) {
      const base = k * L;
      if (which === 'mix' && S.clip) melodyAt(ac, b.mel, S.clip, base, L);
      ph.forEach((p, i) => {
        const nx = ph[i + 1];
        const nextStart = nx ? base + nx.step * sd : k < loops - 1 ? base + (total + ph[0].step) * sd : Infinity;
        playPhrase(ac, b.sub, p, base, nextStart);
      });
    }
    return ac.startRendering();
  };

  // ---------- one-shot library (IndexedDB) ----------
  const DB = 'chordsub', STORE = 'shots';
  function db() {
    return new Promise((resolve, reject) => {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(STORE, { keyPath: 'id' });
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
  }
  const tx = (mode, fn) => db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode), st = t.objectStore(STORE), rq = fn(st);
    t.oncomplete = () => resolve(rq && rq.result);
    t.onerror = () => reject(t.error);
  }));
  CS.store = {
    put: (rec) => tx('readwrite', (st) => st.put(rec)).catch(() => null),
    del: (id) => tx('readwrite', (st) => st.delete(id)).catch(() => null),
    all: () => tx('readonly', (st) => st.getAll()).catch(() => []),
  };
})(window.CS);
