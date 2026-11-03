#!/usr/bin/env python3
"""Build web/data/session.json from the SoundCraft session bundle + bounce receipt.

Read-only integration: the bundle (session/*.scraft + session/Audio Files/) is
inspected with `soundcraft-cli run --in <s.scraft> --inspect` when the CLI is
available, else falls back to the committed snapshot JSON. Stems are read to
compute waveform peak buckets. Nothing is written back to the session.

Usage:
  python3 tools/build_data.py [--session-dir session] [--receipt receipts/first-light-bounce.json]
                              [--mix web/data/first-light-mix.wav] [--out web/data/session.json]
"""
import argparse, glob, json, os, struct, subprocess, sys
from datetime import datetime, timezone

SR = 48000
BEATS_PER_BAR = 4
BUCKETS = 240
PALETTE = {
    "Kick": "#FFB03B", "Snare": "#FF6F61", "Hats": "#4ECDC4",
    "Bass": "#A78BFA", "Keys": "#7BD88F", "Lead": "#5EA9FF",
}
FALLBACK = ["#F4A259", "#E76F51", "#2A9D8F", "#9B5DE5", "#80ED99", "#4CC9F0"]

def parse_wav(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError(f"not a WAV: {path}")
    pos, fmt, raw = 12, None, None
    while pos + 8 <= len(data):
        cid = data[pos:pos+4]
        size = struct.unpack("<I", data[pos+4:pos+8])[0]
        body = data[pos+8:pos+8+size]
        if cid == b"fmt ":
            fmt = struct.unpack("<HHIIHH", body[:16])
            if fmt[0] == 0xFFFE and len(body) >= 26:  # extensible: subformat guid at offset 24
                fmt = (struct.unpack("<H", body[24:26])[0],) + fmt[1:]
        elif cid == b"data":
            raw = body
        pos += 8 + size + (size & 1)
    return fmt, raw

def peaks_of(path, buckets=BUCKETS):
    fmt, raw = parse_wav(path)
    tag, ch, sr, _, align, bits = fmt
    if bits == 24:
        frames = len(raw) // align
        vals = []
        for i in range(frames):
            o = i * align
            for c in range(min(ch, 2)):
                vals.append(int.from_bytes(raw[o+c*3:o+c*3+3], "little", signed=True) / 8388607.0)
    elif bits == 16:
        vals = [v / 32768.0 for v in struct.unpack(f"<{len(raw)//2}h", raw)]
    elif bits == 32 and tag == 3:  # IEEE float
        vals = [v for v in struct.unpack(f"<{len(raw)//4}f", raw)]
    elif bits == 32:  # int32
        vals = [v / 2147483648.0 for v in struct.unpack(f"<{len(raw)//4}i", raw)]
    else:
        raise ValueError(f"unsupported format tag {tag} depth {bits} in {path}")
    per = max(1, len(vals) // buckets)
    out = []
    for b in range(buckets):
        seg = vals[b*per:(b+1)*per]
        out.append(round(max(abs(min(seg)), abs(max(seg))), 3) if seg else 0.0)
    return out

def inspect_session(scraft):
    """Live read via the CLI (no writes); falls back to None if CLI missing."""
    exe = "soundcraft-cli"
    try:
        r = subprocess.run([exe, "run", "--in", scraft, "--inspect"],
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            return None
        idx = r.stdout.rfind("\n{\n")
        if idx < 0:
            idx = r.stdout.find("{\n")
        return json.loads(r.stdout[idx:])
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session-dir", default="session")
    ap.add_argument("--receipt", default="receipts/first-light-bounce.json")
    ap.add_argument("--out", default="web/data/session.json")
    ap.add_argument("--snapshot", default="", help="fallback inspect JSON if CLI absent")
    args = ap.parse_args()

    scrafts = sorted(glob.glob(os.path.join(args.session_dir, "*.scraft")))
    if not scrafts:
        sys.exit(f"no .scraft in {args.session_dir}")
    scraft = scrafts[0]

    insp = inspect_session(scraft)
    source = "soundcraft-cli live inspect"
    if insp is None and args.snapshot:
        insp = json.load(open(args.snapshot))
        source = "committed snapshot"
    if insp is None:
        sys.exit("could not inspect session (no CLI and no snapshot)")

    audio_dir = os.path.join(args.session_dir, "Audio Files")
    tempo = (insp.get("tempo") or [{}])[0]
    bpm = float(tempo.get("bpm", 120.0))
    length_samples = int(insp.get("length_samples", 0))
    seconds = length_samples / float(insp.get("sample_rate", SR))
    sec_per_bar = BEATS_PER_BAR * 60.0 / bpm
    bars = max(1, round(seconds / sec_per_bar))

    fallback_i = 0
    tracks = []
    for t in insp.get("tracks", []):
        if t.get("kind") == "master":
            continue
        name = t.get("name", "?")
        color = PALETTE.get(name)
        if not color:
            color = FALLBACK[fallback_i % len(FALLBACK)]
            fallback_i += 1
        clips = []
        for c in t.get("clips", []):
            start_s, end_s = c["start"] / SR, c["end"] / SR
            clips.append({
                "name": c.get("name", ""),
                "startSample": c["start"], "endSample": c["end"],
                "startSec": round(start_s, 3), "endSec": round(end_s, 3),
                "startBar": max(1, int(start_s / sec_per_bar) + 1),
                "endBar": min(bars, max(1, int(-(-end_s // sec_per_bar)))),
                "gainDb": c.get("gain_db", 0.0),
                "muted": bool(c.get("muted", False)),
            })
        # peak waveform: match the track's first clip source file by stem name
        stem = None
        if clips:
            cand = (clips[0]["name"] or name).lower()
            for f in sorted(glob.glob(os.path.join(audio_dir, "*.wav"))):
                if os.path.basename(f).lower().startswith(cand.split()[0][:5]):
                    stem = f
                    break
        tracks.append({
            "id": t["id"], "name": name, "kind": t.get("kind", "audio"),
            "color": color,
            "volumeDb": t.get("volume_db", 0.0),
            "inserts": [i.get("plugin") for i in t.get("inserts", []) if i.get("plugin")],
            "processed": bool(t.get("inserts")),
            "clips": clips,
            "peak": peaks_of(stem) if stem else [0.0] * BUCKETS,
        })

    bounces = []
    if os.path.exists(args.receipt):
        r = json.load(open(args.receipt))
        bounces.append({
        "session": r.get("session"),
        "tool": r.get("tool"),
        "command": r.get("command"),
        "capturedAt": r.get("capturedAt"),
        "path": r.get("path"),
        "bytes": r.get("bytes"),
        "lufs": r.get("lufs"),
        "peakDb": r.get("peak_db"),
        "truePeakDb": r.get("true_peak_db"),
        "seconds": r.get("seconds"),
    })

    data = {
        "schema": "soundcraft-orbit/session@1",
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "inspectSource": source,
        "session": {
            "name": insp.get("name", os.path.basename(scraft)),
            "sessionFile": os.path.relpath(scraft),
            "bpm": bpm, "beatsPerBar": BEATS_PER_BAR, "bars": bars,
            "sampleRate": insp.get("sample_rate", SR),
            "lengthSamples": length_samples,
            "seconds": round(seconds, 3),
            "dirty": bool(insp.get("dirty", False)),
        },
        "tracks": tracks,
        "bounces": bounces,
        "mixAudio": "data/first-light-mix.wav",
        "provenance": {
            "pipeline": "soundcraft-cli headless (read-only inspect + file.bounce_mix receipt)",
            "receiptTool": bounces[0].get("tool") if bounces else None,
            "constraint": "SoundCraft repos PARKED (founder order 2026-10-26); this repo integrates read-only",
        },
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(data, f, indent=2)
    print(f"wrote {args.out}: {len(tracks)} tracks, {bars} bars @ {bpm} BPM, "
          f"{len(bounces)} bounce receipt(s), inspect via {source}")

if __name__ == "__main__":
    main()
