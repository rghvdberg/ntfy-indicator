#!/usr/bin/env gjs
/**
 * Test: Can set custom server (e.g., https://ntfy.example.com)
 * Checklist: [ ] Can set custom server
 */

import Gio from 'gi://Gio';
import System from 'system';

const settings = new Gio.Settings({
  schema_id: 'org.gnome.shell.extensions.ntfy-indicator'
});

const original = settings.get_string('server');
const custom = 'https://ntfy.example.com';

print(`Original server: ${original}`);
print(`Setting custom server: ${custom}`);

settings.set_string('server', custom);
const readBack = settings.get_string('server');

print(`Read back: ${readBack}`);

if (readBack === custom) {
  print('✓ PASS: Custom server set successfully');
  settings.set_string('server', original); // Restore
  System.exit(0);
} else {
  print(`✗ FAIL: Expected '${custom}', got '${readBack}'`);
  settings.set_string('server', original); // Restore
  System.exit(1);
}