// The peaRview review map — 3D ANIMATED ASCII at 10× RESOLUTION (step 3, take 5).
// Cells are ~2.2×4 px: glyphs become texture, the grid approaches a plotter. At ~90k
// cells/frame, per-cell drawImage dies — so the blit path is a raw Uint32 FRAMEBUFFER
// compositor: glyphs pre-bake to opaque pixel tiles (terminal semantics: a cell is
// replaced, never blended), tiles block-copy into one ImageData, ONE putImageData per
// frame. Readable text (labels, hover line, fps) draws as a fillText overlay pass.
// donut.c's spirit, scaled up: a true 3D scene perspective-projected onto a character
// grid through a glyph atlas, full redraw every frame on uncapped rAF.
//
// The math is the visual design:
//   · BACKGROUND — a live Julia set (c(t) drifting the cardioid rim) with camera
//     parallax, escape-time luminance ramp in two deep-space tones
//   · LAYOUTS (two, MORPHING — nodes lerp between 3D targets):
//       ≋ flow  — a river through space: chapters are stations on a 3D-meandering
//                 spine, findings fan off in the perpendicular plane (severity-major,
//                 golden-angle), the stream debouches into the verdict basin
//       ✿ orbit — spherical phyllotaxis at every scale: beats on a Fibonacci sphere
//                 around the verdict core, findings on mini-spheres around their beat
//   · PROJECTION — yaw/pitch orbit camera, perspective divide, painter's ordering,
//     DEPTH CUEING (farther glyphs dim toward the void)
//   · EDGES — 3D-sampled character lines with phase-animated flow running downstream
// Encoding unchanged: color = type · size = severity · pulse = blocker · orbiting
// / | \ - = engine-disputed · "?" = question · "+" = praise · gold [brackets] =
// selected. DRAG ROTATES, wheel zooms, idle auto-spins, dblclick re-frames; click a
// node → the detail card in the right rail (the graph is never covered).

import type { RdFinding, ReviewDoc } from "./protocol";

const GOLDEN = Math.PI * (3 - Math.sqrt(5)); // radians

// type → color. ONE table (display-layer remap path — spec decision).
const TYPE_COLOR: Record<string, string> = {
  bug: "#f85149",
  security: "#ff5d8f",
  error_handling: "#f0883e",
  test: "#e3b341",
  api: "#58a6ff",
  design: "#a371f7",
  compat: "#8e96f0",
  perf: "#56d4dd",
  observability: "#39c5cf",
  docs: "#9e9784",
  clarity: "#c9b890",
  style: "#8b949e",
  question: "#7ee787",
  praise: "#3fb950",
};
const SEV_R: Record<string, number> = {
  blocker: 1.9,
  fix_before_merge: 1.5,
  follow_up: 1.15,
  take_or_leave: 0.9,
};
const SEV_GLYPH: Record<string, string> = {
  blocker: "⛔",
  fix_before_merge: "🔶",
  follow_up: "⏳",
  take_or_leave: "💭",
};
const RISK_COLOR: Record<string, string> = {
  low: "#6e7681",
  medium: "#d29922",
  high: "#f85149",
};
const RISK_R: Record<string, number> = { low: 2.1, medium: 2.6, high: 3.1 };
const VERDICT_COLOR: Record<string, string> = {
  ready: "#3fb950",
  ready_with_nits: "#7ee787",
  needs_work: "#d29922",
  blocked: "#f85149",
};
const VERDICT_LABEL: Record<string, string> = {
  ready: "✅ ready",
  ready_with_nits: "✅ ready · with nits",
  needs_work: "🔧 needs work",
  blocked: "⛔ blocked",
};

// Luminance ramps (dense → sparse).
const BG_RAMP = " ··::;;==++xxXX##";
const FLOW = "·∙•∙"; // edge phase chars
const VOID = { r: 0x15, g: 0x19, b: 0x2a }; // what depth fades toward

// ── the gem-mosaic palette (the user's painting, dimmed to background level) ──
// 30 hues × 3 shades (core/mid/rim) + a grayscale set for the skull masses.
const GEM_HUES = 30;
function hslCss(h: number, sat: number, l: number): string {
  const a = sat * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255);
  };
  return `rgb(${f(0)},${f(8)},${f(4)})`;
}
const GEM_PAL: string[][] = [];
const GRAY_PAL: string[] = [];
for (let h = 0; h < GEM_HUES; h++) {
  const hue = (h / GEM_HUES) * 360;
  GEM_PAL.push([
    hslCss(hue, 0.7, 0.40),
    hslCss(hue, 0.65, 0.30),
    hslCss(hue, 0.58, 0.21),
    hslCss(hue, 0.5, 0.12),
  ]);
}
// the skulls are BONE — brighter than the field, near-white mosaic
GRAY_PAL.push(hslCss(220, 0.05, 0.46), hslCss(220, 0.05, 0.35), hslCss(220, 0.05, 0.24), hslCss(220, 0.05, 0.13));
const MORTAR = "#0a0d15";

// ── the finding-shape pool: exotic polyhedra, one per finding family ──────────
// Wireframes in local space (unit radius), edge graphs DERIVED from the vertex sets
// (nearest-neighbor at the minimal edge length), rendered as tumbling 3D cages.
const PHI = (1 + Math.sqrt(5)) / 2;
type V3 = [number, number, number];
interface PolyShape {
  verts: V3[];
  edges: [number, number][];
  /** second-tier chords (the great dodecahedron's pentagram diagonals) */
  chords?: [number, number][];
}
function normShape(verts: V3[]): V3[] {
  const m = Math.max(...verts.map(([x, y, z]) => Math.hypot(x, y, z)));
  return verts.map(([x, y, z]) => [x / m, y / m, z / m] as V3);
}
function dedupe(verts: V3[]): V3[] {
  const seen = new Set<string>();
  const out: V3[] = [];
  for (const v of verts) {
    const k = v.map((c) => c.toFixed(4)).join(",");
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}
function edgesByNearest(verts: V3[], tol = 1.06): [number, number][] {
  let d0 = Infinity;
  const D = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  for (let i = 0; i < verts.length; i++)
    for (let j = i + 1; j < verts.length; j++) d0 = Math.min(d0, D(verts[i], verts[j]));
  const out: [number, number][] = [];
  for (let i = 0; i < verts.length; i++)
    for (let j = i + 1; j < verts.length; j++) if (D(verts[i], verts[j]) < d0 * tol) out.push([i, j]);
  return out;
}
function icosaVerts(): V3[] {
  const v: V3[] = [];
  for (const s1 of [-1, 1])
    for (const s2 of [-1, 1]) {
      v.push([0, s1, s2 * PHI], [s1, s2 * PHI, 0], [s2 * PHI, 0, s1]);
    }
  return normShape(dedupe(v));
}
function dodecaVerts(): V3[] {
  const v: V3[] = [];
  for (const s1 of [-1, 1])
    for (const s2 of [-1, 1]) {
      for (const s3 of [-1, 1]) v.push([s1, s2, s3]);
      v.push([0, s1 / PHI, s2 * PHI], [s1 / PHI, s2 * PHI, 0], [s2 * PHI, 0, s1 / PHI]);
    }
  return normShape(dedupe(v));
}
/** even (cyclic) permutations × all sign combos of |triple|. */
function evenPermSigns(triples: V3[]): V3[] {
  const out: V3[] = [];
  for (const [a, b, c] of triples)
    for (const cyc of [
      [a, b, c],
      [c, a, b],
      [b, c, a],
    ] as V3[])
      for (const s1 of [-1, 1])
        for (const s2 of [-1, 1])
          for (const s3 of [-1, 1]) out.push([cyc[0] * s1, cyc[1] * s2, cyc[2] * s3]);
  return dedupe(out);
}
function buildShapes(): Record<string, PolyShape> {
  const shapes: Record<string, PolyShape> = {};
  // GREAT RHOMBICOSIDODECAHEDRON — 120 verts, 180 edges (12 decagons·20 hexagons·30 squares)
  const grVerts = normShape(
    evenPermSigns([
      [1 / PHI, 1 / PHI, 3 + PHI],
      [2 / PHI, PHI, 1 + 2 * PHI],
      [1 / PHI, PHI * PHI, 3 * PHI - 1],
      [2 * PHI - 1, 2, 2 + PHI],
      [PHI, 3, 2 * PHI],
    ]),
  );
  shapes.grhombi = { verts: grVerts, edges: edgesByNearest(grVerts) };
  // CHAMFERED DODECAHEDRON — Goldberg G(2,0): dual of the frequency-2 geodesic
  // icosahedron (80 verts, 42 faces: 12 pentagons + 30 hexagons)
  const iv = icosaVerts();
  const ie = edgesByNearest(iv);
  const adj = new Map<number, Set<number>>();
  for (const [i, j] of ie) {
    (adj.get(i) ?? adj.set(i, new Set()).get(i)!).add(j);
    (adj.get(j) ?? adj.set(j, new Set()).get(j)!).add(i);
  }
  const ifaces: [number, number, number][] = [];
  for (let i = 0; i < iv.length; i++)
    for (let j = i + 1; j < iv.length; j++)
      for (let k = j + 1; k < iv.length; k++)
        if (adj.get(i)!.has(j) && adj.get(j)!.has(k) && adj.get(i)!.has(k)) ifaces.push([i, j, k]);
  const mids = new Map<string, number>();
  const gv: V3[] = [...iv];
  const midOf = (a: number, b: number): number => {
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    let m = mids.get(k);
    if (m === undefined) {
      const p_: V3 = [
        (gv[a][0] + gv[b][0]) / 2,
        (gv[a][1] + gv[b][1]) / 2,
        (gv[a][2] + gv[b][2]) / 2,
      ];
      const l = Math.hypot(...p_);
      m = gv.length;
      gv.push([p_[0] / l, p_[1] / l, p_[2] / l]);
      mids.set(k, m);
    }
    return m;
  };
  // frequency-2 faces (4 per icosa face), then take the DUAL
  const gfaces: number[][] = [];
  for (const [a, b, c] of ifaces) {
    const ab = midOf(a, b);
    const bc = midOf(b, c);
    const ca = midOf(c, a);
    gfaces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
  }
  const dualVerts: V3[] = gfaces.map((f) => {
    const cx = f.reduce((s2, i) => s2 + gv[i][0], 0) / f.length;
    const cy = f.reduce((s2, i) => s2 + gv[i][1], 0) / f.length;
    const cz = f.reduce((s2, i) => s2 + gv[i][2], 0) / f.length;
    const l = Math.hypot(cx, cy, cz);
    return [cx / l, cy / l, cz / l];
  });
  const edgeFaces = new Map<string, number[]>();
  gfaces.forEach((f, fi) => {
    for (let i = 0; i < f.length; i++) {
      const a = f[i];
      const b = f[(i + 1) % f.length];
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      (edgeFaces.get(k) ?? edgeFaces.set(k, []).get(k)!).push(fi);
    }
  });
  const dualEdges: [number, number][] = [];
  edgeFaces.forEach((fs) => {
    if (fs.length === 2) dualEdges.push([fs[0], fs[1]]);
  });
  shapes.chamfered = { verts: dualVerts, edges: dualEdges };
  // GREAT DODECAHEDRON — 12 verts; boundary = icosa edge graph, the star comes from
  // the pentagram CHORDS (second-distance tier), drawn dimmer
  const gdE = edgesByNearest(iv);
  const dists: number[] = [];
  for (let i = 0; i < iv.length; i++)
    for (let j = i + 1; j < iv.length; j++)
      dists.push(Math.hypot(iv[i][0] - iv[j][0], iv[i][1] - iv[j][1], iv[i][2] - iv[j][2]));
  const uniq = [...new Set(dists.map((d) => d.toFixed(3)))].map(Number).sort((a, b) => a - b);
  const chordD = uniq[1];
  const chords: [number, number][] = [];
  for (let i = 0; i < iv.length; i++)
    for (let j = i + 1; j < iv.length; j++) {
      const d = Math.hypot(iv[i][0] - iv[j][0], iv[i][1] - iv[j][1], iv[i][2] - iv[j][2]);
      if (Math.abs(d - chordD) < 0.01) chords.push([i, j]);
    }
  shapes.greatdodeca = { verts: iv, edges: gdE, chords };
  // GREAT STELLATED DODECAHEDRON (rendered as the stellation spikes): icosa core +
  // 20 spike tips over the face centroids, three edges per spike
  const stV: V3[] = [...iv];
  const stE: [number, number][] = [];
  for (const [a, b, c] of ifaces) {
    const cx = (iv[a][0] + iv[b][0] + iv[c][0]) / 3;
    const cy = (iv[a][1] + iv[b][1] + iv[c][1]) / 3;
    const cz = (iv[a][2] + iv[b][2] + iv[c][2]) / 3;
    const l = Math.hypot(cx, cy, cz);
    const tip = stV.length;
    stV.push([(cx / l) * 1.65, (cy / l) * 1.65, (cz / l) * 1.65]);
    stE.push([a, tip], [b, tip], [c, tip]);
  }
  shapes.stellated = { verts: normShape(stV), edges: stE };
  // 120-CELL — cell-first projection: nearest + farthest dodecahedral cells as two
  // concentric shells, corresponding verts linked; the 4D tumble animates at draw time
  const dv = dodecaVerts();
  shapes.cell120 = { verts: dv, edges: edgesByNearest(dv) };
  return shapes;
}
const SHAPES = buildShapes();
// finding family → shape (the user's pool)
const SHAPE_OF: Record<string, string> = {
  bug: "stellated",
  security: "stellated",
  error_handling: "stellated",
  api: "grhombi",
  test: "grhombi",
  compat: "grhombi",
  design: "chamfered",
  perf: "chamfered",
  observability: "chamfered",
  docs: "greatdodeca",
  clarity: "greatdodeca",
  style: "greatdodeca",
  question: "cell120",
};
function phaseOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h >>> 0) % 628) / 100;
}

export interface MapCallbacks {
  onJump: (path: string, line: number | null) => void;
  onAsk: (finding: RdFinding, text: string) => void;
  reduceMotion: boolean;
  /** Canvas height in px (the pop-out theater passes the full window). Default 470. */
  stageHeight?: number;
}

/** A node in WORLD space (isotropic 3D units). `x/y/z` live (lerped), `t*` the
 *  current layout's target — switching layouts morphs the graph instead of snapping. */
export interface MapNode {
  id: string;
  kind: "core" | "beat" | "finding";
  x: number;
  y: number;
  z: number;
  tx: number;
  ty: number;
  tz: number;
  r: number;
  color: string;
  finding?: RdFinding;
  label?: string;
  beatIdx?: number;
}

export interface MapHandle {
  /** The right-rail element journey/detail cards dock into (graph stays visible). */
  side: HTMLElement;
  /** Camera flight to a node; `zoom` = target magnification (default by kind). */
  focus: (node: MapNode, zoom?: number) => void;
  focusWide: () => void;
  setJourneyMode: (on: boolean) => void;
  moonOf: (findingId: string) => MapNode | undefined;
  planetAt: (beatIndex: number) => MapNode | undefined;
  sunObj: () => MapNode;
  setSelected: (findingId: string, on: boolean) => void;
  showDetail: (f: RdFinding) => void;
}

// One live scene at a time.
let teardown: (() => void) | null = null;

/** Dock each finding to the beat whose anchors best match its anchor (path → dir). */
function dockFindings(doc: ReviewDoc): Map<number, RdFinding[]> {
  const beats = doc.understanding.walkthrough;
  const out = new Map<number, RdFinding[]>();
  const dirOf = (p: string) => p.split("/").slice(0, -1).join("/");
  for (const f of doc.findings) {
    let best = -1;
    if (f.anchor) {
      best = beats.findIndex((b) => b.anchors.some((a) => a.path === f.anchor!.path));
      if (best < 0)
        best = beats.findIndex((b) =>
          b.anchors.some((a) => dirOf(a.path) === dirOf(f.anchor!.path)),
        );
    }
    if (best < 0) best = beats.length;
    (out.get(best) ?? out.set(best, []).get(best)!).push(f);
  }
  return out;
}

/** Spherical Fibonacci lattice point j of n on a sphere of radius r. */
function sphereFib(j: number, n: number, r: number): [number, number, number] {
  const y = n === 1 ? 0 : 1 - (2 * (j + 0.5)) / n;
  const ring = Math.sqrt(Math.max(0, 1 - y * y));
  const th = GOLDEN * j;
  return [Math.cos(th) * ring * r, y * r, Math.sin(th) * ring * r];
}

export function renderReviewMap(
  host: HTMLElement,
  doc: ReviewDoc,
  warnings: string[],
  cb: MapCallbacks,
): MapHandle {
  teardown?.();
  host.innerHTML = "";
  const root = document.createElement("div");
  root.className = "rmap rmap-split";
  const main = document.createElement("div");
  main.className = "rmap-main";
  const side = document.createElement("div");
  side.className = "rmap-side";
  root.append(main, side);

  // ── the right rail: verdict strip(s) + purpose + the card slot ──
  const state0 = doc.verdict.per_subject[0]?.state ?? "ready";
  for (const v of doc.verdict.per_subject) {
    const subj = doc.subjects[v.subject];
    const strip = document.createElement("div");
    strip.className = `rmap-verdict rmap-${v.state}`;
    const ledger = Object.entries(doc.verdict.ledger)
      .filter(([k, n]) => n > 0 && SEV_GLYPH[k])
      .map(([k, n]) => `${n}${SEV_GLYPH[k]}`)
      .join(" ");
    strip.innerHTML = `<b>${VERDICT_LABEL[v.state] ?? v.state}</b><span class="rmap-vref">${subj?.ref ?? ""}</span><span class="rmap-vledger">${ledger}</span>`;
    if (v.justification) strip.title = v.justification;
    side.appendChild(strip);
    if (v.scope) {
      const sc = document.createElement("div");
      sc.className = "rmap-scope";
      sc.textContent = `pass scope: ${v.scope}`;
      side.appendChild(sc);
    }
  }
  const purpose = document.createElement("div");
  purpose.className = "rmap-purpose";
  purpose.textContent = doc.understanding.purpose;
  side.appendChild(purpose);
  // The slot journey/detail cards dock into (instead of floating over the graph).
  const slot = document.createElement("div");
  slot.className = "rmap-slot";
  side.appendChild(slot);

  // ── the stage (left column — the graph stays visible while navigating) ──
  const stage = document.createElement("div");
  stage.className = "rmap-stage";
  main.appendChild(stage);
  const canvas = document.createElement("canvas");
  stage.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;
  const ctrls = document.createElement("div");
  ctrls.className = "rmap-ctrls";
  stage.appendChild(ctrls);
  const modeBtn = document.createElement("button");
  modeBtn.className = "rmap-mode";
  ctrls.appendChild(modeBtn);
  const resetBtn = document.createElement("button");
  resetBtn.className = "rmap-mode";
  resetBtn.textContent = "⌖ reset view";
  resetBtn.title = "fly home: frame everything, level the rotation";
  ctrls.appendChild(resetBtn);
  const bgBtn = document.createElement("button");
  bgBtn.className = "rmap-mode";
  ctrls.appendChild(bgBtn);
  const resWrap = document.createElement("label");
  resWrap.className = "rmap-res";
  const resLabel = document.createElement("span");
  const resInput = document.createElement("input");
  resInput.type = "range";
  resInput.min = "1";
  resInput.max = "4";
  resInput.step = "0.25";
  resWrap.append(resLabel, resInput);
  ctrls.appendChild(resWrap);

  // Cell metrics — density is a USER DIAL: ×1 = classic readable terminal cells,
  // ×3 ≈ the 10× texture look, ×4 = plotter-fine. Everything downstream (atlas,
  // framebuffer, picking) derives from these and rebuilds on change.
  let DENS = Math.min(4, Math.max(1, parseFloat(localStorage.getItem("pear.map.res") ?? "3") || 3));
  let FONT = 11 / DENS;
  let CW = 6.6 / DENS;
  let CH = 12 / DENS;
  const ASPECT = CH / CW; // a cell is ~1.8× taller than wide
  const SIDE_W = 380;
  let W = Math.max((host.clientWidth || 800) - SIDE_W - 12, 320);
  let H = cb.stageHeight ?? 470;
  let cols = 0;
  let rows = 0;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let TW = Math.round(CW * dpr); // tile size in device px (integer → clean copies)
  let TH = Math.round(CH * dpr);
  let fb: Uint32Array;
  let fbImage: ImageData;
  let fbW = 0;
  let fbH = 0;
  const sizeCanvas = () => {
    cols = Math.floor(W / CW);
    rows = Math.floor(H / CH);
    fbW = cols * TW;
    fbH = rows * TH;
    canvas.width = fbW;
    canvas.height = fbH;
    canvas.style.width = `${fbW / dpr}px`;
    canvas.style.height = `${fbH / dpr}px`;
    fbImage = ctx.createImageData(fbW, fbH);
    fb = new Uint32Array(fbImage.data.buffer);
  };
  sizeCanvas();

  // Glyph atlas as raw PIXEL TILES (opaque, baked on the void color): a cell is
  // REPLACED by its glyph tile — terminal semantics, zero alpha math, pure memcpy.
  const scratch = document.createElement("canvas");
  const sctx = scratch.getContext("2d", { willReadFrequently: true })!;
  const atlas = new Map<string, Uint32Array>();
  const tile = (ch: string, color: string): Uint32Array => {
    const key = `${ch}|${color}`;
    let t = atlas.get(key);
    if (!t) {
      scratch.width = TW;
      scratch.height = TH;
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sctx.fillStyle = "#05070c";
      sctx.fillRect(0, 0, CW, CH);
      sctx.font = `${FONT}px ui-monospace, Menlo, monospace`;
      sctx.textBaseline = "middle";
      sctx.textAlign = "center";
      sctx.fillStyle = color;
      sctx.fillText(ch, CW / 2, CH / 2 + 0.25);
      t = new Uint32Array(sctx.getImageData(0, 0, TW, TH).data.buffer.slice(0));
      atlas.set(key, t);
    }
    return t;
  };
  let BG_PACKED = tile(" ", "#05070c")[0]; // packed void color, endian-correct
  const applyDensity = (d: number) => {
    DENS = Math.min(4, Math.max(1, d));
    localStorage.setItem("pear.map.res", String(DENS));
    FONT = 11 / DENS;
    CW = 6.6 / DENS;
    CH = 12 / DENS;
    TW = Math.round(CW * dpr);
    TH = Math.round(CH * dpr);
    atlas.clear(); // tiles are density-shaped — rebake lazily
    sizeCanvas();
    BG_PACKED = tile(" ", "#05070c")[0];
    resLabel.textContent = `ascii ×${DENS.toFixed(2).replace(/\.?0+$/, "")}`;
    resInput.value = String(DENS);
  };
  const put = (col: number, row: number, ch: string, color: string) => {
    col = col | 0;
    row = row | 0;
    if (col < 0 || row < 0 || col >= cols || row >= rows || ch === " ") return;
    const t = tile(ch, color);
    const x0 = col * TW;
    let dst = row * TH * fbW + x0;
    let src = 0;
    for (let y = 0; y < TH; y++) {
      fb.set(t.subarray(src, src + TW), dst);
      src += TW;
      dst += fbW;
    }
  };
  // Readable text overlays (labels, hover line, fps) — drawn AFTER the framebuffer
  // blit at a legible size; grid cells are texture, not letters, at this density.
  interface Overlay {
    col: number;
    row: number;
    s: string;
    color: string;
  }
  let overlays: Overlay[] = [];
  const text = (col: number, row: number, s: string, color: string) => {
    overlays.push({ col, row, s, color });
  };

  // ── world: nodes in isotropic 3D units ──
  const docked = dockFindings(doc);
  const beats = [...doc.understanding.walkthrough.map((b) => ({ title: b.title, body: b.body, risk: b.risk }))];
  if (docked.has(beats.length) || beats.length === 0)
    beats.push({ title: beats.length ? "other findings" : "findings", body: "", risk: "low" });

  const mk = (p: Omit<MapNode, "x" | "y" | "z" | "tx" | "ty" | "tz">): MapNode => ({
    ...p,
    x: 0,
    y: 0,
    z: 0,
    tx: 0,
    ty: 0,
    tz: 0,
  });
  const core = mk({ id: "__core__", kind: "core", r: 4.2, color: VERDICT_COLOR[state0] ?? "#3fb950" });
  const beatNodes: MapNode[] = [];
  const findingNodes: MapNode[] = [];
  beats.forEach((b, i) => {
    beatNodes.push(
      mk({
        id: `__beat${i}__`,
        kind: "beat",
        r: RISK_R[b.risk] ?? 2.1,
        color: RISK_COLOR[b.risk] ?? "#6e7681",
        label: `${i + 1}·${b.title}`,
      }),
    );
    const fs = (docked.get(i) ?? [])
      .slice()
      .sort((a, c) => (SEV_R[c.severity] ?? 1) - (SEV_R[a.severity] ?? 1));
    fs.forEach((f) => {
      findingNodes.push(
        mk({
          id: f.id,
          kind: "finding",
          r: SEV_R[f.severity] ?? 1,
          color: TYPE_COLOR[f.type] ?? "#8b949e",
          finding: f,
          beatIdx: i,
        }),
      );
    });
  });
  const nodes = [core, ...beatNodes, ...findingNodes];
  const moonByFid = new Map(findingNodes.map((n) => [n.id, n]));
  const beatOf = (n: MapNode): MapNode => beatNodes[n.beatIdx ?? 0];

  // ── two 3D layouts over the same nodes; targets lerp → switching MORPHS ──
  type LayoutMode = "mandala" | "flow" | "orbit";
  const storedLayout = localStorage.getItem("pear.map.layout");
  let layout: LayoutMode =
    storedLayout === "flow" || storedLayout === "orbit" ? storedLayout : "mandala";
  // The mandala's design radius (world units) — everything fits inside it, always.
  const MRAD = 34;
  const nB = () => Math.max(beatNodes.length, 1);
  const sectorW = () => (Math.PI * 2) / nB();
  const beatAngle = (i: number) => -Math.PI / 2 + i * sectorW(); // 12 o'clock, clockwise
  /** Shallow dome: center toward the viewer, rim receding — the mandala's "eye" depth. */
  const domeZ = (x: number, y: number) => ((x * x + y * y) / (MRAD * MRAD)) * 8 - 4;
  const applyLayout = (mode: LayoutMode) => {
    layout = mode;
    localStorage.setItem("pear.map.layout", mode);
    const perBeat = new Map<number, { j: number; n: number }>();
    findingNodes.forEach((fn) => {
      const i = fn.beatIdx ?? 0;
      const e = perBeat.get(i) ?? { j: 0, n: 0 };
      e.n++;
      perBeat.set(i, e);
    });
    if (mode === "mandala") {
      // Alex Grey arrangement: verdict eye at center; chapters as petals on a ring
      // (equal angles, clockwise from 12); each petal's findings fill arc BANDS
      // outside the ring, severity-major (the worst sits closest to the eye's ring).
      core.tx = core.ty = 0;
      core.tz = domeZ(0, 0);
      const R1 = 15;
      beatNodes.forEach((bn, i) => {
        const a = beatAngle(i);
        bn.tx = Math.cos(a) * R1;
        bn.ty = Math.sin(a) * R1;
        bn.tz = domeZ(bn.tx, bn.ty);
      });
      // fill each petal row by row (rows = concentric bands)
      const byBeat = new Map<number, MapNode[]>();
      findingNodes.forEach((fn) => {
        const i = fn.beatIdx ?? 0;
        (byBeat.get(i) ?? byBeat.set(i, []).get(i)!).push(fn);
      });
      byBeat.forEach((fns, i) => {
        const a0 = beatAngle(i);
        const avail = sectorW() * 0.74;
        let row = 0;
        let pos = 0;
        let cap = 0;
        let rowR = 0;
        const rowOf: { n: MapNode; row: number; pos: number }[] = [];
        fns.forEach((fn) => {
          if (pos >= cap) {
            rowR = R1 + 6.5 + row * 4.8;
            cap = Math.max(1, Math.floor((avail * rowR) / 4.0));
            row++;
            pos = 0;
          }
          rowOf.push({ n: fn, row: row - 1, pos: pos++ });
        });
        // center each row's occupants in the sector
        const rowCounts = new Map<number, number>();
        rowOf.forEach((e) => rowCounts.set(e.row, (rowCounts.get(e.row) ?? 0) + 1));
        rowOf.forEach((e) => {
          const r = R1 + 6.5 + e.row * 4.8;
          const count = rowCounts.get(e.row)!;
          const spacing = count > 1 ? avail / (count - 1) : 0;
          const ang = a0 + (count > 1 ? -avail / 2 + e.pos * spacing : 0);
          e.n.tx = Math.cos(ang) * r;
          e.n.ty = Math.sin(ang) * r;
          e.n.tz = domeZ(e.n.tx, e.n.ty);
        });
      });
    } else if (mode === "orbit") {
      // spherical phyllotaxis at every scale (self-similar)
      core.tx = core.ty = core.tz = 0;
      const R = 15 + beatNodes.length * 1.1;
      beatNodes.forEach((bn, i) => {
        const [x, y, z] = sphereFib(i, beatNodes.length, R);
        bn.tx = x;
        bn.ty = y;
        bn.tz = z;
      });
      findingNodes.forEach((fn) => {
        const i = fn.beatIdx ?? 0;
        const e = perBeat.get(i)!;
        const bn = beatNodes[i];
        const [x, y, z] = sphereFib(e.j, e.n, bn.r + 3.4 + 0.6 * Math.sqrt(e.j));
        e.j++;
        fn.tx = bn.tx + x;
        fn.ty = bn.ty + y;
        fn.tz = bn.tz + z;
      });
    } else {
      // flow: a river through space — 3D meander, tributaries in the ⊥ plane
      const STEP = 22;
      const x0 = (-(beatNodes.length - 1) / 2) * STEP - 8;
      beatNodes.forEach((bn, i) => {
        bn.tx = x0 + i * STEP;
        bn.ty = Math.sin(i * 0.9) * 6;
        bn.tz = Math.cos(i * 0.7) * 7;
      });
      core.tx = x0 + beatNodes.length * STEP + 4;
      core.ty = Math.sin(beatNodes.length * 0.9) * 6;
      core.tz = Math.cos(beatNodes.length * 0.7) * 7;
      findingNodes.forEach((fn) => {
        const i = fn.beatIdx ?? 0;
        const e = perBeat.get(i)!;
        const bn = beatNodes[i];
        const phi = e.j * GOLDEN;
        const rr = bn.r + 3.2 + 1.5 * Math.sqrt(e.j);
        e.j++;
        fn.tx = bn.tx + Math.sin(phi) * 1.8; // slight downstream stagger
        fn.ty = bn.ty + Math.cos(phi) * rr;
        fn.tz = bn.tz + Math.sin(phi) * rr;
      });
    }
  };
  type BgMode = "mosaic" | "galaxy" | "simple";
  const storedBg = localStorage.getItem("pear.map.bg");
  let bgMode: BgMode = storedBg === "galaxy" || storedBg === "simple" ? storedBg : "mosaic";
  applyLayout(layout);
  nodes.forEach((n) => {
    n.x = n.tx;
    n.y = n.ty;
    n.z = n.tz;
  });

  // ── orbit camera: yaw/pitch around a target, perspective projection ──
  const FOV = 42; // perspective strength (world units to the projection plane)
  const extent = () =>
    layout === "mandala"
      ? MRAD + 2
      : nodes.reduce((m, n) => Math.max(m, Math.abs(n.tx) + 8, Math.abs(n.ty) + 6, Math.abs(n.tz) + 6), 18);
  const fitZoom = () => Math.min(cols / (extent() * 2.3), rows / (extent() * 1.28));
  const cam = { x: 0, y: 0, z: 0, zoom: fitZoom(), yaw: 0, pitch: 0 };
  let camTarget: { x: number; y: number; z: number; zoom: number } | null = null;
  let rotTarget: { yaw: number; pitch: number } | null = null;
  let focusNode: MapNode | null = null;
  const selected = new Set<string>();
  let journeyMode = false;
  let hovered: MapNode | null = null;
  let dragging = false;

  interface Proj {
    col: number;
    row: number;
    s: number; // screen scale at this depth (perspective × zoom)
    depth: number; // camera-space z (sorting + dimming)
  }
  const project = (px: number, py: number, pz: number): Proj => {
    const x = px - cam.x;
    const y = py - cam.y;
    const z = pz - cam.z;
    // yaw about Y, then pitch about X
    const cy = Math.cos(cam.yaw);
    const sy = Math.sin(cam.yaw);
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    const cp = Math.cos(cam.pitch);
    const sp = Math.sin(cam.pitch);
    const y1 = y * cp - z1 * sp;
    const z2 = y * sp + z1 * cp;
    const s = (FOV / Math.max(FOV * 0.25, FOV + z2)) * cam.zoom;
    return {
      col: cols / 2 + x1 * s,
      row: rows / 2 + (y1 * s) / (ASPECT / 1.05),
      s,
      depth: z2,
    };
  };
  /** Lighten toward white (specular highlights) — quantized + cached like shade. */
  const lightCache = new Map<string, string>();
  const lighten = (hex: string, amt: number): string => {
    const q = Math.round(Math.max(0, Math.min(1, amt)) * 7) / 7;
    const key = `${hex}^${q}`;
    let out = lightCache.get(key);
    if (!out) {
      const n = parseInt(hex.slice(1), 16);
      const mix = (v: number) => Math.round(v + (255 - v) * q);
      out = `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
      lightCache.set(key, out);
    }
    return out;
  };

  /** Depth cue: far → dim toward the void (quantized so the atlas stays small). */
  const shadeCache = new Map<string, string>();
  const shade = (hex: string, depth: number): string => {
    const t = Math.max(0, Math.min(0.78, (depth + extent() * 0.55) / (extent() * 1.7)));
    const q = Math.round(t * 11) / 11;
    const key = `${hex}@${q}`;
    let out = shadeCache.get(key);
    if (!out) {
      const n = parseInt(hex.slice(1), 16);
      const mix = (v: number, tgt: number) => Math.round(v + (tgt - v) * q);
      out = `rgb(${mix((n >> 16) & 255, VOID.r)},${mix((n >> 8) & 255, VOID.g)},${mix(n & 255, VOID.b)})`;
      shadeCache.set(key, out);
    }
    return out;
  };

  // ── input: drag ROTATES, wheel zooms, click picks, dblclick re-frames ──
  let dragMoved = false;
  let last = { x: 0, y: 0 };
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    dragMoved = false;
    rotTarget = null; // the user takes the wheel
    last = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    if (dragging) {
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
      cam.yaw -= dx * 0.0085;
      cam.pitch = Math.max(-1.25, Math.min(1.25, cam.pitch + dy * 0.0085));
      last = { x: e.clientX, y: e.clientY };
      return;
    }
    hovered = pick((e.clientX - rect.left) / CW, (e.clientY - rect.top) / CH);
    canvas.style.cursor = hovered ? "pointer" : "grab";
  });
  canvas.addEventListener("pointerup", (e) => {
    dragging = false;
    if (dragMoved) return;
    const rect = canvas.getBoundingClientRect();
    const n = pick((e.clientX - rect.left) / CW, (e.clientY - rect.top) / CH);
    if (n?.finding) detail.show(n.finding);
  });
  canvas.addEventListener("dblclick", () => {
    focusNode = null;
    camTarget = { x: 0, y: 0, z: 0, zoom: fitZoom() };
    rotTarget = { yaw: 0, pitch: 0 };
  });
  // Zoom stays inside [just-wider-than-fit … 8×]: never lost, and close enough to
  // read a polyhedron's vertices.
  const clampZoom = (z: number) => Math.max(fitZoom() * 0.85, Math.min(8.0, z));
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.1 : 0.9;
    if (camTarget) camTarget.zoom = clampZoom(camTarget.zoom * f);
    else cam.zoom = clampZoom(cam.zoom * f);
  });
  const pick = (mc: number, mr: number): MapNode | null => {
    let best: MapNode | null = null;
    let bd = 9;
    for (const n of nodes) {
      if (n.kind === "core") continue;
      const p = project(n.x, n.y, n.z);
      const d = (p.col - mc) ** 2 + ((p.row - mr) * 1.8) ** 2;
      const hit = Math.max(n.r * p.s * 1.6, 2.5) ** 2;
      if (d < hit && d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  };

  // ── fractal background: Julia set with camera parallax ──
  const julia = (zx: number, zy: number, jx: number, jy: number): number => {
    let n = 0;
    while (n < 16 && zx * zx + zy * zy < 4) {
      const t = zx * zx - zy * zy + jx;
      zy = 2 * zx * zy + jy;
      zx = t;
      n++;
    }
    return n;
  };
  const BG_A = "#1b2335";
  const BG_B = "#232b47";

  // ── the render loop (uncapped rAF; full redraw via atlas) ──
  let raf = 0;
  let t0 = performance.now();
  let frames = 0;
  let fps = 0;
  let fpsAt = t0;
  const draw = (now: number) => {
    if (!canvas.isConnected) return dispose();
    raf = requestAnimationFrame(draw);
    const t = (now - t0) / 1000;
    frames++;
    if (now - fpsAt > 500) {
      fps = Math.round((frames * 1000) / (now - fpsAt));
      frames = 0;
      fpsAt = now;
    }

    // layout morph, focus tracking, camera damping, idle spin
    const mk_ = 1 - Math.exp(-0.14);
    for (const n of nodes) {
      n.x += (n.tx - n.x) * mk_;
      n.y += (n.ty - n.y) * mk_;
      n.z += (n.tz - n.z) * mk_;
    }
    if (focusNode)
      camTarget = {
        x: focusNode.x,
        y: focusNode.y,
        z: focusNode.z,
        zoom: camTarget?.zoom ?? cam.zoom,
      };
    if (camTarget) {
      const k = 1 - Math.exp(-0.12);
      cam.x += (camTarget.x - cam.x) * k;
      cam.y += (camTarget.y - cam.y) * k;
      cam.z += (camTarget.z - cam.z) * k;
      cam.zoom += (camTarget.zoom - cam.zoom) * k;
    }
    if (rotTarget) {
      const k = 1 - Math.exp(-0.12);
      cam.yaw += (rotTarget.yaw - cam.yaw) * k;
      cam.pitch += (rotTarget.pitch - cam.pitch) * k;
      if (Math.abs(rotTarget.yaw - cam.yaw) + Math.abs(rotTarget.pitch - cam.pitch) < 0.002)
        rotTarget = null;
    }
    if (!cb.reduceMotion && !dragging && !journeyMode && layout !== "mandala") cam.yaw += 0.0009;

    fb.fill(BG_PACKED);
    overlays = [];

    // 1 · the void: mandala mode breathes radial STANDING WAVES (m-fold symmetry,
    //     m = chapter count — the geometry of the review itself); flow/orbit keep
    //     the drifting Julia set. Both with camera parallax.
    const ox = cam.yaw * 9;
    const oy = cam.pitch * 7;
    if (bgMode === "simple") {
      // clean void — zero distraction, maximum fps
    } else if (bgMode === "mosaic") {
      // The painting, in pebbles: a bilateral rainbow gem MOSAIC whose hue bands
      // radiate in arcs from the center; two grayscale masses flank it where the
      // skulls sit; a diamond pulses at the third eye. Each pebble is a brick-offset
      // lattice cell shaded core→rim by the disc ramp (flat gem color per pebble).
      const tt = cb.reduceMotion ? 0 : t;
      // bigger gems so the FACETS resolve (the painting's stones have inner cuts)
      const P = Math.max(8, Math.round(12 * (DENS / 3)));
      const PH = P * 0.8;
      const skX = cols * 0.3; // skull-mass foci (mirrored)
      const skY = -rows * 0.04;
      const skRx = cols * 0.19;
      const skRy = rows * 0.38;
      for (let r = 0; r < rows; r++) {
        const dy = (r - rows / 2) * (ASPECT / 1.05) + oy;
        for (let c = 0; c < cols; c++) {
          const ax = Math.abs(c - cols / 2 + ox); // bilateral mirror
          const ry = Math.floor((dy + rows) / PH);
          const off = ry & 1 ? P / 2 : 0;
          const pcx = (Math.floor((ax + off) / P) + 0.5) * P - off;
          const pcy = (ry + 0.5) * PH - rows;
          const ddx = (ax - pcx) / (P * 0.5);
          const ddy = (dy - pcy) / (PH * 0.5);
          const d = Math.sqrt(ddx * ddx + ddy * ddy);
          if (d > 1.05) {
            put(c, r, "·", MORTAR);
            continue;
          }
          // HUE: elliptical arcs out of the face center — gold at the heart, through
          // green, to blue/violet at the rim, repeating — exactly the painting's bands.
          // (squash y so the bands arch OVER the center like the original)
          const prW = Math.sqrt(pcx * pcx + pcy * pcy * 1.8);
          const jitter = ((((pcx * 73856093) ^ (pcy * 19349663)) >>> 0) % 7) - 3; // per-gem
          const hueDeg = 42 + prW * 2.9 + jitter * 4 + tt * 6;
          const hueIdx = ((Math.floor((hueDeg / 360) * GEM_HUES) % GEM_HUES) + GEM_HUES) % GEM_HUES;
          const sdx = (ax - skX) / skRx;
          const sdy = (dy - skY) / skRy;
          const inSkull = sdx * sdx + sdy * sdy < 1;
          // FACETS: the inner cross + diagonal cuts of the painting's gems
          const cross = Math.min(Math.abs(ddx), Math.abs(ddy));
          const diag = Math.abs(Math.abs(ddx) - Math.abs(ddy));
          let ch: string;
          let shade: number;
          if (d < 0.16) {
            ch = "@";
            shade = 0;
          } else if (cross < 0.14 && d < 0.8) {
            ch = "+";
            shade = 0; // the bright inner cross
          } else if (diag < 0.16 && d < 0.85) {
            ch = "*";
            shade = 1; // diagonal facet cuts
          } else if (d < 0.55) {
            ch = "#";
            shade = 1;
          } else if (d < 0.82) {
            ch = "=";
            shade = 2;
          } else {
            ch = ":";
            shade = 3; // rim
          }
          const pal = inSkull ? GRAY_PAL : GEM_PAL[hueIdx];
          put(c, r, ch, pal[shade]);
        }
      }
      // the third-eye diamond: a small pulsing rhombus above center
      const dy0 = Math.round(rows * 0.18);
      const k = 2.2 + (cb.reduceMotion ? 0 : Math.sin(t * 2.4) * 0.9);
      for (let dr = -Math.ceil(k); dr <= Math.ceil(k); dr++) {
        const half = (k - Math.abs(dr)) * 1.9;
        for (let dc = -Math.ceil(half); dc <= Math.ceil(half); dc++) {
          put(
            Math.round(cols / 2 + dc - ox),
            Math.round(rows / 2 - dy0 + dr - oy),
            Math.abs(dc) + Math.abs(dr) < 1.5 ? "@" : "#",
            Math.abs(dc) + Math.abs(dr) < 1.5 ? "#ffe9a8" : "#e8b34b",
          );
        }
      }
    } else {
      const th = (cb.reduceMotion ? 0 : t * 0.05) + 2.2;
      const jx = 0.7885 * Math.cos(th);
      const jy = 0.7885 * Math.sin(th);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const wx = (c - cols / 2) / cam.zoom + ox;
          const wy = ((r - rows / 2) / cam.zoom) * (ASPECT / 1.05) + oy;
          const n = julia(wx * 0.022, wy * 0.04, jx, jy);
          if (n > 2) put(c, r, BG_RAMP[Math.min(n, BG_RAMP.length - 1)], n % 2 ? BG_A : BG_B);
        }
      }
    }

    // 2 · OBJECT SEPARATION: project every node once, then carve a gaussian void
    //     POCKET around each (suppresses the mosaic — diffusion halo) and drop an
    //     offset PROJECTED SHADOW under it. Nodes get a calm, bordered stage.
    const order = nodes
      .map((n) => ({ n, p: project(n.x, n.y, n.z) }))
      .sort((a, b) => b.p.depth - a.p.depth);
    const SHADE_BLOCKS = ["█", "▓", "▒", "░"];
    for (const { n, p } of order) {
      const R = Math.max(n.r * p.s, 1.2);
      // projected shadow: offset ellipse, light from upper-left
      const shR = R * 1.05;
      const shC = p.col + R * 0.85;
      const shRow = p.row + R * 0.6;
      for (let dr = -Math.ceil(shR); dr <= Math.ceil(shR); dr++) {
        for (let dc = -Math.ceil(shR * 1.9); dc <= Math.ceil(shR * 1.9); dc++) {
          const dd = Math.hypot(dc / 1.9, dr) / shR;
          if (dd > 1) continue;
          put(Math.round(shC + dc), Math.round(shRow + dr), dd > 0.7 ? "▒" : "▓", "#03050a");
        }
      }
      // gaussian pocket: void clears outward (block ramp = the diffusion)
      const HR = R * 1.9 + 2.5;
      const sig2 = 2 * (HR * 0.52) ** 2;
      for (let dr = -Math.ceil(HR); dr <= Math.ceil(HR); dr++) {
        for (let dc = -Math.ceil(HR * 1.9); dc <= Math.ceil(HR * 1.9); dc++) {
          const dist = Math.hypot(dc / 1.9, dr);
          if (dist > HR) continue;
          const w = Math.exp(-(dist * dist) / sig2);
          if (w < 0.22) continue;
          const bi = w > 0.85 ? 0 : w > 0.6 ? 1 : w > 0.4 ? 2 : 3;
          put(Math.round(p.col + dc), Math.round(p.row + dr), SHADE_BLOCKS[bi], "#070a12");
        }
      }
    }

    // 3 · edges (3D-sampled, depth-shaded, flow phase runs downstream)
    const edge = (a: MapNode, b: MapNode, color: string) => {
      const pa = project(a.x, a.y, a.z);
      const pb = project(b.x, b.y, b.z);
      const len = Math.hypot(pb.col - pa.col, pb.row - pa.row);
      const steps = Math.max(2, Math.floor(len));
      for (let i = 1; i < steps; i++) {
        const s = i / steps;
        const p = project(a.x + (b.x - a.x) * s, a.y + (b.y - a.y) * s, a.z + (b.z - a.z) * s);
        const phase = Math.floor(s * len - (cb.reduceMotion ? 0 : t * 7));
        put(
          Math.round(p.col),
          Math.round(p.row),
          FLOW[((phase % FLOW.length) + FLOW.length) % FLOW.length],
          shade(color, p.depth),
        );
      }
    };
    // 3D point on the mandala dome at polar (ang, rad)
    const dome3 = (ang: number, rad: number): [number, number, number] => {
      const x = Math.cos(ang) * rad;
      const y = Math.sin(ang) * rad;
      return [x, y, domeZ(x, y)];
    };
    /** Sample a parametric 3D path with flowing phase chars. */
    const path3 = (
      f: (s: number) => [number, number, number],
      samples: number,
      color: string,
      still = false,
    ) => {
      for (let i = 0; i <= samples; i++) {
        const sN = i / samples;
        const [x, y, z] = f(sN);
        const p = project(x, y, z);
        const phase = Math.floor(sN * samples - (cb.reduceMotion || still ? 0 : t * 7));
        put(
          Math.round(p.col),
          Math.round(p.row),
          still ? "·" : FLOW[((phase % FLOW.length) + FLOW.length) % FLOW.length],
          shade(color, p.depth),
        );
      }
    };
    if (layout === "mandala") {
      const R1 = 15;
      // guide rings + sector meridians (the sacred-geometry scaffolding, whisper-dim)
      path3((sN) => dome3(sN * Math.PI * 2, R1), 150, "#222a3e", true);
      path3((sN) => dome3(sN * Math.PI * 2, R1 + 11.3), 190, "#1d2434", true);
      for (let i = 0; i < nB(); i++) {
        const b = beatAngle(i) + sectorW() / 2;
        path3((sN) => dome3(b, R1 + 2 + sN * (MRAD - R1 - 4)), 16, "#1d2434", true);
      }
      // the FLOW CIRCUIT, clockwise: eye → chapter 1 → … → chapter n → back into the eye
      path3((sN) => dome3(beatAngle(0), core.r + 1.5 + sN * (R1 - core.r - 3)), 14, "#46506a");
      for (let i = 0; i + 1 < beatNodes.length; i++) {
        const a0 = beatAngle(i);
        const a1 = beatAngle(i + 1);
        path3((sN) => dome3(a0 + (a1 - a0) * sN, R1), 26, "#46506a");
      }
      if (beatNodes.length > 1) {
        const aL = beatAngle(beatNodes.length - 1);
        path3((sN) => dome3(aL + sectorW() * 0.35 * sN, R1 - sN * (R1 - core.r - 1.5)), 18, "#46506a");
      }
    } else if (layout === "orbit") {
      for (const bn of beatNodes) edge(core, bn, "#3d4761");
    } else {
      for (let i = 0; i + 1 < beatNodes.length; i++) edge(beatNodes[i], beatNodes[i + 1], "#46506a");
      if (beatNodes.length) edge(beatNodes[beatNodes.length - 1], core, "#46506a");
    }
    for (const fn of findingNodes) {
      const bn = beatOf(fn);
      if (layout === "orbit") edge(bn, fn, dimHex(fn.color));
      else edge(fn, bn, dimHex(fn.color));
    }

    // 4 · nodes, painter's order (far → near): RAY-TRACED spheres. Each cell casts
    //     a ray at the sphere; on hit we get the surface normal → Lambert diffuse +
    //     Blinn-Phong specular from a slowly ORBITING light. ASCII, but lit.
    const lt = cb.reduceMotion ? 0 : t * 0.25;
    const Lx0 = Math.cos(lt) * 0.55 - 0.25;
    const Ly0 = -0.62;
    const Lz0 = Math.sin(lt) * 0.3 + 0.55;
    const Llen = Math.hypot(Lx0, Ly0, Lz0);
    const Lx = Lx0 / Llen;
    const Ly = Ly0 / Llen;
    const Lz = Lz0 / Llen;
    // half-vector for Blinn (view = +z toward camera)
    const Hl = Math.hypot(Lx, Ly, Lz + 1);
    const Hx = Lx / Hl;
    const Hy = Ly / Hl;
    const Hz = (Lz + 1) / Hl;
    const RAY_RAMP = " ·:=+*#%@";
    const sphere = (n: MapNode, p: Proj, boost: number) => {
      const R = Math.max(n.r * p.s, 0.8);
      const rIn = Math.ceil(R);
      for (let dr = -rIn; dr <= rIn; dr++) {
        for (let dc = -Math.ceil(R * 1.9); dc <= Math.ceil(R * 1.9); dc++) {
          const nx = dc / 1.9 / R;
          const ny = dr / R;
          const rr = nx * nx + ny * ny;
          if (rr > 1) continue; // the ray misses
          const nz = Math.sqrt(1 - rr); // surface normal at the hit point
          const diff = Math.max(0, nx * Lx + ny * Ly + nz * Lz);
          const specD = Math.max(0, nx * Hx + ny * Hy + nz * Hz);
          const spec = Math.pow(specD, 24);
          const inten = Math.min(1, 0.13 + (0.78 * diff + spec * 1.1) * boost);
          const ch = RAY_RAMP[Math.min(RAY_RAMP.length - 1, Math.floor(inten * RAY_RAMP.length))];
          if (ch === " ") continue;
          const base = shade(n.color, p.depth);
          const color = spec > 0.45 ? lighten(n.color, Math.min(0.85, spec)) : base;
          put(Math.round(p.col + dc), Math.round(p.row + dr), ch, color);
        }
      }
    };
    /** A tumbling polyhedron cage: local-rotated verts, depth-split edge shading
     *  (front edges in the node color, back edges dimmed), bright vertex points when
     *  the cage is large enough to resolve. The 120-cell adds the 4D act: an inner
     *  shell counter-rotating and breathing through the w-axis. */
    const drawPoly = (n: MapNode, p: Proj, kind: string, boost: number) => {
      const shape = SHAPES[kind];
      const R = Math.max(n.r * p.s * 1.45, 1.6) * (boost > 1 ? 1.12 : 1);
      const ph = phaseOf(n.id);
      const ry = (cb.reduceMotion ? 0 : t * 0.55) + ph;
      const rx = (cb.reduceMotion ? 0 : t * 0.34) + ph * 1.7;
      const cy_ = Math.cos(ry);
      const sy_ = Math.sin(ry);
      const cx_ = Math.cos(rx);
      const sx_ = Math.sin(rx);
      const rot = (v: V3, flip: number): V3 => {
        const x1 = v[0] * cy_ + v[2] * sy_ * flip;
        const z1 = -v[0] * sy_ * flip + v[2] * cy_;
        const y1 = v[1] * cx_ - z1 * sx_;
        const z2 = v[1] * sx_ + z1 * cx_;
        return [x1, y1, z2];
      };
      const front = shade(n.color, p.depth);
      const back = shade(dimHex(n.color), p.depth);
      const seg = (a: V3, b: V3, scale: number, dimAll: boolean) => {
        const ac = p.col + a[0] * R * 1.9 * scale;
        const ar = p.row + a[1] * R * scale;
        const bc = p.col + b[0] * R * 1.9 * scale;
        const br = p.row + b[1] * R * scale;
        const steps = Math.max(1, Math.ceil(Math.hypot(bc - ac, br - ar)));
        for (let i = 0; i <= steps; i++) {
          const s_ = i / steps;
          const z = a[2] + (b[2] - a[2]) * s_;
          put(
            Math.round(ac + (bc - ac) * s_),
            Math.round(ar + (br - ar) * s_),
            z > 0 ? ":" : "·",
            dimAll ? back : z > 0 ? front : back,
          );
        }
      };
      if (kind === "cell120") {
        // 4D tumble: outer cell steady, inner cell counter-rotates + breathes in w
        const w = cb.reduceMotion ? 0.55 : 0.45 + Math.sin(t * 0.9 + ph) * 0.18;
        for (const [i, j] of shape.edges) seg(rot(shape.verts[i], 1), rot(shape.verts[j], 1), 1, false);
        for (const [i, j] of shape.edges)
          seg(rot(shape.verts[i], -1), rot(shape.verts[j], -1), w, true);
        if (R > 3.2)
          for (let i = 0; i < shape.verts.length; i += 2) {
            const a = rot(shape.verts[i], 1);
            const b = rot(shape.verts[i], -1);
            seg(a, [b[0] * w, b[1] * w, b[2] * w] as V3, 1, true);
          }
      } else {
        for (const [i, j] of shape.edges) seg(rot(shape.verts[i], 1), rot(shape.verts[j], 1), 1, false);
        if (shape.chords && R > 2.4)
          for (const [i, j] of shape.chords)
            seg(rot(shape.verts[i], 1), rot(shape.verts[j], 1), 1, true);
      }
      if (R > 3.6) {
        for (const v of shape.verts) {
          const rv = rot(v, 1);
          if (rv[2] > 0.15)
            put(
              Math.round(p.col + rv[0] * R * 1.9),
              Math.round(p.row + rv[1] * R),
              "+",
              boost > 1 ? lighten(n.color, 0.5) : lighten(n.color, 0.25),
            );
        }
      }
    };
    const breathe = cb.reduceMotion ? 0 : Math.sin(t * 1.6) * 0.4;
    core.r = 4.2 + breathe * 0.4;
    for (const { n, p } of order) {
      if (n.kind === "core") {
        sphere(n, p, 1.05);
        continue;
      }
      if (n.kind === "beat") {
        sphere(n, p, 1);
        if (cam.zoom > 0.55 && n.label && p.depth < extent() * 0.45)
          text(
            Math.round(p.col + n.r * p.s * 1.9 + 2),
            Math.round(p.row),
            n.label.slice(0, 24),
            shade("#8b949e", p.depth),
          );
        continue;
      }
      const f = n.finding!;
      const pulse = f.severity === "blocker" && !cb.reduceMotion && Math.sin(t * 6) > 0;
      const shapeKind = SHAPE_OF[f.type];
      if (f.type === "praise") put(Math.round(p.col), Math.round(p.row), "+", shade(n.color, p.depth));
      else if (shapeKind) drawPoly(n, p, shapeKind, pulse ? 1.5 : 1);
      else sphere(n, p, pulse ? 1.45 : 1);
      if (f.status !== "open") put(Math.round(p.col), Math.round(p.row), "·", "#444c56");
      if (Object.values(f.engines).includes("dispute")) {
        const oa = cb.reduceMotion ? 0.8 : t * 2.2;
        const or_ = n.r * p.s + 2;
        for (let k = 0; k < 4; k++) {
          const a = oa + (k * Math.PI) / 2;
          put(
            Math.round(p.col + Math.cos(a) * or_ * 1.9),
            Math.round(p.row + Math.sin(a) * or_),
            "/-\\|"[k],
            shade(n.color, p.depth),
          );
        }
      }
      if (selected.has(n.id)) {
        const off = Math.max(n.r * p.s * 1.9 + 1, 2);
        put(Math.round(p.col - off), Math.round(p.row), "[", "#ffd866");
        put(Math.round(p.col + off), Math.round(p.row), "]", "#ffd866");
      }
    }

    // 5 · FOCUS GLOW: the journey's current node wears a pulsing double ring
    if (focusNode) {
      const p = project(focusNode.x, focusNode.y, focusNode.z);
      const base = Math.max(focusNode.r * p.s, 1.4);
      for (let ring = 0; ring < 2; ring++) {
        const rr = base + 1.6 + ring * 2.2 + (cb.reduceMotion ? 0 : Math.sin(t * 3 + ring * 1.6) * 0.7);
        const n = 18 + ring * 8;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + (cb.reduceMotion ? 0 : t * (ring ? -1.1 : 1.5));
          put(
            Math.round(p.col + Math.cos(a) * rr * 1.9),
            Math.round(p.row + Math.sin(a) * rr),
            ring ? "·" : k % 3 ? "*" : "+",
            ring ? focusNode.color : k % 2 ? "#ffffff" : focusNode.color,
          );
        }
      }
    }

    // 6 · hover halo + status line + fps
    if (hovered) {
      const p = project(hovered.x, hovered.y, hovered.z);
      const hr = Math.max(hovered.r * p.s + 1.5, 2.5);
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2 + (cb.reduceMotion ? 0 : t * 1.2);
        put(Math.round(p.col + Math.cos(a) * hr * 1.9), Math.round(p.row + Math.sin(a) * hr), "·", "#e6edf3");
      }
      const f = hovered.finding;
      const line = f
        ? `${SEV_GLYPH[f.severity] ?? ""} [${f.type}] ${f.id} — ${f.title}`
        : (hovered.label ?? "");
      text(2, rows - 4, line.slice(0, 110), f ? hovered.color : "#8b949e");
    }
    text(cols - Math.ceil(60 / CW), 1, `${String(fps).padStart(3, " ")} fps`, "#39404d");

    // blit the framebuffer, then the readable-text overlay pass
    ctx.putImageData(fbImage, 0, 0);
    ctx.font = `${11 * dpr}px ui-monospace, Menlo, monospace`;
    ctx.textBaseline = "middle";
    for (const o of overlays) {
      ctx.fillStyle = o.color;
      ctx.fillText(o.s, o.col * TW, o.row * TH + TH / 2);
    }
    ctx.fillStyle = "#39404d";
    ctx.font = `${10 * dpr}px ui-monospace, Menlo, monospace`;
    ctx.fillText("+/- zoom · wasd rotate · 0 reset · L layout · G bg · [ ] res", 10 * dpr, fbH - 10 * dpr);
  };

  const ro = new ResizeObserver(() => {
    // Track the REAL stage box — fullscreen/resize must reshape the grid live.
    W = Math.max(host.clientWidth - SIDE_W - 12, 320);
    H = Math.max(stage.clientHeight || H, 300);
    sizeCanvas();
  });
  ro.observe(host);
  ro.observe(stage);

  const dispose = () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    document.removeEventListener("keydown", onMapKey);
    atlas.clear();
    shadeCache.clear();
    teardown = null;
  };
  teardown = dispose;

  const detail = buildDetailCard(slot, cb);
  const syncModeBtn = () => {
    modeBtn.textContent = layout === "mandala" ? "❂ mandala" : layout === "flow" ? "≋ flow" : "✿ orbit";
    modeBtn.title =
      "cycle layout: mandala → flow → orbit (morphs live) · drag rotates · wheel zooms · dblclick re-frames";
  };
  syncModeBtn();
  applyDensity(DENS); // initializes the slider label + value
  resInput.addEventListener("input", () => {
    applyDensity(parseFloat(resInput.value));
    if (!journeyMode) {
      focusNode = null;
      camTarget = { x: 0, y: 0, z: 0, zoom: fitZoom() }; // re-frame at the new grid
    }
  });
  const syncBgBtn = () => {
    bgBtn.textContent = bgMode === "mosaic" ? "▦ mosaic" : bgMode === "galaxy" ? "✦ galaxy" : "○ simple";
    bgBtn.title = "background: gem mosaic → julia galaxy → simple void (independent of layout)";
  };
  syncBgBtn();
  bgBtn.addEventListener("click", () => {
    bgMode = bgMode === "mosaic" ? "galaxy" : bgMode === "galaxy" ? "simple" : "mosaic";
    localStorage.setItem("pear.map.bg", bgMode);
    syncBgBtn();
  });
  // ── hotkeys: +/- zoom · WASD rotate · 0 reset · L layout · G background · [ ] res
  const onMapKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === "INPUT") return;
    switch (e.key) {
      case "+":
      case "=":
        if (camTarget) camTarget.zoom = clampZoom(camTarget.zoom * 1.18);
        else cam.zoom = clampZoom(cam.zoom * 1.18);
        break;
      case "-":
      case "_":
        if (camTarget) camTarget.zoom = clampZoom(camTarget.zoom / 1.18);
        else cam.zoom = clampZoom(cam.zoom / 1.18);
        break;
      case "w":
      case "W":
        rotTarget = null;
        cam.pitch = Math.max(-1.25, cam.pitch - 0.07);
        break;
      case "s":
      case "S":
        rotTarget = null;
        cam.pitch = Math.min(1.25, cam.pitch + 0.07);
        break;
      case "a":
        if (document.querySelector(".jr")) break; // journey owns A (auto-play)
        rotTarget = null;
        cam.yaw += 0.07;
        break;
      case "d":
        if (document.querySelector(".jr")) break; // journey owns D (detail card)
        rotTarget = null;
        cam.yaw -= 0.07;
        break;
      case "0":
        resetView();
        break;
      case "l":
      case "L":
        modeBtn.click();
        break;
      case "g":
      case "G":
        bgBtn.click();
        break;
      case "[":
        applyDensity(DENS - 0.25);
        break;
      case "]":
        applyDensity(DENS + 0.25);
        break;
    }
  };
  document.addEventListener("keydown", onMapKey);

  const resetView = () => {
    focusNode = null;
    camTarget = { x: 0, y: 0, z: 0, zoom: fitZoom() };
    rotTarget = { yaw: 0, pitch: 0 };
  };
  resetBtn.addEventListener("click", resetView);
  modeBtn.addEventListener("click", () => {
    applyLayout(layout === "mandala" ? "flow" : layout === "flow" ? "orbit" : "mandala");
    syncModeBtn();
    focusNode = null;
    camTarget = { x: 0, y: 0, z: 0, zoom: fitZoom() };
  });

  // ── footer ──
  if (doc.understanding.verified.length) {
    const v = document.createElement("div");
    v.className = "rmap-verified";
    v.textContent = `verified: ${doc.understanding.verified.join(" · ")}`;
    side.appendChild(v);
  }
  if (warnings.length) {
    const w = document.createElement("div");
    w.className = "rmap-warnings";
    w.textContent = `⚠ ${warnings.join("; ")}`;
    side.appendChild(w);
  }
  host.appendChild(root);
  t0 = performance.now();
  raf = requestAnimationFrame(draw);

  return {
    side: slot,
    focus(node, zoom) {
      focusNode = node; // tracked live — the node may still be morphing
      camTarget = {
        x: node.x,
        y: node.y,
        z: node.z,
        zoom: clampZoom(zoom ?? (node.kind === "finding" ? 3.4 : node.kind === "beat" ? 1.8 : fitZoom())),
      };
    },
    focusWide() {
      focusNode = null;
      camTarget = { x: 0, y: 0, z: 0, zoom: fitZoom() };
    },
    setJourneyMode(on) {
      journeyMode = on;
      if (!on) {
        focusNode = null;
        camTarget = null;
      }
    },
    moonOf: (id) => moonByFid.get(id),
    planetAt: (i) => beatNodes[i],
    sunObj: () => core,
    setSelected(id, on) {
      if (on) selected.add(id);
      else selected.delete(id);
    },
    showDetail: (f) => detail.show(f),
  };
}

function dimHex(hex: string): string {
  // 45% toward the void — edges whisper, nodes speak.
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(v * 0.45 + 10);
  return `#${((f((n >> 16) & 255) << 16) | (f((n >> 8) & 255) << 8) | f(n & 255)).toString(16).padStart(6, "0")}`;
}

/** The click-through detail card — docks into the right rail (never over the graph). */
function buildDetailCard(root: HTMLElement, cb: MapCallbacks) {
  const card = document.createElement("div");
  card.className = "rmap-card hidden";
  root.appendChild(card);
  const hide = () => card.classList.add("hidden");
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });
  return {
    show(f: RdFinding) {
      card.innerHTML = "";
      const color = TYPE_COLOR[f.type] ?? "#8b949e";
      const head = document.createElement("div");
      head.className = "rmap-card-head";
      head.innerHTML = `<span class="rmap-dot" style="background:${color}"></span><b>${SEV_GLYPH[f.severity] ?? ""} ${escapeText(f.title)}</b><button class="rmap-x">✕</button>`;
      head.querySelector(".rmap-x")!.addEventListener("click", hide);
      card.appendChild(head);
      const meta = document.createElement("div");
      meta.className = "rmap-card-meta";
      const bits = [
        `[${f.type}]`,
        f.severity.replace(/_/g, " "),
        `confidence ${Math.round((f.confidence ?? 1) * 100)}%`,
      ];
      for (const [e, verd] of Object.entries(f.engines)) bits.push(`${e}:${verd}`);
      if (f.status !== "open") bits.push(`status: ${f.status}`);
      meta.textContent = bits.join("  ·  ");
      card.appendChild(meta);
      if (f.anchor) {
        const a = document.createElement("button");
        a.className = "rmap-anchor";
        a.textContent = `↗ ${f.anchor.path}${f.anchor.line ? `:${f.anchor.line}` : ""}`;
        const anchor = f.anchor;
        a.addEventListener("click", () => cb.onJump(anchor.path, anchor.line));
        card.appendChild(a);
      }
      if (f.evidence) {
        const ev = document.createElement("div");
        ev.className = "rmap-card-evidence";
        ev.textContent = f.evidence;
        card.appendChild(ev);
      }
      if (f.rule?.why) {
        const why = document.createElement("div");
        why.className = "rmap-card-why";
        why.innerHTML = `<b>why this matters</b><br>`;
        why.append(f.rule.why);
        card.appendChild(why);
      }
      if (f.suggestion?.patch) {
        const pre = document.createElement("pre");
        pre.className = "rmap-card-patch";
        pre.textContent = f.suggestion.patch;
        const copy = document.createElement("button");
        copy.className = "rmap-copy";
        copy.textContent = "copy patch";
        copy.addEventListener("click", () => {
          void navigator.clipboard.writeText(f.suggestion!.patch);
          copy.textContent = "copied ✓";
        });
        card.appendChild(pre);
        card.appendChild(copy);
      }
      if (f.type === "question") {
        const row = document.createElement("div");
        row.className = "rmap-ask";
        const input = document.createElement("input");
        input.placeholder = "answer / ask the agent about this…";
        const go = document.createElement("button");
        go.textContent = "⏎ to terminal";
        const fire = () => {
          if (!input.value.trim()) return;
          cb.onAsk(f, input.value.trim());
          input.value = "";
          hide();
        };
        go.addEventListener("click", fire);
        input.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") fire();
        });
        row.append(input, go);
        card.appendChild(row);
      }
      card.classList.remove("hidden");
    },
  };
}

function escapeText(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
