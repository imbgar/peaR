import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/ibm-plex-mono/700.css";
import "@fontsource-variable/hanken-grotesk";
import "@fontsource-variable/jetbrains-mono";
import { marked } from "marked";
import { parse as parseSearchQuery, type SearchParserResult } from "search-query-parser";
import { renderMarkdown } from "./markdown";
import { initUpdater } from "./update";
import {
  renderDiff,
  parseDiff,
  commentEl,
  setReactionHandler,
  setCreateHandler,
  setReplyHandler,
  setAskHandler,
  setResolveHandler,
  setPendingReview,
  setDiffCloseHandler,
  setApproveHandler,
  jumpToThread,
  type TreeLevel,
} from "./diff";
import {
  Command,
  Event as CoreEvent,
  CliKind,
  Comment,
  DiffComment,
  Favorites,
  PanelPayload,
  PrComments,
  PrMeta,
  PrRecord,
  PrRef,
  PrStatus,
  Queue,
  QueueItem,
  ReviewButton,
  ReviewThread,
  ReviewTier,
  Watches,
  WinLayoutWire,
  PaneTreeWire,
  parsePrRef,
  shortLabel,
} from "./protocol";

// ── per-theme xterm palettes (match the two app themes) ─────────────────────
const XTERM_THEMES: Record<string, Record<string, string>> = {
  phosphor: {
    background: "#0a0701", foreground: "#f1cb74", cursor: "#ffb000", cursorAccent: "#0a0701",
    selectionBackground: "#3a2a06",
    black: "#1a1304", red: "#ff6a4a", green: "#9bd24e", yellow: "#ffb000", blue: "#ffcf7a",
    magenta: "#ffa657", cyan: "#e3b341", white: "#f1cb74",
    brightBlack: "#74591b", brightRed: "#ff8a6a", brightGreen: "#b6e86a", brightYellow: "#ffc94d",
    brightBlue: "#ffe0a0", brightMagenta: "#ffc07a", brightCyan: "#f0cb5a", brightWhite: "#fff0d0",
  },
  instrument: {
    background: "#08090c", foreground: "#d7dae0", cursor: "#c6f24e", cursorAccent: "#08090c",
    selectionBackground: "#2a3a4a",
    black: "#15171c", red: "#ff6b6b", green: "#c6f24e", yellow: "#f0c674", blue: "#6cb6ff",
    magenta: "#d2a8ff", cyan: "#76e0d6", white: "#c9ccd3",
    brightBlack: "#4b5263", brightRed: "#ff8585", brightGreen: "#9af2a8", brightYellow: "#ffd789",
    brightBlue: "#8cc8ff", brightMagenta: "#e0c0ff", brightCyan: "#95efe6", brightWhite: "#ffffff",
  },
  vscode: {
    background: "#1e1e1e", foreground: "#d4d4d4", cursor: "#aeafad", cursorAccent: "#1e1e1e",
    selectionBackground: "#264f78",
    black: "#000000", red: "#f44747", green: "#6a9955", yellow: "#d7ba7d", blue: "#569cd6",
    magenta: "#c586c0", cyan: "#4ec9b0", white: "#d4d4d4",
    brightBlack: "#808080", brightRed: "#f44747", brightGreen: "#b5cea8", brightYellow: "#dcdcaa",
    brightBlue: "#9cdcfe", brightMagenta: "#c586c0", brightCyan: "#4ec9b0", brightWhite: "#ffffff",
  },
  dark: {
    background: "#0d1117", foreground: "#e6edf3", cursor: "#2f81f7", cursorAccent: "#0d1117",
    selectionBackground: "#264166",
    black: "#484f58", red: "#ff7b72", green: "#3fb950", yellow: "#d29922", blue: "#58a6ff",
    magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
    brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364", brightYellow: "#e3b341",
    brightBlue: "#79c0ff", brightMagenta: "#d2a8ff", brightCyan: "#56d4dd", brightWhite: "#f0f6fc",
  },
  "macos-dark": {
    background: "#1d1d1f", foreground: "#f5f5f7", cursor: "#0a84ff", cursorAccent: "#1d1d1f",
    selectionBackground: "#2a4a6e",
    black: "#3a3a3e", red: "#ff453a", green: "#32d74b", yellow: "#ffd60a", blue: "#0a84ff",
    magenta: "#bf5af2", cyan: "#64d2ff", white: "#f5f5f7",
    brightBlack: "#6e6e73", brightRed: "#ff6961", brightGreen: "#66e06f", brightYellow: "#ffe04a",
    brightBlue: "#409cff", brightMagenta: "#da8fff", brightCyan: "#8ce0ff", brightWhite: "#ffffff",
  },
  light: {
    background: "#ffffff", foreground: "#1f2328", cursor: "#0969da", cursorAccent: "#ffffff",
    selectionBackground: "#b6e3ff",
    black: "#24292f", red: "#cf222e", green: "#1a7f37", yellow: "#9a6700", blue: "#0969da",
    magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
    brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#633c01",
    brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f",
  },
};
const MONO = '"IBM Plex Mono", ui-monospace, monospace';
const JB = '"JetBrains Mono Variable", ui-monospace, monospace';
const TERM_FONT: Record<string, string> = {
  phosphor: MONO,
  instrument: JB,
  vscode: JB,
  dark: JB,
  "macos-dark": '"SF Mono", ui-monospace, monospace',
  light: MONO,
};

function currentTheme(): string {
  return document.documentElement.dataset.theme || "instrument";
}

// ── per-tab view state ──────────────────────────────────────────────────────
interface TabView {
  id: number;
  title: string;
  subtitle: string;
  cli: CliKind;
  pr: PrRef | null;
  meta: PrMeta | null;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
}

const tabs = new Map<number, TabView>();
let active: number | null = null;

// ── tiling / pane layout ──────────────────────────────────────────────────────
// A tabbar "tab" is a WINDOW holding a binary tree of panes; each leaf is a session
// (TabView). A single-leaf window behaves exactly like the old one-terminal-per-tab.
// Right-click a pane to split it (into a new session via a quick-launch picker); drag a
// gutter to resize. `active` stays the focused pane/session id.
type PaneNode =
  | { kind: "leaf"; tab: number }
  | { kind: "split"; dir: "row" | "col"; ratio: number; a: PaneNode; b: PaneNode };
interface Win {
  id: number;
  layout: PaneNode;
  focus: number; // the focused pane/session in this window
  root: number; // the originating ("parent") session — drives the tabbar pill name (pinned)
}
const windows = new Map<number, Win>();
const paneWin = new Map<number, number>(); // session id → window id
let activeWin: number | null = null;
let nextWinId = 1;
// When a split is requested, the new session is inserted next to `source` once it opens.
let pendingSplit: { source: number; dir: "row" | "col"; before: boolean } | null = null;

// Drag-to-tile: what a drag is currently carrying. A tabbar pill drags a whole WINDOW
// (its entire pane subtree); a pane's title bar drags that single PANE out. Dropping onto
// another pane's edge grafts it in beside the target, splitting on the dropped side.
type DragPayload = { kind: "win"; winId: number } | { kind: "pane"; tab: number; winId: number };
let dragPayload: DragPayload | null = null;
type DropZone = "left" | "right" | "top" | "bottom";

/** The nearest edge of `el` to the cursor → the side to dock onto. */
function zoneFor(el: HTMLElement, x: number, y: number): DropZone {
  const r = el.getBoundingClientRect();
  const fx = (x - r.left) / r.width;
  const fy = (y - r.top) / r.height;
  const d: Record<DropZone, number> = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  return (Object.keys(d) as DropZone[]).reduce((a, b) => (d[b] < d[a] ? b : a));
}
function showDropHint(el: HTMLElement, zone: DropZone) {
  const hint = el.querySelector<HTMLElement>(".drop-hint");
  if (hint) hint.className = `drop-hint show ${zone}`;
}
function clearAllDropHints() {
  document.querySelectorAll<HTMLElement>(".drop-hint.show").forEach((h) => h.classList.remove("show"));
}

/** Graft the current drag payload (a window or a single pane) into the target window,
 *  splitting beside `targetTab` on the dropped edge. Source is detached/emptied. */
function dropOnPane(targetTab: number, zone: DropZone) {
  const targetWinId = paneWin.get(targetTab);
  if (targetWinId == null || !dragPayload) return;
  const tgt = windows.get(targetWinId);
  if (!tgt) return;

  let movedLayout: PaneNode;
  const movedLeaves: number[] = [];
  let focusAfter: number;

  if (dragPayload.kind === "win") {
    if (dragPayload.winId === targetWinId) return; // a window dropped onto itself
    const src = windows.get(dragPayload.winId);
    if (!src) return;
    movedLayout = src.layout;
    focusAfter = src.focus;
    windows.delete(dragPayload.winId);
  } else {
    if (dragPayload.tab === targetTab) return; // a pane onto itself
    const src = windows.get(dragPayload.winId);
    if (!src) return;
    movedLayout = { kind: "leaf", tab: dragPayload.tab };
    focusAfter = dragPayload.tab;
    // Detach the pane from its source window first (so a same-window re-dock works on the
    // already-updated tree). If that empties the source window, drop it.
    const rest = removeLeaf(src.layout, dragPayload.tab);
    if (!rest) {
      windows.delete(dragPayload.winId);
    } else {
      src.layout = rest;
      if (src.focus === dragPayload.tab) src.focus = firstLeaf(rest);
      if (src.root === dragPayload.tab) src.root = firstLeaf(rest);
    }
  }
  forEachLeaf(movedLayout, (t) => movedLeaves.push(t));

  const dir: "row" | "col" = zone === "left" || zone === "right" ? "row" : "col";
  const before = zone === "left" || zone === "top";
  tgt.layout = replaceLeaf(tgt.layout, targetTab, (leaf) => ({
    kind: "split",
    dir,
    ratio: 0.5,
    a: before ? movedLayout : leaf,
    b: before ? leaf : movedLayout,
  }));
  for (const t of movedLeaves) paneWin.set(t, targetWinId);
  tgt.focus = focusAfter;
  dragPayload = null;
  clearAllDropHints();
  setActive(focusAfter); // renders the target window, refits, rebuilds the tabbar
  saveLayout();
}

// ── pointer-based tile drag (HTML5 DnD is unreliable over the xterm canvas in the webview) ──
const DRAG_THRESHOLD = 6;
let tileGhost: HTMLElement | null = null;
let lastTileDragEnd = 0; // suppress the click that follows a pill drag
const labelForPayload = (p: DragPayload): string =>
  p.kind === "win"
    ? (tabs.get(windows.get(p.winId)?.root ?? -1)?.title ?? "window")
    : (tabs.get(p.tab)?.title ?? "pane");

/** Begin a potential tile-drag from `sourceEl`. Becomes a real drag only past a small
 *  threshold (so clicks still work); shows a ghost + live left/right/top/bottom drop hint on
 *  whatever pane the cursor is over, and on release asks to confirm the nesting. */
function startTileDrag(e: PointerEvent, payload: DragPayload, sourceEl: HTMLElement) {
  if (e.button !== 0) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let drop: { tab: number; zone: DropZone } | null = null;

  const hostAt = (x: number, y: number) => {
    const host = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>(
      ".terminal-host",
    );
    return host && host.dataset.pane ? host : null;
  };
  const move = (ev: PointerEvent) => {
    if (!dragging) {
      if (Math.abs(ev.clientX - startX) < DRAG_THRESHOLD && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD)
        return;
      dragging = true;
      dragPayload = payload;
      sourceEl.classList.add("dragging");
      document.body.classList.add("tiling-drag");
      tileGhost = document.createElement("div");
      tileGhost.className = "tile-ghost";
      tileGhost.textContent = `⊞ ${labelForPayload(payload)}`;
      document.body.appendChild(tileGhost);
    }
    if (tileGhost) {
      tileGhost.style.left = `${ev.clientX + 14}px`;
      tileGhost.style.top = `${ev.clientY + 16}px`;
    }
    clearAllDropHints();
    drop = null;
    const host = hostAt(ev.clientX, ev.clientY);
    if (host) {
      const tab = Number(host.dataset.pane);
      const selfPane = payload.kind === "pane" && payload.tab === tab;
      const selfWin = payload.kind === "win" && payload.winId === paneWin.get(tab);
      if (!selfPane && !selfWin) {
        const zone = zoneFor(host, ev.clientX, ev.clientY);
        showDropHint(host, zone);
        drop = { tab, zone };
      }
    }
  };
  const up = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    sourceEl.classList.remove("dragging");
    document.body.classList.remove("tiling-drag");
    tileGhost?.remove();
    tileGhost = null;
    if (dragging) lastTileDragEnd = Date.now();
    if (dragging && drop) {
      // Only confirm when dragging a whole tab that has NESTED tiles (a multi-pane window) —
      // moving a single tile (or a single-pane tab) applies immediately.
      const win = payload.kind === "win" ? windows.get(payload.winId) : null;
      const nested = !!win && countLeaves(win.layout) > 1;
      if (nested) {
        confirmTile(drop.tab, drop.zone); // keeps the hint until the user decides
      } else {
        clearAllDropHints();
        dropOnPane(drop.tab, drop.zone);
      }
    } else {
      clearAllDropHints();
      dragPayload = null;
    }
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}

/** Ask the user to confirm a drag-and-dropped nesting before it reorganizes the layout. */
function confirmTile(targetTab: number, zone: DropZone) {
  const payload = dragPayload;
  if (!payload) return;
  const srcLabel = labelForPayload(payload);
  const tgtLabel = tabs.get(targetTab)?.title ?? "pane";
  const scrim = document.createElement("div");
  scrim.className = "pop-scrim";
  const card = document.createElement("div");
  card.className = "tile-confirm";
  const msg = document.createElement("div");
  msg.className = "tc-msg";
  msg.innerHTML = `Nest <b>${escapeHtml(srcLabel)}</b> to the <b>${zone}</b> of <b>${escapeHtml(tgtLabel)}</b>?`;
  const actions = document.createElement("div");
  actions.className = "tc-actions";
  const cancel = document.createElement("button");
  cancel.className = "tc-cancel";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.className = "primary tc-ok";
  ok.textContent = "Nest ⊞";
  actions.append(cancel, ok);
  card.append(msg, actions);
  scrim.appendChild(card);
  const close = (apply: boolean) => {
    scrim.remove();
    document.removeEventListener("keydown", onKey);
    clearAllDropHints();
    if (apply) dropOnPane(targetTab, zone);
    else dragPayload = null;
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") close(false);
    else if (ev.key === "Enter") close(true);
  };
  cancel.onclick = () => close(false);
  ok.onclick = () => close(true);
  scrim.addEventListener("click", (ev) => {
    if (ev.target === scrim) close(false);
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(scrim);
  positionPopover(card); // centered (no anchor)
  ok.focus();
}

const persistOn = () => localStorage.getItem("pear.persist") !== "0"; // default ON
function serializeTree(n: PaneNode): PaneTreeWire {
  return n.kind === "leaf"
    ? { kind: "leaf", i: n.tab }
    : { kind: "split", dir: n.dir, ratio: n.ratio, a: serializeTree(n.a), b: serializeTree(n.b) };
}
function saveLayout() {
  if (!persistOn()) return;
  // Ship the tile structure (leaves = live TabIds) so panes/splits/ratios survive a relaunch.
  // The engine remaps TabIds → entry indices and orders the saved sessions to match.
  const wins: WinLayoutWire[] = [...windows.values()].map((w) => ({
    tree: serializeTree(w.layout),
    focus: w.focus,
    root: w.root,
  }));
  send({ type: "save_layout", active, windows: wins });
}

// ── tile restore ──────────────────────────────────────────────────────────────
// On launch the engine emits `layout_restore` (the saved trees, entry-index based) then
// re-opens the sessions in entry order. We map the Nth restored `tab_opened` to entry index
// N, and once every tree leaf has landed, rebuild the windows/panes. Empty trees → flat.
let restoreState: {
  windows: WinLayoutWire[];
  active: number | null;
  total: number;
  slots: number[]; // restored TabIds, indexed by entry order
} | null = null;

function countLeavesWire(n: PaneTreeWire): number {
  return n.kind === "leaf" ? 1 : countLeavesWire(n.a) + countLeavesWire(n.b);
}
/** Rebuild a PaneNode from a saved (index-based) tree, mapping leaf index → restored TabId.
 *  A missing leaf collapses its split (mirrors removeLeaf); a fully-missing tree returns null. */
function rebuildTree(n: PaneTreeWire, slots: number[]): PaneNode | null {
  if (n.kind === "leaf") {
    const tab = slots[n.i];
    return tab == null ? null : { kind: "leaf", tab };
  }
  const a = rebuildTree(n.a, slots);
  const b = rebuildTree(n.b, slots);
  if (!a || !b) return a ?? b;
  return { kind: "split", dir: n.dir, ratio: n.ratio, a, b };
}
function assembleRestore() {
  const rs = restoreState;
  restoreState = null;
  if (!rs) return;
  for (const w of rs.windows) {
    const layout = rebuildTree(w.tree, rs.slots);
    if (!layout) continue;
    const id = nextWinId++;
    windows.set(id, {
      id,
      layout,
      focus: rs.slots[w.focus] ?? firstLeaf(layout),
      root: rs.slots[w.root] ?? firstLeaf(layout),
    });
    forEachLeaf(layout, (tab) => paneWin.set(tab, id));
  }
  // Any restored tab the trees didn't place (e.g. a safety-appended entry) gets its own window.
  for (const tab of rs.slots) if (!paneWin.has(tab)) newWindow(tab);
  const activeTab = (rs.active != null ? rs.slots[rs.active] : undefined) ?? rs.slots[0];
  if (activeTab != null) setActive(activeTab);
  renderTabBar();
}

// Feature flag: the saved-review "Insight" panel (markdown render of a stored review) is
// hard-coded off for now — the diff panel reuses #panel, so we only hide Insight's own
// controls (the toggle + ⟳ reload). Flip to revive it later.
const INSIGHT_ENABLED = false;

// Monochrome line icons for the compact toolbar (paths inside a 16×16 stroke svg).
const TOOLBAR_ICONS: Record<string, string> = {
  post: `<path d="M8 10.5V3.5M5 6.5l3-3 3 3"/><path d="M3.5 12.5h9"/>`,
  distill: `<path d="M2.5 3.5H13.5L9.3 8.4V13L6.7 14V8.4z"/>`,
  walk: `<path d="M6 4h7M6 8h7M6 12h7"/><path d="M3 4h0M3 8h0M3 12h0"/>`,
  explain: `<circle cx="8" cy="8" r="5.3"/><path d="M8 10.6V7.4"/><path d="M8 5.1h0"/>`,
  video: `<circle cx="8" cy="8" r="5.3"/><path d="M6.8 5.9v4.2l3.4-2.1z"/>`,
  copy: `<rect x="5.2" y="5.2" width="7.3" height="7.3" rx="1.2"/><path d="M3.5 10.8V4.5a1.3 1.3 0 011.3-1.3H10.8"/>`,
  comments: `<path d="M2.8 4.2a1.2 1.2 0 011.2-1.2h8a1.2 1.2 0 011.2 1.2v5a1.2 1.2 0 01-1.2 1.2H6l-2.6 2.3V10.4H4a1.2 1.2 0 01-1.2-1.2z"/>`,
  tree: `<path d="M4 3v8.5"/><path d="M4 5.4h3.4M4 9.6h3.4"/><rect x="8" y="4.1" width="4.3" height="2.6" rx="0.6"/><rect x="8" y="8.3" width="4.3" height="2.6" rx="0.6"/>`,
  diff: `<path d="M4 6.2h6.5l-2-2M12 9.8H5.5l2 2"/>`,
  approve: `<circle cx="8" cy="8" r="5.3"/><path d="M5.6 8.1l1.7 1.7 3.1-3.6"/>`,
  save: `<path d="M8 3v6.3M5.3 6.8 8 9.5l2.7-2.7"/><path d="M3.5 12.5h9"/>`,
};
function actionSvg(paths: string): string {
  return `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

// ── element handles ─────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
let tabbarEl: HTMLElement;
let terminalsEl: HTMLElement;
let historyEl: HTMLElement;
let statusEl: HTMLElement;
let prInput: HTMLInputElement;
let toolbarEl: HTMLElement;
let copyModalEl: HTMLElement;
let copyTextEl: HTMLTextAreaElement;
let copyStatusEl: HTMLElement;
let stageEl: HTMLElement;
let panelBodyEl: HTMLElement;
let panelTitleEl: HTMLElement;
let panelToggleBtn: HTMLButtonElement;
let commentsBodyEl: HTMLElement;
let commentsCountEl: HTMLElement;
let commentsNavEl: HTMLElement;
let reviewBarEl: HTMLElement;
let skillsModalEl: HTMLElement;
let skillsStatusEl: HTMLElement;
// True once dismissed/installed this session, so we don't re-nag on the next
// check_skills round-trip. Not persisted — a fresh launch asks again if missing.
let skillsPrompted = false;

// ── core IPC ────────────────────────────────────────────────────────────────
async function send(cmd: Command) {
  try {
    await invoke("pear_command", { command: cmd });
  } catch (e) {
    setStatus(`⚠ ${e}`, true);
  }
}

// ── launcher state (segmented engine + intensity chips) ──────────────────────
// Engine excludes "shell" — the "New empty shell" button covers a bare terminal.
let selectedEngine: CliKind = "claude";
// The intensity to auto-run on the next Open; null = open without a review.
let selectedTier: LaunchReview | null = "standard";

// Which intensities each engine actually supports (see dispatch.rs). Unsupported chips
// are disabled, so the displayed options change with the selected engine.
const ENGINE_TIERS: Record<string, ReadonlySet<string>> = {
  claude: new Set(["light", "standard", "complex", "ultra"]),
  codex: new Set(["light", "standard"]),
  aider: new Set(["light", "standard", "complex"]),
};

// Curated model presets per engine (the launcher also offers a free-text "custom…").
const MODEL_PRESETS: Record<string, string[]> = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["gpt-5.5", "gpt-5", "gpt-5-codex", "o3"],
  aider: [],
};
// Codex "access" preset → [--ask-for-approval, --sandbox]. "" = codex's own default (no flags).
const CODEX_ACCESS: Record<string, [string, string]> = {
  ro: ["on-request", "read-only"],
  ws: ["on-request", "workspace-write"],
  auto: ["never", "workspace-write"],
  yolo: ["never", "danger-full-access"],
};
const engineModel = (engine: CliKind) => localStorage.getItem(`pear.model.${engine}`) ?? "";
/** Push the current per-engine launch knobs to the engine (applied to future opens). */
function sendLaunchConfig() {
  const access = localStorage.getItem("pear.codexAccess") ?? "";
  const [approval, sandbox] = CODEX_ACCESS[access] ?? [null, null];
  send({
    type: "set_launch_config",
    claude_model: engineModel("claude") || null,
    codex_model: engineModel("codex") || null,
    codex_effort: localStorage.getItem("pear.codexEffort") || null,
    codex_approval: approval,
    codex_sandbox: sandbox,
  });
}

// ── rendering ───────────────────────────────────────────────────────────────
function setStatus(msg: string, warn = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("warn", warn);
}

function renderTabBar() {
  tabbarEl.innerHTML = "";
  for (const w of windows.values()) {
    const paneCount = countLeaves(w.layout);
    // The pill name is PINNED to the window's parent (root) session, not the focused pane,
    // so clicking a subshell pane doesn't rename the tab.
    const t = tabs.get(w.root) ?? tabs.get(firstLeaf(w.layout));
    if (!t) continue;
    const pill = document.createElement("div");
    pill.className = "tab" + (w.id === activeWin ? " active" : "");
    pill.title = t.subtitle || t.title;

    const dot = document.createElement("span");
    dot.className = `dot cli-${t.cli}`;
    pill.appendChild(dot);

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = t.title;
    pill.appendChild(label);

    if (paneCount > 1) {
      const badge = document.createElement("span");
      badge.className = "tab-panes";
      badge.textContent = `⊞${paneCount}`;
      badge.title = `${paneCount} panes`;
      pill.appendChild(badge);
    }

    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "×";
    close.onclick = (e) => {
      e.stopPropagation();
      // Close the whole window (every pane in it).
      forEachLeaf(w.layout, (tab) => send({ type: "close_tab", tab }));
    };
    pill.appendChild(close);

    pill.onclick = () => {
      if (Date.now() - lastTileDragEnd < 250) return; // a tile-drag just ended — swallow the click
      setActive(w.focus);
    };
    // Drag the pill (pointer-based) to tile this whole window into another pane.
    pill.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest(".tab-close")) return; // let the × button work
      startTileDrag(e, { kind: "win", winId: w.id }, pill);
    });
    tabbarEl.appendChild(pill);
  }
  if (windows.size === 0) {
    const empty = document.createElement("div");
    empty.className = "tab-empty";
    empty.textContent = "no open tabs — open a PR or a shell from the left";
    tabbarEl.appendChild(empty);
  }
  // Reopen recently-closed tabs (browser-style), right-aligned at the end of the strip.
  if (closedTabs.length) {
    const reopen = document.createElement("button");
    reopen.className = "tab-reopen";
    reopen.textContent = "↩";
    reopen.title = `Recently closed (${closedTabs.length}) — ⌘⇧T reopens the last`;
    reopen.onclick = (e) => {
      e.stopPropagation();
      const r = reopen.getBoundingClientRect();
      openClosedTabsMenu(r.right - 200, r.bottom + 4);
    };
    tabbarEl.appendChild(reopen);
  }
}

function renderToolbar() {
  const enabled = active !== null;
  toolbarEl
    .querySelectorAll<HTMLButtonElement>("button[data-needs-tab]")
    .forEach((b) => (b.disabled = !enabled));
}

/** Open a PR tab. Default = resume the PR's most recent session; `fresh` forces a
 *  new one; `session_id` resumes that exact session. */
// A review to auto-run on the next opened PR tab: a tier, or "ultra" (the paid cloud
// review, dispatched as a button rather than a tier).
type LaunchReview = ReviewTier | "ultra";
// Auto-review intent for the NEXT tab to open, set per-open so it only applies to
// a fresh Open-box launch — never to a Resume / session-restore.
let pendingAutoReview: LaunchReview | null = null;

function openPr(
  pr: PrRef,
  cli: CliKind,
  opts: { fresh?: boolean; session_id?: string; autoReview?: LaunchReview | null } = {},
) {
  pendingAutoReview = opts.autoReview ?? null;
  send({
    type: "open_pr",
    pr,
    cli,
    cwd: null,
    fresh: opts.fresh ?? false,
    session_id: opts.session_id ?? null,
  });
  closeSessionPop();
}

// ── auto-review readiness ─────────────────────────────────────────────────────
// Fire the review when the agent's boot output goes QUIET (prompt rendered, idle),
// not on a fixed delay that can type into a not-yet-ready CLI. Bounded by a min (don't
// fire absurdly early) and a max (give up waiting if output never settles).
const REVIEW_QUIET_MS = 900;
const REVIEW_MIN_MS = 1800;
const REVIEW_MAX_MS = 20000;
const pendingReviews = new Map<number, { sel: LaunchReview; openedAt: number; timer: number }>();

function fireReview(tab: number) {
  const p = pendingReviews.get(tab);
  if (!p) return;
  const elapsed = Date.now() - p.openedAt;
  if (elapsed < REVIEW_MIN_MS) {
    p.timer = window.setTimeout(() => fireReview(tab), REVIEW_MIN_MS - elapsed);
    return;
  }
  pendingReviews.delete(tab);
  const v = tabs.get(tab);
  const agent = v ? resolveAgent(v) : undefined;
  setStatus(`auto-review (${p.sel}) → ${v?.title ?? `tab ${tab}`}`);
  if (p.sel === "ultra") send({ type: "button", tab, button: "ultra", agent });
  else send({ type: "start_review", tab, tier: p.sel, agent });
}

function scheduleAutoReview(tab: number, sel: LaunchReview) {
  cancelReview(tab);
  const p = { sel, openedAt: Date.now(), timer: 0 };
  pendingReviews.set(tab, p);
  p.timer = window.setTimeout(() => fireReview(tab), REVIEW_QUIET_MS);
}

/** New output for a tab = still booting; push the quiet-timer back (force-fire at max). */
function nudgeReview(tab: number) {
  const p = pendingReviews.get(tab);
  if (!p) return;
  clearTimeout(p.timer);
  if (Date.now() - p.openedAt >= REVIEW_MAX_MS) fireReview(tab);
  else p.timer = window.setTimeout(() => fireReview(tab), REVIEW_QUIET_MS);
}

function cancelReview(tab: number) {
  const p = pendingReviews.get(tab);
  if (p) {
    clearTimeout(p.timer);
    pendingReviews.delete(tab);
  }
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return iso;
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function iconBtn(label: string, title: string, on: (e: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "hicon";
  b.textContent = label;
  b.title = title;
  b.onclick = on;
  return b;
}

// ── session-tree popover (floating breakout per PR) ──────────────────────────
let sessionPopEl: HTMLElement | null = null;
let sessionPopKey: string | null = null;

function closeSessionPop() {
  if (sessionPopEl) {
    sessionPopEl.remove();
    sessionPopEl = null;
    sessionPopKey = null;
  }
}

function toggleSessionPop(rec: PrRecord, anchor: HTMLElement) {
  const key = `${rec.pr.owner}/${shortLabel(rec.pr)}`;
  if (sessionPopKey === key) {
    closeSessionPop();
    return;
  }
  closeSessionPop();
  sessionPopKey = key;

  const pop = document.createElement("div");
  pop.className = "session-pop";
  pop.addEventListener("click", (e) => e.stopPropagation());

  const head = document.createElement("div");
  head.className = "session-pop-head";
  head.textContent = `${shortLabel(rec.pr)} · sessions`;
  pop.appendChild(head);

  if (rec.sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "session-empty";
    empty.textContent = "no Claude sessions yet";
    pop.appendChild(empty);
  } else {
    // Star the busiest session (most messages) — the one most worth resuming.
    const maxMsgs = Math.max(0, ...rec.sessions.map((s) => s.messages || 0));
    rec.sessions.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "session-row";
      const tick = document.createElement("span");
      tick.className = "session-tick";
      tick.textContent = i === 0 ? "●" : "○";
      const meta = document.createElement("div");
      meta.className = "session-meta";
      const when = document.createElement("div");
      when.className = "session-when";
      when.textContent = (i === 0 ? "latest · " : "") + relTime(s.last_opened);
      const id = document.createElement("div");
      id.className = "session-id";
      const busiest = maxMsgs > 0 && (s.messages || 0) === maxMsgs;
      id.textContent = `${s.id.slice(0, 8)} · ${s.messages || 0} msg${busiest ? " ★" : ""}`;
      if (busiest) id.classList.add("session-busiest");
      meta.append(when, id);
      row.append(tick, meta);
      row.onclick = (e) => {
        e.stopPropagation();
        openPr(rec.pr, rec.cli, { session_id: s.id });
      };
      pop.appendChild(row);
    });
  }

  const newRow = document.createElement("div");
  newRow.className = "session-row session-new";
  newRow.textContent = "+ new session";
  newRow.onclick = (e) => {
    e.stopPropagation();
    openPr(rec.pr, rec.cli, { fresh: true });
  };
  pop.appendChild(newRow);

  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const top = Math.min(r.top, window.innerHeight - pop.offsetHeight - 14);
  pop.style.top = `${Math.max(8, top)}px`;
  pop.style.left = `${r.right + 8}px`;
  sessionPopEl = pop;
}

// ── history panel: flat list ⇄ org→repo→PR tree · structured search · favorites ──
let historyEntries: PrRecord[] = [];
let favorites: Favorites = { repos: [], prs: [] };
let queue: Queue = { items: [] };
type HistView = "list" | "tree" | "queue" | "teams";
const savedView = localStorage.getItem("pear.histView");
let historyView: HistView =
  savedView === "tree" || savedView === "queue" || savedView === "teams" ? savedView : "list";
let favOnly = localStorage.getItem("pear.favOnly") === "1";
let histQuery = "";

// ── PR review/merge status (badges in the tree + teams views) ─────────────────
// Cache live status by "owner/repo#number". Each PR is fetched at most once per session
// (tracked in `statusRequested`) so re-renders don't loop.
const prStatusCache = new Map<string, PrStatus>();
const statusRequested = new Set<string>();
// Teams view state: watched users/teams + the PRs they authored.
let watches: Watches = { users: [], teams: [] };
let teamPrs: PrStatus[] = [];
const prKey = (pr: PrRef) => `${pr.owner}/${pr.repo}#${pr.number}`;
function requestStatuses(prs: PrRef[]) {
  const missing = prs.filter((p) => !statusRequested.has(prKey(p)));
  if (!missing.length) return;
  missing.forEach((p) => statusRequested.add(prKey(p)));
  send({ type: "load_pr_statuses", prs: missing });
}
/** Map a PR's status to its tree badge (label · class · tooltip). Covers the user-requested
 *  states: merged · closed · approved · changes requested · commented (+ draft/open/review). */
function prStatusBadge(s: PrStatus): { text: string; cls: string; title: string } {
  if (s.state === "merged") return { text: "merged", cls: "st-merged", title: "Merged" };
  if (s.state === "closed") return { text: "closed", cls: "st-closed", title: "Closed" };
  if (s.draft) return { text: "draft", cls: "st-draft", title: "Draft" };
  if (s.review_decision === "APPROVED")
    return { text: "approved", cls: "st-approved", title: "Approved" };
  if (s.review_decision === "CHANGES_REQUESTED")
    return { text: "changes", cls: "st-changes", title: "Changes requested" };
  if (s.comments > 0)
    return { text: `💬${s.comments}`, cls: "st-commented", title: `${s.comments} comment(s)` };
  if (s.review_decision === "REVIEW_REQUIRED")
    return { text: "review", cls: "st-review", title: "Review required" };
  return { text: "open", cls: "st-open", title: "Open" };
}
/** Append the live status badge for `pr` to a tree row, if we have it cached. */
function appendPrStatus(row: HTMLElement, pr: PrRef) {
  const s = prStatusCache.get(prKey(pr));
  if (!s) return;
  const b = prStatusBadge(s);
  const el = document.createElement("span");
  el.className = `pr-status ${b.cls}`;
  el.textContent = b.text;
  el.title = b.title;
  row.appendChild(el);
}

// ── teams view: watched users/teams → USER→REPO→PR ────────────────────────────
function watchChip(label: string, onRemove: () => void): HTMLElement {
  const c = document.createElement("span");
  c.className = "teams-chip";
  const t = document.createElement("span");
  t.textContent = label;
  const x = document.createElement("button");
  x.type = "button";
  x.className = "teams-chip-x";
  x.textContent = "×";
  x.title = "Unwatch";
  x.onclick = (e) => {
    e.stopPropagation();
    onRemove();
  };
  c.append(t, x);
  return c;
}
function teamPrNode(s: PrStatus): HTMLElement {
  const li = document.createElement("li");
  li.className = "tree-pr";
  const row = document.createElement("div");
  row.className = "tree-row tree-leaf";
  const name = document.createElement("span");
  name.className = "tree-name";
  name.textContent = `#${s.pr.number} · ${s.title}`;
  row.appendChild(name);
  appendPrStatus(row, s.pr);
  row.onclick = (e) => {
    e.stopPropagation();
    openPr(s.pr, "claude");
  };
  row.oncontextmenu = (e) => prContextMenu(e, s.pr, null);
  li.appendChild(row);
  return li;
}
function renderTeams() {
  // Watch-management bar: add a user / org-team, plus removable chips for current watches.
  const bar = document.createElement("div");
  bar.className = "teams-bar";
  const input = document.createElement("input");
  input.className = "teams-add";
  input.placeholder = "watch a github user — or org/team …";
  input.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    const v = input.value.trim().replace(/^@/, "");
    input.value = "";
    if (!v) return;
    if (v.includes("/")) {
      const [org, team] = v.split("/");
      if (org && team) send({ type: "watch_team", org, team, on: true });
    } else {
      send({ type: "watch_user", login: v, on: true });
    }
  };
  bar.appendChild(input);
  const chips = document.createElement("div");
  chips.className = "teams-chips";
  for (const u of watches.users)
    chips.appendChild(watchChip(`@${u}`, () => send({ type: "watch_user", login: u, on: false })));
  for (const t of watches.teams)
    chips.appendChild(
      watchChip(`⛣ ${t}`, () => {
        const [org, team] = t.split("/");
        send({ type: "watch_team", org, team, on: false });
      }),
    );
  bar.appendChild(chips);
  historyEl.appendChild(bar);

  if (!watches.users.length && !watches.teams.length) {
    emptyRow("add a github user (or org/team) to watch their open PRs");
    return;
  }
  // Group the watched PRs: USER → owner/repo → PRs.
  const byUser = new Map<string, Map<string, PrStatus[]>>();
  for (const s of teamPrs) {
    const u = byUser.get(s.author) ?? byUser.set(s.author, new Map()).get(s.author)!;
    const rk = `${s.pr.owner}/${s.pr.repo}`;
    (u.get(rk) ?? u.set(rk, []).get(rk)!).push(s);
  }
  if (byUser.size === 0) {
    emptyRow("no open PRs from watched users yet");
    return;
  }
  for (const user of [...byUser.keys()].sort((a, b) => a.localeCompare(b))) {
    const un = treeNode("user", `@${user}`, "");
    const repos = byUser.get(user)!;
    for (const rk of [...repos.keys()].sort((a, b) => a.localeCompare(b))) {
      const repoNode = treeNode("repo", rk, "");
      for (const s of repos.get(rk)!.sort((a, b) => b.pr.number - a.pr.number))
        repoNode.children.appendChild(teamPrNode(s));
      un.children.appendChild(repoNode.el);
    }
    historyEl.appendChild(un.el);
  }
}

/** (Re)fetch the watch list + the watched users' open PRs for the Teams view. */
function refreshTeams() {
  send({ type: "load_watches" });
  send({ type: "load_team_prs" });
}

// ── notifications (native OS + in-app bell) ───────────────────────────────────
// Poll the PRs you care about (open tabs · favorites · queue · watched teams), diff each
// against its last-seen snapshot, and surface new comments / commits / review verdicts /
// review-requested. Native notification when peaR isn't focused; always logged to the bell.
interface Notif {
  id: number;
  text: string;
  pr: PrRef;
  at: number;
  read: boolean;
}
interface StatusSnap {
  comments: number;
  commits: number;
  head_oid: string | null;
  review_decision: string | null;
  state: string;
}
const notifs: Notif[] = [];
let notifSeq = 1;
let osNotifGranted = false;
const lastSeen = new Map<string, StatusSnap>();
const notifyOn = () => localStorage.getItem("pear.notify") !== "0"; // default ON
const snapOf = (s: PrStatus): StatusSnap => ({
  comments: s.comments,
  commits: s.commits,
  head_oid: s.head_oid,
  review_decision: s.review_decision,
  state: s.state,
});

function maybeNotifyFromStatuses(statuses: PrStatus[]) {
  for (const s of statuses) {
    const k = prKey(s.pr);
    const prev = lastSeen.get(k);
    const cur = snapOf(s);
    lastSeen.set(k, cur);
    if (!prev || !notifyOn()) continue; // first sighting = baseline; muted = baseline only
    const at = `${s.pr.owner}/${s.pr.repo}#${s.pr.number}`;
    if (cur.commits > prev.commits || (!!cur.head_oid && cur.head_oid !== prev.head_oid))
      pushNotif(`🔨 New commits · ${at}`, s.pr);
    if (cur.comments > prev.comments) pushNotif(`💬 New comments · ${at}`, s.pr);
    if (cur.review_decision !== prev.review_decision) {
      if (cur.review_decision === "APPROVED") pushNotif(`✅ Approved · ${at}`, s.pr);
      else if (cur.review_decision === "CHANGES_REQUESTED")
        pushNotif(`✋ Changes requested · ${at}`, s.pr);
      else if (cur.review_decision === "REVIEW_REQUIRED")
        pushNotif(`👀 Your turn — review requested · ${at}`, s.pr);
    }
    if (cur.state !== prev.state && cur.state === "merged") pushNotif(`🟣 Merged · ${at}`, s.pr);
  }
}

function pushNotif(text: string, pr: PrRef) {
  notifs.unshift({ id: notifSeq++, text, pr, at: Date.now(), read: false });
  if (notifs.length > 50) notifs.pop();
  renderNotifBadge();
  if (osNotifGranted && !document.hasFocus()) {
    try {
      sendNotification({ title: "peaR", body: text });
    } catch {
      /* plugin unavailable */
    }
  }
}

function renderNotifBadge() {
  const unread = notifs.filter((n) => !n.read).length;
  const c = $("#notif-count");
  c.textContent = unread > 9 ? "9+" : String(unread);
  c.classList.toggle("hidden", unread === 0);
}

function renderNotifPanel() {
  const panel = $("#notif-panel");
  panel.innerHTML = "";
  const head = document.createElement("div");
  head.className = "notif-head";
  const title = document.createElement("span");
  title.textContent = "Notifications";
  const mute = document.createElement("button");
  mute.className = "notif-act";
  mute.textContent = notifyOn() ? "mute" : "unmute";
  mute.onclick = (e) => {
    e.stopPropagation();
    localStorage.setItem("pear.notify", notifyOn() ? "0" : "1");
    if (notifyOn()) pollNotifications();
    renderNotifPanel();
  };
  const clear = document.createElement("button");
  clear.className = "notif-act";
  clear.textContent = "clear";
  clear.onclick = (e) => {
    e.stopPropagation();
    notifs.length = 0;
    renderNotifBadge();
    renderNotifPanel();
  };
  head.append(title, mute, clear);
  panel.appendChild(head);

  if (!notifs.length) {
    const empty = document.createElement("div");
    empty.className = "notif-empty";
    empty.textContent = notifyOn() ? "no notifications yet" : "notifications muted";
    panel.appendChild(empty);
    return;
  }
  for (const n of notifs) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "notif-item";
    item.textContent = n.text;
    item.onclick = () => {
      openPr(n.pr, "claude");
      $("#notif-panel").classList.add("hidden");
    };
    panel.appendChild(item);
  }
}

function toggleNotifPanel() {
  const panel = $("#notif-panel");
  if (!panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    return;
  }
  renderNotifPanel();
  panel.classList.remove("hidden");
  notifs.forEach((n) => (n.read = true)); // opening marks all read
  renderNotifBadge();
}

/** The set of PRs to poll for notifications: open tabs · favorites · queue (teams polled
 *  separately via load_team_prs). */
function notifPollSet(): PrRef[] {
  const set = new Map<string, PrRef>();
  for (const v of tabs.values()) if (v.pr) set.set(prKey(v.pr), v.pr);
  for (const p of favorites.prs) set.set(prKey(p), p);
  for (const i of queue.items) set.set(prKey(i.pr), i.pr);
  return [...set.values()];
}
function pollNotifications() {
  if (!notifyOn()) return;
  const prs = notifPollSet();
  if (prs.length) send({ type: "load_pr_statuses", prs });
  if (watches.users.length || watches.teams.length) send({ type: "load_team_prs" });
}

function initNotifications() {
  // Wire the UI + polling synchronously so the bell always works, independent of whether the
  // OS-permission check resolves (it throws in a plain browser).
  $("#notif-bell").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleNotifPanel();
  });
  document.addEventListener("click", (e) => {
    const panel = $("#notif-panel");
    if (!panel.classList.contains("hidden") && !(e.target as HTMLElement)?.closest(".notif-wrap"))
      panel.classList.add("hidden");
  });
  // Baseline shortly after launch (first sighting never notifies), then poll on an interval.
  window.setTimeout(pollNotifications, 4000);
  window.setInterval(pollNotifications, 90_000);
  // Best-effort OS-notification permission (async, non-blocking).
  void (async () => {
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      osNotifGranted = granted;
    } catch {
      osNotifGranted = false;
    }
  })();
}

const samePr = (a: PrRef, b: PrRef) =>
  a.owner === b.owner && a.repo === b.repo && a.number === b.number;
const isQueued = (pr: PrRef) => queue.items.some((i) => samePr(i.pr, pr));
const queueAdd = (pr: PrRef, title: string) => send({ type: "queue_add", pr, title });

const isRepoFav = (owner: string, repo: string) => favorites.repos.includes(`${owner}/${repo}`);
const isPrFav = (pr: PrRef) =>
  favorites.prs.some((p) => p.owner === pr.owner && p.repo === pr.repo && p.number === pr.number);
const favRepo = (owner: string, repo: string, on: boolean) =>
  send({ type: "favorite_repo", owner, repo, on });
const favPr = (pr: PrRef, on: boolean) => send({ type: "favorite_pr", pr, on });
const isFavRec = (r: PrRecord) => isPrFav(r.pr) || isRepoFav(r.pr.owner, r.pr.repo);
const totalMessages = (r: PrRecord) => r.sessions.reduce((s, x) => s + (x.messages || 0), 0);
/** The session with the most messages (the ★ busiest), or null if none have any. */
const busiestSession = (r: PrRecord) =>
  r.sessions.reduce<PrRecord["sessions"][number] | null>(
    (best, s) => ((s.messages || 0) > (best?.messages || 0) ? s : best),
    null,
  );

/** Test one PR against one query string. `exact` keyword matching for committed chips
 *  (`repo:roboflow` is the roboflow repo, not roboflow-infra); `prefix` for the still-being-
 *  typed text so it NARROWS live instead of emptying the list before you finish the value. */
function matchOne(
  fields: { owner: string; repo: string; num: string; title: string; cli: string },
  raw: string,
  exact: boolean,
): boolean {
  if (!raw.trim()) return true;
  const q = parseSearchQuery(raw, {
    keywords: ["repo", "org", "pr", "cli"],
    tokenize: true,
    alwaysArray: true,
  }) as SearchParserResult;
  const cmp = (field: unknown, val: string) => {
    if (!field) return true;
    const arr = (Array.isArray(field) ? field : [field])
      .map(String)
      .filter((f) => f.trim() !== ""); // ignore an incomplete `repo:` (no value yet)
    if (!arr.length) return true;
    return arr.some((f) =>
      exact ? val.toLowerCase() === f.toLowerCase() : val.toLowerCase().startsWith(f.toLowerCase()),
    );
  };
  if (!cmp(q.org, fields.owner) || !cmp(q.repo, fields.repo) || !cmp(q.pr, fields.num) || !cmp(q.cli, fields.cli))
    return false;
  const text = Array.isArray(q.text) ? q.text : q.text ? [q.text] : [];
  if (text.length) {
    const hay = `${fields.owner}/${fields.repo}#${fields.num} ${fields.title}`.toLowerCase();
    if (!text.every((t) => hay.includes(String(t).toLowerCase()))) return false;
  }
  return true;
}

/** Structured search: committed chips (`histQuery`, exact) AND the in-progress input
 *  (`#hist-search-input`, prefix — live narrowing). Both must pass. */
function matchFields(owner: string, repo: string, num: string, title: string, cli: string): boolean {
  const f = { owner, repo, num, title, cli };
  const pending = (document.getElementById("hist-search-input") as HTMLInputElement | null)?.value ?? "";
  return matchOne(f, histQuery, true) && matchOne(f, pending, false);
}
const matchesRec = (r: PrRecord) =>
  matchFields(r.pr.owner, r.pr.repo, String(r.pr.number), r.title, r.cli);

function visibleEntries(): PrRecord[] {
  return historyEntries.filter((r) => (!favOnly || isFavRec(r)) && matchesRec(r));
}

// Parse the query into display chips (GitHub-style feedback that each filter was
// recognized). `token` is the raw text used to rebuild the query when a chip is removed.
interface HistChip {
  label: string;
  token: string;
  key: boolean;
}
function parsedFilters(raw: string): HistChip[] {
  if (!raw.trim()) return [];
  const q = parseSearchQuery(raw, {
    keywords: ["repo", "org", "pr", "cli"],
    tokenize: true,
    alwaysArray: true,
  }) as SearchParserResult;
  const out: HistChip[] = [];
  for (const key of ["org", "repo", "pr", "cli"]) {
    const v = q[key];
    if (!v) continue;
    for (const val of Array.isArray(v) ? v : [v]) {
      if (String(val).trim() === "") continue; // skip an incomplete `repo:` (no value yet)
      out.push({ label: `${key}: ${val}`, token: `${key}:${val}`, key: true });
    }
  }
  const text = Array.isArray(q.text) ? q.text : q.text ? [q.text] : [];
  for (const t of text) out.push({ label: `"${t}"`, token: String(t), key: false });
  return out;
}

function renderHistChips() {
  const chips = $("#hist-chips");
  const filters = parsedFilters(histQuery);
  chips.innerHTML = "";
  chips.classList.toggle("hidden", filters.length === 0);
  filters.forEach((f, i) => {
    const chip = document.createElement("span");
    chip.className = "hist-chip " + (f.key ? "key" : "text");
    const lbl = document.createElement("span");
    lbl.textContent = f.label;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "hist-chip-x";
    x.textContent = "×";
    x.title = "Remove filter";
    x.onclick = () => {
      histQuery = filters
        .filter((_, j) => j !== i)
        .map((g) => g.token)
        .join(" ");
      renderHistChips();
      renderHistory();
    };
    chip.append(lbl, x);
    chips.appendChild(chip);
  });
  // Hide the placeholder once there are committed chips (the box reads cleanly).
  $<HTMLInputElement>("#hist-search-input").placeholder = histQuery.trim()
    ? "filter…"
    : "search · repo:x org:y pr:123";
}

/** Commit the in-progress input as a chip (on space / Enter). */
function commitPending(): boolean {
  const inp = $<HTMLInputElement>("#hist-search-input");
  const v = inp.value.trim();
  if (!v) return false;
  histQuery = (histQuery ? `${histQuery} ${v}` : v).trim();
  inp.value = "";
  renderHistChips();
  renderHistory();
  return true;
}

/** Backspace on an empty input removes the last committed chip. */
function removeLastChip(): boolean {
  const toks = parsedFilters(histQuery);
  if (!toks.length) return false;
  histQuery = toks
    .slice(0, -1)
    .map((t) => t.token)
    .join(" ");
  renderHistChips();
  renderHistory();
  return true;
}

function renderHistory() {
  closeSessionPop();
  closeHistCtx();
  $("#view-list").classList.toggle("on", historyView === "list");
  $("#view-tree").classList.toggle("on", historyView === "tree");
  $("#view-queue").classList.toggle("on", historyView === "queue");
  $("#view-teams")?.classList.toggle("on", historyView === "teams");
  $("#fav-only").classList.toggle("on", favOnly);
  // Queue tab badge: number of items not yet done.
  const pending = queue.items.filter((i) => i.status !== "done").length;
  const qc = $("#queue-count");
  qc.textContent = pending ? String(pending) : "";
  qc.classList.toggle("hidden", pending === 0);
  // Search + favorites filters apply to history/tree only, not queue/teams.
  const noFilter = historyView === "queue" || historyView === "teams";
  $("#hist-search").classList.toggle("hidden", noFilter);
  $("#fav-only").classList.toggle("hidden", noFilter);
  historyEl.classList.toggle("tree-mode", historyView === "tree" || historyView === "teams");
  historyEl.classList.toggle("queue-mode", historyView === "queue");
  historyEl.classList.toggle("teams-mode", historyView === "teams");
  historyEl.innerHTML = "";
  if (historyView === "queue") {
    renderQueue();
    return;
  }
  if (historyView === "teams") {
    renderTeams();
    return;
  }
  const entries = visibleEntries();
  if (historyView === "tree") renderHistTree(entries);
  else renderHistList(entries);
}

function emptyRow(text: string) {
  const li = document.createElement("li");
  li.className = "history-empty";
  li.textContent = text;
  historyEl.appendChild(li);
}

function renderHistList(entries: PrRecord[]) {
  if (entries.length === 0) {
    emptyRow(historyEntries.length ? "no matches" : "no reviews yet");
    return;
  }
  // Favorited entries float to the top (stable within each group → keeps recency order).
  const ordered = [...entries].sort((a, b) => Number(isFavRec(b)) - Number(isFavRec(a)));
  for (const rec of ordered) historyEl.appendChild(historyItem(rec));
}

function favIconBtn(pr: PrRef): HTMLButtonElement {
  const on = isPrFav(pr);
  const b = iconBtn(on ? "★" : "☆", on ? "Unfavorite PR" : "Favorite PR", (e) => {
    e.stopPropagation();
    favPr(pr, !on);
  });
  b.classList.add("hicon-fav");
  if (on) b.classList.add("on");
  return b;
}

function historyItem(rec: PrRecord): HTMLElement {
  const li = document.createElement("li");
  li.className = "history-item";
  li.title = `${rec.pr.owner}/${shortLabel(rec.pr)} — ${rec.title}`;

  const main = document.createElement("div");
  main.className = "history-main";
  const ref = document.createElement("span");
  ref.className = "history-ref";
  if (isFavRec(rec)) {
    const star = document.createElement("span");
    star.className = "history-fav-mark";
    star.textContent = "★";
    ref.appendChild(star);
  }
  ref.appendChild(document.createTextNode(shortLabel(rec.pr)));
  if (rec.sessions.length > 0) {
    const msgs = totalMessages(rec);
    const badge = document.createElement("span");
    badge.className = "history-badge";
    badge.textContent = msgs > 0 ? `${rec.sessions.length}·${msgs}✦` : String(rec.sessions.length);
    badge.title = `${rec.sessions.length} session(s), ${msgs} messages — click to expand`;
    ref.appendChild(badge);
  }
  main.appendChild(ref);
  const title = document.createElement("span");
  title.className = "history-title";
  title.textContent = rec.title;
  main.appendChild(title);
  main.onclick = (e) => {
    e.stopPropagation();
    toggleSessionPop(rec, li);
  };
  li.appendChild(main);
  li.oncontextmenu = (e) => prContextMenu(e, rec.pr, rec);

  const actions = document.createElement("div");
  actions.className = "history-actions";
  actions.appendChild(favIconBtn(rec.pr));
  actions.appendChild(
    iconBtn("⟲", "Resume latest session", (e) => {
      e.stopPropagation();
      openPr(rec.pr, rec.cli);
    }),
  );
  actions.appendChild(
    iconBtn("+", "New session for this PR", (e) => {
      e.stopPropagation();
      openPr(rec.pr, rec.cli, { fresh: true });
    }),
  );
  const del = iconBtn("×", "Delete this history entry", (e) => {
    e.stopPropagation();
    send({ type: "delete_history", pr: rec.pr });
  });
  del.classList.add("hicon-danger");
  actions.appendChild(del);
  li.appendChild(actions);
  return li;
}

// ── review queue ──────────────────────────────────────────────────────────────
// A curated to-review list (persisted in pear-core). Items carry a workflow status
// (queued → active → done) and a priority order (top = next up). Right-click a history/
// tree PR to enqueue it; right-click a queue item for the full status/reorder flow.
const QUEUE_STATUS: Record<string, { icon: string; label: string; cls: string }> = {
  queued: { icon: "📋", label: "queued", cls: "q-queued" },
  active: { icon: "👀", label: "in progress", cls: "q-active" },
  done: { icon: "✓", label: "done", cls: "q-done" },
};

function renderQueue() {
  if (queue.items.length === 0) {
    emptyRow("queue is empty — right-click a PR → “Add to queue”");
    return;
  }
  for (const item of queue.items) historyEl.appendChild(queueItemEl(item));
}

function cycleQueueStatus(item: QueueItem) {
  const next = item.status === "queued" ? "active" : item.status === "active" ? "done" : "queued";
  send({ type: "queue_set_status", pr: item.pr, status: next });
}

function queueItemEl(item: QueueItem): HTMLElement {
  const st = QUEUE_STATUS[item.status] ?? QUEUE_STATUS.queued;
  const li = document.createElement("li");
  li.className = `queue-item ${st.cls}`;
  li.title = `${item.pr.owner}/${shortLabel(item.pr)} — ${st.label}`;

  const dot = document.createElement("button");
  dot.type = "button";
  dot.className = "queue-status";
  dot.textContent = st.icon;
  dot.title = `${st.label} — click to advance`;
  dot.onclick = (e) => {
    e.stopPropagation();
    cycleQueueStatus(item);
  };

  const main = document.createElement("div");
  main.className = "queue-main";
  const ref = document.createElement("span");
  ref.className = "queue-ref";
  ref.textContent = shortLabel(item.pr);
  const title = document.createElement("span");
  title.className = "queue-title";
  title.textContent = item.title || `${item.pr.owner}/${item.pr.repo}`;
  main.append(ref, title);
  main.onclick = (e) => {
    e.stopPropagation();
    openPr(item.pr, "claude");
  };

  const actions = document.createElement("div");
  actions.className = "history-actions";
  actions.appendChild(iconBtn("↑", "Move up", (e) => { e.stopPropagation(); send({ type: "queue_move", pr: item.pr, dir: -1 }); }));
  actions.appendChild(iconBtn("↓", "Move down", (e) => { e.stopPropagation(); send({ type: "queue_move", pr: item.pr, dir: 1 }); }));
  actions.appendChild(iconBtn("⟲", "Open / resume", (e) => { e.stopPropagation(); openPr(item.pr, "claude"); }));
  const rm = iconBtn("×", "Remove from queue", (e) => { e.stopPropagation(); send({ type: "queue_remove", pr: item.pr }); });
  rm.classList.add("hicon-danger");
  actions.appendChild(rm);

  li.append(dot, main, actions);
  li.oncontextmenu = (e) => queueContextMenu(e, item);
  return li;
}

function queueContextMenu(e: MouseEvent, item: QueueItem) {
  e.preventDefault();
  e.stopPropagation();
  const fav = isPrFav(item.pr);
  const set = (status: string): CtxItem["on"] => () => send({ type: "queue_set_status", pr: item.pr, status });
  openHistCtx(e.clientX, e.clientY, [
    { label: "👀 Mark in progress", on: set("active") },
    { label: "✓ Mark done", on: set("done") },
    { label: "📋 Mark queued", on: set("queued") },
    { label: "↑ Move up", on: () => send({ type: "queue_move", pr: item.pr, dir: -1 }) },
    { label: "↓ Move down", on: () => send({ type: "queue_move", pr: item.pr, dir: 1 }) },
    { label: "⟲ Open / resume", on: () => openPr(item.pr, "claude") },
    { label: fav ? "★ Unfavorite" : "☆ Favorite", on: () => favPr(item.pr, !fav) },
    { label: "× Remove from queue", danger: true, on: () => send({ type: "queue_remove", pr: item.pr }) },
  ]);
}

// ── org → repo → PR tree ──────────────────────────────────────────────────────
type PrCell = { pr: PrRef; rec: PrRecord | null };

function renderHistTree(entries: PrRecord[]) {
  const orgs = new Map<string, Map<string, Map<number, PrCell>>>();
  const repoOf = (owner: string, repo: string) => {
    const o = orgs.get(owner) ?? orgs.set(owner, new Map()).get(owner)!;
    return o.get(repo) ?? o.set(repo, new Map()).get(repo)!;
  };
  for (const r of entries) repoOf(r.pr.owner, r.pr.repo).set(r.pr.number, { pr: r.pr, rec: r });
  // Merge favorited repos / PRs so added-but-empty favorites still appear (search-filtered).
  for (const key of favorites.repos) {
    const [owner, repo] = key.split("/");
    if (owner && repo && matchFields(owner, repo, "", "", "")) repoOf(owner, repo);
  }
  for (const pr of favorites.prs) {
    if (!matchFields(pr.owner, pr.repo, String(pr.number), "", "")) continue;
    const m = repoOf(pr.owner, pr.repo);
    if (!m.has(pr.number)) m.set(pr.number, { pr, rec: null });
  }

  if (orgs.size === 0) {
    emptyRow(historyEntries.length || favorites.repos.length || favorites.prs.length ? "no matches" : "no reviews yet");
    return;
  }

  for (const owner of [...orgs.keys()].sort((a, b) => a.localeCompare(b))) {
    const org = treeNode("org", owner, "");
    const repos = orgs.get(owner)!;
    for (const repo of [...repos.keys()].sort((a, b) => a.localeCompare(b))) {
      const fav = isRepoFav(owner, repo);
      const repoNode = treeNode("repo", repo, fav ? "★" : "");
      repoNode.rowBtn.oncontextmenu = (e) => repoContextMenu(e, owner, repo);
      const cells = repos.get(repo)!;
      const nums = [...cells.keys()].sort((a, b) => b - a);
      for (const num of nums) repoNode.children.appendChild(treePrNode(cells.get(num)!));
      if (nums.length === 0) {
        const none = document.createElement("div");
        none.className = "tree-none";
        none.textContent = "no PRs yet";
        repoNode.children.appendChild(none);
      }
      org.children.appendChild(repoNode.el);
    }
    historyEl.appendChild(org.el);
  }
  // Fetch live review/merge status for every PR shown (batched, once per session).
  requestStatuses(entries.map((r) => r.pr));
}

function treeNode(
  kind: "org" | "repo" | "user",
  label: string,
  mark: string,
): { el: HTMLElement; rowBtn: HTMLElement; children: HTMLElement } {
  const el = document.createElement("li");
  el.className = `tree-node tn-${kind}`;
  const rowBtn = document.createElement("button");
  rowBtn.type = "button";
  rowBtn.className = "tree-row";
  const chev = document.createElement("span");
  chev.className = "tree-chev";
  chev.textContent = "▾";
  const name = document.createElement("span");
  name.className = "tree-name";
  name.textContent = label;
  rowBtn.append(chev, name);
  if (mark) {
    const m = document.createElement("span");
    m.className = "tree-mark on";
    m.textContent = mark;
    rowBtn.appendChild(m);
  }
  const children = document.createElement("ul");
  children.className = "tree-children";
  rowBtn.addEventListener("click", () => {
    const c = children.classList.toggle("collapsed");
    rowBtn.classList.toggle("collapsed", c);
  });
  el.append(rowBtn, children);
  return { el, rowBtn, children };
}

function treePrNode({ pr, rec }: PrCell): HTMLElement {
  const li = document.createElement("li");
  li.className = "tree-pr";
  const row = document.createElement("div");
  row.className = "tree-row tree-leaf";
  const fav = isPrFav(pr);
  const mark = document.createElement("span");
  mark.className = "tree-mark" + (fav ? " on" : "");
  mark.textContent = fav ? "★" : "•";
  const name = document.createElement("span");
  name.className = "tree-name";
  name.textContent = `#${pr.number}${rec ? ` · ${rec.title}` : ""}`;
  row.append(mark, name);
  if (rec && rec.sessions.length > 0) {
    const msgs = totalMessages(rec);
    const badge = document.createElement("span");
    badge.className = "tree-badge";
    badge.textContent = `${rec.sessions.length}·${msgs}✦`;
    badge.title = `${rec.sessions.length} session(s), ${msgs} messages`;
    row.appendChild(badge);
  }
  appendPrStatus(row, pr); // live review/merge status badge
  row.onclick = (e) => {
    e.stopPropagation();
    if (rec) toggleSessionPop(rec, li);
    else openPr(pr, "claude");
  };
  row.oncontextmenu = (e) => prContextMenu(e, pr, rec);
  li.appendChild(row);
  return li;
}

// ── right-click context menu + add-favorite prompt ────────────────────────────
interface CtxItem {
  label: string;
  danger?: boolean;
  on: () => void;
}
function openHistCtx(x: number, y: number, items: CtxItem[]) {
  const ctx = $("#hist-ctx");
  ctx.innerHTML = "";
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "hist-ctx-item" + (it.danger ? " danger" : "");
    b.textContent = it.label;
    // stopPropagation so this click doesn't reach the document close-handler — important for
    // two-step menus (split → quick-launch) that rebuild #hist-ctx in place: the handler would
    // otherwise see the now-detached button as "outside" and close the freshly-opened menu.
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      closeHistCtx();
      it.on();
    });
    ctx.appendChild(b);
  }
  ctx.classList.remove("hidden");
  ctx.style.left = `${Math.min(x, window.innerWidth - 190)}px`;
  ctx.style.top = `${Math.min(y, window.innerHeight - ctx.offsetHeight - 8)}px`;
}
function closeHistCtx() {
  $("#hist-ctx").classList.add("hidden");
}
function repoContextMenu(e: MouseEvent, owner: string, repo: string) {
  e.preventDefault();
  e.stopPropagation();
  const fav = isRepoFav(owner, repo);
  openHistCtx(e.clientX, e.clientY, [
    { label: fav ? "★ Unfavorite repo" : "☆ Favorite repo", on: () => favRepo(owner, repo, !fav) },
  ]);
}
function prContextMenu(e: MouseEvent, pr: PrRef, rec: PrRecord | null) {
  e.preventDefault();
  e.stopPropagation();
  const fav = isPrFav(pr);
  const cli = rec?.cli ?? "claude";
  const queued = isQueued(pr);
  const items: CtxItem[] = [
    { label: fav ? "★ Unfavorite PR" : "☆ Favorite PR", on: () => favPr(pr, !fav) },
    queued
      ? { label: "📋 Remove from queue", on: () => send({ type: "queue_remove", pr }) }
      : { label: "📋 Add to queue", on: () => queueAdd(pr, rec?.title ?? "") },
    { label: "⟲ Resume latest", on: () => openPr(pr, cli) },
  ];
  // Resume the busiest session (most messages) — only worth a separate item when it's
  // not already the latest one.
  const busiest = rec ? busiestSession(rec) : null;
  if (busiest && rec && rec.sessions[0]?.id !== busiest.id) {
    items.push({
      label: `★ Resume most active (${busiest.messages} msg)`,
      on: () => openPr(pr, cli, { session_id: busiest.id }),
    });
  }
  items.push({ label: "+ New session", on: () => openPr(pr, cli, { fresh: true }) });
  if (rec) items.push({ label: "× Delete history", danger: true, on: () => send({ type: "delete_history", pr }) });
  openHistCtx(e.clientX, e.clientY, items);
}

/** The "+" add button: a small popover to favorite a repo (`owner/repo`) or PR (`owner/repo#123`). */
function promptHistAdd() {
  const ctx = $("#hist-ctx");
  ctx.innerHTML = "";
  const form = document.createElement("form");
  form.className = "hist-add-form";
  const inp = document.createElement("input");
  inp.className = "hist-add-input";
  inp.placeholder = "owner/repo  or  owner/repo#123";
  inp.autocomplete = "off";
  const ok = document.createElement("button");
  ok.type = "submit";
  ok.className = "hist-add-ok";
  ok.textContent = "Add";
  form.append(inp, ok);
  form.onsubmit = (e) => {
    e.preventDefault();
    addFavRef(inp.value.trim());
    closeHistCtx();
  };
  ctx.appendChild(form);
  ctx.classList.remove("hidden");
  const r = $("#hist-add").getBoundingClientRect();
  ctx.style.left = `${Math.max(8, r.right - 210)}px`;
  ctx.style.top = `${r.bottom + 4}px`;
  inp.focus();
}
function addFavRef(v: string) {
  if (!v) return;
  const pr = parsePrRef(v);
  if (pr) {
    favPr(pr, true);
    setStatus(`favorited ${shortLabel(pr)}`);
    return;
  }
  const m = v.match(/^([^/\s]+)\/([^/\s#]+)$/);
  if (m) {
    favRepo(m[1], m[2], true);
    setStatus(`favorited ${m[1]}/${m[2]}`);
    return;
  }
  setStatus("couldn't parse — use owner/repo or owner/repo#123");
}

// ── terminal lifecycle ──────────────────────────────────────────────────────
function createTabView(id: number, title: string, cli: CliKind, pr: PrRef | null): TabView {
  const el = document.createElement("div");
  el.className = "terminal-host hidden";
  // A very thin secondary-color title bar naming this pane (shown only when tiled, so a
  // solo terminal stays clean). It overlays the host's top padding — see .pane-title CSS.
  const titleBar = document.createElement("div");
  titleBar.className = "pane-title";
  // Drag the title bar (pointer-based) to pull this single pane out into another pane/window.
  titleBar.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    const winId = paneWin.get(id);
    if (winId != null) startTileDrag(e, { kind: "pane", tab: id, winId }, el);
  });
  el.appendChild(titleBar);
  // A translucent edge highlight shown while a drag hovers this pane (the drop target).
  const dropHint = document.createElement("div");
  dropHint.className = "drop-hint";
  el.appendChild(dropHint);
  // Focus this pane on click; right-click to split / close it. (Drop targeting is handled by
  // the global pointer-drag in startTileDrag via elementFromPoint + this host's data-pane.)
  el.addEventListener("mousedown", () => focusPane(id), true);
  el.addEventListener("contextmenu", (e) => paneContextMenu(e, id));
  terminalsEl.appendChild(el);

  const term = new Terminal({
    theme: XTERM_THEMES[currentTheme()],
    fontFamily: TERM_FONT[currentTheme()],
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(el);
  queueMicrotask(() => fit.fit());

  term.onData((data) =>
    send({ type: "input", tab: id, bytes: Array.from(new TextEncoder().encode(data)) }),
  );
  term.onResize(({ cols, rows }) => send({ type: "resize", tab: id, cols, rows }));

  const view: TabView = {
    id,
    title,
    subtitle: title,
    cli,
    pr,
    meta: null,
    term,
    fit,
    el,
  };
  tabs.set(id, view);
  return view;
}

function setActive(id: number) {
  active = id;
  // Render the window this pane belongs to (its full split tree); other windows hide.
  const winId = paneWin.get(id);
  if (winId != null) {
    activeWin = winId;
    const w = windows.get(winId);
    if (w) w.focus = id;
    renderWindow(winId);
  }
  const v = tabs.get(id);
  if (v) {
    requestAnimationFrame(() => {
      v.fit.fit();
      v.term.focus();
    });
  }
  renderTabBar();
  renderToolbar();
  // The diff panel follows the active tab: if it's open, re-point it at this tab
  // (instant from cache, fetch if a PR, or a placeholder for a non-PR tab).
  if (stageEl.classList.contains("panel-open") && panelBodyEl.classList.contains("diff-mode")) {
    syncDiffToActive();
  }
  renderTreeRail(); // follow the active tab (re-render for a diff, or hide for a non-diff)
  // The conversation panel + pending-review bar follow the active tab.
  if (stageEl.classList.contains("comments-open")) syncCommentsToActive();
  setPendingReview(commentsCache.get(id)?.pending_review_id ?? null);
  updateReviewBar(id);
  // The brain drawer also follows the active tab.
  if (brainOpen() && brainTab !== id) watchBrainFor(id);
}

function closeTabView(id: number) {
  const v = tabs.get(id);
  if (v) {
    recordClosedTab(v); // remember it so it can be reopened
    v.term.dispose();
    v.el.remove();
    tabs.delete(id);
  }
  // Remove the pane from its window's layout (collapsing the split). If the window is now
  // empty, drop it; otherwise focus a surviving pane in it.
  const winId = paneWin.get(id);
  paneWin.delete(id);
  let nextFocus: number | null = null;
  if (winId != null) {
    const w = windows.get(winId);
    if (w) {
      const layout = removeLeaf(w.layout, id);
      if (!layout) {
        windows.delete(winId);
      } else {
        w.layout = layout;
        if (w.focus === id) w.focus = firstLeaf(layout);
        // If the parent pane closed, re-pin the pill name to a surviving pane.
        if (w.root === id) w.root = firstLeaf(layout);
        nextFocus = w.focus;
      }
    }
  }
  if (active === id) {
    active = null;
    // Prefer another pane in the same window, else any other window's focus.
    if (nextFocus != null) setActive(nextFocus);
    else {
      const otherWin = windows.values().next();
      if (!otherWin.done) setActive(otherWin.value.focus);
      else {
        activeWin = null;
        terminalsEl.replaceChildren();
      }
    }
  } else if (winId === activeWin) {
    renderWindow(winId); // a non-focused pane in the active window closed → re-tile
  }
  renderTabBar();
  renderToolbar();
  saveLayout(); // a pane/window closed — re-capture the tile structure
}

// ── recently closed tabs (reopen via the ↩ tab-bar button or ⌘⇧T) ──────────────
interface ClosedTab {
  pr: PrRef | null;
  cli: CliKind;
  title: string;
}
const closedTabs: ClosedTab[] = [];
const MAX_CLOSED = 25;
function closedKey(c: ClosedTab): string {
  return c.pr ? `${c.pr.owner}/${c.pr.repo}#${c.pr.number}` : `shell:${c.title}`;
}
function recordClosedTab(v: TabView) {
  const entry: ClosedTab = { pr: v.pr, cli: v.cli, title: v.title };
  const key = closedKey(entry);
  const i = closedTabs.findIndex((c) => closedKey(c) === key);
  if (i >= 0) closedTabs.splice(i, 1); // de-dupe, bump to front
  closedTabs.unshift(entry);
  if (closedTabs.length > MAX_CLOSED) closedTabs.pop();
}
function reopenClosed(c: ClosedTab) {
  const i = closedTabs.indexOf(c);
  if (i >= 0) closedTabs.splice(i, 1);
  if (c.pr) openPr(c.pr, c.cli);
  else send({ type: "open_scratch", cli: c.cli, cwd: null });
  renderTabBar();
}
function reopenLastClosed() {
  if (closedTabs.length) reopenClosed(closedTabs[0]);
}
function openClosedTabsMenu(x: number, y: number) {
  const items: CtxItem[] = closedTabs.length
    ? closedTabs.map((c) => ({
        label: `${c.pr ? `⎇ ${c.title}` : `› ${c.title}`}  ·  ${c.cli}`,
        on: () => reopenClosed(c),
      }))
    : [{ label: "no recently closed tabs", on: () => {} }];
  openHistCtx(x, y, items);
}

// ── pane tree: build / mutate / render ────────────────────────────────────────
function newWindow(tab: number): number {
  const id = nextWinId++;
  windows.set(id, { id, layout: { kind: "leaf", tab }, focus: tab, root: tab });
  paneWin.set(tab, id);
  return id;
}

function forEachLeaf(node: PaneNode, fn: (tab: number) => void) {
  if (node.kind === "leaf") fn(node.tab);
  else {
    forEachLeaf(node.a, fn);
    forEachLeaf(node.b, fn);
  }
}
function firstLeaf(node: PaneNode): number {
  return node.kind === "leaf" ? node.tab : firstLeaf(node.a);
}
function countLeaves(node: PaneNode): number {
  return node.kind === "leaf" ? 1 : countLeaves(node.a) + countLeaves(node.b);
}
function replaceLeaf(node: PaneNode, tab: number, fn: (leaf: PaneNode) => PaneNode): PaneNode {
  if (node.kind === "leaf") return node.tab === tab ? fn(node) : node;
  return { ...node, a: replaceLeaf(node.a, tab, fn), b: replaceLeaf(node.b, tab, fn) };
}
function removeLeaf(node: PaneNode, tab: number): PaneNode | null {
  if (node.kind === "leaf") return node.tab === tab ? null : node;
  const a = removeLeaf(node.a, tab);
  const b = removeLeaf(node.b, tab);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

/** Insert `newTab` next to `source` in its window, splitting along `dir`. */
function insertPane(win: Win, source: number, newTab: number, dir: "row" | "col", before: boolean) {
  win.layout = replaceLeaf(win.layout, source, (leaf) => {
    const sib: PaneNode = { kind: "leaf", tab: newTab };
    return { kind: "split", dir, ratio: 0.5, a: before ? sib : leaf, b: before ? leaf : sib };
  });
  paneWin.set(newTab, win.id);
}

/** Re-render the active window's pane tree into #terminals (hosts are moved, not recreated). */
function renderWindow(winId: number) {
  const w = windows.get(winId);
  if (!w) {
    terminalsEl.replaceChildren();
    return;
  }
  for (const t of tabs.values()) t.el.classList.add("hidden");
  terminalsEl.replaceChildren(buildPaneDom(w.layout, w));
  forEachLeaf(w.layout, (tab) => tabs.get(tab)?.el.classList.remove("hidden"));
  requestAnimationFrame(() => refitWindow(winId));
}

function buildPaneDom(node: PaneNode, w: Win): HTMLElement {
  if (node.kind === "leaf") {
    const v = tabs.get(node.tab);
    if (!v) return document.createElement("div");
    const multi = hasSibling(w.layout);
    v.el.classList.toggle("pane-focus", node.tab === w.focus && multi);
    v.el.classList.toggle("show-title", multi);
    v.el.style.flex = "1 1 0";
    v.el.dataset.pane = String(node.tab);
    // Thin title bar: only shown when tiled. Marks the parent (root) pane.
    const title = v.el.querySelector<HTMLElement>(".pane-title");
    if (title) {
      title.textContent = v.title + (node.tab === w.root ? "  ·  parent" : "");
      title.classList.toggle("is-root", node.tab === w.root);
    }
    return v.el;
  }
  const split = document.createElement("div");
  split.className = `pane-split ${node.dir}`;
  const a = buildPaneDom(node.a, w);
  const b = buildPaneDom(node.b, w);
  a.style.flex = `${node.ratio} 1 0`;
  b.style.flex = `${1 - node.ratio} 1 0`;
  split.append(a, makeGutter(node), b);
  return split;
}

/** Whether the layout has more than one pane (drives the focus ring — hidden when solo). */
function hasSibling(node: PaneNode): boolean {
  return node.kind === "split";
}

/** Fit every terminal whose host lives within `root` (used for live resize during a drag). */
function fitLeavesIn(root: HTMLElement) {
  const hosts = root.classList.contains("terminal-host")
    ? [root]
    : Array.from(root.querySelectorAll<HTMLElement>(".terminal-host"));
  for (const host of hosts) {
    const id = Number(host.dataset.pane);
    const v = tabs.get(id);
    if (v) {
      try {
        v.fit.fit();
      } catch {
        /* mid-layout */
      }
    }
  }
}

function makeGutter(node: Extract<PaneNode, { kind: "split" }>): HTMLElement {
  const g = document.createElement("div");
  g.className = `pane-gutter ${node.dir}`;
  g.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const split = g.parentElement;
    if (!split) return;
    const rect = split.getBoundingClientRect();
    const horiz = node.dir === "row";
    const a = split.children[0] as HTMLElement;
    const b = split.children[2] as HTMLElement;
    // Re-fit the panes live as the divider moves so terminal contents reflow during the
    // drag (not just on release). Coalesce to one fit per animation frame to stay smooth.
    let raf = 0;
    const fitSoon = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        fitLeavesIn(a);
        fitLeavesIn(b);
      });
    };
    const move = (ev: PointerEvent) => {
      const pos = horiz
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
      node.ratio = Math.min(0.85, Math.max(0.15, pos));
      a.style.flex = `${node.ratio} 1 0`;
      b.style.flex = `${1 - node.ratio} 1 0`;
      fitSoon();
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      if (raf) cancelAnimationFrame(raf);
      if (activeWin != null) refitWindow(activeWin); // final exact fit
      saveLayout(); // persist the new split ratio
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  });
  return g;
}

function refitWindow(winId: number) {
  const w = windows.get(winId);
  if (!w) return;
  forEachLeaf(w.layout, (tab) => {
    const v = tabs.get(tab);
    if (v) {
      try {
        v.fit.fit();
      } catch {
        /* host not yet laid out */
      }
    }
  });
}

/** Focus a pane (lightweight — just the ring + xterm focus, no full window rebuild). */
function focusPane(tab: number) {
  if (active === tab) return;
  setActive(tab);
}

// ── pane context menu + quick-launch picker ───────────────────────────────────
const PANE_LAUNCH: { label: string; cli: CliKind }[] = [
  { label: "＋ New shell", cli: "shell" },
  { label: "✦ Claude", cli: "claude" },
  { label: "◆ Codex", cli: "codex" },
  { label: "⬡ Aider", cli: "aider" },
];

function paneContextMenu(e: MouseEvent, tab: number) {
  e.preventDefault();
  e.stopPropagation();
  const x = e.clientX;
  const y = e.clientY;
  const split = (dir: "row" | "col", before: boolean) => () =>
    openQuickLaunch(x, y, (cli) => {
      pendingSplit = { source: tab, dir, before };
      send({ type: "open_scratch", cli, cwd: null });
    });
  const items: CtxItem[] = [
    { label: "⊟ Split right", on: split("row", false) },
    { label: "⊟ Split left", on: split("row", true) },
    { label: "⊟ Split down", on: split("col", false) },
    { label: "⊟ Split up", on: split("col", true) },
  ];
  // Only offer "Close pane" when this is one of several panes (a solo window closes via the tab).
  const winId = paneWin.get(tab);
  const w = winId != null ? windows.get(winId) : null;
  if (w && hasSibling(w.layout)) {
    items.push({ label: "× Close pane", danger: true, on: () => send({ type: "close_tab", tab }) });
  }
  openHistCtx(x, y, items);
}

/** A small picker of what to launch into a new split (reuses the floating ctx menu). */
function openQuickLaunch(x: number, y: number, onPick: (cli: CliKind) => void) {
  openHistCtx(
    x,
    y,
    PANE_LAUNCH.map((l) => ({ label: l.label, on: () => onPick(l.cli) })),
  );
}

/** Selection if any, else the full scrollback — used as the saved review artifact. */
function terminalText(term: Terminal): string {
  if (term.hasSelection()) return term.getSelection();
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n").replace(/\s+$/g, "") + "\n";
}

// ── event handling ──────────────────────────────────────────────────────────
function handle(ev: CoreEvent) {
  switch (ev.type) {
    case "layout_restore": {
      const total = ev.windows.reduce((n, w) => n + countLeavesWire(w.tree), 0);
      restoreState = total > 0 ? { windows: ev.windows, active: ev.active, total, slots: [] } : null;
      break;
    }
    case "tab_opened": {
      createTabView(ev.tab, ev.title, ev.cli, ev.pr);
      // Restore in progress: collect this session into its entry slot; rebuild the tile tree
      // once every saved leaf has landed (no per-tab window/setActive churn).
      if (restoreState) {
        restoreState.slots.push(ev.tab);
        if (restoreState.slots.length >= restoreState.total) assembleRestore();
        break;
      }
      // A pending split inserts this session as a pane beside its source; otherwise it's
      // a new top-level window (tabbar pill).
      const ps = pendingSplit;
      const srcWin = ps ? windows.get(paneWin.get(ps.source) ?? -1) : null;
      if (ps && srcWin) {
        pendingSplit = null;
        insertPane(srcWin, ps.source, ev.tab, ps.dir, ps.before);
      } else {
        pendingSplit = null;
        newWindow(ev.tab);
      }
      setActive(ev.tab);
      saveLayout(); // capture the new tile structure (split / new window)
      setStatus(`opened ${ev.title}`);
      // Auto-review on open (PR tabs only, never a plain shell). We don't fire on a
      // fixed delay (that can race ahead of a not-yet-ready CLI) — instead we wait for
      // the agent's boot output to go quiet (prompt rendered, idle). See scheduleAutoReview.
      if (ev.pr && pendingAutoReview && ev.cli !== "shell") {
        setStatus(`auto-review (${pendingAutoReview}) — waiting for ${ev.title} to be ready…`);
        scheduleAutoReview(ev.tab, pendingAutoReview);
      }
      pendingAutoReview = null; // consume — resumes/new opens never carry it
      break;
    }
    case "pr_meta": {
      const v = tabs.get(ev.tab);
      if (v) {
        v.meta = ev.meta;
        const m = ev.meta;
        v.subtitle = `${m.title} — @${m.author} · ${m.state}${m.draft ? " (draft)" : ""} · +${m.additions}/-${m.deletions} · ${m.changed_files} files`;
        renderTabBar();
        setStatus(v.subtitle);
      }
      break;
    }
    case "output": {
      tabs.get(ev.tab)?.term.write(new Uint8Array(ev.bytes));
      nudgeReview(ev.tab); // booting output resets the "ready when quiet" timer
      break;
    }
    case "tab_closed": {
      cancelReview(ev.tab);
      closeTabView(ev.tab);
      setStatus(`tab ${ev.tab} closed${ev.code != null ? ` (exit ${ev.code})` : ""}`);
      break;
    }
    case "review_saved": {
      setStatus(`saved review → ${ev.path}`);
      break;
    }
    case "panel": {
      renderPanel(ev.payload);
      break;
    }
    case "diff": {
      const prev = diffCache.get(ev.tab);
      diffCache.set(ev.tab, { diff: ev.diff, comments: ev.comments });
      // Only (re)render if this tab is showing and the content actually changed — keeps
      // scroll position + collapse state on a background refresh.
      const changed =
        !prev || prev.diff !== ev.diff || prev.comments.length !== ev.comments.length;
      if (ev.tab === active && changed) showDiff(ev.tab, ev.diff, ev.comments);
      break;
    }
    case "comments": {
      commentsCache.set(ev.tab, ev.comments);
      if (ev.tab !== active) break;
      setPendingReview(ev.comments.pending_review_id);
      updateReviewBar(ev.tab);
      // Refresh the conversation panel if it's showing this tab.
      if (stageEl.classList.contains("comments-open")) renderConversation(ev.tab);
      // Upgrade the diff's inline threads now that we have them.
      const cached = diffCache.get(ev.tab);
      if (cached && stageEl.classList.contains("panel-open") && panelBodyEl.classList.contains("diff-mode")) {
        showDiff(ev.tab, cached.diff, cached.comments);
      }
      break;
    }
    case "thought": {
      if (ev.tab === brainTab) appendThought(ev.kind, ev.text, ev.detail);
      break;
    }
    case "insight": {
      updateInsight(ev.id, ev.kind, ev.text);
      break;
    }
    case "repo_tree": {
      repoTreeCache.set(ev.tab, ev.files);
      if (ev.tab === active && treeOpen && treeLevel !== "diff") renderTreeRail();
      break;
    }
    case "history": {
      historyEntries = ev.entries;
      favorites = ev.favorites ?? { repos: [], prs: [] };
      queue = ev.queue ?? { items: [] };
      renderHistory();
      break;
    }
    case "pr_statuses": {
      for (const s of ev.statuses) prStatusCache.set(prKey(s.pr), s);
      maybeNotifyFromStatuses(ev.statuses); // notification diffing (no-op until armed)
      if (historyView === "tree" || historyView === "teams") renderHistory();
      break;
    }
    case "watches": {
      watches = ev.watches ?? { users: [], teams: [] };
      if (historyView === "teams") renderHistory();
      break;
    }
    case "team_prs": {
      teamPrs = ev.prs;
      for (const s of ev.prs) prStatusCache.set(prKey(s.pr), s);
      maybeNotifyFromStatuses(ev.prs);
      if (historyView === "teams") renderHistory();
      break;
    }
    case "skills_status": {
      if (ev.installed) {
        // Installed (initial check or post-install). Close any open prompt.
        closeSkillsModal();
        if (skillsPrompted) setStatus("review skills installed ✓");
      } else if (!skillsPrompted) {
        openSkillsModal(); // missing + not yet asked this session → consent
      }
      break;
    }
    case "notice": {
      setStatus(ev.message);
      break;
    }
    case "error": {
      setStatus(`⚠ ${ev.message}`, true);
      break;
    }
  }
}

// ── wiring ──────────────────────────────────────────────────────────────────
// Recognise the agent actually running in a tab so review actions dispatch the right
// macros. A declared agent (claude/codex/aider) wins; for a "shell" tab we sniff the
// terminal banner. Order matters: match specific agents before claude (broadest).
const AGENT_SIGNATURES: [RegExp, CliKind][] = [
  [/\bcodex\b|openai codex/i, "codex"],
  [/\baider\b/i, "aider"],
  [/claude code|claude-flow|\bruflo\b|anthropic|claude max|\bopus\b|\bsonnet\b/i, "claude"],
];
function resolveAgent(v: TabView): CliKind {
  if (v.cli !== "shell") return v.cli;
  const text = terminalText(v.term);
  for (const [re, cli] of AGENT_SIGNATURES) if (re.test(text)) return cli;
  return "claude"; // sensible default for an unrecognised agent shell
}

function pressButton(button: ReviewButton) {
  if (active === null) return;
  const v = tabs.get(active);
  if (!v) return;
  send({ type: "button", tab: active, button, agent: resolveAgent(v) });
}

// ── copy-content modal ──────────────────────────────────────────────────────
function setCopyStatus(msg: string, warn = false) {
  copyStatusEl.textContent = msg;
  copyStatusEl.classList.toggle("warn", warn);
}

async function copyToClipboard(text: string) {
  try {
    await writeText(text);
    setCopyStatus("copied to clipboard ✓");
  } catch (e) {
    setCopyStatus(`clipboard failed: ${e}`, true);
  }
}

/** Grab the active terminal's text (selection or full buffer), pop the modal, and
 *  push straight to the system clipboard via the Tauri clipboard plugin. */
async function copyContent() {
  if (active === null) return;
  const v = tabs.get(active);
  if (!v) return;
  const hadSelection = v.term.hasSelection();
  const content = terminalText(v.term);
  copyTextEl.value = content;
  copyModalEl.classList.remove("hidden");
  copyTextEl.focus();
  copyTextEl.setSelectionRange(0, copyTextEl.value.length);
  await copyToClipboard(content);
  if (!hadSelection) {
    setCopyStatus("copied whole buffer ✓ — tip: select text first for a tighter copy");
  }
}

function closeCopyModal() {
  copyModalEl.classList.add("hidden");
  if (active !== null) tabs.get(active)?.term.focus();
}

// ── skills consent modal ──────────────────────────────────────────────────────
function openSkillsModal() {
  skillsStatusEl.textContent = "";
  skillsStatusEl.classList.remove("warn");
  skillsModalEl.classList.remove("hidden");
}

function closeSkillsModal() {
  skillsModalEl.classList.add("hidden");
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return s.replace(/[&<>"']/g, (ch) => map[ch]);
}

// A lightweight, dynamically-built confirm modal (reuses the .modal styling). `body` may
// contain trusted inline markup (<b>/<code>); interpolate untrusted text via escapeHtml.
interface ModalOpts {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
}
function showModal(opts: ModalOpts) {
  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.innerHTML = `
    <div class="modal-card">
      <div class="modal-head">
        <span class="modal-title"></span>
        <button class="modal-x" title="Close (Esc)">×</button>
      </div>
      <div class="consent-body modal-prose"></div>
      <div class="modal-foot">
        <span class="toolbar-spacer"></span>
        <button class="action subtle" data-act="cancel">Cancel</button>
        <button class="primary" data-act="ok"></button>
      </div>
    </div>`;
  overlay.querySelector(".modal-title")!.textContent = opts.title;
  overlay.querySelector(".modal-prose")!.innerHTML = opts.body
    .split("\n\n")
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
  const okBtn = overlay.querySelector<HTMLButtonElement>('[data-act="ok"]')!;
  okBtn.textContent = opts.confirmLabel;

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  overlay.querySelector(".modal-x")!.addEventListener("click", close);
  overlay.querySelector('[data-act="cancel"]')!.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  okBtn.addEventListener("click", () => {
    close();
    opts.onConfirm();
  });
  document.body.appendChild(overlay);
  okBtn.focus();
}

/** "Not now" — dismiss for this session; we won't re-prompt until next launch. */
function dismissSkills() {
  skillsPrompted = true;
  closeSkillsModal();
  if (active !== null) tabs.get(active)?.term.focus();
}

function installSkills() {
  skillsPrompted = true;
  skillsStatusEl.classList.remove("warn");
  skillsStatusEl.textContent = "installing…";
  send({ type: "install_skills" }); // core replies with skills_status → closes modal
}

// ── theming ─────────────────────────────────────────────────────────────────
// Display name + a representative accent swatch for the picker.
const THEMES: ReadonlyArray<{ id: string; label: string; swatch: string }> = [
  { id: "instrument", label: "Instrument", swatch: "#c6f24e" },
  { id: "phosphor", label: "Phosphor", swatch: "#ffb000" },
  { id: "vscode", label: "VS Code", swatch: "#0a84ff" },
  { id: "dark", label: "Dark", swatch: "#2f81f7" },
  { id: "macos-dark", label: "macOS Dark", swatch: "#0a84ff" },
  { id: "light", label: "Light", swatch: "#0969da" },
];

function applyTheme(name: string) {
  if (!XTERM_THEMES[name]) name = "instrument";
  document.documentElement.dataset.theme = name;
  localStorage.setItem("pear.theme", name);
  const meta = THEMES.find((t) => t.id === name);
  const label = document.getElementById("theme-name");
  if (label) label.textContent = meta?.label ?? name;
  const sw = document.querySelector<HTMLElement>("#theme-toggle .swatch");
  if (sw && meta) sw.style.color = meta.swatch;
  const theme = XTERM_THEMES[name];
  const font = TERM_FONT[name];
  for (const v of tabs.values()) {
    v.term.options.theme = theme;
    v.term.options.fontFamily = font;
    v.fit.fit();
  }
  // Reflect the active row in the (possibly open) menu.
  document
    .querySelectorAll<HTMLElement>("#theme-menu .theme-opt")
    .forEach((o) => o.classList.toggle("on", o.dataset.theme === name));
}

/** Build the theme picker menu + wire the toggle to open/close it. */
function initThemePicker() {
  const menu = $("#theme-menu");
  menu.innerHTML = "";
  for (const t of THEMES) {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "theme-opt" + (currentTheme() === t.id ? " on" : "");
    opt.dataset.theme = t.id;
    const dot = document.createElement("span");
    dot.className = "theme-dot";
    dot.style.background = t.swatch;
    const name = document.createElement("span");
    name.textContent = t.label;
    opt.append(dot, name);
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      applyTheme(t.id);
      menu.classList.add("hidden");
    });
    menu.appendChild(opt);
  }
  $("#theme-toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  });
  document.addEventListener("click", () => menu.classList.add("hidden"));
}

// ── insight panel ───────────────────────────────────────────────────────────
function refitActive() {
  if (activeWin !== null) refitWindow(activeWin);
  else if (active !== null) tabs.get(active)?.fit.fit();
}

// ── zoom (⌘+ / ⌘- / ⌘0) — per terminal pane AND per panel surface ─────────────
const BASE_FONT = 13;
const MIN_FONT = 8;
const MAX_FONT = 28;
/** Adjust the focused pane's terminal font size (a number delta, or "reset" to the base),
 *  then refit so its rows/cols recompute. Each pane keeps its own zoom (xterm font size). */
function zoomPane(tab: number, delta: number | "reset") {
  const v = tabs.get(tab);
  if (!v) return;
  const cur = v.term.options.fontSize ?? BASE_FONT;
  const next =
    delta === "reset" ? BASE_FONT : Math.min(MAX_FONT, Math.max(MIN_FONT, cur + delta));
  if (next === cur) return;
  v.term.options.fontSize = next;
  try {
    v.fit.fit(); // recompute cols/rows for the new cell size (also emits a backend resize)
  } catch {
    /* host mid-layout */
  }
  setStatus(`pane zoom ${next}px${next === BASE_FONT ? " (reset)" : ""}`);
}

// HTML panels (diff, file viewer, conversation) zoom via CSS `zoom` on their scroll body —
// content scales and scrolls within the fixed-size panel. Each surface keeps its own level.
const surfaceZoom = new WeakMap<HTMLElement, number>();
function zoomSurface(el: HTMLElement, delta: number | "reset", label: string) {
  const cur = surfaceZoom.get(el) ?? 1;
  const next =
    delta === "reset" ? 1 : Math.min(2.4, Math.max(0.6, Math.round((cur + (delta > 0 ? 0.1 : -0.1)) * 100) / 100));
  if (next === cur) return;
  surfaceZoom.set(el, next);
  el.style.zoom = next === 1 ? "" : String(next);
  setStatus(`${label} zoom ${Math.round(next * 100)}%${next === 1 ? " (reset)" : ""}`);
}

// Track the cursor so ⌘± zooms whatever surface it's hovering (terminal pane / diff / tree /
// conversation), GitHub/editor-style, rather than always the focused terminal.
let lastMouse = { x: 0, y: 0 };
function trackMouse(e: MouseEvent) {
  lastMouse = { x: e.clientX, y: e.clientY };
}

/** Route a zoom step to the surface under the cursor; falls back to the focused pane. */
function applyZoom(delta: number | "reset") {
  const el = document.elementFromPoint(lastMouse.x, lastMouse.y) as HTMLElement | null;
  const host = el?.closest<HTMLElement>(".terminal-host");
  if (host) return zoomPane(Number(host.dataset.pane), delta);
  if (el?.closest("#diff-tree")) return zoomSurface($("#dtree-body"), delta, "file tree");
  if (el?.closest("#panel")) return zoomSurface(panelBodyEl, delta, "diff");
  if (el?.closest("#comments-panel")) return zoomSurface(commentsBodyEl, delta, "conversation");
  if (active !== null) zoomPane(active, delta);
}

/** ⌘/Ctrl +/-/0 zooms the surface under the cursor. Capture phase so we beat the webview's
 *  own zoom and xterm's key handling; ignored when typing in a real input/textarea. */
function handleZoomKey(e: KeyboardEvent) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const tgt = e.target;
  if (
    tgt instanceof HTMLElement &&
    !tgt.closest(".xterm") &&
    (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")
  ) {
    return; // a real form field (e.g. the review popover) — let it type
  }
  // ⌘⇧T reopens the most recently closed tab (browser-style).
  if (e.shiftKey && (e.key === "T" || e.key === "t")) {
    e.preventDefault();
    reopenLastClosed();
    return;
  }
  if (e.key === "=" || e.key === "+") {
    e.preventDefault();
    applyZoom(+1);
  } else if (e.key === "-" || e.key === "_") {
    e.preventDefault();
    applyZoom(-1);
  } else if (e.key === "0") {
    e.preventDefault();
    applyZoom("reset");
  }
}

function setPanel(open: boolean) {
  stageEl.classList.toggle("panel-open", open);
  panelToggleBtn.textContent = open ? "Insight ◂" : "Insight ▸";
  // The Diff button is "active" only while the panel is open AND showing a diff.
  document
    .getElementById("diff-btn")
    ?.classList.toggle("active", open && panelBodyEl.classList.contains("diff-mode"));
  renderTreeRail(); // hide the file-tree rail when the diff panel isn't showing
  requestAnimationFrame(refitActive);
}

function togglePanel() {
  setPanel(!stageEl.classList.contains("panel-open"));
}

function loadPanel() {
  if (active === null) return;
  send({ type: "load_panel", tab: active });
}

// Per-tab diff cache so reopening the panel is instant instead of re-hitting GitHub.
const diffCache = new Map<number, { diff: string; comments: DiffComment[] }>();

function diffTitle(tab: number): string {
  const pr = tabs.get(tab)?.pr ?? null;
  return pr ? `Diff — ${shortLabel(pr)}` : "Diff";
}

function showDiff(tab: number, diff: string, comments: DiffComment[]) {
  panelTitleEl.textContent = diffTitle(tab);
  panelBodyEl.classList.add("diff-mode");
  // Drive inline threads from the comments cache (resolved state + reactions) when
  // present; renderDiff falls back to the flat REST comments until they arrive.
  renderDiff(panelBodyEl, diff, comments, commentsCache.get(tab)?.threads ?? []);
  setPanel(true);
  renderTreeRail(); // re-sync the file-tree rail (open state persists across diffs)
  setStatus(`diff · ${comments.length} comment${comments.length === 1 ? "" : "s"}`);
}

/** Render a placeholder in the diff panel (loading / no-PR / error states). */
function showDiffMessage(tab: number, msg: string) {
  panelTitleEl.textContent = diffTitle(tab);
  panelBodyEl.classList.add("diff-mode");
  panelBodyEl.innerHTML = "";
  const div = document.createElement("div");
  div.className = "diff-empty";
  div.textContent = msg;
  panelBodyEl.appendChild(div);
  setPanel(true);
}

// ── diff file-tree rail ───────────────────────────────────────────────────────
// A GitHub-style file tree to the left of the diff. The "Files" toolbar button toggles
// it; the rail's own header drills between three scopes (◂ widens, ▸ narrows):
//   • "diff" — only the files included in the diff (default; click to jump to one).
//   • "dir"  — every file under the highest directory that contains a change.
//   • "repo" — the whole repository.
// Changed files show their +adds / −dels / 💬 count and are clickable; others are context.
const repoTreeCache = new Map<number, string[]>(); // tab → repo-relative tracked files
let treeOpen = false;
let treeLevel: TreeLevel = "diff";

interface FStat {
  adds: number;
  dels: number;
  comments: number;
}
interface TNode {
  name: string;
  full: string; // real repo-relative path (matches a .diff-file's data-path)
  children: Map<string, TNode>;
  isFile: boolean;
  hasChange: boolean;
}
// One step wider / narrower in scope (◂ / ▸), clamped at the ends.
const WIDER: Record<TreeLevel, TreeLevel> = { diff: "dir", dir: "repo", repo: "repo" };
const NARROWER: Record<TreeLevel, TreeLevel> = { repo: "dir", dir: "diff", diff: "diff" };

function diffShowing(): boolean {
  return stageEl.classList.contains("panel-open") && panelBodyEl.classList.contains("diff-mode");
}

/** Per-changed-file stats for the active tab: adds/dels from the diff, comment counts
 *  from the inline review threads. Its keys are exactly the diff's changed paths. */
function fileStats(tab: number): Map<string, FStat> {
  const m = new Map<string, FStat>();
  const d = diffCache.get(tab);
  if (d) for (const f of parseDiff(d.diff)) m.set(f.path, { adds: f.adds, dels: f.dels, comments: 0 });
  for (const t of commentsCache.get(tab)?.threads ?? []) {
    const s = m.get(t.path);
    if (s) s.comments += t.comments.length;
  }
  return m;
}

/** The deepest directory containing every changed file ("" = repo root). */
function changedRoot(paths: string[]): string {
  if (!paths.length) return "";
  const dirs = paths.map((p) => p.split("/").slice(0, -1));
  let common = dirs[0];
  for (const segs of dirs.slice(1)) {
    let i = 0;
    while (i < common.length && i < segs.length && common[i] === segs[i]) i++;
    common = common.slice(0, i);
  }
  return common.join("/");
}

/** Toggle the file-tree rail (the "Files" toolbar button). Opening ensures the diff is shown. */
function toggleFileTree() {
  if (active === null) return;
  if (treeOpen) {
    closeTree();
    return;
  }
  if (!diffShowing()) syncDiffToActive(); // the tree is the diff's companion
  treeOpen = true;
  if (treeLevel !== "diff" && !repoTreeCache.has(active)) send({ type: "load_repo_tree", tab: active });
  renderTreeRail();
}

function setTreeLevel(level: TreeLevel) {
  treeOpen = true;
  treeLevel = level;
  // dir / repo need the repo's full file list — fetch lazily, render when it lands.
  if (level !== "diff" && active !== null && !repoTreeCache.has(active)) {
    send({ type: "load_repo_tree", tab: active });
  }
  renderTreeRail();
}

function closeTree() {
  treeOpen = false;
  renderTreeRail();
}

/** Reflect tree state on the Files toolbar button + the rail's ◂ / ▸ drilldown buttons. */
function syncTreeControls() {
  document.getElementById("files-btn")?.classList.toggle("active", treeOpen);
  const wider = document.getElementById("dtree-wider") as HTMLButtonElement | null;
  const narrower = document.getElementById("dtree-narrower") as HTMLButtonElement | null;
  if (wider) wider.disabled = treeLevel === "repo";
  if (narrower) narrower.disabled = treeLevel === "diff";
}

/** Re-render the rail for the active tab + current scope. */
function renderTreeRail() {
  syncTreeControls();
  const rail = $("#diff-tree");
  const show = treeOpen && active !== null && diffShowing();
  rail.classList.toggle("hidden", !show);
  if (!show || active === null) return;

  const tab = active;
  const stats = fileStats(tab);
  const changed = [...stats.keys()];
  const scopeEl = $("#dtree-scope");
  const body = $("#dtree-body");

  let files: string[];
  let strip = "";
  if (treeLevel === "diff") {
    if (!diffCache.has(tab)) {
      scopeEl.textContent = "diff";
      body.innerHTML = `<div class="dtree-empty">loading diff…</div>`;
      return;
    }
    files = changed;
    scopeEl.textContent = `${changed.length} diff file${changed.length === 1 ? "" : "s"}`;
  } else {
    const repo = repoTreeCache.get(tab);
    if (!repo) {
      scopeEl.textContent = "listing…";
      body.innerHTML = `<div class="dtree-empty">listing repo…</div>`;
      return;
    }
    if (treeLevel === "dir") {
      const root = changedRoot(changed);
      strip = root;
      files = root ? repo.filter((p) => p === root || p.startsWith(root + "/")) : repo;
      scopeEl.textContent = root ? `${root}/` : "repo root";
    } else {
      files = repo;
      scopeEl.textContent = "whole repo";
    }
  }
  body.innerHTML = "";
  if (!files.length) {
    body.innerHTML = `<div class="dtree-empty">no files</div>`;
    return;
  }
  body.appendChild(buildTree(files, stats, strip, tab));
}

/** Build a nested folder/file tree, stripping `strip` (a dir prefix) from the displayed root. */
function buildTree(
  files: string[],
  stats: Map<string, FStat>,
  strip: string,
  tab: number,
): HTMLElement {
  const root: TNode = { name: "", full: "", children: new Map(), isFile: false, hasChange: false };
  for (const full of files) {
    const isCh = stats.has(full);
    const rel = strip && full.startsWith(strip + "/") ? full.slice(strip.length + 1) : full;
    const parts = rel.split("/");
    let node = root;
    root.hasChange ||= isCh;
    let acc = strip;
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.children.get(part);
      if (!child) {
        child = {
          name: part,
          full: acc,
          children: new Map(),
          isFile: i === parts.length - 1,
          hasChange: false,
        };
        node.children.set(part, child);
      }
      child.hasChange ||= isCh;
      node = child;
    });
  }
  const out = document.createElement("div");
  out.className = "dtree-list";
  renderNodes(root, out, stats, tab);
  return out;
}

function renderNodes(
  node: TNode,
  container: HTMLElement,
  stats: Map<string, FStat>,
  tab: number,
) {
  const kids = [...node.children.values()].sort((a, b) =>
    a.isFile === b.isFile ? a.name.localeCompare(b.name) : a.isFile ? 1 : -1,
  );
  for (const k of kids) {
    if (k.isFile) {
      const st = stats.get(k.full);
      const el = document.createElement("button");
      el.type = "button";
      el.className = "dtree-file" + (st ? " changed" : " plain");
      el.title = k.full;
      const name = document.createElement("span");
      name.className = "dtree-fname";
      name.textContent = k.name;
      el.appendChild(name);
      if (st) {
        const meta = document.createElement("span");
        meta.className = "dtree-fstat";
        if (st.comments) {
          const c = document.createElement("button");
          c.type = "button";
          c.className = "dtree-fc";
          c.textContent = `${st.comments}💬`;
          c.title = "Show this file's comment threads";
          c.addEventListener("click", (e) => {
            e.stopPropagation(); // don't trigger the file jump
            toggleFileThreads(c, tab, k.full);
          });
          meta.appendChild(c);
        }
        if (st.adds) {
          const a = document.createElement("span");
          a.className = "dtree-fa";
          a.textContent = `+${st.adds}`;
          meta.appendChild(a);
        }
        if (st.dels) {
          const dd = document.createElement("span");
          dd.className = "dtree-fd";
          dd.textContent = `−${st.dels}`;
          meta.appendChild(dd);
        }
        el.appendChild(meta);
        el.addEventListener("click", () => jumpToFile(k.full));
      } else {
        el.disabled = true; // context only — not in the diff
      }
      container.appendChild(el);
    } else {
      const folder = document.createElement("div");
      folder.className = "dtree-folder";
      const head = document.createElement("button");
      head.type = "button";
      head.className = "dtree-dir";
      const chev = document.createElement("span");
      chev.className = "dtree-chev";
      chev.textContent = "▾";
      const name = document.createElement("span");
      name.className = "dtree-name";
      name.textContent = k.name;
      head.append(chev, name);
      const childWrap = document.createElement("div");
      childWrap.className = "dtree-children";
      // Collapse folders with nothing changed inside (keep the changed path expanded).
      if (!k.hasChange) {
        head.classList.add("collapsed");
        childWrap.classList.add("collapsed");
      }
      head.addEventListener("click", () => {
        const c = childWrap.classList.toggle("collapsed");
        head.classList.toggle("collapsed", c);
      });
      folder.append(head, childWrap);
      renderNodes(k, childWrap, stats, tab);
      container.appendChild(folder);
    }
  }
}

/** Expand + scroll a file's diff card into view, with a brief highlight. */
function jumpToFile(path: string) {
  const card = panelBodyEl.querySelector<HTMLElement>(`.diff-file[data-path="${CSS.escape(path)}"]`);
  if (!card) return;
  card.classList.remove("collapsed");
  card.scrollIntoView({ block: "start", behavior: "smooth" });
  card.classList.add("dtree-jump");
  setTimeout(() => card.classList.remove("dtree-jump"), 1100);
}

/** Point the (open) diff panel at the active tab: cache → instant, PR-without-cache →
 *  fetch, no-PR tab → a placeholder. Called on Diff-button open and on tab switch. */
function syncDiffToActive() {
  if (active === null) return;
  const v = tabs.get(active);
  const cached = diffCache.get(active);
  if (cached) {
    showDiff(active, cached.diff, cached.comments);
  } else if (v?.pr) {
    showDiffMessage(active, "loading PR diff…");
    send({ type: "load_diff", tab: active });
  } else {
    showDiffMessage(active, "No diff — this tab isn't a pull request.");
  }
  // The diff shows inline threads, so make sure comments are loaded too.
  if (v?.pr) ensureComments(active);
  setPendingReview(commentsCache.get(active)?.pending_review_id ?? null);
  updateReviewBar(active);
}

/** Diff toolbar button: toggle the diff panel for the active tab. */
function loadDiff() {
  if (active === null) return;
  if (stageEl.classList.contains("panel-open") && panelBodyEl.classList.contains("diff-mode")) {
    setPanel(false);
    return;
  }
  syncDiffToActive();
}

// ── comments panel (PR conversation; splits left of the diff) ─────────────────
// Per-tab cache of the PR's conversation comments + inline review threads.
const commentsCache = new Map<number, PrComments>();

function setComments(open: boolean) {
  stageEl.classList.toggle("comments-open", open);
  document.getElementById("comments-btn")?.classList.toggle("active", open);
  requestAnimationFrame(refitActive);
}

/** Fetch comments for a tab once and cache them (shared by the panel + the diff's
 *  inline threads). Re-fetch is explicit via the Comments button. */
function ensureComments(tab: number) {
  if (commentsCache.has(tab)) return;
  if (!tabs.get(tab)?.pr) return;
  send({ type: "load_comments", tab });
}

// ── review-changes popup (GitHub-style: Approve / Request changes / Comment) ───
type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
const REVIEW_EVENTS: { id: ReviewEvent; label: string; hint: string }[] = [
  { id: "APPROVE", label: "Approve", hint: "Submit feedback and approve merging." },
  { id: "REQUEST_CHANGES", label: "Request changes", hint: "Submit feedback that must be addressed." },
  { id: "COMMENT", label: "Comment", hint: "Submit general feedback without approval." },
];

/** Open the GitHub-style "Review changes" popup for the active PR tab. If the viewer has
 *  a pending review (queued inline comments) it's submitted with the chosen verdict;
 *  otherwise a fresh review is created + submitted in one shot. */
function openReviewModal(defaultEvent: ReviewEvent = "APPROVE", anchor?: HTMLElement) {
  if (active === null) return;
  const v = tabs.get(active);
  if (!v?.pr) {
    setStatus("review: this tab isn't a pull request");
    return;
  }
  const tab = active;
  ensureComments(tab); // make sure we learn any pending-review id
  let chosen: ReviewEvent = defaultEvent;

  // A small popover anchored to the Review button (GitHub-style), not a centered modal.
  const scrim = document.createElement("div");
  scrim.className = "pop-scrim";
  scrim.innerHTML = `
    <div class="pop-caret"></div>
    <div class="modal-card review-card pop-card" role="dialog">
      <div class="modal-head">
        <span class="modal-title"></span>
        <button class="modal-x close-x" title="Close (Esc)">×</button>
      </div>
      <div class="rv-fields">
        <textarea class="rv-body" rows="4" placeholder="Leave a comment (optional for approve)"></textarea>
        <div class="rv-events"></div>
      </div>
      <div class="modal-foot">
        <span class="modal-status rv-hint"></span>
        <span class="toolbar-spacer"></span>
        <button class="primary rv-submit"></button>
      </div>
    </div>`;
  const card = scrim.querySelector<HTMLElement>(".pop-card")!;
  const caret = scrim.querySelector<HTMLElement>(".pop-caret")!;
  scrim.querySelector(".modal-title")!.textContent = `Review ${shortLabel(v.pr)}`;
  const body = scrim.querySelector<HTMLTextAreaElement>(".rv-body")!;
  const events = scrim.querySelector<HTMLElement>(".rv-events")!;
  const hint = scrim.querySelector<HTMLElement>(".rv-hint")!;
  const submit = scrim.querySelector<HTMLButtonElement>(".rv-submit")!;

  const refresh = () => {
    events.querySelectorAll<HTMLButtonElement>(".rv-event").forEach((b) =>
      b.classList.toggle("on", b.dataset.ev === chosen),
    );
    const meta = REVIEW_EVENTS.find((e) => e.id === chosen)!;
    hint.textContent = meta.hint;
    submit.textContent = meta.label;
    submit.classList.toggle("danger", chosen === "REQUEST_CHANGES");
  };
  for (const e of REVIEW_EVENTS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rv-event";
    b.dataset.ev = e.id;
    b.textContent = e.label;
    b.addEventListener("click", () => {
      chosen = e.id;
      refresh();
    });
    events.appendChild(b);
  }
  refresh();

  const close = () => {
    scrim.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  scrim.querySelector(".modal-x")!.addEventListener("click", close);
  scrim.addEventListener("click", (ev) => {
    if (ev.target === scrim) close();
  });
  submit.addEventListener("click", () => {
    const text = body.value.trim();
    if ((chosen === "REQUEST_CHANGES" || chosen === "COMMENT") && !text) {
      hint.textContent = "a comment is required for this verdict";
      hint.classList.add("warn");
      body.focus();
      return;
    }
    const pendingId = commentsCache.get(tab)?.pending_review_id ?? null;
    if (pendingId) {
      send({ type: "submit_review", tab, review_id: pendingId, event: chosen, body: text });
    } else {
      send({ type: "create_review", tab, event: chosen, body: text });
    }
    setStatus(`submitting review (${chosen.toLowerCase().replace(/_/g, " ")})…`);
    close();
  });
  document.body.appendChild(scrim);
  positionPopover(card, anchor, caret);
  body.focus();
}

/** Place a popover card (+ optional caret) anchored under (or above) `anchor`, right-aligned
 *  and clamped to the viewport. With no anchor it falls back to top-centered. */
function positionPopover(card: HTMLElement, anchor?: HTMLElement, caret?: HTMLElement | null) {
  const m = 8;
  const W = card.offsetWidth || 380;
  const ch = card.offsetHeight;
  if (!anchor) {
    card.style.left = `${Math.round((window.innerWidth - W) / 2)}px`;
    card.style.top = "84px";
    if (caret) caret.style.display = "none";
    return;
  }
  const r = anchor.getBoundingClientRect();
  const left = Math.max(m, Math.min(Math.round(r.right - W), window.innerWidth - W - m));
  let top = Math.round(r.bottom + 8);
  let below = true;
  if (top + ch > window.innerHeight - m) {
    const above = Math.round(r.top - ch - 8);
    if (above >= m) {
      top = above;
      below = false;
    } else {
      top = Math.max(m, window.innerHeight - ch - m);
    }
  }
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  if (caret) {
    const caretX = Math.max(left + 12, Math.min(r.left + r.width / 2 - 6, left + W - 24));
    caret.style.left = `${caretX}px`;
    caret.style.top = `${below ? top - 6 : top + ch - 6}px`;
    caret.classList.toggle("up", below);
    caret.classList.toggle("down", !below);
  }
}

// ── file-tree per-file thread pane ────────────────────────────────────────────
// Clicking a file's 💬 count in the tree toggles a small pane listing that file's threads;
// picking one jumps to it in the diff.
let fileThreadsScrim: HTMLElement | null = null;
let fileThreadsFor: HTMLElement | null = null;
function closeFileThreads() {
  fileThreadsScrim?.remove();
  fileThreadsScrim = null;
  fileThreadsFor = null;
}
function toggleFileThreads(anchor: HTMLElement, tab: number, path: string) {
  if (fileThreadsFor === anchor) return closeFileThreads(); // same bubble → toggle off
  closeFileThreads();
  const threads: ReviewThread[] = (commentsCache.get(tab)?.threads ?? []).filter(
    (t) => t.path === path,
  );
  if (!threads.length) return;

  const scrim = document.createElement("div");
  scrim.className = "pop-scrim";
  const pane = document.createElement("div");
  pane.className = "ftp-pane";
  const head = document.createElement("div");
  head.className = "ftp-head";
  const title = document.createElement("span");
  title.className = "ftp-title";
  const base = path.split("/").pop() ?? path;
  title.textContent = `${base} · ${threads.length} thread${threads.length === 1 ? "" : "s"}`;
  const x = document.createElement("button");
  x.className = "ftp-x close-x";
  x.textContent = "×";
  x.title = "Close";
  x.addEventListener("click", closeFileThreads);
  head.append(title, x);
  pane.appendChild(head);

  const list = document.createElement("div");
  list.className = "ftp-list";
  for (const t of threads) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "ftp-item" + (t.is_resolved ? " resolved" : "");
    const loc = document.createElement("span");
    loc.className = "ftp-loc";
    loc.textContent = `L${t.line ?? t.original_line ?? "?"}`;
    const first = t.comments[0];
    const meta = document.createElement("span");
    meta.className = "ftp-meta";
    const snippet = (first?.body ?? "").replace(/\s+/g, " ").trim().slice(0, 64);
    meta.textContent = first ? `${first.author}: ${snippet}` : "(empty thread)";
    item.append(loc, meta);
    if (t.is_resolved) {
      const r = document.createElement("span");
      r.className = "ftp-res";
      r.textContent = "✓";
      r.title = "resolved";
      item.appendChild(r);
    }
    item.addEventListener("click", () => {
      // Jump to the thread in the rendered diff; if it isn't anchored yet, ensure the diff
      // is showing and retry once.
      if (!jumpToThread(panelBodyEl, t.id)) {
        syncDiffToActive();
        setTimeout(() => jumpToThread(panelBodyEl, t.id), 140);
      }
      closeFileThreads();
    });
    list.appendChild(item);
  }
  pane.appendChild(list);
  scrim.appendChild(pane);
  scrim.addEventListener("click", (e) => {
    if (e.target === scrim) closeFileThreads();
  });
  document.body.appendChild(scrim);
  positionPopover(pane, anchor);
  fileThreadsScrim = scrim;
  fileThreadsFor = anchor;
}

function renderConversation(tab: number) {
  const c = commentsCache.get(tab);
  commentsBodyEl.innerHTML = "";
  commentsNavEl.classList.add("hidden");
  commentsCountEl.classList.remove("on");
  if (!c) {
    const div = document.createElement("div");
    div.className = "panel-empty";
    div.textContent = tabs.get(tab)?.pr ? "loading conversation…" : "This tab isn't a pull request.";
    commentsBodyEl.appendChild(div);
    commentsCountEl.textContent = "";
    return;
  }
  commentsCountEl.textContent = c.conversation.length
    ? `💬 See Threads (${c.conversation.length})`
    : "";
  if (!c.conversation.length) {
    const div = document.createElement("div");
    div.className = "panel-empty";
    div.textContent = "No conversation comments on this PR yet.";
    commentsBodyEl.appendChild(div);
    return;
  }
  for (const cm of c.conversation as Comment[]) {
    const card = document.createElement("div");
    card.className = "cv-card";
    card.dataset.commentId = cm.id;
    card.appendChild(commentEl(cm));
    commentsBodyEl.appendChild(card);
  }
  buildConversationNav(c.conversation as Comment[]);
}

/** Populate the conversation navigator (pop-out list; jump to each comment). */
function buildConversationNav(comments: Comment[]) {
  hideThreadPreview();
  commentsNavEl.innerHTML = "";
  const head = document.createElement("div");
  head.className = "dtl-head";
  const title = document.createElement("span");
  title.textContent = `${comments.length} comment${comments.length > 1 ? "s" : ""}`;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "dtl-close close-x";
  close.textContent = "×";
  close.title = "Hide list";
  close.addEventListener("click", () => {
    commentsNavEl.classList.add("hidden");
    commentsCountEl.classList.remove("on");
  });
  head.append(title, close);
  commentsNavEl.appendChild(head);

  for (const cm of comments) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "dtl-item with-av";
    // Author avatar (GitHub profile image), like the comment cards' floating header.
    const av = document.createElement("img");
    av.className = "dtl-av";
    av.loading = "lazy";
    av.alt = "";
    av.src = `https://github.com/${encodeURIComponent(cm.author)}.png?size=40`;
    av.addEventListener("error", () => (av.style.display = "none"));
    const text = document.createElement("span");
    text.className = "dtl-text";
    const loc = document.createElement("span");
    loc.className = "dtl-loc";
    loc.textContent = `${cm.author}${cm.review_state ? ` · ${cm.review_state.toLowerCase().replace(/_/g, " ")}` : ""} · ${relTime(cm.created_at)}`;
    const meta = document.createElement("span");
    meta.className = "dtl-meta";
    meta.textContent = (cm.body || "").replace(/\s+/g, " ").trim().slice(0, 80) || "(no text)";
    text.append(loc, meta);
    item.append(av, text);
    // Hover → a floating preview bubble with the full comment.
    item.addEventListener("mouseenter", () => showThreadPreview(item, cm));
    item.addEventListener("mouseleave", hideThreadPreview);
    item.addEventListener("click", () => {
      hideThreadPreview();
      const card = [...commentsBodyEl.querySelectorAll<HTMLElement>(".cv-card")].find(
        (e) => e.dataset.commentId === cm.id,
      );
      if (!card) return;
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 1100);
    });
    commentsNavEl.appendChild(item);
  }
}

// Floating preview bubble for the thread navigator: hover an item → see the full comment.
let dtlPreviewEl: HTMLElement | null = null;
function showThreadPreview(anchor: HTMLElement, cm: Comment) {
  if (!dtlPreviewEl) {
    dtlPreviewEl = document.createElement("div");
    dtlPreviewEl.className = "dtl-preview";
    document.body.appendChild(dtlPreviewEl);
  }
  const el = dtlPreviewEl;
  el.innerHTML = "";
  const head = document.createElement("div");
  head.className = "dtl-prev-head";
  const av = document.createElement("img");
  av.className = "dtl-prev-av";
  av.alt = "";
  av.src = `https://github.com/${encodeURIComponent(cm.author)}.png?size=48`;
  av.addEventListener("error", () => (av.style.display = "none"));
  const who = document.createElement("span");
  who.className = "dtl-prev-who";
  who.textContent = cm.author + (cm.review_state ? ` · ${cm.review_state.toLowerCase().replace(/_/g, " ")}` : "");
  head.append(av, who);
  const body = document.createElement("div");
  body.className = "dtl-prev-body markdown";
  renderMarkdown(body, cm.body || "_(no text)_");
  el.append(head, body);
  el.classList.add("show");
  // Place it to the LEFT of the comments panel (the panel hugs the right edge), vertically
  // aligned to the hovered item, clamped to the viewport.
  const panel = document.getElementById("comments-panel")?.getBoundingClientRect();
  const a = anchor.getBoundingClientRect();
  const left = panel ? panel.left - el.offsetWidth - 8 : a.left - el.offsetWidth - 8;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, Math.min(a.top, window.innerHeight - el.offsetHeight - 12))}px`;
}
function hideThreadPreview() {
  dtlPreviewEl?.classList.remove("show");
}

/** Point the (open) comments panel at the active tab: cached → render, PR-without-
 *  cache → fetch, non-PR → placeholder. */
function syncCommentsToActive() {
  if (active === null) return;
  renderConversation(active);
  if (tabs.get(active)?.pr) ensureComments(active);
}

/** Comments toolbar button: toggle the conversation panel for the active tab. */
function loadComments() {
  if (active === null) return;
  if (stageEl.classList.contains("comments-open")) {
    setComments(false);
    return;
  }
  syncCommentsToActive();
  setComments(true);
}

/** The "review in progress · Finish review" bar above the diff, shown when the viewer
 *  has a pending review on this tab's PR. */
function updateReviewBar(tab: number) {
  const meta = commentsCache.get(tab);
  reviewBarEl.innerHTML = "";
  if (!meta?.pending_review_id || tab !== active) {
    reviewBarEl.hidden = true;
    return;
  }
  const reviewId = meta.pending_review_id;
  reviewBarEl.hidden = false;

  const row = document.createElement("div");
  row.className = "rb-row";
  const dot = document.createElement("span");
  dot.className = "rb-dot";
  const label = document.createElement("span");
  label.className = "rb-label";
  const n = meta.pending_count;
  label.textContent = `Review in progress · ${n} comment${n === 1 ? "" : "s"}`;
  const spacer = document.createElement("span");
  spacer.className = "rb-spacer";
  const finish = document.createElement("button");
  finish.type = "button";
  finish.className = "rb-finish";
  finish.textContent = "Finish review ▾";
  row.append(dot, label, spacer, finish);

  const menu = document.createElement("div");
  menu.className = "rb-menu hidden";
  const ta = document.createElement("textarea");
  ta.placeholder = "Review summary (optional)…";
  ta.rows = 2;
  const actions = document.createElement("div");
  actions.className = "rb-actions";
  const mk = (text: string, event: string, cls: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dc-btn " + cls;
    b.textContent = text;
    b.addEventListener("click", () => {
      if (active === null) return;
      actions.querySelectorAll("button").forEach((x) => (x.disabled = true));
      finish.textContent = "Submitting…";
      send({ type: "submit_review", tab: active, review_id: reviewId, event, body: ta.value.trim() });
    });
    return b;
  };
  actions.append(
    mk("Comment", "COMMENT", "primary"),
    mk("Approve", "APPROVE", "ok"),
    mk("Request changes", "REQUEST_CHANGES", "warn"),
  );
  menu.append(ta, actions);
  finish.addEventListener("click", () => menu.classList.toggle("hidden"));
  reviewBarEl.append(row, menu);
}

// ── brain drawer (tail Claude's thinking) ─────────────────────────────────────
// The tab whose thinking is currently being streamed (null = not watching).
let brainTab: number | null = null;

function brainOpen(): boolean {
  return document.getElementById("workspace")?.classList.contains("brain-open") ?? false;
}

function appendThought(kind: string, text: string, detail = "") {
  const feed = $("#brain-feed");
  feed.querySelector(".brain-empty")?.remove();
  // Only autoscroll if the user is already near the bottom (don't yank them while reading).
  const atBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 48;

  if (kind === "action") {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "thought action" + (detail ? " has-detail" : "");
    chip.textContent = `⚒ ${text}`;
    feed.appendChild(chip);
    if (detail) {
      const pre = document.createElement("pre");
      pre.className = "thought-detail hidden";
      pre.textContent = detail;
      chip.addEventListener("click", () => {
        const open = pre.classList.toggle("hidden");
        chip.classList.toggle("open", !open);
      });
      feed.appendChild(pre);
    }
  } else {
    const div = document.createElement("div");
    div.className = `thought ${kind}`;
    div.textContent = text;
    feed.appendChild(div);
  }

  if (atBottom) feed.scrollTop = feed.scrollHeight;
}

/** Watch `tab`'s thinking (stops any previous watcher). Clears the feed. */
function watchBrainFor(tab: number | null) {
  if (brainTab !== null && brainTab !== tab) send({ type: "stop_brain", tab: brainTab });
  brainTab = tab;
  const feed = $("#brain-feed");
  const sub = $("#brain-sub");
  feed.innerHTML = "";
  if (tab === null) {
    feed.innerHTML = `<div class="brain-empty">No active tab.</div>`;
    sub.textContent = "";
    return;
  }
  const v = tabs.get(tab);
  sub.textContent = v ? (v.pr ? shortLabel(v.pr) : v.title) : "";
  feed.innerHTML = `<div class="brain-empty">waiting for thinking…</div>`;
  send({ type: "watch_brain", tab });
}

function setBrain(open: boolean) {
  $("#workspace").classList.toggle("brain-open", open);
  $("#brain-toggle").classList.toggle("active", open);
  if (open) {
    watchBrainFor(active);
  } else if (brainTab !== null) {
    send({ type: "stop_brain", tab: brainTab });
    brainTab = null;
  }
  requestAnimationFrame(refitActive);
}

// ── Ask Claude — floating insight cards ──────────────────────────────────────
// Each ask spawns a forked `claude -p` one-shot whose reply streams into its own
// dismissable card, stacked over the workspace — the live review conversation in the
// terminal is never touched. Cards are keyed by the request id the engine echoes back.
interface InsightCard {
  el: HTMLElement;
  body: HTMLElement;
  raw: string;
  /** The PR this ask came from — break-out resumes the fork as a tab on the same PR. */
  pr: PrRef | null;
  label: string;
  /** "↗ open as tab" button (enabled once the forked session id arrives on `done`). */
  breakBtn: HTMLButtonElement;
}
const insightCards = new Map<string, InsightCard>();

/** Create a streaming insight card and return its request id (sent with `ask_insight`). */
function openInsight(label: string, prompt: string): string {
  const id = crypto.randomUUID();
  const pr = (active !== null ? tabs.get(active)?.pr : null) ?? null;
  const card = document.createElement("div");
  card.className = "insight working";

  const head = document.createElement("div");
  head.className = "insight-head";
  const spinner = document.createElement("span");
  spinner.className = "insight-spin";
  spinner.textContent = "✦";
  const title = document.createElement("span");
  title.className = "insight-title";
  title.textContent = label;
  title.title = `${prompt}\n\n(forked side-conversation — won't touch your terminal session)`;

  // ↗ promote this forked one-shot into a live tab (resumes the exact branch). Disabled
  // until `done` delivers the forked session id; absent for non-PR asks (can't resume).
  const breakBtn = document.createElement("button");
  breakBtn.type = "button";
  breakBtn.className = "insight-btn break";
  breakBtn.textContent = "↗";
  breakBtn.title = "Open this forked chat as a tab";
  breakBtn.disabled = true;

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "insight-btn";
  copy.textContent = "⧉";
  copy.title = "Copy answer";
  copy.addEventListener("click", () => {
    const c = insightCards.get(id);
    if (c && c.raw.trim()) {
      void writeText(c.raw);
      setStatus("copied insight");
    }
  });
  const close = document.createElement("button");
  close.type = "button";
  close.className = "insight-btn close";
  close.textContent = "×";
  close.title = "Dismiss";
  close.addEventListener("click", () => {
    card.remove();
    insightCards.delete(id);
  });
  head.append(spinner, title, breakBtn, copy, close);

  const body = document.createElement("div");
  body.className = "insight-body markdown";
  body.innerHTML = `<div class="insight-wait">thinking…</div>`;

  card.append(head, body);
  $("#insight-stack").appendChild(card);
  insightCards.set(id, { el: card, body, raw: "", pr, label, breakBtn });
  return id;
}

/** Apply one streamed insight piece (`chunk` | `done` | `error`) to its card. */
function updateInsight(id: string, kind: string, text: string) {
  const c = insightCards.get(id);
  if (!c) return;
  const atBottom = c.body.scrollTop + c.body.clientHeight >= c.body.scrollHeight - 24;
  if (kind === "chunk") {
    c.raw += text;
    renderMarkdown(c.body, c.raw);
    if (atBottom) c.body.scrollTop = c.body.scrollHeight;
  } else if (kind === "done") {
    c.el.classList.remove("working");
    if (!c.raw.trim()) c.body.innerHTML = `<div class="insight-wait">no answer.</div>`;
    // `text` carries the forked session id — enable "open as tab" (PR asks only; the
    // engine resumes Claude sessions on PR tabs).
    const sid = text.trim();
    if (sid && c.pr) {
      const pr = c.pr;
      c.breakBtn.disabled = false;
      c.breakBtn.addEventListener("click", () => confirmForkOut(pr, sid, c.label, id));
    }
  } else if (kind === "error") {
    c.el.classList.remove("working");
    c.el.classList.add("errored");
    const err = document.createElement("div");
    err.className = "insight-err";
    err.textContent = text || "couldn't get an answer";
    if (!c.raw.trim()) c.body.innerHTML = "";
    c.body.appendChild(err);
  }
}

/** Informative confirm before promoting a forked insight into a live, resumable tab. */
function confirmForkOut(pr: PrRef, sessionId: string, label: string, cardId: string) {
  showModal({
    title: "Open forked chat as a tab",
    body:
      `This answer came from a <b>forked side-conversation</b> — a throwaway branch of this ` +
      `tab's Claude session that inherited the review's context but never touched it.\n\n` +
      `Opening it as a tab <b>resumes that exact branch</b> as a live, interactive session on ` +
      `<b>${escapeHtml(shortLabel(pr))}</b>, so you can keep going. Your original review ` +
      `conversation stays exactly where it was.`,
    confirmLabel: "↗ Open as tab",
    onConfirm: () => {
      openPr(pr, "claude", { session_id: sessionId });
      setStatus(`opening forked chat — ${label}`);
      // Dismiss the card; the conversation continues in the new tab.
      const c = insightCards.get(cardId);
      c?.el.remove();
      insightCards.delete(cardId);
    },
  });
}

function renderPanel(p: PanelPayload) {
  panelTitleEl.textContent = p.title || "Insight";
  panelBodyEl.classList.remove("diff-mode");
  panelBodyEl.innerHTML = "";
  if (p.kind === "diff") {
    const pre = document.createElement("pre");
    pre.className = "panel-diff";
    for (const raw of p.body.split("\n")) {
      const span = document.createElement("span");
      span.className = raw.startsWith("+")
        ? "d-add"
        : raw.startsWith("-")
          ? "d-del"
          : raw.startsWith("@@")
            ? "d-hunk"
            : "";
      span.textContent = raw + "\n";
      pre.appendChild(span);
    }
    panelBodyEl.appendChild(pre);
  } else if (p.kind === "note") {
    const div = document.createElement("div");
    div.className = "panel-note";
    div.textContent = p.body;
    panelBodyEl.appendChild(div);
  } else {
    const div = document.createElement("div");
    div.className = "panel-md";
    // Local, self-authored review content; rendered for readability.
    div.innerHTML = marked.parse(p.body, { async: false }) as string;
    panelBodyEl.appendChild(div);
  }
  setPanel(true);
}

// ── launcher wiring (segmented engine + intensity chips) ─────────────────────
// Engine pill bar drives which intensities are offered; an intensity chip selects the
// review to auto-run on Open (click the selected one again = "just open", no review).
// Ultra is money-guarded: arm on first click, confirm on the second (or a dbl-click).
function initLauncher(): void {
  const seg = $("#engine-seg");
  const intensity = $("#intensity");
  const openBtn = $<HTMLButtonElement>("#open-btn");
  const permSelect = $("#perm-select");
  let ultraArmTimer = 0;

  // Restore persisted choices.
  const savedEngine = localStorage.getItem("pear.engine");
  if (savedEngine === "claude" || savedEngine === "codex" || savedEngine === "aider") {
    selectedEngine = savedEngine;
  }
  const savedTier = localStorage.getItem("pear.tier") ?? "standard";
  selectedTier = savedTier === "off" ? null
    : (["light", "standard", "complex", "ultra"].includes(savedTier) ? (savedTier as LaunchReview) : "standard");

  const disarmUltra = () => {
    clearTimeout(ultraArmTimer);
    intensity.querySelector(".chip.pay")?.classList.remove("armed");
  };

  // Re-render pills, chip availability, perms visibility, and the CTA label.
  const refresh = () => {
    seg.querySelectorAll<HTMLButtonElement>("button[data-engine]").forEach((b) =>
      b.classList.toggle("on", b.dataset.engine === selectedEngine),
    );
    const allowed = ENGINE_TIERS[selectedEngine] ?? new Set<string>();
    if (selectedTier && !allowed.has(selectedTier)) {
      selectedTier = allowed.has("standard") ? "standard" : null; // drop what this engine can't run
    }
    intensity.querySelectorAll<HTMLButtonElement>(".chip").forEach((c) => {
      const tier = c.dataset.tier!;
      c.disabled = !allowed.has(tier);
      c.classList.toggle("on", tier === selectedTier);
    });
    disarmUltra();
    permSelect.classList.toggle("hidden", selectedEngine !== "claude");
    refreshLaunchAdv();
    openBtn.textContent = selectedTier ? "▸ Open & review" : "▸ Open";
    localStorage.setItem("pear.engine", selectedEngine);
    localStorage.setItem("pear.tier", selectedTier ?? "off");
  };

  // Per-engine model / effort / access selectors.
  const modelSel = $<HTMLSelectElement>("#model-select");
  const modelCustom = $<HTMLInputElement>("#model-custom");
  const effortSel = $<HTMLSelectElement>("#codex-effort");
  const accessSel = $<HTMLSelectElement>("#codex-access");
  const refreshLaunchAdv = () => {
    const cur = engineModel(selectedEngine);
    const presets = MODEL_PRESETS[selectedEngine] ?? [];
    const isCustom = cur !== "" && !presets.includes(cur);
    modelSel.innerHTML = "";
    modelSel.add(new Option("model · default", ""));
    for (const p of presets) modelSel.add(new Option(p, p));
    modelSel.add(new Option("custom…", "__custom__"));
    modelSel.value = isCustom ? "__custom__" : cur;
    modelCustom.classList.toggle("hidden", modelSel.value !== "__custom__");
    if (isCustom) modelCustom.value = cur;
    const isCodex = selectedEngine === "codex";
    effortSel.classList.toggle("hidden", !isCodex);
    accessSel.classList.toggle("hidden", !isCodex);
    effortSel.value = localStorage.getItem("pear.codexEffort") ?? "";
    accessSel.value = localStorage.getItem("pear.codexAccess") ?? "";
  };
  modelSel.addEventListener("change", () => {
    if (modelSel.value === "__custom__") {
      modelCustom.classList.remove("hidden");
      modelCustom.focus();
      return;
    }
    localStorage.setItem(`pear.model.${selectedEngine}`, modelSel.value);
    modelCustom.classList.add("hidden");
    sendLaunchConfig();
  });
  const commitCustomModel = () => {
    localStorage.setItem(`pear.model.${selectedEngine}`, modelCustom.value.trim());
    sendLaunchConfig();
  };
  modelCustom.addEventListener("change", commitCustomModel);
  modelCustom.addEventListener("blur", commitCustomModel);
  effortSel.addEventListener("change", () => {
    localStorage.setItem("pear.codexEffort", effortSel.value);
    sendLaunchConfig();
  });
  accessSel.addEventListener("change", () => {
    localStorage.setItem("pear.codexAccess", accessSel.value);
    sendLaunchConfig();
  });

  seg.querySelectorAll<HTMLButtonElement>("button[data-engine]").forEach((b) =>
    b.addEventListener("click", () => {
      selectedEngine = b.dataset.engine as CliKind;
      refresh();
    }),
  );

  const pickTier = (tier: LaunchReview) => {
    selectedTier = selectedTier === tier ? null : tier; // click the selected one again = just open
    refresh();
  };
  intensity.querySelectorAll<HTMLButtonElement>(".chip").forEach((c) => {
    const tier = c.dataset.tier as LaunchReview;
    if (tier === "ultra") {
      c.addEventListener("click", () => {
        if (c.disabled) return;
        if (selectedTier === "ultra" || c.classList.contains("armed")) {
          pickTier("ultra");
          return;
        }
        c.classList.add("armed");
        setStatus("Ultra is a paid cloud review — click again to confirm 💸");
        ultraArmTimer = window.setTimeout(() => { disarmUltra(); refresh(); }, 2500);
      });
      c.addEventListener("dblclick", () => {
        if (!c.disabled) { selectedTier = "ultra"; refresh(); }
      });
    } else {
      c.addEventListener("click", () => { if (!c.disabled) pickTier(tier); });
    }
  });

  refresh();
  sendLaunchConfig(); // push persisted model/effort/access to the engine on startup
}

window.addEventListener("DOMContentLoaded", async () => {
  tabbarEl = $("#tabbar");
  terminalsEl = $("#terminals");
  historyEl = $("#history");
  statusEl = $("#status");
  prInput = $("#pr-input");
  toolbarEl = $("#toolbar");
  // Prepend the line icon into each labelled toolbar button.
  toolbarEl.querySelectorAll<HTMLButtonElement>("button[data-icon]").forEach((b) => {
    const ic = TOOLBAR_ICONS[b.dataset.icon ?? ""];
    if (ic) b.insertAdjacentHTML("afterbegin", actionSvg(ic));
  });
  copyModalEl = $("#copy-modal");
  copyTextEl = $("#copy-modal-text");
  copyStatusEl = $("#copy-modal-status");
  skillsModalEl = $("#skills-modal");
  skillsStatusEl = $("#skills-status");
  stageEl = $("#stage");
  panelBodyEl = $("#panel-body");
  panelTitleEl = $("#panel-title");
  panelToggleBtn = $("#panel-toggle");
  commentsBodyEl = $("#comments-body");
  commentsCountEl = $("#comments-count");
  commentsNavEl = $("#comments-nav");
  reviewBarEl = $("#review-bar");

  initLauncher();

  $("#open-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const pr = parsePrRef(prInput.value);
    // Agent engines run the review workflow, which needs a PR. (Bare terminals come from
    // the "New empty shell" button instead.)
    if (!pr) {
      setStatus("⚠ enter owner/repo#NUMBER — or use “+ New empty shell” for a plain terminal", true);
      return;
    }
    // The Open box always starts a FRESH session; History is where you resume.
    // selectedTier null = open without a review.
    openPr(pr, selectedEngine, { fresh: true, autoReview: selectedTier });
    prInput.value = "";
  });

  $("#new-shell").addEventListener("click", () =>
    send({ type: "open_scratch", cli: "shell", cwd: null }),
  );

  $("#history-clear").addEventListener("click", () => send({ type: "clear_history" }));
  $("#history-restore").addEventListener("click", () => send({ type: "restore_history" }));

  // History view: list ⇄ org→repo→PR tree, favorites-only filter, add-favorite, search.
  const setHistView = (v: HistView) => {
    historyView = v;
    localStorage.setItem("pear.histView", v);
    if (v === "teams") refreshTeams();
    renderHistory();
  };
  $("#view-list").addEventListener("click", () => setHistView("list"));
  $("#view-tree").addEventListener("click", () => setHistView("tree"));
  $("#view-queue").addEventListener("click", () => setHistView("queue"));
  $("#view-teams")?.addEventListener("click", () => setHistView("teams"));
  $("#fav-only").addEventListener("click", () => {
    favOnly = !favOnly;
    localStorage.setItem("pear.favOnly", favOnly ? "1" : "0");
    renderHistory();
  });
  $("#hist-add").addEventListener("click", (e) => {
    e.stopPropagation();
    promptHistAdd();
  });
  // Token-field search: committed qualifiers are chips inside the box; the input holds the
  // in-progress term. Typing live-filters using committed chips + the pending text. Space or
  // Enter commits the term to a chip (tag values never contain spaces) — EXCEPT a space right
  // after `repo:` (an incomplete qualifier, no value yet) is swallowed so it can't make a junk
  // chip. Backspace on an empty input removes the last chip.
  const searchEl = $<HTMLInputElement>("#hist-search-input");
  searchEl.addEventListener("input", () => renderHistory());
  searchEl.addEventListener("keydown", (e) => {
    const trimmed = searchEl.value.trim();
    if (e.key === "Enter" || e.key === " ") {
      if (!trimmed) return; // let a bare space through
      e.preventDefault();
      if (trimmed.endsWith(":")) return; // incomplete `repo:` — swallow the stray space
      commitPending();
    } else if (e.key === "Backspace" && searchEl.value === "" && searchEl.selectionStart === 0) {
      if (removeLastChip()) e.preventDefault();
    }
  });
  // Click anywhere in the box focuses the input.
  $("#hist-search").addEventListener("click", () => searchEl.focus());
  // Dismiss the history context menu / add popover on any outside click or Escape.
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement)?.closest("#hist-ctx")) closeHistCtx();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeHistCtx();
  });

  // Action buttons. copy_content is frontend-handled (clipboard); the rest — including
  // save_review (now an agent "write the review to markdown" command) — are core macros.
  toolbarEl.querySelectorAll<HTMLButtonElement>("button[data-btn]").forEach((b) => {
    const which = b.dataset.btn!;
    b.addEventListener("click", () => {
      if (which === "copy_content") copyContent();
      else pressButton(which as ReviewButton);
    });
  });

  // Insight panel + auto-review.
  panelToggleBtn.addEventListener("click", togglePanel);
  $("#panel-close").addEventListener("click", () => setPanel(false));
  $("#panel-load").addEventListener("click", loadPanel);
  $("#diff-btn").addEventListener("click", loadDiff);
  $("#comments-btn").addEventListener("click", loadComments);
  $("#approve-btn").addEventListener("click", (e) =>
    openReviewModal("APPROVE", e.currentTarget as HTMLElement),
  );
  $("#comments-close").addEventListener("click", () => setComments(false));
  // The comment count toggles a pop-out navigator (jump to each conversation comment).
  commentsCountEl.addEventListener("click", () => {
    if (!commentsNavEl.children.length) return;
    const open = commentsNavEl.classList.toggle("hidden");
    commentsCountEl.classList.toggle("on", !open);
  });
  // Reactions (shared by the conversation panel + inline diff threads): toggle on the
  // active tab; the engine re-fetches and re-emits comments with authoritative state.
  setReactionHandler((subject_id, content, add) => {
    if (active === null) return;
    send({ type: "toggle_reaction", tab: active, subject_id, content, add });
  });
  // Create a new inline comment (single, or batched into the pending review).
  setCreateHandler((c) => {
    if (active === null) return;
    const meta = commentsCache.get(active);
    if (!meta) return;
    send({
      type: "create_review_comment",
      tab: active,
      mode: c.mode,
      body: c.body,
      commit_id: meta.head_sha,
      pr_node_id: meta.pr_node_id,
      review_id: meta.pending_review_id,
      path: c.path,
      line: c.line,
      side: c.side,
      start_line: c.start_line ?? null,
      start_side: c.start_side ?? null,
    });
  });
  // Reply to an existing inline thread.
  setReplyHandler((thread_id, body) => {
    if (active === null) return;
    send({ type: "reply_review_thread", tab: active, thread_id, body });
  });
  // "Ask Claude" — answer the question off the main thread. The engine forks the tab's
  // session into a throwaway one-shot and streams the reply into a floating insight card,
  // so the live review conversation is never disturbed.
  setAskHandler((message, label) => {
    if (active === null) return;
    const id = openInsight(label, message);
    send({ type: "ask_insight", tab: active, id, prompt: message });
    setStatus("asked Claude — streaming a side answer…");
  });
  // Resolve / unresolve an inline thread.
  setResolveHandler((thread_id, resolved) => {
    if (active === null) return;
    send({ type: "resolve_thread", tab: active, thread_id, resolved });
  });
  // The diff toolbar's × closes the panel.
  setDiffCloseHandler(() => setPanel(false));
  // File tree: a top-toolbar "Files" button toggles the rail; the rail's own ◂ / ▸
  // drill between scopes (◂ widens diff → dir → repo, ▸ narrows back).
  $("#files-btn").addEventListener("click", toggleFileTree);
  $("#dtree-wider").addEventListener("click", () => setTreeLevel(WIDER[treeLevel]));
  $("#dtree-narrower").addEventListener("click", () => setTreeLevel(NARROWER[treeLevel]));
  $("#dtree-close").addEventListener("click", () => closeTree());
  setApproveHandler((anchor) => openReviewModal("APPROVE", anchor));
  // Insight is hard-coded off for now — hide its controls (the panel itself is reused
  // by the diff view, so it stays). Flip INSIGHT_ENABLED to bring these back.
  if (!INSIGHT_ENABLED) {
    panelToggleBtn.style.display = "none";
    $("#panel-load").style.display = "none";
  }

  // Brain drawer toggle (status bar) + close button.
  $("#brain-toggle").addEventListener("click", () => setBrain(!brainOpen()));

  // Persist-session toggle (default ON): reopen the same tabs + sessions next launch.
  const persistBtn = $("#persist-toggle");
  persistBtn.classList.toggle("active", persistOn());
  persistBtn.addEventListener("click", () => {
    const next = !persistOn();
    localStorage.setItem("pear.persist", next ? "1" : "0");
    persistBtn.classList.toggle("active", next);
    if (next) saveLayout();
    else send({ type: "clear_layout" });
    setStatus(next ? "persist on — these tabs reopen next launch" : "persist off — saved layout cleared");
  });
  // Zoom: ⌘/Ctrl + +/-/0 resizes whatever surface the cursor is over — a terminal pane or a
  // panel (diff / file tree / conversation). Capture phase beats the webview's built-in zoom.
  window.addEventListener("mousemove", trackMouse, true);
  window.addEventListener("keydown", handleZoomKey, true);
  // Best-effort capture of the latest cwd / focused tab before the window goes away.
  window.addEventListener("beforeunload", saveLayout);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveLayout();
  });
  $("#brain-close").addEventListener("click", () => setBrain(false));

  // Collapsible sidebar: hard toggle (status ☰ / sidebar ‹ / ⌘B), persisted. When
  // collapsed it parks off-screen and the left-edge hot-zone floats it back (CSS).
  const appEl = $("#app");
  const setSidebar = (collapsed: boolean) => {
    appEl.classList.toggle("sidebar-collapsed", collapsed);
    // Suppress the hover-peek while collapsing under the cursor; re-armed on edge enter.
    appEl.classList.toggle("peek-suppressed", collapsed);
    $("#sidebar-toggle").classList.toggle("active", !collapsed);
    localStorage.setItem("pear.sidebarCollapsed", collapsed ? "1" : "0");
  };
  const toggleSidebar = () => setSidebar(!appEl.classList.contains("sidebar-collapsed"));
  // Default open: only collapsed if the user explicitly left it that way.
  setSidebar(localStorage.getItem("pear.sidebarCollapsed") === "1");
  $("#sidebar-toggle").addEventListener("click", toggleSidebar);
  $("#sidebar-collapse").addEventListener("click", () => setSidebar(true));
  // Re-arm the peek once the cursor reaches the left edge again.
  $("#edge-peek").addEventListener("mouseenter", () => appEl.classList.remove("peek-suppressed"));
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      toggleSidebar();
    }
  });

  // Smallest the terminal may get squeezed to by a panel drag (keeps xterm rendering
  // horizontally; below ~120px it collapses to a 1-char vertical sliver).
  const TERMINAL_MIN = 160;
  const commentsPanelEl = $<HTMLElement>("#comments-panel");
  const diffPanelEl = $<HTMLElement>("#panel");

  // The divider between conversations and the diff panel. When BOTH are open it trades space
  // between them — conversations grow as the diff shrinks (terminals stay put), which is what
  // "drag the conversation↔file-tree divider to resize conversations" means. With only the diff
  // open it falls back to resizing the diff vs the terminal.
  const savedPanelW = localStorage.getItem("pear.panelW");
  if (savedPanelW) stageEl.style.setProperty("--panel-w", savedPanelW);
  const resizer = $<HTMLElement>("#panel-resizer");
  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    stageEl.classList.add("resizing");
    const bothOpen = stageEl.classList.contains("comments-open");
    const rect = stageEl.getBoundingClientRect();
    const convLeft = commentsPanelEl.getBoundingClientRect().left; // fixed (terminals don't move)
    const pair =
      commentsPanelEl.getBoundingClientRect().width + diffPanelEl.getBoundingClientRect().width;
    const onMove = (ev: PointerEvent) => {
      if (bothOpen) {
        // Conversation's right edge follows the pointer; the diff panel gives up the space.
        const hi = Math.max(240, pair - 280); // keep the diff panel ≥ 280
        const cw = Math.min(Math.max(ev.clientX - convLeft, 240), hi);
        stageEl.style.setProperty("--comments-w", `${Math.round(cw)}px`);
        stageEl.style.setProperty("--panel-w", `${Math.round(pair - cw)}px`);
      } else {
        const maxDiff = rect.width - 10 - TERMINAL_MIN;
        const w = Math.min(Math.max(rect.right - ev.clientX, 300), maxDiff);
        stageEl.style.setProperty("--panel-w", `${Math.round(w)}px`);
      }
      refitActive();
    };
    const onUp = () => {
      stageEl.classList.remove("resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const pw = stageEl.style.getPropertyValue("--panel-w");
      const cw = stageEl.style.getPropertyValue("--comments-w");
      if (pw) localStorage.setItem("pear.panelW", pw);
      if (bothOpen && cw) localStorage.setItem("pear.commentsW", cw);
      refitActive();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  // Double-click resets the conversation panel to its standard width (drops the override →
  // the CSS default 340px).
  resizer.addEventListener("dblclick", () => {
    stageEl.style.removeProperty("--comments-w");
    localStorage.removeItem("pear.commentsW");
    refitActive();
    setStatus("conversation width reset");
  });

  // Resizable conversation panel (drag the divider between the terminal and it).
  const savedCommentsW = localStorage.getItem("pear.commentsW");
  if (savedCommentsW) stageEl.style.setProperty("--comments-w", savedCommentsW);
  const cResizer = $<HTMLElement>("#comments-resizer");
  cResizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    cResizer.setPointerCapture(e.pointerId);
    stageEl.classList.add("resizing");
    const onMove = (ev: PointerEvent) => {
      // The panel is right-anchored (terminals absorb the change), so its right edge
      // is stable during the drag — width is just (right edge − pointer). Bounded so
      // the terminal (and the diff, if open) keep their minimum.
      const rect = stageEl.getBoundingClientRect();
      const diffW = stageEl.classList.contains("panel-open")
        ? diffPanelEl.getBoundingClientRect().width
        : 0;
      const right = commentsPanelEl.getBoundingClientRect().right;
      const max = rect.width - diffW - 10 - TERMINAL_MIN;
      const w = Math.min(Math.max(right - ev.clientX, 240), max);
      stageEl.style.setProperty("--comments-w", `${Math.round(w)}px`);
      refitActive();
    };
    const onUp = () => {
      stageEl.classList.remove("resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const w = stageEl.style.getPropertyValue("--comments-w");
      if (w) localStorage.setItem("pear.commentsW", w);
      refitActive();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  // Resizable file tree (drag the divider between the file tree and the diff body). The tree
  // keeps a minimum so it can't be crushed; leave it where you like and it stays put.
  const savedTreeW = localStorage.getItem("pear.dtreeW");
  const diffTreeEl = $<HTMLElement>("#diff-tree");
  if (savedTreeW) diffTreeEl.style.setProperty("--dtree-w", savedTreeW);
  const tResizer = $<HTMLElement>("#dtree-resizer");
  tResizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    tResizer.setPointerCapture(e.pointerId);
    stageEl.classList.add("resizing-tree");
    const onMove = (ev: PointerEvent) => {
      const left = diffTreeEl.getBoundingClientRect().left;
      const panelW = diffPanelEl.getBoundingClientRect().width;
      const maxTree = Math.max(150, panelW - 200); // always leave room for the diff body
      const w = Math.min(Math.max(ev.clientX - left, 150), maxTree);
      diffTreeEl.style.setProperty("--dtree-w", `${Math.round(w)}px`);
    };
    const onUp = () => {
      stageEl.classList.remove("resizing-tree");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const w = diffTreeEl.style.getPropertyValue("--dtree-w");
      if (w) localStorage.setItem("pear.dtreeW", w);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  // Double-click resets the file tree to its standard width (drops the override → 232px).
  tResizer.addEventListener("dblclick", () => {
    diffTreeEl.style.removeProperty("--dtree-w");
    localStorage.removeItem("pear.dtreeW");
    setStatus("file tree width reset");
  });

  // Theme picker — 6 themes; persisted, restyles terminals live. Deep-link: a
  // matching #<theme> in the URL hash forces it (handy for previews).
  const hashTheme = location.hash.slice(1);
  const initialTheme = XTERM_THEMES[hashTheme]
    ? hashTheme
    : localStorage.getItem("pear.theme") || "instrument";
  initThemePicker();
  applyTheme(initialTheme);

  // Claude permission mode — auto (smart) by default; bypass = zero prompts.
  const permSelect = $<HTMLSelectElement>("#perm-select");
  const savedPerm = localStorage.getItem("pear.perm") || "auto";
  permSelect.value = savedPerm;
  permSelect.classList.toggle("perm-danger", savedPerm === "bypassPermissions");
  send({ type: "set_claude_permission", mode: savedPerm });
  permSelect.addEventListener("change", () => {
    localStorage.setItem("pear.perm", permSelect.value);
    permSelect.classList.toggle("perm-danger", permSelect.value === "bypassPermissions");
    send({ type: "set_claude_permission", mode: permSelect.value });
  });

  // Copy modal controls.
  $("#copy-modal-close").addEventListener("click", closeCopyModal);
  $("#copy-modal-done").addEventListener("click", closeCopyModal);
  $("#copy-modal-recopy").addEventListener("click", () => copyToClipboard(copyTextEl.value));
  copyModalEl.addEventListener("click", (e) => {
    if (e.target === copyModalEl) closeCopyModal();
  });

  // Skills consent modal controls.
  $("#skills-install").addEventListener("click", installSkills);
  $("#skills-later").addEventListener("click", dismissSkills);
  $("#skills-dismiss").addEventListener("click", dismissSkills);
  skillsModalEl.addEventListener("click", (e) => {
    if (e.target === skillsModalEl) dismissSkills(); // backdrop click = not now
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!skillsModalEl.classList.contains("hidden")) dismissSkills();
      else if (!copyModalEl.classList.contains("hidden")) closeCopyModal();
      else closeSessionPop();
    }
  });
  document.addEventListener("click", () => closeSessionPop());

  const refit = () => {
    if (active !== null) tabs.get(active)?.fit.fit();
  };
  window.addEventListener("resize", refit);
  new ResizeObserver(refit).observe(terminalsEl);

  initNotifications(); // wire the bell + polling before the (Tauri-only) event listener

  await listen<CoreEvent>("pear:event", (e) => handle(e.payload));

  renderTabBar();
  renderToolbar();
  // Show the running app version in the sidebar brand.
  getVersion()
    .then((v) => {
      const el = document.getElementById("app-version");
      if (el) el.textContent = `v${v}`;
    })
    .catch(() => {});
  send({ type: "load_history" });
  if (historyView === "teams") refreshTeams(); // restore the Teams view on launch
  send({ type: "check_skills" }); // → skills_status; consent modal if /pr-* missing
  // Always sync the engine's tabs into this (possibly reloaded) frontend; the engine only
  // *restores* the saved layout on a genuinely fresh start, so a reload never duplicates.
  send({ type: "load_layout", restore: persistOn() });
  setStatus("ready");
  initUpdater(); // notify (don't auto-install) when a newer GitHub release exists
});
