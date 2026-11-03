#!/usr/bin/env python3
"""Make a REAL change to the SoundCraft session so the Orbit live bridge shows
an end-to-end update: engine edit → engine bounce receipt → companion re-render.

Every step goes through soundcraft-cli (headless, read-only wrt engine code):

  1. opens the committed session and edits it in place with engine commands:
     the Lead clip drops out of the last bar (edit.trim_clip) and the Lead/Bass
     balance is pushed +3 dB (mix.volume) — audible, visible, and measurable;
  2. bounces the new mix — the engine measures LUFS / peak / true peak and
     prints the verbatim `file.bounce_mix` receipt, which this script stores as
     receipts/first-light-live.json (the plaque's new "latest bounce");
  3. installs the new mix as web/data/first-light-mix.wav so PLAY plays it.

`tools/serve.py` watches the session bundle, the receipts directory and the
mix file; on the next poll (page polls /api/session every 4 s) the companion
re-renders: ring bar 8 dims from 6/6 to 5/6 coverage, the Lead card mini-grid
loses its last cell, both volume ticks move, and the bounce plaque shows the
new LUFS / peaks / "just now" age with the fresh engine receipt.

`--restore` returns the working tree to the committed first-light state.

Watch it live:  python3 tools/serve.py --port 8760   →  http://localhost:8760
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRAFT = os.path.join(REPO, "session", "first-light.scraft")
LIVE_RECEIPT = os.path.join(REPO, "receipts", "first-light-live.json")
LIVE_MIX = os.path.join(REPO, "build", "live-take.wav")
WEB_MIX = os.path.join(REPO, "web", "data", "first-light-mix.wav")
WEB_DATA = os.path.join(REPO, "web", "data", "session.json")

# The take-2 edit: Lead exits after bar 7 (drops out of bar 8), Lead +3 dB, Bass +3 dB.
TRIM_END_BAR = 7          # clip ends at the END of bar 7
VOLUME_DB = {"Lead": -6.0, "Bass": -2.0}

# session.json is NOT guarded: the bridge legitimately rewrites that generated
# artifact on every rebuild. Residue of a previous live run is a changed bundle,
# a changed mix, or a leftover live receipt.
GIT_DIRTY_GUARDS = ["session/first-light.scraft", "web/data/first-light-mix.wav"]


def cli(*args, timeout=120):
    r = subprocess.run(["soundcraft-cli", *args], cwd=REPO,
                       capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        sys.exit(f"soundcraft-cli {' '.join(args[:3])} failed:\n{r.stderr}")
    return r


def cli_version():
    return cli("--version").stdout.strip()


def inspect():
    r = cli("run", "--in", SCRAFT, "--inspect", "--compact")
    idx = r.stdout.find('{"')
    if idx < 0:
        sys.exit("could not parse inspect JSON")
    return json.loads(r.stdout[idx:])


def lead_clip_id(d):
    for t in d.get("tracks", []):
        if t.get("name") == "Lead":
            clips = t.get("clips", [])
            if len(clips) != 1 or "id" not in clips[0]:
                sys.exit(f"expected exactly one id'd Lead clip, got: {clips}")
            return clips[0]["id"], clips[0]
    sys.exit("no Lead track in session")


def guard_clean():
    r = subprocess.run(["git", "-C", REPO, "status", "--porcelain", "--"] + GIT_DIRTY_GUARDS,
                       capture_output=True, text=True)
    if r.stdout.strip():
        sys.exit("refusing to run: guarded files already differ from HEAD:\n" + r.stdout)


def session_json_lufs():
    try:
        with open(WEB_DATA) as f:
            return json.load(f)["bounces"][0]["lufs"]
    except Exception:
        return None


def capture():
    guard_clean()
    d = inspect()
    clip_id, clip = lead_clip_id(d)
    sr = float(d.get("sample_rate", 48000))
    bpm = float((d.get("tempo") or [{"bpm": 120}])[0].get("bpm", 120))
    sec_per_bar = 4 * 60.0 / bpm
    end_samples = int(TRIM_END_BAR * sec_per_bar * sr)
    if clip["end"] <= end_samples:
        sys.exit(f"Lead clip already ends at/before bar {TRIM_END_BAR}; nothing to trim")

    before = {
        "leadClip": [clip["start"], clip["end"]],
        "volumes": {t["name"]: t.get("volume_db") for t in d["tracks"] if t["name"] in VOLUME_DB},
        "plaqueLufs": session_json_lufs(),
    }

    cmds = [
        ("edit.trim_clip", {"clip": clip_id, "end": f"0:{TRIM_END_BAR * sec_per_bar:.3f}"}),
    ] + [("mix.volume", {"track": name, "db": db}) for name, db in VOLUME_DB.items()]
    args = ["run", "--in", SCRAFT]
    for cid, params in cmds:
        args += ["--cmd", f"{cid}={json.dumps(params)}"]
    args += ["--bounce", os.path.relpath(LIVE_MIX, REPO),
             "--save", SCRAFT, "--in-place"]
    os.makedirs(os.path.dirname(LIVE_RECEIPT), exist_ok=True)
    os.makedirs(os.path.dirname(LIVE_MIX), exist_ok=True)
    r = cli(*args)

    receipt = None
    for line in r.stdout.splitlines():
        line = line.strip()
        if line.startswith('{"bytes"'):
            receipt = json.loads(line)
            break
    if receipt is None:
        sys.exit("engine printed no bounce receipt line")

    doc = {
        "session": "first-light",
        "tool": cli_version(),
        "command": "soundcraft-cli run --in first-light.scraft "
                   + " ".join(f"--cmd {c}={json.dumps(p)}" for c, p in cmds)
                   + " --bounce live-take.wav --save first-light.scraft --in-place",
        "capturedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        **receipt,
    }
    os.makedirs(os.path.dirname(LIVE_RECEIPT), exist_ok=True)
    with open(LIVE_RECEIPT, "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")

    shutil.copyfile(LIVE_MIX, WEB_MIX)

    d2 = inspect()
    _, clip2 = lead_clip_id(d2)
    after = {
        "leadClip": [clip2["start"], clip2["end"]],
        "volumes": {t["name"]: t.get("volume_db") for t in d2["tracks"] if t["name"] in VOLUME_DB},
        "plaqueLufs": doc["lufs"],
    }
    print("LIVE CHANGE APPLIED (engine receipt below)")
    print(f"  lead clip end : {before['leadClip'][1]} → {after['leadClip'][1]} samples "
          f"(bar {TRIM_END_BAR + 1} drops out of the Lead)")
    for name in VOLUME_DB:
        print(f"  {name} volume    : {before['volumes'][name]} → {after['volumes'][name]} dB")
    print(f"  bounce plaque : {before['plaqueLufs']} → {doc['lufs']:.2f} LUFS, "
          f"PK {doc['peak_db']:.2f} dBFS, TP {doc['true_peak_db']:.2f} dBTP")
    print(f"  receipt       : {os.path.relpath(LIVE_RECEIPT, REPO)} (capturedAt {doc['capturedAt']})")
    print("The bridge rebuilds on its next poll; give the page ~5 s, then screenshot.")


def restore():
    subprocess.run(["git", "-C", REPO, "restore", "--",
                    "session/first-light.scraft", "web/data/first-light-mix.wav"],
                   check=True)
    for p in (LIVE_RECEIPT, LIVE_MIX):
        if os.path.exists(p):
            os.remove(p)
    shutil.rmtree(os.path.join(REPO, "session", "Backups"), ignore_errors=True)  # engine in-place saves
    # regenerate session.json from the canonical bundle + receipt, then restore
    # the committed file so the working tree is byte-identical to HEAD
    r = subprocess.run([sys.executable, os.path.join(REPO, "tools", "build_data.py")],
                       cwd=REPO, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr)
    subprocess.run(["git", "-C", REPO, "restore", "--", "web/data/session.json"], check=True)
    print("restored committed first-light state (session, mix, receipt, session.json)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--restore", action="store_true",
                    help="return the working tree to the committed first-light state")
    args = ap.parse_args()
    if args.restore:
        restore()
    else:
        capture()
