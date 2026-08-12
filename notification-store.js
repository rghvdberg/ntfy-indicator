/**
 * Notification store for persistent storage
 * Stores notifications in JSON files in ~/.local/share/ntfy/
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
import Gio from 'gi://Gio';
import { getNotificationFile, getDataDir, getCacheDir, debugLog } from './utils.js';

/**
 * NotificationStore class
 * Handles reading/writing notifications to disk (async, non-blocking)
 */
export class NotificationStore {
  constructor() {
    this.dataDir = getDataDir();
    this.cacheDir = getCacheDir();
    this._ensureDataDir();
    this._onChange = null;
    this._locks = {};
  }

  setOnChange(cb) {
    this._onChange = cb;
  }

  _notify() {
    if (this._onChange) this._onChange();
  }

  _enqueue(topicUrl, work) {
    const prev = this._locks[topicUrl] || Promise.resolve();
    const next = prev.then(work, work);
    this._locks[topicUrl] = next.catch(() => {});
    return next;
  }

  _ensureDataDir() {
    GLib.mkdir_with_parents(this.dataDir, 0o755);
    GLib.mkdir_with_parents(this.cacheDir, 0o755);
  }

  _readFile(file) {
    return new Promise((resolve) => {
      file.load_contents_async(null, (source, result) => {
        try {
          const [success, contents] = source.load_contents_finish(result);
          resolve(success ? contents : null);
        } catch (e) {
          resolve(null);
        }
      });
    });
  }

  async _readData(topicUrl) {
    const file = Gio.File.new_for_path(getNotificationFile(topicUrl));
    if (!file.query_exists(null)) return null;
    try {
      const contents = await this._readFile(file);
      if (!contents) return null;
      return JSON.parse(new TextDecoder('utf-8').decode(contents));
    } catch (e) {
      debugLog(`Failed to load ${topicUrl}:`, e);
      return null;
    }
  }

  async _persist(topicUrl, notifications, seenIds, lastId, limit) {
    const sorted = limit == null
      ? notifications
      : notifications.sort((a, b) => b.time - a.time).slice(0, limit);
    const data = {
      topic: topicUrl,
      notifications: sorted,
      seenIds,
      lastId,
      lastUpdated: Date.now() / 1000
    };
    await this._writeFile(
      Gio.File.new_for_path(getNotificationFile(topicUrl)),
      new TextEncoder().encode(JSON.stringify(data, null, 2))
    );
  }

  _writeFile(file, contents) {
    return new Promise((resolve) => {
      file.replace_contents_async(
        contents, null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null,
        (source, result) => {
          try {
            source.replace_contents_finish(result);
            resolve(true);
          } catch (e) {
            resolve(false);
          }
        }
      );
    });
  }

  async load(topicUrl) {
    const data = await this._readData(topicUrl);
    return data && data.notifications ? data.notifications : [];
  }

  async getLastMessageId(topicUrl) {
    const data = await this._readData(topicUrl);
    return data && data.lastId ? data.lastId : null;
  }

  setLastMessageId(topicUrl, id) {
    return this._enqueue(topicUrl, async () => {
      const data = (await this._readData(topicUrl)) || {};
      await this._persist(topicUrl, data.notifications || [], data.seenIds || [], id, null);
    });
  }

  async addNotification(topicUrl, notification, limit = 100) {
    return this._enqueue(topicUrl, async () => {
      const data = (await this._readData(topicUrl)) || {};
      const seenIds = data.seenIds || [];
      const notifications = data.notifications || [];

      // Skip if already stored or previously seen (read or deleted)
      if (notifications.some(n => n.id === notification.id)) return false;
      if (seenIds.includes(notification.id)) return false;

      notifications.push(notification);
      await this._persist(topicUrl, notifications, seenIds, data.lastId || null, limit);
      this._notify();
      return true;
    });
  }

  async markRead(topicUrl, notificationId) {
    return this._enqueue(topicUrl, async () => {
      const data = (await this._readData(topicUrl)) || {};
      const notifications = data.notifications || [];
      const notification = notifications.find(n => n.id === notificationId);

      if (!notification) {
        debugLog('[ntfy] markRead: notification not found');
        return false;
      }

      debugLog(`[ntfy] markRead: found, new was=${notification.new}`);
      notification.new = false;
      const seenIds = data.seenIds || [];
      if (!seenIds.includes(notificationId)) seenIds.push(notificationId);
      await this._persist(topicUrl, notifications, seenIds, data.lastId || null, null);
      this._notify();
      return true;
    });
  }

  async markAllRead(topicUrl) {
    return this._enqueue(topicUrl, async () => {
      const data = (await this._readData(topicUrl)) || {};
      const notifications = data.notifications || [];
      const seenIds = data.seenIds || [];
      for (const n of notifications) {
        n.new = false;
        if (!seenIds.includes(n.id)) seenIds.push(n.id);
      }
      await this._persist(topicUrl, notifications, seenIds, data.lastId || null, null);
      this._notify();
    });
  }

  async deleteNotification(topicUrl, notificationId) {
    return this._enqueue(topicUrl, async () => {
      const data = (await this._readData(topicUrl)) || {};
      const notifications = data.notifications || [];
      const idx = notifications.findIndex(n => n.id === notificationId);
      if (idx === -1) return false;
      notifications.splice(idx, 1);
      const seenIds = data.seenIds || [];
      if (!seenIds.includes(notificationId)) seenIds.push(notificationId);
      await this._persist(topicUrl, notifications, seenIds, data.lastId || null, null);
      this._notify();
      return true;
    });
  }

  async markDeleted(topicUrl, notificationId) {
    return this._enqueue(topicUrl, async () => {
      const data = (await this._readData(topicUrl)) || {};
      const notifications = data.notifications || [];
      const seenIds = data.seenIds || [];
      const idx = notifications.findIndex(n => n.id === notificationId);
      if (idx !== -1) notifications.splice(idx, 1);
      if (!seenIds.includes(notificationId)) seenIds.push(notificationId);
      await this._persist(topicUrl, notifications, seenIds, data.lastId || null, null);
      this._notify();
      return true;
    });
  }

  async getUnreadCount(topicUrl) {
    const notifications = await this.load(topicUrl);
    return notifications.filter(n => n.new !== false).length;
  }

}

/**
 * Singleton notification store instance
 */
export const notificationStore = new NotificationStore();