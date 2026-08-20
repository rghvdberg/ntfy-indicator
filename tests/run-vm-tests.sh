#!/bin/bash
# Run all modular tests on the VM
# This script is executed locally, and ssh commands are inside the script

set -e
cd "$(dirname "$0")"
source config.sh

VM_IP=$(vm_ip)
VM_USER="${NTFY_TEST_VM_USER:-tester}"

echo "Running tests on VM ${VM_USER}@${VM_IP}"
echo "========================================"

for test in 0*.js; do
  echo ""
  echo "=== ${test} ==="
  ssh "${SSH_OPTS[@]}" "${VM_USER}@${VM_IP}" "gjs -m ~/ntfy-tests/${test}" || echo "FAILED: ${test}"
done

echo ""
echo "========================================"
echo "All tests completed"