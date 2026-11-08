# preview-recording

Small macOS CLI (`preview-recorder`, single-file Swift, no dependencies) that
records the **real Lens Studio Preview window** — the actual frames Lens Studio
renders, composited by the macOS WindowServer — straight to an `.mp4` file.
It does **not** produce simulated or fake frames, and it does **not** touch any
Lens Studio project files, scenes, scripts, backends, or credentials.

Built for the SoundCraft Orbit public demo tooling: a lightweight laptop
workflow for capturing an honest public Preview video after the real backend
is verified.

## What it does

- `--check` — preflight only. Verifies the macOS Screen Recording permission
  and lists **Lens Studio windows only** (window IDs + titles). It never lists
  windows from other applications, never records, and never triggers a system
  prompt.
- `--record` — captures exactly one Lens Studio window (desktop-independent
  window filter on an exact `CGWindowID`) to H.264 + `.mp4` via Apple
  ScreenCaptureKit hardware recording (`SCStream` + `SCRecordingOutput`,
  macOS 15+).

Hard guarantees:

- **No microphone, ever.** `SCStreamConfiguration.captureMicrophone` is pinned
  to `false`; the mic is never opened and no mic permission is requested.
- **No other app windows** in the frame (single-window capture filter).
- **No network access. No credentials.**
- **Never overwrites** an existing output file, and requires the output parent
  directory to already exist (fully explicit output path).
- **Bounded**: recording length is hard-capped at 170 seconds.
- **No stretching**: source aspect ratio is always preserved. Output is fitted
  inside a 1280x720 box (landscape sources) or 1280x1280 box (square/portrait
  sources), scaled to fit — `scalesToFit` + `preservesAspectRatio`.
- **No automatic settings changes.** If Screen Recording permission is missing,
  the tool prints the exact approval steps for the user and exits with code 2.
  It never calls `CGRequestScreenCaptureAccess` (no prompt spam), never opens
  System Settings, never flips any switch.

## What it does NOT do

- **No uploading of any kind.** It only writes a local `.mp4`. There is no
  YouTube / social-platform integration and no upload authorization is
  available — any publishing is a separate, manual human step.
- **No faked content.** What lands in the file is what Lens Studio actually
  rendered on screen during the capture window.
- **No per-app audio.** See the audio section below.

## Audio: honestly documented limits (verified against SDK headers)

Research result (verified by reading every header in the locally installed
SDK — `MacOSX26.5.sdk`, framework `ScreenCaptureKit.framework/Headers/`):
ScreenCaptureKit has **no per-application audio filtering API**.
`SCContentFilter` (applications / windows / desktop-independent window)
filters **video frames only**. The only audio knobs that exist are:

- `SCStreamConfiguration.capturesAudio` — captures the **macOS system output
  mix** (every app's sound on the default output device),
- `.excludesCurrentProcessAudio` — excludes the capturing process itself,
- `.captureMicrophone` — microphone input (this tool never enables it).

Therefore:

| Mode | Command | Audio in file |
|---|---|---|
| default | `--record --output x.mp4` | **VIDEO ONLY** — no audio track at all (fully isolated, safe) |
| opt-in | `--record --audio system --output x.mp4` | the **whole system output mix** (Lens Studio preview sound *plus any other app making noise*) |

`--audio system` is not app-isolated audio. If you use it, close/quiet other
audio-producing apps first. The tool **measures the finished file** with
AVFoundation after every recording and reports the codec, dimensions, frame
rate, and whether an audio track is actually present — no live audio is
claimed unless the measured track exists (exit code 4 if requested audio is
missing). Video-only output is the safe default and is never replaced by a
fake audio dub.

## Requirements

- macOS 15 Sequoia or newer (`SCRecordingOutput`). Developed and verified on
  macOS 26 with Apple Command Line Tools (SDK 26.5); no full Xcode needed.
- Lens Studio running with its Preview window visible.
- macOS **Screen Recording** permission for the terminal app that launches
  this tool (one-time, user-granted):
  System Settings -> Privacy & Security -> Screen & System Audio Recording ->
  enable the responsible app (Terminal/iTerm2/IDE), then fully quit and
  relaunch that app. The tool tells you exactly this if permission is missing.

## Build

```sh
tools/preview-recording/build.sh
```

Produces `tools/preview-recording/build/preview-recorder` (git-ignored;
nothing machine-local is committed).

## Usage

```sh
# List Lens Studio windows (IDs + titles only; other apps' windows hidden)
build/preview-recorder --check

# Video only (default, fully isolated — no audio track, no mic)
build/preview-recorder --record --output demo-preview.mp4 --duration 150

# Pick an exact window by ID or title substring
build/preview-recorder --record --output demo-preview.mp4 \
  --window-id 1234 --duration 150

# Video + system output mix (NOT app-isolated; keep other apps quiet)
build/preview-recorder --record --output demo-preview.mp4 \
  --duration 150 --audio system
```

Options: `--output FILE.mp4` (required, must not exist) · `--duration 1..170`
(default 60) · `--window-id N` / `--window-title TEXT` (optional
disambiguation) · `--fps 1..60` (default 30) · `--box landscape|square|auto`
(default auto) · `--audio none|system` (default `none`).

Exit codes: `0` success · `1` capture/verification error · `2` Screen
Recording permission missing (nothing recorded, no prompt shown) · `3`
usage/window-selection error · `4` recorded, but the requested audio track is
not present in the measured file.

## Verified on this machine (macOS 26.6, one-time probes — NO recording was made)

- `--check` runs clean: preflight granted, lists **only** Lens Studio windows
  (e.g. the main `… - Lens Studio v5.23` project window and its panels) and
  hides all other applications' windows (count only).
- Window enumeration deliberately uses `onScreenWindowsOnly: false`: measured
  on macOS 26.6, the on-screen-only variant hid backgrounded Lens Studio
  entirely (3 apps / 7 windows visible vs 29 apps / 119 windows with the full
  set), which would have made `--check` report false negatives whenever LS is
  not the frontmost app. The tool therefore reports each window's
  `onScreen` state and refuses/warns instead of guessing.
- `SCShareableContent.displays` can come back empty in bare-CLI contexts on
  this system; the tool never depends on displays (single-window capture
  only), and derives source pixel size from the filter's `contentRect` and
  `pointPixelScale`.
- Recording an off-screen (hidden/minimized) Lens Studio window is refused
  auto-selection and prints an explicit blank-frame warning if forced by ID —
  for a real preview video, keep the Lens Studio Preview window visible.

## API confidence

All signatures were verified against the locally installed SDK headers before
writing code — `SCStream.h`, `SCShareableContent.h`, `SCRecordingOutput.h`,
`SCError.h`, `SCContentSharingPicker.h`, `SCScreenshotManager.h` in
`MacOSX26.5.sdk/System/Library/Frameworks/ScreenCaptureKit.framework/Headers/`,
plus `CGPreflightScreenCaptureAccess` in `CoreGraphics/CGWindow.h`. The binary
compiles cleanly; the file-level post-record measurement (codec / size /
track presence) is reported by the tool itself on every run.

Known runtime notes from the headers: recording output finalization happens
when the stream stops (`stopCapture`), signaled via the
`recordingOutputDidFinishRecording` delegate — the tool waits for it (20 s
budget) before exiting, so the `.mp4` is complete. HDR recording is
unsupported by `SCRecordingOutput` per the SDK header, so capture stays SDR.
