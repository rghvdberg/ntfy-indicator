#!/usr/bin/env gjs
/**
 * Test: History limit setting
 * Checklist: [ ] History limit 10–1000 honored
 */

import Gio from 'gi://Gio';
import System from 'system';

const settings = new Gio.Settings({
  schema_id: 'org.gnome.shell.extensions.ntfy-indicator'
});

const original = settings.get_int('history-limit');

print(`Original limit: ${original}`);

// Test minimum
settings.set_int('history-limit', 10);
const min = settings.get_int('history-limit');
print(`Set to 10, read back: ${min}`);

// Test maximum
settings.set_int('history-limit', 1000);
const max = settings.get_int('history-limit');
print(`Set to 1000, read back: ${max}`);

// Test custom value
settings.set_int('history-limit', 250);
const custom = settings.get_int('history-limit');
print(`Set to 250, read back: ${custom}`);

settings.set_int('history-limit', original);

if (min === 10 && max === 1000 && custom === 250) {
  print('✓ PASS: History limit works (10-1000)');
  System.exit(0);
} else {
  print(`✗ FAIL: Expected 10, 1000, 250, got ${min}, ${max}, ${custom}`);
  System.exit(1);
}