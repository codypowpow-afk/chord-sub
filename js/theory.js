// Music theory: note names, scales, chord types, roman numerals and chord detection from chroma.
window.CS = window.CS || {};

(function (CS) {
  'use strict';

  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  CS.NOTE_NAMES = SHARP;
  CS.pc = (m) => ((Math.round(m) % 12) + 12) % 12;

  CS.SCALES = {
    maj: { name: 'Major', ints: [0, 2, 4, 5, 7, 9, 11], rel: 'maj' },
    min: { name: 'Minor', ints: [0, 2, 3, 5, 7, 8, 10], rel: 'min' },
    hmin: { name: 'Harmonic minor', ints: [0, 2, 3, 5, 7, 8, 11], rel: 'min' },
    dor: { name: 'Dorian', ints: [0, 2, 3, 5, 7, 9, 10], rel: 'min' },
    phr: { name: 'Phrygian', ints: [0, 1, 3, 5, 7, 8, 10], rel: 'min' },
    mix: { name: 'Mixolydian', ints: [0, 2, 4, 5, 7, 9, 10], rel: 'maj' },
  };

  CS.useFlats = function (key, mode) {
    const major = CS.SCALES[mode] && CS.SCALES[mode].rel === 'min' ? (key + 3) % 12 : key;
    return [5, 10, 3, 8, 1, 6].includes(major);
  };
  CS.pcName = function (pc, flats) { return (flats ? FLAT : SHARP)[((pc % 12) + 12) % 12]; };
  CS.midiName = function (m, flats) {
    const r = Math.round(m);
    return CS.pcName(r, flats) + (Math.floor(r / 12) - 1);
  };
  CS.scalePcs = function (key, mode) {
    return new Set((CS.SCALES[mode] || CS.SCALES.min).ints.map((i) => (key + i) % 12));
  };

  // prior: score handicap so plain triads win unless an extension is clearly there
  CS.CHORD_TYPES = [
    { id: 'maj', suf: '', ints: [0, 4, 7], prior: 0 },
    { id: 'min', suf: 'm', ints: [0, 3, 7], prior: 0 },
    { id: '7', suf: '7', ints: [0, 4, 7, 10], prior: -0.07 },
    { id: 'm7', suf: 'm7', ints: [0, 3, 7, 10], prior: -0.06 },
    { id: 'maj7', suf: 'maj7', ints: [0, 4, 7, 11], prior: -0.07 },
    { id: 'dim', suf: '°', ints: [0, 3, 6], prior: -0.12 },
    { id: 'm7b5', suf: 'm7♭5', ints: [0, 3, 6, 10], prior: -0.14 },
    { id: 'sus2', suf: 'sus2', ints: [0, 2, 7], prior: -0.1 },
    { id: 'sus4', suf: 'sus4', ints: [0, 5, 7], prior: -0.1 },
    { id: '5', suf: '5', ints: [0, 7], prior: -0.14 },
  ];
  const TYPE = {};
  CS.CHORD_TYPES.forEach((t) => { TYPE[t.id] = t; });
  CS.chordType = (id) => TYPE[id] || TYPE.maj;

  CS.chordPcs = (ch) => new Set(CS.chordType(ch.type).ints.map((i) => (ch.root + i) % 12));
  CS.chordName = (ch, flats) => (ch ? CS.pcName(ch.root, flats) + CS.chordType(ch.type).suf : '—');

  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
  CS.roman = function (ch, key, mode) {
    if (!ch) return '';
    const sc = (CS.SCALES[mode] || CS.SCALES.min).ints;
    const rel = (ch.root - key + 12) % 12;
    const t = CS.chordType(ch.type);
    let deg = sc.indexOf(rel), acc = '';
    if (deg < 0) {
      // outside the mode: a major-scale degree, else a flattened one
      const maj = CS.SCALES.maj.ints;
      deg = maj.indexOf(rel);
      if (deg < 0) { deg = maj.indexOf((rel + 1) % 12); acc = '♭'; }
    }
    const minor = t.ints[1] === 3 || t.id === 'dim' || t.id === 'm7b5';
    let s = acc + (minor ? ROMAN[deg].toLowerCase() : ROMAN[deg]);
    if (t.id === 'dim') s += '°';
    else if (t.id === 'm7b5') s += 'ø';
    else if (t.id === 'min') s += '';
    else if (t.id === 'm7') s += '7';
    else if (t.suf) s += t.suf;
    return s;
  };

  // Diatonic triads (and 7ths) of the key, for the chord picker.
  CS.diatonic = function (key, mode, sevenths) {
    const sc = (CS.SCALES[mode] || CS.SCALES.min).ints;
    return sc.map((r, d) => {
      const third = (sc[(d + 2) % 7] - r + 12) % 12, fifth = (sc[(d + 4) % 7] - r + 12) % 12, sev = (sc[(d + 6) % 7] - r + 12) % 12;
      let type;
      if (third === 4 && fifth === 7) type = sevenths ? (sev === 11 ? 'maj7' : '7') : 'maj';
      else if (third === 3 && fifth === 7) type = sevenths ? 'm7' : 'min';
      else if (third === 3 && fifth === 6) type = sevenths ? 'm7b5' : 'dim';
      else type = 'maj';
      return { root: (key + r) % 12, type };
    });
  };

  // ---------- chord detection ----------
  // Each segment's chroma (treble + half the bass band) is correlated against weighted chord
  // templates. Bonuses: the bass band agreeing with the root, and every tone being in key.
  // Returns [{root, type, score, alts: [{root, type, score}], quiet}] per segment.
  CS.detectChords = function (ch, segs, key, mode) {
    const scale = CS.scalePcs(key, mode);
    const spans = segs.map(([a, b]) => CS.chromaSpan(ch, a, b));
    const maxE = Math.max(1e-12, ...spans.map((s) => s.e / Math.max(1, s.n)));
    const tmpl = [];
    CS.CHORD_TYPES.forEach((t) => {
      for (let root = 0; root < 12; root++) {
        const v = new Array(12).fill(0);
        t.ints.forEach((iv, k) => { v[(root + iv) % 12] = k === 0 ? 1 : k === 1 ? 0.85 : k === 2 ? 0.8 : 0.6; });
        if (t.id === '5') v[(root + 7) % 12] = 0.85;
        const diatonic = t.ints.every((iv) => scale.has((root + iv) % 12));
        tmpl.push({ root, type: t.id, v, prior: t.prior + (diatonic ? 0.06 : 0) });
      }
    });
    const out = spans.map((sp) => {
      const quiet = sp.n === 0 || sp.e / Math.max(1, sp.n) < maxE * 0.02;
      const h = sp.c.map((x, i) => x + sp.b[i] * 0.5);
      const bt = sp.b.reduce((a, b) => a + b, 0) || 1;
      const ranked = tmpl.map((t) => {
        const r = CS.pearson(h, t.v, 0);
        const bassFit = sp.b[t.root] / bt;
        return { root: t.root, type: t.type, score: r + t.prior + bassFit * 0.25 };
      }).sort((a, b) => b.score - a.score);
      const alts = [];
      ranked.forEach((c) => { if (alts.length < 6 && !alts.some((a) => a.root === c.root && a.type === c.type)) alts.push(c); });
      return { root: ranked[0].root, type: ranked[0].type, score: ranked[0].score, alts, quiet };
    });
    // silent segments inherit the chord before (or after) them
    for (let i = 0; i < out.length; i++) {
      if (!out[i].quiet) continue;
      const src = out.slice(0, i).reverse().find((c) => !c.quiet) || out.slice(i + 1).find((c) => !c.quiet);
      if (src) { out[i].root = src.root; out[i].type = src.type; }
    }
    return out;
  };

  // Key from the whole clip: chroma + bass + melody note histogram.
  CS.keyFromAnalysis = function (ch, melody) {
    const all = CS.chromaSpan(ch, 0, Infinity);
    const tot = all.c.reduce((a, b) => a + b, 0) || 1, btot = all.b.reduce((a, b) => a + b, 0) || 1;
    const h = all.c.map((v, i) => v / tot + (all.b[i] / btot) * 0.6);
    if (melody) {
      const mh = new Array(12).fill(0);
      let n = 0;
      melody.forEach((m) => { if (!isNaN(m)) { mh[CS.pc(m)]++; n++; } });
      if (n) mh.forEach((v, i) => { h[i] += (v / n) * 0.5; });
    }
    return CS.detectKey(h);
  };
})(window.CS);
