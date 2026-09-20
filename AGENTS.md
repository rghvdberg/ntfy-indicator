# Agent Guide: ntfy GNOME Shell Extension

A GNOME Shell extension that delivers real-time desktop notifications via ntfy.sh. This guide contains the non-obvious conventions, gotchas, and commands needed to work effectively in this codebase.

## Quick Start

**First-time setup:**
```bash
# Syntax check any JS file
node --check <file>.js

# Run unit tests (isolated temp directory)
./tests/run.sh

# Lint before EGO submission (PIN tree-sitter!)
python3 -m venv venv
. venv/bin/activate
pip install shexli
pip install "tree-sitter==0.25.2"   # 0.26.0 causes shexli to segfault
shexli build/ntfy-indicator@rghvdberg.shell-extension.zip
```

## Essential Commands

### Build & Pack
```bash
gnome-extensions pack -f -o build \
  --extra-source=api.js --extra-source=attachment-downloader.js \
  --extra-source=history-dialog.js --extra-source=indicator.js \
  --extra-source=notification-store.js --extra-source=subscription-manager.js \
  --extra-source=utils.js --extra-source=LICENSE --extra-source=icons .
```
**Gotcha:** `gnome-extensions pack` auto-includes `metadata.json`, `extension.js`, `prefs.js`, `stylesheet.css`, and `schemas/`. Non-standard files MUST be in `--extra-source` or they won't be in the zip.

### Testing
```bash
# All unit tests
./tests/run.sh

# Single test suite with isolated data dir
XDG_DATA_HOME=$(mktemp -d) gjs -m tests/test-store.js

# API tests (requires ntfy server)
NTFY_TEST_SERVER=https://ntfy.sh XDG_DATA_HOME=$(mktemp -d) gjs -m tests/test-api.js

# Integration tests (nested shell)
NTFY_TEST_SERVER=https://ntfy.sh ./tests/test-integration.sh

# Nested shell for manual testing
./tests/run-nested-shell.sh  # Requires mutter-dev-bin package
```

### Deploy to VM (optional)
```bash
# Create VM (one-time)
./tests/vm-create.sh

# Sync extension to VM
NTFY_DEV_KEY=tests/.vm-key NTFY_DEV_VM=ntfy-test ./tests/vm-sync.sh
```

## Architecture Overview

### Process Model
- **Shell process** (`extension.js`): Panel indicator, desktop notifications, network feeds, persistent store, D-Bus service
- **Dialog process** (`history-dialog.js`): Standalone GTK4 app, reads store files, sends actions via D-Bus
- **Prefs process** (`prefs.js`): Runs inside GNOME Settings, uses libadwaita

**Critical:** The dialog is a separate process with no store state of its own. All actions (mark read/delete/mute/publish) go to the shell over D-Bus.

### Data Flow
1. User adds topics in prefs → `channels` gsettings
2. `SubscriptionManager` opens one long-poll feed per topic via `NtfyApi`
3. `api.js` streams JSON lines; new messages delivered to `notificationStore`
4. `notificationStore` writes `~/.local/share/ntfy/<safe-topic-url>.json`
5. `history-dialog.js` reads store files, sends actions via D-Bus to shell

### Key Modules
| Module | Responsibility |
|--------|---------------|
| `extension.js` | Entry point; creates settings, indicator, subscription manager |
| `indicator.js` | Panel button with summed unread count; menu lists topics |
| `subscription-manager.js` | One feed per topic; delivers to store/desktop; owns MessageTray; exports D-Bus; spawns dialog |
| `api.js` | `NtfyApi` — libsoup3 long-poll client, exponential backoff, self-signed TLS, tombstone handling |
| `notification-store.js` | Persistent per-topic JSON store; serializes writes per topic |
| `history-dialog.js` | GTK4 history/publish UI; D-Bus client for shell actions |
| `attachment-downloader.js` | Caches attachments in `~/.local/share/ntfy/cache` (5 MB cap) |
| `prefs.js` | Preferences UI with libadwaita |
| `utils.js` | Helpers (`parseTopicUrl`, `getApiKey`, paths, debug logging) |

## Hard Invariants — Do Not Regress

1. **Never lose history**: Fresh subscribe resumes from persisted `lastId` watermark (`since=<lastId>`). When no watermark exists, `since=all` loads the full server backlog **once**. Never use time windows (`since=1h`).

2. **Never re-notify known messages**: Messages already in the store or `seenIds` must be suppressed — no duplicate desktop notification, no duplicated history row, no lost read/delete state.

3. **No lost writes**: All store mutations (add, mark read, mark all read, delete) run serialized per topic. Concurrent delivery bursts must not drop data or clobber `seenIds`/`lastId`.

4. **Read/Delete is durable**: Marking read or deleting in the dialog persists the id in `seenIds` so the message never resurfaces, even after re-login or a `since=all` first-subscribe.

5. **Dialog is separate process**: It holds no store state — actions go to the shell over D-Bus, updates come from the store files.

## EGO Review Guidelines (Mandatory)

This extension targets submission to [extensions.gnome.org](https://extensions.gnome.org). Code MUST adhere to:

### Lifecycle Rules
- **Only** create objects, connect signals, and add main-loop sources in `enable()`
- **Only** clean them up in `disable()`
- **Nothing** in constructor/init
- Disconnect all signals, destroy all widgets, remove all GLib sources in `disable()`

### Code Style
- No unnecessary `try-catch` around `destroy()`, `connect()`, `disconnect()`, or `GLib.Source.remove()`
- No `_destroyed` or `_enabled` boolean flags — null out references after cleanup
- Timeout cleanup belongs next to creation; remove existing source BEFORE creating new one
- Keep `enable()` and `disable()` adjacent in class definitions
- Line length ≤200 characters
- No deprecated modules — use ES6 classes, `async`/`await`, `GLib.timeout_add`

### Process Isolation
- No GTK/Gdk/Adw in the shell process
- No Clutter/Meta/St/Shell in the prefs process

### Other Rules
- No excessive logging (only important messages and errors)
- AI code must be understandable by the human author
- Remove "Generated with AI" comments before EGO submission
- Well-formed, accurate `metadata.json` with no unnecessary keys
- GPL-2.0-or-later compatible licensing

## Code Patterns

### Store Serialization
```javascript
// Writes are serialized per topic to prevent data loss
this._enqueue(topicUrl, async () => {
  // Your write logic here
});
```

### D-Bus Service (Shell → Dialog)
```javascript
// Export on session bus in subscription-manager.js
this._dbusNodeId = Gio.DBusExportedObject.wrapJSObject(SERVICE_XML, this);
this._dbusExport = Gio.DBus.session.export_object(DBUS_PATH, this._dbusNodeId);
```

### Long-Polling with Tombstones
The `api.js` client batches incoming JSON lines for 300ms before delivery. This ensures that replayed messages and their trailing `message_delete`/`message_clear` tombstones arrive together, preventing spurious notifications.

**Gotcha:** ntfy keeps the original row and emits tombstones (`sequence_id` = message id). The extension receives them and converts them in `deleteNotification`/`markRead`, advancing `lastId`. The extension never sends deletes/clears.

### Attachment Caching
Attachments are cached in `~/.local/share/ntfy/cache` with a 5 MB cap. When the history limit trims notifications, the cached attachment of trimmed notifications is deleted.

## Testing Patterns

### Unit Tests
Pure `gjs` tests that run on the host. No extension code under test is modified by the test harness. Use `XDG_DATA_HOME=$(mktemp -d)` to isolate store tests from your real data.

### Integration Tests
End-to-end tests on a nested GNOME Shell session:
- `tests/test-integration.sh` deploys to a nested shell, drives a real ntfy server, and asserts store state locally
- Tests hit the dev server with a disposable topic
- Runs entirely on the host (no VM required)

### Configuration
Configuration is env-driven via `tests/config.sh`:
- `NTFY_TEST_SERVER` — required for api/integration tests
- `NTFY_TEST_SELF_SIGNED` — "true" if server uses self-signed cert
- `NTFY_TEST_VM` — virsh domain name (default: ntfy-test)
- `NTFY_TEST_SSH_KEY` — private key path (default: tests/.vm-key)

## Known Issues & Deferrals

### History Dialog Scroll Glitch (Cosmetic)
Deleting a message makes the list briefly jump to the top then back to the current position. Cause: the fixed 150 ms scroll-restore in the delete handler races GTK's async relayout of the ListBox. **Deferred:** rewrite with `GtkListView` + `GListModel` (GTK 4 recommended approach for mutable lists).

### Muted Topics UI (Missing Indicator)
After muting a topic, there is no persistent visual cue. **Proposed fix:**
- Panel menu: append a `notification-disabled-symbolic` icon for muted topics
- Dialog sidebar: show a `notification-disabled-symbolic` icon per muted topic row
- Fix the header "Mute"/"Unmute" label to track the selected topic

**Mute semantics:** messages are still stored + counted while muted (web app behavior); only the desktop banner is suppressed.

## File Locations

```
~/.local/share/ntfy/<safe-topic-url>.json   # Per-topic store
~/.local/share/ntfy/cache/                  # Attachment cache (5 MB cap)
```

## Common Tasks

### Add a New Module
1. Create the file with the standard GPL header
2. Export classes/functions with `export`
3. Import in `extension.js` or relevant module
4. Add to `--extra-source` in pack command if non-standard

### Modify Store Behavior
1. Changes go in `notification-store.js`
2. Writes are serialized per topic via `_enqueue()`
3. Callbacks are emitted to notify indicator/dialog
4. Test with `XDG_DATA_HOME=$(mktemp -d) gjs -m tests/test-store.js`

### Add D-Bus Methods
1. Update `SERVICE_XML` in `subscription-manager.js`
2. Implement the method on the `SubscriptionManager` class
3. Update `history-dialog.js` client to call the new method
4. Test that the dialog can invoke the method successfully

## Verification Checklist

Before deploying:
- [ ] Pass the shexli check (with pinned `tree-sitter==0.25.2`)
- [ ] Run `node --check` on changed JS files
- [ ] Lint the **packed zip**, not the loose sources
- [ ] Run unit tests (`./tests/run.sh`)
- [ ] Run integration tests (if `NTFY_TEST_SERVER` is available)
- [ ] Manual testing in nested shell or VM

## Project Context

This project is "vibe coded" — built collaboratively with AI (opencode). The human designed the features, tested on real hardware, and reviewed every change. The AI wrote the code.

**Key requirement:** All AI-generated code must be understandable and maintainable by the human author.
