---
description: Dispatch creation of a narrated walk-through video of the PR review.
argument-hint: "[optional: 'purpose' | 'review' | 'both' — default both]"
---

Produce a narrated, animated MP4 walk-through of this pull request using the
**video-explainer** skill (~/.claude/skills/video-explainer/SKILL.md).

Steps:
1. Assemble the script content first (do NOT narrate generic filler):
   - **Purpose** — what the PR does and why (from `gh pr view`).
   - **Key changes** — the 3–6 most important moves, with the kind of before/after that
     reads well on screen.
   - **Review findings** — if a saved review exists for this PR, fold in its top blocking
     items; otherwise do a quick distill pass. ($ARGUMENTS controls scope: purpose / review / both.)
2. Invoke the video-explainer skill with that script, dark educational theme, animated
   diffs/diagrams where they clarify a change.
3. Save the resulting MP4 into this PR's review directory and print the output path.

Keep the runtime tight (aim 2–4 min). This is a dispatch action — kick it off and report
where the file will land; it runs to completion in the background of the agent session.
