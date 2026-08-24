# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

GNOME Shell 50 extension that brings ntfy push notifications to the desktop. It subscribes to configurable ntfy topics, shows desktop notifications, tracks unread counts in the panel, and provides a history dialog with publish/mute/mark-read/delete and image/attachment previews.

## Common commands

### Run unit tests

```bash
./tests/run.sh
```

Requires `gjs`. Set `NTFY_TEST_SERVER=https://...` to include API tests (they hit the dev server with a disposable topic). Runs the utils, store, and optionally api suites.

### Run a single test suite

```bash
XDG_DATA_HOME=$(mktemp -d) gjs -m tests/test-utils.js
XDG_DATA_HOME=$(mktemp -d) gjs -m tests/test-store.js
NTFY_TEST_SERVER=https://... XDG_DATA_HOME=$(mktemp -d) gjs -m tests/test-api.js
```

### Syntax-check changed JS

```bash
node --check <file>.js
```

### Lint / EGO preflight

```bash
python3 -m venv venv
. venv/bin/activate
pip install shexli
pip install "tree-sitter==0.25.2"   # shexli 0.2.1 crashes with tree-sitter 0.26.0
shexli build/ntfy-indicator@rghvdberg.shell-extension.zip
```

`shexli` only accepts a folder or zip; `history-dialog.js` is reported unreachable because its reachability walker does not recognize `Gio.SubprocessLauncher.spawnv`. That is a known false positive — the dialog is spawned intentionally and ships in the zip. Any other finding needs investigation.

### Build / pack the extension zip

```bash
gnome-extensions pack -f -o build \
  --extra-source=api.js --extra-source=attachment-downloader.js \
  --extra-source=history-dialog.js --extra-source=indicator.js \
  --extra-source=notification-store.js --extra-source=subscription-manager.js \
  --extra-source=utils.js --extra-source=LICENSE --extra-source=icons .
```

This mirrors `.github/workflows/build-extension.yml`. The native pack auto-includes `metadata.json`, `extension.js`, `prefs.js`, `stylesheet.css`, and `schemas/`.

### Deploy to dev VM

```bash
./vm-sync.sh
```

Syncs host source to the libvirt VM named `ntfy-dev`, compiles schemas, installs icons/desktop file, restarts GDM, and enables the extension. One-time sudo setup in the VM is required unless the VM was created by `tests/vm-create.sh`.

### Integration tests on throwaway VM

```bash
NTFY_TEST_SERVER=https://... ./tests/test-integration.sh
```

Requires a running VM (default `ntfy-test`). Builds a fresh zip via `tests/deploy-vm.sh`, drives a real ntfy server, and asserts store state over SSH. Creates and disposes a topic per run.

### Build a throwaway test VM

```bash
./tests/vm-create.sh        # create VM ntfy-test
./tests/vm-create.sh --fresh # recreate it
```

Host deps: `qemu-utils virtinst libvirt-daemon-system libvirt-clients cloud-image-utils openssh-client curl`.

### Release / CI

GitHub Actions builds the zip on push/tag/release and optionally uploads to extensions.gnome.org. No local release command is required. See `.github/GNOME_ACTION_SETUP.md` for EGO secret setup and release steps.

## High-level architecture

### Process model

- **Shell process** (`extension.js`): owns the panel indicator, desktop notifications, network feeds, persistent store, and a session D-Bus service. Created when the extension is enabled; destroyed on disable.
- **Dialog process** (`history-dialog.js`): standalone GTK4 app spawned by the shell. It is a thin client — it reads store files directly but sends all actions (mark read/delete/mute/publish) to the shell over D-Bus.
- **Prefs process** (`prefs.js`, Adw): runs inside GNOME Settings. Must not import Clutter/Meta/St/Shell.

### Module responsibilities

- `extension.js`: Extension entry point; creates settings, indicator, and subscription manager.
- `indicator.js`: Panel button with summed unread count; menu lists topics and opens the history dialog.
- `subscription-manager.js`: Manages one `NtfyApi` feed per topic; delivers new messages to the store and desktop; owns the `MessageTray` source; exports the D-Bus service used by the history dialog; spawns the dialog subprocess.
- `api.js`: `NtfyApi` — libsoup3 long-poll client (`GET /<topic>/json?since=...`), exponential backoff, self-signed TLS policy, and batching/tombstone handling.
- `notification-store.js`: Persistent per-topic JSON store in `~/.local/share/ntfy/`. Serializes writes per topic. Emits change callbacks so the indicator and dialog refresh.
- `history-dialog.js`: GTK4 history/publish UI. Reads store files and calls D-Bus methods on `com.github.rghvdberg.ntfy_indicator`.
- `attachment-downloader.js`: Caches attachment downloads in `~/.local/share/ntfy/cache` (5 MB cap).
- `prefs.js`: Preferences UI.
- `utils.js`: Shared helpers (`parseTopicUrl`, `getApiKey`, data/cache/paths, `debugLog`).

### Data flow

1. User adds topics in prefs → `channels` gsettings.
2. `Indicator` / `SubscriptionManager` opens one long-poll feed per topic.
3. `api.js` streams JSON lines; new messages are passed to `subscription-manager.js`.
4. `subscription-manager.js` pushes messages into `notification-store.js` and shows desktop banners (unless muted).
5. `notification-store.js` writes `~/.local/share/ntfy/<safe-topic-url>.json` and notifies `Indicator` and `history-dialog.js`.
6. `history-dialog.js` sends actions over D-Bus; the shell-side service mutates the store.

### Hard invariants

- **Never lose history.** Resume from persisted per-topic `lastId` (`since=<lastId>`); when no watermark exists, `since=all` loads the full server backlog once. Never use a time window.
- **Never re-notify known messages.** Suppress messages already in the store or in `seenIds`.
- **No lost writes.** Store mutations are serialized per topic via `_pendingWrites`.
- **Read/delete is durable.** Marking read or deleting persists the id in `seenIds` so the message never resurfaces.
- **Dialog is stateless.** It holds no store state of its own; actions go to the shell over D-Bus.

### EGO / code-style constraints

- Lifecycle: create objects, connect signals, and add main-loop sources only in `enable()`; clean them up in `disable()`.
- No GTK/Gdk/Adw in the shell process; no Clutter/Meta/St/Shell in the prefs process.
- No unnecessary `try-catch` around `destroy()`, `connect()`, `disconnect()`, or `GLib.Source.remove()`.
- No `_destroyed` or `_enabled` boolean flags — null out references after cleanup.
- Timeout cleanup belongs next to creation; remove the existing source before creating a new one.
- Keep `enable()` and `disable()` adjacent in class definitions.
- Line length ≤200.
- `gnome-extensions pack` requires non-standard files in `extra-source`; never put the schema XML in `extra-source` (it must stay under `schemas/`).

### Testing / deployment notes

- Unit tests are pure `gjs` and run on the host.
- Integration tests run against a throwaway VM and a real ntfy server (`NTFY_TEST_SERVER`).
- `tests/config.sh` centralizes test environment variables and SSH options.
- After any install/refresh on a VM, restart the GNOME session (`sudo systemctl restart gdm`) before judging behavior; shell caches extension JS modules per process.
- `gnome-extensions install` handles schema compilation automatically.

### Sending test messages

```bash
# Plain text
curl -d "message text" https://ntfy.domain.com/topic

# Attachment (small text files need Filename header to count as attachment)
curl -T /path/to/file -H "Filename: file.txt" -H "Title: title" -H "Message: msg" https://ntfy.domain.com/topic

# Delete / clear on the dev self-signed server
curl -sk -X DELETE https://server.cup.cake:12707/<topic>/<id>
curl -sk -X PUT https://server.cup.cake:12707/<topic>/<id>/clear
```
