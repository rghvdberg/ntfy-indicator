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
import { getNotificationFile, getDataDir, debugLog } from './utils.js';

/**
 * NotificationStore class
 * Handles reading/writing notifications to disk (async, non-blocking)
 */
export class NotificationStore {
  constructor() {
    this.dataDir = getDataDir();
    this.cacheDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'ntfy', 'cache']);
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

  /**
   * Load notifications for a topic
   * @param {string} topicUrl - Full topic URL
   * @returns {Promise<object[]>} Array of notifications
   */
  async load(topicUrl) {
    const filePath = getNotificationFile(topicUrl);
    const file = Gio.File.new_for_path(filePath);

    if (!file.query_exists(null)) {
      return [];
    }

    try {
      const contents = await this._readFile(file);
      if (!contents) {
        return [];
      }

      const decoder = new TextDecoder('utf-8');
      const jsonStr = decoder.decode(contents);
      const data = JSON.parse(jsonStr);
      return data.notifications || [];
    } catch (e) {
      debugLog(`Failed to load notifications for ${topicUrl}:`, e);
      return [];
    }
  }

  async _loadSeenIds(topicUrl) {
    const filePath = getNotificationFile(topicUrl);
    const file = Gio.File.new_for_path(filePath);
    if (!file.query_exists(null)) return new Set();
    try {
      const contents = await this._readFile(file);
      if (!contents) return new Set();
      const data = JSON.parse(new TextDecoder().decode(contents));
      return new Set(data.seenIds || []);
    } catch (e) {
      return new Set();
    }
  }

  async _addSeenId(topicUrl, id) {
    const filePath = getNotificationFile(topicUrl);
    const file = Gio.File.new_for_path(filePath);
    if (!file.query_exists(null)) return;
    try {
      const contents = await this._readFile(file);
      if (!contents) return;
      const data = JSON.parse(new TextDecoder().decode(contents));
      const seenIds = data.seenIds || [];
      if (!seenIds.includes(id)) seenIds.push(id);
      data.seenIds = seenIds;
      await this._writeFile(file, new TextEncoder().encode(JSON.stringify(data, null, 2)));

    } catch (e) { /* ignore */ }
  }

  async getLastMessageId(topicUrl) {
    const filePath = getNotificationFile(topicUrl);
    const file = Gio.File.new_for_path(filePath);
    if (!file.query_exists(null)) return null;
    try {
      const contents = await this._readFile(file);
      if (!contents) return null;
      const data = JSON.parse(new TextDecoder().decode(contents));
      return data.lastId || null;
    } catch (e) {
      return null;
    }
  }

  setLastMessageId(topicUrl, id) {
    return this._enqueue(topicUrl, async () => {
      const filePath = getNotificationFile(topicUrl);
      const file = Gio.File.new_for_path(filePath);
      let data = {
        topic: topicUrl,
        notifications: [],
        seenIds: [],
        lastId: id,
        lastUpdated: Date.now() / 1000
      };
      if (file.query_exists(null)) {
        try {
          const contents = await this._readFile(file);
          if (contents) data = JSON.parse(new TextDecoder().decode(contents));
        } catch (e) { /* ignore */ }
      }
      data.lastId = id;
      try {
        const encoder = new TextEncoder();
        await this._writeFile(file, encoder.encode(JSON.stringify(data, null, 2)));
      } catch (e) {
        debugLog(`Failed to save lastId for ${topicUrl}:`, e);
      }
    });
  }

  /**
   * Save notifications for a topic
   * @param {string} topicUrl - Full topic URL
   * @param {object[]} notifications - Array of notifications
   * @param {number} limit - Maximum notifications to keep
   */
  save(topicUrl, notifications, limit = 100) {
    return this._enqueue(topicUrl, () => this._saveUnlocked(topicUrl, notifications, limit));
  }

  async _saveUnlocked(topicUrl, notifications, limit) {
    const filePath = getNotificationFile(topicUrl);
    const file = Gio.File.new_for_path(filePath);

    // Preserve existing seenIds + lastId
    let seenIds = [];
    let lastId = null;
    if (file.query_exists(null)) {
      try {
        const contents = await this._readFile(file);
        if (contents) {
          const old = JSON.parse(new TextDecoder().decode(contents));
          seenIds = old.seenIds || [];
          lastId = old.lastId || null;
        }
      } catch (e) { /* ignore */ }
    }

    // Sort by time (newest first) and limit
    const sorted = notifications
      .sort((a, b) => b.time - a.time)
      .slice(0, limit);

    const data = {
      topic: topicUrl,
      notifications: sorted,
      seenIds,
      lastId,
      lastUpdated: Date.now() / 1000
    };

    try {
      const encoder = new TextEncoder();
      const jsonStr = JSON.stringify(data, null, 2);
      const contents = encoder.encode(jsonStr);

      await this._writeFile(file, contents);
    } catch (e) {
      debugLog(`Failed to save notifications for ${topicUrl}:`, e);
    }
  }

  /**
   * Add a notification to a topic
   * @param {string} topicUrl - Full topic URL
   * @param {object} notification - Notification object
   * @param {number} limit - Maximum notifications to keep
   * @returns {Promise<boolean>} True if added successfully
   */
  async addNotification(topicUrl, notification, limit = 100) {
    return this._enqueue(topicUrl, async () => {
      const notifications = await this.load(topicUrl);

      // Check if already exists
      const exists = notifications.some(n => n.id === notification.id);
      if (exists) {
        return false;
      }

      // Skip if previously seen (read or deleted)
      const seenIds = await this._loadSeenIds(topicUrl);
      if (seenIds.has(notification.id)) {
        return false;
      }

      notifications.push(notification);
      await this._saveUnlocked(topicUrl, notifications, limit);
      this._notify();
      return true;
    });
  }

  /**
   * Mark a notification as read
   * @param {string} topicUrl - Full topic URL
   * @param {string} notificationId - Notification ID
   * @returns {Promise<boolean>} True if updated
   */
  async markRead(topicUrl, notificationId) {
    return this._enqueue(topicUrl, async () => {
      const notifications = await this.load(topicUrl);
      debugLog(`[ntfy] markRead: topicUrl=${topicUrl} id=${notificationId} storeSize=${notifications.length}`);
      const notification = notifications.find(n => n.id === notificationId);

      if (!notification) {
        debugLog('[ntfy] markRead: notification not found');
        return false;
      }

      debugLog(`[ntfy] markRead: found, new was=${notification.new}`);
      notification.new = false;
      await this._addSeenId(topicUrl, notificationId);
      await this._saveUnlocked(topicUrl, notifications);
      this._notify();
      return true;
    });
  }

  /**
   * Mark all notifications as read for a topic
   * @param {string} topicUrl - Full topic URL
   */
  async markAllRead(topicUrl) {
    return this._enqueue(topicUrl, async () => {
      const notifications = await this.load(topicUrl);
      for (const n of notifications) {
        n.new = false;
        await this._addSeenId(topicUrl, n.id);
      }
      await this._saveUnlocked(topicUrl, notifications);
      this._notify();
    });
  }

  /**
   * Delete a notification
   * @returns {Promise<boolean>} True if deleted
   */
  async deleteNotification(topicUrl, notificationId) {
    return this._enqueue(topicUrl, async () => {
      const notifications = await this.load(topicUrl);
      const idx = notifications.findIndex(n => n.id === notificationId);
      if (idx === -1) return false;
      notifications.splice(idx, 1);
      await this._addSeenId(topicUrl, notificationId);
      await this._saveUnlocked(topicUrl, notifications);
      this._notify();
      return true;
    });
  }

  /**
   * Get unread count for a topic
   * @param {string} topicUrl - Full topic URL
   * @returns {Promise<number>} Unread count
   */
  async getUnreadCount(topicUrl) {
    const notifications = await this.load(topicUrl);
    return notifications.filter(n => n.new !== false).length;
  }

}

/**
 * Singleton notification store instance
 */
export const notificationStore = new NotificationStore();