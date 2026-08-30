#!/bin/bash
# Run nested GNOME Shell with ntfy extension on local machine in an isolated environment

set -e

# Get the project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

EXT_ID="ntfy-indicator@rghvdberg"
BUILD_DIR="$PROJECT_ROOT/build"
ZIP_FILE="$BUILD_DIR/$EXT_ID.shell-extension.zip"

# Pack extension if it doesn't exist
if [ ! -f "$ZIP_FILE" ]; then
    echo "=> packing extension"
    mkdir -p "$BUILD_DIR"
    gnome-extensions pack -f -o build \
        --extra-source=api.js --extra-source=attachment-downloader.js \
        --extra-source=history-dialog.js --extra-source=indicator.js \
        --extra-source=notification-store.js --extra-source=subscription-manager.js \
        --extra-source=utils.js --extra-source=LICENSE --extra-source=icons .
fi

# Create isolated environment and set it up
NESTED_HOME="$(mktemp -d)"
export HOME="$NESTED_HOME"
export XDG_DATA_HOME="$NESTED_HOME/.local/share"
export XDG_CONFIG_HOME="$NESTED_HOME/.config"

echo "=> installing extension in isolated environment"
# Copy zip to nested environment and install
cp "$ZIP_FILE" "$NESTED_HOME/"
cd "$NESTED_HOME"
gnome-extensions install -f "$(basename "$ZIP_FILE")"

# Copy and compile schemas
EXT_DIR="$XDG_DATA_HOME/gnome-shell/extensions/$EXT_ID"
if [ ! -d "$EXT_DIR" ]; then
    echo "Error: Extension not installed"
    exit 1
fi

echo "=> compiling schemas"
mkdir -p "$XDG_DATA_HOME/glib-2.0/schemas"
cp "$EXT_DIR/schemas/"*.gschema.xml "$XDG_DATA_HOME/glib-2.0/schemas/"
glib-compile-schemas "$XDG_DATA_HOME/glib-2.0/schemas"

# `--devkit` mode writes this marker to disable all user extensions at
# startup. Remove it so our extension can load.
rm -f "/run/user/$(id -u)/gnome-shell-disable-extensions" || true

# Clean up on exit
cleanup() {
    echo "=> cleaning up nested session"
    pkill -f "gnome-shell.*wayland" 2>/dev/null || true
    rm -rf "$NESTED_HOME"
}
trap cleanup EXIT

echo "=> starting nested GNOME Shell"
echo "   Press Ctrl+C to stop"
# Enable the extension inside the nested session's own D-Bus bus (the same
# pattern that works when enabled from a terminal inside the session), then run
# the shell on that bus per the documented --devkit approach.
dbus-run-session bash -c '
  gsettings set org.gnome.shell enabled-extensions "[\"$0\"]"
  echo "   enabled: $(gsettings get org.gnome.shell enabled-extensions)"
  exec gnome-shell --devkit --wayland
' "$EXT_ID"