/**
 * OrbitSessionController.ts — Orbit AR-first track-progress stage for Snap Spectacles.
 *
 * Builds the IA described in docs/AR-INFORMATION-ARCHITECTURE.md:
 *   - session ring (8 bar segments) at (-330, +40) mm, R 110 mm, depth 1500 mm
 *   - track cards on a shallow arc, theta -2.5°..+17.5°, depth 1450..1650 mm
 *   - bounce plaque at (-330, -285) mm, 200 x 104 mm
 *
 * Lens Studio world units are CENTIMETRES; the IA is millimetres at 1.5 m,
 * so every coordinate is divided by 10 (mm -> LS units).
 *
 * Data: the same soundcraft-orbit/session@1 JSON the web companion uses,
 * fetched via RemoteServiceModule from `dataUrl`.
 */

// @input SceneObject ringRoot      {"hint":"Empty SceneObject at world origin"}
// @input SceneObject cardsRoot     {"hint":"Empty SceneObject at world origin"}
// @input SceneObject plaqueRoot    {"hint":"Empty SceneObject at world origin"}
// @input Asset.Material segmentMat {"hint":"Unlit fullframe-pass material; baseColor set per state"}
// @input Asset.Material cardMat    {"hint":"Unlit material for card quads"}
// @input Asset.Material textMat    {"hint":"Text material for Component.Text"}
// @input Asset.Font font           {"hint":"Icon/Editorium font, weight bold"}
// @input Asset.RemoteServiceModule remoteService {"hint":"Remote Service module with dataUrl host allow-listed"}
// @input string dataUrl            {"hint":"https://…/data/session.json (soundcraft-orbit/session@1)"}

import { TrackCard } from "./TrackCard";
import { SessionDataSource } from "./SessionDataSource";

const MM = 0.1; // mm -> Lens Studio units (cm)

// IA geometry — single source of truth mirrored from web/app.js
const RING = { x: -330, y: 40, d: 1500, r: 110, th: 26 };
const CARD = { w: 84, h: 140, d0: 1450, dd: 40, th0: -2.5, dth: 4.0, y: -60, bow: 20 };
const PLAQUE = { x: -330, y: -285, d: 1500, w: 200, h: 104 };
const TRACK_ORDER = ["Kick", "Snare", "Hats", "Bass", "Keys", "Lead"];

@component
export class OrbitSessionController extends BaseScriptComponent {
  private cards: TrackCard[] = [];
  private ringSegments: SceneObject[] = [];
  private plaque: SceneObject | null = null;
  private source: SessionDataSource | null = null;

  onAwake() {
    this.source = new SessionDataSource(this.remoteService, this.dataUrl);
    this.source.onData = (data) => this.build(data);
    this.source.fetch();
  }

  // ------------------------------------------------------------------
  private build(data: any) {
    const bars: number = data.session.bars;
    const orderIdx = (name: string) => {
      const i = TRACK_ORDER.indexOf(name);
      return i < 0 ? 99 : i;
    };
    const tracks = [...data.tracks].sort(
      (a: any, b: any) => orderIdx(a.name) - orderIdx(b.name) || a.id - b.id
    );

    this.buildRing(bars, data);
    tracks.forEach((t: any, i: number) => this.buildCard(t, i, tracks.length, data));
    if (data.bounces && data.bounces.length > 0) this.buildPlaque(data.bounces[0]);
  }

  private mmObject(parent: SceneObject, name: string): SceneObject {
    const so = global.scene.createSceneObject(name);
    so.setParent(parent);
    return so;
  }

  private place(so: SceneObject, xmm: number, ymm: number, dmm: number) {
    const t = so.getTransform();
    t.setWorldPosition(new vec3(xmm * MM, ymm * MM, -dmm * MM));
  }

  private quad(parent: SceneObject, name: string, xmm: number, ymm: number, dmm: number,
               wmm: number, hmm: number, mat: Material.Material): Image {
    const so = this.mmObject(parent, name);
    this.place(so, xmm, ymm, dmm);
    so.getTransform().setLocalScale(new vec3(wmm * MM, hmm * MM, 1));
    const img = so.createComponent(Component.Image);
    img.mainMaterial = mat;
    img.mainPass.stretchMode = StretchMode.Stretch;
    img.addMaterial(new AssignMaterial(mat)); // resolve: main pass only
    return img;
  }

  private label(parent: SceneObject, name: string, xmm: number, ymm: number, dmm: number,
                str: string, sizeMm: number, color: vec4): Text {
    const so = this.mmObject(parent, name);
    this.place(so, xmm, ymm, dmm);
    const txt = so.createComponent(Component.Text);
    txt.font = this.font;
    txt.material = this.textMat;
    txt.text = str;
    txt.size = sizeMm * MM * 10; // font size in LS units; tune per font metrics
    txt.textFill.color = color;
    txt.alignment = HorizontalTextAlignment.Center;
    txt.verticalAlignment = VerticalTextAlignment.Center;
    return txt;
  }

  // ------------------------------------------------------------------
  private buildRing(bars: number, data: any) {
    const seg = 360 / bars;
    for (let k = 0; k < bars; k++) {
      const cov = this.barCoverage(k + 1, data);
      const angle = -90 + (k + 0.5) * seg; // degrees, 0 = up on the ring
      const so = this.mmObject(this.ringRoot, `bar-${k + 1}`);
      this.place(so, RING.x, RING.y, RING.d);
      const rot = so.getTransform();
      rot.setLocalRotation(quat.fromEuler(0, 0, angle));

      const img = so.createComponent(Component.Image);
      img.mainMaterial = this.segmentMat;
      // segment quad: a thin rect offset outward from ring center
      so.getTransform().setLocalPosition(
        new vec3(RING.x * MM, (RING.y + RING.r - RING.th / 2) * MM, -RING.d * MM));
      so.getTransform().setLocalScale(
        new vec3(2 * Math.PI * (RING.r - RING.th / 2) * (seg / 360) * 0.82 * MM, RING.th * MM, 1));
      const a = cov <= 0 ? 0.12 : 0.16 + 0.74 * cov;
      img.mainPass.baseColor = new vec4(0.91, 0.93, 0.95, a);
    }

    this.label(this.ringRoot, "bpm", RING.x, RING.y + 4, RING.d,
      `${Math.round(data.session.bpm)}`, 30, new vec4(0.91, 0.93, 0.95, 0.95));
    this.label(this.ringRoot, "bpm-cap", RING.x, RING.y - 14, RING.d,
      "BPM", 11, new vec4(0.91, 0.93, 0.95, 0.55));
    this.label(this.ringRoot, "session-name", RING.x, RING.y + RING.r + 16, RING.d,
      String(data.session.name).toUpperCase(), 13, new vec4(0.91, 0.93, 0.95, 0.8));
  }

  private barCoverage(k: number, data: any): number {
    const mats = data.tracks.filter((t: any) => t.clips && t.clips.length > 0);
    if (mats.length === 0) return 0;
    let n = 0;
    for (const t of mats) {
      if (t.clips.some((c: any) => c.startBar <= k && k <= c.endBar)) n++;
    }
    return n / mats.length;
  }

  // ------------------------------------------------------------------
  private buildCard(t: any, i: number, n: number, data: any) {
    const th = ((CARD.th0 + i * CARD.dth) * Math.PI) / 180;
    const d = CARD.d0 + i * CARD.dd;
    const x = d * Math.sin(th);
    const y = CARD.y + CARD.bow * Math.sin((Math.PI * i) / Math.max(1, n - 1));
    const card = new TrackCard(this.cardsRoot, t, x, y, d, CARD.w, CARD.h,
      this.cardMat, this.textMat, this.font);
    card.build();
    this.cards.push(card);
  }

  // ------------------------------------------------------------------
  private buildPlaque(b: any) {
    const so = this.quad(this.plaqueRoot, "bounce-plaque",
      PLAQUE.x, PLAQUE.y, PLAQUE.d, PLAQUE.w, PLAQUE.h, this.cardMat);
    so.mainPass.baseColor = new vec4(0.06, 0.07, 0.09, 0.5);

    this.label(this.plaqueRoot, "plaque-cap", PLAQUE.x, PLAQUE.y + 34, PLAQUE.d,
      "MIX BOUNCE", 10, new vec4(0.91, 0.93, 0.95, 0.6));
    this.label(this.plaqueRoot, "plaque-lufs", PLAQUE.x - 20, PLAQUE.y + 6, PLAQUE.d,
      b.lufs.toFixed(1), 34, new vec4(0.91, 0.93, 0.95, 0.95));
    this.label(this.plaqueRoot, "plaque-lufs-cap", PLAQUE.x + 52, PLAQUE.y + 6, PLAQUE.d,
      "LUFS", 10, new vec4(0.91, 0.93, 0.95, 0.5));
    this.label(this.plaqueRoot, "plaque-peak", PLAQUE.x, PLAQUE.y - 14, PLAQUE.d,
      `PK ${b.peakDb.toFixed(1)} dBFS · TP ${b.truePeakDb.toFixed(1)} dBTP`, 11,
      new vec4(0.91, 0.93, 0.95, 0.75));
    this.label(this.plaqueRoot, "plaque-age", PLAQUE.x, PLAQUE.y - 32, PLAQUE.d,
      `${(b.bytes / 1e6).toFixed(1)} MB · ${b.seconds.toFixed(1)} s`, 10,
      new vec4(0.91, 0.93, 0.95, 0.45));
  }
}
