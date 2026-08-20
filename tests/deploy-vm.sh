#!/bin/bash
# Pack the extension zip (same file list as .github/workflows/build-extension.yml)
# and install it on the test VM like a user would: gnome-extensions install,
# then a session restart so the shell picks it up.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/config.sh

EXT_ID="ntfy-indicator@rghvdberg"
ZIP="build/$EXT_ID.shell-extension.zip"

IP=$(vm_ip)
[ -n "$IP" ] || { echo "no IP for VM '$NTFY_TEST_VM' (is it running?)"; exit 1; }
TARGET="$NTFY_TEST_VM_USER@$IP"

echo "=> pack zip"
mkdir -p build
rm -f "$ZIP"
gnome-extensions pack -f -o build \
  --extra-source=api.js --extra-source=attachment-downloader.js \
  --extra-source=history-dialog.js --extra-source=indicator.js \
  --extra-source=notification-store.js --extra-source=subscription-manager.js \
  --extra-source=utils.js --extra-source=LICENSE --extra-source=icons . >/dev/null

echo "=> install on $TARGET"
scp "${SSH_OPTS[@]}" "$ZIP" "$TARGET:/tmp/ntfy-ext.zip"
ssh "${SSH_OPTS[@]}" "$TARGET" "mkdir -p ~/ntfy-tests"
scp "${SSH_OPTS[@]}" tests/0*.js tests/helpers.js "$TARGET:~/ntfy-tests/" 2>/dev/null || true

ssh "${SSH_OPTS[@]}" "$TARGET" "${VM_ENV}bash -s" <<EOF
set -e
gnome-extensions install --force /tmp/ntfy-ext.zip
EXT=~/.local/share/gnome-shell/extensions/$EXT_ID
mkdir -p ~/.local/share/glib-2.0/schemas
cp "\$EXT/schemas/"*.gschema.xml ~/.local/share/glib-2.0/schemas/
glib-compile-schemas ~/.local/share/glib-2.0/schemas
mkdir -p ~/.local/share/icons/hicolor/scalable/apps
cp "\$EXT/icons/ntfy.svg" ~/.local/share/icons/hicolor/scalable/apps/ntfy.svg
gtk-update-icon-cache -q -t ~/.local/share/icons/hicolor 2>/dev/null || true
mkdir -p ~/.local/share/applications
printf '[Desktop Entry]\nType=Application\nName=ntfy History\nIcon=ntfy\nNoDisplay=true\n' > ~/.local/share/applications/com.ntfy.HistoryDialog.desktop
# persist enablement so the restarted session auto-loads the extension
KEY="/org/gnome/shell/enabled-extensions"
CUR=\$(dconf read "\$KEY")
if [ -z "\$CUR" ] || [ "\$CUR" = "[]" ] || [ "\$CUR" = "@as []" ]; then
  dconf write "\$KEY" "['$EXT_ID']"
elif echo "\$CUR" | grep -q "$EXT_ID"; then
  :
else
  dconf write "\$KEY" "\${CUR%]}, '$EXT_ID']"
fi
rm -f /tmp/ntfy-ext.zip
EOF

echo "=> restarting session (GDM)"
if ! ssh "${SSH_OPTS[@]}" "$TARGET" "sudo -n systemctl restart gdm" 2>/dev/null; then
  echo "need one-time sudo setup on the VM:"
  echo "  echo '$NTFY_TEST_VM_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart gdm' | sudo tee /etc/sudoers.d/ntfy-test"
  echo "(vm-create.sh VMs already have full NOPASSWD sudo)"
  exit 1
fi

echo "=> waiting for session + extension"
sleep 12
STATE=""
for _ in $(seq 1 12); do
  STATE=$(ssh "${SSH_OPTS[@]}" "$TARGET" "${VM_ENV}gnome-extensions info $EXT_ID 2>/dev/null | grep '^  State'" || true)
  echo "$STATE" | grep -q "ACTIVE" && break
  sleep 5
done
echo "  ${STATE:-not found}"
echo "$STATE" | grep -q "ACTIVE"
