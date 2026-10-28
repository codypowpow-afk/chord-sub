# Chord Sub

Load melody clips and loops. Chord Sub works out their key, tempo, chord progression and melody, then writes sub-bass lines that fit. You can reroll the line, lock bars you like and shape it until it works. The sub sound is a modular synth with presets, and it can also play your own bass one-shots (808s, subs, bass hits) at any pitch.

Runs in the browser (`index.html`) or as a single Windows exe (`dist/ChordSub.exe`, from the GitHub releases).

## Workflow

1. **Melody clips**: drop one or more WAV / MP3 / FLAC / OGG / M4A clips (or press **DEMO LOOP**). Each clip is analysed for:
   - **tempo and length**: a loop is taken to be a whole number of bars, so the bar count whose tempo agrees with the detected beat wins. Fix it with BPM / BARS, ½× / 2×, or move **CLIP START** if bar 1 isn't at the start of the file.
   - **key**, from a polyphonic chroma analysis plus the melody notes. When the result could be either the major key or its relative minor, the chords decide.
   - **melody**: solo lines use YIN pitch tracking. Clips with chords use a harmonic-salience "top voice" estimate. The melody is shown in the pink lane above the roll.
   - **chords**: one per ½ bar, 1 bar or 2 bars, matched against triads, 7ths, sus and power chords.
   Every clip keeps its own grid, chords, sub line, history and kept slots.
2. **Chord progression**: click any chord to change it (choices: detected alternatives, chords in the key, or any chord). Only the bars under that chord are re-pitched. **SNAP TO KEY** replaces out-of-key chords.
3. **Sub line**: generated from these controls:
   - **STYLE**: Long subs, Pulse 8ths, Offbeat house, Syncopated, 808 trap, Rolling DnB, 2-step garage, Dembow, Walking 4s, Gallop, Follow melody (hits on the melody's notes), Fill the gaps (hits where the melody rests), Random.
   - **NOTES**: Roots · Root + 5th · Chord tones · In key · Melodic (in key, plus chromatic approach notes into the next chord).
   - **DENSITY**, **ROOT ON CHANGE** (chance that a chord's first note is its root), **MOVEMENT** (steps or leaps), **MELODY FIT** (avoids notes that clash with the melody above), **COUNTER** (contrary motion against the melody), **SLIDES**, **OCTAVE JUMPS**, **RANGE**, and **NEW NOTE** on each chord change.
   - **⟳ REROLL ALL** (R) · **♪ NOTES** (N: same rhythm, new pitches) · **▮▮ RHYTHM** (T: new rhythm, same note contour) · **✱ MUTATE** (M: changes about a third of the notes). Rhythm and pitch use separate seeds, and moving a slider re-runs the generator on the current seeds.
   - Each bar under the roll has its own 🔒 lock and ⟳ reroll. **★ KEEP** (K) saves the current line to a slot you can recall. Undo / redo: Ctrl+Z / Ctrl+Y.
   - Note colours: root · chord tone · in key · out of key · **red = clashes with the melody**.
   - Editing: click to add · drag to move or change pitch · drag the right edge to change length · right-click to delete · double-click to toggle a slide · Alt-click to reroll one note · ↑/↓ to transpose the selected note (Shift = octave) · click a key in the left gutter to hear it.
4. **Sub sound**:
   - **SOURCE**: SYNTH, ONE-SHOT, or LAYER (both).
   - Modules, each with its own power switch: OSC 1, OSC 2 (detuned pair), SUB OSC, NOISE, ONE-SHOT, DRIVE (soft / hard clip / fold), FILTER (with envelope and key tracking), AMP ENV, PITCH DROP (808 punch), GLIDE, tempo-synced LFO (cutoff / pitch / volume), OUTPUT. Notes are monophonic and each new note cuts the previous one off, like an 808.
   - 18 factory presets, **SAVE PRESET** for your own, **🎲 RANDOM PATCH**.
   - **Bass one-shots**: load or drop them. Each one's root note is detected automatically (you can override it) and it is pitched to every note of the line. **ONE-SHOTS PER** LINE / BAR / NOTE lets rerolls pick from the one-shots marked **POOL**. **BOUNCE PATCH** renders the current synth patch into a new one-shot. The library is saved between sessions.

**Export**: WAV SUB, WAV MIX (melody + sub), or MIDI (sub, chords and detected melody), for 1–8 loops.

## Files

- `js/dsp.js`: YIN pitch tracking, FFT chroma, salience melody, tempo / loop length, key, one-shot root detection, WAV / MIDI encoders, demo loop
- `js/theory.js`: scales, chord types, roman numerals, chord detection
- `js/synth.js`: modular voice and presets
- `js/gen.js`: rhythm templates and the sub-line generator
- `js/engine.js`: analysis pipeline, transport, offline render, one-shot store (IndexedDB)
- `js/ui.js`: interface

## Build the exe

```
powershell -ExecutionPolicy Bypass -File desktop\build.ps1
```

This uses only the .NET Framework `csc.exe` that ships with Windows. The WebView2 SDK is downloaded into `desktop\packages` on the first build.
