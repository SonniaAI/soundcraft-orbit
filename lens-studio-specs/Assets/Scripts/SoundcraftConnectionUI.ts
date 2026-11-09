// SoundcraftConnectionUI.ts — minimal user-facing pairing/status panel for the
// SoundCraft Lens companion connection. NEW file owned by the connection-UI
// work stream: the controller (SoundcraftCaptureController), the companion
// client/transport/types, and the owned prototype scripts are consumed ONLY
// through their existing public surfaces and are NOT edited by this module.
//
// WHAT THIS PANEL IS:
//  * A big ONE-TOUCH Pair button + a small standard UIKit TextInputField for
//    the server-minted one-time code, plus live phase / unsynced / save-ack
//    status. No recording console, no chat, no instrument buttons — the play
//    -first master controls stay untouched.
//
// WHAT IT CALLS (existing controller APIs ONLY — nothing is invented):
//  * controller.configureEndpointAndPair(endpoint, code) — the ONE pairing
//    path (runtime HTTPS endpoint + one-time code; same-endpoint calls pair
//    in place). Resolves true only when the code was exchanged AND capture
//    actually opened; every refusal resolves false and is surfaced by the
//    controller as a pre-sanitized note (CODE — reason) via onWorkflowNote
//    and its statusText WORKFLOW line.
//  * controller.explicitOpenLastSavedProject() — the guarded operator reopen,
//    ONLY behind this panel's TWO-STEP confirmation (the contract requires
//    the UI to confirm before calling: the action REPLACES the live
//    document). NEVER auto-called — not on pair, not on snapshot.
//  * controller.onWorkflowNote — CHAINED (a pre-existing consumer is kept and
//    invoked first). The sanitized note is mirrored verbatim into this
//    panel's hint row so typed refusal codes + reasons are visible without
//    waiting for the controller's own status render.
//  * controller.statusText — this panel hands the controller its own status
//    Text (public field assignment, typed, no casts). From then on the
//    CONTROLLER writes the truthful multi-line status (phase, monitor label,
//    detail, unsynced ledger, receipt-backed playlist) into this panel's row
//    at its existing 2 Hz refresh.
//  * controller.companionBaseUrl — read ONCE to prefill the endpoint field
//    (runtime memory only, never logged). After the authored-scene value is
//    sanitized to empty, the field simply starts empty and the operator
//    types the endpoint at runtime.
//  * Deliberately NOT called: submitPairingCode("") would stomp the client's
//    phase to awaiting_pair even while paired — so there is NO "Connect /
//    Check" button, and there is NO manual "Retry" button (the client's pump
//    already auto-retries provably-unsent events; no manual retry API exists
//    on the controller). The snapshot adapter (compact line, severity tint,
//    phase-aware auto-collapse) is wired internally in tryWireController().
//  * JUDGE MODE: when controller.judgeLocalOnlyMode is authored on, the
//    endpoint/code/pair/open affordances are NOT offered at all (the
//    controller refuses them by design); the panel shows a truthful
//    local-only note instead.
//
// PAIRING-CODE HYGIENE (hard rules in this file):
//  * The code is NEVER an @input, never stored in a scene asset, never
//    persisted. It is read from the TextInputField at tap time, submitted,
//    and the field is cleared immediately. The only log line uses length-only
//    masking. Bearer tokens are never displayed, accepted, or logged here.
//
// SAVED-BADGE HONESTY:
//  * This panel never renders a "saved" badge itself. The SAVED count shown
//    in the compact line comes from the client's savedBadgeCount, which the
//    client increments ONLY on an exact `saved` receipt; the controller's own
//    status row (which this panel hosts) applies the same rule.

import {SoundcraftCaptureController} from "./SoundcraftCaptureController";
import type {StatusDetail} from "./SoundcraftCompanionClient";
import type {Severity} from "./SoundcraftConnectionStatus";
import {
  compactSummary,
  isPairInputNeeded,
  isPairedLike,
  saveAckSnippet,
  severityForSummary,
} from "./SoundcraftConnectionStatus";
import {SoundcraftBus} from "./SoundcraftBus";
import {SoundcraftPreviewKeyboard} from "./SoundcraftPreviewKeyboard";
import {Interactable} from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import {Button} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/Button";
import {FlexItem} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexItem";
import {FlexLayout} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexLayout";
import {
  FlexAlign,
  FlexAlignSelf,
  FlexDirection,
  FlexJustify,
} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes";
import {Frame} from "SpectaclesUIKit.lspkg/Scripts/Components/Frame/Frame";
import {TextInputField} from "SpectaclesUIKit.lspkg/Scripts/Components/TextInputField/TextInputField";
import {openConfirmDecision, OPEN_CONFIRM_WINDOW_MS} from "./SoundcraftOpenConfirm";

// ── Typography: the single source of truth for text size + weight ───────────
// (canonical scale — see specs-build-ui references/patterns.md → Typography.
// Every row is rendered at the panel's focal distance, passed to roleSize.)
//
// DIAGNOSED 2026-11-08 (live-preview evidence, see QA notes): scaling the
// canonical scale by `distance/110` at the panel's ~66-70 cm placement put
// every row at 0.52-0.56 cm em — BELOW the canonical Caption floor (38 →
// 0.87 cm em is the minimum readable size at the 110 cm calibration plane,
// and every other panel in this scene renders 0.68-1.09 cm em). At 70 cm
// that is ~0.42° of arc — the device view renders it ~15 px tall with thin
// strokes on a dark backplate: unreadable mush. The clamp below keeps the
// canonical sizes for panels at or closer than 110 cm and only GROWS the
// type for panels placed farther away.
const FONT_SIZE_SCALE = 1.0 // 1.0 = SnapOS system-font metrics
const CALIBRATION_CM = 110 // type-scale calibration plane (specs-build-ui canon)

type TextRole =
  | "Title1" | "Title2" | "HeadlineXL" | "Headline1" | "Headline2"
  | "Subheadline" | "Button" | "Callout" | "Body" | "Caption"

const TYPE_SCALE: Record<TextRole, {size: number; weight: number}> = {
  Title1: {size: 105, weight: 700}, Title2: {size: 93, weight: 700},
  HeadlineXL: {size: 62, weight: 700}, Headline1: {size: 54, weight: 700},
  Headline2: {size: 48, weight: 700}, Subheadline: {size: 41, weight: 700},
  Button: {size: 39, weight: 500}, Callout: {size: 39, weight: 700},
  Body: {size: 39, weight: 500}, Caption: {size: 38, weight: 500},
}

/** Font-corrected em-square size for a role at a focal distance (cm).
 * Clamped: the canonical sizes ARE the readability floor at ≤110 cm —
 * closer panels keep them (never shrink), farther panels scale up. */
function roleSize(role: TextRole, distanceCm: number): number {
  const factor = Math.max(distanceCm, CALIBRATION_CM) / CALIBRATION_CM
  return TYPE_SCALE[role].size * FONT_SIZE_SCALE * factor
}

/** Apply a type-scale role to a Text — the ONE place size + weight are set. */
function applyTextRole(t: Text, role: TextRole, distanceCm: number): void {
  t.size = roleSize(role, distanceCm)
  t.weight = TYPE_SCALE[role].weight
}

// ── geometry constants (tunables live in @input s below) ────────────────────
const CONTENT_Z_LIFT = 0.6 // content forward of the Frame surface (z-fight rule)
const LAYOUT_Z_LIFT = 0.02 // nested flex containers
const BUTTON_LABEL_Z = 0.08 // label on a Button face (leading-glyph occlusion fix)
const PAD = 1.4 // panel padding
const ROW_GAP = 0.6
const HEADER_H = 3.4 // fits the Headline2 title + the 2.8 cm toggle
const COMPACT_H = 2.4 // Body-size compact line
const HINT_H = 2.6 // Caption-size hint (two wrapped lines + slack)
const FOOTER_H = 2.0 // Caption-size hygiene footer
const TOGGLE_BTN_W = 3.0
const TOGGLE_BTN_H = 2.8
const STATUS_TINT = new vec4(0.92, 0.92, 0.96, 1)
const SECONDARY_TINT = new vec4(1, 1, 1, 0.75) // strong-secondary opacity tier

// Fit minimums — the readable type scale needs these row heights; @input
// defaults alone cannot guarantee it because ALREADY-AUTHORED scene
// components keep their serialized values when script defaults change
// (scene re-authoring is a separate, explicit step). Values above the
// minimum still win — this only guarantees the panel never overflows.
// Stack budget (endpoint+code combined row): header 3.4 + compact 2.4 +
// inputs 3.0 + pair 4.2 + open 3.6 + hint 2.6 + status 6.0 + footer 2.0
// = 27.4 + 7 gaps × 0.6 = 4.2 + padding 2.8 → 34.4 → 34 kept as the
// readable-fit floor so the translucent Frame backplate stays clear of the
// chord panel's title row below (measured plate ≈ innerSize + ~9.7 cm).
const EXPANDED_MIN_H = 34.2 // full workflow stack (rows 27.2 + 7×0.6 gaps + 2.8 padding)
const COLLAPSED_MIN_H = 10 // header + compact + gap + padding
const INPUT_ROW_MIN_H = 3.0 // endpoint + code combined row
const PAIR_ROW_MIN_H = 4.2
const OPEN_ROW_MIN_H = 3.6 // secondary operator action (still hand-friendly)
const STATUS_ROW_MIN_H = 6.0 // ~4 wrapped Caption lines + slack
// Reopen confirmation timings live in SoundcraftOpenConfirm.ts (pure helper:
// 8 s arm window + 300 ms minimum separation; duplicates never advance).
// Preview on-screen keyboard: replaces the workflow rows while a field is
// being edited (the AR keyboard does not appear in the SPECS 27 preview).
const KEYBOARD_ROW_H = 12.0
const EDITING_INNER_H = 28.6 // header + compact + inputs + hint + keyboard + gaps + padding

@component
export class SoundcraftConnectionUI extends BaseScriptComponent {
  // ---- required wiring -------------------------------------------------------
  @input
  @label("Capture Controller")
  @hint("The SoundcraftCaptureController ScriptComponent. Pair calls its existing submitPairingCode(); this panel hands the controller its status Text. No other controller API is used.")
  controller: SoundcraftCaptureController = null

  // ---- layout ----------------------------------------------------------------
  @ui.separator
  @ui.label("Layout")
  @ui.group_start("Panel")
  @input
  @label("Panel Width (cm)")
  @hint("Full panel width. Content = width − 2 × 1.4 cm padding.")
  @widget(new SliderWidget(20, 44, 1))
  panelWidth: number = 30

  @input
  @label("Expanded Height (cm)")
  @hint("Frame height with the endpoint/code entry + pair + open rows visible. Values below the readable-fit minimum (34) are raised to it.")
  @widget(new SliderWidget(16, 44, 0.5))
  expandedHeight: number = EXPANDED_MIN_H

  @input
  @label("Collapsed Height (cm)")
  @hint("Small near-playlist status after pairing: header + compact line only. Values below the fit minimum (10) are raised to it.")
  @widget(new SliderWidget(6, 16, 0.5))
  collapsedHeight: number = COLLAPSED_MIN_H

  @input
  @label("Type Calibration Distance (cm)")
  @hint("Panel placement depth used to scale the type roles. At or closer than 110 cm the canonical scale holds (readability floor); farther panels scale type up. Default matches this panel's scene placement (~70 cm).")
  @widget(new SliderWidget(40, 110, 1))
  focalDistanceCm: number = 70

  @input
  @label("Status Row Height (cm)")
  @hint("Multi-line controller status row (phase · monitor · unsynced · playlist). ~1.05 cm per line at the canonical Caption size.")
  @widget(new SliderWidget(4, 14, 0.5))
  statusLineHeight: number = 7.0

  @input
  @label("Input Row Height (cm)")
  @hint("TextInputField height. Values below the hand-friendly minimum (3.0) are raised to it.")
  @widget(new SliderWidget(2, 4, 0.1))
  inputRowHeight: number = INPUT_ROW_MIN_H

  @input
  @label("Pair Row Height (cm)")
  @hint("One-touch Pair button height. Values below the hand-friendly minimum (4.2) are raised to it.")
  @widget(new SliderWidget(2.4, 6, 0.1))
  pairRowHeight: number = PAIR_ROW_MIN_H
  @ui.group_end

  // ---- labels ----------------------------------------------------------------
  @ui.separator
  @ui.label("Labels")
  @ui.group_start("Text")
  @input
  @label("Title")
  @hint("Panel header text.")
  titleText: string = "COMPANION LINK"

  @input
  @label("Pair Button Label")
  @hint("The big one-touch action. Calls configureEndpointAndPair(endpoint, code) — the controller's runtime workflow API.")
  pairButtonLabel: string = "PAIR — LINK COMPANION"

  @input
  @label("Endpoint Placeholder")
  @hint("Endpoint TextInputField placeholder (URL keyboard). The endpoint may be typed at runtime; the authored scene value stays sanitized/empty.")
  endpointPlaceholder: string = "companion endpoint (https://…)"

  @input
  @label("Open Button Label")
  @hint("The guarded operator reopen (explicitOpenLastSavedProject). FIRST tap arms it; ONLY the second tap calls the controller.")
  openButtonLabel: string = "OPEN LAST SAVE"

  @input
  @label("Open Armed Label")
  @hint("Shown after the first tap, until the second tap fires or the 8 s window expires.")
  openArmedLabel: string = "TAP AGAIN — REPLACES LIVE DOC"

  @input
  @label("Code Placeholder")
  @hint("TextInputField placeholder. The code itself is typed at runtime and is never an input.")
  codePlaceholder: string = "one-time pairing code…"

  @input
  @label("Idle Compact Line")
  @hint("Compact-line text before any status feed arrives. Must not claim a connection state — the controller's status row carries the truth.")
  idleCompactText: string = "WAITING · tap ▸ for details"

  @input
  @label("Empty-Code Hint")
  @hint("Shown when Pair is tapped with an empty field. The code comes from the operator for this session — never authored in the scene.")
  emptyCodeHint: string = "enter the one-time code for this session, then tap PAIR"

  @input
  @label("Submitted Hint")
  @hint("Shown right after a submit. States local facts only — the outcome arrives via the controller's status row.")
  submittedHint: string = "pairing… code cleared (memory only) — outcome shows in the status line"

  @input
  @label("Missing Endpoint Hint")
  @hint("Shown when Pair is tapped with an empty endpoint field.")
  missingEndpointHint: string = "enter the companion endpoint (https://…), then tap PAIR"

  @input
  @label("Busy Hint")
  @hint("Shown while a workflow call is already in flight (the controller runs one at a time).")
  busyHint: string = "working… one action at a time"

  @input
  @label("Open Armed Hint")
  @hint("Shown while the reopen action is armed (first tap of two).")
  openArmedHint: string = "⚠ second tap opens the last saved project — the live document is REPLACED (data-preserving refusals still apply)"

  @input
  @label("Open Expired Hint")
  @hint("Shown when the armed window lapses without a second tap.")
  openExpiredHint: string = "open-confirmation expired — nothing was opened"

  @input
  @label("Judge Mode Note")
  @hint("Shown instead of the workflow affordances when controller.judgeLocalOnlyMode is authored on (the controller refuses them by design).")
  judgeNoteText: string = "JUDGE LOCAL-ONLY MODE — local capture only; no backend actions offered"

  @input
  @label("Editing Hint")
  @hint("Shown while the on-screen keyboard is open (preview only).")
  editingHint: string = "on-screen keyboard — tap DONE when finished"

  @input
  @label("Empty Endpoint Hint")
  @hint("Shown when the pad opens on an EMPTY endpoint field: the scheme button comes first, then the host.")
  endpointEmptyHint: string = "endpoint empty — tap https:// first, then type the host"

  @input
  @label("Footer Note")
  @hint("Static hygiene note under the pair row.")
  footerNote: string = "code: used once · cleared after use · never stored or logged"
  @ui.group_end

  // ---- severity colors ---------------------------------------------------------
  @ui.separator
  @ui.label("Severity Colors")
  @ui.group_start("Colors")
  @input
  @label("OK")
  @hint("paired / capturing when CLEAN — escalates to warn the moment any hit/note/event loss or unknown-duration note exists.")
  @widget(new ColorWidget())
  colorOk: vec4 = new vec4(0.45, 0.9, 0.55, 1)

  @input
  @label("Info")
  @hint("connecting / commit_pending.")
  @widget(new ColorWidget())
  colorInfo: vec4 = new vec4(0.45, 0.7, 0.95, 1)

  @input
  @label("Warn")
  @hint("awaiting_pair / commit_unknown / token_expired — and ANY phase with MISSED HITS, DROPPED NOTES, RETIRED EVENTS, unknown-duration notes, LONG NOTES NOT CAPTURED, TIMING UNCERTAIN (save withheld), or a WINDOW UNKNOWN stuck window.")
  @widget(new ColorWidget())
  colorWarn: vec4 = new vec4(1.0, 0.8, 0.45, 1)

  @input
  @label("Error")
  @hint("config_error / offline / commit_failed / backend_down.")
  @widget(new ColorWidget())
  colorError: vec4 = new vec4(0.9, 0.45, 0.45, 1)

  @input
  @label("Neutral")
  @hint("local_only (judge mode) / unknown phases.")
  @widget(new ColorWidget())
  colorNeutral: vec4 = new vec4(1, 1, 1, 0.75)
  @ui.group_end

  // ---- built UI handles (never destroyed while the panel lives) ---------------
  private frame: Frame = null
  private colFlex: FlexLayout = null
  private codeField: TextInputField = null
  private endpointField: TextInputField = null
  private openLabel: Text = null
  private fullStatusText: Text = null // controller writes here (assigned in OnStart)
  private compactText: Text = null
  private hintText: Text = null
  private toggleLabel: Text = null
  private expandedRows: SceneObject[] = []
  private expandedItems: FlexItem[] = []
  private judgeMode = false // authored controller.judgeLocalOnlyMode — workflow affordances withheld
  // Preview on-screen keyboard state (this.keyboardRow hosts the pad; the
  // workflow rows swap out for it while a field is being edited).
  private kb: SoundcraftPreviewKeyboard = null
  private keyboardRow: SceneObject = null
  private keyboardItem: FlexItem = null
  private editingField: "endpoint" | "code" | null = null
  private editHideRows: SceneObject[] = []
  private editHideItems: FlexItem[] = []
  // Preview-only deferred NATIVE exit: the UIKit field invokes onEditMode(true)
  // BEFORE isEditing=true/requestKeyboard (BaseTextInputComponent.editMode),
  // so a synchronous editMode(false) inside the event is an SDK line-611
  // no-op. The dismiss is scheduled for the NEXT frame via ONE reusable
  // DelayedCallbackEvent; a stale firing no-ops on the consumed pointer.
  private kbExitDelayed: DelayedCallbackEvent = null
  private kbExitPendingField: "endpoint" | "code" | null = null
  private destroyed = false
  // Field-tap wiring is DEFERRED: the UIKit TextInputField creates its SIK
  // Interactable during its own (later) initialization, so at build time the
  // component does not exist yet. A per-frame retry attaches as soon as it
  // appears (bounded at ~10 s; both fields succeed on the current boots).
  private fieldTapPending: { field: "endpoint" | "code"; tf: TextInputField; done: boolean }[] = []

  // ---- state -------------------------------------------------------------------
  private built = false
  private expanded = true
  private userWantsExpanded: boolean | null = null // manual override wins until phase family changes back
  private codeStash = "" // in-memory only; survives collapse/expand, cleared on submit
  private workflowBusy = false // mirrors the controller's one-workflow rule (UI-side, no queueing)
  private openArmedAtMs: number | null = null // arm timestamp of the reopen confirmation; null = idle

  // ---- effective geometry (authored @inputs raised to the fit minimums) ---------
  private get effExpandedHeight(): number {
    return Math.max(this.expandedHeight, EXPANDED_MIN_H)
  }
  private get effCollapsedHeight(): number {
    return Math.max(this.collapsedHeight, COLLAPSED_MIN_H)
  }
  private get effInputRowHeight(): number {
    return Math.max(this.inputRowHeight, INPUT_ROW_MIN_H)
  }
  private get effPairRowHeight(): number {
    return Math.max(this.pairRowHeight, PAIR_ROW_MIN_H)
  }
  private get effStatusLineHeight(): number {
    return Math.max(this.statusLineHeight, STATUS_ROW_MIN_H)
  }

  // ---- editor/device gating -------------------------------------------------------
  /** The on-screen pad + editing layout are PREVIEW-ONLY: on hardware the
   * native TextInputField + AR keyboard own entry, and none of the fallback
   * UI is created (no Bus flag, no row swap, no physical-key listener). */
  private get isEditorPreview(): boolean {
    return global.deviceInfoSystem.isEditor()
  }

  // ---- controller wiring state (single-shot, race-safe) -------------------------
  private controllerReady = false // OnStart ran with a live controller @input
  private wired = false // exactly-once guard for the statusText/onSnapshot hookup
  private snapshotCb: ((s: StatusDetail) => void) | null = null // our hook's identity — the unsubscribe check
  private supersededOnSnapshot: ((s: StatusDetail) => void) | null = null // pre-existing consumer, chained (never dropped)
  private workflowNoteCb: ((note: string) => void) | null = null // our onWorkflowNote identity
  private supersededOnWorkflowNote: ((note: string) => void) | null = null // pre-existing consumer, chained (never dropped)

  onAwake() {
    // Canvas at the root — defaults to SortingType.Hierarchy: the DFS over this
    // subtree IS the render order. No renderOrder is set anywhere below.
    this.sceneObject.createComponent("Component.Canvas")

    this.kbExitDelayed = this.createEvent("DelayedCallbackEvent") as DelayedCallbackEvent
    this.kbExitDelayed.bind(() => this.deferredNativeExit())

    const frame = this.sceneObject.createComponent(Frame.getTypeName()) as Frame
    frame.autoShowHide = false
    frame.autoScaleContent = false
    frame.allowScaling = false
    this.frame = frame

    this.createEvent("UpdateEvent").bind(() => {
      this.tryAttachFieldTaps()
      this.tickOpenArmExpiry()
    })

    // Frame initializes in OnStartEvent — innerSize / contentTransform are
    // unsafe before onInitialized fires (gotcha G1/G3). The panel starts
    // VISIBLE and EXPANDED (the user must see it before any connection), so
    // there is no hidden-start disable anywhere in this component.
    frame.onInitialized.add(() => {
      frame.innerSize = new vec2(this.panelWidth, this.effExpandedHeight)
      frame.padding = new vec2(PAD, PAD)
      this.buildContent(frame.contentTransform.getSceneObject())
      // Frame init is ASYNC relative to OnStart — OnStart may already have run
      // (controllerReady set, status row still null). This is the later of the
      // two race sides: wiring completes here if OnStart won the race.
      this.tryWireController()
    })

    this.createEvent("OnStartEvent").bind(() => this.onStart())
    this.createEvent("OnDestroyEvent").bind(() => this.onWillDestroy())
  }

  private onStart() {
    if (this.controller === null || this.controller === undefined) {
      console.error("[ConnectionUI] controller @input is not wired — Pair will be a no-op and no status row is hosted")
      return
    }
    this.controllerReady = true
    // Frame.onInitialized may NOT have fired yet (async init race) — the status
    // row Text can still be null here. Never wire against a stale null: the
    // hookup completes in tryWireController() once buildContent has run too.
    this.tryWireController()
  }

  /**
   * The ONE controller hookup, run exactly once after BOTH async sides are
   * ready: OnStart (controller @input resolved) AND Frame.onInitialized →
   * buildContent (the status row Text exists). Either side may land first —
   * nothing is written until both hold, so no stale-null skip and no
   * double-subscribe (idempotent via the `wired` guard).
   */
  private tryWireController() {
    if (
      this.wired ||
      !this.controllerReady ||
      this.controller === null ||
      this.controller === undefined ||
      this.fullStatusText === null
    ) {
      return
    }
    this.wired = true

    // The controller renders its truthful multi-line status (phase, monitor
    // label, unsynced ledger, receipt-only playlist) into its public statusText
    // at its existing cadence. Any status Text wired by the operator elsewhere
    // is superseded — logged.
    this.controller.statusText = this.fullStatusText
    console.log("[ConnectionUI] controller.statusText now points at the connection panel status row (any other wired status Text is superseded)")

    // The ONE snapshot hook: controller → compact line / severity tint /
    // phase-aware auto-collapse. A pre-existing consumer is NEVER silently
    // overwritten — it is chained first, with its errors contained so a
    // foreign consumer cannot break this panel's feed.
    const existing = this.controller.onSnapshot
    this.supersededOnSnapshot = existing !== null && existing !== undefined ? existing : null
    this.snapshotCb = (s: StatusDetail) => {
      if (this.supersededOnSnapshot !== null) {
        try {
          this.supersededOnSnapshot(s)
        } catch (e) {
          console.error("[ConnectionUI] chained onSnapshot consumer threw (" + String(e) + ") — panel status unaffected")
        }
      }
      this.applyStatus(s)
    }
    this.controller.onSnapshot = this.snapshotCb
    console.log(
      "[ConnectionUI] controller.onSnapshot wired → applyStatus (compact line, severity tint, phase-aware auto-collapse)" +
        (this.supersededOnSnapshot !== null ? " — pre-existing consumer preserved, chained first" : "")
    )

    // Workflow notes: chained exactly like onSnapshot. The controller's note is
    // ALREADY sanitized (URLs stripped, credential-shaped content withheld,
    // length-capped) — it is mirrored VERBATIM into the hint row so typed
    // refusal codes (JUDGE_MODE / NOT_CONFIGURED / INVALID_ENDPOINT /
    // DATA_PRESENT / …) and reasons are visible immediately, not just in the
    // controller's next status render.
    const existingNote = this.controller.onWorkflowNote
    this.supersededOnWorkflowNote = existingNote !== null && existingNote !== undefined ? existingNote : null
    this.workflowNoteCb = (note: string) => {
      if (this.supersededOnWorkflowNote !== null) {
        try {
          this.supersededOnWorkflowNote(note)
        } catch (e) {
          console.error("[ConnectionUI] chained onWorkflowNote consumer threw (" + String(e) + ") — panel unaffected")
        }
      }
      this.setHint(note)
    }
    this.controller.onWorkflowNote = this.workflowNoteCb
    console.log(
      "[ConnectionUI] controller.onWorkflowNote wired → hint row (verbatim sanitized refusal text)" +
        (this.supersededOnWorkflowNote !== null ? " — pre-existing consumer preserved, chained first" : "")
    )

    // Endpoint prefill from the authored/runtime controller value — read once,
    // runtime memory only, never logged. After scene sanitization this is
    // empty and the operator types the endpoint at runtime.
    if (this.endpointField !== null) {
      const authored = this.controller.companionBaseUrl
      const current = this.endpointField.text
      if (authored !== null && authored !== undefined && authored.length > 0 && (current === null || current === undefined || current.length === 0)) {
        this.endpointField.text = authored
        console.log("[ConnectionUI] endpoint field prefilled from controller.companionBaseUrl (runtime memory only, not logged)")
      }
    }
  }

  private onWillDestroy() {
    // P3 stuck-flag cleanup FIRST: plain state writes only — the panel is
    // being destroyed, so NO native UI/layout calls happen here. A pending
    // next-frame native-exit becomes a no-op (the guard sees destroyed).
    this.destroyed = true
    this.kbExitPendingField = null
    this.editingField = null
    SoundcraftBus.textEntryActive = false
    // Lifetime unsubscribe: clear the hooks ONLY if they are still ours (a
    // consumer wired after us by someone else is never nulled). Prevents a
    // dangling applyStatus/note feed into destroyed Text rows and duplicate
    // feeds if the panel is ever re-created in the same session.
    if (
      this.controller !== null &&
      this.controller !== undefined &&
      this.snapshotCb !== null &&
      this.controller.onSnapshot === this.snapshotCb
    ) {
      this.controller.onSnapshot = null
      console.log("[ConnectionUI] controller.onSnapshot unsubscribed (panel destroyed)")
    }
    if (
      this.controller !== null &&
      this.controller !== undefined &&
      this.workflowNoteCb !== null &&
      this.controller.onWorkflowNote === this.workflowNoteCb
    ) {
      this.controller.onWorkflowNote = null
      console.log("[ConnectionUI] controller.onWorkflowNote unsubscribed (panel destroyed)")
    }
    this.snapshotCb = null
    this.supersededOnSnapshot = null
    this.workflowNoteCb = null
    this.supersededOnWorkflowNote = null
  }

  // ---- build -------------------------------------------------------------------

  private buildContent(host: SceneObject) {
    // Judge mode is an authored controller flag — readable at build time. The
    // workflow affordances are WITHHELD in judge mode (contract: the UI must
    // not offer what the controller refuses by design).
    this.judgeMode =
      this.controller !== null &&
      this.controller !== undefined &&
      this.controller.judgeLocalOnlyMode === true

    const content = global.scene.createSceneObject("Content")
    content.setParent(host)
    content.getTransform().setLocalPosition(new vec3(0, 0, CONTENT_Z_LIFT))

    const col = content.createComponent(FlexLayout.getTypeName()) as FlexLayout
    // UIKit contract (FlexLayout.addItems): explicit addItems/removeItems THROW
    // while autoDiscoverItemsOnStart (the default) is on and the layout has not
    // run its own OnStart yet. buildContent runs inside Frame.onInitialized —
    // BEFORE the content layouts' OnStart — so discovery-based layouts would
    // make every flexChild registration throw and abort the whole build.
    // This panel's ownership model is the explicit flexChild registration
    // (single source, re-used by collapse/expand), so discovery is disabled
    // here and the items are managed solely via addItems/removeItems.
    col.autoDiscoverItemsOnStart = false
    col.width = this.panelWidth
    col.height = -1 // auto — rows + gaps decide, Frame innerSize is set per state
    col.direction = FlexDirection.Column
    col.alignItems = FlexAlign.Stretch
    col.justifyContent = FlexJustify.Start
    col.rowGap = ROW_GAP
    col.paddingTop = PAD
    col.paddingBottom = PAD
    col.paddingLeft = PAD
    col.paddingRight = PAD
    this.colFlex = col

    const innerW = this.panelWidth - PAD * 2

    // NOTE: flexChild() itself registers each child with the parent FlexLayout
    // via addItems — that registration is the mandatory one. We only keep the
    // returned FlexItems here; addItems is NEVER called a second time.

    // 1 · header: title + collapse toggle (always visible)
    this.flexChild(content, {w: innerW, h: HEADER_H}, (row) => {
      const rowFlex = row.createComponent(FlexLayout.getTypeName()) as FlexLayout
      // same autoDiscoverItemsOnStart=false contract as the column above —
      // this nested row is also built (and its children registered) before
      // any OnStart, so explicit registration must be the ownership model.
      rowFlex.autoDiscoverItemsOnStart = false
      rowFlex.width = innerW
      rowFlex.height = HEADER_H
      rowFlex.direction = FlexDirection.Row
      rowFlex.alignItems = FlexAlign.Center
      rowFlex.justifyContent = FlexJustify.SpaceBetween
      rowFlex.columnGap = 0.6

      // Row-direction text needs a REAL rect sized for the longest string.
      const titleW = Math.max(8, this.titleText.length * 0.62 + 2)
      this.flexChild(row, {w: titleW, h: 2.6}, (titleHost) => {
        const t = titleHost.createComponent("Component.Text") as Text
        t.text = this.titleText
        t.depthTest = true
        applyTextRole(t, "Headline2", this.focalDistanceCm)
        t.horizontalAlignment = HorizontalAlignment.Left
        t.verticalAlignment = VerticalAlignment.Center
        t.horizontalOverflow = HorizontalOverflow.Overflow
        t.verticalOverflow = VerticalOverflow.Overflow
        t.layoutRect = Rect.create(-titleW / 2, titleW / 2, -1.3, 1.3)
      })

      this.flexChild(row, {w: TOGGLE_BTN_W, h: TOGGLE_BTN_H}, (btnHost) => {
        const toggle = btnHost.createComponent(Button.getTypeName()) as Button
        toggle.size = new vec3(TOGGLE_BTN_W, TOGGLE_BTN_H, 1)
        this.toggleLabel = this.addButtonLabel(btnHost, "▾", TOGGLE_BTN_W - 0.5)
        toggle.onTriggerUp.add(() => this.toggleExpanded())
      })
    })

    // 2 · compact status line (always visible — informative once the adapter
    // feeds applyStatus(); honest local placeholder before that)
    this.flexChild(content, {w: innerW, h: COMPACT_H}, (c) => {
      this.compactText = this.makeText(c, this.idleCompactText, "Body", innerW, COMPACT_H, SECONDARY_TINT, HorizontalOverflow.Overflow)
      this.compactText.textFill.color = this.colorNeutral
    })

    // 3 · endpoint + one-time code inputs (collapsible) — two standard UIKit
    // TextInputFields side by side (URL keyboard for the endpoint). The pair
    // affordances sit ABOVE the verbose controller detail block: the compact
    // line + these rows are the whole pre-pair flow. JUDGE MODE: both fields
    // and every workflow button are withheld (the controller refuses them by
    // design); a truthful local-only note takes the row's place.
    const halfW = (innerW - 0.6) / 2
    let inputsRow: SceneObject = null
    let pairRow: SceneObject = null
    let openRow: SceneObject = null
    let judgeRow: SceneObject = null
    if (this.judgeMode) {
      judgeRow = this.flexChild(content, {w: innerW, h: HINT_H}, (c) => {
        this.makeText(c, this.judgeNoteText, "Caption", innerW, HINT_H, SECONDARY_TINT, HorizontalOverflow.Wrap)
      })
    } else {
      inputsRow = this.flexChild(content, {w: innerW, h: this.effInputRowHeight}, (row) => {
        const rowFlex = row.createComponent(FlexLayout.getTypeName()) as FlexLayout
        rowFlex.autoDiscoverItemsOnStart = false
        rowFlex.width = innerW
        rowFlex.height = this.effInputRowHeight
        rowFlex.direction = FlexDirection.Row
        rowFlex.alignItems = FlexAlign.Center
        rowFlex.justifyContent = FlexJustify.Start
        rowFlex.columnGap = 0.6

        this.flexChild(row, {w: halfW, h: this.effInputRowHeight}, (c) => {
          const tf = c.createComponent(TextInputField.getTypeName()) as TextInputField
          tf.size = new vec3(halfW, this.effInputRowHeight, 1)
          tf.fontSize = roleSize("Body", this.focalDistanceCm)
          tf.placeholderText = this.endpointPlaceholder
          tf.actionSlot = "none"
          tf.inputType = "url" // URL system keyboard for the endpoint
          this.endpointField = tf
        })

        this.flexChild(row, {w: halfW, h: this.effInputRowHeight}, (c) => {
          const tf = c.createComponent(TextInputField.getTypeName()) as TextInputField
          tf.size = new vec3(halfW, this.effInputRowHeight, 1)
          tf.fontSize = roleSize("Body", this.focalDistanceCm)
          tf.placeholderText = this.codePlaceholder
          tf.actionSlot = "none" // no voice slot on a credential field
          tf.inputType = "default"
          this.codeField = tf
        })
      })
    }

    // 4 · big one-touch Pair button (collapsible) — configureEndpointAndPair
    if (!this.judgeMode) {
      pairRow = this.flexChild(content, {w: innerW, h: this.effPairRowHeight}, (c) => {
        const btn = c.createComponent(Button.getTypeName()) as Button
        btn.size = new vec3(innerW, this.effPairRowHeight, 1)
        this.addButtonLabel(c, this.pairButtonLabel, innerW - 0.5, "Headline2")
        btn.onTriggerUp.add(() => this.onPairTapped())
      })
    }

    // 4b · guarded operator reopen (collapsible) — TWO-STEP confirmation: the
    // first tap only ARMS (label flips, hint warns); ONLY the second tap
    // within the window calls explicitOpenLastSavedProject(). Never
    // auto-called anywhere in this file.
    if (!this.judgeMode) {
      openRow = this.flexChild(content, {w: innerW, h: OPEN_ROW_MIN_H}, (c) => {
        const btn = c.createComponent(Button.getTypeName()) as Button
        btn.size = new vec3(innerW, OPEN_ROW_MIN_H, 1)
        this.openLabel = this.addButtonLabel(c, this.openButtonLabel, innerW - 0.5, "Headline2")
        btn.onTriggerUp.add(() => this.onOpenTapped())
      })
    }

    // 5 · dynamic tap-feedback / workflow-refusal hint (collapsible)
    const hintRow = this.flexChild(content, {w: innerW, h: HINT_H}, (c) => {
      this.hintText = this.makeText(c, "", "Caption", innerW, HINT_H, SECONDARY_TINT, HorizontalOverflow.Wrap)
    })

    // 6 · full controller-driven status row (collapsible details). The
    // controller writes its truthful multi-line status here at its own 2 Hz;
    // the compact line above is the drastically-shortened always-visible
    // summary (unsaved counts / capture-window errors included), and this
    // row keeps the full truth one toggle away.
    const statusRow = this.flexChild(content, {w: innerW, h: this.effStatusLineHeight}, (c) => {
      this.fullStatusText = this.makeText(c, "", "Caption", innerW, this.effStatusLineHeight, STATUS_TINT, HorizontalOverflow.Wrap)
    })

    // 7 · static hygiene footer (collapsible)
    const footerRow = this.flexChild(content, {w: innerW, h: FOOTER_H}, (c) => {
      this.makeText(c, this.footerNote, "Caption", innerW, FOOTER_H, SECONDARY_TINT, HorizontalOverflow.Wrap)
    })

    // 8 · PREVIEW-ONLY on-screen keyboard (hidden unless a field is selected).
    // Created ONLY in the editor preview — on hardware the native
    // TextInputField + AR keyboard own entry and none of this exists.
    // While editing it REPLACES the workflow rows (pair/open/status/footer)
    // instead of growing the panel past the readable FOV budget.
    if (!this.judgeMode && this.isEditorPreview) {
      this.keyboardRow = this.flexChild(content, {w: innerW, h: KEYBOARD_ROW_H}, (c) => {
        this.kb = c.createComponent(SoundcraftPreviewKeyboard.getTypeName()) as SoundcraftPreviewKeyboard
        this.kb.configure(innerW, this.focalDistanceCm)
        this.kb.onTextChanged.add((text: string) => {
          if (this.editingField === "endpoint" && this.endpointField !== null) {
            this.endpointField.text = text
          } else if (this.editingField === "code" && this.codeField !== null) {
            this.codeField.text = text
          }
        })
        this.kb.onDone.add(() => {
          this.closeKeyboard()
          this.setHint("entry closed — the fields keep their text")
        })
      })
      this.keyboardItem = this.itemOf(this.keyboardRow)
      // The pad starts unregistered: flexChild registered it for the build,
      // so it is removed again immediately (same ownership model as collapse).
      this.colFlex.removeItems([this.keyboardItem])
      this.keyboardRow.enabled = false
      // Field selection opens the pad. PRIMARY: the field component's own
      // onEditMode signal (exists at build time, fires on tap in preview).
      // SECONDARY (deferred): the SIK Interactable appears on the field
      // object lazily, so its trigger is attached per-frame once present.
      if (this.endpointField !== null) {
        this.endpointField.onEditMode.add((editing: boolean) => {
          if (editing) {
            this.openKeyboardFor("endpoint")
            this.scheduleNativeExit("endpoint")
          }
        })
        this.fieldTapPending.push({ field: "endpoint", tf: this.endpointField, done: false })
      }
      if (this.codeField !== null) {
        this.codeField.onEditMode.add((editing: boolean) => {
          if (editing) {
            this.openKeyboardFor("code")
            this.scheduleNativeExit("code")
          }
        })
        this.fieldTapPending.push({ field: "code", tf: this.codeField, done: false })
      }
    }

    // Collapsible rows keep their FlexItems (already registered by flexChild);
    // collapse = removeItems + disable, expand = addItems + enable — the item
    // count change is what triggers FlexLayout re-discovery. No row is ever
    // destroyed, so the controller's status Text handle stays valid forever.
    const collapsible = [judgeRow, inputsRow, pairRow, openRow, statusRow, hintRow, footerRow]
    this.expandedRows = collapsible.filter((row) => row !== null && row !== undefined)
    this.expandedItems = this.expandedRows.map((child) => this.itemOf(child))
    // Rows the EDITING state swaps out for the keyboard (workflow rows only —
    // header/compact/inputs/hint stay visible while typing).
    const editHide = [statusRow, pairRow, openRow, footerRow]
    this.editHideRows = editHide.filter((row) => row !== null && row !== undefined)
    this.editHideItems = this.editHideRows.map((child) => this.itemOf(child))
    this.built = true
  }

  /** Field selection (pinch/tap on a TextInputField) opens the pad for that
   * field. DEFERRED attach: the UIKit field's SIK Interactable does not exist
   * at build time, so a per-frame retry (bounded ~10 s) attaches the trigger
   * the moment the component appears. The field keeps its native behavior on
   * hardware — the pad is an additional preview entry surface. */
  private tryAttachFieldTaps() {
    if (this.fieldTapPending.length === 0) {
      return
    }
    let remaining: typeof this.fieldTapPending = []
    for (const entry of this.fieldTapPending) {
      if (entry.done || entry.tf === null || entry.tf === undefined) {
        continue
      }
      let inter: Interactable | null = null
      try {
        inter = entry.tf.getSceneObject().getComponent(Interactable.getTypeName()) as unknown as Interactable
      } catch (e) {
        inter = null
      }
      if (inter === null || inter === undefined) {
        remaining.push(entry)
        continue
      }
      entry.done = true
      inter.onTriggerEnd.add(() => this.openKeyboardFor(entry.field))
    }
    this.fieldTapPending = remaining
  }

  /** Open the pad for a field: swap the workflow rows out (they reappear on
   * Done/Pair/collapse) and shrink the frame to the editing stack. Flags the
   * bus so physical keystrokes stop driving the mini-DAW shortcuts.
   * DEFENSE-IN-DEPTH: preview-only — this is unreachable on hardware (the
   * affordances that call it are not created there). */
  private openKeyboardFor(field: "endpoint" | "code") {
    if (!this.isEditorPreview || !this.built || this.kb === null || this.keyboardItem === null) {
      return
    }
    if (this.editingField === field) {
      return // already editing this field (debounce for repeated triggers)
    }
    this.closeKeyboard()
    this.editingField = field
    const initial = field === "endpoint" ? this.endpointField.text : this.codeField.text
    this.kb.show(field, typeof initial === "string" ? initial : "")
    SoundcraftBus.textEntryActive = true
    this.disarmOpen()
    this.colFlex.removeItems(this.editHideItems)
    for (const row of this.editHideRows) {
      row.enabled = false
    }
    this.colFlex.addItems([this.keyboardItem])
    this.keyboardRow.enabled = true
    this.frame.innerSize = new vec2(this.panelWidth, EDITING_INNER_H)
    if (field === "endpoint" && (initial === null || initial === undefined || initial.length === 0)) {
      // EMPTY-ONLY scheme rule, made visible: the https:// button comes first.
      this.setHint(this.endpointEmptyHint)
    } else {
      this.setHint(this.editingHint)
    }
  }

  /** Schedule the PREVIEW-ONLY native edit-mode exit for the NEXT frame.
   * The UIKit field invokes onEditMode(true) BEFORE isEditing=true and
   * requestKeyboard (BaseTextInputComponent.editMode), so a synchronous
   * editMode(false) inside the event is an SDK line-611 early-return no-op.
   * One reusable DelayedCallbackEvent; overwriting the pending field pointer
   * on a field change IS the cancellation (a stale firing consumes it and
   * no-ops). Editor-only: never scheduled on hardware. */
  private scheduleNativeExit(field: "endpoint" | "code") {
    if (!this.isEditorPreview) {
      return
    }
    this.kbExitPendingField = field
    if (this.kbExitDelayed !== null && this.kbExitDelayed !== undefined) {
      this.kbExitDelayed.reset(0)
    }
  }

  /** NEXT-frame native exit: dismisses the invisible native TextInput session
   * that the field opened under the on-screen pad (untoggle, dismiss
   * keyboard, deregister the active field, cancel pending keyboard requests
   * — the SDK's full editMode(false) path). No text reads, no logs. The
   * field's editModeEvent(false) is ignored by this panel's handler, so the
   * pad stays open. */
  private deferredNativeExit() {
    if (this.destroyed || !this.isEditorPreview) {
      return
    }
    const field = this.kbExitPendingField
    this.kbExitPendingField = null // consume: a stale firing is a no-op
    if (field === null) {
      return
    }
    const tf = field === "endpoint" ? this.endpointField : this.codeField
    if (tf === null || tf === undefined) {
      return
    }
    tf.editMode(false)
  }

  /** Close the pad and restore the workflow rows (no-op when not editing).
   * Field text is already live (every keystroke wrote the actual field). */
  private closeKeyboard() {
    if (this.editingField === null) {
      return
    }
    this.editingField = null
    this.kbExitPendingField = null // consumed: no stale native-exit after close
    if (this.kb !== null) {
      this.kb.hide()
    }
    SoundcraftBus.textEntryActive = false
    if (this.keyboardItem !== null && this.colFlex !== null) {
      this.colFlex.removeItems([this.keyboardItem])
    }
    if (this.keyboardRow !== null) {
      this.keyboardRow.enabled = false
    }
    if (!this.expanded) {
      return // collapsed while editing: the workflow rows stay hidden
    }
    if (this.colFlex !== null) {
      this.colFlex.addItems(this.editHideItems)
    }
    for (const row of this.editHideRows) {
      row.enabled = true
    }
    this.frame.innerSize = new vec2(this.panelWidth, this.effExpandedHeight)
  }

  // ---- collapse / expand ---------------------------------------------------------

  private toggleExpanded() {
    if (!this.built) {
      return
    }
    this.setExpanded(!this.expanded, true)
  }

  /** Expand/collapse by re-adding vs removing FlexItems — the count change is
   * what triggers FlexLayout re-discovery (toggling .enabled alone does not).
   * No row is ever destroyed, so the controller's status Text stays valid. */
  private setExpanded(expanded: boolean, byUser: boolean) {
    if (!this.built || this.frame === null || this.colFlex === null || expanded === this.expanded) {
      return
    }
    this.expanded = expanded
    if (byUser) {
      this.userWantsExpanded = expanded
    }
    // Collapse/expand is a workflow-context change: a stale armed reopen
    // intent never survives it (the armed label is hidden anyway), and an
    // open on-screen keyboard is closed first so the row swap stays consistent.
    this.disarmOpen()
    this.closeKeyboard()
    if (expanded) {
      this.colFlex.addItems(this.expandedItems)
      // restore an in-flight code stashed by the collapse (memory only — the
      // stash is emptied on submit, never written anywhere else)
      if (this.codeField !== null && this.codeStash.length > 0) {
        this.codeField.text = this.codeStash
      }
    } else {
      // stash an in-flight code (memory only) before hiding the field
      if (this.codeField !== null) {
        const current = this.codeField.text
        this.codeStash = current !== null && current !== undefined ? current : ""
        this.codeField.text = ""
      }
      this.colFlex.removeItems(this.expandedItems)
    }
    for (const row of this.expandedRows) {
      row.enabled = expanded
    }
    this.frame.innerSize = new vec2(this.panelWidth, expanded ? this.effExpandedHeight : this.effCollapsedHeight)
    if (this.toggleLabel !== null) {
      this.toggleLabel.text = expanded ? "▾" : "▸"
    }
  }

  // ---- the Pair + Open actions ----------------------------------------------------

  /** PAIR: endpoint + one-time code → controller.configureEndpointAndPair.
   * The endpoint field prefills from controller.companionBaseUrl (read once,
   * runtime memory only). The CODE is cleared the instant it is consumed —
   * memory only, never stored, never logged (the log line carries no
   * endpoint/code/token material). Refusals resolve false; the controller
   * surfaces the sanitized typed refusal (CODE — reason) via onWorkflowNote
   * → this panel's hint row, and its own statusText WORKFLOW line. */
  private onPairTapped() {
    if (this.controller === null || this.controller === undefined) {
      console.error("[ConnectionUI] Pair tapped but no controller is wired — nothing was sent")
      this.setHint(this.emptyCodeHint)
      return
    }
    if (this.workflowBusy) {
      this.setHint(this.busyHint)
      return
    }
    // Any pair submit resets the reopen confirmation: the armed intent from a
    // stale OPEN tap must never survive a workflow context change. An open
    // on-screen keyboard is committed as-is first (its buffer is already
    // live in the fields) so validation reads the complete text.
    this.disarmOpen()
    this.closeKeyboard()
    if (this.endpointField === null || this.codeField === null) {
      return
    }
    const rawEndpoint = this.endpointField.text
    const endpoint = rawEndpoint !== null && rawEndpoint !== undefined ? rawEndpoint.trim() : ""
    const rawCode = this.codeField.text
    const code = rawCode !== null && rawCode !== undefined ? rawCode.trim() : ""
    this.codeStash = "" // a submitted (or empty) stash is gone for good
    if (endpoint.length === 0) {
      this.setHint(this.missingEndpointHint)
      return
    }
    if (code.length === 0) {
      this.setHint(this.emptyCodeHint)
      return
    }
    this.workflowBusy = true
    // Clear the code the instant it is consumed: memory only, never stored
    // and never logged (this log line is content-free, matching the
    // controller's masking convention — no endpoint, code or token material).
    this.codeField.text = ""
    this.setHint(this.submittedHint)
    console.log("[ConnectionUI] configureEndpointAndPair requested (code cleared · memory only)")
    this.controller
      .configureEndpointAndPair(endpoint, code)
      .then((ok: boolean) => {
        this.workflowBusy = false
        if (ok) {
          // Truthful local statement only — the paired truth arrives via the
          // controller's snapshot feed (compact line + status row). The
          // phase-aware auto-collapse takes over from applyStatus().
          this.setHint("pair accepted — see status line")
        }
        // false: the controller already surfaced the verbatim sanitized
        // refusal through onWorkflowNote → hint row; nothing is invented here.
      })
      .catch((e: unknown) => {
        this.workflowBusy = false
        this.setHint("pair call failed unexpectedly — nothing changed; see status line")
        console.error("[ConnectionUI] configureEndpointAndPair threw (" + String(e) + ") — no data was discarded")
      })
  }

  /** OPEN LAST SAVE: TWO-STEP confirmation, duplicate-trigger-safe. The pure
   * decision helper (SoundcraftOpenConfirm.openConfirmDecision) guarantees:
   *  * first trigger → "arm": visible armed state (label + warning hint);
   *    the controller is NOT called on this branch.
   *  * duplicate onTriggerUp callbacks from the same gesture/frame arrive
   *    <300 ms after the arm → "ignore": nothing advances, nothing fires.
   *  * a distinct trigger ≥300 ms and ≤8 s after the arm → "fire": disarm,
   *    then call explicitOpenLastSavedProject() (this action REPLACES the
   *    live document — the confirmation requirement is the controller
   *    contract's, enforced here in the UI).
   *  * a trigger after the 8 s window → expired: it NEVER fires; it re-arms
   *    a fresh confirmation instead.
   * Never auto-called anywhere in this file. */
  private onOpenTapped() {
    if (this.controller === null || this.controller === undefined) {
      console.error("[ConnectionUI] Open tapped but no controller is wired — nothing was called")
      return
    }
    if (this.workflowBusy) {
      this.setHint(this.busyHint)
      return
    }
    const nowMs = getRealTimeNanos() / 1e6
    const decision = openConfirmDecision(this.openArmedAtMs, nowMs)
    if (decision === "ignore") {
      // Duplicate synthetic trigger from the same gesture/frame: swallow it
      // completely — no state change, no controller call, no hint churn.
      return
    }
    if (decision === "arm") {
      // Step 1: arm only — the controller is NOT called.
      this.openArmedAtMs = nowMs
      if (this.openLabel !== null) {
        this.openLabel.text = this.openArmedLabel
      }
      this.setHint(this.openArmedHint)
      return
    }
    // Step 2 ("fire"): confirmed second distinct tap inside the window.
    this.disarmOpen()
    this.workflowBusy = true
    this.setHint("opening the last saved project…")
    console.log("[ConnectionUI] explicitOpenLastSavedProject requested after two-step confirmation")
    this.controller
      .explicitOpenLastSavedProject()
      .then((ok: boolean) => {
        this.workflowBusy = false
        if (ok) {
          this.setHint("opened — capture resumed (truth in the status line)")
        }
        // false: the controller surfaced the verbatim sanitized refusal
        // (gate code — reason) via onWorkflowNote → hint row already.
      })
      .catch((e: unknown) => {
        this.workflowBusy = false
        this.setHint("open call failed unexpectedly — nothing changed; see status line")
        console.error("[ConnectionUI] explicitOpenLastSavedProject threw (" + String(e) + ") — no data was discarded")
      })
  }

  /** Disarm the reopen affordance (restore its resting label). */
  private disarmOpen() {
    this.openArmedAtMs = null
    if (this.openLabel !== null) {
      this.openLabel.text = this.openButtonLabel
    }
  }

  /** Per-frame arm expiry: an armed confirmation that was never confirmed
   * lapses without calling anything (the decision helper additionally
   * re-arms instead of firing on any post-expiry tap). */
  private tickOpenArmExpiry() {
    if (this.openArmedAtMs !== null && getRealTimeNanos() / 1e6 - this.openArmedAtMs > OPEN_CONFIRM_WINDOW_MS) {
      this.disarmOpen()
      this.setHint(this.openExpiredHint)
    }
  }

  private setHint(message: string) {
    if (this.hintText !== null) {
      this.hintText.text = message
    }
  }

  // ---- adapter seam (wired internally in tryWireController) --------------------

  /**
   * Feed a client snapshot to drive the compact status line, severity tint,
   * and the phase-aware auto-collapse ("after paired, collapse to the small
   * status near the playlist"). The controller's `onSnapshot` hook (its public
   * field, invoked from its safe renderStatus path) is assigned to this method
   * by `tryWireController()` — once, after OnStart AND Frame.onInitialized
   * have both landed; a pre-existing consumer is chained, never dropped; the
   * hook is cleared again in `onWillDestroy()` (only if still ours). Before
   * the first snapshot arrives the compact line keeps its honest idle
   * placeholder ("WAITING — tap ▸ for connection details"); nothing here ever
   * claims a connection state on its own.
   * A manual expand/collapse always wins over the automatic rules.
   */
  applyStatus(s: StatusDetail) {
    if (!this.built || s === null || s === undefined) {
      return
    }
    if (this.compactText !== null) {
      let line = compactSummary(s)
      const ack = saveAckSnippet(s.lastSavedReceipt)
      if (ack.length > 0) {
        line += " · " + ack
      }
      this.compactText.text = line
      this.compactText.textFill.color = this.severityColor(severityForSummary(s))
    }
    if (isPairedLike(s.phase) && this.judgeMode && this.userWantsExpanded !== true) {
      // Judge mode may collapse freely (its workflow rows do not exist). The
      // UNCONFIGURED PLACEHOLDER also reports local_only, but there the
      // runtime-config flow NEEDS the endpoint/code fields visible — never
      // auto-collapse it (the user can still collapse manually).
      this.setExpanded(false, false)
    } else if (isPairInputNeeded(s.phase) && this.userWantsExpanded !== false) {
      this.setExpanded(true, false)
    }
  }

  private severityColor(severity: Severity): vec4 {
    if (severity === "ok") {
      return this.colorOk
    }
    if (severity === "info") {
      return this.colorInfo
    }
    if (severity === "warn") {
      return this.colorWarn
    }
    if (severity === "error") {
      return this.colorError
    }
    return this.colorNeutral
  }

  // ---- helpers (specs-build-ui canon) --------------------------------------------

  private itemOf(child: SceneObject): FlexItem {
    return child.getComponent(FlexItem.getTypeName()) as FlexItem
  }

  private obj(parent: SceneObject, name: string, position?: vec3): SceneObject {
    const sceneObject = global.scene.createSceneObject(name)
    sceneObject.setParent(parent)
    if (position) {
      sceneObject.getTransform().setLocalPosition(position)
    }
    return sceneObject
  }

  private liftInZ(sceneObject: SceneObject, zOffset: number): void {
    const transform = sceneObject.getTransform()
    const pos = transform.getLocalPosition()
    transform.setLocalPosition(new vec3(pos.x, pos.y, pos.z + zOffset))
  }

  private flexChild(parent: SceneObject, size: {w?: number, h?: number, grow?: number},
                    builder: (childObject: SceneObject) => void): SceneObject {
    const child = this.obj(parent, "Item")
    this.liftInZ(child, LAYOUT_Z_LIFT)
    const flexItem = child.createComponent(FlexItem.getTypeName()) as FlexItem
    if (size.w !== undefined && size.w > 0) {
      flexItem.overrideWidth = size.w
    }
    if (size.h !== undefined && size.h > 0) {
      flexItem.overrideHeight = size.h
    }
    flexItem.flexGrow = size.grow ?? 0
    flexItem.flexShrink = 0
    builder(child)
    const parentFlexLayout = parent.getComponent(FlexLayout.getTypeName()) as FlexLayout | null
    if (parentFlexLayout !== null && parentFlexLayout !== undefined) {
      parentFlexLayout.addItems([flexItem])
    }
    return child
  }

  /** Raw Component.Text for runtime-updating rows, sized to its host cell. */
  private makeText(host: SceneObject, value: string, role: TextRole, widthCM: number, heightCM: number,
                   tint: vec4, overflow: HorizontalOverflow): Text {
    const t = host.createComponent("Component.Text") as Text
    t.text = value
    t.depthTest = true
    applyTextRole(t, role, this.focalDistanceCm)
    t.horizontalAlignment = HorizontalAlignment.Left
    t.verticalAlignment = VerticalAlignment.Center // NEVER Top for multi-line (overflow-upward gotcha)
    t.horizontalOverflow = overflow
    t.verticalOverflow = VerticalOverflow.Overflow
    t.layoutRect = Rect.create(-widthCM / 2, widthCM / 2, -heightCM / 2, heightCM / 2)
    t.textFill.color = tint
    // register the host with alignSelf Stretch so the row spans the column width
    const item = host.getComponent(FlexItem.getTypeName()) as FlexItem | null
    if (item !== null && item !== undefined) {
      item.alignSelf = FlexAlignSelf.Stretch
    }
    return t
  }

  /** Raw Text label on a Button face, lifted +Z so the glyph is not occluded. */
  private addButtonLabel(parent: SceneObject, text: string, widthCM: number, role: TextRole = "Button"): Text {
    const so = this.obj(parent, "ButtonLabel", new vec3(0, 0, BUTTON_LABEL_Z))
    const t = so.createComponent("Component.Text") as Text
    t.text = text
    t.depthTest = true
    applyTextRole(t, role, this.focalDistanceCm)
    t.horizontalAlignment = HorizontalAlignment.Center
    t.verticalAlignment = VerticalAlignment.Center
    t.horizontalOverflow = HorizontalOverflow.Overflow
    t.verticalOverflow = VerticalOverflow.Overflow
    t.layoutRect = Rect.create(-widthCM / 2, widthCM / 2, -1.2, 1.2)
    return t
  }
}
