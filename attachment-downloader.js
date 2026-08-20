/**
 * Attachment Downloader for ntfy GNOME Extension
 * Handles downloading and caching of all attachment types (images, documents, etc.)
 *
 * Copyright 2026 Rob van den Berg
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; see the GNU General Public License for
 * details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import Soup from 'gi://Soup';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { debugLog, getCacheDir } from './utils.js';

export class AttachmentDownloader {
  constructor(acceptSelfSigned = false, apiKey = null) {
    this.cacheDir = getCacheDir();
    this._ensureCacheDir();
    this.acceptSelfSigned = acceptSelfSigned;
    this.apiKey = apiKey;
  }

  _ensureCacheDir() {
    GLib.mkdir_with_parents(this.cacheDir, 0o755);
  }

  /**
   * Get cache file path for a notification/attachment
   * @param {string} notificationId - Notification ID
   * @param {string} attachmentName - Original attachment filename
   * @returns {string} Cache file path
   */
  _cachePath(notificationId, attachmentName) {
    const safeName = `${notificationId}_${attachmentName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    return GLib.build_filenamev([this.cacheDir, safeName]);
  }

  /**
   * Download any attachment to cache (no type validation).
   * Callback-based: `downloadAttachment` (used by the shell, where promises
   * do get pumped) wraps this in a Promise; the history dialog never calls it
   * directly — it reads the shared cache via `getCachedAttachment`.
   * @param {string} url - Attachment URL
   * @param {string} cachePath - Where to save the cached file
   * @param {boolean} acceptSelfSigned - Accept self-signed certificates
   * @param {string} apiKey - Optional API key for authentication
   * @param {(path: string|null) => void} cb - Called with cache path or null
   */
  _downloadFile(url, cachePath, acceptSelfSigned, apiKey, cb) {
    try {
      const session = new Soup.Session();
      const msg = Soup.Message.new('GET', url);

      if (acceptSelfSigned) {
        msg.connect('accept-certificate', () => true);
      }
      if (apiKey) {
        msg.request_headers.append('Authorization', `Bearer ${apiKey}`);
      }

      session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
        try {
          const bytes = sess.send_and_read_finish(result);
          const data = bytes.get_data();
          const size = data.length;
          if (size > 5 * 1024 * 1024) { cb(null); return; }

          const file = Gio.File.new_for_path(cachePath);
          const ostream = file.replace(
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
          );
          ostream.write_all(data, null);
          ostream.close(null);
          cb(cachePath);
        } catch (e) {
          debugLog(`[dl] Download error: ${e.message}`);
          cb(null);
        }
      });
    } catch (e) {
      debugLog(`[dl] Init error: ${e.message}`);
      cb(null);
    }
  }

  _resolveCachePath(attachment, notificationId) {
    if (!attachment || !attachment.url) return null;
    return this._cachePath(notificationId, attachment.name || 'attachment');
  }

  /**
   * Promise API for the shell extension, where promises do get pumped.
   * @returns {Promise<string|null>} Cache path on success, null on failure
   */
  async downloadAttachment(attachment, notificationId, acceptSelfSigned = this.acceptSelfSigned, apiKey = this.apiKey) {
    const cachePath = this._resolveCachePath(attachment, notificationId);
    if (!cachePath) return null;
    if (GLib.file_test(cachePath, GLib.FileTest.EXISTS)) return cachePath;
    return new Promise((resolve) => {
      this._downloadFile(attachment.url, cachePath, acceptSelfSigned, apiKey, resolve);
    });
  }

  /**
   * Cache-only lookup for the history dialog. The shell pre-caches every
   * attachment on arrival, so the dialog just reads the shared cache — no
   * network IO (which would need callbacks, since promises don't fire in the
   * standalone `gjs -m` dialog process). Returns the cache path or null.
   */
  getCachedAttachment(attachment, notificationId) {
    const cachePath = this._resolveCachePath(attachment, notificationId);
    if (!cachePath) return null;
    return GLib.file_test(cachePath, GLib.FileTest.EXISTS) ? cachePath : null;
  }
}

/**
 * Singleton image downloader instance
 */
export const attachmentDownloader = new AttachmentDownloader();