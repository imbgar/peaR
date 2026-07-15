// The review DECK — flip through one finding card at a time and build your review by
// hitting "Add to review" on the keepers. The compiled review (verdict header + the
// picked findings) copies as markdown via onExport. Shares the journey's selection
// store (same localStorage key) and export format, so deck picks and journey picks
// are one set — flip in whichever mode suits.
//
// Keys: ←/→ flip · Space/Enter toggle add · c compile · Esc exit.

import type { RdFinding, ReviewDoc } from "./protocol";

export interface DeckOpts {
  onJump: (path: string, line: number | null) => void;
  onExport: (markdown: string, count: number) => void;
  onExit: () => void;
}

export interface DeckHandle {
  exit: () => void;
}

const SEV_RANK: Record<string, number> = {
  blocker: 0,
  fix_before_merge: 1,
  follow_up: 2,
  take_or_leave: 3,
};

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/** The compiled-review markdown — IDENTICAL format to the journey's export. */
function draftMarkdown(doc: ReviewDoc, selected: Set<string>): { md: string; count: number } {
  const picks = doc.findings.filter((f) => selected.has(f.id));
  const v = doc.verdict.per_subject[0];
  const lines = [
    `## Review — ${doc.subjects.map((s) => s.ref).join(" + ")}`,
    ``,
    `**Verdict:** ${v?.state.replace(/_/g, " ") ?? ""}${v?.justification ? ` — ${v.justification}` : ""}`,
    ``,
    ...picks.map((f) => {
      const at = f.anchor ? ` (\`${f.anchor.path}${f.anchor.line ? `:${f.anchor.line}` : ""}\`)` : "";
      const why = f.rule?.why ? `\n  - why: ${f.rule.why}` : "";
      return `- **[${f.severity.replace(/_/g, " ")}]** ${f.title}${at}${f.evidence ? `\n  - ${f.evidence}` : ""}${why}`;
    }),
  ];
  return { md: lines.join("\n"), count: picks.length };
}

export function startDeck(host: HTMLElement, doc: ReviewDoc, opts: DeckOpts): DeckHandle {
  // Gate-first order (the research finding: blocking items lead), stable within a tier.
  const findings = [...doc.findings].sort(
    (a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9),
  );
  const selKey = `pear.journey.sel.${doc.subjects.map((s) => s.ref).join("+")}`;
  const selected = new Set<string>(JSON.parse(localStorage.getItem(selKey) ?? "[]") as string[]);
  const persist = () => localStorage.setItem(selKey, JSON.stringify([...selected]));
  let idx = 0;

  const root = document.createElement("div");
  root.className = "deck";
  host.appendChild(root);

  const render = () => {
    if (!findings.length) {
      root.innerHTML = `<div class="deck-empty">no findings in this review 🎉<button class="deck-x close-x">×</button></div>`;
      root.querySelector(".deck-x")?.addEventListener("click", exit);
      return;
    }
    const f = findings[idx];
    const on = selected.has(f.id);
    const conf = Math.round((f.confidence ?? 0) * 100);
    root.innerHTML = `
      <div class="deck-hud">
        <span class="deck-pos">${idx + 1} / ${findings.length}</span>
        <span class="deck-picked">${selected.size} in review</span>
        <button class="deck-compile" title="Copy the compiled review draft (c)">📋 compile review${selected.size ? ` (${selected.size})` : ""}</button>
        <button class="deck-x close-x" title="Exit the deck (Esc)">×</button>
      </div>
      <div class="deck-card sev-${esc(f.severity)}">
        <div class="dc-top">
          <span class="dc-id">${esc(f.id)}</span>
          <span class="dc-type ft-${esc(f.type)}">${esc(f.type.replace(/_/g, " "))}</span>
          <span class="dc-sev">${esc(f.severity.replace(/_/g, " "))}</span>
          <span class="dc-conf" title="engine confidence">${conf}%</span>
        </div>
        <div class="dc-title">${esc(f.title)}</div>
        ${f.evidence ? `<div class="dc-evidence">${esc(f.evidence)}</div>` : ""}
        ${f.rule?.why ? `<div class="dc-why"><b>why this matters</b> ${esc(f.rule.why)}</div>` : ""}
        ${f.suggestion?.patch ? `<pre class="dc-patch">${esc(f.suggestion.patch)}</pre>` : ""}
        ${
          f.anchor
            ? `<button class="dc-anchor" title="Jump the diff here">${esc(f.anchor.path)}${f.anchor.line ? `:${f.anchor.line}` : ""} ↗</button>`
            : ""
        }
        <button class="dc-add${on ? " on" : ""}">${on ? "✓ in your review — click to remove" : "＋ add to review"}</button>
      </div>
      <div class="deck-nav">
        <button class="deck-prev" ${idx === 0 ? "disabled" : ""}>← prev</button>
        <div class="deck-dots">${findings
          .map(
            (x, i) =>
              `<span class="dd${i === idx ? " cur" : ""}${selected.has(x.id) ? " sel" : ""}" data-i="${i}"></span>`,
          )
          .join("")}</div>
        <button class="deck-next" ${idx === findings.length - 1 ? "disabled" : ""}>next →</button>
      </div>`;
    root.querySelector(".deck-x")?.addEventListener("click", exit);
    root.querySelector(".deck-prev")?.addEventListener("click", () => go(idx - 1));
    root.querySelector(".deck-next")?.addEventListener("click", () => go(idx + 1));
    root.querySelector(".dc-add")?.addEventListener("click", toggle);
    root.querySelector(".deck-compile")?.addEventListener("click", compile);
    root.querySelector(".dc-anchor")?.addEventListener("click", () => {
      if (f.anchor) opts.onJump(f.anchor.path, f.anchor.line ?? null);
    });
    root.querySelectorAll<HTMLElement>(".deck-dots .dd").forEach((d) =>
      d.addEventListener("click", () => go(parseInt(d.dataset.i || "0", 10))),
    );
  };

  const go = (i: number) => {
    idx = Math.max(0, Math.min(findings.length - 1, i));
    render();
  };
  const toggle = () => {
    const f = findings[idx];
    if (selected.has(f.id)) selected.delete(f.id);
    else selected.add(f.id);
    persist();
    render();
  };
  const compile = () => {
    const { md, count } = draftMarkdown(doc, selected);
    opts.onExport(md, count);
  };

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === "INPUT") return;
    if (e.key === "ArrowRight") go(idx + 1);
    else if (e.key === "ArrowLeft") go(idx - 1);
    else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggle();
    } else if (e.key === "c" || e.key === "C") compile();
    else if (e.key === "Escape") exit();
  };
  document.addEventListener("keydown", onKey);

  const exit = () => {
    document.removeEventListener("keydown", onKey);
    root.remove();
    opts.onExit();
  };

  render();
  return { exit };
}

export type { RdFinding };
