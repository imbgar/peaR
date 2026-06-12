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

// Luminance ramps (dense → sparse). One law, every scale.
const DISC_RAMP = ["@", "%", "#", "*", "+", "=", ":", "·"];
const BG_RAMP = " ··::;;==++xxXX##";
const FLOW = "·∙•∙"; // edge phase chars
const VOID = { r: 0x15, g: 0x19, b: 0x2a }; // what depth fades toward

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
  const modeBtn = document.createElement("button");
  modeBtn.className = "rmap-mode";
  stage.appendChild(modeBtn);

  // Cell metrics — 10× density: glyphs are ~2×4 px texture, not letters.
  const FONT = 3.8;
  const CW = 2.2;
  const CH = 4;
  const ASPECT = CH / CW; // a cell is ~1.8× taller than wide
  const SIDE_W = 380;
  let W = Math.max((host.clientWidth || 800) - SIDE_W - 12, 320);
  const H = cb.stageHeight ?? 470;
  let cols = 0;
  let rows = 0;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const TW = Math.round(CW * dpr); // tile size in device px (integer → clean copies)
  const TH = Math.round(CH * dpr);
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
  scratch.width = TW;
  scratch.height = TH;
  const sctx = scratch.getContext("2d", { willReadFrequently: true })!;
  const atlas = new Map<string, Uint32Array>();
  const tile = (ch: string, color: string): Uint32Array => {
    const key = `${ch}|${color}`;
    let t = atlas.get(key);
    if (!t) {
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
  const BG_PACKED = tile(" ", "#05070c")[0]; // packed void color, endian-correct
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
  type LayoutMode = "flow" | "orbit";
  let layout: LayoutMode =
    (localStorage.getItem("pear.map.layout") as LayoutMode) === "orbit" ? "orbit" : "flow";
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
    if (mode === "orbit") {
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
  applyLayout(layout);
  nodes.forEach((n) => {
    n.x = n.tx;
    n.y = n.ty;
    n.z = n.tz;
  });

  // ── orbit camera: yaw/pitch around a target, perspective projection ──
  const FOV = 42; // perspective strength (world units to the projection plane)
  const extent = () =>
    nodes.reduce((m, n) => Math.max(m, Math.abs(n.tx) + 8, Math.abs(n.ty) + 6, Math.abs(n.tz) + 6), 18);
  const fitZoom = () => Math.min(cols / (extent() * 2.3), rows / (extent() * 1.28));
  const cam = { x: 0, y: 0, z: 0, zoom: fitZoom(), yaw: 0.35, pitch: 0.22 };
  let camTarget: { x: number; y: number; z: number; zoom: number } | null = null;
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
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.1 : 0.9;
    if (camTarget) camTarget.zoom = Math.max(fitZoom() * 0.5, Math.min(7, camTarget.zoom * f));
    else cam.zoom = Math.max(fitZoom() * 0.5, Math.min(7, cam.zoom * f));
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
    if (!cb.reduceMotion && !dragging && !journeyMode) cam.yaw += 0.0009;

    fb.fill(BG_PACKED);
    overlays = [];

    // 1 · Julia field (screen space with yaw/pitch parallax — the void turns with you)
    const th = (cb.reduceMotion ? 0 : t * 0.05) + 2.2;
    const jx = 0.7885 * Math.cos(th);
    const jy = 0.7885 * Math.sin(th);
    const ox = cam.yaw * 9;
    const oy = cam.pitch * 7;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const wx = (c - cols / 2) / cam.zoom + ox;
        const wy = ((r - rows / 2) / cam.zoom) * (ASPECT / 1.05) + oy;
        const n = julia(wx * 0.022, wy * 0.04, jx, jy);
        if (n > 2) put(c, r, BG_RAMP[Math.min(n, BG_RAMP.length - 1)], n % 2 ? BG_A : BG_B);
      }
    }

    // 2 · edges (3D-sampled, depth-shaded, flow phase runs downstream)
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
    if (layout === "orbit") {
      for (const bn of beatNodes) edge(core, bn, "#3d4761");
    } else {
      for (let i = 0; i + 1 < beatNodes.length; i++) edge(beatNodes[i], beatNodes[i + 1], "#46506a");
      if (beatNodes.length) edge(beatNodes[beatNodes.length - 1], core, "#46506a");
    }
    for (const fn of findingNodes) {
      const bn = beatOf(fn);
      if (layout === "flow") edge(fn, bn, dimHex(fn.color));
      else edge(bn, fn, dimHex(fn.color));
    }

    // 3 · nodes, painter's order (far → near), glyph-ramp discs with depth cueing
    const disc = (n: MapNode, p: Proj, wob: number) => {
      const R = Math.max(n.r * p.s, 0.8);
      const color = shade(n.color, p.depth);
      const rIn = Math.ceil(R);
      for (let dr = -rIn; dr <= rIn; dr++) {
        for (let dc = -Math.ceil(R * 1.9); dc <= Math.ceil(R * 1.9); dc++) {
          const d = Math.hypot(dc / 1.9, dr) / R;
          if (d > 1) continue;
          const idx = Math.min(
            DISC_RAMP.length - 1,
            Math.floor(d * DISC_RAMP.length + wob * 0.6) % DISC_RAMP.length,
          );
          put(Math.round(p.col + dc), Math.round(p.row + dr), DISC_RAMP[Math.abs(idx)], color);
        }
      }
    };
    const breathe = cb.reduceMotion ? 0 : Math.sin(t * 1.6) * 0.4;
    core.r = 4.2 + breathe * 0.4;
    const order = nodes
      .map((n) => ({ n, p: project(n.x, n.y, n.z) }))
      .sort((a, b) => b.p.depth - a.p.depth);
    for (const { n, p } of order) {
      if (n.kind === "core") {
        disc(n, p, cb.reduceMotion ? 0 : t * 1.5);
        continue;
      }
      if (n.kind === "beat") {
        disc(n, p, cb.reduceMotion ? 0 : t * 0.8);
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
      if (f.type === "question") put(Math.round(p.col), Math.round(p.row), "?", shade(n.color, p.depth));
      else if (f.type === "praise") put(Math.round(p.col), Math.round(p.row), "+", shade(n.color, p.depth));
      else disc(n, p, pulse ? 2 : 0);
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

    // 4 · hover halo + status line + fps
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
  };

  const ro = new ResizeObserver(() => {
    W = Math.max(host.clientWidth - SIDE_W - 12, 320);
    sizeCanvas();
  });
  ro.observe(host);

  const dispose = () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    atlas.clear();
    shadeCache.clear();
    teardown = null;
  };
  teardown = dispose;

  const detail = buildDetailCard(slot, cb);
  const syncModeBtn = () => {
    modeBtn.textContent = layout === "flow" ? "≋ flow" : "✿ orbit";
    modeBtn.title =
      "toggle layout: flow river ⇄ phyllotaxis orbit (morphs live) · drag rotates · wheel zooms · dblclick re-frames";
  };
  syncModeBtn();
  modeBtn.addEventListener("click", () => {
    applyLayout(layout === "flow" ? "orbit" : "flow");
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
        zoom: zoom ?? (node.kind === "finding" ? 3.2 : node.kind === "beat" ? 1.9 : fitZoom()),
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
