#!/usr/bin/env python3
"""Synthesize the 8-bar 120 BPM test-track stems for the SON-6172 demo session.

8 bars, 4/4, 120 BPM -> bar = 2.0 s, total 16.0 s, 48 kHz mono 16-bit WAV.
Am - F - C - G progression, twice. Deterministic (fixed seed).
"""
import math, os, struct, wave

SR = 48000
BPM = 120.0
BAR = 4 * 60.0 / BPM          # 2.0 s
TOTAL = 8 * BAR               # 16.0 s
N = int(SR * TOTAL)
OUT = os.path.join(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build", "stems"))
os.makedirs(OUT, exist_ok=True)

def buf():
    return [0.0] * N

def add(b, t0, samples, gain=1.0):
    i0 = int(t0 * SR)
    for i, s in enumerate(samples):
        j = i0 + i
        if 0 <= j < N:
            b[j] += s * gain

def env_exp(n, decay):
    return [math.exp(-i / (decay * SR)) for i in range(n)]

def kick():
    dur = 0.35; n = int(dur * SR); out = []
    for i in range(n):
        t = i / SR
        f = 115.0 * math.exp(-t * 22.0) + 42.0
        ph = 2 * math.pi * f * t
        out.append(0.9 * math.sin(ph) * math.exp(-t * 9.0))
    return out

def snare():
    dur = 0.22; n = int(dur * SR); out = []
    import random
    rnd = random.Random(7)
    for i in range(n):
        t = i / SR
        tone = 0.5 * math.sin(2 * math.pi * 185.0 * t) + 0.3 * math.sin(2 * math.pi * 330.0 * t)
        noise = 0.7 * (rnd.random() * 2 - 1)
        e = math.exp(-t * 24.0)
        out.append(0.8 * (tone * 0.4 + noise * 0.6) * e)
    return out

def hat(open=False):
    dur = 0.12 if open else 0.05; n = int(dur * SR); out = []
    import random
    rnd = random.Random(11 if open else 5)
    prev = 0.0
    for i in range(n):
        t = i / SR
        x = rnd.random() * 2 - 1
        hp = x - prev          # crude high-pass
        prev = x
        out.append(0.35 * hp * math.exp(-t * (30.0 if open else 70.0)))
    return out

NOTE = {"A1":55.0,"C2":65.41,"F1":43.65,"G1":49.0,"A2":110.0,"F2":87.31,"C3":130.81,"G2":98.0,
        "A3":220.0,"C4":261.63,"E4":329.63,"F3":174.61,"F4":349.23,"G3":196.0,"B3":246.94,
        "C5":523.25,"E5":659.26,"G4":392.0,"A4":440.0,"D5":587.33,"E3":164.81}

def tone(freq, dur, shape="sine", attack=0.01, release=0.1, gain=0.5):
    n = int(dur * SR); out = []
    for i in range(n):
        t = i / SR
        e = 1.0
        if t < attack: e = t / attack
        rem = dur - t
        if rem < release: e = min(e, rem / release)
        if shape == "sine":
            s = math.sin(2 * math.pi * freq * t)
        elif shape == "saw":
            s = 2 * ((freq * t) % 1.0) - 1.0
        elif shape == "tri":
            s = 2 * abs(2 * ((freq * t) % 1.0) - 1.0) - 1.0
        else:
            s = math.sin(2 * math.pi * freq * t)
        out.append(gain * s * e)
    return out

kick_b, snare_b, hats_b, bass_b, keys_b, lead_b = buf(), buf(), buf(), buf(), buf(), buf()

k = kick()
for bar in range(8):
    for beat in range(4):
        add(kick_b, bar * BAR + beat * 0.5, k)

s = snare()
for bar in range(8):
    add(snare_b, bar * BAR + 0.5, s)
    add(snare_b, bar * BAR + 1.5, s)

h8, h16o = hat(False), hat(True)
for i in range(64):                      # straight 8ths, open hat on off-beat 4 of bars 4/8
    t = i * 0.25
    add(hats_b, t, h16o if (i % 8 == 7 and i in (31, 63)) else h8)

prog = ["A1","F1","C2","G1"] * 2         # bass roots, 8 bars
bnote = tone(55, 0.4, "saw", 0.005, 0.15, 0.6)
for bar in range(8):
    root = NOTE[prog[bar]]
    for e8 in range(4):                  # driving 8ths
        b = tone(root * (2 if e8 == 3 else 1), 0.22, "saw", 0.004, 0.12, 0.55)
        add(bass_b, bar * BAR + e8 * 0.5, b)

chords = [("A3","C4","E4"),("F3","A3","C4"),("C4","E4","G4"),("G3","B3","D5")] * 2
for bar in range(8):
    for nn in chords[bar]:
        add(keys_b, bar * BAR, tone(NOTE[nn], BAR * 0.95, "tri", 0.05, 0.5, 0.16))

mel = [("E5",0.0,0.5),("C5",0.5,0.5),("A4",1.0,1.0),("G4",2.0,0.5),("A4",2.5,0.5),("C5",3.0,1.0),
       ("F4",0.0,0.5),("A4",0.5,0.5),("C5",1.0,1.0),("A4",2.0,0.5),("G4",2.5,0.5),("F4",3.0,1.0)]
for bar in range(8):
    phrase = mel if bar % 2 == 0 else mel[6:]
    for nn, off, dur in phrase:
        add(lead_b, bar * BAR + off, tone(NOTE[nn], dur * 0.92, "sine", 0.02, 0.25, 0.22))

# lead2: ONLY the second-half phrase (bars 5-8 content), an 8 s file placed at 0:08 in the session
N2 = int(SR * 4 * BAR)
lead2_b = [0.0] * N2
def add2(t0, samples, gain=1.0):
    i0 = int(t0 * SR)
    for i, s in enumerate(samples):
        j = i0 + i
        if 0 <= j < N2:
            lead2_b[j] += s * gain
for nn, off, dur in mel[6:]:
    add2(off, tone(NOTE[nn], dur * 0.92, "sine", 0.02, 0.25, 0.22))

def clamp(x): return max(-0.98, min(0.98, x))

def write_wav(name, b, gain=1.0):
    path = os.path.join(OUT, name)
    with wave.open(path, "w") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        frames = b"".join(struct.pack("<h", int(clamp(x * gain) * 32767)) for x in b)
        w.writeframes(frames)
    return path

peak = lambda b: max(abs(x) for x in b)
for name, b, g in [("kick.wav",kick_b,1.0),("snare.wav",snare_b,1.0),("hats.wav",hats_b,1.0),
                   ("bass.wav",bass_b,0.9),("keys.wav",keys_b,1.0),("lead.wav",lead_b,1.0)]:
    p = write_wav(name, b, g)
    print(f"{name}: peak={peak(b):.3f}")

# write lead2 with its own 8 s buffer (write_wav assumes N; do it inline)
lead2_path = os.path.join(OUT, "lead2.wav")
with wave.open(lead2_path, "w") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    frames2 = b"".join(struct.pack("<h", int(clamp(x) * 32767)) for x in lead2_b)
    w.writeframes(frames2)
print(f"lead2.wav: peak={peak(lead2_b):.3f}")
print("stems dir:", OUT)
