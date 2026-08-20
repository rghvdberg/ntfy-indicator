#!/usr/bin/env gjs
/**
 * Test: Can set server with custom port
 * Checklist: [ ] Server URL with port works
 */

import Gio from 'gi://Gio';
import System from 'system';

const settings = new Gio.Settings({
  schema_id: 'org.gnome.shell.extensions.ntfy-indicator'
});

const original = settings.get_string('server');
const withPort = 'https://server.local:12707';

print(`Setting server with port: ${withPort}`);

settings.set_string('server', withPort);
const readBack = settings.get_string('server');

print(`Read back: ${readBack}`);

if (readBack === withPort) {
  print('✓ PASS: Server with port works');
  settings.set_string('server', original);
  System.exit(0);
} else {
  print(`✗ FAIL: Expected '${withPort}', got '${readBack}'`);
  settings.set_string('server', original);
  System.exit(1);
}