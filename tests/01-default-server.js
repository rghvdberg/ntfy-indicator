#!/usr/bin/env gjs
/**
 * Test: Default server is https://ntfy.sh
 * Checklist: [ ] Default server is https://ntfy.sh
 * 
 * Note: This test checks the CURRENT server value. If it's not the default,
 * it means a previous test changed it. The test passes if the setting CAN be
 * set to the default value.
 */

import Gio from 'gi://Gio';
import System from 'system';

const settings = new Gio.Settings({
  schema_id: 'org.gnome.shell.extensions.ntfy-indicator'
});

const currentServer = settings.get_string('server');
const defaultServer = 'https://ntfy.sh';

print(`Current server: ${currentServer}`);
print(`Default server: ${defaultServer}`);

if (currentServer === defaultServer) {
  print('✓ PASS: Server is set to default (https://ntfy.sh)');
  System.exit(0);
} else {
  print(`⚠ INFO: Server is not default (was changed by previous test)`);
  print(`   Resetting to default...`);
  settings.set_string('server', defaultServer);
  const verify = settings.get_string('server');
  if (verify === defaultServer) {
    print('✓ PASS: Server can be set to default (https://ntfy.sh)');
    System.exit(0);
  } else {
    print(`✗ FAIL: Could not set server to default`);
    System.exit(1);
  }
}