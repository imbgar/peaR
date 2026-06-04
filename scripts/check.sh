#!/usr/bin/env bash
# Local pre-flight that mirrors .github/workflows/ci.yml exactly, so a push can't
# surface a red check you couldn't have seen locally. Run it by hand any time:
#
#     ./scripts/check.sh            # full gate (core + frontend)
#     ./scripts/check.sh --core     # Rust core only (fast; skips frontend)
#
# It's also what the opt-in pre-push hook runs — see scripts/hooks/pre-push.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2
root="$(pwd)"

# ── tiny output helpers ──────────────────────────────────────────────────────
bold=$'\033[1m'; red=$'\033[31m'; grn=$'\033[32m'; dim=$'\033[2m'; rst=$'\033[0m'
fail=0
declare -a results

step() { # step "Label" cmd...
  local label="$1"; shift
  printf '%s▸ %s%s  %s%s\n' "$bold" "$label" "$rst" "$dim" "$*"
  printf '%s' "$rst"
  if "$@"; then
    results+=("${grn}✓${rst} $label")
  else
    results+=("${red}✗${rst} $label")
    fail=1
  fi
  echo
}

core_only=0
[ "${1:-}" = "--core" ] && core_only=1

# ── core job (.github/workflows/ci.yml → job: core) ──────────────────────────
step "rustfmt"        cargo fmt --all -- --check
step "clippy (core)"  cargo clippy -p pear-core --all-targets -- -D warnings
step "test (core)"    cargo test -p pear-core

# ── app job (.github/workflows/ci.yml → job: app) ────────────────────────────
if [ "$core_only" = "0" ]; then
  if [ -d "$root/apps/desktop/node_modules" ]; then
    step "eslint"           npm --prefix apps/desktop run --silent lint
    step "build (tsc+vite)"  npm --prefix apps/desktop run --silent build
    step "clippy (desktop)"  cargo clippy -p desktop --all-targets -- -D warnings
  else
    results+=("${dim}— frontend skipped (run: cd apps/desktop && npm install)${rst}")
  fi
fi

# ── summary ──────────────────────────────────────────────────────────────────
echo "${bold}── summary ──${rst}"
for r in "${results[@]}"; do echo "  $r"; done
if [ "$fail" = "0" ]; then
  echo "${grn}${bold}all checks passed${rst}"
else
  echo "${red}${bold}checks failed — fix before pushing${rst}  ${dim}(cargo fmt --all fixes formatting)${rst}"
fi
exit "$fail"
