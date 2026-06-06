// In-app auto-update: poll the GitHub-hosted updater manifest, and when a newer
// version is available surface a status-bar pill (changelog on hover) that
// downloads + installs the new bundle in place and relaunches. macOS-only; in a
// plain browser (no Tauri) the imports throw, so every call is guarded.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

let pill: HTMLButtonElement | null = null;
let pending: Update | null = null;
let installing = false;

function ensurePill(): HTMLButtonElement {
  if (pill) return pill;
  const el = document.createElement("button");
  el.id = "update-pill";
  el.className = "update-pill hidden";
  el.type = "button";
  document.getElementById("statusbar")?.insertBefore(el, document.getElementById("status"));
  pill = el;
  return el;
}

function setStatusLine(msg: string) {
  const s = document.getElementById("status");
  if (s) s.textContent = msg;
}

async function install() {
  if (!pending || installing) return;
  installing = true;
  const p = ensurePill();
  let total = 0;
  let got = 0;
  try {
    await pending.downloadAndInstall((ev) => {
      if (ev.event === "Started") {
        total = ev.data.contentLength ?? 0;
        p.textContent = "⬇ downloading…";
      } else if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        p.textContent = total ? `⬇ ${Math.round((got / total) * 100)}%` : "⬇ downloading…";
      } else if (ev.event === "Finished") {
        p.textContent = "↻ restarting…";
      }
    });
    await relaunch();
  } catch (e) {
    installing = false;
    p.textContent = `⬆ v${pending.version}`;
    setStatusLine(`update failed: ${e}`);
  }
}

/** Show the "update available" pill with the version + changelog (manifest notes). */
function showAvailable(update: Update) {
  pending = update;
  const p = ensurePill();
  p.textContent = `⬆ v${update.version}`;
  // The manifest `body` carries the release notes / CHANGELOG section.
  const notes = (update.body ?? "").trim();
  p.title = notes
    ? `peaR ${update.version} is available — click to install & relaunch\n\n${notes.slice(0, 600)}`
    : `peaR ${update.version} is available — click to install & relaunch`;
  p.classList.remove("hidden");
  p.onclick = install;
}

/** Check once for an update (no-op off Tauri / on error). */
export async function checkForUpdate() {
  try {
    const update = await check();
    if (update) showAvailable(update);
  } catch {
    // Not running under Tauri, offline, or no manifest — silently ignore.
  }
}

/** Start update checks: once shortly after launch, then every 6 hours. */
export function initUpdater() {
  setTimeout(checkForUpdate, 4000);
  setInterval(checkForUpdate, 6 * 60 * 60 * 1000);
}
