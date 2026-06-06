# In-app auto-update

peaR checks GitHub Releases on launch (and every 6h) and, when a newer version is
available, shows an **`⬆ vX.Y.Z`** pill in the status bar. Hover it for the changelog;
click to download, install the new bundle **in place** (wherever the app was launched
from), and relaunch.

## How it works

- The Tauri **updater** plugin reads a signed manifest:
  `https://github.com/imbgar/peaR/releases/latest/download/latest.json`
- `latest.json` + the `.app.tar.gz.sig` are produced by `tauri-action` during the
  release build (`.github/workflows/release.yml`, `includeUpdaterJson: true`).
- The bundle is verified against the **minisign public key** committed in
  `apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).
- Updating is **separate from Apple notarization** — the build stays "unsigned"
  (right-click → Open on first install), and updates still work via the minisign key.

## One-time setup (required to actually ship updates)

The signing keypair was generated locally; the **private key is gitignored** at
`.secrets-local/pear-updater.key` (and its `.pub`). Add the private key to the repo so
release builds can sign:

1. **`TAURI_SIGNING_PRIVATE_KEY`** — the contents of `.secrets-local/pear-updater.key`:
   ```bash
   gh secret set TAURI_SIGNING_PRIVATE_KEY --repo imbgar/peaR < .secrets-local/pear-updater.key
   ```
2. **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`** — the password set at generation time
   (empty here, but set the secret anyway so the env var exists):
   ```bash
   printf '' | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo imbgar/peaR
   ```
3. **Back up** `.secrets-local/pear-updater.key` somewhere safe (a password manager). If
   it's lost you can't sign updates for existing installs — they'd need a manual reinstall
   with a new key.

Until the secret is set, release builds still succeed and publish the `.dmg`/`.app.tar.gz`;
they just won't emit a signed `latest.json`, so existing installs won't see the update
(manual download still works). The **first** version users can auto-update *from* is the
first release built **after** the secret is set and this feature ships.
