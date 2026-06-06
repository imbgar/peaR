// Update *notifications* (no in-app install — deliberately). On launch (and every 6h)
// peaR checks the latest GitHub release against the running version; if a newer one
// exists it shows a dismissable card with the changelog and a "View release" link
// (opens the download page), plus snooze buttons. This needs ZERO signing infra — it
// never replaces the bundle, so there's no minisign key, no Gatekeeper swap, nothing
// to notarize. Off Tauri (plain browser) every call no-ops.

import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

const REPO = "imbgar/peaR";
const RELEASES = `https://github.com/${REPO}/releases`;
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const SNOOZE_KEY = "pear.update.snoozeUntil"; // ms timestamp
const SKIP_KEY = "pear.update.skip"; // a version string the user chose "Never" on

interface Release {
  version: string; // semver without the leading "v"
  notes: string;
  url: string;
}

/** Compare dotted numeric versions. >0 if a>b, <0 if a<b, 0 if equal. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function fetchLatest(): Promise<Release | null> {
  const res = await fetch(API_LATEST, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) return null;
  const j = await res.json();
  const tag: string = j.tag_name ?? "";
  return {
    version: tag.replace(/^v/, ""),
    notes: (j.body ?? "").trim(),
    url: j.html_url || RELEASES,
  };
}

function snoozed(): boolean {
  const until = parseInt(localStorage.getItem(SNOOZE_KEY) ?? "0", 10);
  return Date.now() < until;
}
function snooze(ms: number) {
  localStorage.setItem(SNOOZE_KEY, String(Date.now() + ms));
}

/** Render the update notification card (bottom-right, above the status bar). */
function showCard(rel: Release) {
  document.getElementById("update-card")?.remove();
  const card = document.createElement("div");
  card.id = "update-card";
  card.className = "update-card";

  const head = document.createElement("div");
  head.className = "uc-head";
  const title = document.createElement("span");
  title.className = "uc-title";
  title.textContent = `⬆ peaR v${rel.version} available`;
  const x = document.createElement("button");
  x.className = "uc-x";
  x.textContent = "×";
  x.title = "Dismiss (you'll be reminded next launch)";
  x.addEventListener("click", () => card.remove());
  head.append(title, x);

  const notes = document.createElement("div");
  notes.className = "uc-notes";
  // Plain text only — release notes are shown verbatim, never as HTML.
  notes.textContent = rel.notes || "A new version is available.";

  const view = document.createElement("button");
  view.className = "uc-view";
  view.textContent = "View release ↗";
  view.addEventListener("click", () => {
    openUrl(rel.url).catch(() => {});
    card.remove();
  });

  const snoozeRow = document.createElement("div");
  snoozeRow.className = "uc-snooze";
  const DAY = 86_400_000;
  const mk = (label: string, fn: () => void) => {
    const b = document.createElement("button");
    b.className = "uc-snz";
    b.textContent = label;
    b.addEventListener("click", () => {
      fn();
      card.remove();
    });
    return b;
  };
  snoozeRow.append(
    mk("Tomorrow", () => snooze(DAY)),
    mk("In a week", () => snooze(7 * DAY)),
    // "Never" = skip *this* version; a genuinely newer release still notifies.
    mk("Never", () => localStorage.setItem(SKIP_KEY, rel.version)),
  );

  card.append(head, notes, view, snoozeRow);
  document.body.appendChild(card);
}

/** Check once; show the card if a newer, non-snoozed, non-skipped release exists. */
export async function checkForUpdate() {
  if (snoozed()) return;
  try {
    const [current, rel] = await Promise.all([getVersion(), fetchLatest()]);
    if (!rel || !rel.version) return;
    if (cmpVersion(rel.version, current) <= 0) return; // up to date
    if (localStorage.getItem(SKIP_KEY) === rel.version) return; // user chose "Never" on it
    showCard(rel);
  } catch {
    // Not under Tauri, offline, rate-limited, or private repo — silently ignore.
  }
}

/** Start update checks: once shortly after launch, then every 6 hours. */
export function initUpdater() {
  setTimeout(checkForUpdate, 4000);
  setInterval(checkForUpdate, 6 * 60 * 60 * 1000);
}
