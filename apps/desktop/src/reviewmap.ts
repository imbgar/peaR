// The peaRview review map — the rich rendering of a review.pear.v1 doc (step 3 of
// docs/PEARVIEW.md). The visual grammar is IDENTICAL every review (that consistency is
// the v1 learning model): verdict strip → purpose → the walkthrough SPINE down the
// page, each beat carrying its findings as SATELLITES packed by golden-angle
// phyllotaxis (sunflower spiral — organic, deterministic, density-stable, and
// self-similar at the group level later). Encoding never varies:
//   hue = finding type · size = severity · ring opacity = confidence ·
//   spinning dashed ring = engine-disputed · outline-only = question · green = praise.
// Zero deps: layout is pure math, animation is WAAPI (respects reduce-motion).

import type { RdAnchor, RdFinding, ReviewDoc } from "./protocol";

const SVGNS = "http://www.w3.org/2000/svg";
const GOLDEN = 137.50776405003785; // degrees

// type → hue. ONE table (display-layer remap path to fewer buckets — spec decision).
// Evolvability types sit in the warm-neutral band so the empirical 75% doesn't scream.
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
  blocker: 10,
  fix_before_merge: 8,
  follow_up: 6.5,
  take_or_leave: 5,
};
const SEV_GLYPH: Record<string, string> = {
  blocker: "⛔",
  fix_before_merge: "🔶",
  follow_up: "⏳",
  take_or_leave: "💭",
};
const RISK_COLOR: Record<string, string> = {
  low: "var(--bd2)",
  medium: "#d29922",
  high: "#f85149",
};
const RISK_R: Record<string, number> = { low: 8, medium: 10, high: 12 };
const VERDICT_LABEL: Record<string, string> = {
  ready: "✅ ready",
  ready_with_nits: "✅ ready · with nits",
  needs_work: "🔧 needs work",
  blocked: "⛔ blocked",
};

export interface MapCallbacks {
  /** Jump the diff panel to an anchor. */
  onJump: (path: string, line: number | null) => void;
  /** Send a question-reply into the tab's agent terminal. */
  onAsk: (finding: RdFinding, text: string) => void;
  reduceMotion: boolean;
}

interface Sat {
  f: RdFinding;
  x: number;
  y: number;
  r: number;
}
interface BeatBlock {
  id: string;
  title: string;
  body: string;
  risk: string;
  anchors: RdAnchor[];
  y: number;
  sats: Sat[];
  height: number;
}

/** Golden-angle phyllotaxis offsets around a center: j → (dx, dy). */
function phyllo(j: number, base: number): { dx: number; dy: number } {
  const theta = ((j * GOLDEN) % 360) * (Math.PI / 180);
  const r = base * Math.sqrt(j + 0.7);
  return { dx: Math.cos(theta) * r, dy: Math.sin(theta) * r };
}

/** Dock each finding to the beat whose anchors best match its anchor (path, then dir). */
function dockFindings(doc: ReviewDoc): Map<number, RdFinding[]> {
  const beats = doc.understanding.walkthrough;
  const out = new Map<number, RdFinding[]>();
  const dirOf = (p: string) => p.split("/").slice(0, -1).join("/");
  for (const f of doc.findings) {
    let best = -1;
    if (f.anchor) {
      best = beats.findIndex((b) => b.anchors.some((a) => a.path === f.anchor!.path));
      if (best < 0)
        best = beats.findIndex((b) => b.anchors.some((a) => dirOf(a.path) === dirOf(f.anchor!.path)));
    }
    if (best < 0) best = beats.length; // the trailing "everything else" block
    (out.get(best) ?? out.set(best, []).get(best)!).push(f);
  }
  return out;
}

export function renderReviewMap(
  host: HTMLElement,
  doc: ReviewDoc,
  warnings: string[],
  cb: MapCallbacks,
): void {
  host.innerHTML = "";
  const root = document.createElement("div");
  root.className = "rmap";

  // ── verdict strip(s) — the grammar always starts here ──
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

  // ── layout ──
  const W = Math.max(host.clientWidth || 420, 340);
  const spineX = 30;
  const docked = dockFindings(doc);
  const beats: BeatBlock[] = doc.understanding.walkthrough.map((b) => ({
    id: b.id,
    title: b.title,
    body: b.body,
    risk: b.risk,
    anchors: b.anchors,
    y: 0,
    sats: [],
    height: 0,
  }));
  if (docked.has(beats.length) || beats.length === 0) {
    beats.push({
      id: "~",
      title: beats.length ? "other findings" : "findings",
      body: "",
      risk: "low",
      anchors: [],
      y: 0,
      sats: [],
      height: 0,
    });
  }
  let y = 26;
  beats.forEach((blk, i) => {
    blk.y = y;
    const fs = docked.get(i) ?? [];
    // Satellites spiral around a focus below-right of the beat node — phyllotaxis
    // keeps any count readable without overlap logic.
    const cx = spineX + 56;
    const cy = blk.y + 40;
    let maxY = blk.y + 30;
    fs
      .slice()
      .sort((a, b) => (SEV_R[b.severity] ?? 5) - (SEV_R[a.severity] ?? 5)) // big first → center
      .forEach((f, j) => {
        const { dx, dy } = phyllo(j, 17);
        const r = SEV_R[f.severity] ?? 5;
        const x = Math.min(Math.max(cx + dx, spineX + 24), W - 20);
        const yy = cy + dy;
        blk.sats.push({ f, x, y: yy, r });
        maxY = Math.max(maxY, yy + r);
      });
    blk.height = Math.max(fs.length ? maxY - blk.y + 26 : 44, 44);
    y += blk.height;
  });
  const H = y + 12;

  // ── svg ──
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", "100%");
  svg.classList.add("rmap-svg");
  const defs = document.createElementNS(SVGNS, "defs");
  defs.innerHTML = `
    <linearGradient id="rmap-spine" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="var(--accent)" stop-opacity="0.9"/>
      <stop offset="1" stop-color="var(--accent)" stop-opacity="0.25"/>
    </linearGradient>
    <filter id="rmap-glow" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="3.5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>`;
  svg.appendChild(defs);

  // Spine (draw-in animated).
  const spine = document.createElementNS(SVGNS, "path");
  spine.setAttribute("d", `M ${spineX} 8 V ${H - 16}`);
  spine.setAttribute("stroke", "url(#rmap-spine)");
  spine.setAttribute("stroke-width", "2");
  spine.setAttribute("fill", "none");
  svg.appendChild(spine);

  const anim = !cb.reduceMotion;
  if (anim) {
    const len = H;
    spine.setAttribute("stroke-dasharray", String(len));
    spine.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], {
      duration: 650,
      easing: "ease-out",
      fill: "both",
    });
  }

  const detail = buildDetailCard(root, cb);
  let beatDelay = 150;
  beats.forEach((blk) => {
    const g = document.createElementNS(SVGNS, "g");
    // Beat node — risk ring on the spine.
    const node = document.createElementNS(SVGNS, "circle");
    node.setAttribute("cx", String(spineX));
    node.setAttribute("cy", String(blk.y + 12));
    node.setAttribute("r", String(RISK_R[blk.risk] ?? 8));
    node.setAttribute("fill", "var(--elev)");
    node.setAttribute("stroke", RISK_COLOR[blk.risk] ?? "var(--bd2)");
    node.setAttribute("stroke-width", "2");
    g.appendChild(node);
    // Beat title (foreignObject so it wraps).
    const fo = document.createElementNS(SVGNS, "foreignObject");
    fo.setAttribute("x", String(spineX + 18));
    fo.setAttribute("y", String(blk.y));
    fo.setAttribute("width", String(W - spineX - 26));
    fo.setAttribute("height", "30");
    const t = document.createElement("div");
    t.className = "rmap-beat-title";
    t.textContent = blk.title;
    if (blk.body) t.title = blk.body;
    fo.appendChild(t);
    g.appendChild(fo);
    // Satellites + curved connectors.
    blk.sats.forEach((s, j) => {
      const conn = document.createElementNS(SVGNS, "path");
      const bx = spineX;
      const by = blk.y + 12;
      conn.setAttribute(
        "d",
        `M ${bx} ${by} Q ${(bx + s.x) / 2} ${(by + s.y) / 2 + 14} ${s.x} ${s.y}`,
      );
      conn.setAttribute("stroke", "var(--bd)");
      conn.setAttribute("stroke-width", "1");
      conn.setAttribute("fill", "none");
      conn.setAttribute("opacity", "0.6");
      g.appendChild(conn);

      const sg = document.createElementNS(SVGNS, "g");
      sg.classList.add("rmap-sat");
      const color = TYPE_COLOR[s.f.type] ?? "#8b949e";
      const isQ = s.f.type === "question";
      const blockerHalo = s.f.severity === "blocker";
      if (blockerHalo) {
        const halo = document.createElementNS(SVGNS, "circle");
        halo.setAttribute("cx", String(s.x));
        halo.setAttribute("cy", String(s.y));
        halo.setAttribute("r", String(s.r + 4));
        halo.setAttribute("fill", color);
        halo.setAttribute("opacity", "0.25");
        sg.appendChild(halo);
        if (anim)
          halo.animate(
            [{ opacity: 0.3, transform: "scale(1)" }, { opacity: 0.06, transform: "scale(1.45)" }, { opacity: 0.3, transform: "scale(1)" }],
            { duration: 1800, iterations: Infinity, easing: "ease-in-out" },
          );
        (halo.style as CSSStyleDeclaration).transformOrigin = `${s.x}px ${s.y}px`;
      }
      const c = document.createElementNS(SVGNS, "circle");
      c.setAttribute("cx", String(s.x));
      c.setAttribute("cy", String(s.y));
      c.setAttribute("r", String(s.r));
      c.setAttribute("fill", isQ ? "transparent" : color);
      c.setAttribute("stroke", color);
      c.setAttribute("stroke-width", isQ ? "2" : "1.5");
      c.setAttribute("stroke-opacity", String(0.35 + 0.65 * (s.f.confidence ?? 1)));
      if (s.f.severity === "blocker" || s.f.severity === "fix_before_merge")
        c.setAttribute("filter", "url(#rmap-glow)");
      if (s.f.status !== "open") c.setAttribute("fill-opacity", "0.25");
      sg.appendChild(c);
      // Engine-disputed → slowly spinning dashed ring.
      if (Object.values(s.f.engines).includes("dispute")) {
        const ring = document.createElementNS(SVGNS, "circle");
        ring.setAttribute("cx", String(s.x));
        ring.setAttribute("cy", String(s.y));
        ring.setAttribute("r", String(s.r + 4.5));
        ring.setAttribute("fill", "none");
        ring.setAttribute("stroke", color);
        ring.setAttribute("stroke-width", "1.2");
        ring.setAttribute("stroke-dasharray", "3 4");
        sg.appendChild(ring);
        if (anim) {
          (ring.style as CSSStyleDeclaration).transformOrigin = `${s.x}px ${s.y}px`;
          ring.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
            duration: 9000,
            iterations: Infinity,
            easing: "linear",
          });
        }
      }
      const title = document.createElementNS(SVGNS, "title");
      title.textContent = `${SEV_GLYPH[s.f.severity] ?? ""} [${s.f.type}] ${s.f.title}`;
      sg.appendChild(title);
      sg.addEventListener("click", () => detail.show(s.f, s.x, s.y));
      if (anim) {
        (sg.style as CSSStyleDeclaration).transformOrigin = `${s.x}px ${s.y}px`;
        sg.animate(
          [{ transform: "scale(0)", opacity: 0 }, { transform: "scale(1.15)", opacity: 1, offset: 0.7 }, { transform: "scale(1)", opacity: 1 }],
          { duration: 360, delay: beatDelay + 140 + j * 55, easing: "ease-out", fill: "backwards" },
        );
      }
      g.appendChild(sg);
    });
    if (anim) {
      (g.style as CSSStyleDeclaration).transformOrigin = `${spineX}px ${blk.y + 12}px`;
      g.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" }], {
        duration: 320,
        delay: beatDelay,
        easing: "ease-out",
        fill: "backwards",
      });
    }
    svg.appendChild(g);
    beatDelay += 130;
  });
  root.appendChild(svg);

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
}

/** The click-through detail card: evidence, the rule's teaching block, the committable
 *  patch, engine attribution — and for questions, the v1 reply-into-terminal box. */
function buildDetailCard(root: HTMLElement, cb: MapCallbacks) {
  const card = document.createElement("div");
  card.className = "rmap-card hidden";
  root.appendChild(card);
  const hide = () => card.classList.add("hidden");
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });
  return {
    show(f: RdFinding, _x: number, _y: number) {
      card.innerHTML = "";
      const color = TYPE_COLOR[f.type] ?? "#8b949e";
      const head = document.createElement("div");
      head.className = "rmap-card-head";
      head.innerHTML = `<span class="rmap-dot" style="background:${color}"></span><b>${SEV_GLYPH[f.severity] ?? ""} ${escapeText(f.title)}</b><button class="rmap-x">✕</button>`;
      head.querySelector(".rmap-x")!.addEventListener("click", hide);
      card.appendChild(head);
      const meta = document.createElement("div");
      meta.className = "rmap-card-meta";
      const bits = [`[${f.type}]`, f.severity.replace(/_/g, " "), `confidence ${Math.round((f.confidence ?? 1) * 100)}%`];
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
