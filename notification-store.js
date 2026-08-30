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

import GLib from "gi://GLib";
import Gio from "gi://Gio";
import { getNotificationFile, getDataDir, debugLog } from "./utils.js";
import { attachmentDownloader } from "./attachment-downloader.js";

/**
 * NotificationStore class
 * Handles reading/writing notifications to disk (async, non-blocking)
 */
export class NotificationStore {
  constructor() {
    this.dataDir = getDataDir();
    this._onChange = null;
    this._pendingWrites = {};
  }

  setOnChange(cb) {
    this._onChange = cb;
  }

  _notify() {
    if (this._onChange) this._onChange();
  }

  _enqueue(topicUrl, work) {
    // Serialize writes per topic to prevent data loss from concurrent operations
    const prev = this._pendingWrites[topicUrl];
    const promise = (prev || Promise.resolve()).then(work, work).catch((e) => {
      debugLog(`[ntfy] store work failed for ${topicUrl}:`, e);
    });
    this._pendingWrites[topicUrl] = promise;
    return promise;
  }

  _readData(topicUrl) {
    const file = Gio.File.new_for_path(getNotificationFile(topicUrl));
    if (!file.query_exists(null)) return Promise.resolve(null);
    return new Promise((resolve) => {
      file.load_contents_async(null, (source, result) => {
        try {
          const [success, contents] = source.load_contents_finish(result);
          if (!success || !contents) {
            resolve(null);
            return;
          }
          resolve(JSON.parse(new TextDecoder("utf-8").decode(contents)));
        } catch (e) {
          debugLog(`Failed to load ${topicUrl}:`, e);
          resolve(null);
        }
      });
    });
  }

  async _persist(topicUrl, notifications, seenIds, lastId, limit) {
    GLib.mkdir_with_parents(this.dataDir, 0o755);
    const sorted =
      limit == null
        ? notifications
        : notifications.sort((a, b) => b.time - a.time).slice(0, limit);
    // Cache is bounded by store lifetime: delete the cached attachment of any
    // notification trimmed out of history (the trim only happens when `limit`
    // is set — the history-limit path).
    if (limit != null) {
      for (const removed of notifications.slice(limit))
        attachmentDownloader.deleteCached(removed);
    }
    const data = {
      topic: topicUrl,
      notifications: sorted,
      seenIds,
      lastId,
    };
    await this._writeFile(
      Gio.File.new_for_path(getNotificationFile(topicUrl)),
      new TextEncoder().encode(JSON.stringify(data, null, 2)),
    );
  }

  _writeFile(file, contents) {
    return new Promise((resolve, reject) => {
      file.replace_contents_async(
        contents,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null,
        (source, result) => {
          try {
            source.replace_contents_finish(result);
            resolve();
          } catch (e) {
            debugLog(`[ntfy] write failed: ${file.get_path()}:`, e);
            reject(e);
          }
        },
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
      await this._persist(
        topicUrl,
        data.notifications || [],
        data.seenIds || [],
        id,
        null,
      );
    });
  }

  async addNotification(topicUrl, notification, limit = 100) {
    return this._enqueue(topicUrl, async () => {
      const data = (await this._readData(topicUrl)) || {};
      const seenIds = data.seenIds || [];
      const notifications = data.notifications || [];

      // Skip if already stored or previously seen (read or deleted)
      if (notifications.some((n) => n.id === notification.id)) return false;
      if (seenIds.includes(notification.id)) return false;

      notifications.push(notification);
      await this._persist(
        topicUrl,
        notifications,
        seenIds,
        data.lastId || null,
        limit,
      );
      this._notify();
      return true;
    });
  }

  async markRead(topicUrl, notificationId) {
    return this._enqueue(topicUrl, async () => {
      const data = (await this._readData(topicUrl)) || {};
      const notifications = data.notifications || [];
      const notification = notifications.find((n) => n.id === notificationId);

      if (!notification) {
        debugLog("[ntfy] markRead: notification not found");
        return false;
      }

      debugLog(`[ntfy] markRead: found, new was=${notification.new}`);
      notification.new = false;
      const seenIds = data.seenIds || [];
      if (!seenIds.includes(notificationId)) seenIds.push(notificationId);
      await this._persist(
        topicUrl,
        notifications,
        seenIds,
        data.lastId || null,
        null,
      );
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
      await this._persist(
        topicUrl,
        notifications,
        seenIds,
        data.lastId || null,
        null,
      );
      this._notify();
    });
  }

  async deleteNotification(topicUrl, notificationId) {
    return this._enqueue(topicUrl, async () => {
      const data = (await this._readData(topicUrl)) || {};
      const notifications = data.notifications || [];
      const idx = notifications.findIndex((n) => n.id === notificationId);
      const removed = idx !== -1 ? notifications.splice(idx, 1) : [];
      if (removed.length) attachmentDownloader.deleteCached(removed[0]);
      const seenIds = data.seenIds || [];
      if (!seenIds.includes(notificationId)) seenIds.push(notificationId);
      await this._persist(
        topicUrl,
        notifications,
        seenIds,
        data.lastId || null,
        null,
      );
      this._notify();
      return true;
    });
  }

  async getUnreadCount(topicUrl) {
    const notifications = await this.load(topicUrl);
    return notifications.filter((n) => n.new !== false).length;
  }

  /**
   * Delete store files for topics that are no longer in the channel list.
   * History for removed subscriptions is discarded; run cache sweep afterwards
   * so their attachments are cleaned up too.
   */
  cleanupInactiveStores(activeTopicUrls) {
    if (!activeTopicUrls || activeTopicUrls.length === 0) return;
    const dir = Gio.File.new_for_path(this.dataDir);
    if (!dir.query_exists(null)) return;
    const activeFiles = new Set(
      activeTopicUrls.map((url) => getNotificationFile(url)),
    );
    const enumerator = dir.enumerate_children(
      "standard::name",
      Gio.FileQueryInfoFlags.NONE,
      null,
    );
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
      const name = info.get_name();
      if (!name.endsWith(".json")) continue;
      const path = GLib.build_filenamev([this.dataDir, name]);
      if (activeFiles.has(path)) continue;
      try {
        Gio.File.new_for_path(path).delete(null);
      } catch (e) {
        debugLog(`[ntfy] Failed to delete old store ${path}:`, e);
      }
    }
    enumerator.close(null);
  }

  /**
   * Delete cached attachments no longer referenced by an active store file.
   * If activeTopicUrls is given, only store files for those topics are
   * considered live; cache for removed-topic store files is purged.
   * Runs once per session; ongoing trimming/deletion keep the cache bounded.
   */
  async sweepOrphanedAttachments(activeTopicUrls = null) {
    const dir = Gio.File.new_for_path(this.dataDir);
    if (!dir.query_exists(null)) return;
    const active = activeTopicUrls ? new Set(activeTopicUrls) : null;
    const live = [];
    const enumerator = dir.enumerate_children(
      "standard::name",
      Gio.FileQueryInfoFlags.NONE,
      null,
    );
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
      if (!info.get_name().endsWith(".json")) continue;
      const file = Gio.File.new_for_path(
        GLib.build_filenamev([this.dataDir, info.get_name()]),
      );
      const contents = await new Promise((resolve) => {
        file.load_contents_async(null, (source, result) => {
          try {
            const [success, contents] = source.load_contents_finish(result);
            resolve(success ? contents : null);
          } catch (e) {
            resolve(null);
          }
        });
      });
      if (!contents) continue;
      try {
        const data = JSON.parse(new TextDecoder("utf-8").decode(contents));
        if (active && !active.has(data.topic)) continue;
        if (data && data.notifications)
          for (const n of data.notifications) live.push(n);
      } catch (e) {
        /* skip malformed store */
      }
    }
    enumerator.close(null);
    attachmentDownloader.sweepCache(live);
  }
}

/**
 * Singleton notification store instance
 */
export const notificationStore = new NotificationStore();
