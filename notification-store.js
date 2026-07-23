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
import { getNotificationFile, getDataDir } from './utils.js';

/**
 * NotificationStore class
 * Handles reading/writing notifications to disk
 */
export class NotificationStore {
  constructor() {
    this.dataDir = getDataDir();
    this._ensureDataDir();
    this._onChange = null;
  }

  setOnChange(cb) {
    this._onChange = cb;
  }

  _notify() {
    if (this._onChange) this._onChange();
  }

  _ensureDataDir() {
    GLib.mkdir_with_parents(this.dataDir, 0o755);
  }

  /**
   * Load notifications for a topic
   * @param {string} topicUrl - Full topic URL
   * @returns {object[]} Array of notifications
   */
  load(topicUrl) {
    const filePath = getNotificationFile(topicUrl);
    const file = Gio.File.new_for_path(filePath);
    
    if (!file.query_exists(null)) {
      return [];
    }
    
    try {
      const [success, contents] = file.load_contents(null);
      if (!success) {
        return [];
      }
      
      const decoder = new TextDecoder('utf-8');
      const jsonStr = decoder.decode(contents);
      const data = JSON.parse(jsonStr);
      return data.notifications || [];
    } catch (e) {
      logError(e, `Failed to load notifications for ${topicUrl}`);
      return [];
    }
  }

  _loadSeenIds(topicUrl) {
    const filePath = getNotificationFile(topicUrl);
    const file = Gio.File.new_for_path(filePath);
    if (!file.query_exists(null)) return new Set();
    try {
      const [success, contents] = file.load_contents(null);
      if (!success) return new Set();
      const data = JSON.parse(new TextDecoder().decode(contents));
      return new Set(data.seenIds || []);
    } catch (e) {
      return new Set();
    }
  }

  _addSeenId(topicUrl, id) {
    const filePath = getNotificationFile(topicUrl);
    const file = Gio.File.new_for_path(filePath);
    if (!file.query_exists(null)) return;
    try {
      const [success, contents] = file.load_contents(null);
      if (!success) return;
      const data = JSON.parse(new TextDecoder().decode(contents));
      const seenIds = data.seenIds || [];
      if (!seenIds.includes(id)) seenIds.push(id);
      data.seenIds = seenIds;
      file.replace_contents(JSON.stringify(data, null, 2), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch (e) { /* ignore */ }
  }

  /**
   * Save notifications for a topic
   * @param {string} topicUrl - Full topic URL
   * @param {object[]} notifications - Array of notifications
   * @param {number} limit - Maximum notifications to keep
   */
  save(topicUrl, notifications, limit = 100) {
    const filePath = getNotificationFile(topicUrl);
    const file = Gio.File.new_for_path(filePath);

    // Preserve existing seenIds
    let seenIds = [];
    if (file.query_exists(null)) {
      try {
        const [success, contents] = file.load_contents(null);
        if (success) {
          const old = JSON.parse(new TextDecoder().decode(contents));
          seenIds = old.seenIds || [];
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
      lastUpdated: Date.now() / 1000
    };
    
    try {
      const encoder = new TextEncoder();
      const jsonStr = JSON.stringify(data, null, 2);
      const contents = encoder.encode(jsonStr);
      
      file.replace_contents(contents, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch (e) {
      logError(e, `Failed to save notifications for ${topicUrl}`);
    }
  }

  /**
   * Add a notification to a topic
   * @param {string} topicUrl - Full topic URL
   * @param {object} notification - Notification object
   * @param {number} limit - Maximum notifications to keep
   * @returns {boolean} True if added successfully
   */
  addNotification(topicUrl, notification, limit = 100) {
    const notifications = this.load(topicUrl);
    
    // Check if already exists
    const exists = notifications.some(n => n.id === notification.id);
    if (exists) {
      return false;
    }

    // Skip if previously seen (read or deleted)
    const seenIds = this._loadSeenIds(topicUrl);
    if (seenIds.has(notification.id)) {
      return false;
    }
    
    notifications.push(notification);
    this.save(topicUrl, notifications, limit);
    this._notify();
    return true;
  }

  /**
   * Mark a notification as read
   * @param {string} topicUrl - Full topic URL
   * @param {string} notificationId - Notification ID
   * @returns {boolean} True if updated
   */
  markRead(topicUrl, notificationId) {
    const notifications = this.load(topicUrl);
    log(`[ntfy] markRead: topicUrl=${topicUrl} id=${notificationId} storeSize=${notifications.length}`);
    const notification = notifications.find(n => n.id === notificationId);
    
    if (!notification) {
      log(`[ntfy] markRead: notification not found`);
      return false;
    }
    
    log(`[ntfy] markRead: found, new was=${notification.new}`);
    notification.new = false;
    this._addSeenId(topicUrl, notificationId);
    this.save(topicUrl, notifications);
    this._notify();
    return true;
  }

  /**
   * Mark all notifications as read for a topic
   * @param {string} topicUrl - Full topic URL
   */
  markAllRead(topicUrl) {
    const notifications = this.load(topicUrl);
    for (const n of notifications) {
      n.new = false;
      this._addSeenId(topicUrl, n.id);
    }
    this.save(topicUrl, notifications);
    this._notify();
  }

  /**
   * Delete a notification
   */
  deleteNotification(topicUrl, notificationId) {
    const notifications = this.load(topicUrl);
    const idx = notifications.findIndex(n => n.id === notificationId);
    if (idx === -1) return false;
    notifications.splice(idx, 1);
    this._addSeenId(topicUrl, notificationId);
    this.save(topicUrl, notifications);
    this._notify();
    return true;
  }

  /**
   * Get unread count for a topic
   * @param {string} topicUrl - Full topic URL
   * @returns {number} Unread count
   */
  getUnreadCount(topicUrl) {
    const notifications = this.load(topicUrl);
    return notifications.filter(n => n.new !== false).length;
  }

}

/**
 * Singleton notification store instance
 */
export const notificationStore = new NotificationStore();