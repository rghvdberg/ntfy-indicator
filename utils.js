/**
 * Utility functions for ntfy GNOME extension
 *
 * Copyright 2026 Rob van den Berg
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; see the GNU General Public License for details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import GLib from 'gi://GLib';

export function getDataDir() {
  const dataDir = GLib.get_user_data_dir();
  return GLib.build_filenamev([dataDir, 'ntfy']);
}

export function getNotificationFile(topicUrl) {
  const dataDir = getDataDir();
  const safeName = topicUrl.replace(/[^a-zA-Z0-9]/g, '_');
  return GLib.build_filenamev([dataDir, `${safeName}.json`]);
}

export function parseTopicUrl(topicUrl) {
  if (topicUrl.includes('://')) {
    // Split manually to avoid depending on URL constructor
    const protoEnd = topicUrl.indexOf('://');
    const proto = topicUrl.substring(0, protoEnd);
    const rest = topicUrl.substring(protoEnd + 3);
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) {
      return { baseUrl: `${proto}://${rest}`, topic: '' };
    }
    const host = rest.substring(0, slashIdx);
    const path = rest.substring(slashIdx);
    const parts = path.split('/').filter(p => p);
    const topic = parts[parts.length - 1];
    return { baseUrl: `${proto}://${host}`, topic };
  } else {
    return { baseUrl: null, topic: topicUrl };
  }
}

export function getServerUrl(settings) {
  return settings.get_string('server');
}

export function getApiKey(settings, serverUrl) {
  try {
    const apiKeysStr = settings.get_string('api-keys');
    const apiKeys = JSON.parse(apiKeysStr);
    return apiKeys[serverUrl] || null;
  } catch (e) {
    logError(e, 'Failed to parse API keys');
    return null;
  }
}
