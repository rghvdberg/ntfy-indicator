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
```

### Configuration

Open the extension preferences to configure:

- **Server URL** — Base URL of your ntfy server (default: `https://ntfy.sh`)
- **API Key** — For authenticated servers (optional)
- **Accept self-signed certificates** — For self-hosted servers with self-signed certs
- **Topics** — Add topics to subscribe to
- **History Limit** — Max notifications per topic (default: 100)

## Requirements

- GNOME Shell 50+
- GTK4
- libadwaita
- libsoup3

## License

GNU General Public License v3.0 or later — see [LICENSE](LICENSE) for details.

## Links

- [ntfy Website](https://ntfy.sh)
- [ntfy Documentation](https://ntfy.sh/docs)
- [GitHub Repository](https://github.com/rghvdberg/ntfy-indicator)
- [GNOME Shell Extensions](https://extensions.gnome.org)
