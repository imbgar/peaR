// The peaRview review map — ANIMATED ASCII (replaces the WebGL galaxy; step 3 of
// docs/PEARVIEW.md, take 3). Terminal-native to the bone: the whole scene is a
// character grid rendered to canvas through a glyph atlas, full redraw every frame,
// uncapped requestAnimationFrame (M-series sustains 60-120 fps).
//
// The math is the visual design:
//   · BACKGROUND — a live Julia set, c(t) drifting along the cardioid's rim, rendered
//     as an escape-time luminance ramp in two deep-space tones (fractal geometry,
//     literally, morphing in real time)
//   · LAYOUT — golden-angle phyllotaxis at EVERY scale (self-similar): beats spiral
//     around the verdict core exactly as findings spiral around their beat
//   · NODES — glyph-ramp discs: the same ramp law renders the core, planets, and
//     moons at their own radii (fractal self-similarity again)
//   · EDGES — Bresenham character lines with phase-animated flow (data streams)
// Encoding unchanged from the galaxy: color = type · size = severity · pulse =
// blocker · orbiting / | \ - = engine-disputed · "?" = question · "+" = praise ·
// gold brackets = selected. Click a node → the detail card. Drag pans, wheel zooms.
//
// The journey drives this through the SAME MapHandle surface the galaxy exposed —
// focus flights are now damped pan/zoom in grid space.

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

export interface MapCallbacks {
  onJump: (path: string, line: number | null) => void;
  onAsk: (finding: RdFinding, text: string) => void;
  reduceMotion: boolean;
  /** Canvas height in px (the pop-out theater passes the full window). Default 470. */
  stageHeight?: number;
}

/** A node in grid space (cells). Opaque to callers — the journey passes them back. */
export interface MapNode {
  id: string;
  kind: "core" | "beat" | "finding";
  x: number;
  y: number;
  r: number;
  color: string;
  finding?: RdFinding;
  label?: string;
}

export interface MapHandle {
  /** Pan/zoom flight to a node; `zoom` = target magnification (default by kind). */
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

export function renderReviewMap(
  host: HTMLElement,
  doc: ReviewDoc,
  warnings: string[],
  cb: MapCallbacks,
): MapHandle {
  teardown?.();
  host.innerHTML = "";
  const root = document.createElement("div");
  root.className = "rmap";

  // ── verdict strip(s) + purpose: readable text stays HTML ──
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
    root.appendChild(strip);
    if (v.scope) {
      const sc = document.createElement("div");
      sc.className = "rmap-scope";
      sc.textContent = `pass scope: ${v.scope}`;
      root.appendChild(sc);
    }
  }
  const purpose = document.createElement("div");
  purpose.className = "rmap-purpose";
  purpose.textContent = doc.understanding.purpose;
  root.appendChild(purpose);

  // ── the stage ──
  const stage = document.createElement("div");
  stage.className = "rmap-stage";
  root.appendChild(stage);
  const canvas = document.createElement("canvas");
  stage.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;

  // Cell metrics (a tight terminal grid).
  const FONT = 11;
  const CW = 6.6;
  const CH = 12;
  let W = Math.max(host.clientWidth || 460, 340) - 24;
  let H = cb.stageHeight ?? 470;
  let cols = 0;
  let rows = 0;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const sizeCanvas = () => {
    cols = Math.floor(W / CW);
    rows = Math.floor(H / CH);
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
  };
  sizeCanvas();

  // Glyph atlas: one tiny pre-rendered tile per (char, color) — fillText is far too
  // slow for a full-grid redraw; drawImage from the atlas isn't.
  const atlas = new Map<string, HTMLCanvasElement>();
  const tile = (ch: string, color: string): HTMLCanvasElement => {
    const key = `${ch}|${color}`;
    let t = atlas.get(key);
    if (!t) {
      t = document.createElement("canvas");
      t.width = Math.ceil(CW * dpr);
      t.height = Math.ceil(CH * dpr);
      const tc = t.getContext("2d")!;
      tc.scale(dpr, dpr);
      tc.font = `${FONT}px ui-monospace, Menlo, monospace`;
      tc.textBaseline = "middle";
      tc.textAlign = "center";
      tc.fillStyle = color;
      tc.fillText(ch, CW / 2, CH / 2 + 0.5);
      atlas.set(key, t);
    }
    return t;
  };
  const put = (col: number, row: number, ch: string, color: string) => {
    if (col < 0 || row < 0 || col >= cols || row >= rows || ch === " ") return;
    ctx.drawImage(tile(ch, color), Math.round(col * CW * dpr), Math.round(row * CH * dpr));
  };
  const text = (col: number, row: number, s: string, color: string) => {
    for (let i = 0; i < s.length; i++) put(col + i, row, s[i], color);
  };

  // ── world layout: phyllotaxis at every scale (units = cells at zoom 1) ──
  const docked = dockFindings(doc);
  const beats = [...doc.understanding.walkthrough.map((b) => ({ title: b.title, body: b.body, risk: b.risk }))];
  if (docked.has(beats.length) || beats.length === 0)
    beats.push({ title: beats.length ? "other findings" : "findings", body: "", risk: "low" });

  const core: MapNode = {
    id: "__core__",
    kind: "core",
    x: 0,
    y: 0,
    r: 4.4,
    color: VERDICT_COLOR[state0] ?? "#3fb950",
  };
  const beatNodes: MapNode[] = [];
  const findingNodes: MapNode[] = [];
  beats.forEach((b, i) => {
    const ang = i * GOLDEN + 0.8;
    const rad = 15 + 6.5 * Math.sqrt(i + 1);
    const bn: MapNode = {
      id: `__beat${i}__`,
      kind: "beat",
      x: Math.cos(ang) * rad * 1.9, // ×1.9: cells are taller than wide — circularize
      y: Math.sin(ang) * rad,
      r: RISK_R[b.risk] ?? 2.1,
      color: RISK_COLOR[b.risk] ?? "#6e7681",
      label: `${i + 1}·${b.title}`,
    };
    beatNodes.push(bn);
    const fs = (docked.get(i) ?? [])
      .slice()
      .sort((a, c) => (SEV_R[c.severity] ?? 1) - (SEV_R[a.severity] ?? 1));
    fs.forEach((f, j) => {
      const fa = j * GOLDEN + i * 1.3;
      const fr = bn.r + 3.2 + 1.8 * Math.sqrt(j + 0.5);
      findingNodes.push({
        id: f.id,
        kind: "finding",
        x: bn.x + Math.cos(fa) * fr * 1.9,
        y: bn.y + Math.sin(fa) * fr,
        r: SEV_R[f.severity] ?? 1,
        color: TYPE_COLOR[f.type] ?? "#8b949e",
        finding: f,
      });
    });
  });
  const nodes = [core, ...beatNodes, ...findingNodes];
  const moonByFid = new Map(findingNodes.map((n) => [n.id, n]));
  const beatOf = (n: MapNode): MapNode =>
    beatNodes.reduce((a, b) => (dist2(n, a) < dist2(n, b) ? a : b), beatNodes[0]);
  const dist2 = (a: MapNode, b: MapNode) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

  // ── camera (pan in world cells, zoom = magnification) ──
  const extent = nodes.reduce((m, n) => Math.max(m, Math.abs(n.x) + 8, Math.abs(n.y) + 5), 20);
  const fitZoom = () => Math.min(cols / (extent * 2.2), rows / (extent * 1.35));
  const cam = { x: 0, y: 0, z: fitZoom() };
  let camTarget: { x: number; y: number; z: number } | null = null;
  const selected = new Set<string>();
  let journeyMode = false;
  let hovered: MapNode | null = null;

  const toScreen = (n: { x: number; y: number }) => ({
    col: cols / 2 + (n.x - cam.x) * cam.z,
    row: rows / 2 + ((n.y - cam.y) * cam.z) / (CH / CW / 1.05), // aspect-correct
  });

  // ── input: drag pans, wheel zooms, click picks ──
  let dragging = false;
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
      if (Math.abs(dx) + Math.abs(dy) > 2) {
        dragMoved = true;
        camTarget = null; // the user took the wheel
        cam.x -= dx / CW / cam.z;
        cam.y -= (dy / CH / cam.z) * (CH / CW / 1.05);
      }
      last = { x: e.clientX, y: e.clientY };
      return;
    }
    // hover pick (screen-space)
    const mc = (e.clientX - rect.left) / CW;
    const mr = (e.clientY - rect.top) / CH;
    hovered = pick(mc, mr);
    canvas.style.cursor = hovered ? "pointer" : "grab";
  });
  canvas.addEventListener("pointerup", (e) => {
    dragging = false;
    if (dragMoved) return;
    const rect = canvas.getBoundingClientRect();
    const n = pick((e.clientX - rect.left) / CW, (e.clientY - rect.top) / CH);
    if (n?.finding) detail.show(n.finding);
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    camTarget = null;
    cam.z = Math.max(fitZoom() * 0.6, Math.min(6, cam.z * (e.deltaY < 0 ? 1.1 : 0.9)));
  });
  const pick = (mc: number, mr: number): MapNode | null => {
    let best: MapNode | null = null;
    let bd = 9;
    for (const n of nodes) {
      if (n.kind === "core") continue;
      const s = toScreen(n);
      const d = (s.col - mc) ** 2 + ((s.row - mr) * 1.8) ** 2;
      const hit = Math.max(n.r * cam.z * 1.6, 2.5) ** 2;
      if (d < hit && d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  };

  // ── fractal background: Julia set, c(t) drifting along the cardioid rim ──
  const julia = (zx: number, zy: number, cx: number, cy: number): number => {
    let n = 0;
    while (n < 16 && zx * zx + zy * zy < 4) {
      const t = zx * zx - zy * zy + cx;
      zy = 2 * zx * zy + cy;
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

    // camera damping
    if (camTarget) {
      const k = 1 - Math.exp(-0.12);
      cam.x += (camTarget.x - cam.x) * k;
      cam.y += (camTarget.y - cam.y) * k;
      cam.z += (camTarget.z - cam.z) * k;
    }

    ctx.fillStyle = "#05070c";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 1 · Julia field (sampled in WORLD space so it pans/zooms with the graph)
    const th = (cb.reduceMotion ? 0 : t * 0.05) + 2.2;
    const cx = 0.7885 * Math.cos(th);
    const cy = 0.7885 * Math.sin(th);
    const step = cam.z > 2 ? 1 : 1; // dense always — it's cheap
    for (let r = 0; r < rows; r += step) {
      for (let c = 0; c < cols; c += step) {
        const wx = (c - cols / 2) / cam.z + cam.x;
        const wy = ((r - rows / 2) / cam.z) * (CH / CW / 1.05) + cam.y;
        const n = julia(wx * 0.022, wy * 0.04, cx, cy);
        if (n > 2) {
          const ch = BG_RAMP[Math.min(n, BG_RAMP.length - 1)];
          put(c, r, ch, n % 2 ? BG_A : BG_B);
        }
      }
    }

    // 2 · edges with flowing phase
    const edge = (a: MapNode, b: MapNode, color: string) => {
      const sa = toScreen(a);
      const sb = toScreen(b);
      const len = Math.hypot(sb.col - sa.col, sb.row - sa.row);
      const steps = Math.max(2, Math.floor(len));
      for (let i = 1; i < steps; i++) {
        const s = i / steps;
        const col = Math.round(sa.col + (sb.col - sa.col) * s);
        const row = Math.round(sa.row + (sb.row - sa.row) * s);
        const phase = Math.floor(s * len - (cb.reduceMotion ? 0 : t * 7));
        put(col, row, FLOW[((phase % FLOW.length) + FLOW.length) % FLOW.length], color);
      }
    };
    for (const bn of beatNodes) edge(core, bn, "#2b3344");
    for (const fn of findingNodes) edge(beatOf(fn), fn, dim(fn.color));

    // 3 · nodes — glyph-ramp discs (one law, every scale)
    const disc = (n: MapNode, wob: number) => {
      const s = toScreen(n);
      const R = Math.max(n.r * cam.z, 0.8);
      const rIn = Math.ceil(R);
      for (let dr = -rIn; dr <= rIn; dr++) {
        for (let dc = -Math.ceil(R * 1.9); dc <= Math.ceil(R * 1.9); dc++) {
          const d = Math.hypot(dc / 1.9, dr) / R;
          if (d > 1) continue;
          const idx = Math.min(
            DISC_RAMP.length - 1,
            Math.floor(d * DISC_RAMP.length + wob * 0.6) % DISC_RAMP.length,
          );
          put(Math.round(s.col + dc), Math.round(s.row + dr), DISC_RAMP[Math.abs(idx)], n.color);
        }
      }
      return s;
    };
    // core breathes
    const breathe = cb.reduceMotion ? 0 : Math.sin(t * 1.6) * 0.5;
    core.r = 4.4 + breathe * 0.4;
    disc(core, cb.reduceMotion ? 0 : t * 1.5);
    for (const bn of beatNodes) {
      const s = disc(bn, cb.reduceMotion ? 0 : t * 0.8);
      if (cam.z > 0.55 && bn.label)
        text(Math.round(s.col + bn.r * cam.z * 1.9 + 2), Math.round(s.row), bn.label.slice(0, 26), "#8b949e");
    }
    for (const fn of findingNodes) {
      const f = fn.finding!;
      const pulse = f.severity === "blocker" && !cb.reduceMotion && Math.sin(t * 6) > 0;
      const s = toScreen(fn);
      if (f.type === "question") {
        put(Math.round(s.col), Math.round(s.row), "?", fn.color);
      } else if (f.type === "praise") {
        put(Math.round(s.col), Math.round(s.row), "+", fn.color);
      } else {
        disc(fn, pulse ? 2 : 0);
      }
      if (f.status !== "open") put(Math.round(s.col), Math.round(s.row), "·", "#444c56");
      // engine-disputed → orbiting / - \ |
      if (Object.values(f.engines).includes("dispute")) {
        const oa = cb.reduceMotion ? 0.8 : t * 2.2;
        const or_ = fn.r * cam.z + 2;
        for (let k = 0; k < 4; k++) {
          const a = oa + (k * Math.PI) / 2;
          put(
            Math.round(s.col + Math.cos(a) * or_ * 1.9),
            Math.round(s.row + Math.sin(a) * or_),
            "/-\\|"[k],
            fn.color,
          );
        }
      }
      // selected → gold brackets
      if (selected.has(fn.id)) {
        const off = Math.max(fn.r * cam.z * 1.9 + 1, 2);
        put(Math.round(s.col - off), Math.round(s.row), "[", "#ffd866");
        put(Math.round(s.col + off), Math.round(s.row), "]", "#ffd866");
      }
    }

    // 4 · hover halo + status line
    if (hovered) {
      const s = toScreen(hovered);
      const hr = Math.max(hovered.r * cam.z + 1.5, 2.5);
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2 + (cb.reduceMotion ? 0 : t * 1.2);
        put(Math.round(s.col + Math.cos(a) * hr * 1.9), Math.round(s.row + Math.sin(a) * hr), "·", "#e6edf3");
      }
      const f = hovered.finding;
      const line = f
        ? `${SEV_GLYPH[f.severity] ?? ""} [${f.type}] ${f.id} — ${f.title}`
        : (hovered.label ?? "");
      text(1, rows - 1, line.slice(0, cols - 14), f ? hovered.color : "#8b949e");
    }
    text(cols - 9, 0, `${String(fps).padStart(3, " ")} fps`, "#30363d");
  };

  const ro = new ResizeObserver(() => {
    W = Math.max(host.clientWidth - 24, 280);
    sizeCanvas();
  });
  ro.observe(host);

  const dispose = () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    atlas.clear();
    teardown = null;
  };
  teardown = dispose;

  const detail = buildDetailCard(root, cb);

  // ── footer ──
  if (doc.understanding.verified.length) {
    const v = document.createElement("div");
    v.className = "rmap-verified";
    v.textContent = `verified: ${doc.understanding.verified.join(" · ")}`;
    root.appendChild(v);
  }
  if (warnings.length) {
    const w = document.createElement("div");
    w.className = "rmap-warnings";
    w.textContent = `⚠ ${warnings.join("; ")}`;
    root.appendChild(w);
  }
  host.appendChild(root);
  t0 = performance.now();
  raf = requestAnimationFrame(draw);

  return {
    focus(node, zoom) {
      camTarget = { x: node.x, y: node.y, z: zoom ?? (node.kind === "finding" ? 3.2 : node.kind === "beat" ? 1.9 : fitZoom()) };
    },
    focusWide() {
      camTarget = { x: 0, y: 0, z: fitZoom() };
    },
    setJourneyMode(on) {
      journeyMode = on;
      if (!on) camTarget = null;
      void journeyMode;
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

function dim(hex: string): string {
  // 45% toward the void — edges whisper, nodes speak.
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(v * 0.45 + 10);
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/** The click-through detail card (unchanged surface from the galaxy version). */
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
