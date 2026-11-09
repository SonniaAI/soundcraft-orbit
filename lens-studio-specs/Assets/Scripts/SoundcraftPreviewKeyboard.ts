// SoundcraftPreviewKeyboard.ts — PREVIEW-ONLY on-screen keyboard for the
// connection panel's endpoint / one-time-code fields. The AR keyboard does
// not appear in Lens Studio Preview with the SPECS 27 simulation, and gesture
// "typing" otherwise falls through to the mini-DAW test shortcuts — this pad
// is the fallback entry surface. On hardware the native TextInputField + AR
// keyboard remain unchanged; this pad is created only in editor Preview.
//
// SELF-CONTAINED: the component is created at runtime on a panel row
// SceneObject (no scene asset, no manual GUIDs). All entry logic lives in the
// pure model (SoundcraftKeyboardModel.ts) — this layer is a dumb UIKit grid:
// Button per key (raw-Text label with the +0.08 face lift), per-button
// ≥250 ms duplicate-trigger debounce, Caps toggle for
// the endpoint letters, https:// prefix button, Backspace/Clear/Done.
//
// PRIVACY: every character lives in this component's in-memory buffer and is
// pushed to the caller via onTextChanged/onDone. Nothing is logged, printed,
// persisted, or sent anywhere (covered by the model test's contract scan).

import {Button} from "SpectaclesUIKit.lspkg/Scripts/Components/Button/Button";
import {FlexItem} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexItem";
import {FlexLayout} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexLayout";
import {
  FlexAlign,
  FlexAlignSelf,
  FlexDirection,
  FlexJustify,
} from "SpectaclesUIKit.lspkg/Scripts/Components/Layout2D/Flex/FlexTypes";
import Event, {PublicApi} from "SpectaclesInteractionKit.lspkg/Utils/Event";
import {TargetingMode} from "SpectaclesInteractionKit.lspkg/Core/Interactor/Interactor";
import {Interactable} from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import {
  applyCodeAction,
  applyEndpointAction,
  CODE_CHAR_ROWS,
  ENDPOINT_CHAR_ROWS,
  formatCodeBuffer,
  KeyAction,
  sanitizeCodeRaw,
} from "./SoundcraftKeyboardModel";

export type KeyboardMode = "endpoint" | "code"

const DEBOUNCE_MS = 250
const KEY_ROW_GAP = 0.2
const KEY_H = 1.9
const CODE_KEY_H = 2.0
const KEY_FACE_LIFT = 0.08

// PREVIEW pad targeting: Direct (hand pinch) + Indirect (mouse ray) ONLY —
// Poke is excluded from initialized key targets (the SIK enum marks
// Poke mutually exclusive with Direct/Indirect; source: Interactor.ts enum
// TargetingMode). Pad keys only — instrument Pad/Pair/Open untouched.
const KEY_TARGETING_MODE: number = TargetingMode.Direct | TargetingMode.Indirect

type PressEntry = { lastMs: number }

@component
export class SoundcraftPreviewKeyboard extends BaseScriptComponent {
  // ---- caller wiring ----------------------------------------------------------
  private widthCm = 27.2
  private focalCm = 70
  private mode: KeyboardMode | null = null
  private buffer = ""

  private _onTextChanged = new Event<string>()
  get onTextChanged(): PublicApi<string> {
    return this._onTextChanged.publicApi()
  }

  private _onDone = new Event<string>()
  get onDone(): PublicApi<string> {
    return this._onDone.publicApi()
  }

  // ---- built handles ------------------------------------------------------------
  private built = false
  private endpointCol: SceneObject | null = null
  private codeCol: SceneObject | null = null
  private letterLabels: { label: Text; base: string }[] = []
  private capsOn = false
  // UIKit creates Interactable lazily. Retain each key host until its real
  // component exists, including keys in the initially hidden code column.
  private pendingTargeting: SceneObject[] = []

  /** Store geometry before the first show. */
  configure(widthCm: number, focalCm: number) {
    this.widthCm = widthCm
    this.focalCm = focalCm
  }

  onAwake() {
    // PHYSICAL KEYS ARE EDITOR-ONLY: the KeyPressEvent stream is the editor
    // preview's test-key path (DawManager binds the same way). On hardware
    // this component never listens — native entry stays untouched.
    if (!global.deviceInfoSystem.isEditor()) {
      return
    }
    // Physical-key forwarding (editor preview): letter/digit/Backspace keys
    // land here while the pad is visible instead of leaking into the
    // mini-DAW shortcuts (DawManager early-returns on the same flag).
    this.createEvent("KeyPressEvent").bind((ev: KeyPressEvent) => this.onPhysicalKey(ev.key));
    this.createEvent("UpdateEvent").bind(() => this.applyPendingTargetingModes())
  }

  /** Apply the mask after UIKit materializes each key's Interactable.
   * Pending hosts are retried; no missing component is silently dropped.
   * Instrument pads / Pair / Open are never queued. */
  private applyPendingTargetingModes() {
    if (this.pendingTargeting.length === 0) {
      return
    }
    const remaining: SceneObject[] = []
    for (const host of this.pendingTargeting) {
      if (isNull(host)) continue
      const inter = host.getComponent(Interactable.getTypeName()) as unknown as Interactable
      if (inter === null || inter === undefined) {
        remaining.push(host)
        continue
      }
      inter.targetingMode = KEY_TARGETING_MODE
    }
    this.pendingTargeting = remaining
  }

  /** Show the pad for a mode. Re-armable: resets the buffer from the field's
   * current text (endpoint: literal; code: the hyphen display is stripped). */
  show(mode: KeyboardMode, initialText: string) {
    if (!this.built) {
      this.build()
    }
    this.mode = mode
    if (mode === "endpoint") {
      this.buffer = typeof initialText === "string" ? initialText : ""
      this.capsOn = false
      this.refreshLetterLabels()
      if (this.endpointCol !== null) this.endpointCol.enabled = true
      if (this.codeCol !== null) this.codeCol.enabled = false
    } else {
      this.buffer = sanitizeCodeRaw(typeof initialText === "string" ? initialText : "")
      if (this.endpointCol !== null) this.endpointCol.enabled = false
      if (this.codeCol !== null) this.codeCol.enabled = true
    }
    this.emitText()
  }

  /** Hide the pad (buffer resets on the next show). */
  hide() {
    this.mode = null
    this.buffer = ""
  }

  /** Physical-key forwarding entry point. */
  injectChar(ch: string) {
    this.press({ kind: "char", ch })
  }

  injectBackspace() {
    this.press({ kind: "backspace" })
  }

  // ---- build ---------------------------------------------------------------------

  private build() {
    this.built = true
    const col = this.sceneObject.createComponent(FlexLayout.getTypeName()) as FlexLayout
    col.autoDiscoverItemsOnStart = false
    col.width = this.widthCm
    col.height = -1
    col.direction = FlexDirection.Column
    col.alignItems = FlexAlign.Center
    col.justifyContent = FlexJustify.Start
    col.rowGap = KEY_ROW_GAP

    const w = this.widthCm

    this.endpointCol = this.keyColumn(col, w, ENDPOINT_CHAR_ROWS, 10, KEY_H, true)
    this.codeCol = this.keyColumn(col, w, CODE_CHAR_ROWS, 8, CODE_KEY_H, false)

    this.endpointCol.enabled = false
    this.codeCol.enabled = false
  }

  /** One mode column: char rows + that mode's control row. */
  private keyColumn(
    parentCol: FlexLayout,
    widthCm: number,
    charRows: string[][],
    cols: number,
    keyH: number,
    isEndpoint: boolean,
  ): SceneObject {
    const colObj = this.obj(this.sceneObject, isEndpoint ? "KBEndpoint" : "KBCode")
    const col = colObj.createComponent(FlexLayout.getTypeName()) as FlexLayout
    col.autoDiscoverItemsOnStart = false
    col.width = widthCm
    col.height = -1
    col.direction = FlexDirection.Column
    col.alignItems = FlexAlign.Center
    col.justifyContent = FlexJustify.Start
    col.rowGap = KEY_ROW_GAP
    const colItem = colObj.createComponent(FlexItem.getTypeName()) as FlexItem
    colItem.alignSelf = FlexAlignSelf.Center
    parentCol.addItems([colItem])

    const gap = KEY_ROW_GAP
    const keyW = (widthCm - (cols - 1) * gap) / cols

    for (const row of charRows) {
      const rowObj = this.obj(colObj, "KBRow")
      const rowFlex = rowObj.createComponent(FlexLayout.getTypeName()) as FlexLayout
      rowFlex.autoDiscoverItemsOnStart = false
      rowFlex.width = widthCm
      rowFlex.height = keyH
      rowFlex.direction = FlexDirection.Row
      rowFlex.alignItems = FlexAlign.Center
      rowFlex.justifyContent = FlexJustify.Center
      rowFlex.columnGap = gap
      const rowItem = rowObj.createComponent(FlexItem.getTypeName()) as FlexItem
      rowItem.alignSelf = FlexAlignSelf.Center
      col.addItems([rowItem])

      for (const base of row) {
        const isLetter = isEndpoint && /[a-z]/.test(base)
        const press: PressEntry = { lastMs: -1 }
        const labelText = isLetter ? (this.capsOn ? base.toUpperCase() : base) : base
        const label = this.keyButton(rowObj, rowFlex, keyW, keyH, labelText, press, () => {
          if (isLetter) {
            this.press({ kind: "char", ch: this.capsOn ? base.toUpperCase() : base })
          } else {
            this.press({ kind: "char", ch: base })
          }
        })
        if (isLetter) {
          this.letterLabels.push({ label: label, base: base })
        }
      }
    }

    // control row
    const ctrlObj = this.obj(colObj, "KBControls")
    const ctrl = ctrlObj.createComponent(FlexLayout.getTypeName()) as FlexLayout
    ctrl.autoDiscoverItemsOnStart = false
    ctrl.width = widthCm
    ctrl.height = keyH
    ctrl.direction = FlexDirection.Row
    ctrl.alignItems = FlexAlign.Center
    ctrl.justifyContent = FlexJustify.Center
    ctrl.columnGap = gap
    const ctrlItem = ctrlObj.createComponent(FlexItem.getTypeName()) as FlexItem
    ctrlItem.alignSelf = FlexAlignSelf.Center
    col.addItems([ctrlItem])

    if (isEndpoint) {
      // ':' has a DEDICATED on-screen key (the Keys enum has no punctuation
      // members): custom host:port entry exists without claiming ports by
      // guesswork. Widths budget to 26.5 cm inside the 27.2 cm content.
      const capsPress: PressEntry = { lastMs: -1 }
      this.controlButton(ctrlObj, ctrl, 3.6, keyH, this.capsOn ? "Aa" : "aa", capsPress, () => {
        this.capsOn = !this.capsOn
        this.refreshLetterLabels()
      })
      const prefixPress: PressEntry = { lastMs: -1 }
      this.controlButton(ctrlObj, ctrl, 6.0, keyH, "https://", prefixPress, () => {
        this.press({ kind: "prefixUrl" })
      })
      const colonPress: PressEntry = { lastMs: -1 }
      this.controlButton(ctrlObj, ctrl, 2.5, keyH, ":", colonPress, () => {
        this.press({ kind: "char", ch: ":" })
      })
      const bsPress: PressEntry = { lastMs: -1 }
      this.controlButton(ctrlObj, ctrl, 4.0, keyH, "⌫", bsPress, () => {
        this.press({ kind: "backspace" })
      })
      const clrPress: PressEntry = { lastMs: -1 }
      this.controlButton(ctrlObj, ctrl, 4.2, keyH, "CLR", clrPress, () => {
        this.press({ kind: "clear" })
      })
      const donePress: PressEntry = { lastMs: -1 }
      this.controlButton(ctrlObj, ctrl, 5.2, keyH, "DONE", donePress, () => {
        this._onDone.invoke(this.text())
      })
    } else {
      const bsPress: PressEntry = { lastMs: -1 }
      this.controlButton(ctrlObj, ctrl, 8.0, keyH, "⌫", bsPress, () => {
        this.press({ kind: "backspace" })
      })
      const clrPress: PressEntry = { lastMs: -1 }
      this.controlButton(ctrlObj, ctrl, 8.0, keyH, "CLR", clrPress, () => {
        this.press({ kind: "clear" })
      })
      const donePress: PressEntry = { lastMs: -1 }
      this.controlButton(ctrlObj, ctrl, 10.0, keyH, "DONE", donePress, () => {
        this._onDone.invoke(this.text())
      })
    }
    return colObj
  }

  /** Queue the host, not a possibly-null lazy Interactable. */
  private queuePadTargeting(keyObj: SceneObject) {
    this.pendingTargeting.push(keyObj)
  }

  // ---- key press plumbing -----------------------------------------------------
  private press(action: KeyAction) {
    if (this.mode === null) {
      return
    }
    if (this.mode === "endpoint") {
      this.buffer = applyEndpointAction(this.buffer, action)
    } else {
      this.buffer = applyCodeAction(this.buffer, action)
    }
    this.emitText()
  }

  private text(): string {
    return this.mode === "code" ? formatCodeBuffer(this.buffer) : this.buffer
  }

  private emitText() {
    this._onTextChanged.invoke(this.text())
  }

  private refreshLetterLabels() {
    for (const entry of this.letterLabels) {
      if (entry.label !== null && entry.label !== undefined) {
        entry.label.text = this.capsOn ? entry.base.toUpperCase() : entry.base
      }
    }
  }

  private onPhysicalKey(key: Keys) {
    if (this.mode === null || !this.sceneObject.enabled) {
      return
    }
    // Dts-verified: Keys is a SEQUENTIAL numeric enum (… Zero..Nine, A..Z —
    // no explicit values), so anchored fromCharCode mapping is exact and no
    // reverse enum-object lookup (not guaranteed on native enums) is used.
    if (key >= Keys.A && key <= Keys.Z) {
      const letter = String.fromCharCode(97 + (key - Keys.A)) // a-z
      this.injectChar(this.mode === "endpoint" && this.capsOn ? letter.toUpperCase() : letter)
      return
    }
    if (key >= Keys.Zero && key <= Keys.Nine) {
      this.injectChar(String(key - Keys.Zero)) // 0-9
      return
    }
    if (key === Keys.Backspace) {
      this.injectBackspace()
    }
  }

  // ---- small builders ------------------------------------------------------------
  private obj(parent: SceneObject, name: string): SceneObject {
    const so = global.scene.createSceneObject(name)
    so.setParent(parent)
    return so
  }

  /** One pad key: its own SceneObject + FlexItem (registered into the row
   * layout) hosting a UIKit Button with a raw-Text face label (+0.08 lift).
   * Per-button ≥250 ms trigger debounce guards against duplicate onTriggerUp
   * callbacks from a single poke/gesture. */
  private keyButton(
    rowObj: SceneObject,
    rowFlex: FlexLayout,
    w: number,
    h: number,
    label: string,
    press: PressEntry,
    onFire: () => void,
  ): Text {
    const keyObj = this.obj(rowObj, "Key")
    const item = keyObj.createComponent(FlexItem.getTypeName()) as FlexItem
    item.overrideWidth = w
    item.overrideHeight = h
    rowFlex.addItems([item])
    const btn = keyObj.createComponent(Button.getTypeName()) as Button
    btn.size = new vec3(w, h, 1)
    this.queuePadTargeting(keyObj)
    const labelObj = this.obj(keyObj, "KeyLabel")
    labelObj.getTransform().setLocalPosition(new vec3(0, 0, KEY_FACE_LIFT))
    const t = labelObj.createComponent("Component.Text") as Text
    t.text = label
    t.depthTest = true
    t.size = 38
    t.weight = 500
    t.horizontalAlignment = HorizontalAlignment.Center
    t.verticalAlignment = VerticalAlignment.Center
    t.horizontalOverflow = HorizontalOverflow.Overflow
    t.verticalOverflow = VerticalOverflow.Overflow
    t.layoutRect = Rect.create(-w / 2, w / 2, -h / 2, h / 2)
    btn.onTriggerUp.add(() => {
      const now = getRealTimeNanos() / 1e6
      if (press.lastMs >= 0 && now - press.lastMs < DEBOUNCE_MS) {
        return // duplicate trigger from the same poke/gesture
      }
      press.lastMs = now
      onFire()
    })
    return t
  }

  private controlButton(
    parent: SceneObject,
    parentFlex: FlexLayout,
    w: number,
    h: number,
    label: string,
    press: PressEntry,
    onFire: () => void,
  ) {
    const keyObj = this.obj(parent, "Key")
    const item = keyObj.createComponent(FlexItem.getTypeName()) as FlexItem
    item.overrideWidth = w
    item.overrideHeight = h
    parentFlex.addItems([item])
    const btn = keyObj.createComponent(Button.getTypeName()) as Button
    btn.size = new vec3(w, h, 1)
    this.queuePadTargeting(keyObj)
    const labelObj = this.obj(keyObj, "KeyLabel")
    labelObj.getTransform().setLocalPosition(new vec3(0, 0, KEY_FACE_LIFT))
    const t = labelObj.createComponent("Component.Text") as Text
    t.text = label
    t.depthTest = true
    t.size = 34
    t.weight = 500
    t.horizontalAlignment = HorizontalAlignment.Center
    t.verticalAlignment = VerticalAlignment.Center
    t.horizontalOverflow = HorizontalOverflow.Overflow
    t.verticalOverflow = VerticalOverflow.Overflow
    t.layoutRect = Rect.create(-w / 2, w / 2, -h / 2, h / 2)
    btn.onTriggerUp.add(() => {
      const now = getRealTimeNanos() / 1e6
      if (press.lastMs >= 0 && now - press.lastMs < DEBOUNCE_MS) {
        return
      }
      press.lastMs = now
      onFire()
    })
  }
}
