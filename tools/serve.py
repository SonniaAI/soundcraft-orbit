#!/usr/bin/env python3
"""Live bridge for the Orbit web companion.

Serves web/ as a static site and adds two endpoints:

  GET /api/bridge-info  -> {"bridge": true, "sessionFile": ..., "cli": ...}
  GET /api/session      -> freshly rebuilt session JSON (re-inspects the
                           SoundCraft bundle with soundcraft-cli, read-only;
                           rebuilds only when the .scraft mtime changes)

The page polls /api/session every 4 s in bridge mode, so edits to the session
(show up as a new mtime / new bounce receipt) appear live in the browser.

Usage:  python3 tools/serve.py [--repo DIR] [--port 8760]
"""
import argparse, json, os, subprocess, sys, threading, time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(REPO, "web")
LOCK = threading.Lock()
CACHE = {"mtime": None, "json": None}


def rebuild_if_stale():
    scrafts = sorted(
        os.path.join(REPO, "session", f) for f in os.listdir(os.path.join(REPO, "session"))
        if f.endswith(".scraft")
    )
    if not scrafts:
        return None
    scraft = scrafts[0]
    mtime = os.path.getmtime(scraft)
    with LOCK:
        if CACHE["json"] is not None and CACHE["mtime"] == mtime:
            return CACHE["json"]
        r = subprocess.run(
            [sys.executable, os.path.join(REPO, "tools", "build_data.py")],
            cwd=REPO, capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            sys.stderr.write(r.stderr)
            return CACHE["json"]
        with open(os.path.join(REPO, "web", "data", "session.json")) as f:
            CACHE["json"] = json.load(f)
        CACHE["mtime"] = mtime
        print(f"[bridge] rebuilt session data at {datetime.now(timezone.utc).isoformat()}")
        return CACHE["json"]


def cli_version():
    try:
        return subprocess.run(["soundcraft-cli", "--version"], capture_output=True,
                              text=True, timeout=10).stdout.strip()
    except OSError:
        return "not found"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/bridge-info":
            body = json.dumps({
                "bridge": True,
                "sessionFile": "session/first-light.scraft",
                "cli": cli_version(),
                "note": "read-only re-inspect on .scraft change; page polls /api/session",
            }).encode()
            return self._send(200, body, "application/json")
        if path == "/api/session":
            d = rebuild_if_stale()
            if d is None:
                return self._send(503, b'{"error": "no session bundle"}', "application/json")
            return self._send(200, json.dumps(d).encode(), "application/json")

        rel = path.lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(WEB, rel))
        if not full.startswith(WEB) or not os.path.isfile(full):
            return self._send(404, b"not found", "text/plain")
        ctypes = {
            ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
            ".json": "application/json", ".wav": "audio/wav", ".svg": "image/svg+xml",
            ".png": "image/png", ".md": "text/markdown",
        }
        ctype = ctypes.get(os.path.splitext(full)[1], "application/octet-stream")
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8760)
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"orbit bridge on http://0.0.0.0:{args.port} (web/ = {WEB})")
    srv.serve_forever()
