#!/bin/bash
# Unit tests: pure gjs, no GNOME Shell needed. Store tests run against a
# throwaway XDG_DATA_HOME. API tests hit the real dev server with a
# disposable topic per run.
set -u
cd "$(dirname "$0")/.."
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
run_suite "api"   tests/test-api.js

if [ $fail -eq 0 ]; then echo "ALL SUITES PASSED"; else echo "SOME SUITES FAILED"; fi
exit $fail
