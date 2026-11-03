#!/usr/bin/env python3
"""Record the Orbit demo video (docs/devpost/DEMO-SCRIPT.md shot list).

Runs a virtual display, opens the live bridge in Chromium, drives the nine
beats over the DevTools protocol (PLAY, the real live change, the inspect
layer, FOV/RULER, the Lens sources, the live URL), captures with ffmpeg
x11grab, and post-splices the real bounced mix as the audio under the PLAY
beat plus burned-in captions.

Output: docs/evidence/orbit-demo.mp4 (~85 s, 1440x900, H.264 + AAC).

Requirements (Debian): xvfb, chromium, ffmpeg, fonts-dejavu-core,
python3-websocket-client. The Orbit bridge must be running:
    python3 tools/serve.py --port 8760
Then:
    python3 tools/record_demo.py [--repo DIR] [--keep]
Afterwards `tools/live_change.py --restore` is run automatically unless
--keep is given (a second manual run of --restore is then needed).
"""
import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(REPO, "build", "demo")
PORT = 8760
URL = f"http://localhost:{PORT}/"
W, H = 1440, 900
FPS = 25

# beat boundaries (seconds) — keep in sync with docs/devpost/DEMO-SCRIPT.md
T_PLAY = 8.0            # PLAY clicked; mix is 16.0 s → ends at 24
T_CHANGE = 26.0         # live_change.py runs (~3 s); page polls every 4 s
T_INSPECT = 44.0        # Lead card click
T_FOV = 54.0            # FOV off/on + RULER
T_LENS = 65.0           # navigate to the Lens sources/runbook
T_LIVE_URL = 76.0       # navigate to the deployed companion
T_END = 85.0

CAPTIONS = [
    (0, T_PLAY, "Orbit — how the track is coming along, at a glance. Designed for Snap Spectacles first."),
    (T_PLAY, 16, "The real bounced mix. The playhead sweeps the ring; cards light the active bar."),
    (16, T_CHANGE, "Bars 1–4: five of six tracks. The lead enters at bar 5 — half-lit means half-finished."),
    (T_CHANGE, 34, "A real change: the engine trims the lead out of bar 8, rebalances, bounces — and measures."),
    (34, T_INSPECT, "The live bridge re-inspects; the stage re-renders itself, with the engine's receipt on the plaque."),
    (T_INSPECT, T_FOV, "One fixation per track: waveform, clips, inserts."),
    (T_FOV, T_LENS, "Everything inside the Spectacles' 51-degree window at 1.5 m — the budget is the design discipline."),
    (T_LENS, T_LIVE_URL, "The same geometry ships as a Spectacles Lens: scripts + manifest, fetching the same live data."),
    (T_LIVE_URL, T_END, "Orbit — your track's progress, at a glance, in AR."),
]


def encode(raw, final, mix):
    """Assemble the final cut: burned-in captions + the real bounced mix as audio.

    Caption text goes through drawtext `textfile` (one file per beat) so no
    filter-escaping can corrupt punctuation.
    """
    capfiles = []
    for i, (_, _, line) in enumerate(CAPTIONS):
        p = os.path.join(BUILD, f"cap{i}.txt")
        with open(p, "w", encoding="utf-8") as f:
            f.write(line)
        capfiles.append(p)
    chain = []
    for i, ((a, b, _), p) in enumerate(zip(CAPTIONS, capfiles)):
        chain.append(
            f"drawtext=fontfile={FONT}:textfile={p}:fontsize=26:fontcolor=white:"
            f"box=1:boxcolor=black@0.55:boxborderw=14:x=(w-text_w)/2:y=h-110:"
            f"enable='between(t,{a},{b})'")
    flt = (
        f"[0:v]{','.join(chain)}[v];"
        f"[1:a]adelay={int(T_PLAY * 1000)}:all=1,apad,atrim=0:{T_END},"
        f"afade=t=out:st={T_END - 1.2}:d=1.2,volume=0.9[a]"
    )
    log_path = os.path.join(BUILD, "encode.log")
    with open(log_path, "w") as logf:
        r = subprocess.run([
            "ffmpeg", "-y", "-i", raw, "-i", mix,
            "-filter_complex", flt,
            "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium",
            "-crf", "26", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
            "-movflags", "+faststart", "-shortest", final],
            stdout=logf, stderr=logf)
    if r.returncode != 0:
        sys.exit(f"ffmpeg encode failed — see {log_path} (tail below)\n"
                 + "\n".join(open(log_path).read().splitlines()[-15:]))

LENS_DOC = os.path.join(REPO, "lens", "SETUP-LENS-STUDIO.md")
LIVE_URL = "https://sonniaai.github.io/soundcraft-orbit/web/"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


class CDP:
    def __init__(self, port=9222):
        import urllib.request
        for _ in range(50):
            try:
                targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2))
                page = next(t for t in targets if t.get("type") == "page")
                break
            except Exception:
                time.sleep(0.4)
        else:
            sys.exit("chromium DevTools endpoint never came up")
        import websocket
        self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=10,
                                              suppress_origin=True)
        self.n = 0

    def cmd(self, method, **params):
        self.n += 1
        mid = self.n
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        deadline = time.time() + 15
        while time.time() < deadline:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})
        raise TimeoutError(method)

    def eval(self, expr):
        r = self.cmd("Runtime.evaluate", expression=expr, returnByValue=True)
        return r.get("result", {}).get("value")

    def click(self, x, y):
        for type_ in ("mousePressed", "mouseReleased"):
            self.cmd("Input.dispatchMouseEvent", type=type_, x=float(x), y=float(y),
                     button="left", clickCount=1)

    def click_dom(self, selector):
        r = self.eval(f"""(() => {{ const b = document.getElementById('{selector}')
            .getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; }})()""")
        if not r:
            raise RuntimeError(f"no rect for #{selector}")
        self.click(*r)

    def navigate(self, url):
        self.cmd("Page.navigate", url=url)
        time.sleep(2.5)


def wait_bridge():
    import urllib.request
    for _ in range(40):
        try:
            j = json.load(urllib.request.urlopen(f"{URL}api/bridge-info", timeout=2))
            if j.get("bridge"):
                return j
        except Exception:
            time.sleep(0.5)
    sys.exit(f"bridge not reachable on {URL} — start tools/serve.py first")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true", help="keep the live-change state (skip auto-restore)")
    ap.add_argument("--encode-only", action="store_true",
                    help="re-assemble docs/evidence/orbit-demo.mp4 from build/demo/video-raw.mp4")
    args = ap.parse_args()
    if not os.path.exists(FONT):
        sys.exit(f"caption font missing: {FONT} (apt install fonts-dejavu-core)")
    final = os.path.join(REPO, "docs", "evidence", "orbit-demo.mp4")
    raw = os.path.join(BUILD, "video-raw.mp4")
    mix = os.path.join(REPO, "web", "data", "first-light-mix.wav")
    if args.encode_only:
        os.makedirs(BUILD, exist_ok=True)
        encode(raw, final, mix)
        print(f"wrote {final} ({os.path.getsize(final) / 1e6:.1f} MB)")
        return
    info = wait_bridge()
    print("bridge:", info["cli"], "| receipt:", info["receipt"])

    shutil.rmtree(BUILD, ignore_errors=True)
    os.makedirs(BUILD, exist_ok=True)

    xvfb = subprocess.Popen(["Xvfb", ":99", "-screen", "0", f"{W}x{H}x24"], cwd=BUILD)
    time.sleep(1.5)
    chrom = subprocess.Popen([
        "chromium", "--no-sandbox", "--disable-gpu", "--no-first-run",
        "--disable-extensions", "--disable-sync", "--disable-session-crashed-bubble",
        "--autoplay-policy=no-user-gesture-required",
        f"--user-data-dir={os.path.join(BUILD, 'chrome-profile')}",
        f"--window-size={W},{H}", "--window-position=0,0", "--kiosk",
        "--remote-debugging-port=9222", URL], cwd=BUILD,
        env={**os.environ, "DISPLAY": ":99"})
    time.sleep(4)
    cdp = CDP()
    cdp.cmd("Page.enable")
    time.sleep(2)                                   # static load + bridge probe

    ff = subprocess.Popen([
        "ffmpeg", "-y", "-f", "x11grab", "-video_size", f"{W}x{H}", "-framerate", str(FPS),
        "-i", ":99.0", "-c:v", "libx264", "-preset", "medium", "-crf", "23",
        "-pix_fmt", "yuv420p", os.path.join(BUILD, "video-raw.mp4")],
        cwd=BUILD, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    t0 = time.time()

    def until(t):
        wait = t - (time.time() - t0)
        if wait > 0:
            time.sleep(wait)

    def log(msg):
        print(f"[{time.time() - t0:6.1f}s] {msg}")

    # beat 2: PLAY at T_PLAY
    until(T_PLAY)
    cdp.click_dom("btnPlay")
    time.sleep(2)
    t = cdp.eval("audio ? audio.currentTime : -1")
    log(f"PLAY clicked; audio.currentTime after 2 s = {t}")

    # beat 4/5: the real change
    until(T_CHANGE)
    r = subprocess.run([sys.executable, os.path.join(REPO, "tools", "live_change.py")],
                       capture_output=True, text=True, cwd=REPO)
    if r.returncode != 0:
        print(r.stdout, r.stderr, file=sys.stderr)
        sys.exit("live_change failed mid-recording")
    log("live change applied (engine edit + bounce receipt)")

    # beat 6: inspect layer — click the Lead card (canvas), fall back to a small scan
    until(T_INSPECT)

    def inspect_open():
        return cdp.eval("!document.getElementById('inspect').classList.contains('hidden')")

    th, d, S, CX, CY = 17.5, 1650, min(W / 1300, H / 760), W * 0.46, H * 0.54
    k = (1500 / d) * S
    cx = CX + d * math.sin(th * math.pi / 180) * k
    cy = CY + 60 * k
    opened = False
    for dx, dy in ((0, 0), (-20, -30), (20, 30), (-35, 0), (35, 0), (0, -40), (0, 40)):
        if inspect_open():
            opened = True
            break
        cdp.click(cx + dx, cy + dy)
        time.sleep(0.8)
    opened = opened or inspect_open()
    log(f"inspect layer {'open' if opened else 'DID NOT OPEN'}")

    # beat 7: FOV off/on + RULER
    until(T_FOV)
    cdp.click_dom("btnFov"); time.sleep(2.5)         # overlay off — full stage
    cdp.click_dom("btnFov"); time.sleep(1.5)         # overlay on again
    cdp.click_dom("btnRuler")
    log("FOV toggle + ruler shown")

    # beat 8: Lens sources
    until(T_LENS)
    cdp.navigate("file://" + LENS_DOC)
    for _ in range(4):
        cdp.eval("window.scrollBy(0, 420)")
        time.sleep(1.6)
    log("Lens runbook on screen")

    # beat 9: the deployed companion
    until(T_LIVE_URL)
    cdp.navigate(LIVE_URL)
    log("live URL on screen")

    until(T_END)
    ff.terminate()
    ff.wait(timeout=20)
    encode(raw, final, mix)
    log(f"wrote {final} ({os.path.getsize(final) / 1e6:.1f} MB)")

    chrom.terminate()
    xvfb.terminate()
    if not args.keep:
        subprocess.run([sys.executable, os.path.join(REPO, "tools", "live_change.py"),
                        "--restore"], cwd=REPO, capture_output=True, text=True)
        print("live state restored")
    print("done")


if __name__ == "__main__":
    main()
