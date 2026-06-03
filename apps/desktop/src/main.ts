import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
import {
  Command,
  Event as CoreEvent,
  CliKind,
  PanelPayload,
  PrMeta,
  PrRecord,
  PrRef,
  ReviewButton,
  ReviewTier,
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
};
const TERM_FONT: Record<string, string> = {
  phosphor: '"IBM Plex Mono", ui-monospace, monospace',
  instrument: '"JetBrains Mono Variable", ui-monospace, monospace',
};

function currentTheme(): string {
  return document.documentElement.dataset.theme || "phosphor";
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

// ── element handles ─────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
let tabbarEl: HTMLElement;
let terminalsEl: HTMLElement;
let historyEl: HTMLElement;
let statusEl: HTMLElement;
let prInput: HTMLInputElement;
let cliSelect: HTMLSelectElement;
let toolbarEl: HTMLElement;
let copyModalEl: HTMLElement;
let copyTextEl: HTMLTextAreaElement;
let copyStatusEl: HTMLElement;
let stageEl: HTMLElement;
let panelBodyEl: HTMLElement;
let panelTitleEl: HTMLElement;
let panelToggleBtn: HTMLButtonElement;
let autoToggle: HTMLInputElement;
let autoTier: HTMLSelectElement;

// ── core IPC ────────────────────────────────────────────────────────────────
async function send(cmd: Command) {
  try {
    await invoke("pear_command", { command: cmd });
  } catch (e) {
    setStatus(`⚠ ${e}`, true);
  }
}

function selectedCli(): CliKind {
  return cliSelect.value as CliKind;
}

// ── rendering ───────────────────────────────────────────────────────────────
function setStatus(msg: string, warn = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("warn", warn);
}

function renderTabBar() {
  tabbarEl.innerHTML = "";
  for (const t of tabs.values()) {
    const pill = document.createElement("div");
    pill.className = "tab" + (t.id === active ? " active" : "");
    pill.title = t.subtitle || t.title;

    const dot = document.createElement("span");
    dot.className = `dot cli-${t.cli}`;
    pill.appendChild(dot);

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = t.title;
    pill.appendChild(label);

    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "×";
    close.onclick = (e) => {
      e.stopPropagation();
      send({ type: "close_tab", tab: t.id });
    };
    pill.appendChild(close);

    pill.onclick = () => setActive(t.id);
    tabbarEl.appendChild(pill);
  }
  if (tabs.size === 0) {
    const empty = document.createElement("div");
    empty.className = "tab-empty";
    empty.textContent = "no open tabs — open a PR or a shell from the left";
    tabbarEl.appendChild(empty);
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
function openPr(pr: PrRef, cli: CliKind, opts: { fresh?: boolean; session_id?: string } = {}) {
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
      id.textContent = s.id.slice(0, 8);
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

function renderHistory(entries: PrRecord[]) {
  closeSessionPop();
  historyEl.innerHTML = "";
  if (entries.length === 0) {
    const li = document.createElement("li");
    li.className = "history-empty";
    li.textContent = "no reviews yet";
    historyEl.appendChild(li);
    return;
  }
  for (const rec of entries) {
    const li = document.createElement("li");
    li.className = "history-item";
    li.title = `${rec.pr.owner}/${shortLabel(rec.pr)} — ${rec.title}`;

    const main = document.createElement("div");
    main.className = "history-main";

    const ref = document.createElement("span");
    ref.className = "history-ref";
    ref.textContent = shortLabel(rec.pr);
    if (rec.sessions.length > 0) {
      const badge = document.createElement("span");
      badge.className = "history-badge";
      badge.textContent = String(rec.sessions.length);
      badge.title = `${rec.sessions.length} session(s) — click to expand`;
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

    const actions = document.createElement("div");
    actions.className = "history-actions";
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
    li.appendChild(actions);

    historyEl.appendChild(li);
  }
}

// ── terminal lifecycle ──────────────────────────────────────────────────────
function createTabView(id: number, title: string, cli: CliKind, pr: PrRef | null): TabView {
  const el = document.createElement("div");
  el.className = "terminal-host hidden";
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
  for (const t of tabs.values()) {
    t.el.classList.toggle("hidden", t.id !== id);
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
}

function closeTabView(id: number) {
  const v = tabs.get(id);
  if (v) {
    v.term.dispose();
    v.el.remove();
    tabs.delete(id);
  }
  if (active === id) {
    active = null;
    const next = tabs.keys().next();
    if (!next.done) setActive(next.value);
  }
  renderTabBar();
  renderToolbar();
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
    case "tab_opened": {
      createTabView(ev.tab, ev.title, ev.cli, ev.pr);
      setActive(ev.tab);
      setStatus(`opened ${ev.title}`);
      // Auto-review on open (PR tabs only). Delay lets the CLI boot before the
      // slash command is typed (input queues in the PTY regardless).
      if (ev.pr && autoToggle.checked) {
        const tier = autoTier.value as ReviewTier;
        const tab = ev.tab;
        setStatus(`auto-review (${tier}) queued for ${ev.title}`);
        setTimeout(() => send({ type: "start_review", tab, tier }), 2200);
      }
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
      break;
    }
    case "tab_closed": {
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
    case "history": {
      renderHistory(ev.entries);
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
function pressButton(button: ReviewButton) {
  if (active === null) return;
  send({ type: "button", tab: active, button });
}

function saveReview() {
  if (active === null) return;
  const v = tabs.get(active);
  if (!v) return;
  send({ type: "save_review", tab: active, content: terminalText(v.term) });
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

// ── theming ─────────────────────────────────────────────────────────────────
function applyTheme(name: string) {
  document.documentElement.dataset.theme = name;
  localStorage.setItem("pear.theme", name);
  const label = document.getElementById("theme-name");
  if (label) label.textContent = name;
  const theme = XTERM_THEMES[name];
  const font = TERM_FONT[name];
  for (const v of tabs.values()) {
    v.term.options.theme = theme;
    v.term.options.fontFamily = font;
    v.fit.fit();
  }
}

function toggleTheme() {
  applyTheme(currentTheme() === "phosphor" ? "instrument" : "phosphor");
}

// ── review tiers ────────────────────────────────────────────────────────────
function startReview(tier: ReviewTier) {
  if (active === null) return;
  send({ type: "start_review", tab: active, tier });
  setStatus(`launching ${tier} review…`);
}

// ── insight panel ───────────────────────────────────────────────────────────
function refitActive() {
  if (active !== null) tabs.get(active)?.fit.fit();
}

function setPanel(open: boolean) {
  stageEl.classList.toggle("panel-open", open);
  panelToggleBtn.textContent = open ? "Insight ◂" : "Insight ▸";
  requestAnimationFrame(refitActive);
}

function togglePanel() {
  setPanel(!stageEl.classList.contains("panel-open"));
}

function loadPanel() {
  if (active === null) return;
  send({ type: "load_panel", tab: active });
}

function renderPanel(p: PanelPayload) {
  panelTitleEl.textContent = p.title || "Insight";
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

window.addEventListener("DOMContentLoaded", async () => {
  tabbarEl = $("#tabbar");
  terminalsEl = $("#terminals");
  historyEl = $("#history");
  statusEl = $("#status");
  prInput = $("#pr-input");
  cliSelect = $("#cli-select");
  toolbarEl = $("#toolbar");
  copyModalEl = $("#copy-modal");
  copyTextEl = $("#copy-modal-text");
  copyStatusEl = $("#copy-modal-status");
  stageEl = $("#stage");
  panelBodyEl = $("#panel-body");
  panelTitleEl = $("#panel-title");
  panelToggleBtn = $("#panel-toggle");
  autoToggle = $("#auto-review-toggle");
  autoTier = $("#auto-review-tier");

  $("#open-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const pr = parsePrRef(prInput.value);
    if (!pr) {
      setStatus("⚠ expected owner/repo#NUMBER", true);
      return;
    }
    openPr(pr, selectedCli());
    prInput.value = "";
  });

  $("#new-shell").addEventListener("click", () =>
    send({ type: "open_scratch", cli: selectedCli(), cwd: null }),
  );

  $("#history-clear").addEventListener("click", () => send({ type: "clear_history" }));
  $("#history-restore").addEventListener("click", () => send({ type: "restore_history" }));

  // Review-tier launch buttons.
  toolbarEl.querySelectorAll<HTMLButtonElement>("button[data-tier]").forEach((b) =>
    b.addEventListener("click", () => startReview(b.dataset.tier as ReviewTier)),
  );

  // Action buttons. copy_content + save_review are frontend-handled; the rest are
  // slash macros dispatched by the core.
  toolbarEl.querySelectorAll<HTMLButtonElement>("button[data-btn]").forEach((b) => {
    const which = b.dataset.btn!;
    b.addEventListener("click", () => {
      if (which === "copy_content") copyContent();
      else if (which === "save_review") saveReview();
      else pressButton(which as ReviewButton);
    });
  });

  // Insight panel + auto-review.
  panelToggleBtn.addEventListener("click", togglePanel);
  $("#panel-close").addEventListener("click", () => setPanel(false));
  $("#panel-load").addEventListener("click", loadPanel);

  autoToggle.checked = localStorage.getItem("pear.autoReview") === "1";
  autoTier.value = localStorage.getItem("pear.tier") || "standard";
  autoToggle.addEventListener("change", () =>
    localStorage.setItem("pear.autoReview", autoToggle.checked ? "1" : "0"),
  );
  autoTier.addEventListener("change", () => localStorage.setItem("pear.tier", autoTier.value));

  // Theme — Phosphor (default) ↔ Instrument; persisted, restyles terminals live.
  // Deep-link: #instrument / #phosphor forces a theme (handy for previews).
  const hashTheme = location.hash.slice(1);
  const initialTheme = ["phosphor", "instrument"].includes(hashTheme)
    ? hashTheme
    : localStorage.getItem("pear.theme") || "phosphor";
  applyTheme(initialTheme);
  $("#theme-toggle").addEventListener("click", toggleTheme);

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
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!copyModalEl.classList.contains("hidden")) closeCopyModal();
      else closeSessionPop();
    }
  });
  document.addEventListener("click", () => closeSessionPop());

  const refit = () => {
    if (active !== null) tabs.get(active)?.fit.fit();
  };
  window.addEventListener("resize", refit);
  new ResizeObserver(refit).observe(terminalsEl);

  await listen<CoreEvent>("pear:event", (e) => handle(e.payload));

  renderTabBar();
  renderToolbar();
  send({ type: "load_history" });
  setStatus("ready");
});
