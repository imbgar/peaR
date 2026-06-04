# pear-review

PR-review skills shipped with [peaR](https://github.com/imbgar/peaR), installable as a
plugin in **Claude Code** and **Codex**.

## Skills

| Skill | What it does |
|-------|--------------|
| `pr-post-review` | Review the PR and **post** inline + summary comments to GitHub |
| `pr-copy` | Produce clean, copy/paste-ready review markdown (no posting) |
| `pr-distill` | Distill to only the merge-blocking items |
| `pr-walkthru` | Interactive, finding-by-finding guided tour |
| `pr-explain` | Explain the PR's purpose + changes, then surface gaps |
| `pr-video` | _Optional._ Dispatch a narrated MP4 walk-through — needs a separately-installed `video-explainer` engine (it isn't bundled; the skill checks for it and prints setup steps if missing) |

The first five are `gh`-driven and work out of the box on the PR checked out in the working
directory. `pr-video` is an optional hook that depends on an external narrated-video engine.

## Install

### Claude Code
```
/plugin marketplace add imbgar/peaR
/plugin install pear-review@peaR
```
Then invoke any skill as a slash command, e.g. `/pr-distill`.

### Codex
Codex reads the same `skills/<name>/SKILL.md` files via `.codex-plugin/plugin.json`
(it keys off each skill's `name` + `description`). Add the plugin per the
[Codex plugin docs](https://developers.openai.com/codex/plugins/build).

## Layout
```
plugins/pear-review/
  .claude-plugin/plugin.json   # Claude Code manifest
  .codex-plugin/plugin.json    # Codex manifest
  skills/<name>/SKILL.md        # one folder per skill (name matches folder)
```
