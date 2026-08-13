#!/bin/bash
# Unit tests: pure gjs, no GNOME Shell needed. Store tests run against a
# throwaway XDG_DATA_HOME. API tests hit NTFY_TEST_SERVER with a disposable
# topic per run (skipped when NTFY_TEST_SERVER is unset).
set -u
cd "$(dirname "$0")/.."
source tests/config.sh
fail=0

run_suite() {
    local name="$1" file="$2"
    local xdg
    xdg=$(mktemp -d)
    echo "=== $name ==="
    XDG_DATA_HOME="$xdg" gjs -m "$file"
    [ $? -ne 0 ] && fail=1
    rm -rf "$xdg"
}

run_suite "utils" tests/test-utils.js
run_suite "store" tests/test-store.js
if [ -n "$NTFY_TEST_SERVER" ]; then
    run_suite "api" tests/test-api.js
else
    echo "=== api ==="
    echo "skip (set NTFY_TEST_SERVER to enable)"
fi

if [ $fail -eq 0 ]; then echo "ALL SUITES PASSED"; else echo "SOME SUITES FAILED"; fi
exit $fail
