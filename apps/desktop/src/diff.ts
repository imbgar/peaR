// Unified-diff parser + renderer for the PR diff panel. Diff code is built with the
// DOM (textContent), so diff content is never injected as HTML. Comment *bodies* are
// markdown, rendered through the sanitizing `renderMarkdown` helper (see markdown.ts).

import { Comment, DiffComment, ReviewThread } from "./protocol";
import { renderMarkdown } from "./markdown";

type LineKind = "add" | "del" | "ctx";
interface DLine {
  kind: LineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}
interface DHunk {
  header: string;
  lines: DLine[];
}
interface DFile {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "renamed" | "modified";
  binary: boolean;
  adds: number;
  dels: number;
  hunks: DHunk[];
}

/** Parse a git/GitHub unified diff into files → hunks → lines. */
export function parseDiff(diff: string): DFile[] {
  const files: DFile[] = [];
  let f: DFile | null = null;
  let h: DHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  const flush = () => {
    if (f) files.push(f);
  };

  for (const ln of diff.split("\n")) {
    if (ln.startsWith("diff --git")) {
      flush();
      const m = ln.match(/^diff --git a\/(.+) b\/(.+)$/);
      f = {
        path: m ? m[2] : ln.slice(11).trim(),
        oldPath: m ? m[1] : null,
        status: "modified",
        binary: false,
        adds: 0,
        dels: 0,
        hunks: [],
      };
      h = null;
      continue;
    }
    if (!f) continue;
    if (ln.startsWith("new file")) {
      f.status = "added";
      continue;
    }
    if (ln.startsWith("deleted file")) {
      f.status = "deleted";
      continue;
    }
    if (ln.startsWith("rename from ")) {
      f.oldPath = ln.slice(12);
      f.status = "renamed";
      continue;
    }
    if (ln.startsWith("rename to ")) {
      f.path = ln.slice(10);
      f.status = "renamed";
      continue;
    }
    if (ln.startsWith("Binary files")) {
      f.binary = true;
      continue;
    }
    if (
      ln.startsWith("--- ") ||
      ln.startsWith("+++ ") ||
      ln.startsWith("index ") ||
      ln.startsWith("similarity ") ||
      ln.startsWith("old mode") ||
      ln.startsWith("new mode") ||
      ln.startsWith("copy ") ||
      ln.startsWith("dissimilarity ")
    ) {
      continue;
    }
    if (ln.startsWith("@@")) {
      const m = ln.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      oldNo = m ? parseInt(m[1], 10) : 0;
      newNo = m ? parseInt(m[2], 10) : 0;
      h = { header: m ? m[3].trim() : ln.replace(/^@+/, "").trim(), lines: [] };
      f.hunks.push(h);
      continue;
    }
    if (!h) continue;
    const c = ln[0];
    if (c === "+") {
      h.lines.push({ kind: "add", text: ln.slice(1), oldNo: null, newNo });
      newNo++;
      f.adds++;
    } else if (c === "-") {
      h.lines.push({ kind: "del", text: ln.slice(1), oldNo, newNo: null });
      oldNo++;
      f.dels++;
    } else if (c === " ") {
      h.lines.push({ kind: "ctx", text: ln.slice(1), oldNo, newNo });
      oldNo++;
      newNo++;
    }
    // "\ No newline at end of file" and stray lines are ignored.
  }
  flush();
  return files;
}

const STATUS_LETTER: Record<string, string> = {
  added: "A",
  deleted: "D",
  renamed: "R",
  modified: "M",
};

/**
 * Render the parsed diff into `container`. When `threads` is provided (full review
 * threads with resolved state + reactions) it drives the inline UI — each anchored
 * line gets a collapsible 💬 bubble that toggles a GitHub-style thread. Otherwise we
 * fall back to the flat `comments` list (rendered open) until threads arrive.
 */
export function renderDiff(
  container: HTMLElement,
  diff: string,
  comments: DiffComment[],
  threads: ReviewThread[] = [],
) {
  container.innerHTML = "";
  const files = parseDiff(diff);
  if (!files.length) {
    const empty = document.createElement("div");
    empty.className = "diff-empty";
    empty.textContent = "No textual changes in this PR's diff.";
    container.appendChild(empty);
    return;
  }

  const useThreads = threads.length > 0;
  // Index inline threads by path → anchored line (current line, else original).
  const threadByPath = new Map<string, Map<number, ReviewThread[]>>();
  for (const t of threads) {
    const line = t.line ?? t.original_line;
    if (line == null) continue;
    const m = threadByPath.get(t.path) ?? new Map<number, ReviewThread[]>();
    (m.get(line) ?? m.set(line, []).get(line)!).push(t);
    threadByPath.set(t.path, m);
  }
  // Fallback: index flat comments by path → new-side line.
  const byPath = new Map<string, Map<number, DiffComment[]>>();
  for (const c of comments) {
    if (c.line == null) continue;
    const m = byPath.get(c.path) ?? new Map<number, DiffComment[]>();
    (m.get(c.line) ?? m.set(c.line, []).get(c.line)!).push(c);
    byPath.set(c.path, m);
  }

  const cmtCount = useThreads
    ? threads.reduce((s, t) => s + t.comments.length, 0)
    : comments.length;
  const totAdd = files.reduce((s, f) => s + f.adds, 0);
  const totDel = files.reduce((s, f) => s + f.dels, 0);
  const summary = document.createElement("div");
  summary.className = "diff-summary";
  const fc = document.createElement("span");
  fc.className = "diff-fcount";
  fc.textContent = `${files.length} file${files.length > 1 ? "s" : ""} changed`;
  const a = document.createElement("span");
  a.className = "diff-adds";
  a.textContent = `+${totAdd}`;
  const d = document.createElement("span");
  d.className = "diff-dels";
  d.textContent = `−${totDel}`;
  if (cmtCount) {
    const cc = document.createElement("span");
    cc.className = "diff-ccount";
    cc.textContent = `${cmtCount} comment${cmtCount > 1 ? "s" : ""}`;
    summary.append(fc, a, d, cc);
  } else {
    summary.append(fc, a, d);
  }
  container.appendChild(summary);

  for (const f of files) {
    const card = document.createElement("div");
    card.className = "diff-file";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "diff-file-head";
    const chev = document.createElement("span");
    chev.className = "diff-chev";
    chev.textContent = "▾";
    const badge = document.createElement("span");
    badge.className = `diff-status s-${f.status}`;
    badge.textContent = STATUS_LETTER[f.status] ?? "M";
    badge.title = f.status;
    const path = document.createElement("span");
    path.className = "diff-path";
    path.textContent =
      f.status === "renamed" && f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
    const adds = document.createElement("span");
    adds.className = "diff-adds";
    adds.textContent = `+${f.adds}`;
    const dels = document.createElement("span");
    dels.className = "diff-dels";
    dels.textContent = `−${f.dels}`;
    head.append(chev, badge, path, adds, dels);
    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "diff-body";
    if (f.binary) {
      const b = document.createElement("div");
      b.className = "diff-binary";
      b.textContent = "Binary file — not shown";
      body.appendChild(b);
    }
    const threadMap = threadByPath.get(f.path);
    const cmtMap = byPath.get(f.path);
    for (const hunk of f.hunks) {
      const hh = document.createElement("div");
      hh.className = "diff-hunk";
      hh.textContent = hunk.header ? `┄ ${hunk.header}` : "┄";
      body.appendChild(hh);
      for (const line of hunk.lines) {
        const row = document.createElement("div");
        row.className = `diff-row r-${line.kind}`;
        // Anchor data for commenting: a row maps to a side+line (RIGHT/newNo for
        // add/ctx, LEFT/oldNo for del).
        row.dataset.path = f.path;
        row.dataset.kind = line.kind;
        if (line.newNo != null) row.dataset.newno = String(line.newNo);
        if (line.oldNo != null) row.dataset.oldno = String(line.oldNo);
        const go = document.createElement("span");
        go.className = "diff-gutter";
        go.textContent = line.oldNo?.toString() ?? "";
        const gn = document.createElement("span");
        gn.className = "diff-gutter";
        gn.textContent = line.newNo?.toString() ?? "";
        const sign = document.createElement("span");
        sign.className = "diff-sign";
        sign.textContent = line.kind === "add" ? "+" : line.kind === "del" ? "−" : "";
        const code = document.createElement("span");
        code.className = "diff-code";
        code.textContent = line.text.length ? line.text : " ";
        row.append(go, gn, sign, code);
        // Inline threads (collapsible, GitHub-style): render a 💬 bubble on the line
        // that toggles the thread, collapsed by default.
        const lineThreads = line.newNo != null ? threadMap?.get(line.newNo) : undefined;
        if (lineThreads) {
          row.classList.add("has-cmt");
          const blocks: HTMLElement[] = [];
          for (const t of lineThreads) {
            const block = renderThread(t);
            const n = t.comments.length;
            const bubble = document.createElement("button");
            bubble.type = "button";
            bubble.className = "diff-bubble" + (t.is_resolved ? " resolved" : "");
            const setLabel = () =>
              (bubble.textContent = `💬 ${n}${block.classList.contains("hidden") ? " ▸" : " ▾"}`);
            bubble.addEventListener("click", () => {
              block.classList.toggle("hidden");
              setLabel();
            });
            setLabel();
            code.appendChild(bubble);
            blocks.push(block);
          }
          body.appendChild(row);
          for (const b of blocks) body.appendChild(b);
          continue;
        }
        body.appendChild(row);
        // Fallback (pre-threads): render flat comments open under the line.
        if (line.newNo != null && cmtMap?.has(line.newNo)) {
          for (const c of cmtMap.get(line.newNo)!) body.appendChild(renderFlatComment(c));
        }
      }
    }
    card.appendChild(body);
    head.addEventListener("click", () => card.classList.toggle("collapsed"));
    container.appendChild(card);
  }
  wireLineSelection(container);
}

/** A short relative time ("2h", "3d", "5mo") from an RFC3339 timestamp. */
export function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.floor(d)}d`;
  const mo = d / 30;
  if (mo < 12) return `${Math.floor(mo)}mo`;
  return `${Math.floor(mo / 12)}y`;
}

/**
 * Render one comment — author, relative time, body, and reaction rollups. Shared
 * by the inline diff threads and the conversation panel (same `Comment` shape).
 * The body is GitHub markdown, rendered via the sanitizing `renderMarkdown`.
 */
export function commentEl(c: Comment): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cv-cmt";
  const top = document.createElement("div");
  top.className = "cv-top";
  const who = document.createElement("span");
  who.className = "cv-who" + (c.mine ? " me" : "");
  who.textContent = c.author;
  const when = document.createElement("span");
  when.className = "cv-when";
  when.textContent = relTime(c.created_at);
  top.append(who);
  if (c.review_state) top.appendChild(reviewBadge(c.review_state));
  top.appendChild(when);
  wrap.append(top);
  if (c.body.trim()) {
    const body = document.createElement("div");
    body.className = "cv-body markdown";
    renderMarkdown(body, c.body);
    wrap.appendChild(body);
  }
  wrap.appendChild(reactionRow(c));
  return wrap;
}

const REVIEW_STATE: Record<string, { label: string; cls: string }> = {
  APPROVED: { label: "approved", cls: "ok" },
  CHANGES_REQUESTED: { label: "requested changes", cls: "warn" },
  COMMENTED: { label: "reviewed", cls: "" },
  DISMISSED: { label: "dismissed", cls: "dim" },
};

function reviewBadge(state: string): HTMLElement {
  const meta = REVIEW_STATE[state] ?? { label: state.toLowerCase().replace(/_/g, " "), cls: "" };
  const b = document.createElement("span");
  b.className = "cv-review-state" + (meta.cls ? ` ${meta.cls}` : "");
  b.textContent = meta.label;
  return b;
}

// The eight reactions GitHub supports, in its display order (emoji ↔ enum).
const REACTIONS: ReadonlyArray<{ emoji: string; content: string }> = [
  { emoji: "👍", content: "THUMBS_UP" },
  { emoji: "👎", content: "THUMBS_DOWN" },
  { emoji: "😄", content: "LAUGH" },
  { emoji: "🎉", content: "HOORAY" },
  { emoji: "😕", content: "CONFUSED" },
  { emoji: "❤️", content: "HEART" },
  { emoji: "🚀", content: "ROCKET" },
  { emoji: "👀", content: "EYES" },
];

// Set once by the app (main.ts) — toggles a reaction on a comment node id.
type ReactFn = (subjectId: string, content: string, add: boolean) => void;
let onReact: ReactFn | null = null;
export function setReactionHandler(fn: ReactFn) {
  onReact = fn;
}

// Close any open reaction picker when clicking elsewhere (the toggles below
// stopPropagation, so opening one doesn't immediately close it).
document.addEventListener("click", () => {
  document.querySelectorAll(".cv-picker:not(.hidden)").forEach((p) => p.classList.add("hidden"));
});

function reactionRow(c: Comment): HTMLElement {
  const row = document.createElement("div");
  row.className = "cv-react";
  for (const r of c.reactions) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "cv-pill" + (r.me ? " me" : "");
    pill.textContent = `${r.emoji} ${r.count}`;
    pill.title = r.me ? "Remove your reaction" : "React";
    pill.addEventListener("click", () => onReact?.(c.id, r.content, !r.me));
    row.appendChild(pill);
  }
  // "+" opens a small picker of the eight reactions; clicking one toggles it.
  const add = document.createElement("button");
  add.type = "button";
  add.className = "cv-addreact";
  add.textContent = "＋";
  add.title = "Add reaction";
  const picker = document.createElement("div");
  picker.className = "cv-picker hidden";
  for (const opt of REACTIONS) {
    const mine = c.reactions.find((x) => x.content === opt.content)?.me ?? false;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cv-pick" + (mine ? " me" : "");
    b.textContent = opt.emoji;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      picker.classList.add("hidden");
      onReact?.(c.id, opt.content, !mine);
    });
    picker.appendChild(b);
  }
  add.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasHidden = picker.classList.contains("hidden");
    document.querySelectorAll(".cv-picker:not(.hidden)").forEach((p) => p.classList.add("hidden"));
    picker.classList.toggle("hidden", !wasHidden);
  });
  const wrap = document.createElement("span");
  wrap.className = "cv-react-add";
  wrap.append(add, picker);
  row.appendChild(wrap);
  return row;
}

/** An inline review thread block (collapsed by default via the `hidden` class). */
function renderThread(t: ReviewThread): HTMLElement {
  const block = document.createElement("div");
  block.className = "diff-thread hidden" + (t.is_resolved ? " resolved" : "");
  if (t.is_resolved || t.is_outdated) {
    const tag = document.createElement("div");
    tag.className = "dt-state";
    tag.textContent = [t.is_resolved ? "✓ resolved" : "", t.is_outdated ? "outdated" : ""]
      .filter(Boolean)
      .join(" · ");
    block.appendChild(tag);
  }
  for (const c of t.comments) block.appendChild(commentEl(c));
  if (!t.is_resolved && t.id) block.appendChild(replyBox(t.id));
  return block;
}

/** A compact reply composer for an existing inline thread. */
function replyBox(threadId: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "dt-reply";
  const ta = document.createElement("textarea");
  ta.placeholder = "Reply…";
  ta.rows = 1;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dc-btn primary";
  btn.textContent = "Reply";
  const send = () => {
    const body = ta.value.trim();
    if (!body || !onReply) return;
    ta.disabled = true;
    btn.disabled = true;
    btn.textContent = "Posting…";
    onReply(threadId, body);
  };
  btn.addEventListener("click", send);
  // ⌘/Ctrl+Enter sends; plain Enter keeps newlines for multi-line replies.
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
  });
  wrap.append(ta, btn);
  return wrap;
}

/** Fallback inline render of a flat REST review comment (before threads arrive). */
function renderFlatComment(c: DiffComment): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "diff-comment";
  const who = document.createElement("div");
  who.className = "dc-author";
  who.textContent = `@${c.author}`;
  const body = document.createElement("div");
  body.className = "dc-body";
  body.textContent = c.body;
  wrap.append(who, body);
  return wrap;
}

// ── inline comment creation (line selection → bubble → composer) ──────────────
export interface NewComment {
  mode: "single" | "review";
  body: string;
  path: string;
  line: number;
  side: string;
  start_line?: number;
  start_side?: string;
}
type CreateFn = (c: NewComment) => void;
type ReplyFn = (threadId: string, body: string) => void;
let onCreate: CreateFn | null = null;
let onReply: ReplyFn | null = null;
let pendingReviewId: string | null = null;
export function setCreateHandler(fn: CreateFn) {
  onCreate = fn;
}
export function setReplyHandler(fn: ReplyFn) {
  onReply = fn;
}
/** The viewer's pending review id (drives the composer's review button label). */
export function setPendingReview(id: string | null) {
  pendingReviewId = id;
}

/** A diff row's comment anchor: the side + line GitHub expects for that row. */
function rowAnchor(row: HTMLElement): { side: string; line: number } | null {
  const kind = row.dataset.kind;
  if (kind === "del") {
    const l = row.dataset.oldno;
    return l ? { side: "LEFT", line: parseInt(l, 10) } : null;
  }
  const l = row.dataset.newno;
  return l ? { side: "RIGHT", line: parseInt(l, 10) } : null;
}

// Active selection within a single file body.
interface LineSelection {
  body: HTMLElement;
  rows: HTMLElement[]; // contiguous, in DOM order
  anchor: number; // index into the body's row list where the drag began
}
let sel: LineSelection | null = null;

function clearSelection() {
  if (!sel) return;
  for (const r of sel.body.querySelectorAll(".diff-row.sel")) r.classList.remove("sel");
  sel.body.querySelector(".diff-bubble-new")?.remove();
  sel.body.querySelector(".diff-composer")?.remove();
  sel = null;
}

function bodyRows(body: HTMLElement): HTMLElement[] {
  return Array.from(body.querySelectorAll<HTMLElement>(".diff-row"));
}

function applySelection(body: HTMLElement, a: number, b: number) {
  const rows = bodyRows(body);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const chosen: HTMLElement[] = [];
  rows.forEach((r, i) => {
    const on = i >= lo && i <= hi;
    r.classList.toggle("sel", on);
    if (on) chosen.push(r);
  });
  sel = { body, rows: chosen, anchor: a };
}

/** Show the comment bubble at the left of the first selected row. */
function showBubble() {
  if (!sel || !sel.rows.length) return;
  sel.body.querySelector(".diff-bubble-new")?.remove();
  const first = sel.rows[0];
  const bubble = document.createElement("button");
  bubble.type = "button";
  bubble.className = "diff-bubble-new";
  bubble.textContent = "💬";
  bubble.title = "Comment on the selected lines";
  bubble.style.top = `${first.offsetTop}px`;
  bubble.addEventListener("click", (e) => {
    e.stopPropagation();
    openComposer();
  });
  sel.body.appendChild(bubble);
}

/** Insert the composer block right after the last selected row. */
function openComposer() {
  if (!sel || !sel.rows.length) return;
  sel.body.querySelector(".diff-composer")?.remove();
  const last = sel.rows[sel.rows.length - 1];
  const first = sel.rows[0];
  const startA = rowAnchor(first);
  const endA = rowAnchor(last);
  if (!endA) return;

  const box = document.createElement("div");
  box.className = "diff-composer";
  const head = document.createElement("div");
  head.className = "dc-head";
  head.textContent =
    sel.rows.length > 1 && startA
      ? `Commenting on lines ${startA.line}–${endA.line}`
      : `Commenting on line ${endA.line}`;
  const ta = document.createElement("textarea");
  ta.placeholder = "Leave a comment (markdown supported)…";
  ta.rows = 3;
  const actions = document.createElement("div");
  actions.className = "dc-actions";

  const submit = (mode: "single" | "review") => {
    const body = ta.value.trim();
    if (!body || !onCreate) return;
    const nc: NewComment = { mode, body, path: first.dataset.path!, line: endA.line, side: endA.side };
    if (sel!.rows.length > 1 && startA) {
      nc.start_line = startA.line;
      nc.start_side = startA.side;
    }
    box.querySelectorAll("button").forEach((b) => (b.disabled = true));
    ta.disabled = true;
    head.textContent = "Posting…";
    onCreate(nc);
  };

  const single = document.createElement("button");
  single.type = "button";
  single.className = "dc-btn primary";
  single.textContent = "Add single comment";
  single.addEventListener("click", () => submit("single"));
  const review = document.createElement("button");
  review.type = "button";
  review.className = "dc-btn";
  review.textContent = pendingReviewId ? "Add review comment" : "Start a review";
  review.addEventListener("click", () => submit("review"));
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "dc-btn ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => clearSelection());

  actions.append(single, review, cancel);
  box.append(head, ta, actions);
  last.after(box);
  ta.focus();
}

/** Wire gutter-drag + shift-click line selection on a freshly rendered diff. */
function wireLineSelection(container: HTMLElement) {
  sel = null; // DOM was rebuilt; drop any stale selection
  let dragging: HTMLElement | null = null; // the body being dragged within

  const rowFromPoint = (x: number, y: number, body: HTMLElement): number => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(".diff-row");
    if (!el || el.parentElement !== body) return -1;
    return bodyRows(body).indexOf(el);
  };

  container.addEventListener("pointerdown", (e) => {
    const gutter = (e.target as HTMLElement).closest<HTMLElement>(".diff-gutter");
    if (!gutter) return; // only the line-number gutter is the selection handle
    const row = gutter.closest<HTMLElement>(".diff-row");
    const body = row?.parentElement as HTMLElement | undefined;
    if (!row || !body || !rowAnchor(row)) return;
    e.preventDefault();
    const idx = bodyRows(body).indexOf(row);

    // Shift-click extends the current selection (if it's in this body) instead of dragging.
    if (e.shiftKey && sel && sel.body === body) {
      applySelection(body, sel.anchor, idx);
      showBubble();
      return;
    }
    clearSelection();
    applySelection(body, idx, idx);
    dragging = body;
    body.classList.add("selecting");
  });

  window.addEventListener("pointermove", (e) => {
    if (!dragging || !sel) return;
    const idx = rowFromPoint(e.clientX, e.clientY, dragging);
    if (idx >= 0) applySelection(dragging, sel.anchor, idx);
  });

  window.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging.classList.remove("selecting");
    dragging = null;
    showBubble();
  });
}

// Clear a selection on Escape, or on a click that isn't part of the diff comment UI.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") clearSelection();
});
document.addEventListener("pointerdown", (e) => {
  const t = e.target as HTMLElement;
  if (
    sel &&
    !t.closest(".diff-composer") &&
    !t.closest(".diff-bubble-new") &&
    !t.closest(".diff-gutter")
  ) {
    clearSelection();
  }
});
