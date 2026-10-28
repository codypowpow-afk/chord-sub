// DSP + file helpers: seeded RNG, YIN pitch tracking, FFT chroma, tempo / loop-length
// detection, key detection, one-shot root detection, WAV / MIDI encoders.
window.CS = window.CS || {};

(function (CS) {
  'use strict';

  // ---------- RNG ----------
  CS.rng = function (seed) {
    let a = seed >>> 0;
    const r = function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    r.int = (n) => Math.floor(r() * n);
    r.pick = (arr) => arr[Math.floor(r() * arr.length)];
    r.chance = (p) => r() < p;
    r.weighted = (items, weight) => {
      let tot = 0;
      items.forEach((it) => { tot += weight(it); });
      let x = r() * tot;
      for (const it of items) { x -= weight(it); if (x <= 0) return it; }
      return items[items.length - 1];
    };
    return r;
  };
  CS.newSeed = () => (Math.random() * 0xffffffff) >>> 0;

  CS.mono = function (buffer) {
    const n = buffer.length, out = new Float32Array(n);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i];
    }
    const k = 1 / buffer.numberOfChannels;
    for (let i = 0; i < n; i++) out[i] *= k;
    return out;
  };

  const median = (arr) => {
    const s = arr.slice().sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  CS.median = median;

  // Box-filtered copy at roughly `target` Hz.
  function downsample(x, sr, target) {
    const D = Math.max(1, Math.round(sr / target));
    const n = Math.floor(x.length / D), y = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < D; k++) s += x[i * D + k]; y[i] = s / D; }
    return { y, D, sr: sr / D };
  }

  // ---------- pitch tracking (YIN) ----------
  // Monophonic pitch per frame on a ~22 kHz copy. Async so the UI can show progress.
  CS.track = async function (buffer, onProgress, fmin, fmax, maxSec) {
    fmin = fmin || 65; fmax = fmax || 1400;
    let x = CS.mono(buffer);
    if (maxSec) x = x.subarray(0, Math.min(x.length, Math.round(maxSec * buffer.sampleRate)));
    const { y, D, sr: srd } = downsample(x, buffer.sampleRate, 22050);
    const n = y.length;
    const tauMin = Math.max(2, Math.floor(srd / fmax)), tauMax = Math.ceil(srd / fmin);
    const W = Math.max(640, tauMax);
    const hop = Math.max(128, Math.ceil(n / 2400));
    const frames = Math.max(0, Math.floor((n - W - tauMax) / hop) + 1);
    const midi = new Float32Array(frames).fill(NaN), ap = new Float32Array(frames).fill(1), rms = new Float32Array(frames);
    let maxRms = 1e-9;
    for (let f = 0; f < frames; f++) {
      let s = 0;
      for (let j = 0, o = f * hop; j < W; j++) s += y[o + j] * y[o + j];
      rms[f] = Math.sqrt(s / W);
      if (rms[f] > maxRms) maxRms = rms[f];
    }
    const gate = maxRms * 0.025, d = new Float32Array(tauMax + 2);
    for (let f = 0; f < frames; f++) {
      if (onProgress && f % 300 === 0) { onProgress(f / frames); await new Promise((r) => setTimeout(r, 0)); }
      if (rms[f] < gate) continue;
      const o = f * hop;
      for (let tau = 1; tau <= tauMax + 1; tau++) {
        let s = 0;
        for (let j = 0; j < W; j++) { const v = y[o + j] - y[o + j + tau]; s += v * v; }
        d[tau] = s;
      }
      let run = 0;
      for (let tau = 1; tau <= tauMax + 1; tau++) { run += d[tau]; d[tau] = run > 0 ? (d[tau] * tau) / run : 1; }
      let best = -1;
      for (let tau = tauMin; tau <= tauMax; tau++) {
        if (d[tau] < 0.15) { while (tau < tauMax && d[tau + 1] < d[tau]) tau++; best = tau; break; }
      }
      if (best < 0) { best = tauMin; for (let tau = tauMin; tau <= tauMax; tau++) if (d[tau] < d[best]) best = tau; }
      let t = best;
      const s0 = d[best - 1], s1 = d[best], s2 = d[best + 1], den = s0 + s2 - 2 * s1;
      if (den > 0) t = best + (s0 - s2) / (2 * den);
      ap[f] = s1;
      if (s1 < 0.3) midi[f] = 69 + 12 * Math.log2(srd / t / 440);
    }
    if (onProgress) onProgress(1);
    // frame f covers samples [f*hop*D, f*hop*D + W*D) of the original
    return { hop: hop * D, win: W * D, frames, midi, ap, rms, maxRms };
  };

  // Melody pitch per grid step (NaN where unvoiced): median of the voiced frames in the step
  // when at least 40% of its audible frames carry a pitch.
  CS.melodySteps = function (tr, start, stepLen, nSteps) {
    const out = new Float32Array(nSteps).fill(NaN);
    if (!tr) return out;
    for (let s = 0; s < nSteps; s++) {
      const a0 = start + s * stepLen, b0 = a0 + stepLen;
      const a = Math.max(0, Math.floor((a0 - tr.win * 0.5) / tr.hop));
      const b = Math.min(tr.frames, Math.max(a + 1, Math.ceil((b0 - tr.win * 0.5) / tr.hop)));
      const v = [];
      let loud = 0;
      for (let f = a; f < b; f++) {
        if (tr.rms[f] < tr.maxRms * 0.04) continue;
        loud++;
        if (!isNaN(tr.midi[f])) v.push(tr.midi[f]);
      }
      if (v.length && v.length >= loud * 0.4) out[s] = median(v);
    }
    return out;
  };

  // ---------- FFT ----------
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < h; k++) {
          const a = i + k, b = a + h;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  // ---------- chroma ----------
  // Polyphonic pitch-class energy per frame from spectral peaks (parabolic-interpolated so low
  // notes land on the right semitone). Two bands: "treble" 80-2400 Hz for harmony / melody and
  // "bass" 38-260 Hz for chord roots. Frame f is centred on sample (f * hop + win / 2).
  CS.chroma = async function (buffer, onProgress) {
    const { y, D, sr: srd } = downsample(CS.mono(buffer), buffer.sampleRate, 11025);
    const N = 4096, hop = 512, half = N / 2;
    const frames = Math.max(1, Math.floor((y.length - N) / hop) + 1);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    const chroma = new Float32Array(frames * 12), bass = new Float32Array(frames * 12), energy = new Float32Array(frames);
    const re = new Float32Array(N), im = new Float32Array(N), mag = new Float32Array(half);
    const kLo = Math.floor((38 * N) / srd), kHi = Math.min(half - 2, Math.ceil((2400 * N) / srd));
    for (let f = 0; f < frames; f++) {
      if (onProgress && f % 60 === 0) { onProgress(f / frames); await new Promise((r) => setTimeout(r, 0)); }
      const o = f * hop;
      for (let i = 0; i < N; i++) { re[i] = (y[o + i] || 0) * win[i]; im[i] = 0; }
      fft(re, im);
      let mx = 0, e = 0;
      for (let k = 0; k < half; k++) { const m = Math.hypot(re[k], im[k]); mag[k] = m; e += m * m; if (k >= kLo && k <= kHi && m > mx) mx = m; }
      energy[f] = e;
      if (mx <= 0) continue;
      const floor = mx * 0.03;
      for (let k = Math.max(1, kLo); k <= kHi; k++) {
        const b = mag[k];
        if (b < floor || b < mag[k - 1] || b < mag[k + 1]) continue;
        const la = Math.log(mag[k - 1] + 1e-12), lb = Math.log(b), lc = Math.log(mag[k + 1] + 1e-12);
        const den = la - 2 * lb + lc;
        const p = den < 0 ? (0.5 * (la - lc)) / den : 0;
        const fr = ((k + p) * srd) / N;
        if (fr < 38) continue;
        const m = 69 + 12 * Math.log2(fr / 440), r = Math.round(m), dev = m - r;
        const w = Math.cos(Math.PI * dev) ** 2 * b, pc = ((r % 12) + 12) % 12;
        if (fr >= 80) chroma[f * 12 + pc] += w;
        if (fr <= 260) bass[f * 12 + pc] += w;
      }
    }
    if (onProgress) onProgress(1);
    return { hop: hop * D, win: N * D, frames, chroma, bass, energy };
  };

  // Predominant (top) melody for polyphonic clips: harmonic-sum salience per semitone from
  // D3 to C7 on a 2048-point STFT, with a lean towards higher notes since the melody usually sits
  // on top. Same shape as CS.track's result, so CS.melodySteps can read either.
  CS.salience = async function (buffer, onProgress) {
    const { y, D, sr: srd } = downsample(CS.mono(buffer), buffer.sampleRate, 11025);
    const N = 2048, hop = 256, half = N / 2, df = srd / N;
    const frames = Math.max(1, Math.floor((y.length - N) / hop) + 1);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    const re = new Float32Array(N), im = new Float32Array(N), mag = new Float32Array(half);
    const midi = new Float32Array(frames).fill(NaN), sal = new Float32Array(frames), ap = new Float32Array(frames).fill(0);
    const M0 = 50, M1 = 96;
    let maxSal = 1e-9;
    for (let f = 0; f < frames; f++) {
      if (onProgress && f % 120 === 0) { onProgress(f / frames); await new Promise((r) => setTimeout(r, 0)); }
      const o = f * hop;
      for (let i = 0; i < N; i++) { re[i] = (y[o + i] || 0) * win[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k < half; k++) mag[k] = Math.sqrt(Math.hypot(re[k], im[k]));
      let best = -1, bestS = 0, bestRaw = 0;
      for (let m = M0; m <= M1; m++) {
        const f0 = 440 * Math.pow(2, (m - 69) / 12);
        let s = 0;
        for (let h = 1; h <= 5; h++) {
          const k = (f0 * h) / df;
          if (k >= half - 2) break;
          const k0 = Math.floor(k);
          s += Math.max(mag[k0], mag[k0 + 1], mag[k0 - 1] * 0.5, mag[k0 + 2] * 0.5) / h;
        }
        const sc = s * (1 + 0.012 * (m - M0));
        if (sc > bestS) { bestS = sc; best = m; bestRaw = s; }
      }
      sal[f] = bestRaw;
      if (bestRaw > maxSal) maxSal = bestRaw;
      midi[f] = best;
    }
    for (let f = 0; f < frames; f++) if (sal[f] < maxSal * 0.2) midi[f] = NaN;
    if (onProgress) onProgress(1);
    return { hop: hop * D, win: N * D, frames, midi, ap, rms: sal, maxRms: maxSal };
  };

  // Share of audible frames where YIN found a clean single pitch: high for solo leads / vocals.
  CS.monophony = function (tr) {
    let loud = 0, clean = 0;
    for (let f = 0; f < tr.frames; f++) {
      if (tr.rms[f] < tr.maxRms * 0.08) continue;
      loud++;
      if (!isNaN(tr.midi[f]) && tr.ap[f] < 0.12) clean++;
    }
    return loud ? clean / loud : 0;
  };

  // Sum of chroma frames centred inside [a, b) samples. Returns {c: 12, b: 12, e}.
  CS.chromaSpan = function (ch, a, b) {
    const c = new Array(12).fill(0), bs = new Array(12).fill(0);
    let e = 0;
    const f0 = Math.max(0, Math.ceil((a - ch.win / 2) / ch.hop)), f1 = Math.min(ch.frames, Math.ceil((b - ch.win / 2) / ch.hop));
    for (let f = f0; f < f1; f++) {
      for (let i = 0; i < 12; i++) { c[i] += ch.chroma[f * 12 + i]; bs[i] += ch.bass[f * 12 + i]; }
      e += ch.energy[f];
    }
    return { c, b: bs, e, n: Math.max(0, f1 - f0) };
  };

  // ---------- tempo / loop length ----------
  // Onset-envelope autocorrelation gives a tempo guess; a loop is assumed to be a whole number of
  // bars, so the bar count whose implied tempo agrees best with that guess wins.
  CS.tempo = function (buffer) {
    const { y, sr: srd } = downsample(CS.mono(buffer), buffer.sampleRate, 11025);
    const hop = 128, W = 512;
    const frames = Math.floor((y.length - W) / hop);
    const dur = buffer.duration;
    let bpmA = 120, conf = 0;
    if (frames > 64) {
      const e = new Float32Array(frames), eh = new Float32Array(frames);
      let mx = 0;
      for (let f = 0; f < frames; f++) {
        let s = 0, sh = 0, prev = y[f * hop];
        for (let i = 0; i < W; i++) { const v = y[f * hop + i]; s += v * v; const dd = v - prev; prev = v; sh += dd * dd; }
        e[f] = s; eh[f] = sh; if (s > mx) mx = s;
      }
      const eps = mx * 1e-5 + 1e-12, odf = new Float32Array(frames);
      for (let f = 2; f < frames; f++) {
        odf[f] = Math.max(0, Math.log((e[f] + eps) / (e[f - 2] + eps))) + Math.max(0, Math.log((eh[f] + eps) / (eh[f - 2] + eps)));
      }
      let mean = 0;
      for (let f = 0; f < frames; f++) mean += odf[f];
      mean /= frames;
      for (let f = 0; f < frames; f++) odf[f] = Math.max(0, odf[f] - mean);
      const fps = srd / hop;
      const lagMin = Math.floor((60 / 200) * fps), lagMax = Math.min(frames - 2, Math.ceil((60 / 55) * fps));
      const r = new Float32Array(lagMax + 2);
      let r0 = 1e-12;
      for (let i = 0; i < frames; i++) r0 += odf[i] * odf[i];
      let best = -1, bestV = -1;
      for (let l = lagMin; l <= lagMax; l++) {
        let s = 0;
        for (let i = 0; i + l < frames; i++) s += odf[i] * odf[i + l];
        r[l] = s / (frames - l);
        const bpm = (60 * fps) / l;
        const wgt = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
        if (r[l] * wgt > bestV) { bestV = r[l] * wgt; best = l; }
      }
      if (best > lagMin && best < lagMax) {
        const a = r[best - 1], b = r[best], c = r[best + 1], den = a - 2 * b + c;
        const p = den < 0 ? (0.5 * (a - c)) / den : 0;
        bpmA = (60 * fps) / (best + p);
        conf = (r[best] * (frames - best)) / r0;
      }
    }
    let pick = null;
    [1, 2, 4, 8, 16, 32].forEach((bars) => {
      const bpm = (bars * 240) / dur;
      if (bpm < 60 || bpm > 200) return;
      let d = Infinity;
      [0.5, 1, 2].forEach((m) => { d = Math.min(d, Math.abs(Math.log2(bpm / (bpmA * m)))); });
      if (bpm < 80 || bpm > 178) d += 0.02;
      if (!pick || d < pick.d) pick = { bars, bpm, d };
    });
    if (pick && pick.d < 0.06) {
      const round = Math.round(pick.bpm);
      const bpm = Math.abs(round - pick.bpm) / pick.bpm < 0.004 ? round : Math.round(pick.bpm * 100) / 100;
      return { bpm, bars: Math.min(16, pick.bars), loop: true, guess: bpmA, conf };
    }
    let bpm = bpmA;
    while (bpm < 70) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    bpm = Math.round(bpm);
    const bars = Math.max(1, Math.min(16, Math.floor((dur * bpm) / 240 + 0.15)));
    return { bpm, bars, loop: false, guess: bpmA, conf };
  };

  // ---------- key ----------
  // Krumhansl-Kessler profiles correlated against a 12-bin pitch-class histogram.
  const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  CS.pearson = function (h, prof, k) {
    const mx = h.reduce((a, b) => a + b, 0) / 12, mp = prof.reduce((a, b) => a + b, 0) / 12;
    let num = 0, dx = 0, dp = 0;
    for (let i = 0; i < 12; i++) {
      const a = h[(i + k) % 12] - mx, b = prof[i] - mp;
      num += a * b; dx += a * a; dp += b * b;
    }
    return num / Math.sqrt(dx * dp + 1e-12);
  };
  CS.detectKey = function (h) {
    if (h.every((v) => !v)) return { key: 9, mode: 'min', r: 0 };
    let best = { key: 0, mode: 'maj', r: -2 };
    for (let k = 0; k < 12; k++) {
      const a = CS.pearson(h, KK_MAJ, k), b = CS.pearson(h, KK_MIN, k);
      if (a > best.r) best = { key: k, mode: 'maj', r: a };
      if (b > best.r) best = { key: k, mode: 'min', r: b };
    }
    return best;
  };

  // ---------- one-shot root ----------
  // Pitch of a bass one-shot from its first second (808s and subs sit at 25-200 Hz).
  CS.detectRoot = async function (buffer) {
    const tr = await CS.track(buffer, null, 25, 700, 1.2);
    const v = [];
    for (let f = 0; f < tr.frames; f++) {
      if (isNaN(tr.midi[f]) || tr.rms[f] < tr.maxRms * 0.12) continue;
      v.push(tr.midi[f]);
    }
    if (v.length < 2) return null;
    // the attack of an 808 is often bent up: prefer the settled body
    const body = v.slice(Math.floor(v.length * 0.25));
    return median(body.length ? body : v);
  };

  // ---------- encoders ----------
  CS.encodeWav = function (channels, sampleRate) {
    const n = channels[0].length, chs = channels.length;
    const buf = new ArrayBuffer(44 + n * chs * 2);
    const dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * chs * 2, true); w(8, 'WAVE');
    w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, chs, true);
    dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * chs * 2, true);
    dv.setUint16(32, chs * 2, true); dv.setUint16(34, 16, true);
    w(36, 'data'); dv.setUint32(40, n * chs * 2, true);
    let o = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < chs; c++) {
        const v = Math.max(-1, Math.min(1, channels[c][i]));
        dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2;
      }
    }
    return new Uint8Array(buf);
  };

  // Format-1 MIDI. tracks: [{name, channel, events: [{step (16ths), len, note, vel 0..1}]}]
  CS.encodeMidi = function (tracks, bpm, totalSteps) {
    const PPQ = 96, TPS = PPQ / 4;
    const chunk = (type, bytes) => {
      const out = [];
      for (let i = 0; i < 4; i++) out.push(type.charCodeAt(i));
      out.push((bytes.length >>> 24) & 255, (bytes.length >>> 16) & 255, (bytes.length >>> 8) & 255, bytes.length & 255);
      return out.concat(bytes);
    };
    const vlq = (bytes, v) => {
      const st = [v & 0x7f];
      while ((v >>= 7)) st.unshift((v & 0x7f) | 0x80);
      bytes.push(...st);
    };
    const enc = new TextEncoder();
    const out = chunk('MThd', [0, 1, 0, tracks.length + 1, (PPQ >> 8) & 255, PPQ & 255]);
    const tempo = Math.round(60000000 / bpm);
    const meta = [];
    vlq(meta, 0); meta.push(0xff, 0x51, 0x03, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255);
    vlq(meta, 0); meta.push(0xff, 0x58, 0x04, 4, 2, 24, 8);
    vlq(meta, totalSteps * TPS); meta.push(0xff, 0x2f, 0x00);
    out.push(...chunk('MTrk', meta));
    tracks.forEach((tk) => {
      const msgs = [];
      tk.events.forEach((e) => {
        const on = Math.round(e.step * TPS), off = Math.max(on + 1, Math.round((e.step + e.len) * TPS) - 1);
        const vel = Math.max(1, Math.min(127, Math.round(e.vel * 127)));
        const note = Math.max(0, Math.min(127, Math.round(e.note)));
        msgs.push({ t: on, d: [0x90 | tk.channel, note, vel] });
        msgs.push({ t: off, d: [0x80 | tk.channel, note, 0] });
      });
      msgs.sort((a, b) => a.t - b.t || ((a.d[0] & 0xf0) === 0x80 ? -1 : 1));
      const bytes = [];
      const name = Array.from(enc.encode(tk.name));
      vlq(bytes, 0); bytes.push(0xff, 0x03); vlq(bytes, name.length); bytes.push(...name);
      let last = 0;
      msgs.forEach((m) => { vlq(bytes, m.t - last); last = m.t; bytes.push(...m.d); });
      vlq(bytes, Math.max(0, totalSteps * TPS - last)); bytes.push(0xff, 0x2f, 0x00);
      out.push(...chunk('MTrk', bytes));
    });
    return new Uint8Array(out);
  };

  CS.download = function (blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  // ---------- demo loop ----------
  // 4 bars at 120 BPM in A minor: a soft saw pad on Am - F - C - G with a triangle lead on top,
  // so the app is playable before any file is loaded.
  CS.makeDemo = async function (sampleRate) {
    const bpm = 120, beat = 60 / bpm, len = 16 * beat;
    const off = new OfflineAudioContext(1, Math.ceil(len * sampleRate), sampleRate);
    const out = off.createGain(); out.gain.value = 0.5; out.connect(off.destination);
    const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
    const chords = [[57, 60, 64], [53, 57, 60], [55, 60, 64], [55, 59, 62]];
    chords.forEach((ch, b) => {
      const t = b * 4 * beat;
      const g = off.createGain(), lp = off.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 1400;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.11, t + 0.08);
      g.gain.setValueAtTime(0.11, t + 4 * beat - 0.08); g.gain.linearRampToValueAtTime(0, t + 4 * beat);
      lp.connect(g); g.connect(out);
      ch.forEach((m) => [-6, 6].forEach((dc) => {
        const o = off.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(m); o.detune.value = dc;
        o.connect(lp); o.start(t); o.stop(t + 4 * beat);
      }));
    });
    const mel = [[76, 0, 1], [72, 1, 1], [69, 2, 1], [72, 3, 0.5], [74, 3.5, 0.5],
      [69, 4, 1.5], [72, 5.5, 0.5], [77, 6, 1], [76, 7, 1],
      [79, 8, 1], [76, 9, 1], [72, 10, 1], [76, 11, 1],
      [74, 12, 1.5], [71, 13.5, 0.5], [67, 14, 1], [71, 15, 1]];
    mel.forEach(([m, b, d]) => {
      const t = b * beat, dur = d * beat - 0.03;
      const o = off.createOscillator(), g = off.createGain();
      o.type = 'triangle'; o.frequency.value = hz(m);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 0.012);
      g.gain.setTargetAtTime(0.3, t + 0.012, 0.15); g.gain.setTargetAtTime(0, t + dur - 0.02, 0.01);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.1);
    });
    // a high tick on the 8ths (above the chroma band) gives the tempo detector something to lock to
    for (let b = 0; b < 32; b++) {
      const t = (b * beat) / 2, o = off.createOscillator(), g = off.createGain();
      o.frequency.value = 5200;
      g.gain.setValueAtTime(b % 2 ? 0.05 : 0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.05);
    }
    return off.startRendering();
  };
})(window.CS);
