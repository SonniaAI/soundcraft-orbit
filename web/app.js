/* Orbit — AR-first track-progress stage (web companion).
 *
 * Renders the SAME information architecture as the Snap Spectacles Lens
 * (lens/): one geometry, expressed in millimetres at a 1.5 m reference depth,
 * constrained to the glasses' field of view (51° horizontal, 30° assumed
 * vertical). The FOV overlay dims everything the glasses would NOT show.
 *
 * Layout constants are the single source of truth mirrored in
 * lens/Scripts/OrbitSessionController.ts and docs/AR-INFORMATION-ARCHITECTURE.md.
 */
"use strict";

/* ------------------------------------------------------------------ */
/* IA geometry (mm at D0 = 1500 mm)                                    */
/* ------------------------------------------------------------------ */
const D0 = 1500;
const FOV_H = 51, FOV_V = 30;                       // degrees (founder envelope / conservative vertical)
const FOV_HALF_W = D0 * Math.tan((FOV_H / 2) * Math.PI / 180);  // ≈ 717 mm
const FOV_HALF_H = D0 * Math.tan((FOV_V / 2) * Math.PI / 180);  // ≈ 402 mm
const DEG_MM = D0 * Math.PI / 180;                  // mm per degree ≈ 26.2

const RING = { x: -330, y: 40, d: 1500, r: 110, th: 26, gapDeg: 6 };
const CARD = { w: 84, h: 140, d0: 1450, dd: 40, th0: -2.5, dth: 4.0, y: -60, bow: 20 };
const PLAQUE = { x: -330, y: -285, d: 1500, w: 200, h: 104 };

const TRACK_ORDER = ["Kick", "Snare", "Hats", "Bass", "Keys", "Lead"];

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
let DATA = null;
let showFov = true, showRuler = false, playing = false;
let audio = null;
let bridgeLive = false;
let lastGeneratedAt = null;
let hoverCard = null;

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
let W = 0, H = 0, DPR = 1, S = 1, CX = 0, CY = 0;

/* ------------------------------------------------------------------ */
/* Projection: mm at depth d -> px                                     */
/* ------------------------------------------------------------------ */
function proj(x, y, d = D0) {
  const k = (D0 / d) * S;
  return [CX + x * k, CY - y * k, k];
}

function resize() {
  DPR = window.devicePixelRatio || 1;
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
  canvas.style.width = W + "px"; canvas.style.height = H + "px";
  // fit content span: x ∈ [-460, +730], y ∈ [-350, +260]
  S = Math.min(W / 1300, H / 760);
  CX = W * 0.46; CY = H * 0.54;
}
window.addEventListener("resize", resize);
resize();

/* ------------------------------------------------------------------ */
/* Drawing helpers                                                     */
/* ------------------------------------------------------------------ */
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function rrect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function text(str, x, y, mm, opts = {}) {
  const px = mm * S;
  ctx.font = `${opts.weight || 500} ${px}px ${opts.mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : "\"Avenir Next\", \"Segoe UI\", system-ui, sans-serif"}`;
  ctx.fillStyle = opts.color || "rgba(232,236,241,0.9)";
  ctx.textAlign = opts.align || "left";
  ctx.textBaseline = opts.baseline || "alphabetic";
  if (opts.tracking) {           // simple letter-spacing for small caps labels
    const chars = [...str];
    const total = chars.reduce((a, c) => a + ctx.measureText(c).width + px * opts.tracking, 0) - px * opts.tracking;
    let cx0 = opts.align === "center" ? x - total / 2 : opts.align === "right" ? x - total : x;
    ctx.textAlign = "left";
    for (const c of chars) { ctx.fillText(c, cx0, y); cx0 += ctx.measureText(c).width + px * opts.tracking; }
  } else {
    ctx.fillText(str, x, y);
  }
}

/* ------------------------------------------------------------------ */
/* Data-derived state                                                  */
/* ------------------------------------------------------------------ */
function materialTracks() { return DATA.tracks.filter(t => t.clips.length > 0); }

function barCoverage(k) { // 0..1 fraction of material tracks present in bar k (1-based)
  const mats = materialTracks();
  if (!mats.length) return 0;
  let n = 0;
  for (const t of mats) {
    if (t.clips.some(c => c.startBar <= k && k <= c.endBar)) n++;
  }
  return n / mats.length;
}

function cardGeom(i, n) {
  const th = (CARD.th0 + i * CARD.dth) * Math.PI / 180;
  const d = CARD.d0 + i * CARD.dd;
  const x = d * Math.sin(th);
  const y = CARD.y + CARD.bow * Math.sin(Math.PI * i / Math.max(1, n - 1));
  return { x, y, d };
}

function sortedCards() {
  const tracks = [...DATA.tracks].sort(
    (a, b) => (TRACK_ORDER.indexOf(a.name) + 99) * (TRACK_ORDER.includes(a.name) ? 1 : 0) - (TRACK_ORDER.indexOf(b.name) + 99) * (TRACK_ORDER.includes(b.name) ? 1 : 0)
      || a.id - b.id);
  return tracks.map((t, i) => ({ t, g: cardGeom(i, tracks.length) }))
    .sort((a, b) => b.g.d - a.g.d);          // far first (painter)
}

function playheadBar() {
  if (!playing || !audio) return null;
  const spb = DATA.session.seconds / DATA.session.bars;
  const bar = Math.floor(audio.currentTime / spb) + 1;
  return Math.min(DATA.session.bars, Math.max(1, bar));
}

/* ------------------------------------------------------------------ */
/* Stage pieces                                                        */
/* ------------------------------------------------------------------ */
function drawRing() {
  const { x, y, d, r, th, gapDeg } = RING;
  const [cx, cy] = proj(x, y, d);
  const R = r * S, T = th * S;
  const bars = DATA.session.bars;
  const seg = 360 / bars;
  const phb = playheadBar();

  for (let k = 0; k < bars; k++) {
    const cov = barCoverage(k + 1);
    const segRad = seg * Math.PI / 180, gapRad = gapDeg * Math.PI / 180;
    const start = -Math.PI / 2 + k * segRad + gapRad / 2;
    const end = -Math.PI / 2 + (k + 1) * segRad - gapRad / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, start, end);
    ctx.arc(cx, cy, R - T, end, start, true);
    ctx.closePath();
    if (cov > 0) {
      ctx.fillStyle = `rgba(232,236,241,${0.16 + 0.74 * cov})`;
      ctx.fill();
      if (cov === 1 && phb === k + 1) { ctx.fillStyle = "rgba(255,176,59,0.85)"; ctx.fill(); }
    }
    ctx.strokeStyle = "rgba(232,236,241,0.22)";
    ctx.lineWidth = Math.max(1, 0.8 * S);
    ctx.stroke();
    // bar number glyph (small, at mid-arc, outside)
    const mid = (start + end) / 2;
    const tx = cx + Math.cos(mid) * (R + T * 0.9), ty = cy + Math.sin(mid) * (R + T * 0.9);
    text(String(k + 1), tx, ty, 9, { align: "center", baseline: "middle",
      color: cov === 1 ? "rgba(232,236,241,0.8)" : "rgba(232,236,241,0.35)" });
  }

  // playhead needle
  if (phb) {
    const frac = audio ? (audio.currentTime / (DATA.session.seconds / bars)) % 1 : 0;
    const ang = -Math.PI / 2 + (phb - 1 + frac) * seg * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * (R - T * 1.6), cy + Math.sin(ang) * (R - T * 1.6));
    ctx.lineTo(cx + Math.cos(ang) * (R + 10 * S * 0.1 + 6 * S), cy + Math.sin(ang) * (R + 6 * S));
    ctx.strokeStyle = "rgba(255,176,59,0.95)";
    ctx.lineWidth = Math.max(1.5, 3 * S);
    ctx.stroke();
  }

  // center readout
  text(`${Math.round(DATA.session.bpm)}`, cx, cy + 2 * S, 30, { align: "center", weight: 700 });
  text("BPM", cx, cy + 16 * S, 11, { align: "center", tracking: 0.28, color: "rgba(232,236,241,0.55)" });
  text(`${materialTracks().length}/${DATA.tracks.length} TRACKS`, cx, cy - 12 * S, 11,
    { align: "center", tracking: 0.18, color: "rgba(232,236,241,0.7)" });
  text(DATA.session.name.toUpperCase(), cx, cy - R - 16 * S, 13, { align: "center", tracking: 0.22 });
}

function drawCard(t, g) {
  const [cx, cy, k] = proj(g.x, g.y, g.d);
  const w = CARD.w * S, h = CARD.h * S;
  const x0 = cx - w / 2, y0 = cy - h / 2;
  const phb = playheadBar();
  const active = phb && t.clips.some(c => c.startBar <= phb && phb <= c.endBar);
  const hov = hoverCard === t.id;

  rrect(x0, y0, w, h, 9 * S);
  ctx.fillStyle = `rgba(255,255,255,${(active ? 0.16 : 0.07) * (0.8 + 0.2 * k)})`;
  ctx.fill();
  ctx.strokeStyle = active ? "rgba(255,255,255,0.65)" : hov ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.18)";
  ctx.lineWidth = active ? 1.6 * S : Math.max(1, 0.9 * S);
  ctx.stroke();

  // colour edge — intensity encodes processed (inserts)
  const edgeA = t.processed ? 0.95 : t.clips.length ? 0.5 : 0.2;
  ctx.fillStyle = rgba(t.color, edgeA);
  rrect(x0 + 5 * S, y0 + 7 * S, 4 * S, h - 14 * S, 2 * S);
  ctx.fill();

  // name (18 mm caps ≈ 0.69° at 1.5 m — the legibility floor for text)
  text(t.name.toUpperCase(), x0 + 13 * S, y0 + 20 * S, 13, { weight: 700, tracking: 0.06 });

  // status dot: hollow=empty, filled=material, core=processed
  const dx = x0 + w - 12 * S, dy = y0 + 15 * S, dr = 5.5 * S;
  ctx.beginPath(); ctx.arc(dx, dy, dr, 0, 7);
  if (t.clips.length) { ctx.fillStyle = rgba(t.color, 0.95); ctx.fill(); }
  ctx.strokeStyle = t.clips.length ? rgba(t.color, 0.95) : "rgba(232,236,241,0.35)";
  ctx.lineWidth = Math.max(1, S);
  ctx.stroke();
  if (t.processed) { ctx.beginPath(); ctx.arc(dx, dy, dr * 0.38, 0, 7); ctx.fillStyle = "#0b0d10"; ctx.fill(); }

  // insert dots (max 3) + count
  const nIns = t.inserts.length;
  for (let i = 0; i < Math.min(3, nIns); i++) {
    ctx.beginPath(); ctx.arc(x0 + 15 * S + i * 8 * S, y0 + 30 * S, 2.2 * S, 0, 7);
    ctx.fillStyle = "rgba(232,236,241,0.55)"; ctx.fill();
  }
  if (nIns > 3) text(`+${nIns - 3}`, x0 + 15 * S + 3 * 8 * S, y0 + 33 * S, 9, { color: "rgba(232,236,241,0.5)" });
  if (!nIns) text("dry", x0 + 13 * S, y0 + 33 * S, 9, { color: "rgba(232,236,241,0.35)", tracking: 0.1 });

  // volume tick (right edge)
  const volLevel = Math.max(0, Math.min(1, (t.volumeDb + 24) / 24));
  const vx = x0 + w - 9 * S, vy0 = y0 + 44 * S, vh = 78 * S;
  ctx.strokeStyle = "rgba(232,236,241,0.14)"; ctx.lineWidth = 2.4 * S;
  ctx.beginPath(); ctx.moveTo(vx, vy0); ctx.lineTo(vx, vy0 + vh); ctx.stroke();
  ctx.strokeStyle = rgba(t.color, 0.9);
  ctx.beginPath(); ctx.moveTo(vx - 3 * S, vy0 + vh * (1 - volLevel)); ctx.lineTo(vx + 3 * S, vy0 + vh * (1 - volLevel)); ctx.stroke();

  // 8-bar mini grid (progress glyph strip)
  const cells = DATA.session.bars, pad = 7 * S, cw2 = (w - 2 * pad - (cells - 1) * 1.6 * S) / cells;
  for (let b = 0; b < cells; b++) {
    const covered = t.clips.some(c => c.startBar <= b + 1 && b + 1 <= c.endBar);
    const bx = x0 + pad + b * (cw2 + 1.6 * S), by = y0 + h - 17 * S;
    if (covered) { ctx.fillStyle = rgba(t.color, phb === b + 1 ? 1 : 0.85); }
    else { ctx.fillStyle = "rgba(232,236,241,0.09)"; }
    ctx.fillRect(bx, by, cw2, 9 * S);
  }
  // clip span underline
  ctx.fillStyle = "rgba(232,236,241,0.35)";
  text(`${t.clips[0] ? t.clips[0].startBar : "-"}–${t.clips[0] ? t.clips[0].endBar : "-"}`,
    x0 + pad, y0 + h - 21 * S, 9, { color: "rgba(232,236,241,0.45)", mono: true });
  text(t.volumeDb.toFixed(0).padStart(2, " ") + " dB", x0 + w - pad, y0 + h - 21 * S, 9,
    { color: "rgba(232,236,241,0.45)", align: "right", mono: true });
}

function drawPlaque() {
  const b = DATA.bounces[0];
  if (!b) return;
  const { x, y, d, w, h } = PLAQUE;
  const [cx, cy] = proj(x, y, d);
  const W2 = w * S, H2 = h * S;
  const x0 = cx - W2 / 2, y0 = cy - H2 / 2;

  rrect(x0, y0, W2, H2, 9 * S);
  ctx.fillStyle = "rgba(255,255,255,0.06)"; ctx.fill();
  ctx.strokeStyle = "rgba(255,176,59,0.5)"; ctx.lineWidth = Math.max(1, 1.1 * S); ctx.stroke();

  ctx.fillStyle = "rgba(255,176,59,0.9)";
  rrect(x0 + 5 * S, y0 + 7 * S, 4 * S, H2 - 14 * S, 2 * S); ctx.fill();

  text("MIX BOUNCE", x0 + 15 * S, y0 + 20 * S, 10, { tracking: 0.3, color: "rgba(232,236,241,0.6)" });
  text(b.lufs.toFixed(1), x0 + 15 * S, y0 + 52 * S, 30, { weight: 700, mono: true });
  text("LUFS", x0 + 15 * S + ctx.measureText("").width + 62 * S, y0 + 52 * S, 10,
    { tracking: 0.22, color: "rgba(232,236,241,0.5)" });
  text(`PK ${b.peakDb.toFixed(1)} dBFS · TP ${b.truePeakDb.toFixed(1)} dBTP`,
    x0 + 15 * S, y0 + 70 * S, 11, { mono: true, color: "rgba(232,236,241,0.75)" });
  const age = b.capturedAt ? timeAgo(b.capturedAt) : "";
  text(`${age} · ${(b.bytes / 1e6).toFixed(1)} MB · ${b.seconds.toFixed(1)} s`,
    x0 + 15 * S, y0 + 88 * S, 10, { mono: true, color: "rgba(232,236,241,0.45)" });
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 120) return "just now";
  if (s < 7200) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/* ------------------------------------------------------------------ */
/* FOV overlay + ruler                                                 */
/* ------------------------------------------------------------------ */
function drawFov() {
  const [x0, y0] = proj(-FOV_HALF_W, FOV_HALF_H);
  const [x1, y1] = proj(FOV_HALF_W, -FOV_HALF_H);
  ctx.save();
  ctx.fillStyle = "rgba(4, 6, 8, 0.6)";
  ctx.fillRect(0, 0, W, y0); ctx.fillRect(0, y1, W, H - y1);
  ctx.fillRect(0, y0, x0, y1 - y0); ctx.fillRect(x1, y0, W - x1, y1 - y0);
  ctx.restore();

  ctx.strokeStyle = "rgba(255,176,59,0.85)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([7, 6]);
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.setLineDash([]);

  const label = `SNAP SPECTACLES FOV ${FOV_H}° × ${FOV_V}° @ ${D0 / 1000} m — outside = not rendered on glasses`;
  text(label, (x0 + x1) / 2, y0 - 10, 11, { align: "center", color: "rgba(255,176,59,0.9)", tracking: 0.08 });
}

function drawRuler() {
  const y = proj(0, 0)[1];
  ctx.strokeStyle = "rgba(232,236,241,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(proj(-FOV_HALF_W, 0)[0], y); ctx.lineTo(proj(FOV_HALF_W, 0)[0], y); ctx.stroke();
  for (let deg = -25; deg <= 25; deg += 5) {
    const x = proj(deg * DEG_MM, 0)[0];
    const big = deg % 10 === 0;
    ctx.beginPath(); ctx.moveTo(x, y - (big ? 9 : 5)); ctx.lineTo(x, y + (big ? 9 : 5)); ctx.stroke();
    if (big) text(`${deg}°`, x, y + 24, 10, { align: "center", color: "rgba(232,236,241,0.5)" });
  }
}

/* ------------------------------------------------------------------ */
/* Render loop                                                         */
/* ------------------------------------------------------------------ */
function render() {
  requestAnimationFrame(render);          // keep the loop alive even if a frame throws
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!DATA) return;

  if (showRuler) drawRuler();
  for (const { t, g } of sortedCards()) drawCard(t, g);
  drawRing();
  drawPlaque();
  if (showFov) drawFov();
}

/* ------------------------------------------------------------------ */
/* Interaction                                                         */
/* ------------------------------------------------------------------ */
function cardAt(px, py) {
  if (!DATA) return null;
  for (const { t, g } of sortedCards()) {          // near-last drawn = topmost; iterate reverse-ish
    const [cx, cy] = proj(g.x, g.y, g.d);
    const w = CARD.w * S, h = CARD.h * S;
    if (px >= cx - w / 2 && px <= cx + w / 2 && py >= cy - h / 2 && py <= cy + h / 2) return t;
  }
  return null;
}

canvas.addEventListener("mousemove", (e) => {
  const t = cardAt(e.clientX, e.clientY);
  hoverCard = t ? t.id : null;
  canvas.style.cursor = t ? "pointer" : "default";
});
canvas.addEventListener("click", (e) => {
  const t = cardAt(e.clientX, e.clientY);
  if (t) openInspect(t);
});

/* ------------------------------------------------------------------ */
/* Inspect modal                                                       */
/* ------------------------------------------------------------------ */
const inspect = document.getElementById("inspect");
function openInspect(t) {
  document.getElementById("inspectName").textContent = t.name;
  document.getElementById("inspectSwatch").style.background = t.color;
  document.getElementById("inspectKind").textContent = `${t.kind} · ${t.clips.length} clip${t.clips.length === 1 ? "" : "s"}`;
  const meta = document.getElementById("inspectMeta");
  const inserts = t.inserts.length ? t.inserts.join(" → ") : "(dry)";
  const cov = t.clips.map(c => `bars ${c.startBar}–${c.endBar} (${c.startSec.toFixed(2)}s → ${c.endSec.toFixed(2)}s)`).join(", ");
  meta.innerHTML = `
    <div><b>CLIP COVERAGE</b>${cov}</div>
    <div><b>INSERTS</b>${inserts}</div>
    <div><b>VOLUME</b>${t.volumeDb.toFixed(1)} dB</div>
    <div><b>PEAK (STEM)</b>${(Math.max(...t.peak) * 100).toFixed(0)} %FS</div>`;
  document.getElementById("inspectFoot").textContent =
    `SoundCraft: session "${DATA.session.name}", track id ${t.id} — read-only CLI inspect.`;
  drawWave(t);
  inspect.classList.remove("hidden");
}
function drawWave(t) {
  const cv = document.getElementById("inspectWave");
  const wpx = cv.clientWidth, hpx = 120;
  cv.width = wpx * 2; cv.height = hpx * 2;
  const c = cv.getContext("2d");
  c.setTransform(2, 0, 0, 2, 0, 0);
  c.clearRect(0, 0, wpx, hpx);
  const n = t.peak.length, bw = wpx / n;
  for (let i = 0; i < n; i++) {
    const a = t.peak[i] * (hpx / 2 - 6);
    c.fillStyle = rgba(t.color, 0.85);
    c.fillRect(i * bw, hpx / 2 - a, Math.max(1, bw - 0.4), a * 2);
  }
  // clip coverage shading
  const secs = DATA.session.seconds;
  for (const cl of t.clips) {
    const x0 = cl.startSec / secs * wpx, x1 = cl.endSec / secs * wpx;
    c.fillStyle = "rgba(232,236,241,0.06)";
    c.fillRect(x0, 0, x1 - x0, hpx);
  }
}
document.getElementById("inspectClose").onclick = () => inspect.classList.add("hidden");
inspect.addEventListener("click", (e) => { if (e.target === inspect) inspect.classList.add("hidden"); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape") inspect.classList.add("hidden"); });

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */
const btnFov = document.getElementById("btnFov");
const btnRuler = document.getElementById("btnRuler");
const btnPlay = document.getElementById("btnPlay");
btnFov.onclick = () => { showFov = !showFov; btnFov.classList.toggle("on", showFov); };
btnRuler.onclick = () => { showRuler = !showRuler; btnRuler.classList.toggle("on", showRuler); };
btnPlay.onclick = () => {
  if (!audio) { audio = new Audio(DATA.mixAudio); audio.addEventListener("ended", () => { playing = false; btnPlay.classList.remove("on"); btnPlay.textContent = "▶ PLAY"; }); }
  if (playing) { audio.pause(); playing = false; btnPlay.classList.remove("on"); btnPlay.textContent = "▶ PLAY"; }
  else { audio.play(); playing = true; btnPlay.classList.add("on"); btnPlay.textContent = "❚❚ PAUSE"; }
};

/* ------------------------------------------------------------------ */
/* Data loading (static baked JSON, or live via the bridge)            */
/* ------------------------------------------------------------------ */
function applyData(d) {
  DATA = d;
  const s = DATA.session;
  document.getElementById("sessionLine").textContent =
    `${s.name} — ${s.bars} bars @ ${s.bpm} BPM · ${s.seconds.toFixed(1)} s · ${s.sampleRate / 1000} kHz`;
  const last = DATA.bounces[0];
  document.getElementById("provenance").textContent =
    `data: ${DATA.inspectSource} · receipt: ${DATA.provenance.receiptTool || "?"} · generated ${DATA.generatedAt} · session file ${s.sessionFile}`;
  if (!lastGeneratedAt || lastGeneratedAt !== d.generatedAt) {
    lastGeneratedAt = d.generatedAt;
    if (audio) { audio.src = DATA.mixAudio; }
  }
}

async function loadStatic() {
  const r = await fetch("data/session.json", { cache: "no-cache" });
  applyData(await r.json());
  requestAnimationFrame(render);
}

async function probeBridge() {
  try {
    const r = await fetch("/api/bridge-info", { cache: "no-cache" });
    if (!r.ok) return false;
    const j = await r.json();
    return !!j.bridge;
  } catch { return false; }
}

async function pollBridge() {
  try {
    const r = await fetch("/api/session", { cache: "no-cache" });
    if (r.ok) {
      const d = await r.json();
      if (d.generatedAt !== (DATA && DATA.generatedAt)) applyData(d);
    }
  } catch { /* keep last good */ }
  setTimeout(pollBridge, 4000);
}

(async function init() {
  await loadStatic();
  if (await probeBridge()) {
    bridgeLive = true;
    const badge = document.getElementById("modeBadge");
    badge.textContent = "LIVE · BRIDGE";
    badge.classList.add("live");
    badge.title = "serve.py re-inspects first-light.scraft with soundcraft-cli; page polls every 4 s";
    pollBridge();
  }
})();
