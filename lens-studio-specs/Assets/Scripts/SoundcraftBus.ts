// SoundcraftBus.ts — session state, event bus, and small interaction helpers.
// Fresh original code for the SoundCraft Orbit SPECS Lens (no Orbit-repo code reused).
//
// Everything lives in a static registry so scripts never need cross-component
// typed lookups: instruments / panels / orb self-register in OnStartEvent.

import { Interactable } from "SpectaclesInteractionKit.lspkg/Components/Interaction/Interactable/Interactable";
import { InteractableManipulation } from "SpectaclesInteractionKit.lspkg/Components/Interaction/InteractableManipulation/InteractableManipulation";
import Event from "SpectaclesInteractionKit.lspkg/Utils/Event";

export type HitInfo = {
  instrument: string; // "beat" | "bass" | "chord"
  pad: number; // pad index within the instrument
  label: string; // e.g. "KICK"
  time: number; // seconds since session start
};

export type PadInstrumentLike = {
  instrumentType: string;
  panLinked: boolean;
  hitPad: (index: number) => void;
  togglePanLink: () => void;
};

/**
 * Component lookup that works across LS naming generations: tries the modern
 * plain name first, then the legacy "Component."-prefixed name.
 */
export function getComponentLoose<T>(obj: SceneObject, plain: string, prefixed: string): T | null {
  let c = obj.getComponent(plain as unknown as Parameters<SceneObject["getComponent"]>[0]);
  if (c === null || c === undefined) {
    c = obj.getComponent(prefixed as unknown as Parameters<SceneObject["getComponent"]>[0]);
  }
  return (c as unknown) as T | null;
}

/**
 * Component creation with the same dual-name strategy as getComponentLoose.
 */
export function createComponentLoose<T>(obj: SceneObject, plain: string, prefixed: string): T {
  type CreateArg = Parameters<SceneObject["createComponent"]>[0];
  let c = null;
  try {
    c = obj.createComponent(plain as unknown as CreateArg);
  } catch (e) {
    c = null;
  }
  if (c === null || c === undefined) {
    c = obj.createComponent(prefixed as unknown as CreateArg);
  }
  return (c as unknown) as T;
}

/**
 * Static session bus. All timing is accumulated (never Date-based) so it
 * behaves identically in editor preview and on device.
 */
export class SoundcraftBus {
  static sessionTime = 0;
  static sessionActive = false;
  static demoPlaying = false;
  static demoBpm = 70;
  static demoLength = 30.9; // seconds, matches Assets/GeneratedSFX/demo_vapor.wav

  static instruments: PadInstrumentLike[] = [];
  static playlist: {
    playDemo: (on: boolean) => void;
    toggleDemo: () => void;
  } | null = null;
  static take: HitInfo[] = [];
  static onHit: Event<HitInfo> = new Event<HitInfo>();
  static onDemoChanged: Event<boolean> = new Event<boolean>();
  static onTakeCleared: Event<void> = new Event<void>();

  static resetSession() {
    SoundcraftBus.sessionTime = 0;
    SoundcraftBus.sessionActive = true;
    SoundcraftBus.take = [];
  }

  /** Called once per frame by DawManager to advance the session clock. */
  static tick(dt: number) {
    if (SoundcraftBus.sessionActive) {
      SoundcraftBus.sessionTime += dt;
    }
  }

  static recordHit(instrument: string, pad: number, label: string) {
    const info: HitInfo = {
      instrument: instrument,
      pad: pad,
      label: label,
      time: SoundcraftBus.sessionTime,
    };
    SoundcraftBus.take.push(info);
    SoundcraftBus.onHit.invoke(info);
  }

  static clearTake() {
    SoundcraftBus.take = [];
    SoundcraftBus.onTakeCleared.invoke();
  }

  static setDemoPlaying(playing: boolean) {
    SoundcraftBus.demoPlaying = playing;
    SoundcraftBus.onDemoChanged.invoke(playing);
  }
}

/**
 * Ensure a box collider of the given LOCAL size on a SceneObject.
 *
 * LOCAL-GEOMETRY CONTRACT: `size` is stored verbatim on the BoxShape — the
 * object's own transform maps it to world size. Two supported patterns:
 *  - Panel roots: pass the plate's local size (e.g. (21,21,1.2) or (11,38,1.2)
 *    or (34,14,1.2)); the root's parent scale (if any) then sizes the world
 *    collider, matching the scaled BackPlate child underneath.
 *  - Scale-as-size visuals (unit SCBox meshes): pass (1,1,1) so the collider
 *    tracks the object's own scale exactly — pads, PanToggle, DemoPad. This
 *    keeps pulse/rescale animations and panel-scale parenting correct without
 *    any division (no zero-scale arithmetic anywhere).
 *
 * fitVisual is force-set false AFTER the shape assignment: assigning a shape
 * resets fitVisual to true, and fitVisual=true would override this explicit
 * size with the visual mesh's AABB, silently discarding the contract above.
 */
export function ensureBoxCollider(obj: SceneObject, size: vec3): ColliderComponent {
  let col = getComponentLoose<ColliderComponent>(obj, "ColliderComponent", "Component.ColliderComponent");
  if (col === null) {
    col = createComponentLoose<ColliderComponent>(obj, "ColliderComponent", "Component.ColliderComponent");
  }
  const shape = Shape.createBoxShape();
  (shape as BoxShape).size = size;
  col.shape = shape;
  col.fitVisual = false;
  return col;
}

/** Ensure an Interactable (SIK pinch/hover target) on a SceneObject. */
export function ensureInteractable(obj: SceneObject): Interactable {
  let it = obj.getComponent(Interactable.getTypeName()) as unknown as Interactable;
  if (it === null) {
    it = obj.createComponent(Interactable.getTypeName()) as unknown as Interactable;
  }
  return it;
}

/**
 * Ensure grab-and-move on a panel root. The caller must first add a box
 * collider + Interactable on the root (see ensureBoxCollider/ensureInteractable)
 * sized to the panel's backing plate. SIK's MouseInteractor drives this in
 * editor preview (mouse click), HandInteractor drives it on device (pinch).
 */
export function ensurePanelManipulation(root: SceneObject): InteractableManipulation {
  let man = root.getComponent(InteractableManipulation.getTypeName()) as unknown as InteractableManipulation;
  if (man === null) {
    man = root.createComponent(InteractableManipulation.getTypeName()) as unknown as InteractableManipulation;
  }
  return man;
}

/** Find a direct child by exact name (returns null when absent). */
export function findChild(parent: SceneObject, name: string): SceneObject {
  for (let i = 0; i < parent.getChildrenCount(); i++) {
    const c = parent.getChild(i);
    if (c.name === name) {
      return c;
    }
  }
  return null;
}

/** Collect direct children whose names match Pad0..Pad99, ordered by index. */
export function collectPads(parent: SceneObject): SceneObject[] {
  const byIndex: { [index: number]: SceneObject } = {};
  let max = -1;
  for (let i = 0; i < parent.getChildrenCount(); i++) {
    const c = parent.getChild(i);
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

/** Get the first Text component on a SceneObject (if any). */
export function textOf(obj: SceneObject): Text | null {
  return getComponentLoose<Text>(obj, "Text", "Component.Text");
}

/** Get the first AudioComponent on a SceneObject (if any). */
export function audioOf(obj: SceneObject): AudioComponent | null {
  return getComponentLoose<AudioComponent>(obj, "AudioComponent", "Component.AudioComponent");
}

/** Get the first RenderMeshVisual on a SceneObject (if any). */
export function visualOf(obj: SceneObject): RenderMeshVisual | null {
  return getComponentLoose<RenderMeshVisual>(obj, "RenderMeshVisual", "Component.RenderMeshVisual");
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ":" + (r < 10 ? "0" : "") + r;
}
