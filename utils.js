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

export function debugLog(...args) {
  const debug = GLib.getenv('NTFY_DEBUG');
  if (debug !== null && debug !== '0')
    console.debug('[ntfy]', ...args);
}

export function getDataDir() {
  const dataDir = GLib.get_user_data_dir();
  return GLib.build_filenamev([dataDir, 'ntfy']);
}

export function getCacheDir() {
  return GLib.build_filenamev([getDataDir(), 'cache']);
}

export function getNotificationFile(topicUrl) {
  const dataDir = getDataDir();
  const safeName = topicUrl.replace(/[^a-zA-Z0-9]/g, '_');
  return GLib.build_filenamev([dataDir, `${safeName}.json`]);
}

export function parseTopicUrl(topicUrl) {
  if (!topicUrl.includes('://'))
    return { baseUrl: null, topic: topicUrl };
  const uri = GLib.Uri.parse(topicUrl, GLib.UriFlags.NONE);
  const host = uri.get_host() || '';
  const ipv6 = host.includes(':') ? `[${host}]` : host;
  const baseUrl = `${uri.get_scheme()}://${ipv6}${uri.get_port() !== -1 ? `:${uri.get_port()}` : ''}`;
  const parts = (uri.get_path() || '').split('/').filter(p => p);
  return { baseUrl, topic: parts.length ? parts[parts.length - 1] : '' };
}
export function getApiKey(settings, serverUrl) {
  try {
    const apiKeysStr = settings.get_string('api-keys');
    const apiKeys = JSON.parse(apiKeysStr);
    return apiKeys[serverUrl] || null;
  } catch (e) {
    debugLog('Failed to parse API keys:', e);
    return null;
  }
}
