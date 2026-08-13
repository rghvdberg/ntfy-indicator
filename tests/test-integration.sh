#!/bin/bash
# End-to-end integration test on the ntfy-dev VM.
# Deploys via vm-sync.sh, drives the real dev server, and asserts store state
# over SSH. Uses a disposable topic per run (deletes are append-only).
set -uo pipefail
cd "$(dirname "$0")/.."

VM=ntfy-dev
SSH_KEY="$HOME/.ssh/cupcakeathome"
BASE=https://server.cup.cake:12707
TOPIC="ext-test-$(date +%s)"
URL="$BASE/$TOPIC"
SAFE=$(echo -n "$URL" | sed 's/[^a-zA-Z0-9]/_/g')
STORE=".local/share/ntfy/$SAFE.json"

VM_IP=$(virsh domifaddr "$VM" 2>/dev/null | awk '/ipv4/ {print $4}' | cut -d/ -f1)
if [ -z "$VM_IP" ]; then echo "VM '$VM' not running (virsh start $VM)"; exit 1; fi
SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null rob@$VM_IP"

PASS=0; FAIL=0
ok() { if [ "$1" = "$2" ]; then echo "ok - $3"; PASS=$((PASS+1)); else echo "FAIL - $3 (want [$2] got [$1])"; FAIL=$((FAIL+1)); fi; }

gs() { # set a gsettings key on the VM session bus (value quoted for remote shell + GVariant)
    $SSH "export XDG_RUNTIME_DIR=/run/user/\$(id -u); export DBUS_SESSION_BUS_ADDRESS=unix:path=\$XDG_RUNTIME_DIR/bus; gsettings set org.gnome.shell.extensions.ntfy-indicator $1 \"$2\"" >/dev/null
}

$SSH 'cat > /tmp/storeq.py' <<'PY'
import json, os, sys
path = os.path.expanduser(sys.argv[1])
if not os.path.exists(path):
    print('NOFILE'); sys.exit(0)
d = json.load(open(path))
q = sys.argv[2]
if q == 'rows': print(len(d['notifications']))
elif q == 'unread': print(sum(1 for n in d['notifications'] if n.get('new')))
elif q == 'has': print(int(any(n['id'] == sys.argv[3] for n in d['notifications'])))
elif q == 'seen': print(int(sys.argv[3] in d['seenIds']))
elif q == 'new':
    n = [x for x in d['notifications'] if x['id'] == sys.argv[3]]
    print(int(bool(n and n[0].get('new'))))
PY
q() { $SSH "python3 /tmp/storeq.py ~/$STORE $1 ${2:-}"; }

pub() { curl -sk -d "$1" ${2:+-H "Title: $2"} "$URL" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])"; }

echo "=== deploy ==="
./vm-sync.sh > /tmp/vm-sync.log 2>&1 && tail -1 /tmp/vm-sync.log || { echo "vm-sync FAILED"; cat /tmp/vm-sync.log; exit 1; }
grep -q "State: ACTIVE" /tmp/vm-sync.log; ok $? 0 "extension ACTIVE after deploy"

gs server "'$BASE'"
gs accept-self-signed true
gs channels "['$TOPIC']"
sleep 3

echo "=== publish + store ==="
ID1=$(pub "plain text" "text")
ID2=$(pub "to be deleted" "delete-me")
ID3=$(curl -sk -T test-images/img01.png -H "Filename: img01.png" -H "Title: image" -H "Message: pic" "$URL" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
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
$SSH "rm -f ~/$STORE"
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

echo "=== history limit trim ==="
gs history-limit 10
gs channels "@as []"; sleep 2; gs channels "['$TOPIC']"; sleep 3
for i in $(seq 1 3); do curl -sk -d "trim $i" "$URL" >/dev/null; done
sleep 6
ok "$(q rows)" 10 "limit trims to 10 newest"

echo "=== lifecycle: disable/enable ==="
$SSH "export XDG_RUNTIME_DIR=/run/user/\$(id -u); export DBUS_SESSION_BUS_ADDRESS=unix:path=\$XDG_RUNTIME_DIR/bus; gnome-extensions disable ntfy-indicator@rghvdberg; sleep 1; gnome-extensions enable ntfy-indicator@rghvdberg; sleep 3; gnome-extensions info ntfy-indicator@rghvdberg | grep -E '^  State'" | grep -q "ACTIVE"
ok $? 0 "ACTIVE after disable/enable"
ERRS=$($SSH "export XDG_RUNTIME_DIR=/run/user/\$(id -u); export DBUS_SESSION_BUS_ADDRESS=unix:path=\$XDG_RUNTIME_DIR/bus; journalctl --user -b --since '3 minutes ago' --no-pager 2>/dev/null | grep -iE 'ntfy-indicator@rghvdberg.*(Error|TypeError)' | wc -l")
ok "$ERRS" 0 "no extension errors in journal"

echo "=== reset ==="
gs history-limit 100
gs channels "['testing']"

echo
echo "$PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
