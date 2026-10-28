// Modular sub-bass voice: OSC 1, OSC 2 (detuned pair), SUB, NOISE and a pitched ONE-SHOT
// sampler feed DRIVE -> FILTER -> AMP, with PITCH (808 drop), GLIDE and a tempo-synced LFO.
// Every module can be switched off; presets are partial patches over the defaults.
window.CS = window.CS || {};

(function (CS) {
  'use strict';

  CS.SYNTH_DEFAULT = {
    src: 'synth', // synth | sample | layer
    o1On: true, o1Type: 'sine', o1Oct: 0, o1Semi: 0, o1Lvl: 0.9,
    o2On: false, o2Type: 'sawtooth', o2Oct: 0, o2Det: 12, o2Lvl: 0.4,
    subOn: false, subLvl: 0.5,
    noiseOn: false, noiseLvl: 0.15, noiseDec: 0.08,
    smpLvl: 1, smpTune: 0, smpLoop: false,
    driveOn: false, driveType: 'soft', drive: 0.3,
    filterOn: true, fType: 'lowpass', cutoff: 900, res: 0.7, fEnv: 0, fDecay: 0.25, fKey: 0,
    atk: 0.004, dec: 0.3, sus: 1, rel: 0.08,
    pitchOn: false, pAmt: 12, pDec: 0.06,
    glide: 0.06,
    lfoOn: false, lfoDest: 'cutoff', lfoShape: 'sine', lfoDiv: '1/8', lfoDepth: 0.5,
    level: 0.8,
  };

  CS.LFO_DIVS = { '2/1': 8, '1/1': 4, '1/2': 2, '1/4': 1, '1/4T': 2 / 3, '1/8': 0.5, '1/8T': 1 / 3, '1/16': 0.25, '1/32': 0.125 };

  const P = (name, p) => ({ name, p });
  CS.PRESETS = [
    P('Pure Sine', {}),
    P('Warm Sub', { o1Type: 'triangle', subOn: true, subLvl: 0.35, cutoff: 500, driveOn: true, drive: 0.15 }),
    P('808 Boom', { pitchOn: true, pAmt: 12, pDec: 0.05, dec: 1.4, sus: 0.25, rel: 0.4, driveOn: true, drive: 0.25, cutoff: 1800, glide: 0.09 }),
    P('808 Distorted', { pitchOn: true, pAmt: 14, pDec: 0.04, dec: 1.1, sus: 0.35, rel: 0.3, driveOn: true, driveType: 'hard', drive: 0.75, cutoff: 2600, glide: 0.1 }),
    P('808 Slide', { pitchOn: true, pAmt: 7, pDec: 0.05, sus: 0.8, dec: 0.9, rel: 0.25, driveOn: true, drive: 0.35, cutoff: 2200, glide: 0.16 }),
    P('Reese', { o1Type: 'sawtooth', o1Lvl: 0.5, o2On: true, o2Type: 'sawtooth', o2Det: 18, o2Lvl: 0.55, subOn: true, subLvl: 0.6, cutoff: 650, res: 2, driveOn: true, drive: 0.3 }),
    P('Wobble', { o1Type: 'sawtooth', o1Lvl: 0.6, o2On: true, o2Type: 'square', o2Det: 9, o2Lvl: 0.4, subOn: true, subLvl: 0.5, cutoff: 350, res: 6, lfoOn: true, lfoDest: 'cutoff', lfoDiv: '1/8', lfoDepth: 0.75, driveOn: true, drive: 0.4 }),
    P('Square Sub', { o1Type: 'square', o1Lvl: 0.55, cutoff: 420, res: 0.5, subOn: true, subLvl: 0.4 }),
    P('Growl', { o1Type: 'sawtooth', o1Lvl: 0.7, o2On: true, o2Type: 'sawtooth', o2Oct: 1, o2Det: 7, o2Lvl: 0.3, subOn: true, subLvl: 0.6, driveOn: true, driveType: 'fold', drive: 0.55, cutoff: 900, res: 4, lfoOn: true, lfoDiv: '1/16', lfoDepth: 0.45 }),
    P('Acid', { o1Type: 'sawtooth', o1Oct: 1, o1Lvl: 0.7, cutoff: 260, res: 14, fEnv: 0.65, fDecay: 0.18, sus: 0.7, driveOn: true, drive: 0.35, glide: 0.08 }),
    P('Garage Organ', { o1Type: 'square', o1Lvl: 0.45, o2On: true, o2Type: 'sine', o2Oct: 1, o2Det: 0, o2Lvl: 0.35, subOn: true, subLvl: 0.6, cutoff: 1200, dec: 0.22, sus: 0.45, rel: 0.06 }),
    P('Deep House', { o1Type: 'triangle', subOn: true, subLvl: 0.45, cutoff: 700, fEnv: 0.25, fDecay: 0.12, dec: 0.25, sus: 0.55, rel: 0.05 }),
    P('DnB Roller', { o1Type: 'sine', subOn: false, o2On: true, o2Type: 'triangle', o2Oct: 1, o2Det: 0, o2Lvl: 0.18, driveOn: true, drive: 0.2, cutoff: 1100, glide: 0.07, rel: 0.05 }),
    P('Pluck Sub', { o1Type: 'triangle', subOn: true, subLvl: 0.5, cutoff: 500, fEnv: 0.5, fDecay: 0.08, dec: 0.18, sus: 0.2, rel: 0.12, noiseOn: true, noiseLvl: 0.1, noiseDec: 0.02 }),
    P('Tape Sub', { o1Type: 'sine', driveOn: true, driveType: 'soft', drive: 0.55, cutoff: 380, res: 1.2, lfoOn: true, lfoDest: 'pitch', lfoDiv: '1/1', lfoDepth: 0.08 }),
    P('Trem Sub', { o1Type: 'triangle', subOn: true, subLvl: 0.3, cutoff: 600, lfoOn: true, lfoDest: 'amp', lfoShape: 'square', lfoDiv: '1/16', lfoDepth: 0.6 }),
    P('One-Shot Clean', { src: 'sample', filterOn: false, atk: 0.002, sus: 1, rel: 0.12, glide: 0.1 }),
    P('One-Shot + Sine', { src: 'layer', o1Lvl: 0.45, smpLvl: 0.8, cutoff: 3000, atk: 0.002, rel: 0.15, glide: 0.1 }),
  ];

  CS.patch = (overrides) => Object.assign({}, CS.SYNTH_DEFAULT, overrides);

  // Random but usable patch: always keeps a solid fundamental.
  CS.randomPatch = function (r, src) {
    const types = ['sine', 'triangle', 'sawtooth', 'square'];
    const p = CS.patch({ src: src || 'synth' });
    p.o1Type = r.pick(['sine', 'sine', 'triangle', 'sawtooth', 'square']);
    p.o1Lvl = 0.5 + r() * 0.4;
    p.o2On = r.chance(0.45); p.o2Type = r.pick(types); p.o2Oct = r.pick([0, 0, 1]); p.o2Det = Math.round(r() * 25); p.o2Lvl = 0.15 + r() * 0.4;
    p.subOn = p.o1Type !== 'sine' && r.chance(0.7); p.subLvl = 0.3 + r() * 0.4;
    p.noiseOn = r.chance(0.15); p.noiseLvl = 0.05 + r() * 0.15;
    p.driveOn = r.chance(0.6); p.driveType = r.pick(['soft', 'soft', 'hard', 'fold']); p.drive = 0.1 + r() * 0.6;
    p.cutoff = Math.round(250 + r() * r() * 2500); p.res = Math.round(r() * r() * 120) / 10;
    p.fEnv = r.chance(0.4) ? Math.round(r() * 70) / 100 : 0; p.fDecay = 0.05 + r() * 0.4;
    p.pitchOn = r.chance(0.35); p.pAmt = 5 + r.int(14); p.pDec = 0.02 + r() * 0.08;
    p.dec = 0.1 + r() * 1.2; p.sus = r.chance(0.6) ? 0.7 + r() * 0.3 : 0.2 + r() * 0.5; p.rel = 0.03 + r() * 0.3;
    p.glide = 0.03 + r() * 0.12;
    p.lfoOn = r.chance(0.3); p.lfoDest = r.pick(['cutoff', 'cutoff', 'amp', 'pitch']); p.lfoShape = r.pick(['sine', 'triangle', 'square']);
    p.lfoDiv = r.pick(['1/4', '1/8', '1/8T', '1/16']); p.lfoDepth = p.lfoDest === 'pitch' ? 0.05 + r() * 0.1 : 0.2 + r() * 0.6;
    return p;
  };

  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // ---------- shared resources per context ----------
  const cache = new WeakMap();
  function res(ac) {
    let c = cache.get(ac);
    if (!c) {
      const noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate), d = noise.getChannelData(0);
      const r = CS.rng(99);
      for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
      c = { noise, curves: {} };
      cache.set(ac, c);
    }
    return c;
  }
  function curve(ac, type, amt) {
    const c = res(ac), key = type + Math.round(amt * 50);
    if (c.curves[key]) return c.curves[key];
    const n = 2048, out = new Float32Array(n);
    const k = 1 + amt * 18;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      if (type === 'hard') out[i] = Math.max(-1, Math.min(1, x * (1 + amt * 9)));
      else if (type === 'fold') out[i] = Math.sin(x * (1 + amt * 5) * Math.PI * 0.5);
      else out[i] = Math.tanh(x * k) / Math.tanh(k);
    }
    c.curves[key] = out;
    return out;
  }

  // Plays one phrase (a note plus any notes sliding out of it).
  //   ph: { t0, t1 (note off), kill (choke time, next note), vel, segs: [{t, midi}] }
  //   o:  { bpm, shot: {buffer, root} | null }
  // Returns the source nodes so playback can be stopped early.
  CS.voice = function (ac, dest, p, ph, o) {
    const t0 = ph.t0, t1 = Math.max(t0 + 0.005, ph.t1);
    const glide = Math.max(0.01, p.glide);
    const relTau = Math.max(0.002, p.rel / 4);
    const kill = Math.max(t1, (ph.kill == null ? Infinity : ph.kill) - 0.004);
    const end = Math.min(t1 + p.rel * 1.6 + 0.03, kill + 0.02);
    const useSynth = p.src !== 'sample' || !o.shot, useShot = p.src !== 'synth' && o.shot;
    const srcs = [];
    const mix = ac.createGain();

    const det = ac.createConstantSource();
    det.offset.value = 0;
    if (p.pitchOn && p.pAmt) {
      det.offset.setValueAtTime(p.pAmt * 100, t0);
      det.offset.setTargetAtTime(0, t0, Math.max(0.003, p.pDec / 3));
    }
    srcs.push(det);

    const track = (param, f) => {
      let prev = ph.segs[0].midi;
      param.setValueAtTime(f(prev), t0);
      for (let i = 1; i < ph.segs.length; i++) {
        const s = ph.segs[i];
        if (s.t >= end) break;
        param.setValueAtTime(f(prev), s.t);
        param.exponentialRampToValueAtTime(f(s.midi), Math.min(s.t + glide, end));
        prev = s.midi;
      }
    };
    const osc = (type, mult, cents, lvl) => {
      const n = ac.createOscillator();
      n.type = type;
      track(n.frequency, (m) => hz(m) * mult);
      n.detune.value = cents;
      det.connect(n.detune);
      const g = ac.createGain(); g.gain.value = lvl;
      n.connect(g); g.connect(mix);
      srcs.push(n);
    };
    if (useSynth) {
      if (p.o1On) osc(p.o1Type, Math.pow(2, p.o1Oct + p.o1Semi / 12), 0, p.o1Lvl);
      if (p.o2On) {
        const m = Math.pow(2, p.o2Oct);
        if (p.o2Det) { osc(p.o2Type, m, p.o2Det, p.o2Lvl * 0.6); osc(p.o2Type, m, -p.o2Det, p.o2Lvl * 0.6); } else osc(p.o2Type, m, 0, p.o2Lvl);
      }
      if (p.subOn) osc('sine', 0.5, 0, p.subLvl);
      if (p.noiseOn && p.noiseLvl) {
        const n = ac.createBufferSource(), g = ac.createGain();
        n.buffer = res(ac).noise; n.loop = true;
        g.gain.setValueAtTime(p.noiseLvl * 0.5, t0);
        g.gain.setTargetAtTime(0, t0, Math.max(0.003, p.noiseDec / 3));
        n.connect(g); g.connect(mix);
        srcs.push(n);
      }
    }
    if (useShot) {
      const n = ac.createBufferSource(), g = ac.createGain();
      n.buffer = o.shot.buffer;
      if (p.smpLoop) { n.loop = true; n.loopStart = Math.min(0.1, n.buffer.duration / 2); n.loopEnd = n.buffer.duration; }
      track(n.playbackRate, (m) => Math.pow(2, (m - o.shot.root + p.smpTune) / 12));
      det.connect(n.detune);
      g.gain.value = p.smpLvl;
      n.connect(g); g.connect(mix);
      srcs.push(n);
    }

    let head = mix;
    if (p.driveOn && p.drive > 0) {
      const sh = ac.createWaveShaper(), post = ac.createGain();
      sh.curve = curve(ac, p.driveType, p.drive);
      sh.oversample = '2x';
      post.gain.value = 1 / (1 + p.drive * 0.8);
      head.connect(sh); sh.connect(post); head = post;
    }
    let filt = null;
    if (p.filterOn) {
      filt = ac.createBiquadFilter();
      filt.type = p.fType;
      filt.Q.value = p.res;
      const base = Math.min(18000, p.cutoff * Math.pow(2, ((ph.segs[0].midi - 36) / 12) * p.fKey));
      if (p.fEnv > 0) {
        filt.frequency.setValueAtTime(Math.min(18000, base * Math.pow(2, p.fEnv * 7)), t0);
        filt.frequency.setTargetAtTime(base, t0, Math.max(0.003, p.fDecay / 3));
      } else filt.frequency.value = base;
      head.connect(filt); head = filt;
    }
    const amp = ac.createGain();
    const vel = ph.vel == null ? 1 : ph.vel;
    const tA = Math.min(t0 + Math.max(0.001, p.atk), t1);
    amp.gain.setValueAtTime(0, t0);
    amp.gain.linearRampToValueAtTime(vel, tA);
    if (tA < t1) amp.gain.setTargetAtTime(vel * p.sus, tA, Math.max(0.003, p.dec / 3));
    if (kill <= t1 + 0.0005) amp.gain.setTargetAtTime(0, t1, 0.003);
    else {
      amp.gain.setTargetAtTime(0, t1, relTau);
      if (kill < end) amp.gain.setTargetAtTime(0, kill, 0.003);
    }
    head.connect(amp);
    let tail = amp;

    if (p.lfoOn && p.lfoDepth > 0) {
      const lfo = ac.createOscillator(), lg = ac.createGain();
      lfo.type = p.lfoShape;
      lfo.frequency.value = (o.bpm || 120) / 60 / (CS.LFO_DIVS[p.lfoDiv] || 0.5);
      lfo.connect(lg);
      if (p.lfoDest === 'cutoff' && filt) { lg.gain.value = p.lfoDepth * 3600; lg.connect(filt.detune); }
      else if (p.lfoDest === 'pitch') { lg.gain.value = p.lfoDepth * 200; lg.connect(det.offset); }
      else if (p.lfoDest === 'amp') {
        const trem = ac.createGain();
        trem.gain.value = 1 - p.lfoDepth / 2;
        lg.gain.value = p.lfoDepth / 2;
        lg.connect(trem.gain);
        amp.connect(trem); tail = trem;
      }
      srcs.push(lfo);
    }
    tail.connect(dest);
    srcs.forEach((s) => { s.start(t0); s.stop(end); });
    return { srcs, end };
  };
})(window.CS);
