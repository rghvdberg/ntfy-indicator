# Shared test configuration. Override via environment, e.g.:
#   NTFY_TEST_SERVER=https://ntfy.example.com ./tests/run.sh
#
# NTFY_TEST_SERVER        ntfy server URL (required for api + integration tests)
# NTFY_TEST_SELF_SIGNED   "true" if the server uses a self-signed cert
# NTFY_TEST_VM            virsh domain name (default: ntfy-test)
# NTFY_TEST_VM_IP         set to skip virsh IP autodetect (any ssh-reachable GNOME host)
# NTFY_TEST_VM_USER       ssh/desktop user on the VM (default: tester, created by vm-create.sh)
# NTFY_TEST_SSH_KEY       private key path (default: tests/.vm-key, auto-generated)

: "${NTFY_TEST_SERVER:=}"
: "${NTFY_TEST_SELF_SIGNED:=false}"
: "${NTFY_TEST_VM:=ntfy-test}"
: "${NTFY_TEST_VM_IP:=}"
: "${NTFY_TEST_VM_USER:=tester}"
: "${NTFY_TEST_SSH_KEY:=}"
export NTFY_TEST_SERVER NTFY_TEST_SELF_SIGNED

_TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5)
if [ -n "$NTFY_TEST_SSH_KEY" ]; then
  SSH_OPTS+=(-i "$NTFY_TEST_SSH_KEY")
elif [ -f "$_TESTS_DIR/.vm-key" ]; then
  SSH_OPTS+=(-i "$_TESTS_DIR/.vm-key")
fi

# shellcheck disable=SC2016
VM_ENV='export XDG_RUNTIME_DIR=/run/user/$(id -u); export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus; '

vm_ip() {
  if [ -n "$NTFY_TEST_VM_IP" ]; then echo "$NTFY_TEST_VM_IP"; return; fi
  virsh domifaddr "$NTFY_TEST_VM" 2>/dev/null | awk '/ipv4/ {print $4}' | cut -d/ -f1 | head -1
}
