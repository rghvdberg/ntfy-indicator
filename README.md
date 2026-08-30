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

### From GitHub Releases (Recommended)

1. Download the latest `.shell-extension.zip` artifact from the [GitHub Actions](https://github.com/rghvdberg/ntfy-indicator/actions) or [Releases](https://github.com/rghvdberg/ntfy-indicator/releases) page
2. Open GNOME Extensions app (or `gnome-extensions-app`)
3. Click the gear icon → "Install from file..."
4. Select the downloaded `.zip` file
5. Toggle the extension on

### From Source

```bash
# Clone the repo
git clone https://github.com/rghvdberg/ntfy-indicator.git
cd ntfy-indicator

# Pack the extension
gnome-extensions pack -f -o build \
  --extra-source=api.js --extra-source=attachment-downloader.js \
  --extra-source=history-dialog.js --extra-source=indicator.js \
  --extra-source=notification-store.js --extra-source=subscription-manager.js \
  --extra-source=utils.js --extra-source=LICENSE --extra-source=icons .

# Install the packed zip
gnome-extensions install -f build/ntfy-indicator@rghvdberg.shell-extension.zip

# Enable the extension
gnome-extensions enable ntfy-indicator@rghvdberg

# Restart GNOME Shell to load the extension
# X11: press Alt+F2, type 'r', press Enter
# Wayland: log out and log back in
```

### Configuration

Open the extension preferences to configure:

- **Server URL** — Base URL of your ntfy server (default: `https://ntfy.sh`)
- **Accept self-signed certificates** — For self-hosted servers with self-signed certs
- **Topics** — Add topics to subscribe to (e.g., `https://ntfy.sh/my-topic` or just `my-topic`)
- **History Limit** — Max notifications per topic (default: 100)

**Note**: API keys are supported in the code but not yet tested. If you need authenticated servers, please test and report back.

## Requirements

- GNOME Shell 50+
- For nested shell development: `mutter-dev-bin` package (provides `mutter-devkit` for window display)

```bash
# Install development dependency for nested shell
sudo apt install mutter-dev-bin
```

## Development

See the documentation for detailed guides:

- [CONTRIBUTING.md](CONTRIBUTING.md) - Development guidelines, testing, and CI/CD
- [ARCHITECTURE.md](ARCHITECTURE.md) - Technical architecture and module overview

## License

GNU General Public License v3.0 or later — see [LICENSE](LICENSE) for details.

## Links

- [ntfy Website](https://ntfy.sh)
- [ntfy Documentation](https://ntfy.sh/docs)
- [GitHub Repository](https://github.com/rghvdberg/ntfy-indicator)
- [GNOME Shell Extensions](https://extensions.gnome.org)
