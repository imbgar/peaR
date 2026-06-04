---
name: pr-video
description: Dispatch creation of a narrated, animated MP4 walk-through of the PR via a narrated-video engine (e.g. video-explainer). Optional — it checks for the engine first and prints setup steps if it's missing. Use when you want a shareable video explainer of a pull request.
argument-hint: "['purpose' | 'review' | 'both' — default both]"
allowed-tools: [Bash, Read, Grep, Glob]
metadata:
  category: code-review
  optional: true
  requires:
    cli: [gh, git, ffmpeg]
    skills-optional: [video-explainer]
---

# Video walk-through

Produce a narrated, animated MP4 walk-through of this pull request. peaR ships the **dispatch
hook**, not the renderer — the video itself is produced by a separate **`video-explainer`**
skill (a narrated-MP4 engine with its own runtime deps: `ffmpeg` + a TTS). So check for it first.

## 0. Dependency check — do this BEFORE any other work

1. `command -v ffmpeg` — the renderer needs it.
2. Confirm a usable `video-explainer` skill/engine is installed (e.g.
   `ls ~/.claude/skills/video-explainer` and that its generator script is present).

If either is missing, **do not attempt to render**. Print exactly this and stop:

> **`pr-video` needs the `video-explainer` engine, which isn't installed.**
> It isn't bundled with peaR (it has its own heavy runtime deps). Set it up once:
> 1. Install `ffmpeg` — e.g. `brew install ffmpeg`.
> 2. Install the `video-explainer` skill from the setup gist:
>    **https://gist.github.com/imbgar/46660c46c8e3a16169cc2b2b59cb7394**
>    (drop it in `~/.claude/skills/video-explainer/` and follow its README).
> 3. Re-run `/pr-video`.

## 1. If the engine is present, build the video

1. Assemble the script content first (no generic filler):
   - **Purpose** — what the PR does and why (from `gh pr view`).
   - **Key changes** — the 3–6 most important moves, with before/after that reads on screen.
   - **Review findings** — if a saved review exists, fold in its top blocking items;
     otherwise do a quick distill pass. ($ARGUMENTS controls scope: purpose / review / both.)
2. Invoke the **video-explainer** skill with that script: dark educational theme, animated
   diffs/diagrams where they clarify a change.
3. Save the resulting MP4 into this PR's review directory and print the output path.

Keep the runtime tight (aim 2–4 min). This is a dispatch action — kick it off and report
where the file lands.
