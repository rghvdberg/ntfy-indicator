# ntfy GNOME Shell Extension

Desktop notifications via ntfy.sh — subscribe to topics and receive real-time notifications on your GNOME desktop.

## About

This project is vibe coded — built collaboratively with AI (opencode). The human designed the features, tested on real hardware, and reviewed every change. The AI wrote the code.

## Features

- Real-time notifications via ntfy JSON polling
- Per-topic history dialog with publish support
- Mute/unmute topics
- Self-signed certificate support
- Priority and tag display
- Click actions (open URLs, attachments)

## Installation

### From Source

```bash
# Clone the repo
git clone https://github.com/rghvdberg/ntfy-indicator.git
cd ntfy-indicator

# Install to GNOME extensions directory
cp -r . ~/.local/share/gnome-shell/extensions/ntfy-indicator@rghvdberg

# Compile GSettings schemas
mkdir -p ~/.local/share/glib-2.0/schemas
cp ~/.local/share/gnome-shell/extensions/ntfy-indicator@rghvdberg/schemas/*.gschema.xml ~/.local/share/glib-2.0/schemas/
glib-compile-schemas ~/.local/share/glib-2.0/schemas

# Install icons (for proper scaling in panel and dock)
mkdir -p ~/.local/share/icons/hicolor/scalable/apps
cp ~/.local/share/gnome-shell/extensions/ntfy-indicator@rghvdberg/icons/ntfy.svg ~/.local/share/icons/hicolor/scalable/apps/
gtk-update-icon-cache -q -t ~/.local/share/icons/hicolor

# Install desktop file (for dock icon of history dialog)
mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/com.ntfy.HistoryDialog.desktop << 'EOF'
[Desktop Entry]
Type=Application
Name=ntfy History
Icon=ntfy
NoDisplay=true
EOF

# Enable the extension
gnome-extensions enable ntfy-indicator@rghvdberg

# Restart GNOME Shell to load the extension
# X11: press Alt+F2, type 'r', press Enter
# Wayland: log out and log back in
```

### Configuration

Open the extension preferences to configure:

- **Server URL** — Base URL of your ntfy server (default: `https://ntfy.sh`)
- **API Key** — For authenticated servers (optional, untested)
- **Accept self-signed certificates** — For self-hosted servers with self-signed certs
- **Topics** — Add topics to subscribe to
- **History Limit** — Max notifications per topic (default: 100)

## Requirements

- GNOME Shell 50+
- GTK4
- libadwaita
- libsoup3

## Development

### Running shexli (extension linter)

`shexli` (0.2.1 — the only release) segfaults if installed fresh, because `pip install shexli` pulls `tree-sitter==0.26.0`, which has a memory-corruption bug that crashes the analyzer on larger modules (SIGSEGV/Bus error, no findings). Pin the known-good version:

```bash
python3 -m venv venv
. venv/bin/activate
pip install shexli
pip install "tree-sitter==0.25.2"   # workaround for shexli crash (see below)
shexli <extension-folder-or-zip>
```

This is a known upstream issue — `tree-sitter` 0.25.1/0.25.2 analyze extensions cleanly and repeatably; 0.26.0 crashes (memory corruption, symptom location varies per run). Not a bug in this extension.

### CI packaging (extensions.gnome.org)

`gnome-extensions pack` (as wrapped by the CI action) only includes standard files automatically (`metadata.json`, `extension.js`, `prefs.js`, `stylesheet.css`, `schemas/`). Every other file must be listed in the workflow's `extra-source`. The first EGO submission's zip was missing all module JS and LICENSE because of this, and `extra-source` files are flattened to their basename — so never pass the schema XML via `extra-source` (it must stay under `schemas/`). The workflow verifies the packaged zip's contents after building; keep `extra-source` and the packed file list in sync when adding files.

## License

GNU General Public License v3.0 or later — see [LICENSE](LICENSE) for details.

## Links

- [ntfy Website](https://ntfy.sh)
- [ntfy Documentation](https://ntfy.sh/docs)
- [GitHub Repository](https://github.com/rghvdberg/ntfy-indicator)
- [GNOME Shell Extensions](https://extensions.gnome.org)
