/**
 * TrackCard.ts — one track card on the Orbit stage arc.
 *
 * A card is a single quad + a small hierarchy of labels and glyph quads:
 *   - colour edge (processed = 95% alpha, material-only = 50%, empty = 20%)
 *   - name label 19 mm caps (above the 0.7° text floor at 1.5 m)
 *   - status dot (hollow = empty, filled = material, core = processed)
 *   - insert dots (max 3, then +n)
 *   - volume tick on the right edge
 *   - 8-cell bar strip (≈10 mm cells — the 0.25° glyph floor)
 */

// Contract: constructed from OrbitSessionController; no script inputs here.

export class TrackCard {
  private root: SceneObject;

  constructor(
    parent: SceneObject,
    private data: any,
    private xMm: number,
    private yMm: number,
    private dMm: number,
    private wMm: number,
    private hMm: number,
    private cardMat: Material.Material,
    private textMat: Material.Material,
    private font: Font,
  ) {
    this.root = global.scene.createSceneObject("card-" + String(data.name));
    this.root.setParent(parent);
  }

  get sceneObject(): SceneObject {
    return this.root;
  }

  build() {
    const t = this.data;
    const hasMaterial = t.clips && t.clips.length > 0;
    const processed = t.inserts && t.inserts.length > 0;
    const [r, g, b] = TrackCard.hexToRgb(t.color);

    // card body
    const body = this.quad("body", 0, 0, this.wMm, this.hMm);
    body.mainPass.baseColor = new vec4(1, 1, 1, hasMaterial ? 0.08 : 0.04);

    // colour edge — intensity encodes processed vs material vs empty
    const edgeA = processed ? 0.95 : hasMaterial ? 0.5 : 0.2;
    const edge = this.quad("edge", -this.wMm / 2 + 6, 0, 4.5, this.hMm - 18);
    edge.mainPass.baseColor = new vec4(r, g, b, edgeA);

    // name (19 mm caps ≈ 0.73° at 1.5 m)
    const name = this.label("name", -this.wMm / 2 + 15, this.hMm / 2 - 28,
      String(t.name).toUpperCase(), 19, new vec4(0.91, 0.93, 0.95, 0.9));

    // status dot
    const dotX = this.wMm / 2 - 15, dotY = this.hMm / 2 - 20;
    const dot = this.quad("status-dot", dotX, dotY, 12, 12);
    dot.mainPass.baseColor = hasMaterial ? new vec4(r, g, b, 0.95) : new vec4(1, 1, 1, 0.12);
    if (processed) {
      const core = this.quad("status-core", dotX, dotY, 4, 4);
      core.mainPass.baseColor = new vec4(0.04, 0.05, 0.06, 1);
    }

    // insert dots (max 3)
    const nIns = (t.inserts || []).length;
    for (let i = 0; i < Math.min(3, nIns); i++) {
      const d = this.quad("ins-" + i, -this.wMm / 2 + 17 + i * 9, this.hMm / 2 - 43, 5.2, 5.2);
      d.mainPass.baseColor = new vec4(1, 1, 1, 0.65);
    }
    if (nIns === 0) {
      this.label("dry", -this.wMm / 2 + 15, this.hMm / 2 - 46, "DRY", 10,
        new vec4(1, 1, 1, 0.42));
    }

    // volume tick (right edge) — level = (db + 24) / 24
    const lvl = Math.max(0, Math.min(1, (t.volumeDb + 24) / 24));
    const rail = this.quad("vol-rail", this.wMm / 2 - 11, 0, 2.4, 78);
    rail.mainPass.baseColor = new vec4(1, 1, 1, 0.18);
    const vy = 31 - 78 * lvl; // from +31 (0 dB) down
    const mark = this.quad("vol-mark", this.wMm / 2 - 11, vy, 6.8, 2.4);
    mark.mainPass.baseColor = new vec4(r, g, b, 0.9);

    // bar strip (glyphs, ≈10 mm cells)
    const bars = Math.max(1, t.bars || 8);
    const pad = 10;
    const cellW = (this.wMm - 2 * pad - (bars - 1) * 1.6) / bars;
    for (let bIdx = 0; bIdx < bars; bIdx++) {
      const covered = (t.clips || []).some(
        (c: any) => c.startBar <= bIdx + 1 && bIdx + 1 <= c.endBar
      );
      const cell = this.quad("bar-" + (bIdx + 1),
        -this.wMm / 2 + pad + bIdx * (cellW + 1.6), -this.hMm / 2 + 19.5, cellW, 11);
      cell.mainPass.baseColor = covered
        ? new vec4(r, g, b, 0.95)
        : new vec4(1, 1, 1, 0.16);
    }

    // clip span caption (supportive sub-floor text)
    const first = (t.clips || [])[0];
    const span = first ? `${first.startBar}\u2013${first.endBar}` : "\u2013";
    this.label("span", -this.wMm / 2 + pad, -this.hMm / 2 + 33, span, 11,
      new vec4(1, 1, 1, 0.6));
    this.label("volcap", this.wMm / 2 - 17, -this.hMm / 2 + 33,
      `${t.volumeDb.toFixed(0)} dB`, 11, new vec4(1, 1, 1, 0.6));
  }

  // ------------------------------------------------------------------
  private mmObj(name: string, xmm: number, ymm: number): SceneObject {
    const so = global.scene.createSceneObject(name);
    so.setParent(this.root);
    so.getTransform().setLocalPosition(new vec3(xMm * 0.1, yMm * 0.1, 0));
    return so;
  }

  private quad(name: string, xmm: number, ymm: number, wMm: number, hMm: number): Image {
    const so = this.mmObj(name, xmm, ymm);
    so.getTransform().setLocalScale(new vec3(wMm * 0.1, hMm * 0.1, 1));
    const img = so.createComponent(Component.Image);
    img.mainMaterial = this.cardMat;
    return img;
  }

  private label(name: string, xmm: number, ymm: number, str: string,
                sizeMm: number, color: vec4): Text {
    const so = this.mmObj(name, xmm, ymm);
    const txt = so.createComponent(Component.Text);
    txt.font = this.font;
    txt.material = this.textMat;
    txt.text = str;
    txt.size = sizeMm * 0.1 * 10;
    txt.textFill.color = color;
    txt.alignment = HorizontalTextAlignment.Left;
    txt.verticalAlignment = VerticalTextAlignment.Center;
    return txt;
  }

  static hexToRgb(hex: string): [number, number, number] {
    const n = parseInt(String(hex).replace("#", ""), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
}
