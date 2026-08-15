#!/bin/bash
# Create a throwaway GNOME test VM from the Ubuntu 26.04 cloud image.
# First run downloads ~821 MB and first boot installs GNOME (~5-10 min).
#
# Host deps: sudo apt install qemu-utils virtinst libvirt-daemon-system \
#              libvirt-clients cloud-image-utils openssh-client curl
# Usage: tests/vm-create.sh [--fresh]   (--fresh destroys and recreates)
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/config.sh

RELEASE=26.04
IMG_URL="https://cloud-images.ubuntu.com/releases/${RELEASE}/release/ubuntu-${RELEASE}-server-cloudimg-amd64.img"
POOL=default
BASE_VOL="ubuntu-${RELEASE}-server-cloudimg-amd64.img"
DISK_VOL="${NTFY_TEST_VM}.qcow2"
SEED_VOL="${NTFY_TEST_VM}-seed.iso"
CACHE_DIR="$HOME/.cache/ntfy-test"
BASE_IMG="$CACHE_DIR/$BASE_VOL"
KEY="${NTFY_TEST_SSH_KEY:-tests/.vm-key}"

FRESH=0
case "${1:-}" in
  "") ;;
  --fresh) FRESH=1 ;;
  *) echo "usage: $0 [--fresh]"; exit 1 ;;
esac

missing=()
for c in qemu-img virt-install virsh ssh-keygen cloud-localds; do
  command -v "$c" >/dev/null || missing+=("$c")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "missing tools: ${missing[*]}"
  echo "install: sudo apt install qemu-utils virtinst libvirt-daemon-system libvirt-clients cloud-image-utils openssh-client"
  exit 1
fi
virsh net-info default >/dev/null 2>&1 || { echo "libvirt 'default' network not available"; exit 1; }

if [ ! -f "$KEY" ]; then
  echo "=> generating throwaway ssh keypair: $KEY"
  ssh-keygen -t ed25519 -N '' -q -f "$KEY"
fi

if virsh dominfo "$NTFY_TEST_VM" >/dev/null 2>&1; then
  if [ "$FRESH" -eq 1 ]; then
    echo "=> destroying existing VM '$NTFY_TEST_VM'"
    virsh destroy "$NTFY_TEST_VM" 2>/dev/null || true
    virsh undefine "$NTFY_TEST_VM" --remove-all-storage 2>/dev/null || virsh undefine "$NTFY_TEST_VM"
    virsh vol-delete "$DISK_VOL" "$POOL" 2>/dev/null || true
    virsh vol-delete "$SEED_VOL" "$POOL" 2>/dev/null || true
  else
    echo "VM '$NTFY_TEST_VM' already exists (use --fresh to recreate)"
    exit 1
  fi
fi

mkdir -p "$CACHE_DIR"
if [ ! -f "$BASE_IMG" ]; then
  echo "=> downloading $IMG_URL"
  curl -fL --progress-bar -o "$BASE_IMG" "$IMG_URL"
fi

# Upload images into the libvirt pool (/var/lib/libvirt/images). qemu:///system
# guests are AppArmor-confined to pool paths, so disks in ~/ do not work.
if ! virsh vol-info "$BASE_VOL" "$POOL" >/dev/null 2>&1; then
  echo "=> uploading base image to libvirt pool"
  virsh vol-create-as "$POOL" "$BASE_VOL" 1G --format qcow2 >/dev/null
  virsh vol-upload "$BASE_VOL" "$BASE_IMG" "$POOL" >/dev/null
fi

echo "=> creating overlay disk"
virsh vol-create-as "$POOL" "$DISK_VOL" 10G --format qcow2 \
  --backing-vol "$BASE_VOL" --backing-vol-format qcow2 >/dev/null

SEED=$(mktemp -d)
trap 'rm -rf "$SEED"' EXIT
cat > "$SEED/user-data" <<EOF
#cloud-config
hostname: $NTFY_TEST_VM
users:
  - name: $NTFY_TEST_VM_USER
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: false
    password: tester
    ssh_authorized_keys:
      - $(cat "$KEY.pub")
package_update: true
packages:
  - gdm3
  - gnome-shell
  - gnome-session
  - gjs
  - gir1.2-adw-1
  - libgtk-4-bin
  - curl
  - python3
runcmd:
  - printf '[daemon]\nAutomaticLoginEnable=true\nAutomaticLogin=$NTFY_TEST_VM_USER\n' > /etc/gdm3/custom.conf
power_state:
  mode: reboot
  delay: now
EOF
cat > "$SEED/meta-data" <<EOF
instance-id: ${NTFY_TEST_VM}-$(date +%s)
local-hostname: $NTFY_TEST_VM
EOF
cloud-localds "$SEED/seed.iso" "$SEED/user-data" "$SEED/meta-data"

virsh vol-create-as "$POOL" "$SEED_VOL" 1M --format raw >/dev/null
virsh vol-upload "$SEED_VOL" "$SEED/seed.iso" "$POOL" >/dev/null

echo "=> creating VM '$NTFY_TEST_VM'"
virt-install \
  --name "$NTFY_TEST_VM" \
  --memory 4096 --vcpus 2 \
  --machine q35 \
  --disk "vol=$POOL/$DISK_VOL,bus=virtio,format=qcow2" \
  --disk "vol=$POOL/$SEED_VOL,device=cdrom" \
  --network network=default,model=virtio \
  --graphics spice,listen=127.0.0.1 \
  --video virtio \
  --os-variant generic \
  --import --noautoconsole >/dev/null

echo "=> waiting for GNOME session (first boot installs packages, ~5-10 min)"
deadline=$(( $(date +%s) + 1800 ))
IP=""
while true; do
  IP=$(vm_ip)
  if [ -n "$IP" ] && ssh "${SSH_OPTS[@]}" "$NTFY_TEST_VM_USER@$IP" "pgrep -u $NTFY_TEST_VM_USER -x gnome-shell" >/dev/null 2>&1; then
    break
  fi
  if [ "$(date +%s)" -gt "$deadline" ]; then
    echo "timeout waiting for GNOME session on '$NTFY_TEST_VM'"
    exit 1
  fi
  sleep 15
done

echo
echo "VM ready: ssh -i $KEY $NTFY_TEST_VM_USER@$IP"
echo "Console: virt-manager -> $NTFY_TEST_VM"
echo "Next:    NTFY_TEST_SERVER=<url> ./tests/deploy-vm.sh"
