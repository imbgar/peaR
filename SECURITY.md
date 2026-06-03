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

## Automated scanning

Every push and PR runs a DevSecOps suite (see `.github/workflows/`):

| Tool | What it catches |
|------|-----------------|
| **gitleaks** | Hardcoded secrets / keys (full git history) |
| **cargo-audit** | Known vulnerabilities in Rust crates (RustSec) |
| **OSV-Scanner** | Vulns in `Cargo.lock` + `package-lock.json` (OSV DB) |
| **CodeQL** | SAST for the TypeScript frontend |
| **OSSF Scorecard** | Supply-chain security posture score |
| **Dependabot** | Automated dependency updates (cargo / npm / actions) |

### Socket.dev (recommended, one-click)
For supply-chain / malicious-dependency detection on every PR, install the
[**Socket** GitHub App](https://github.com/apps/socket-security) on the repo — it reviews
new/changed dependencies for risky behavior (install scripts, network, obfuscation) and
comments on PRs. No workflow file or API key needed for the App; the org-level CLI/API
integration is optional.

## Supported versions

As a pre-1.0 project, only the latest release receives security fixes.
