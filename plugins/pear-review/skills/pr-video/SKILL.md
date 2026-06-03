---
name: pr-video
description: Dispatch creation of a narrated, animated MP4 walk-through of the PR using the video-explainer skill. Use when you want a shareable video explainer of a pull request.
argument-hint: "['purpose' | 'review' | 'both' — default both]"
allowed-tools: [Bash, Read, Grep, Glob]
metadata:
  category: code-review
  requires:
    cli: [gh, git]
    skills: [video-explainer]
---

# Video walk-through

Produce a narrated, animated MP4 walk-through of this pull request using the
**video-explainer** skill.

Steps:
1. Assemble the script content first (no generic filler):
   - **Purpose** — what the PR does and why (from `gh pr view`).
   - **Key changes** — the 3–6 most important moves, with before/after that reads on screen.
   - **Review findings** — if a saved review exists, fold in its top blocking items;
     otherwise do a quick distill pass. ($ARGUMENTS controls scope: purpose / review / both.)
2. Invoke the video-explainer skill with that script: dark educational theme, animated
   diffs/diagrams where they clarify a change.
3. Save the resulting MP4 into this PR's review directory and print the output path.

Keep the runtime tight (aim 2–4 min). This is a dispatch action — kick it off and report
where the file lands.
