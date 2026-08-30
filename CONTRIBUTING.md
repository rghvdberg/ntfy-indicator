# Development Guide

This guide covers development, testing, and deployment for the ntfy GNOME Shell extension.

## Table of Contents

- [EGO Review Compliance](#ego-review-compliance)
- [Development Commands](#development-commands)
- [Testing](#testing)
- [Local Development with Nested Shell](#local-development-with-nested-shell)
- [CI/CD and Deployment](#cicd-and-deployment)

---

## EGO Review Compliance

This extension targets submission to [extensions.gnome.org](https://extensions.gnome.org) (EGO). All code must adhere to the official [EGO Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html) and [Best Practices](https://gjs.guide/extensions/review-guidelines/best-practices.html).

### Mandatory Rules

- **Lifecycle**: Only create objects, connect signals, and add main-loop sources in `enable()`. Clean up everything in `disable()`. Nothing in constructor/init.
- **Destruction**: Disconnect all signals, destroy all widgets, remove all GLib sources in `disable()`.
- **No deprecated modules**: Use ES6 classes, `async`/`await`, `GLib.timeout_add`.
- **Process isolation**: No GTK (Gdk, Gtk, Adw) in shell process; no Clutter, Meta, St, Shell in prefs process.
- **No excessive logging**: Only log important messages and errors.
- **AI code**: Must be understandable and maintainable by the human author. Remove "Generated with AI" comments before EGO submission.
- **metadata.json**: Well-formed, accurate, no unnecessary keys.
- **Licensing**: GPL-2.0-or-later compatible (extension.js, LICENSE).

### Best Practices

- **No unnecessary try-catch**: `destroy()`, `connect()`, `disconnect()`, `GLib.Source.remove()` don't throw.
- **No `_destroyed` flags**: Null out references after cleanup, don't guard.
- **Timeout cleanup**: Remove existing source BEFORE creating new one, same location.
- **enable()/disable() proximity**: Keep them adjacent in class definition.
- **Modular code**: Split logic into single-responsibility files.
- **Line length**: ≤200 characters for readability.
- **Self-explanatory code**: Clear names, minimal redundant comments.
- **D-Bus over subprocesses**: Prefer D-Bus for inter-process communication.
- **Icons**: Use `St.Icon`/`icon_name` for shell, `Gtk.Image` for prefs. No Unicode emojis as icons.

---

## Development Commands

### Syntax Check

```bash
node --check <file>.js
```

### Run Unit Tests

```bash
./tests/run.sh
```

Requires `gjs`. Set `NTFY_TEST_SERVER=https://...` to include API tests (they hit the dev server with a disposable topic). Runs the utils, store, and optionally api suites.

### Run a Single Test Suite

```bash
# Run with isolated temp directory to avoid polluting your real ~/.local/share/ntfy/
XDG_DATA_HOME=$(mktemp -d) gjs -m tests/test-utils.js
XDG_DATA_HOME=$(mktemp -d) gjs -m tests/test-store.js
NTFY_TEST_SERVER=https://... XDG_DATA_HOME=$(mktemp -d) gjs -m tests/test-api.js
```

### Lint / EGO Preflight

```bash
python3 -m venv venv
. venv/bin/activate
pip install shexli
pip install "tree-sitter==0.25.2"   # shexli 0.2.1 crashes with tree-sitter 0.26.0
shexli build/ntfy-indicator@rghvdberg.shell-extension.zip
```

**Important**: `shexli` only accepts a folder or zip. `history-dialog.js` is reported unreachable because its reachability walker does not recognize `Gio.SubprocessLauncher.spawnv`. This is a known false positive — the dialog is spawned intentionally and ships in the zip. Any other finding needs investigation.

**Note**: `shexli` 0.2.1 segfaults if installed fresh because `pip install shexli` pulls `tree-sitter==0.26.0` with a memory-corruption bug. Pin to the known-good version `tree-sitter==0.25.2`.

### Build / Pack the Extension Zip

```bash
gnome-extensions pack -f -o build \
  --extra-source=api.js --extra-source=attachment-downloader.js \
  --extra-source=history-dialog.js --extra-source=indicator.js \
  --extra-source=notification-store.js --extra-source=subscription-manager.js \
  --extra-source=utils.js --extra-source=LICENSE --extra-source=icons .
```

This mirrors `.github/workflows/build-extension.yml`. The native pack auto-includes `metadata.json`, `extension.js`, `prefs.js`, `stylesheet.css`, and `schemas/`.

### Deploy to Dev VM

```bash
NTFY_DEV_KEY=~/.ssh/my-key ./tests/vm-sync.sh
```

This script:
1. Packs the extension locally with `gnome-extensions pack`
2. Transfers the zip to the VM
3. Installs it with `gnome-extensions install -f` (which handles schema compilation, enabling, and dconf)
4. Restarts GNOME session for a clean reload
5. Verifies the extension is active

**Configuration** (required environment variables):
- `NTFY_DEV_KEY` - **Required**: Path to your SSH private key for the VM
- `NTFY_DEV_VM` - VM name (default: `ntfy-dev`)
- `NTFY_DEV_USER` - SSH user on VM (default: `tester`)

**First-time setup**: Before using this script, you'll need to:
1. Create or use an existing SSH key pair
2. Add the public key to your VM's `~/.ssh/authorized_keys`
3. Ensure the VM is running (`virsh start ntfy-dev`)
4. Set up passwordless sudo for GDM restart:
   ```bash
   # Run once on the VM:
   echo 'tester ALL=(root) NOPASSWD: /usr/bin/systemctl restart gdm' | sudo tee /etc/sudoers.d/ntfy-dev
   sudo systemctl restart gdm
   ```

---

## Testing

### Unit Tests

Unit tests are pure `gjs` and run on the host. See `tests/run.sh` for the test runner.

### Integration Tests

Integration tests run in an isolated nested GNOME Shell session with a real ntfy server:

```bash
NTFY_TEST_SERVER=https://... ./tests/test-integration.sh
```

The script creates a temporary environment, installs the extension, starts a nested GNOME Shell on an isolated session bus, runs all tests locally, and cleans up on exit. Requires a running ntfy server (`NTFY_TEST_SERVER`). Creates a disposable topic per run.

### Manual Testing

See [tests/MANUAL.md](tests/MANUAL.md) for the human UI checklist. Run this after unit and integration tests pass. Each item maps to a past regression.

### Build a Throwaway Test VM

```bash
./tests/vm-create.sh        # create VM ntfy-test
./tests/vm-create.sh --fresh # recreate it
```

Host deps: `qemu-utils virtinst libvirt-daemon-system libvirt-clients cloud-image-utils openssh-client curl`.

### Sending Test Messages

```bash
# Plain text
curl -d "message text" https://ntfy.domain.com/topic

# Attachment (small text files need Filename header to count as attachment)
curl -T /path/to/file -H "Filename: file.txt" -H "Title: title" -H "Message: msg" https://ntfy.domain.com/topic

# Delete / clear
curl -s -X DELETE https://ntfy.example.com/<topic>/<id>
curl -s -X PUT https://ntfy.example.com/<topic>/<id>/clear

Note: add `-k` to skip TLS certificate verification if your server uses a self-signed certificate.
```

---

## Local Development with Nested Shell

For testing without affecting your main GNOME session, you can run a nested GNOME Shell instance:

```bash
./tests/run-nested-shell.sh
```

A new window will appear with a full GNOME desktop. The ntfy extension should be automatically enabled.

### What This Does

1. Creates an isolated environment (temporary home directory)
2. Copies your extension to the nested session
3. Sets up schemas
4. Enables the extension via dconf
5. Starts GNOME Shell in Wayland mode

### Debugging Features

- **Console Output**: All `console.log()`, `console.warn()`, `console.error()` messages appear in the terminal.
- **Stack Traces**: With `SHELL_DEBUG=all`, you get full stack traces for warnings and errors.
- **Looking Glass**: Inside the nested shell, press `Alt+F2`, type `lg`, press Enter to open the GNOME Shell debugger.
- **Reload**: The nested shell restarts when you close the window. Just run the script again after making changes.

### Stopping

You can stop the nested shell in two ways:

1. **Keyboard shortcut**: Press `Ctrl+C` in the terminal where the script is running
2. **UI button**: Click the **orange button** with a computer screen and arrow icon in the top bar of the nested shell window. This is GNOME Shell's built-in "Exit Nested Session" control. Next to it is a square stop button that also stops the session.

Both methods will terminate the nested GNOME Shell process and clean up the temporary environment.

---

## CI/CD and Deployment

### GitHub Actions

The workflow `.github/workflows/build-extension.yml` builds and packages the extension on push/tag/release.

Two jobs:

1. **build-zip** (runs on push/tag/release/manual): packages the extension and
   - Uploads the zip as a **workflow artifact** (downloadable from the Actions page, ~90-day retention)
   - On tags (`v*`), attaches the zip to the **GitHub Release** as a downloadable asset
2. **upload-ego** (runs on release/manual): packages and uploads to extensions.gnome.org using the `GNOME_USERNAME`/`GNOME_PASSWORD` secrets

### Setup Required

#### 1. Create GitHub Secrets

Go to: `Settings → Secrets and variables → Actions → New repository secret`

Add these secrets:

| Name | Value |
|------|-------|
| `GNOME_USERNAME` | Your extensions.gnome.org username |
| `GNOME_PASSWORD` | Your extensions.gnome.org password |

Create the account at https://extensions.gnome.org/upload/ if you don't have one.

#### 2. Accept TOS First

Run the workflow once manually to accept the GNOME Developer Agreement:

```bash
# Trigger via GitHub UI: Actions → Build and Upload GNOME Extension → Run workflow
# Or via CLI:
gh workflow run build-extension.yml --ref main
```

#### 3. Submit for Review

After upload, the extension appears in the "Pending" section of your extensions.gnome.org account. Submit it for review there.

### Workflow Triggers

- **On push to main / tag `v*`**: packages a zip → workflow artifact, and on tags also attaches it to the GitHub release
- **On release publish**: builds zip, attaches to release, and uploads to extensions.gnome.org
- **Manual**: can be triggered from Actions tab or via `gh workflow run`

### Releasing a New Version

1. Bump `"version"` in `metadata.json` (e.g. `0.2.0`) and commit
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`
3. Publish a GitHub release from the tag (or `gh release create v0.2.0`) — the workflow attaches the zip and uploads to EGO

### CI Packaging Notes

`gnome-extensions pack` (as wrapped by the CI action) only includes standard files automatically (`metadata.json`, `extension.js`, `prefs.js`, `stylesheet.css`, `schemas/`). Every other file must be listed in the workflow's `extra-source`. The first EGO submission's zip was missing all module JS and LICENSE because of this, and `extra-source` files are flattened to their basename — so never pass the schema XML via `extra-source` (it must stay under `schemas/`). The workflow verifies the packaged zip's contents after building; keep `extra-source` and the packed file list in sync when adding files.

### Node.js Deprecation Warnings

Actions `checkout@v4`, `upload-artifact@v4`, and `action-gh-release@v2` show Node.js 20 deprecation warnings. Workflows complete successfully (GitHub forces Node.js 24). Update action versions when convenient.

---

---

## Known Issues / Deferred

### History Dialog Scroll Glitch

Deleting a message in the history dialog makes the list briefly jump to the top then back to the current position. Cosmetic only; cause not documented by GTK — the fixed 150 ms scroll-restore in the delete handler races GTK's async relayout of the ListBox. Deferred: rewrite the message list with `GtkListView` + `GListModel` (the GTK 4 recommended approach for mutable lists) in a future release.

### Muted Topics UI

After muting a topic in the dialog, there is no persistent visual cue that the topic is muted. The web app shows a `NotificationsOff` icon (bell-with-slash) next to each muted topic in the nav sidebar, plus "Muted" tooltip. Our extension only shows the mute state as the "Mute"/"Unmute" label of the currently open topic.

**Proposed fix**:
- Panel menu (`indicator.js`): append a `notification-disabled-symbolic` icon for muted topics; add `muted-topics` to settings-changed handler to refresh.
- Dialog sidebar (`history-dialog.js`): pass the full `muted-topics` JSON to the dialog; show a `notification-disabled-symbolic` icon per muted topic row; fix the header "Mute"/"Unmute" label to track the selected topic (not just the initial topic).

Mute semantics: messages are still stored + counted while muted (web app behavior); only the desktop banner is suppressed.