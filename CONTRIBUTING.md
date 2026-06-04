# Contributing to pear

Thanks for your interest! pear is early but already functional, and contributions are
welcome — bug reports, features, docs, and design ideas alike.

## Ground rules

- Be kind. We follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Keep the **core test-covered**. Logic lives in `crates/pear-core`; the Tauri layer is a
  thin shim. New core behavior should come with tests.
- Match the surrounding style. Rust is `rustfmt`-clean and `clippy`-clean; TypeScript builds
  with no errors.

## Dev setup

```bash
# prerequisites: Rust >= 1.80, Node >= 20, gh
cd apps/desktop && npm install
npm run tauri dev        # runs the app with hot reload
```

Core-only iteration is faster:

```bash
cargo test -p pear-core
cargo clippy -p pear-core --all-targets
cargo fmt --all
```

Frontend checks:

```bash
cd apps/desktop && npm run build   # tsc + vite build
```

### One-shot pre-flight (mirrors CI)

`./scripts/check.sh` runs every check CI runs — `rustfmt`, core/desktop `clippy -D warnings`,
core tests, eslint, and the frontend build — so a push can't surface a red check you couldn't
see locally. `./scripts/check.sh --core` skips the frontend for fast Rust-only loops. To run it
automatically before every push:

```bash
git config core.hooksPath scripts/hooks   # opt-in pre-push gate; --no-verify to bypass once
```

## Architecture in one paragraph

`pear-core` owns all state behind a serializable `Command`/`Event` protocol (see
`crates/pear-core/src/protocol.rs`). The Tauri backend (`apps/desktop/src-tauri`) forwards
commands and bridges events to the webview. Because the boundary is serializable, a future
TUI or daemon frontend reuses the core unchanged. Read
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before large changes.

## Pull requests

1. Branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Keep PRs focused; describe the *why*.
3. Ensure `cargo test -p pear-core`, `cargo fmt --check`, `cargo clippy`, and
   `npm run build` (in `apps/desktop`) all pass — CI enforces these.
4. Update `CHANGELOG.md` under `[Unreleased]` for user-facing changes.

## Commit style

Conventional-ish prefixes are appreciated (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`),
but clarity beats ceremony.

## Reporting bugs / proposing features

Use the issue templates. For security issues, see [SECURITY.md](SECURITY.md) instead of a
public issue.
