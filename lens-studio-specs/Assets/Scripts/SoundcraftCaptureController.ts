// SoundcraftCaptureController.ts — the ONE scene component of the companion
// adapter. NEW file: it reads the owned prototype only through its public,
// existing surfaces (SoundcraftBus.onHit / SoundcraftBus.instruments, pad
// SceneObjects named Pad0..N with an AudioComponent) — no owned script, scene,
// or package file is edited.
//
// WHAT IT OWES THE USER (honesty rules):
//  * The Lens's own sounds are the LOCAL monitor: "AUDIO = LOCAL DEVICE
//    MONITOR ONLY". The backend records notes; it never sounds them.
//  * Judge mode (`judgeLocalOnlyMode`) is clearly labelled local-only — no
//    request is sent, no backend is claimed, the playlist says so.
//  * The saved badge appears ONLY on an exact `saved` receipt
//    (saved.status === "saved") — never from a listing, never inferred.
//  * Note timing is ONE monotonic lens clock (getRealTimeNanos deltas from the
//    session origin): real onset; note-off by the explicitly-labelled
//    SAMPLE-DURATION POLICY (the pad's declared asset duration), observed
//    retrigger cuts, or a trusted explicit finish — the runtime setOnFinish
//    is deliberately NOT used (fires on manual stop; no generation identity).
//    NO sample-phase alignment or drift correction is claimed anywhere.
//  * Retries are only ever for events provably not applied (the client owns
//    that policy); commits/saves with unknown outcomes settle by readback.
//
// PAIRING CREDENTIALS: the pairing code arrives ONLY via the public
// submitPairingCode() / configureEndpointAndPair() methods (memory/UI — there
// is NO inspector field: an authored scene value could never be truly removed
// at runtime), is exchanged once, and the resulting bearer token lives ONLY
// inside the transport's memory field. Nothing is
// written back to any input, scene asset, or log (logs use length-only masks),
// and no service/cluster/Forge credential ever passes through this file.
//
// RUNTIME WORKFLOW API (no Inspector / no CLI needed):
//  * configureEndpointAndPair(endpoint, code) — strict-HTTPS runtime endpoint
//    + one-time code; refuses unsafe endpoint changes over preserved data.
//  * explicitOpenLastSavedProject() — the guarded operator reopen: the
//    client's bootstrap only EVER auto-recovers a demonstrably tracks:[]
//    document, so a banked boot (the CLI ensure creates 12 tracks at start)
//    intentionally surfaces "use the explicit open-last-save action" instead.
//    This method closes a SAFE open session first (awaited), then opens the
//    last save, refreshes capabilities/track ends via the client's existing
//    calls, and resumes capture only after actual success. It refuses on ANY
//    preserved work — no discard, no destruction, no blind recover.
//  * getStatusSnapshot() — poll-safe scrubbed StatusDetail for UI panels.
//  * onWorkflowNote — optional hook; outcomes also render in statusText.
//  The bus/local monitor keeps working even when unconfigured; pre-pair hits
//  stay clearly "NOT CAPTURED (no open session)" counts — never replayed,
//  never fake-saved, and the replaced count is carried into the status line.

import { SoundcraftBus, HitInfo } from "./SoundcraftBus";
import {
  ClientEnv,
  DEFAULT_CONFIG,
  MONITOR_LABEL,
  SoundcraftCompanionClient,
  StatusDetail,
} from "./SoundcraftCompanionClient";
import {
  DeadlineTimer,
  InternetModuleTransport,
  neverTime,
} from "./SoundcraftCompanionHttp";
import { surfaceIdFor } from "./SoundcraftCompanionTypes";

// The Lens's own stable note-naming convention (documented, not a backend claim):
// beat = GM percussion keys on channel 9; bass/chord = chromatic keys on channel 0.
const BEAT_KEYS = [36, 38, 42, 39]; // KICK · SNARE · HAT · CLAP
const BASS_KEYS = [33, 36, 38, 40]; // A1 · C2 · D2 · E2
const CHORD_KEYS = [48, 46, 44, 51]; // Cm · Bb · Ab · Eb
const BEAT_CHANNEL = 9;
const MELODIC_CHANNEL = 0;
const DEFAULT_VELOCITY = 100; // the Lens's fixed note velocity (no per-hit sensor exists in this prototype)
const DISCOVERY_MAX_FRAMES = 600; // ~10 s at 60 fps: pads register in their own OnStart

// SAMPLE-DURATION WINDOW REQUEST (PR17 live_open `stuck_timeout_seconds`) — a
// controller-owned bounded override, deliberately NOT DEFAULT_CONFIG's 2.0 s:
// that value predates the current pad samples and silently made every chord
// one-shot "not capturable" even though the Lens declares and plays the full
// sample. Backed by the ACTUAL WAV headers in Assets/GeneratedSFX (all
// 44100 Hz, 16-bit PCM): bass_*.wav 1.864263 s (mono), chord_1..4.wav
// 5.219887 s (stereo), pad_*.wav ≤ 0.30 s. 7.0 s covers the longest declared
// one-shot (5.219887 s) with ~34 % headroom and is hard-bounded under the
// 10 s ceiling below. This is only the REQUEST — the backend's open reply
// (`stuck_timeout_samples` / `sample_rate`) remains the EFFECTIVE bound: a
// backend that honours less keeps long-declared notes honestly retained
// (never sent, never truncated), an old backend that rejects the field still
// triggers the client's progressive safeguard (retry once without it, long
// notes retained, compatible-backend requirement surfaced), and a missing
// window stays fail-closed as "CAPTURE WINDOW unknown" in the status. Adding
// a LONGER pad sample than the window is an honest refusal path (the
// duration-policy test refuses loudly), never a silent clip.
// ASSET-DERIVED ALTERNATIVE (documented, not implemented): discovery reads
// each pad's real `audio.duration`, but the client exposes no public API to
// reconfigure the requested window before `startCapture` (cfg is private,
// constructor-injected; judge/paired sessions can open before pad discovery
// completes) — deriving the request from assets would need a client-owner
// change (a public pre-start config setter). The bounded fixed 7.0 s is the
// documented SAMPLE-DURATION policy for the known original set.
const REQUESTED_STUCK_TIMEOUT_SECONDS = 7.0;
const REQUESTED_STUCK_TIMEOUT_CEILING_SECONDS = 10.0; // bounded tolerance ceiling — never request an unbounded window

// ---- WORKFLOW PURE LOGIC (exported; no Lens-runtime dependency) --------------
// These gate functions ARE the decision logic the public controller methods
// run (the methods call them directly — not a parallel copy). They are kept
// dependency-free (string/number/StatusDetail inputs only) so the workflow
// test can import this exact module (Lens decorators stripped mechanically)
// and exercise the shipped logic. The endpoint validator is deliberately
// string-level: this Lens runtime exposes no URL parser in StudioLib.d.ts, so
// string parsing is the verified no-DOM route.

export type WorkflowGateDecision = {
  allowed: boolean;
  code: string; // stable machine code for the UI
  reason: string; // safe human text — constructed here, never echoes endpoints/codes/tokens
  needCloseFirst: boolean; // an open session is present and empty-safe: close it first (awaited)
};

/**
 * Defensive scrub for workflow notes: they are CONSTRUCTED safe (no endpoint,
 * code or token), but the status line must stay safe even if wording ever
 * changes. Strips URL-shaped substrings, withholds credential-shaped content
 * outright, and caps the length.
 */
export function sanitizeWorkflowNote(note: string): string {
  let out = String(note === null || note === undefined ? "" : note);
  out = out.replace(/https?:\/\/[^ \n]*/gi, "<endpoint>");
  const lowered = out.toLowerCase();
  if (lowered.indexOf("bearer") !== -1 || lowered.indexOf("access_token") !== -1 || out.indexOf("eyJ") !== -1) {
    return "[note withheld — credential-shaped content refused]";
  }
  if (out.length > 220) {
    out = out.slice(0, 217) + "...";
  }
  return out;
}

/**
 * Strict runtime-endpoint validation (https only). Rules: https scheme, no
 * user:password@ userinfo (credentials never ride in URLs), no query string,
 * no fragment, host[:port] with a sane host shape, arbitrary /path prefix
 * ALLOWED (the transport concatenates baseUrl + path, e.g. tunnel subpaths).
 * Accepts private/tailnet hostnames for now — authored-scene sanitization is
 * a separate later lane. Returns the normalized endpoint when valid.
 */
export function validateHttpEndpointStrict(raw: string): { ok: boolean; normalized: string; problem: string } {
  const endpoint = String(raw === null || raw === undefined ? "" : raw).trim();
  if (endpoint.length === 0) {
    return { ok: false, normalized: "", problem: "the endpoint is empty" };
  }
  if (endpoint.length > 300) {
    return { ok: false, normalized: "", problem: "the endpoint is unreasonably long (>300 chars)" };
  }
  for (let i = 0; i < endpoint.length; i++) {
    const c = endpoint.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) {
      return { ok: false, normalized: "", problem: "the endpoint contains whitespace or control characters" };
    }
  }
  if (endpoint.indexOf("?") !== -1) {
    return { ok: false, normalized: "", problem: "query strings are refused in the endpoint" };
  }
  if (endpoint.indexOf("#") !== -1) {
    return { ok: false, normalized: "", problem: "fragments are refused in the endpoint" };
  }
  const schemeSep = endpoint.indexOf("://");
  if (schemeSep <= 0) {
    return { ok: false, normalized: "", problem: "the endpoint has no scheme (expected https://...)" };
  }
  const scheme = endpoint.slice(0, schemeSep).toLowerCase();
  if (scheme !== "https") {
    return { ok: false, normalized: "", problem: "only https:// endpoints are accepted" };
  }
  const rest = endpoint.slice(schemeSep + 3);
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const urlPath = slash === -1 ? "" : rest.slice(slash);
  if (authority.indexOf("@") !== -1) {
    return { ok: false, normalized: "", problem: "user:password@ in the endpoint is refused (credentials never ride in URLs)" };
  }
  if (authority.length === 0) {
    return { ok: false, normalized: "", problem: "the endpoint has no host" };
  }
  const colon = authority.lastIndexOf(":");
  let host = authority;
  let port = "";
  if (colon !== -1) {
    host = authority.slice(0, colon);
    port = authority.slice(colon + 1);
    if (!/^\d{1,5}$/.test(port) || parseInt(port) > 65535 || parseInt(port) === 0) {
      return { ok: false, normalized: "", problem: "the port is not a valid 1..65535 number" };
    }
  }
  host = host.toLowerCase();
  if (!/^[a-z0-9.\-]+$/.test(host)) {
    return { ok: false, normalized: "", problem: "the host contains characters outside [a-z0-9.-]" };
  }
  if (host.indexOf(".") === -1) {
    return { ok: false, normalized: "", problem: "the host has no dot (public/tailnet hostnames do)" };
  }
  if (urlPath.length > 0 && !urlPath.startsWith("/")) {
    return { ok: false, normalized: "", problem: "the path must start with /" };
  }
  return { ok: true, normalized: scheme + "://" + authority + urlPath, problem: "" };
}

/**
 * The refuse-set of REAL preserved work: any of these means the operator has
 * material that a document replacement would lose — the workflow refuses and
 * changes nothing (no discard, no destruction, ever).
 *
 * DELIBERATELY EXCLUDED (visible lifetime loss/retention counters — no data
 * object exists behind them; replacing the doc never replays or saves them):
 * uncapturedHits, overflowDroppedNotes, retiredUnsent/RefusedEvents,
 * staleFinishesIgnored, policyClosedNotes, notCapturableNotes,
 * nonFaithfulNotes. completed/acked notes of an OPEN session are also not
 * pre-refused: a COMMITTED take closes cleanly, and the awaited
 * client.stopCapture() boolean is the authoritative arbiter (false ⇒
 * uncommitted take, NOT closed → refuse). The client never resets these
 * counters, so gating on them would permanently lock the workflow.
 */
function firstPreservedDataReason(s: StatusDetail): string {
  if (s.phase === "commit_pending") {
    return "a commit is in flight";
  }
  if (s.phase === "commit_unknown") {
    return "the last commit's outcome is UNKNOWN and must settle by readback";
  }
  if (s.unsynced.unsentEvents > 0) {
    return s.unsynced.unsentEvents + " queued event(s) are not yet confirmed applied";
  }
  if (s.heldNotes > 0 || s.unsynced.heldNotes > 0) {
    return (s.heldNotes > 0 ? s.heldNotes : s.unsynced.heldNotes) + " held note(s) are unfinished";
  }
  if (s.unsynced.notesUnknownDuration > 0) {
    return s.unsynced.notesUnknownDuration + " note(s) have UNKNOWN duration";
  }
  if (s.unsynced.bufferedHits > 0) {
    return s.unsynced.bufferedHits + " hit(s) are buffered for the next take";
  }
  if (s.unsynced.uncertainInFlight) {
    return "a reply was lost in flight (uncertain) — reconcile first";
  }
  const receipt = s.lastSavedReceipt;
  if (receipt !== null && receipt !== undefined) {
    if (receipt.status === "pending" || receipt.status === "unknown") {
      return "the previous save's outcome is " + receipt.status.toUpperCase() + " (a prior SAVED badge is never treated as settled)";
    }
  }
  return "";
}

/**
 * Gate for explicitOpenLastSavedProject(): pure, refuse-first. judge mode and
 * the unconfigured placeholder refuse up front (no backend to reopen from);
 * preserved work refuses without touching anything; an open but safe session
 * yields needCloseFirst (the caller awaits stopCapture and treats false as an
 * uncommitted-take refusal).
 */
export function gateExplicitOpenLastSaved(s: StatusDetail, judgeLocalOnlyMode: boolean): WorkflowGateDecision {
  if (s === null || s === undefined) {
    return { allowed: false, code: "no_status", reason: "no status snapshot available yet — nothing was done", needCloseFirst: false };
  }
  if (judgeLocalOnlyMode) {
    return { allowed: false, code: "judge_mode", reason: "judge mode is local-only by design — it never contacts the backend, so there is nothing to reopen", needCloseFirst: false };
  }
  if (s.localOnly) {
    return { allowed: false, code: "not_configured", reason: "no backend is configured yet — call configureEndpointAndPair(endpoint, code) first", needCloseFirst: false };
  }
  if (s.phase === "backend_down") {
    return { allowed: false, code: "backend_down", reason: "the backend is latched down — restart the companion first; nothing was done", needCloseFirst: false };
  }
  const data = firstPreservedDataReason(s);
  if (data !== "") {
    return { allowed: false, code: "data_present", reason: "reopen refused — " + data + " (nothing was discarded)", needCloseFirst: false };
  }
  if (s.capturingStillOpen) {
    return {
      allowed: true,
      code: "close_empty_session",
      reason: "an open session holds no preserved work — it will be closed first (a committed take closes cleanly)",
      needCloseFirst: true,
    };
  }
  return { allowed: true, code: "idle", reason: "", needCloseFirst: false };
}

export type ConfigureEndpointDecision = {
  allowed: boolean;
  code: string;
  reason: string;
  action: "none" | "pair_existing" | "rebuild_client";
  normalized: string; // valid normalized endpoint when allowed
};

/**
 * Gate for configureEndpointAndPair(): pure. Same endpoint + a real (online)
 * client ⇒ pair in place — the existing client, its token and its buffers are
 * untouched. A DIFFERENT endpoint (or the first real endpoint after the
 * unconfigured placeholder) ⇒ rebuild_client, allowed ONLY on a provably
 * clean state: no preserved work, no open session, an Internet Module present.
 * judge mode refuses outright (its zero-network promise must never bend).
 */
export function gateConfigureEndpoint(
  rawEndpoint: string,
  activeBaseUrl: string,
  clientBackendCapable: boolean,
  s: StatusDetail,
  judgeLocalOnlyMode: boolean,
  hasInternetModule: boolean
): ConfigureEndpointDecision {
  const refuse = (code: string, reason: string): ConfigureEndpointDecision => ({
    allowed: false,
    code: code,
    reason: reason,
    action: "none",
    normalized: "",
  });
  if (judgeLocalOnlyMode) {
    return refuse("judge_mode", "judge mode is local-only by design — endpoint configuration would break its zero-network promise");
  }
  if (!hasInternetModule) {
    return refuse("no_internet_module", "no Internet Module is assigned — fetch is impossible, pairing cannot run");
  }
  const check = validateHttpEndpointStrict(rawEndpoint);
  if (!check.ok) {
    return refuse("invalid_endpoint", check.problem);
  }
  if (s === null || s === undefined) {
    return refuse("no_status", "no status snapshot yet — the controller is still booting; try again");
  }
  if (clientBackendCapable && activeBaseUrl === check.normalized) {
    return { allowed: true, code: "pair_existing", reason: "", action: "pair_existing", normalized: check.normalized };
  }
  const data = firstPreservedDataReason(s);
  if (data !== "") {
    return refuse("data_present", "endpoint change refused — " + data + " (commit or settle first; nothing was discarded)");
  }
  if (s.capturingStillOpen) {
    return refuse("session_open", "endpoint change refused — a capture session is open; stopCapture() it first (commit/discard is the operator's decision)");
  }
  return {
    allowed: true,
    code: clientBackendCapable ? "endpoint_replacement_clean" : "initial_endpoint",
    reason: clientBackendCapable
      ? "clean state — a fresh client is registered at the new endpoint (the old token belonged to the old endpoint and is abandoned, never logged)"
      : "the unconfigured placeholder client is replaced by a real one — the local monitor keeps running meanwhile",
    action: "rebuild_client",
    normalized: check.normalized,
  };
}


type PadBinding = {
  instrument: string;
  pad: number;
  channel: number;
  key: number;
  audio: AudioComponent | null;
};

@component
export class SoundcraftCaptureController extends BaseScriptComponent {
  @input("Asset.InternetModule")
  @label("Internet Module")
  @hint("The Lens asset providing fetch. Required unless Judge Local-Only Mode is on.")
  internetModule: InternetModule = null;

  @input("string")
  @label("Companion Base URL")
  @hint("HTTPS endpoint of the companion, e.g. https://<machine>.tail….ts.net — set via Inspector, never hardcoded. The host must be in the project's allowed domains.")
  companionBaseUrl = "";

  @input("string")
  @label("Capture Track")
  @hint("Typed track id or name for live_open (e.g. an existing MIDI track name). No filesystem paths anywhere — the API has none.")
  captureTrack = "Lens";

  @input("bool")
  @label("Judge Local-Only Mode")
  @hint("Clearly-labelled LOCAL-ONLY judging: local capture + local monitor, zero network use, no backend claims.")
  judgeLocalOnlyMode = false;

  @input("Component.Text")
  @label("Status Text (optional)")
  @hint("Optional Text that mirrors the connection phase, queue state, and saved badge.")
  statusText: Text = null;

  @input("SceneObject")
  @label("Capture Root (optional)")
  @hint("Subtree scanned for instrument panels (BeatPanel/BassPanel/ChordPanel with Pad0..N children). Defaults to the whole scene.")
  captureRoot: SceneObject = null;

  /**
   * Optional typed snapshot hook for a pairing/status UI (connected after
   * review by the UI author — no credential ever appears in StatusDetail:
   * phases, counters, basenames, policy text only). Invoked from the safe
   * renderStatus path; a throwing consumer cannot break the capture loop.
   */
  public onSnapshot: (s: StatusDetail) => void = null;

  /**
   * Optional workflow-outcome hook (UI adds later): every refused/failed/ok
   * workflow step lands here as an already-sanitized note (see
   * sanitizeWorkflowNote). A throwing consumer cannot break capture.
   */
  public onWorkflowNote: (note: string) => void = null;

  private client: SoundcraftCompanionClient = null;
  private bindings: PadBinding[] = [];
  private discoveryFrames = 0;
  private discoveryDone = false;
  private pumpAccumulator = 0;
  private statusAccumulator = 0;
  private pendingPairCode: string | null = null;
  private connecting = false;
  private captureWanted = false;
  // runtime workflow state (memory only)
  private activeBaseUrl = ""; // the endpoint the CURRENT client transport was built with; the inspector input is never written back
  private busSubscribed = false; // exactly-once Bus subscription — a client swap never re-subscribes (onBusHit reads this.client dynamically)
  private workflowBusy = false; // one state-changing workflow at a time; UI retries, never queues
  private workflowNote = ""; // last sanitized workflow outcome (status text + hook)
  private declaredPolicyNs: { [id: string]: number } = {}; // "<channel>:<key>" → declared ns; re-registered onto any new client
  private prePairUnsavedHits = -1; // uncapturedHits carried from a replaced placeholder (-1 = none carried)

  onAwake() {
    this.createEvent("OnStartEvent").bind(() => this.start());
    this.createEvent("UpdateEvent").bind(() => this.update());
    this.createEvent("OnDestroyEvent").bind(() => this.onWillDestroy());
  }

  private start() {
    const online = !this.judgeLocalOnlyMode;
    if (online && (this.internetModule === null || this.companionBaseUrl === null || this.companionBaseUrl.length === 0)) {
      // Honest config failure: no fake endpoint, no fake pairing. The
      // placeholder client below is deliberately NOT pairable (pair() returns
      // false in local mode) — configureEndpointAndPair() REPLACES it at
      // runtime, so a missing Inspector endpoint is no longer a dead end.
      // The local monitor and Bus keep working meanwhile.
      this.client = new SoundcraftCompanionClient(this.makeLocalEnv(), cfgWithDefaults(false));
      void this.client.pair("");
      this.refreshStatusNow();
      print(
        "[Companion] CONFIG ERROR — set the Internet Module + Companion Base URL in the Inspector, call configureEndpointAndPair(endpoint, oneTimeCode) at runtime (no Inspector needed), or enable Judge Local-Only Mode. " +
        MONITOR_LABEL
      );
      return;
    }

    if (online) {
      this.activeBaseUrl = this.companionBaseUrl;
      this.client = this.createOnlineClient();
    } else {
      this.client = new SoundcraftCompanionClient(this.makeLocalEnv(), cfgWithDefaults(false));
    }

    // Bus subscription (public API of the owned prototype — read-only), once.
    this.subscribeBusOnce();

    // Pairing is memory/UI-only: the code arrives via submitPairingCode()
    // from a keyboard UI (an inspector field could never be truly removed
    // from the authored scene). Judge mode starts its local take at once.
    if (this.client !== null && this.judgeLocalOnlyMode) {
      void this.client.startCapture(this.captureTrack);
    }
    this.refreshStatusNow();
  }

  private makeLocalEnv() {
    return {
      transport: {
        request: () =>
          Promise.resolve({
            outcome: "local_only" as const,
            status: 0,
            bodyText: "",
            retryAfterSeconds: 0,
            problem: "judge mode — no request was sent",
          }),
      },
      nowSecs: getTime,
      realtimeNanos: getRealTimeNanos,
      timer: neverTime(),
      log: (m: string) => print(m),
    };
  }

  private subscribeBusOnce(): void {
    if (this.busSubscribed) {
      return; // onBusHit reads this.client dynamically, so a client swap needs no re-subscription
    }
    this.busSubscribed = true;
    SoundcraftBus.onHit.add((info: HitInfo) => this.onBusHit(info));
  }

  // EXACT current pipeline values, shared by the authored start() path AND the
  // runtime reconfiguration so every client runs the identical transport/config
  // pipeline: deadline 15.0 s, spacing 0.55 s (far under 120 req/min), cfg with
  // the controller's bounded 7.0 s stuck-window request.
  private buildOnlineEnv(): ClientEnv {
    return {
      transport: new InternetModuleTransport(
        {
          internetModule: this.internetModule,
          baseUrl: this.activeBaseUrl,
          deadlineSeconds: 15.0,
          timer: this.deadlineTimer(),
          clockNanos: getRealTimeNanos,
          log: (m: string) => print(m),
        },
        0.55
      ),
      nowSecs: getTime,
      realtimeNanos: getRealTimeNanos,
      timer: this.deadlineTimer(),
      log: (m: string) => print(m),
    };
  }

  private createOnlineClient(): SoundcraftCompanionClient {
    const created = new SoundcraftCompanionClient(this.buildOnlineEnv(), cfgWithDefaults(true));
    this.registerDeclaredPolicies(created);
    return created;
  }

  /** Re-register the discovered pad duration policies onto a (new) client. */
  private registerDeclaredPolicies(target: SoundcraftCompanionClient): void {
    for (const id in this.declaredPolicyNs) {
      const sep = id.indexOf(":");
      const channel = parseInt(id.slice(0, sep));
      const key = parseInt(id.slice(sep + 1));
      target.setPadPolicyDurationNs(key, channel, this.declaredPolicyNs[id]);
    }
  }

  /**
   * Public API for a keyboard UI: exchange the user-visible one-time code for
   * the in-memory token, then start capture. The code and token exist ONLY as
   * arguments/runtime memory — no inspector field, no scene value, no log.
   */
  submitPairingCode(code: string): void {
    if (this.client === null || this.connecting || this.workflowBusy) {
      return; // one state-changing flow at a time — the UI retries, never queues
    }
    this.connecting = true;
    this.captureWanted = true;
    void this.client
      .pair(code)
      .then((paired: boolean) => {
        this.connecting = false;
        if (paired && this.captureWanted) {
          this.captureWanted = false;
          return this.client.startCapture(this.captureTrack);
        }
        return false;
      })
      .then(() => this.refreshStatusNow())
      .catch(() => {
        this.connecting = false;
        print("[Companion] pairing flow failed — no claim was made; try again with a fresh code");
      });
  }

  /** Public API: stop the capture session (releases held voices) without unpairing. */
  stopCapture(): void {
    if (this.client !== null) {
      void this.client.stopCapture().then(() => this.refreshStatusNow());
    }
  }

  // ---- runtime workflow API (no Inspector / no CLI needed) --------------------

  /**
   * Poll-safe read-only snapshot for UI panels (playlist view etc.). The
   * StatusDetail is client-scrubbed — phases, counters, basenames, policy
   * text — NEVER a credential, endpoint, or code. Returns null before the
   * controller finishes booting. Pure getter: no state change, no network.
   */
  public getStatusSnapshot(): StatusDetail | null {
    return this.client !== null ? this.client.snapshot() : null;
  }

  /**
   * Public API (operator action, typically a UI button): open the newest save
   * and resume capture — the guarded explicit replacement of the live document
   * that the client's bootstrap deliberately never does implicitly. A banked
   * boot (the bank CLI ensure creates 12 tracks at start) can NEVER auto-
   * recover (the client only recovers a demonstrably tracks:[] document), so
   * THIS method is the only reopen path — and it refuses on ANY preserved
   * work: unfinished/unknown/unsynced notes, buffers, an in-flight or
   * unsettled commit, an unsettled save receipt (pending/unknown — a prior
   * SAVED badge is never treated as "current empty"), or an open session
   * whose awaited close is refused (uncommitted take — data intact).
   *
   * THE CALLER OWNS THE CONFIRMATION: this action REPLACES the live document,
   * so the UI must confirm with the user BEFORE calling. This API never
   * prompts and never discards.
   */
  public explicitOpenLastSavedProject(): Promise<boolean> {
    return this.runGuardedWorkflow((): Promise<boolean> => {
      const gate = gateExplicitOpenLastSaved(this.getStatusSnapshot(), this.judgeLocalOnlyMode);
      if (!gate.allowed) {
        this.setWorkflowNote(gate.code.toUpperCase() + " — " + gate.reason);
        return Promise.resolve(false);
      }
      const afterClose = gate.needCloseFirst ? this.client.stopCapture().then((closed: boolean): Promise<boolean> | boolean => {
        if (!closed) {
          // no discard option was passed: an uncommitted take refuses in the
          // client and stays fully intact
          this.setWorkflowNote("CLOSE REFUSED — the open take holds uncommitted work; commit it (or explicitly discard) first; the last save was NOT opened");
          return false;
        }
        return this.openLastSaveAndResume();
      }) : this.openLastSaveAndResume();
      return afterClose;
    });
  }

  /** recover + capabilities re-read + capture start, only after actual success of each step. */
  private openLastSaveAndResume(): Promise<boolean> {
    return this.client.explicitOpenLastSave().then((opened: boolean): Promise<boolean> => {
      if (!opened) {
        this.setWorkflowNote("OPEN FAILED — the live document was not proven replaced (see status); if a reply was lost, verify the document state in the UI before retrying");
        return Promise.resolve(false);
      }
      return this.client.refreshCapabilities().then((caps: boolean): Promise<boolean> => {
        if (!caps) {
          // Non-fatal: startCapture self-guards on an authoritative cap.
          this.setWorkflowNote("opened the last save, but the capabilities re-read did not answer cleanly — capture start may refuse until it does");
        }
        return this.client.startCapture(this.captureTrack).then((started: boolean): boolean => {
          if (!started) {
            this.setWorkflowNote("last save is OPEN but capture did not start (see status) — clear the surfaced blocker and retry; the reopened document is untouched");
            return false;
          }
          this.setWorkflowNote("OPENED the last save; capture resumed");
          return true;
        });
      });
    });
  }

  /**
   * Public API (no Inspector needed): configure the companion HTTPS endpoint
   * at runtime and pair with a one-time code, then start capture on success.
   * Endpoint rules (strict, string-level — this runtime has no URL parser):
   * https only, no user:password@, no query, no fragment, valid host[:port];
   * an arbitrary /path prefix is allowed (the transport concatenates
   * baseUrl + path). The endpoint is REPLACED only on a provably clean state —
   * refused over ANY preserved work or an open session; same-endpoint pairing
   * keeps the existing client untouched (token + buffers preserved). The
   * unconfigured placeholder (initial missing endpoint) is replaced by a real
   * client, so the local-only dead end cannot strand the demo. The code and
   * token are memory-only arguments — never logged, never stored on the
   * controller, never written to any input or scene asset. Private/tailnet
   * hostnames are accepted as-is for now (authored-scene sanitization is a
   * separate later lane).
   * PRE-PAIR HITS: hits while unconfigured stay visible "NOT CAPTURED (no open
   * session)" counts — the local monitor kept playing them; they are NEVER
   * replayed or fake-saved, and the replaced count is carried into the status
   * line so the honesty survives the swap.
   */
  public configureEndpointAndPair(endpoint: string, code: string): Promise<boolean> {
    return this.runGuardedWorkflow((): Promise<boolean> => {
      const gate = gateConfigureEndpoint(
        endpoint,
        this.activeBaseUrl,
        this.clientIsBackendCapable(),
        this.getStatusSnapshot(),
        this.judgeLocalOnlyMode,
        this.internetModule !== null
      );
      if (!gate.allowed) {
        this.setWorkflowNote(gate.code.toUpperCase() + " — " + gate.reason);
        return Promise.resolve(false);
      }
      const trimmed = String(code === null || code === undefined ? "" : code).trim();
      if (trimmed.length === 0) {
        this.setWorkflowNote("a one-time pairing code is required — nothing was sent");
        return Promise.resolve(false);
      }
      if (gate.action === "rebuild_client") {
        const before = this.getStatusSnapshot();
        if (before !== null) {
          this.prePairUnsavedHits = Math.max(this.prePairUnsavedHits, before.unsynced.uncapturedHits);
        }
        this.activeBaseUrl = gate.normalized; // memory only — the inspector input is never written back
        this.client = this.createOnlineClient(); // declared pad policies re-registered onto the fresh client
        this.setWorkflowNote("endpoint configured (memory only) — exchanging the one-time code...");
      }
      return this.client.pair(trimmed).then((paired: boolean): Promise<boolean> => {
        if (!paired) {
          this.setWorkflowNote("PAIRING DID NOT COMPLETE (see status) — the code may be burned; get a fresh code and try again; the local monitor is unaffected");
          return Promise.resolve(false);
        }
        return this.client.startCapture(this.captureTrack).then((started: boolean): boolean => {
          if (!started) {
            this.setWorkflowNote("paired, but capture did not open (see status) — clear the surfaced blocker and retry via submitPairingCode with a fresh code");
            return false;
          }
          this.setWorkflowNote("paired and capturing");
          return true;
        });
      });
    });
  }

  private clientIsBackendCapable(): boolean {
    const s = this.getStatusSnapshot();
    return s !== null && !s.localOnly;
  }

  /** One state-changing workflow at a time; failures keep data and are surfaced, never swallowed. */
  private runGuardedWorkflow(body: () => Promise<boolean>): Promise<boolean> {
    if (this.workflowBusy || this.connecting) {
      return Promise.resolve(false);
    }
    if (this.client === null) {
      this.setWorkflowNote("still booting — try again in a moment");
      return Promise.resolve(false);
    }
    this.workflowBusy = true;
    return body()
      .then((ok: boolean) => {
        this.workflowBusy = false;
        this.refreshStatusNow();
        return ok;
      })
      .catch((e) => {
        this.workflowBusy = false;
        this.setWorkflowNote("workflow failed unexpectedly (" + String(e) + ") — no data was discarded; state unchanged to the best of proof");
        return false;
      });
  }

  private setWorkflowNote(note: string): void {
    this.workflowNote = sanitizeWorkflowNote(note);
    if (this.onWorkflowNote !== null && this.onWorkflowNote !== undefined) {
      try {
        this.onWorkflowNote(this.workflowNote);
      } catch (e) {
        print("[Companion] workflow-note consumer threw (" + String(e) + ") — capture unaffected");
      }
    }
    this.refreshStatusNow();
  }

  // ---- pad discovery (read-only over the owned scene) -----------------------

  private update() {
    if (!this.discoveryDone) {
      this.discoverPads();
    }
    this.pumpAccumulator += getDeltaTime();
    if (this.client !== null && this.pumpAccumulator >= 0.25) {
      this.pumpAccumulator = 0;
      void this.client.pump().then(() => this.refreshStatusMaybe());
    }
  }

  private discoverPads() {
    this.discoveryFrames++;
    if (this.discoveryFrames > DISCOVERY_MAX_FRAMES) {
      this.discoveryDone = true;
      print("[Companion] pad discovery gave up after " + DISCOVERY_MAX_FRAMES + " frames — local monitor continues without backend capture");
      return;
    }
    if (SoundcraftBus.instruments.length === 0) {
      return; // panels self-register in their own OnStartEvent
    }
    const scanRoots: SceneObject[] = [];
    if (this.captureRoot !== null) {
      scanRoots.push(this.captureRoot);
    } else {
      // Whole-scene scan through the sanctioned root accessors (as SIK does).
      const count = global.scene.getRootObjectsCount();
      for (let i = 0; i < count; i++) {
        scanRoots.push(global.scene.getRootObject(i));
      }
    }
    this.bindings = [];
    let panels = 0;
    for (let i = 0; i < SoundcraftBus.instruments.length; i++) {
      const instrument = SoundcraftBus.instruments[i];
      const type = instrument.instrumentType;
      // Locate the panel's SceneObject by scanning the subtree(s) for the
      // panel name the prototype derives the type from (BeatPanel/…), or any
      // child holding a Pad0.
      const panelObj = this.findPanelObject(scanRoots, type);
      if (panelObj === null) {
        continue;
      }
      panels++;
      const keys = this.keysFor(type);
      const channel = this.channelFor(type);
      const padObjects = collectPadsNamed(panelObj);
      for (let p = 0; p < padObjects.length && p < keys.length; p++) {
        const padObj = padObjects[p];
        const audio = this.audioComponentOf(padObj);
        const binding: PadBinding = {
          instrument: type,
          pad: p,
          channel: channel,
          key: keys[p],
          audio: audio,
        };
        this.bindings.push(binding);
        if (audio !== null) {
          // GENERATION-SAFE NOTE-OFF (P1): the runtime `setOnFinish` is
          // deliberately NOT used. Its own contract — "called whenever this
          // sound stops playing", single-setter, callback receives only the
          // shared AudioComponent, no timing specified — makes it fire on
          // manual `stop()` (hitPad stops before replaying) with unspecified
          // ordering and no generation identity: an untrusted source that
          // could close a different generation at a fabricated ~0 duration.
          // Instead, the pad's DECLARED asset duration becomes the
          // explicitly-labelled SAMPLE-DURATION POLICY (a fixed per-pad
          // policy — never claimed as a measured natural callback), and
          // retriggered notes close at the observed cut. Both are enforced
          // deterministically inside the client.
          const declaredSecs = audio.duration;
          if (declaredSecs > 0 && isFinite(declaredSecs)) {
            const ns = Math.round(declaredSecs * 1e9);
            this.declaredPolicyNs[channel + ":" + keys[p]] = ns; // survives a client swap (runtime reconfiguration)
            if (this.client !== null) {
              this.client.setPadPolicyDurationNs(keys[p], channel, ns);
            }
          }
        }
      }
    }
    if (panels === SoundcraftBus.instruments.length && this.bindings.length > 0) {
      this.discoveryDone = true;
      const withAudio = this.audioCount();
      print(
        "[Companion] discovered " +
          this.bindings.length +
          " pads on " +
          panels +
          " instrument panel(s); " +
          (withAudio === this.bindings.length
            ? "every pad registered its declared asset duration as the SAMPLE-DURATION POLICY (runtime setOnFinish is not used as a note-off source: it fires on manual stop with no generation identity or timing guarantee)"
            : withAudio + " of " + this.bindings.length + " pads have audio — pads without audio have no duration policy and are honestly held/unknown unless explicitly finished")
      );
    }
  }

  private findPanelObject(roots: SceneObject[], instrumentType: string): SceneObject | null {
    const candidates: string[] = [];
    if (instrumentType === "beat") {
      candidates.push("BeatPanel");
    } else if (instrumentType === "bass") {
      candidates.push("BassPanel");
    } else if (instrumentType === "chord") {
      candidates.push("ChordPanel");
    }
    for (let r = 0; r < roots.length; r++) {
      for (let c = 0; c < candidates.length; c++) {
        const named = this.findDescendantByName(roots[r], candidates[c]);
        if (named !== null) {
          return named;
        }
      }
    }
    // Fallback: any descendant that has a child named Pad0.
    for (let r = 0; r < roots.length; r++) {
      const found = this.findDescendantWithPad0(roots[r]);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  private findDescendantByName(node: SceneObject, name: string): SceneObject | null {
    if (node.name === name) {
      return node;
    }
    for (let i = 0; i < node.getChildrenCount(); i++) {
      const found = this.findDescendantByName(node.getChild(i), name);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  private findDescendantWithPad0(node: SceneObject): SceneObject | null {
    for (let i = 0; i < node.getChildrenCount(); i++) {
      const child = node.getChild(i);
      if (child.name === "Pad0") {
        return node;
      }
      const found = this.findDescendantWithPad0(child);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  private keysFor(instrumentType: string): number[] {
    if (instrumentType === "beat") {
      return BEAT_KEYS;
    }
    if (instrumentType === "bass") {
      return BASS_KEYS;
    }
    if (instrumentType === "chord") {
      return CHORD_KEYS;
    }
    // Stable fallback for custom instruments: derived from the surface id — a
    // documented Lens convention, not a measured pitch.
    const surface = surfaceIdFor(instrumentType);
    const keys: number[] = [];
    for (let i = 0; i < 4; i++) {
      keys.push((surface + i * 7) % 128);
    }
    return keys;
  }

  private channelFor(instrumentType: string): number {
    return instrumentType === "beat" ? BEAT_CHANNEL : MELODIC_CHANNEL;
  }

  private audioComponentOf(obj: SceneObject): AudioComponent | null {
    let a = obj.getComponent("AudioComponent" as any) as AudioComponent;
    if (a === null || a === undefined) {
      a = obj.getComponent("Component.AudioComponent" as any) as AudioComponent;
    }
    return a;
  }

  private audioCount(): number {
    let n = 0;
    for (let i = 0; i < this.bindings.length; i++) {
      if (this.bindings[i].audio !== null) {
        n++;
      }
    }
    return n;
  }

  // ---- the bus → note pipeline ----------------------------------------------

  private onBusHit(info: HitInfo) {
    if (this.client === null) {
      return;
    }
    const channel = this.channelFor(info.instrument);
    const key = this.keyForPad(info.instrument, info.pad);
    this.client.noteOn(info.instrument, info.pad, key, DEFAULT_VELOCITY, channel);
  }

  private keyForPad(instrumentType: string, pad: number): number {
    const keys = this.keysFor(instrumentType);
    return keys[pad % keys.length];
  }

  // ---- status -----------------------------------------------------------------

  private refreshStatusNow() {
    this.renderStatus(this.client !== null ? this.client.snapshot() : null);
  }

  private refreshStatusMaybe() {
    // Text writes are cheap but not free: throttle to every other pump (2 Hz).
    this.statusAccumulator += 1;
    if (this.statusAccumulator >= 2) {
      this.statusAccumulator = 0;
      this.renderStatus(this.client !== null ? this.client.snapshot() : null);
    }
  }

  private renderStatus(s: StatusDetail | null) {
    if (s !== null && this.onSnapshot !== null && this.onSnapshot !== undefined) {
      // Safe invoke: a UI bug must never break capture.
      try {
        this.onSnapshot(s);
      } catch (e) {
        print("[Companion] status consumer threw (" + String(e) + ") — capture unaffected");
      }
    }
    if (this.statusText === null || s === null) {
      return;
    }
    let line = "";
    // The PHASE cannot distinguish a real judge-mode client from the
    // unconfigured network-off placeholder (both surface local_only) — the
    // authored judgeLocalOnlyMode flag is the only truth for mode wording.
    const actualJudgeMode = this.judgeLocalOnlyMode;
    if (s.localOnly && actualJudgeMode) {
      line += "LOCAL-ONLY (judge mode — not backend) · ";
    }
    line += "PHASE " + s.phase.toUpperCase();
    if (s.savedBadgeCount > 0) {
      line += " · SAVED " + s.savedBadgeCount; // exact receipts only
    }
    line += "\n" + s.monitorLabel;
    if (s.localOnly && !actualJudgeMode) {
      // PLACEHOLDER (unconfigured, network-off): the client's local_only
      // detail is judge-worded ("judge mode — pairing is not used…") and must
      // NOT be relayed as a real mode claim while pairing is offered. The
      // controller states the actual setup requirement instead — counts,
      // bindings and every other block below stay unchanged.
      line += "\nSETUP REQUIRED — enter HTTPS endpoint + one-time code; local playing not captured/saved";
    } else {
      line += "\n" + s.detail;
    }
    if (
      s.heldNotes > 0 ||
      s.unsynced.notesUnknownDuration > 0 ||
      s.unsynced.overflowDroppedNotes > 0 ||
      s.unsynced.unsentEvents > 0 ||
      s.unsynced.uncapturedHits > 0 ||
      s.unsynced.retiredRefusedEvents > 0 ||
      s.unsynced.captureBlockedReason !== ""
    ) {
      line +=
        "\nheld " +
        s.heldNotes +
        " · unsent " +
        s.unsynced.unsentEvents +
        " · unknown-duration " +
        s.unsynced.notesUnknownDuration +
        (s.unsynced.overflowDroppedNotes > 0 ? " · NOT CAPTURED (queue overflow): " + s.unsynced.overflowDroppedNotes : "") +
        (s.unsynced.uncapturedHits > 0 ? " · NOT CAPTURED (no open session): " + s.unsynced.uncapturedHits : "") +
        (s.unsynced.bufferedHits > 0 ? " · BUFFERED for next take: " + s.unsynced.bufferedHits : "") +
        (s.unsynced.retiredRefusedEvents > 0 ? " · REFUSED (retired): " + s.unsynced.retiredRefusedEvents : "") +
        (s.unsynced.captureBlockedReason !== "" ? "\nCAPTURE BLOCKED: " + s.unsynced.captureBlockedReason : "");
    }
    // LOUD stuck-window block: the user must see that the local monitor still
    // works while some captures were not saved / are not exact.
    if (s.stuckKnown) {
      line += "\nCAPTURE WINDOW " + s.stuckWindowSecsLabel + " (engine stuck-note policy)";
    } else {
      line += "\nCAPTURE WINDOW unknown (backend did not declare it)";
    }
    if (s.notCapturableNotes > 0) {
      line += "\n⚠ NOT CAPTURED: " + s.notCapturableNotes + " long-sample note(s) — retained locally, UNSAVED (local monitor kept playing)";
    }
    if (s.nonFaithfulNotes > 0) {
      line += "\n⚠ TIMING-UNCERTAIN HELD: " + s.nonFaithfulNotes + " note(s) the engine substituted at the window — exact save WITHHELD";
    }
    if (s.unsynced.notesUnknownDuration > 0) {
      line += "\n⚠ UNKNOWN-DURATION notes: " + s.unsynced.notesUnknownDuration + " — commit will honestly refuse until re-recorded";
    }
    if (s.projectNote !== "") {
      line += "\nPROJECT: " + s.projectNote;
    }
    if (this.workflowNote !== "") {
      line += "\nWORKFLOW: " + this.workflowNote;
    }
    if (this.prePairUnsavedHits >= 0) {
      line += "\npre-pair hits: " + this.prePairUnsavedHits + " (never captured — local unsaved, NOT replayed)";
    }
    if (s.playlist.length > 0) {
      line += "\nPLAYLIST:";
      const max = Math.min(s.playlist.length, 4);
      for (let i = 0; i < max; i++) {
        const e = s.playlist[i];
        line += "\n" + (e.savedBadge ? "[SAVED] " : "[       ] ") + e.name + (e.source === "backend_readback" ? " (backend listing)" : "");
      }
      if (s.playlist.length > max) {
        line += "\n… +" + (s.playlist.length - max) + " more";
      }
    }
    this.statusText.text = line;
  }

  private onWillDestroy() {
    // NEVER silently close an uncommitted take on teardown: bare stopCapture
    // refuses when the take holds uncommitted work (the session stays open —
    // the known backend gap that an open take dies with the process is then
    // at least stated, not hidden). Closing is reserved for committed/empty
    // takes; an explicit discard is a user decision, never cleanup.
    if (this.client !== null) {
      void this.client.stopCapture().then((closed: boolean) => {
        if (!closed) {
          print("[Companion] teardown left the capture session open — the take has uncommitted work; commit or explicitly discard to close it");
        }
      });
    }
  }

  private deadlineTimer(): DeadlineTimer {
    const component = this;
    return {
      arm: (seconds: number, onFire: () => void) => {
        const ev = component.createEvent("DelayedCallbackEvent");
        let fired = false;
        const handler = () => {
          if (fired) {
            return;
          }
          fired = true;
          component.removeEvent(ev);
          onFire();
        };
        ev.bind(handler);
        ev.reset(Math.max(0.05, seconds));
        return {
          cancel: () => {
            if (!fired) {
              fired = true;
              component.removeEvent(ev);
            }
          },
        };
      },
    };
  }
}

// Local-only config normalisation (kept outside the class for a clean diff surface).
function cfgWithDefaults(online: boolean) {
  const cfg = {
    onlineMode: online,
    captureBatchMaxEvents: DEFAULT_CONFIG.captureBatchMaxEvents,
    flushIntervalSeconds: DEFAULT_CONFIG.flushIntervalSeconds,
    idlePhraseSeconds: DEFAULT_CONFIG.idlePhraseSeconds,
    autoCommitNotes: DEFAULT_CONFIG.autoCommitNotes,
    commitPollIntervalSeconds: DEFAULT_CONFIG.commitPollIntervalSeconds,
    commitPollMaxTries: DEFAULT_CONFIG.commitPollMaxTries,
    savesRefreshIntervalSeconds: DEFAULT_CONFIG.savesRefreshIntervalSeconds,
    pendingEventQueueMax: DEFAULT_CONFIG.pendingEventQueueMax,
    tokenExpirySafetySeconds: DEFAULT_CONFIG.tokenExpirySafetySeconds,
    // Explicit controller override (see REQUESTED_STUCK_TIMEOUT_SECONDS above):
    // 7.0 s > actual WAV max 5.219887 s, bounded ≤ 10 s ceiling. NOT
    // DEFAULT_CONFIG's 2.0 s, which is shorter than the chord samples and made
    // them honestly fail-closed (retained, unsaved) on every take.
    requestedStuckTimeoutSeconds: Math.min(
      REQUESTED_STUCK_TIMEOUT_SECONDS,
      REQUESTED_STUCK_TIMEOUT_CEILING_SECONDS
    ),
  };
  return cfg;
}

/** Every SceneObject under `panel` named Pad<N>, ordered by N (same rule as the owned bus). */
function collectPadsNamed(panel: SceneObject): SceneObject[] {
  const byIndex: { [index: number]: SceneObject } = {};
  let max = -1;
  for (let i = 0; i < panel.getChildrenCount(); i++) {
    const c = panel.getChild(i);
    const m = /^Pad(\d+)$/.exec(c.name);
    if (m !== null) {
      const idx = parseInt(m[1]);
      byIndex[idx] = c;
      if (idx > max) {
        max = idx;
      }
    }
  }
  const found: SceneObject[] = [];
  for (let i = 0; i <= max; i++) {
    if (byIndex[i] !== undefined) {
      found.push(byIndex[i]);
    }
  }
  return found;
}
