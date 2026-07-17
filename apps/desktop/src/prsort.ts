// prsort.ts — PR list sorting shared across the Teams / Mine / Queue / Tree views.
//
// The "smart" default ranks PRs by how likely the viewer needs to ACT on them (heuristic
// co-designed with codex): your-review-needed > you-must-revise > waiting-on-reviewers >
// not-your-turn > approved > draft > closed — with a staleness nudge so an old actionable PR
// isn't buried under noisy fresh ones, then recency, then PR number as the final tiebreaker.
// The manual options are literal single-key orders (no product judgment).

import type { PrStatus } from "./protocol";

export type PrSortKey =
  | "smart"
  | "recent"
  | "oldest"
  | "newest_pr"
  | "oldest_pr"
  | "most_commented"
  | "most_commits"
  | "review_status";

export const PR_SORTS: ReadonlyArray<{ key: PrSortKey; label: string }> = [
  { key: "smart", label: "Smart — needs action" },
  { key: "recent", label: "Recently updated" },
  { key: "oldest", label: "Oldest updated" },
  { key: "newest_pr", label: "Newest PR" },
  { key: "oldest_pr", label: "Oldest PR" },
  { key: "most_commented", label: "Most commented" },
  { key: "most_commits", label: "Most commits" },
  { key: "review_status", label: "Review status" },
];

export const DEFAULT_PR_SORT: PrSortKey = "smart";

export function isPrSortKey(v: unknown): v is PrSortKey {
  return typeof v === "string" && PR_SORTS.some((s) => s.key === v);
}

const ts = (s: string): number => Date.parse(s || "") || 0;

/** Lower = more action-worthy (sorts toward the top). `mine` = the viewer authored the PR. */
function actionBucket(s: PrStatus, mine: boolean): number {
  if (s.state !== "open") return 90; // closed / merged sink to the bottom
  if (s.draft) return 70; // drafts below ready PRs, but still visible
  const rd = s.review_decision;
  if (!mine && rd === "REVIEW_REQUIRED") return 0; // a teammate needs YOUR review
  if (mine && rd === "CHANGES_REQUESTED") return 1; // you must revise your PR
  if (mine && rd === "REVIEW_REQUIRED") return 10; // your PR waiting on reviewers
  if (!mine && rd === "CHANGES_REQUESTED") return 20; // teammate's turn, not yours
  if (mine && rd === "APPROVED") return 30; // your PR likely mergeable
  if (!mine && rd === "APPROVED") return 40;
  return mine ? 50 : 45; // unknown / no review state
}

/** Coarse staleness so an old actionable PR rises *within* its action bucket (don't forget it). */
function staleBucket(updatedAt: string, now: number): number {
  const h = (now - ts(updatedAt)) / 3_600_000;
  if (!isFinite(h)) return 0;
  if (h >= 72) return 3;
  if (h >= 24) return 2;
  if (h >= 4) return 1;
  return 0;
}

/** Review-status rank for the manual "Review status" sort (most-urgent first). */
function reviewRank(s: PrStatus): number {
  if (s.state !== "open") return 5;
  if (s.draft) return 4;
  switch (s.review_decision) {
    case "CHANGES_REQUESTED":
      return 0;
    case "REVIEW_REQUIRED":
      return 1;
    case "APPROVED":
      return 3;
    default:
      return 2; // null / unknown
  }
}

/** Compare two PRs under `key`. `meLogin` decides mine-vs-teammate for the smart sort; `now` is
 *  the current epoch-ms (passed in so the comparator stays a pure function). */
export function comparePrStatus(
  a: PrStatus,
  b: PrStatus,
  key: PrSortKey,
  meLogin: string | null,
  now: number,
): number {
  switch (key) {
    case "recent":
      return ts(b.updated_at) - ts(a.updated_at);
    case "oldest":
      return ts(a.updated_at) - ts(b.updated_at);
    case "newest_pr":
      return b.pr.number - a.pr.number;
    case "oldest_pr":
      return a.pr.number - b.pr.number;
    case "most_commented":
      return b.comments - a.comments || ts(b.updated_at) - ts(a.updated_at);
    case "most_commits":
      return b.commits - a.commits || ts(b.updated_at) - ts(a.updated_at);
    case "review_status":
      return reviewRank(a) - reviewRank(b) || ts(b.updated_at) - ts(a.updated_at);
    case "smart":
    default: {
      const me = meLogin ? meLogin.toLowerCase() : null;
      const mineA = !!me && a.author.toLowerCase() === me;
      const mineB = !!me && b.author.toLowerCase() === me;
      const ba = actionBucket(a, mineA);
      const bb = actionBucket(b, mineB);
      if (ba !== bb) return ba - bb; // primary: action bucket
      const sa = staleBucket(a.updated_at, now);
      const sb = staleBucket(b.updated_at, now);
      if (sa !== sb) return sb - sa; // staler rises within the same bucket
      const ua = ts(a.updated_at);
      const ub = ts(b.updated_at);
      if (ua !== ub) return ub - ua; // then most-recent activity
      return b.pr.number - a.pr.number; // stable final tiebreaker
    }
  }
}

/** Sort a copy of `list` (never mutates the input). */
export function sortPrStatuses(
  list: PrStatus[],
  key: PrSortKey,
  meLogin: string | null,
  now: number,
): PrStatus[] {
  return [...list].sort((a, b) => comparePrStatus(a, b, key, meLogin, now));
}
