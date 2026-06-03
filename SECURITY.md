# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report privately via GitHub's
[private vulnerability reporting](https://github.com/imbgar/pear/security/advisories/new)
(Security → Advisories → Report a vulnerability). We aim to acknowledge within a few days.

When reporting, include: affected version/commit, reproduction steps, and the impact you
observed.

## Scope & notes

pear runs AI CLIs in real PTYs against your local repositories. A few things to be aware of:

- **Permission modes.** pear can launch Claude with `bypassPermissions` (the sidebar's
  *bypass 🚨* option), which lets the agent run any command without prompting. Use it
  deliberately; the default is `auto`.
- **PR checkout.** Opening a PR runs `gh pr checkout` in your real local repo, switching the
  branch. It will not clobber conflicting uncommitted changes (git refuses), but it does move
  your working branch.
- **No secrets in the repo.** Tokens are sourced at runtime from `gh` or env vars and are
  never written to disk by pear.

## Supported versions

As a pre-1.0 project, only the latest release receives security fixes.
