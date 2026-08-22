# Development Guide

## EGO Review Compliance

This extension targets submission to extensions.gnome.org (EGO). All code must
adhere to the official [EGO Review Guidelines](https://gjs.guide/extensions/
review-guidelines/review-guidelines.html) and [Best Practices](https://gjs.guide/
extensions/review-guidelines/best-practices.html).

### Mandatory Rules
- **Lifecycle**: Only create objects/connect signals/add main-loop sources in
  `enable()`, cleanup in `disable()`. Nothing in constructor/init.
- **Destruction**: Disconnect all signals, destroy all widgets, remove all
  GLib sources in `disable()`.
- **No deprecated modules**: Use ES6 classes, `async`/`await`, GLib.timeout_add.
- **Process isolation**: No GTK (Gdk, Gtk, Adw) in shell process; no Clutter,
  Meta, St, Shell in prefs process.
- **No excessive logging**: Only log important messages and errors.
- **AI code**: Must be understandable and maintainable by the human author.
  Remove "Generated with AI" comments before EGO submission.
- **metadata.json**: Well-formed, accurate, no unnecessary keys.
- **Licensing**: GPL-2.0-or-later compatible (extension.js, LICENSE).

### Best Practices
- **No unnecessary try-catch**: `destroy()`, `connect()`, `disconnect()`,
  `GLib.Source.remove()` don't throw.
- **No `_destroyed` flags**: Null out references after cleanup, don't guard.
- **Timeout cleanup**: Remove existing source BEFORE creating new one, same
  location.
- **enable()/disable() proximity**: Keep them adjacent in class definition.
- **Modular code**: Split logic into single-responsibility files.
- **Line length**: ≤200 characters for readability.
- **Self-explanatory code**: Clear names, minimal redundant comments.
- **D-Bus over subprocesses**: Prefer D-Bus for inter-process communication.
- **Icons**: Use `St.Icon`/`icon_name` for shell, `Gtk.Image` for prefs.
  No Unicode emojis as icons.

## Linting with shexli

`shexli` (0.2.1 — the only release) segfaults if installed fresh, because
`pip install shexli` pulls `tree-sitter==0.26.0`, which has a memory-corruption
bug that crashes the analyzer on larger modules (SIGSEGV/Bus error, no findings).
Pin the known-good version:

```bash
python3 -m venv venv
. venv/bin/activate
pip install shexli
pip install "tree-sitter==0.25.2"   # workaround for shexli crash
shexli <extension-folder-or-zip>
```

This is a known upstream issue — `tree-sitter` 0.25.1/0.25.2 analyze extensions
cleanly and repeatably; 0.26.0 crashes (memory corruption, symptom location
varies per run). Not a bug in this extension.

### Known false positive: EGO-P-007 on history-dialog.js

shexli reports `history-dialog.js` as unreachable because its reachability
walker only recognizes `Gio.Subprocess.new`, `GLib.spawn_command_line_*`,
`GLib.spawn_async*` and `Shell.Util.*` spawn forms — not the
`Gio.SubprocessLauncher.spawnv` call we use (nor an absolute `/usr/bin/gjs`
argv[0]). The dialog is spawned as a subprocess from subscription-manager.js
and ships in the zip on purpose. shexli exits 0 regardless of findings, so
this single warning can be ignored; any other finding needs a look.

## CI Packaging (extensions.gnome.org)

`gnome-extensions pack` (as wrapped by the CI action) only includes standard
files automatically (`metadata.json`, `extension.js`, `prefs.js`, `stylesheet.css`,
`schemas/`). Every other file must be listed in the workflow's `extra-source`.
The first EGO submission's zip was missing all module JS and LICENSE because of
this, and `extra-source` files are flattened to their basename — so never pass
the schema XML via `extra-source` (it must stay under `schemas/`). The workflow
verifies the packaged zip's contents after building; keep `extra-source` and the
packed file list in sync when adding files.