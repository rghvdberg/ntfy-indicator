#!/bin/bash
# End-to-end integration test on a nested GNOME Shell session.
# Runs the extension in an isolated nested session, drives NTFY_TEST_SERVER,
# and asserts store state locally. Disposable topic per run.
set -euo pipefail

# Get the project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

source tests/config.sh

[ -n "$NTFY_TEST_SERVER" ] || { echo "Set NTFY_TEST_SERVER, e.g. NTFY_TEST_SERVER=https://ntfy.example.com $0"; exit 1; }

BASE="${NTFY_TEST_SERVER%/}"
TOPIC="ext-test-$(date +%s)"
URL="$BASE/$TOPIC"
SAFE=$(echo -n "$URL" | sed 's/[^a-zA-Z0-9]/_/g')

# Create isolated environment for nested shell
NESTED_HOME="$(mktemp -d)"
NESTED_XDG_DATA="$NESTED_HOME/.local/share"
NESTED_XDG_CONFIG="$NESTED_HOME/.config"
STORE="$NESTED_XDG_DATA/ntfy/$SAFE.json"
BUS_ADDR_FILE="$NESTED_HOME/bus-addr"

# Cleanup on exit
cleanup() {
    echo "=> cleaning up nested session"
    pkill -f "history-dialo[g].js" 2>/dev/null || true
    [ -n "${NESTED_PID:-}" ] && kill "$NESTED_PID" 2>/dev/null || true
    rm -rf "$NESTED_HOME"
}
trap cleanup EXIT

# Install extension in isolated environment
echo "=> installing extension in nested environment"
EXT_ID="ntfy-indicator@rghvdberg"
ZIP_FILE="$PROJECT_ROOT/build/$EXT_ID.shell-extension.zip"

if [ ! -f "$ZIP_FILE" ]; then
    echo "=> packing extension"
    mkdir -p "$PROJECT_ROOT/build"
    gnome-extensions pack -f -o build \
        --extra-source=api.js --extra-source=attachment-downloader.js \
        --extra-source=history-dialog.js --extra-source=indicator.js \
        --extra-source=notification-store.js --extra-source=subscription-manager.js \
        --extra-source=utils.js --extra-source=LICENSE --extra-source=icons .
fi

# Create isolated environment
cd "$NESTED_HOME"
export HOME="$NESTED_HOME"
export XDG_DATA_HOME="$NESTED_XDG_DATA"
export XDG_CONFIG_HOME="$NESTED_XDG_CONFIG"

# Copy and install
cp "$ZIP_FILE" .
gnome-extensions install -f "$(basename "$ZIP_FILE")"

# Verify installation by checking the directory exists
if [ ! -d "$XDG_DATA_HOME/gnome-shell/extensions/$EXT_ID" ]; then
    echo "ERROR: Extension not installed"
    exit 1
fi
echo "Extension installed successfully"

# Compile and install schemas
EXT_DIR="$XDG_DATA_HOME/gnome-shell/extensions/$EXT_ID"
mkdir -p "$XDG_DATA_HOME/glib-2.0/schemas"
cp "$EXT_DIR/schemas/"*.gschema.xml "$XDG_DATA_HOME/glib-2.0/schemas/"
glib-compile-schemas "$XDG_DATA_HOME/glib-2.0/schemas"

# Enable via dconf on the nested session's own bus (the exact pattern that
# works when done from a terminal inside the session). `--devkit` also writes a
# marker that disables all user extensions at startup; remove it.
rm -f "/run/user/$(id -u)/gnome-shell-disable-extensions" || true

# Start nested GNOME Shell wrapped in its own D-Bus session (per
# https://gjs.guide/extensions/development/debugging.html), but have the
# wrapper hand its bus address to us so the test driver joins the SAME bus
# (and dconf service) as the extension.
echo "=> starting nested GNOME Shell"
dbus-run-session bash -c '
  gsettings set org.gnome.shell enabled-extensions "[\"$0\"]"
  echo "$DBUS_SESSION_BUS_ADDRESS" > "$1"
  exec gnome-shell --devkit --wayland
' "$EXT_ID" "$BUS_ADDR_FILE" >/tmp/nested-shell.log 2>&1 &
NESTED_PID=$!

# Wait for the bus address, then join that session.
for i in $(seq 1 20); do [ -s "$BUS_ADDR_FILE" ] && break; sleep 0.5; done
export DBUS_SESSION_BUS_ADDRESS="$(cat "$BUS_ADDR_FILE")"

# Wait for GNOME Shell to be ready
echo "=> waiting for GNOME Shell to start"
for i in $(seq 1 15); do
    if gdbus wait --session --dest org.gnome.Shell >/dev/null 2>&1; then
        echo "   GNOME Shell is running"
        break
    fi
    sleep 1
done

# Configure extension
echo "=> configuring extension"
gsettings set org.gnome.shell.extensions.ntfy-indicator server "'$BASE'"
gsettings set org.gnome.shell.extensions.ntfy-indicator accept-self-signed "$NTFY_TEST_SELF_SIGNED"
gsettings set org.gnome.shell.extensions.ntfy-indicator channels "['$TOPIC']"
sleep 5

# Helper functions
ok() { if [ "$1" = "$2" ]; then echo "ok - $3"; PASS=$((PASS+1)); else echo "FAIL - $3 (want [$2] got [$1])"; FAIL=$((FAIL+1)); fi; }

gs() { # set a gsettings key
    gsettings set org.gnome.shell.extensions.ntfy-indicator "$1" "$2"
}

# Store query helper (runs locally in nested environment)
q() {
    python3 - "$@" <<PY
import json, os, sys
path = "$STORE"
if not os.path.exists(path):
    print('NOFILE'); sys.exit(0)
d = json.load(open(path))
q = sys.argv[1]
if q == 'rows': print(len(d['notifications']))
elif q == 'unread': print(sum(1 for n in d['notifications'] if n.get('new')))
elif q == 'has': print(int(any(n['id'] == sys.argv[2] for n in d['notifications'])))
elif q == 'seen': print(int(sys.argv[2] in d['seenIds']))
elif q == 'new':
    n = [x for x in d['notifications'] if x['id'] == sys.argv[2]]
    print(int(bool(n and n[0].get('new'))))
elif q == 'find':
    n = [x for x in d['notifications'] if sys.argv[2] in x.get('message', '')]
    print(n[-1]['id'] if n else 'NONE')
PY
}

pub() { curl -sk -d "$1" ${2:+-H "Title: $2"} "$URL" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])"; }

PASS=0; FAIL=0

echo "=== publish + store ==="
ID1=$(pub "plain text" "text")
ID2=$(pub "to be deleted" "delete-me")
ID3=$(curl -sk -T "$PROJECT_ROOT/tests/fixtures/img01.png" -H "Filename: img01.png" -H "Title: image" -H "Message: pic" "$URL" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
sleep 5
ok "$(q rows)" 3 "three rows stored"
ok "$(q unread)" 3 "unread 3"

echo "=== server delete ==="
curl -sk -X DELETE "$URL/$ID2" -o /dev/null
sleep 5
ok "$(q has $ID2)" 0 "deleted row gone"
ok "$(q seen $ID2)" 1 "deleted id in seenIds"
ok "$(q unread)" 2 "unread drops to 2"

echo "=== server clear ==="
curl -sk -X PUT "$URL/$ID3/clear" -o /dev/null
sleep 5
ok "$(q has $ID3)" 1 "cleared row stays"
ok "$(q new $ID3)" 0 "cleared row marked read"
ok "$(q unread)" 1 "unread drops to 1"

echo "=== wipe + replay suppression ==="
rm -f "$STORE"
gs channels "@as []"
sleep 2
gs channels "['$TOPIC']"
sleep 6
ok "$(q has $ID1)" 1 "untouched message re-added on replay"
ok "$(q new $ID1)" 1 "re-added message is new"
ok "$(q has $ID2)" 0 "deleted message stays suppressed"
ok "$(q has $ID3)" 0 "cleared message stays suppressed"
ok "$(q unread)" 1 "unread 1 after replay"

echo "=== burst (no lost writes) ==="
for i in $(seq 1 50); do curl -sk -d "burst $i" "$URL" >/dev/null; done
sleep 8
ok "$(q rows)" 51 "burst: 51 rows"
ok "$(q unread)" 51 "burst: 51 unread"

echo "=== muted topic: stored + counted, not dropped ==="
gs muted-topics "{\"$URL\": 9999999999}"
IDM=$(pub "muted msg" "muted")
sleep 5
ok "$(q has $IDM)" 1 "muted message stored (not dropped)"
ok "$(q new $IDM)" 1 "muted message counted as unread"
gs muted-topics "{}"

echo "=== history limit trim ==="
gs history-limit 10
gs channels "@as []"; sleep 2; gs channels "['$TOPIC']"; sleep 3
for i in $(seq 1 3); do curl -sk -d "trim $i" "$URL" >/dev/null; done
sleep 6
ok "$(q rows)" 10 "limit trims to 10 newest"

echo "=== history limit grow (100) ==="
gs history-limit 100
gs channels "@as []"; sleep 2; gs channels "['$TOPIC']"; sleep 3
for i in $(seq 1 5); do curl -sk -d "grow $i" "$URL" >/dev/null; done
sleep 6
ok "$(q rows)" 15 "limit 100: grows to 15 (was capped at 10)"

echo "=== history limit shrink back to 10 ==="
gs history-limit 10
gs channels "@as []"; sleep 2; gs channels "['$TOPIC']"; sleep 3
for i in $(seq 1 3); do curl -sk -d "shrink $i" "$URL" >/dev/null; done
sleep 6
ok "$(q rows)" 10 "limit 10: re-trims to 10 on next write"

echo "=== tls toggle off must stop delivery (session-resumption regression) ==="
if [ "$NTFY_TEST_SELF_SIGNED" = "true" ]; then
    gs accept-self-signed true
    sleep 4
    IDT1=$(pub "tls off 1" "tls")
    gs accept-self-signed false
    sleep 5
    ok "$(q has $IDT1)" 0 "publish right after toggle-off not delivered"
    sleep 25
    IDT2=$(pub "tls off 2" "tls")
    sleep 6
    ok "$(q has $IDT2)" 0 "publish 30s later while off not delivered"
    gs accept-self-signed true
    sleep 6
    ok "$(q has $IDT1)" 1 "missed message delivered once policy restored"
else
    echo "skip - tls toggle block needs a self-signed server"
fi

echo "=== dbus: dialog service (shell exports, dialog calls) ==="
# The extension owns com.github.rghvdberg.ntfy_indicator while enabled
DEST=com.github.rghvdberg.ntfy_indicator
OBJ=/com/github/rghvdberg/ntfy_indicator/service
IFACE=$DEST.Service

# Start history dialog (on the nested shell's display)
WL_DISPLAY=$(grep -o "Wayland display name '[^']*'" /tmp/nested-shell.log | head -1 | sed "s/.*'//;s/'//")
export WAYLAND_DISPLAY="$WL_DISPLAY"
nohup gjs -m "$XDG_DATA_HOME/gnome-shell/extensions/$EXT_ID/history-dialog.js" "$BASE" "$TOPIC" "$TOPIC" false "$XDG_DATA_HOME/gnome-shell/extensions/$EXT_ID" >/tmp/ntfy-dialog.log 2>&1 &
sleep 4
ok "$(pgrep -c -f 'history-dialo[g].js' || true)" 1 "history dialog process running"

# Check service exports
INTRO=$(gdbus call --session --dest $DEST --object-path $OBJ --method org.freedesktop.DBus.Introspectable.Introspect 2>&1)
for m in MarkRead Delete MarkAllRead DeleteAll Mute Unmute Publish; do
    echo "$INTRO" | grep -q "$m"; ok $? 0 "service exports method $m"
done

# Test D-Bus methods
IDR=$(pub "dbus read me" "dbus-read")
IDD=$(pub "dbus delete me" "dbus-del")
sleep 5
ok "$(q new $IDR)" 1 "pre: markRead target unread"
ok "$(q has $IDD)" 1 "pre: delete target stored"

gdbus call --session --dest $DEST --object-path $OBJ --method $IFACE.MarkRead "'$URL'" "'$IDR'" >/dev/null
sleep 2
ok "$(q has $IDR)" 1 "MarkRead keeps row"
ok "$(q new $IDR)" 0 "MarkRead marks row read"
ok "$(q seen $IDR)" 1 "MarkRead persists id in seenIds"

gdbus call --session --dest $DEST --object-path $OBJ --method $IFACE.Delete "'$URL'" "'$IDD'" >/dev/null
sleep 2
ok "$(q has $IDD)" 0 "Delete removes row"
ok "$(q seen $IDD)" 1 "Delete persists id in seenIds"

gdbus call --session --dest $DEST --object-path $OBJ --method $IFACE.Publish "'$URL'" "'via gdbus'" "''" '{}' >/dev/null
sleep 6
IDP=$(q find "via gdbus")
[ "$IDP" != "NONE" ]; ok $? 0 "Publish round-trips into store"
ok "$(q new $IDP)" 1 "published message is unread"

gdbus call --session --dest $DEST --object-path $OBJ --method $IFACE.Mute "'$URL'" >/dev/null
MT=$(gsettings get org.gnome.shell.extensions.ntfy-indicator muted-topics)
echo "$MT" | grep -q "$URL"; ok $? 0 "Mute writes muted-topics"
gdbus call --session --dest $DEST --object-path $OBJ --method $IFACE.Unmute "'$URL'" >/dev/null
MT=$(gsettings get org.gnome.shell.extensions.ntfy-indicator muted-topics)
ok "$MT" "'{}'" "Unmute clears muted-topics"

echo "--- dialog-style client call (Gio.DBusConnection.call arg-count regression) ---"
IDC=$(pub "client read me" "client-read")
sleep 5
ok "$(q new $IDC)" 1 "pre: client-call target unread"
cat > /tmp/ntfy-dbus-client.js <<'EOF'
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const [topicUrl, id] = ARGV;
Gio.DBus.session.call(
  'com.github.rghvdberg.ntfy_indicator',
  '/com/github/rghvdberg/ntfy_indicator/service',
  'com.github.rghvdberg.ntfy_indicator.Service',
  'MarkRead',
  new GLib.Variant('(ss)', [topicUrl, id]),
  null,
  Gio.DBusCallFlags.NONE,
  -1,
  null,
  null
);
print('sent');
EOF
CLIENT_OUT=$(gjs -m /tmp/ntfy-dbus-client.js "$URL" "$IDC")
ok "$CLIENT_OUT" "sent" "dialog-style call dispatches without throwing"
sleep 2
ok "$(q new $IDC)" 0 "dialog-style MarkRead marks row read"

pkill -f 'history-dialo[g].js' 2>/dev/null || true

echo "=== reset (throwaway: leave no channels) ==="
gs history-limit 100
gs channels "@as []"

echo
echo "$PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]