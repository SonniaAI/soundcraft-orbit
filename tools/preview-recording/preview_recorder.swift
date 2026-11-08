// preview_recorder.swift — SoundCraft Orbit public preview-recording tooling.
//
// Records the REAL Lens Studio Preview window (actual frames composited by the
// macOS WindowServer — not simulated) to an H.264 + AAC .mp4 via Apple
// ScreenCaptureKit hardware capture (SCStream + SCRecordingOutput, macOS 15+).
//
// Scope / guarantees:
//   * Video: exactly one window — a desktop-independent SCWindow filter on an
//     exact Lens Studio window (matched by CGWindowID / title / auto-pick).
//   * Audio: microphone is NEVER captured (captureMicrophone is pinned to
//     false). Optional `--audio system` records the macOS *system output mix*
//     (every app's sound). There is NO public per-app audio API in
//     ScreenCaptureKit (verified against SDK 26.5 headers — see README), so the
//     default is VIDEO ONLY.
//   * No network access, no credentials, never overwrites an existing file,
//     recording length is hard-capped at 170 s.
//   * Never triggers the macOS permission prompt: if screen-capture
//     permission is missing, it prints what the user must approve and exits.
//
// API signatures were verified against the locally installed SDK headers:
//   /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
//     (MacOSX26.5.sdk) — ScreenCaptureKit.framework/Headers/*.h

import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

// MARK: - Constants

/// Hard upper bound for a single recording session (seconds).
private let kMaxDurationSeconds = 170

/// Lens Studio's macOS bundle identifier (read from the app's Info.plist).
private let kLensAppBundleID = "com.snap.LensStudio"

// MARK: - Errors

enum ToolError: Error, CustomStringConvertible {
    /// Exit with a specific code after printing `message`.
    case exit(Int, String)

    var description: String { switch self { case .exit(_, let m): return m } }
}

// MARK: - Helpers

/// Round to an even integer (video encoders want even dimensions), min 2 px.
private func evenRound(_ value: Double) -> Int {
    max(2, Int(value.rounded()) & ~1)
}

/// Render a FourCharCode (e.g. 'avc1', 'aac ') as a readable string.
private func fourCCString(_ code: FourCharCode) -> String {
    let bytes = [
        UInt8((code >> 24) & 0xFF), UInt8((code >> 16) & 0xFF),
        UInt8((code >> 8) & 0xFF), UInt8(code & 0xFF),
    ]
    return String(bytes: bytes, encoding: .ascii) ?? "0x\(String(code, radix: 16))"
}

/// Thread-safe stop flag shared with signal handlers.
final class StopFlag {
    private let lock = NSLock()
    private var value = false
    var isSet: Bool {
        lock.lock(); defer { lock.unlock() }
        return value
    }
    func set() {
        lock.lock(); value = true; lock.unlock()
    }
}

// MARK: - Delegates

/// Reports SCRecordingOutput lifecycle (started / failed / file finalized).
final class RecorderDelegate: NSObject, SCRecordingOutputDelegate {
    let didStart = StopFlag()
    let didFinish = StopFlag()
    private let lock = NSLock()
    private var failure: String?
    var failureMessage: String? {
        lock.lock(); defer { lock.unlock() }
        return failure
    }
    private func recordFailure(_ message: String) {
        lock.lock()
        if failure == nil { failure = message }
        lock.unlock()
    }

    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {
        didStart.set()
    }

    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        recordFailure("recording output failed: \(error)")
        didFinish.set() // unblock the waiter; failure is surfaced afterwards
    }

    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        didFinish.set()
    }
}

/// Surfaces unexpected stream termination (e.g. window closed mid-record).
final class StreamStopDelegate: NSObject, SCStreamDelegate {
    private let lock = NSLock()
    private var stopError: String?
    var stopErrorMessage: String? {
        lock.lock(); defer { lock.unlock() }
        return stopError
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock()
        if stopError == nil { stopError = "stream stopped unexpectedly: \(error)" }
        lock.unlock()
    }
}

// MARK: - Options

struct RecordOptions {
    var output: String?
    var durationSeconds = 60
    var windowID: CGWindowID?
    var windowTitleSubstring: String?
    /// false = VIDEO ONLY (default, fully isolated). true = whole system output mix.
    var audioSystem = false
    var fps = 30
    /// auto | landscape (1280x720 box) | square (1280x1280 box)
    var boxMode = "auto"
}

// MARK: - Tool

@main
struct PreviewRecorder {
    static func main() async {
        let arguments = Array(CommandLine.arguments.dropFirst())

        do {
            if arguments.contains("--check") {
                try await runCheck()
            } else if arguments.contains("--record") {
                let exitCode = try await runRecord(arguments)
                exit(Int32(exitCode))
            } else {
                printUsage()
                exit(3)
            }
        } catch let error as ToolError {
            FileHandle.standardError.write(Data((error.description + "\n").utf8))
            switch error {
            case .exit(let code, _): exit(Int32(code))
            }
        } catch {
            FileHandle.standardError.write(Data("error: \(error)\n".utf8))
            exit(1)
        }
    }

    // MARK: Usage

    private static func printUsage() {
        print("""
        preview-recorder — record the real Lens Studio Preview window (macOS 15+)

        USAGE:
          preview-recorder --check
              Preflight only: verify Screen Recording permission and list
              Lens Studio windows (IDs + titles). Never lists other apps'
              windows, never starts a recording, never triggers a prompt.

          preview-recorder --record --output FILE.mp4 [options]
              Record one Lens Studio window to FILE.mp4 (H.264 + AAC).
              Refuses to overwrite an existing file. Hard cap: 170 s.

        OPTIONS (--record):
          --output PATH        Destination .mp4 (must not already exist; parent
                               directory must already exist).
          --duration SECONDS   Recording length, 1–170 (default 60).
          --window-id N        Exact CGWindowID (from --check).
          --window-title TEXT  Case-insensitive substring of the window title.
          --audio none|system  none (default): VIDEO ONLY — no audio track at all.
                               system: record the macOS system output mix.
                               NOTE: there is no per-app audio API; 'system'
                               includes sound from every app. The microphone is
                               never captured in either mode.
          --fps N              Target frame rate, 1–60 (default 30).
          --box landscape|square|auto
                               Output bounding box: 1280x720 (landscape) or
                               1280x1280 (square). auto picks by source aspect.
                               Source aspect ratio is always preserved — content
                               is scaled to fit, never stretched.

        EXIT CODES:
          0 success   1 capture/verification error   2 Screen Recording
          permission missing (nothing was recorded)  3 usage/window-selection
          error   4 recorded, but requested audio track not present in the
          output file (measured after recording)
        """)
    }

    // MARK: Permission (preflight only — never prompts, never changes settings)

    private static func requireScreenCapturePermission() throws {
        guard CGPreflightScreenCaptureAccess() else {
            let responsible = Bundle.main.bundleIdentifier ?? "the terminal app that launches this tool"
            throw ToolError.exit(2, """
            Screen Recording permission is NOT granted (CGPreflightScreenCaptureAccess == false).
            Nothing was recorded and no prompt was shown (this tool never changes settings).

            To grant it, the user must do exactly this, once:
              1. Open System Settings -> Privacy & Security -> Screen & System Audio Recording.
              2. Enable the app responsible for this process: \(responsible)
                 (e.g. Terminal, iTerm2, or your IDE — whatever launches preview-recorder).
              3. Fully quit and relaunch that responsible app (macOS only applies
                 the permission after it restarts).
            Then re-run with --check to confirm.
            """)
        }
    }

    // MARK: Shareable content

    /// Full content (on-screen + off-screen windows). Lens Studio's windows are
    /// often off-screen while LS sits in the background; filtering to on-screen
    /// only would hide them and confuse --check. Privacy note: only Lens Studio
    /// windows/app names are ever printed by this tool.
    private static func loadShareableContent() async throws -> SCShareableContent {
        try await withCheckedThrowingContinuation { continuation in
            SCShareableContent.getExcludingDesktopWindows(
                true, onScreenWindowsOnly: false
            ) { content, error in
                if let content {
                    continuation.resume(returning: content)
                } else {
                    continuation.resume(throwing: error ?? NSError(
                        domain: "preview-recorder", code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "SCShareableContent returned no content"]
                    ))
                }
            }
        }
    }

    private static func isLensStudioApp(_ app: SCRunningApplication) -> Bool {
        let bundleID = app.bundleIdentifier.lowercased()
        let name = app.applicationName.lowercased()
        return bundleID == kLensAppBundleID
            || bundleID.contains("lensstudio")
            || name.contains("lens studio")
            || name == "lensstudio"
    }

    private static func lensStudioWindows(in content: SCShareableContent) -> [SCWindow] {
        content.windows
            .filter { window in
                guard let app = window.owningApplication else { return false }
                return isLensStudioApp(app)
            }
            .sorted { a, b in
                if a.isOnScreen != b.isOnScreen { return a.isOnScreen } // on-screen first
                let areaA = a.frame.width * a.frame.height
                let areaB = b.frame.width * b.frame.height
                return areaA > areaB
            }
    }

    /// Cross-check against CoreGraphics window metadata: is Lens Studio running
    /// with windows at all, independent of ScreenCaptureKit enumeration?
    private static func lensStudioRunningPerWindowServer() -> Bool {
        let list = CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] ?? []
        return list.contains { window in
            let owner = window[kCGWindowOwnerName as String] as? String ?? ""
            return owner.lowercased().contains("lens studio")
        }
    }

    private static func describeWindow(_ window: SCWindow) -> String {
        let app = window.owningApplication.map { "\($0.applicationName) [\($0.bundleIdentifier)]" } ?? "(no app)"
        let title = window.title ?? "(untitled)"
        let frame = window.frame
        return String(
            format: "windowID=%-10d  %6.0fx%-6.0f @(%0.f,%0.f)  onScreen=%@  active=%@  layer=%d  title=%@  app=%@",
            Int(window.windowID), frame.width, frame.height,
            frame.origin.x, frame.origin.y,
            window.isOnScreen ? "yes" : "no",
            window.isActive ? "yes" : "no",
            window.windowLayer, title, app
        )
    }

    // MARK: --check

    private static func runCheck() async throws {
        try requireScreenCapturePermission()

        print("Screen Recording permission: GRANTED (preflight)")
        let content = try await loadShareableContent()
        let lensWindows = lensStudioWindows(in: content)
        let lensAppIDs = Set(content.applications.filter(isLensStudioApp).map { $0.bundleIdentifier })

        print("Lens Studio application(s): \(lensAppIDs.joined(separator: ", "))")
        if lensWindows.isEmpty {
            if lensStudioRunningPerWindowServer() {
                throw ToolError.exit(2, """
                Lens Studio is running (CoreGraphics sees its windows) but ScreenCaptureKit \
                returned no Lens Studio windows — Screen Recording consent may be stale for \
                this context. Re-approve and relaunch, then re-run --check.
                """)
            }
            print("Lens Studio does not appear to be running. Start it, open the Preview, then re-run --check.")
            return
        }

        print("Lens Studio windows (only Lens Studio windows are listed; on-screen first):")
        for window in lensWindows {
            print("  " + describeWindow(window))
        }
        let onScreenCount = lensWindows.filter { $0.isOnScreen }.count
        if onScreenCount == 0 {
            print("NOTE: no Lens Studio window is currently on screen. Recording one while it is " +
                  "hidden/minimized may produce blank or idle frames — bring the Preview window " +
                  "to the front before --record.")
        }
        let others = content.windows.count - lensWindows.count
        print("Hidden from this listing: \(others) window(s) owned by other applications.")
        print("No recording was started (--check is read-only).")
    }

    // MARK: Argument parsing

    private static func parseRecordOptions(_ arguments: [String]) throws -> RecordOptions {
        var options = RecordOptions()
        var index = 0
        func nextValue(_ name: String) throws -> String {
            index += 1
            guard index < arguments.count else {
                throw ToolError.exit(3, "missing value for \(name)")
            }
            return arguments[index]
        }

        while index < arguments.count {
            let arg = arguments[index]
            switch arg {
            case "--output":
                options.output = try nextValue(arg)
            case "--duration":
                guard let value = Int(try nextValue(arg)), value >= 1 else {
                    throw ToolError.exit(3, "--duration must be a positive integer")
                }
                options.durationSeconds = min(value, kMaxDurationSeconds)
                if value > kMaxDurationSeconds {
                    print("note: duration clamped to the hard cap of \(kMaxDurationSeconds)s")
                }
            case "--window-id":
                guard let value = UInt32(try nextValue(arg)) else {
                    throw ToolError.exit(3, "--window-id must be an integer CGWindowID")
                }
                options.windowID = value
            case "--window-title":
                options.windowTitleSubstring = try nextValue(arg)
            case "--audio":
                let value = try nextValue(arg).lowercased()
                switch value {
                case "none": options.audioSystem = false
                case "system": options.audioSystem = true
                default:
                    throw ToolError.exit(3, "--audio must be 'none' (video only) or 'system' (whole system mix)")
                }
            case "--fps":
                guard let value = Int(try nextValue(arg)), value >= 1 else {
                    throw ToolError.exit(3, "--fps must be a positive integer")
                }
                options.fps = min(value, 60)
            case "--box":
                let value = try nextValue(arg).lowercased()
                guard ["auto", "landscape", "square"].contains(value) else {
                    throw ToolError.exit(3, "--box must be auto, landscape (1280x720) or square (1280x1280)")
                }
                options.boxMode = value
            case "--record", "--check":
                break
            default:
                throw ToolError.exit(3, "unknown argument: \(arg) (run preview-recorder with no arguments for usage)")
            }
            index += 1
        }

        guard let output = options.output, !output.isEmpty else {
            throw ToolError.exit(3, "--record requires --output FILE.mp4")
        }
        return options
    }

    // MARK: Output path (explicit new file, never overwrite)

    private static func validatedOutputURL(_ path: String) throws -> URL {
        var expanded = path
        if expanded.hasPrefix("~") {
            expanded = (expanded as NSString).expandingTildeInPath
        }
        let url = URL(fileURLWithPath: expanded)

        guard url.pathExtension.lowercased() == "mp4" else {
            throw ToolError.exit(3, "output must be an .mp4 path (got: \(url.lastPathComponent))")
        }
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: url.path) {
            throw ToolError.exit(3, "output file already exists, refusing to overwrite: \(url.path)")
        }
        let parentDirectory = url.deletingLastPathComponent().path
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: parentDirectory, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw ToolError.exit(3, "output parent directory does not exist: \(parentDirectory)")
        }
        return url
    }

    // MARK: Window selection

    /// Shared diagnostic when ScreenCaptureKit shows no Lens Studio windows.
    private static func ensureLensWindowsReachable(_ content: SCShareableContent) throws {
        guard lensStudioWindows(in: content).isEmpty else { return }
        if lensStudioRunningPerWindowServer() {
            throw ToolError.exit(2, """
            Lens Studio is running (CoreGraphics sees its windows) but ScreenCaptureKit \
            returned no Lens Studio windows — Screen Recording consent may be stale for \
            this context. Re-approve and relaunch, then retry.
            """)
        }
        throw ToolError.exit(3, "Lens Studio does not appear to be running. Start it, open the Preview window, then retry.")
    }

    private static func selectWindow(
        _ options: RecordOptions, content: SCShareableContent
    ) throws -> SCWindow {
        let candidates = lensStudioWindows(in: content)

        if let wantedID = options.windowID {
            if let match = candidates.first(where: { $0.windowID == wantedID }) {
                return match
            }
            throw ToolError.exit(3, "no Lens Studio window with windowID \(wantedID). Run --check for current IDs.")
        }

        if let wantedTitle = options.windowTitleSubstring {
            let lowered = wantedTitle.lowercased()
            let matches = candidates.filter { ($0.title ?? "").lowercased().contains(lowered) }
            guard let match = matches.first else {
                throw ToolError.exit(3, "no Lens Studio window title contains \"\(wantedTitle)\". Run --check for current titles.")
            }
            if matches.count > 1 {
                print("note: \(matches.count) windows matched the title; using the largest on-screen one (windowID=\(match.windowID))")
            }
            return match
        }

        let visible = candidates.filter { $0.isOnScreen && $0.frame.width >= 120 && $0.frame.height >= 120 }
        switch visible.count {
        case 1:
            return visible[0]
        default:
            let listing = candidates.map {
                "  windowID=\($0.windowID) title=\($0.title ?? "(untitled)") \(Int($0.frame.width))x\(Int($0.frame.height)) onScreen=\($0.isOnScreen ? "yes" : "no")"
            }.joined(separator: "\n")
            throw ToolError.exit(3, """
            no unique sizable on-screen Lens Studio window to auto-select (bring exactly one \
            Lens Studio window to the front, or pass --window-id / --window-title). Candidates:
            \(listing)
            """)
        }
    }

    // MARK: Async wrappers

    private static func startCapture(_ stream: SCStream) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            stream.startCapture { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    private static func stopCapture(_ stream: SCStream) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            stream.stopCapture { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    // MARK: Post-record measurement (never claim audio that was not measured)

    private static func measureOutputFile(at url: URL, audioRequested: Bool) async throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        let fileSize = (attributes[.size] as? NSNumber)?.intValue ?? 0

        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration)
        let videoTracks = try await asset.loadTracks(withMediaType: .video)
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)

        print("--- measured output (\(url.lastPathComponent), \(fileSize) bytes, \(String(format: "%.2f", duration.seconds))s) ---")

        guard let videoTrack = videoTracks.first else {
            throw ToolError.exit(1, "verification failed: no video track present in the recorded file")
        }
        let naturalSize = try await videoTrack.load(.naturalSize)
        let frameRate = try await videoTrack.load(.nominalFrameRate)
        var videoCodec = "unknown"
        let videoFormats = try await videoTrack.load(.formatDescriptions)
        if let format = videoFormats.first {
            videoCodec = fourCCString(CMFormatDescriptionGetMediaSubType(format))
        }
        print("video track: codec=\(videoCodec) size=\(Int(naturalSize.width))x\(Int(naturalSize.height)) fps=\(String(format: "%.1f", frameRate))")

        if let audioTrack = audioTracks.first {
            var audioDescription = "aac"
            let audioFormats = try await audioTrack.load(.formatDescriptions)
            if let format = audioFormats.first, let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee {
                audioDescription = "\(fourCCString(CMFormatDescriptionGetMediaSubType(format))) \(Int(streamDescription.mSampleRate)) Hz x \(streamDescription.mChannelsPerFrame) ch"
            }
            print("audio track: \(audioDescription)")
        } else {
            print("audio track: none (measured)")
            if audioRequested {
                print("WARNING: system audio was requested but no audio track is present in the file.")
                return 4
            }
        }
        return 0
    }

    // MARK: --record

    private static func runRecord(_ arguments: [String]) async throws -> Int {
        let options = try parseRecordOptions(arguments)
        try requireScreenCapturePermission()

        let outputURL = try validatedOutputURL(options.output!)
        let content = try await loadShareableContent()
        try ensureLensWindowsReachable(content)
        let window = try selectWindow(options, content: content)
        let filter = SCContentFilter(desktopIndependentWindow: window)

        if !window.isOnScreen {
            print("WARNING: the selected window is currently OFF-SCREEN. ScreenCaptureKit may " +
                  "deliver blank/idle frames until the window is visible — bring it to the front " +
                  "for a real preview capture.")
        }

        // Source pixel size: window content rect (points) * display scale.
        let contentInfo = SCShareableContent.info(for: filter)
        let pointToPixel = max(1.0, min(4.0, Double(contentInfo.pointPixelScale)))
        let contentRect = contentInfo.contentRect.width > 0 ? contentInfo.contentRect : window.frame
        let sourceWidthPx = max(2, Int((contentRect.width * pointToPixel).rounded()))
        let sourceHeightPx = max(2, Int((contentRect.height * pointToPixel).rounded()))

        // Fit within the requested bounding box, preserving source aspect ratio
        // (never stretch). scalesToFit allows upscaling small preview windows;
        // preservesAspectRatio guarantees the frame keeps the source shape.
        let aspect = Double(sourceWidthPx) / Double(sourceHeightPx)
        let box: (width: Int, height: Int)
        switch options.boxMode {
        case "landscape": box = (1280, 720)
        case "square": box = (1280, 1280)
        default: box = aspect >= 1.0 ? (1280, 720) : (1280, 1280)
        }
        let fitScale = min(Double(box.width) / Double(sourceWidthPx), Double(box.height) / Double(sourceHeightPx))
        let outputWidth = evenRound(Double(sourceWidthPx) * fitScale)
        let outputHeight = evenRound(Double(sourceHeightPx) * fitScale)

        let configuration = SCStreamConfiguration()
        configuration.width = outputWidth
        configuration.height = outputHeight
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(options.fps))
        configuration.scalesToFit = true
        configuration.preservesAspectRatio = true
        configuration.showsCursor = true
        configuration.captureDynamicRange = .SDR // HDR recording unsupported per SDK header
        configuration.capturesAudio = options.audioSystem
        if options.audioSystem {
            configuration.excludesCurrentProcessAudio = true
            configuration.sampleRate = 48_000
            configuration.channelCount = 2
        }
        // HARD RULE: the microphone is never captured.
        configuration.captureMicrophone = false

        let recordingConfiguration = SCRecordingOutputConfiguration()
        recordingConfiguration.outputURL = outputURL
        recordingConfiguration.videoCodecType = .h264
        recordingConfiguration.outputFileType = .mp4

        let recorderDelegate = RecorderDelegate()
        let streamDelegate = StreamStopDelegate()
        let recorder = SCRecordingOutput(configuration: recordingConfiguration, delegate: recorderDelegate)
        let stream = SCStream(filter: filter, configuration: configuration, delegate: streamDelegate)

        // Add the recording output BEFORE startCapture so the first captured
        // sample lands in the file (per SCStream.h documentation).
        try stream.addRecordingOutput(recorder)

        // Graceful Ctrl-C / SIGTERM handling: stop the stream so the file is
        // finalized; never leave a truncated .mp4 behind.
        let interrupted = StopFlag()
        signal(SIGINT, SIG_IGN)
        signal(SIGTERM, SIG_IGN)
        let signalSources = [SIGINT, SIGTERM].map { signalNumber -> DispatchSourceSignal in
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .global())
            source.setEventHandler { interrupted.set() }
            source.resume()
            return source
        }
        defer { for source in signalSources { source.cancel() } }

        let title = window.title ?? "(untitled)"
        print("window: windowID=\(window.windowID) title=\(title) app=com.snap.LensStudio")
        print("source: \(sourceWidthPx)x\(sourceHeightPx) px (points x\(String(format: "%.1f", pointToPixel))) -> output \(outputWidth)x\(outputHeight) (aspect preserved, fit in \(box.width)x\(box.height))")
        print("video: H.264 .mp4 @ \(options.fps) fps target; audio: \(options.audioSystem ? "SYSTEM OUTPUT MIX (all apps)" : "NONE (video only)")")
        print("microphone: never captured. duration cap: \(min(options.durationSeconds, kMaxDurationSeconds))s")
        print("recording \(outputURL.path) ... (Ctrl-C stops gracefully and finalizes the file)")

        try await startCapture(stream)
        let deadline = Date().addingTimeInterval(Double(min(options.durationSeconds, kMaxDurationSeconds)))
        while Date() < deadline && !interrupted.isSet && streamDelegate.stopErrorMessage == nil {
            try await Task.sleep(nanoseconds: 250_000_000)
        }

        // stopCapture finalizes the recording; wait for the delegate's
        // recordingOutputDidFinishRecording so the .mp4 is fully written.
        try await stopCapture(stream)
        _ = recorderDelegate.didFinish.waitOrTimeout(seconds: 20)
        for source in signalSources { source.cancel() }

        if let failure = recorderDelegate.failureMessage {
            throw ToolError.exit(1, failure)
        }
        if let stopError = streamDelegate.stopErrorMessage {
            throw ToolError.exit(1, stopError)
        }

        let exitCode = try await measureOutputFile(at: outputURL, audioRequested: options.audioSystem)
        print("recording complete: \(outputURL.path)")
        return exitCode
    }
}

// MARK: - StopFlag wait helper

extension StopFlag {
    /// Block up to `seconds` for the flag; returns true if it was set.
    func waitOrTimeout(seconds: Double) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if isSet { return true }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return isSet
    }
}
