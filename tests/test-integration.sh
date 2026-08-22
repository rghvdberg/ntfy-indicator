#!/bin/bash
# End-to-end integration test on a throwaway VM.
# Deploys via tests/deploy-vm.sh, drives NTFY_TEST_SERVER, asserts store state
# over SSH. Disposable topic per run; VM state is not preserved (throwaway).
set -uo pipefail
cd "$(dirname "$0")/.."
source tests/config.sh

[ -n "$NTFY_TEST_SERVER" ] || { echo "Set NTFY_TEST_SERVER, e.g. NTFY_TEST_SERVER=https://ntfy.example.com $0"; exit 1; }

BASE="${NTFY_TEST_SERVER%/}"
TOPIC="ext-test-$(date +%s)"
URL="$BASE/$TOPIC"
SAFE=$(echo -n "$URL" | sed 's/[^a-zA-Z0-9]/_/g')
STORE=".local/share/ntfy/$SAFE.json"

IP=$(vm_ip)
[ -n "$IP" ] || { echo "VM '$NTFY_TEST_VM' not running (tests/vm-create.sh or virsh start)"; exit 1; }
TARGET="$NTFY_TEST_VM_USER@$IP"

PASS=0; FAIL=0
ok() { if [ "$1" = "$2" ]; then echo "ok - $3"; PASS=$((PASS+1)); else echo "FAIL - $3 (want [$2] got [$1])"; FAIL=$((FAIL+1)); fi; }

gs() { # set a gsettings key on the VM session bus (value quoted for remote shell + GVariant)
    ssh "${SSH_OPTS[@]}" "$TARGET" "${VM_ENV}gsettings set org.gnome.shell.extensions.ntfy-indicator $1 \"$2\"" >/dev/null
}

ssh "${SSH_OPTS[@]}" "$TARGET" 'cat > /tmp/storeq.py' <<'PY'
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
q() { ssh "${SSH_OPTS[@]}" "$TARGET" "python3 /tmp/storeq.py ~/$STORE $1 ${2:-}"; }

pub() { curl -sk -d "$1" ${2:+-H "Title: $2"} "$URL" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])"; }

echo "=== deploy ==="
./tests/deploy-vm.sh >/tmp/deploy-vm.log 2>&1 || { echo "deploy FAILED"; cat /tmp/deploy-vm.log; exit 1; }
ok 0 0 "extension ACTIVE after deploy"

gs server "'$BASE'"
gs accept-self-signed "$NTFY_TEST_SELF_SIGNED"
gs channels "['$TOPIC']"
sleep 3

echo "=== publish + store ==="
ID1=$(pub "plain text" "text")
ID2=$(pub "to be deleted" "delete-me")
ID3=$(curl -sk -T tests/fixtures/img01.png -H "Filename: img01.png" -H "Title: image" -H "Message: pic" "$URL" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
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
ssh "${SSH_OPTS[@]}" "$TARGET" "rm -f ~/$STORE"
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
# Only meaningful on self-signed servers: with a valid CA chain there is no
# policy difference to observe. Requires NTFY_TEST_SELF_SIGNED=true.
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

echo "=== lifecycle: disable/enable ==="
ssh "${SSH_OPTS[@]}" "$TARGET" "${VM_ENV}gnome-extensions disable ntfy-indicator@rghvdberg; sleep 1; gnome-extensions enable ntfy-indicator@rghvdberg; sleep 3; gnome-extensions info ntfy-indicator@rghvdberg | grep -E '^  State'" | grep -q "ACTIVE"
ok $? 0 "ACTIVE after disable/enable"
ERRS=$(ssh "${SSH_OPTS[@]}" "$TARGET" "${VM_ENV}journalctl --user -b --since '3 minutes ago' --no-pager 2>/dev/null | grep -iE 'ntfy-indicator@rghvdberg.*(Error|TypeError)' | wc -l")
ok "$ERRS" 0 "no extension errors in journal"

echo "=== reset (throwaway: leave no channels) ==="
gs history-limit 100
gs channels "@as []"

echo
echo "$PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
