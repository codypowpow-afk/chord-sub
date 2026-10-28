// Sub-bass line generator. A rhythm comes from the style's bar templates (or from the melody
// itself), then each hit gets a pitch drawn from a weighted pool: harmony mode decides which
// tones are allowed against the current chord, movement favours small or big intervals, and
// "melody fit" scores the interval against the melody note sounding above it.
// Rhythm and pitch use separate seeds so either can be rerolled alone; locked bars are kept.
//   Templates: 16 steps per bar.  x = hit  - = hold  . = rest
window.CS = window.CS || {};

(function (CS) {
  'use strict';

  CS.RHYTHMS = [
    { id: 'hold', name: 'Long subs', bars: ['x---------------', 'x-------x-------', 'x-----------x---', 'x---------x-----'] },
    { id: 'pulse', name: 'Pulse 8ths', bars: ['x-x-x-x-x-x-x-x-', 'x-x-x-x-x-x-x.x.', 'x.x.x.x.x.x.x.x.'] },
    { id: 'offbeat', name: 'Offbeat house', bars: ['..x-..x-..x-..x-', '..x...x...x...x.', '..x-..x-..x-.xx-', 'x.x-..x-..x-..x-'] },
    { id: 'synco', name: 'Syncopated', bars: ['x--x--x---x--x--', 'x--x--x-x--x----', 'x-.x-.x-..x-.x..', 'x--x---x--x-x---'] },
    { id: 'trap', name: '808 trap', bars: ['x-------..x-----', 'x-----x---------', 'x---------x--x--', 'x-------x-x-x---', 'x--x------x-----'], glide: 0.25 },
    { id: 'dnb', name: 'Rolling DnB', bars: ['x---------x-----', 'x-----x---x-----', 'x-------x-x---x-', 'x--x------x--x--'], glide: 0.1 },
    { id: 'garage', name: '2-step garage', bars: ['x-----x.--x-----', 'x--x----..x--x--', 'x-----x---x--x..', 'x.....x.x.....x.'] },
    { id: 'dembow', name: 'Dembow', bars: ['x--x---x-x--x---', 'x--x--x-x--x--x-', 'x--x---xx--x----'] },
    { id: 'walk', name: 'Walking 4s', bars: ['x---x---x---x---', 'x---x---x---x-x-', 'x---x---x-x-x---'] },
    { id: 'gallop', name: 'Gallop', bars: ['x-xxx-xxx-xxx-xx', 'x-xx-xx-x-xx-xx-'] },
    { id: 'follow', name: 'Follow melody', special: true },
    { id: 'gaps', name: 'Fill the gaps', special: true },
    { id: 'random', name: 'Random', special: true },
  ];
  CS.rhythmById = (id) => CS.RHYTHMS.find((r) => r.id === id) || CS.RHYTHMS[3];

  CS.HARMONY = [
    { id: 'root', name: 'ROOTS', title: 'Only chord roots (any octave)' },
    { id: 'fifth', name: 'R+5', title: 'Roots and fifths' },
    { id: 'chord', name: 'CHORD', title: 'Chord tones' },
    { id: 'scale', name: 'KEY', title: 'Any note in key, chord tones favoured' },
    { id: 'melodic', name: 'MELODIC', title: 'In key plus chromatic approach notes into the next chord' },
  ];

  CS.GEN_DEFAULT = {
    rhythm: 'synco', harmony: 'chord', density: 0.5, anchor: 0.85, movement: 0.35,
    fit: 0.6, counter: 0.2, glide: 0.15, octave: 0.15, low: 28, span: 19, onChange: true,
    shotMode: 'one', // one | bar | note
  };

  // How well an interval (melody pc above bass pc, mod 12) sits. >1 good, <1 rub.
  const CONS = [0.9, 0.12, 0.55, 1.25, 1.25, 0.8, 0.2, 1.3, 1.05, 1.2, 0.75, 0.3];

  function parse(tpl) {
    const hits = [];
    let cur = null;
    for (let s = 0; s < 16; s++) {
      const c = tpl[s] || '.';
      if (c === 'x' || c === 'X') { cur = { step: s, len: 1 }; hits.push(cur); } else if (c === '-' && cur) cur.len++; else cur = null;
    }
    return hits;
  }

  function barRhythm(p, ctx, r, bar) {
    const st = CS.rhythmById(p.rhythm), b0 = bar * 16;
    let hits;
    if (st.id === 'follow' || st.id === 'gaps') {
      const mel = ctx.melody, voiced = (s) => !isNaN(mel[b0 + s]);
      hits = [];
      for (let s = 0; s < 16; s++) {
        let start;
        if (st.id === 'follow') start = voiced(s) && (s === 0 || !voiced(s - 1) || Math.round(mel[b0 + s]) !== Math.round(mel[b0 + s - 1]));
        else start = !voiced(s) && (s === 0 || voiced(s - 1));
        if (start) hits.push({ step: s, len: 1 });
        else if (hits.length && (st.id === 'follow' ? voiced(s) : !voiced(s))) hits[hits.length - 1].len++;
      }
      if (!hits.length || hits[0].step > 0) {
        if (r() < p.anchor) hits.unshift({ step: 0, len: hits.length ? hits[0].step : 4 });
      }
    } else if (st.id === 'random') {
      hits = [];
      for (let s = 0; s < 16; s++) {
        const w = s === 0 ? 1 : s % 4 === 0 ? 0.45 : s % 2 === 0 ? 0.3 : 0.14;
        if (r() < w * (0.4 + p.density * 1.2)) hits.push({ step: s, len: 1 });
        else if (hits.length && r() < 0.75) hits[hits.length - 1].len++;
      }
    } else hits = parse(r.pick(st.bars));

    // density: thin out (never the downbeat) or add hits on 8ths / 16ths
    if (p.density < 0.5 && !st.special) {
      const drop = (0.5 - p.density) * 1.5;
      hits = hits.filter((h, i) => {
        if (h.step === 0 || r() >= drop) return true;
        const prev = hits[i - 1];
        if (prev && prev.step + prev.len === h.step && r() < 0.5) prev.len += h.len;
        return false;
      });
    } else if (p.density > 0.5 && !st.special) {
      const add = p.density - 0.5;
      for (let s = 1; s < 16; s++) {
        if (hits.some((h) => h.step === s)) continue;
        if (r() >= (s % 2 === 0 ? add * 0.8 : add * 0.35)) continue;
        const cover = hits.find((h) => h.step < s && h.step + h.len > s);
        if (cover) { const rest = cover.step + cover.len - s; cover.len = s - cover.step; hits.push({ step: s, len: rest }); } else hits.push({ step: s, len: Math.min(2, 16 - s) });
        hits.sort((a, b) => a.step - b.step);
      }
    }
    hits.sort((a, b) => a.step - b.step);
    hits.forEach((h, i) => {
      const next = hits[i + 1];
      h.len = Math.max(1, Math.min(h.len, (next ? next.step : 16) - h.step));
      h.step += b0;
    });
    return hits;
  }

  // Split or add hits so each chord change gets its own note.
  function onChanges(hits, ctx, keep) {
    for (let s = 1; s < ctx.total; s++) {
      if (keep(Math.floor(s / 16)) || ctx.segOf(s) === ctx.segOf(s - 1)) continue;
      if (hits.some((h) => h.step === s)) continue;
      const cover = hits.find((h) => h.step < s && h.step + h.len > s);
      if (cover) { hits.push({ step: s, len: cover.step + cover.len - s }); cover.len = s - cover.step; } else {
        const next = hits.filter((h) => h.step > s).reduce((m, h) => Math.min(m, h.step), ctx.total);
        hits.push({ step: s, len: Math.max(1, Math.min(4, next - s)) });
      }
    }
    return hits.sort((a, b) => a.step - b.step);
  }

  // First voiced melody pitch under a note.
  function melodyAt(ctx, step, len) {
    for (let s = step; s < Math.min(ctx.total, step + Math.max(1, Math.min(len, 4))); s++) if (!isNaN(ctx.melody[s])) return ctx.melody[s];
    return NaN;
  }

  // Weighted candidate list for one note.
  CS.candidates = function (p, ctx, h, prev, forceRoot) {
    const ch = ctx.chordAt(h.step);
    const pcs = CS.chordPcs(ch), scale = ctx.scale;
    const seg = ctx.segOf(h.step);
    const chordStart = h.step === 0 || ctx.segOf(h.step - 1) !== seg;
    const nextStep = h.step + h.len;
    const lastBefore = nextStep < ctx.total && ctx.segOf(nextStep) !== seg;
    const nextRoot = lastBefore ? ctx.chordAt(nextStep).root : null;
    const mel = melodyAt(ctx, h.step, h.len);
    const melPrev = prev && !isNaN(prev.mel) ? prev.mel : NaN;
    const hi = p.low + p.span, center = p.low + p.span * 0.35;
    const out = [];
    for (let m = p.low; m <= hi; m++) {
      const pc = m % 12, rel = (pc - ch.root + 12) % 12;
      const isRoot = rel === 0, isCT = pcs.has(pc), inKey = scale.has(pc);
      let w = 0;
      if (isRoot) w = 1;
      else if (forceRoot) w = 0;
      else if (p.harmony === 'fifth') w = rel === 7 ? 0.6 : 0;
      else if (p.harmony === 'chord') w = isCT ? 0.6 : 0;
      else if (p.harmony === 'scale' || p.harmony === 'melodic') {
        w = isCT ? 0.7 : inKey ? 0.32 : 0;
        if (p.harmony === 'melodic' && nextRoot != null && !isCT && Math.min((pc - nextRoot + 12) % 12, (nextRoot - pc + 12) % 12) === 1) w = Math.max(w, 0.8);
      }
      if (p.harmony === 'root' && !isRoot) w = 0;
      if (!w) continue;
      if (prev) {
        const iv = Math.abs(m - prev.midi);
        w *= Math.exp(-iv / (1.5 + p.movement * 10));
        if (iv === 12) w *= 1 + p.octave * 6;
        if (iv === 0) w *= 1.25 - p.movement * 0.7;
      } else w *= Math.exp(-Math.abs(m - center) / 7);
      if (!isNaN(mel) && p.fit > 0) {
        const c = CONS[(CS.pc(mel) - pc + 12) % 12];
        w *= 1 + (c - 1) * p.fit;
      }
      if (p.counter > 0 && prev && !isNaN(mel) && !isNaN(melPrev) && Math.round(mel) !== Math.round(melPrev) && m !== prev.midi) {
        const contrary = Math.sign(m - prev.midi) !== Math.sign(mel - melPrev);
        w *= contrary ? 1 + p.counter * 1.5 : 1 - p.counter * 0.6;
      }
      if (chordStart && isRoot) w *= 1.5;
      if (w > 0) out.push({ midi: m, w });
    }
    if (!out.length) {
      let m = p.low + ((ch.root - p.low) % 12 + 12) % 12;
      if (prev && m + 12 <= hi && Math.abs(m + 12 - prev.midi) < Math.abs(m - prev.midi)) m += 12;
      out.push({ midi: m, w: 1 });
    }
    return { list: out, mel, chordStart };
  };

  function pickPitch(p, ctx, r, h, prev) {
    const seg = ctx.segOf(h.step);
    const chordStart = h.step === 0 || ctx.segOf(h.step - 1) !== seg;
    const forceRoot = chordStart && r() < p.anchor;
    const c = CS.candidates(p, ctx, h, prev, forceRoot);
    return { midi: r.weighted(c.list, (x) => x.w).midi, mel: c.mel };
  }

  const barOf = (n) => Math.floor(n.step / 16);
  CS.normalize = function (notes, total) {
    notes.sort((a, b) => a.step - b.step);
    const out = [];
    notes.forEach((n) => {
      if (n.step < 0 || n.step >= total) return;
      const last = out[out.length - 1];
      if (last && last.step === n.step) { out[out.length - 1] = n; return; }
      out.push(n);
    });
    out.forEach((n, i) => {
      const next = out[i + 1];
      n.len = Math.max(1, Math.min(n.len, (next ? next.step : total) - n.step));
      if (n.slide && !(i > 0 && out[i - 1].step + out[i - 1].len === n.step)) n.slide = false;
    });
    return out;
  };

  // opts: { seedR, seedN, mode: all|rhythm|notes|mutate, prev: notes, locks: Set(bar), only: Set(bar) }
  CS.generate = function (p, ctx, opts) {
    const st = CS.rhythmById(p.rhythm);
    const prev = (opts.prev || []).map((n) => Object.assign({}, n));
    const keep = (b) => opts.locks.has(b) || (opts.only && !opts.only.has(b));
    const rr = CS.rng(opts.seedR), rn = CS.rng(opts.seedN);
    const mode = prev.length ? opts.mode : 'all';
    let hits;
    if (mode === 'notes' || mode === 'mutate') hits = prev.filter((n) => !keep(barOf(n))).map((n) => ({ step: n.step, len: n.len, old: n }));
    else {
      hits = [];
      for (let b = 0; b < ctx.bars; b++) {
        const hb = barRhythm(p, ctx, rr, b);
        if (!keep(b)) hits.push(...hb);
      }
      if (p.onChange) hits = onChanges(hits, ctx, keep);
    }
    const kept = prev.filter((n) => keep(barOf(n)));
    const all = kept.map((n) => ({ step: n.step, len: n.len, note: n })).concat(hits).sort((a, b) => a.step - b.step);
    let last = null;
    const out = [];
    all.forEach((h) => {
      if (h.note) { out.push(h.note); last = { midi: h.note.midi, mel: melodyAt(ctx, h.step, h.len) }; return; }
      let midi, mel = melodyAt(ctx, h.step, h.len);
      if (mode === 'rhythm') {
        const src = prev.filter((n) => n.step <= h.step).pop() || prev[0];
        midi = src.midi;
      } else if (mode === 'mutate' && h.old && rn() > 0.3) midi = h.old.midi;
      else ({ midi, mel } = pickPitch(p, ctx, rn, h, last));
      const n = { step: h.step, len: h.len, midi, vel: h.step % 16 === 0 ? 1 : h.step % 4 === 0 ? 0.92 : 0.78 + rn() * 0.14, slide: false };
      if (mode === 'notes' || mode === 'mutate') { n.vel = h.old.vel; n.shot = h.old.shot; }
      const before = out[out.length - 1];
      if (before && before.step + before.len === n.step && before.midi !== n.midi) {
        const leap = Math.abs(before.midi - n.midi) >= 5 ? 1.3 : 0.8;
        n.slide = rn() < Math.min(1, (p.glide + (st.glide || 0) * p.glide * 2) * leap);
      }
      out.push(n);
      last = { midi, mel };
    });
    // one-shot pool assignment
    if (ctx.shotIds && ctx.shotIds.length > 1 && p.shotMode !== 'one') {
      const rs = CS.rng(opts.seedN ^ 0x5bd1e995);
      const perBar = {};
      out.forEach((n) => {
        if (keep(barOf(n)) || (n.shot && (mode === 'notes' || mode === 'mutate') && rs() < 0.7)) return;
        if (p.shotMode === 'bar') n.shot = perBar[barOf(n)] || (perBar[barOf(n)] = rs.pick(ctx.shotIds));
        else n.shot = rs.pick(ctx.shotIds);
      });
    } else out.forEach((n) => { if (!keep(barOf(n))) delete n.shot; });
    return CS.normalize(out, ctx.total);
  };

  // New pitch for one note, keeping everything else.
  CS.rerollNote = function (p, ctx, notes, i, seed) {
    const r = CS.rng(seed), n = notes[i], before = notes[i - 1];
    const prev = before ? { midi: before.midi, mel: melodyAt(ctx, before.step, before.len) } : null;
    const c = CS.candidates(p, ctx, n, prev, false);
    const list = c.list.filter((x) => x.midi !== n.midi);
    if (list.length) n.midi = r.weighted(list, (x) => x.w).midi;
  };

  // Colour class of a bass note against its chord / key / melody.
  CS.noteRole = function (ctx, n) {
    const ch = ctx.chordAt(n.step), pc = n.midi % 12;
    const mel = melodyAt(ctx, n.step, n.len);
    if (!isNaN(mel) && CONS[(CS.pc(mel) - pc + 12) % 12] < 0.35) return 'clash';
    if (pc === ch.root) return 'root';
    if (CS.chordPcs(ch).has(pc)) return 'chord';
    if (ctx.scale.has(pc)) return 'key';
    return 'out';
  };
})(window.CS);
