#!/bin/bash
# Sync the ntfy Indicator extension into the ntfy-dev VM and reload it.
# Edit files on the host, run this; the extension is reloaded remotely (no
# manual steps inside the VM needed once the first-time discovery is done).
#
# Configuration (required):
#   NTFY_DEV_KEY  - Path to your SSH private key for the VM
#   NTFY_DEV_VM   - VM name (default: ntfy-dev)
#   NTFY_DEV_USER - SSH user on VM (default: tester)
#
# Example:
#   NTFY_DEV_KEY=~/.ssh/my-key ./vm-sync.sh
#
# Copyright 2026 Contributors
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; see the GNU General Public License for details.
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.
set -euo pipefail

# Get the project root (parent of tests directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

VM="${NTFY_DEV_VM:-ntfy-dev}"
VM_USER="${NTFY_DEV_USER:-tester}"
# SSH_KEY must be set via NTFY_DEV_KEY environment variable
SSH_KEY="${NTFY_DEV_KEY:-}"
EXT_ID="ntfy-indicator@rghvdberg"

# Validate SSH_KEY is configured
if [ -z "$SSH_KEY" ]; then
    echo "ERROR: SSH_KEY not configured. Set NTFY_DEV_KEY environment variable" >&2
    echo "Example: NTFY_DEV_KEY=~/.ssh/my-key ./vm-sync.sh" >&2
    exit 1
fi

# Auto-detect VM IP (NAT address from libvirt)
VM_IP=$(virsh domifaddr "$VM" | awk '/ipv4/ {print $4}' | cut -d/ -f1)
if [ -z "$VM_IP" ]; then
    echo "ERROR: could not determine IP for VM '$VM' (is it running?)" >&2
    exit 1
fi
echo "VM '$VM' at $VM_IP"

SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)

# 1. Pack the extension locally
echo "=> packing extension"
if [ ! -d "build" ]; then
    mkdir -p build
fi
gnome-extensions pack -f -o build \
    --extra-source=api.js --extra-source=attachment-downloader.js \
    --extra-source=history-dialog.js --extra-source=indicator.js \
    --extra-source=notification-store.js --extra-source=subscription-manager.js \
    --extra-source=utils.js --extra-source=LICENSE --extra-source=icons .

# Find the packed zip
ZIP_FILE=$(ls build/${EXT_ID}.shell-extension.zip 2>/dev/null | head -1)
if [ -z "$ZIP_FILE" ]; then
    echo "ERROR: could not find packed extension zip" >&2
    exit 1
fi
echo "   packed: $ZIP_FILE"

# 2. Copy the zip to the VM
echo "=> transferring zip to VM"
scp "${SSH_OPTS[@]}" "$ZIP_FILE" "$VM_USER@$VM_IP:/tmp/"

# 3. Install on the VM (handles schema compilation, enabling, dconf)
echo "=> installing extension on VM"
ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_IP" "gnome-extensions install -f /tmp/$(basename "$ZIP_FILE") && gnome-extensions info $EXT_ID 2>&1 | grep -E 'State|Enabled' || true"

# 4. Restart GNOME session to ensure clean reload
echo "=> restarting VM session (GDM) for a clean reload"
ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_IP" "sudo systemctl restart gdm"

echo "=> waiting for session restart + extension to become active"
STATE=""
for i in $(seq 1 12); do
    STATE=$(ssh "${SSH_OPTS[@]}" "$VM_USER@$VM_IP" "gnome-extensions info $EXT_ID 2>/dev/null | grep -E 'State|Enabled'" || true)
    echo "$STATE" | grep -q "ACTIVE" && break
    echo "   waiting... ($i/12)"
    sleep 5
done
echo "   $STATE"

if ! echo "$STATE" | grep -q "ACTIVE"; then
    echo "WARNING: Extension may not be fully loaded. Check VM console." >&2
fi

echo
echo "Done. The extension should now be enabled and polling 'testing' in the VM."