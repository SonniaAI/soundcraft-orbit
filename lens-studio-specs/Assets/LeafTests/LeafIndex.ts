// LeafIndex.ts — registration module for the SoundCraft Orbit LEAF scenarios.
// TEST-OWNED FILE (Assets/LeafTests).
//
// NOT attached to the scene by the test author (scene owner is active).
// See README.md in this folder for the exact wiring steps the scene owner /
// parent session performs: create SceneObject "LeafIndex", add a
// ScriptComponent, set scriptAsset to this file, force recompile, run from
// the LeafPlugin panel.

import {scenariosIndex} from "Leaf.lspkg/Scenarios/decorator/ScenarioIndexDecorator"
import {ScenarioMetadata} from "Leaf.lspkg/Scenarios/scenario/ScenarioMetadata"
import {SoundcraftPinchBeatPadScenario} from "./SoundcraftPinchBeatPadScenario"
import {SoundcraftDragPanelScenario} from "./SoundcraftDragPanelScenario"
import {SoundcraftPanToggleScenario} from "./SoundcraftPanToggleScenario"
import {ColliderLocalGeometryScenario} from "./ColliderLocalGeometryScenario"

@component
export class LeafIndex extends BaseScriptComponent {
  @scenariosIndex
  static scenariosIndex: ScenarioMetadata[] = [
    {
      id: "soundcraft-pinch-beat-pad-records-take",
      typename: SoundcraftPinchBeatPadScenario.getTypeName(),
    },
    {
      id: "soundcraft-drag-panel-world-fixed-restore",
      typename: SoundcraftDragPanelScenario.getTypeName(),
    },
    {
      id: "soundcraft-pan-toggle-reverses-spatial",
      typename: SoundcraftPanToggleScenario.getTypeName(),
    },
    {
      id: "soundcraft-collider-local-geometry",
      typename: ColliderLocalGeometryScenario.getTypeName(),
    },
  ]
}
