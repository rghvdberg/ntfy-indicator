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


// Maximum image size to download (5MB)
// Rationale: Most notification images (screenshots, camera snapshots, memes)
// are under 1MB. 5MB provides headroom for high-quality images while
// preventing excessive storage/bandwidth usage. Can be increased if needed.
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

export class AttachmentDownloader {
  constructor(acceptSelfSigned = false, apiKey = null) {
    this.cacheDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'ntfy', 'cache']);
    this._ensureCacheDir();
    this.acceptSelfSigned = acceptSelfSigned;
    this.apiKey = apiKey;
  }

  _ensureCacheDir() {
    GLib.mkdir_with_parents(this.cacheDir, 0o755);
  }

  /**
   * Check if an image is already cached
   * @param {string} notificationId - Notification ID
   * @param {string} attachmentName - Original attachment filename
   * @returns {string|null} Cache file path if exists, null otherwise
   */
  getCachedImage(notificationId, attachmentName) {
    const cachePath = this.getCacheFilePath(notificationId, attachmentName);
    if (GLib.file_test(cachePath, GLib.FileTest.EXISTS)) {
      return cachePath;
    }
    return null;
  }

  /**
   * Get cache file path for a notification/attachment
   * @param {string} notificationId - Notification ID
   * @param {string} attachmentName - Original attachment filename
   * @returns {string} Cache file path
   */
  getCacheFilePath(notificationId, attachmentName) {
    const safeName = `${notificationId}_${attachmentName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    return GLib.build_filenamev([this.cacheDir, safeName]);
  }

  /**
   * Download any attachment to cache (no type validation)
   * @param {string} url - Attachment URL
   * @param {string} cachePath - Where to save the cached file
   * @param {boolean} acceptSelfSigned - Accept self-signed certificates
   * @param {string} apiKey - Optional API key for authentication
   * @returns {Promise<string|null>} Resolves with cache path on success, null on failure
   */
  _downloadFile(url, cachePath) {
    return new Promise((resolve) => {
      try {
        printerr(`[dl] Starting download: ${url} -> ${cachePath}`);
        const session = new Soup.Session();
        const msg = Soup.Message.new('GET', url);

        // Handle self-signed certificates
        if (this.acceptSelfSigned) {
          msg.connect('accept-certificate', (_msg, _cert, errors) => {
            printerr(`[dl] Accepting self-signed cert`);
            return true;
          });
        }

        // Add API key if provided
        if (this.apiKey) {
          msg.request_headers.append('Authorization', `Bearer ${this.apiKey}`);
        }

        // Use synchronous download
        try {
          const bytes = session.send_and_read(msg, null);
          const data = bytes.get_data();
          const size = data.length;
          printerr(`[dl] Downloaded ${size} bytes`);
      
          // Check size limit
          if (size > MAX_IMAGE_SIZE) {
            printerr(`[dl] File too large: ${size}`);
            resolve(null);
            return;
          }

          // Write to cache
          const file = Gio.File.new_for_path(cachePath);
          const ostream = file.replace(
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
          );
          ostream.write_all(data, null);
          ostream.close(null);

          printerr(`[dl] Cached: ${cachePath}`);
          resolve(cachePath);
        } catch (e) {
          printerr(`[dl] Download error: ${e.message}`);
          resolve(null);
        }
      } catch (e) {
        printerr(`[dl] Init error: ${e.message}`);
        resolve(null);
      }
    });
  }

  /**
   * Download and cache any attachment, returning the cache path
   * @param {object} attachment - Attachment object from ntfy
   * @param {string} notificationId - Notification ID
   * @param {boolean} acceptSelfSigned - Accept self-signed certificates
   * @param {string} apiKey - Optional API key
   * @returns {Promise<string|null>} Resolves with cache path on success, null on failure
   */
  async downloadAttachment(attachment, notificationId) {
    printerr(`[dl] downloadAttachment called with: ${JSON.stringify(attachment)}`);
    if (!attachment || !attachment.url) {
      printerr(`[dl] No attachment or URL: ${!!attachment}, ${!!attachment?.url}`);
      return null;
    }

    printerr(`[dl] downloadAttachment: ${attachment.name}, type: ${attachment.type}`);

    // Check if already cached
    const cached = this.getCachedImage(notificationId, attachment.name || 'attachment');
    if (cached) {
      printerr(`[dl] Already cached: ${cached}`);
      return cached;
    }

    // Download and cache
    const cachePath = this.getCacheFilePath(notificationId, attachment.name || 'attachment');
    printerr(`[dl] Downloading to: ${cachePath}`);
    return await this._downloadFile(attachment.url, cachePath);
  }
}

/**
 * Singleton image downloader instance
 */
export const attachmentDownloader = new AttachmentDownloader();