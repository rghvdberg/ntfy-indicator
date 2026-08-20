#!/usr/bin/env gjs
/**
 * Test: Accept self-signed certificates toggle
 * Checklist: [ ] Accept self-signed toggle works
 */

import Gio from 'gi://Gio';
import System from 'system';

const settings = new Gio.Settings({
  schema_id: 'org.gnome.shell.extensions.ntfy-indicator'
});

const original = settings.get_boolean('accept-self-signed');

print(`Original value: ${original}`);

// Toggle to opposite
const newValue = !original;
print(`Setting to: ${newValue}`);

settings.set_boolean('accept-self-signed', newValue);
const readBack = settings.get_boolean('accept-self-signed');

print(`Read back: ${readBack}`);

if (readBack === newValue) {
  print('✓ PASS: Self-signed toggle works');
  settings.set_boolean('accept-self-signed', original);
  System.exit(0);
} else {
  print(`✗ FAIL: Expected ${newValue}, got ${readBack}`);
  settings.set_boolean('accept-self-signed', original);
  System.exit(1);
}