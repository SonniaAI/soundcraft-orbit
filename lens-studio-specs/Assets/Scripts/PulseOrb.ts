// PulseOrb.ts — the visual heartbeat of the mini-DAW: a floating orb that
// pulses on every sound and breathes with the demo loop. This is the
// Preview-safe spatial moment: hit a pad and the room visibly reacts.
// Fresh original code for the SoundCraft Orbit SPECS Lens.

import animate from "SpectaclesInteractionKit.lspkg/Utils/animate";
import { SoundcraftBus, HitInfo, findChild, visualOf } from "./SoundcraftBus";

const HIT_TINTS: { [key: string]: vec4 } = {
  beat: new vec4(1.0, 0.45, 0.85, 1),
  bass: new vec4(0.35, 0.85, 1.0, 1),
  chord: new vec4(0.72, 0.5, 1.0, 1),
};

@component
export class PulseOrb extends BaseScriptComponent {
  private orbBase: vec3 = new vec3(7, 7, 7);
  private haloBase: vec3 = new vec3(11, 0.5, 11);
  private orbMat: Material = null;
  private haloMat: Material = null;
  private orbBaseColor: vec4 = new vec4(1.0, 0.94, 0.62, 1);
  private time = 0;
  private pulsing = false;
  private spinAngle = 0;
  private orbCore: SceneObject = null;
  private halo: SceneObject = null;

  onAwake() {
    this.orbCore = findChild(this.sceneObject, "OrbCore");
    this.halo = findChild(this.sceneObject, "OrbHalo");
    if (this.orbCore !== null) {
      const vis = visualOf(this.orbCore);
      if (vis !== null && vis.mainMaterial !== null) {
        this.orbMat = vis.mainMaterial;
      }
    }
    if (this.halo !== null) {
      const vis = visualOf(this.halo);
      if (vis !== null && vis.mainMaterial !== null) {
        this.haloMat = vis.mainMaterial;
      }
    }

    this.createEvent("OnStartEvent").bind(() => {
      SoundcraftBus.onHit.add((info: HitInfo) => this.onAnyHit(info));
      SoundcraftBus.onDemoChanged.add((playing: boolean) => {
        if (playing) {
          this.gentlePulse(0.5);
        }
      });
    });
    this.createEvent("UpdateEvent").bind(() => this.update());
  }

  private onAnyHit(info: HitInfo) {
    const tint = HIT_TINTS[info.instrument] !== undefined ? HIT_TINTS[info.instrument] : this.orbBaseColor;
    const orb = this.orbCore;
    const halo = this.halo;
    this.pulsing = true;
    animate({
      duration: 0.4,
      easing: "ease-out-quad",
      update: (t: number) => {
        const s = 1 + 0.42 * Math.sin(Math.PI * Math.min(1, t * 1.15));
        if (orb !== null) {
          orb.getTransform().setLocalScale(new vec3(this.orbBase.x * s, this.orbBase.y * s, this.orbBase.z * s));
        }
        if (halo !== null) {
          const h = this.haloBase.x * (1 + t * 0.9);
          halo.getTransform().setLocalScale(new vec3(h, this.haloBase.y, h));
        }
        const mix = this.lerp(tint, this.orbBaseColor, Math.min(1, t * t));
        if (this.orbMat !== null) {
          this.orbMat.mainPass.baseColor = mix;
        }
        if (this.haloMat !== null) {
          const hf = this.lerp(tint, new vec4(0.16, 0.1, 0.3, 1), Math.min(1, t * 1.4));
          this.haloMat.mainPass.baseColor = hf;
        }
      },
      ended: () => {
        this.pulsing = false;
        if (orb !== null) {
          orb.getTransform().setLocalScale(this.orbBase);
        }
        if (halo !== null) {
          halo.getTransform().setLocalScale(this.haloBase);
        }
        if (this.orbMat !== null) {
          this.orbMat.mainPass.baseColor = this.orbBaseColor;
        }
      },
    });
  }

  /** Small breath used on demo transitions (no color change). */
  private gentlePulse(strength: number) {
    const orb = this.orbCore;
    animate({
      duration: 0.5,
      easing: "ease-out-quad",
      update: (t: number) => {
        if (this.pulsing) {
          return; // a real hit pulse takes priority
        }
        const s = 1 + strength * Math.sin(Math.PI * t);
        if (orb !== null) {
          orb.getTransform().setLocalScale(new vec3(this.orbBase.x * s, this.orbBase.y * s, this.orbBase.z * s));
        }
      },
    });
  }

  private update() {
    const dt = getDeltaTime();
    this.time += dt;
    // Breathe with the demo beat (70 BPM) while it plays and no hit pulse owns the orb.
    if (SoundcraftBus.demoPlaying && !this.pulsing) {
      const beat = 60.0 / SoundcraftBus.demoBpm;
      const breathe = 1 + 0.07 * Math.sin((this.time * Math.PI * 2) / beat);
      if (this.orbCore !== null) {
        this.orbCore.getTransform().setLocalScale(
          new vec3(this.orbBase.x * breathe, this.orbBase.y * breathe, this.orbBase.z * breathe)
        );
      }
    }
    // Slow idle spin keeps the room alive even before anyone plays.
    this.spinAngle += 6 * dt; // degrees per second
    this.sceneObject.getTransform().setLocalRotation(quat.fromEulerAngles(0, this.spinAngle, 0));
  }

  private lerp(a: vec4, b: vec4, t: number): vec4 {
    return new vec4(
      a.x + (b.x - a.x) * t,
      a.y + (b.y - a.y) * t,
      a.z + (b.z - a.z) * t,
      a.w + (b.w - a.w) * t
    );
  }
}
