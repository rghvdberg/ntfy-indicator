/**
 * Subscription Manager
 * Manages topic subscriptions and notification delivery
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

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import { NtfyApi } from './api.js';
import { notificationStore } from './notification-store.js';
import { attachmentDownloader } from './attachment-downloader.js';
import { getApiKey, parseTopicUrl, debugLog } from './utils.js';

// Polyfill URL for GNOME 50 MessageTray which references it internally
if (typeof URL === 'undefined') {
  globalThis.URL = class URL {
    constructor(url) {
      this.href = url;
      // Simple parser for common URLs
      const match = url.match(/^(https?:\/\/[^/]+)(\/[^\?]*)?(\?.*)?$/);
      this.origin = match ? match[1] : '';
      this.pathname = match && match[2] ? match[2] : '/';
      this.search = match && match[3] ? match[3] : '';
      this.hash = '';
    }
  };
}

/**
 * SubscriptionManager class
 * Handles subscribing/unsubscribing to topics and delivering notifications
 */
export class SubscriptionManager {
  constructor(settings) {
    this.settings = settings;
    this.subscriptions = {}; // Map of topicUrl -> { api, subscription, lastMessageId }
    this.connectionListeners = [];
    this._historyPid = null;
    this._historyTopic = null;
    
    // Create MessageTray source for notifications with click actions
    this._source = new MessageTray.Source({
      title: 'ntfy',
      iconName: 'dialog-information-symbolic',
    });
    Main.messageTray.add(this._source);
    this._source.connect('destroy', () => { this._source = null; });
  }

  /**
   * Add connection listener
   * @param {function} callback - Called when connection state changes
   */
  addConnectionListener(callback) {
    this.connectionListeners.push(callback);
  }

  /**
   * Remove connection listener
   * @param {function} callback - Listener to remove
   */
  removeConnectionListener(callback) {
    const index = this.connectionListeners.indexOf(callback);
    if (index > -1) {
      this.connectionListeners.splice(index, 1);
    }
  }

  /**
   * Notify listeners about connection state
   * @param {string} topicUrl - Topic URL
   * @param {boolean} connected - Connection state
   */
  _notifyConnectionChange(topicUrl, connected) {
    for (const callback of this.connectionListeners) {
      try {
        callback(topicUrl, connected);
      } catch (e) {
        debugLog('Connection listener error:', e);
      }
    }
  }

  /**
   * Subscribe to a topic
   * @param {string} topicUrl - Full topic URL or topic name
   * @returns {Promise<boolean>} True if subscribed successfully
   */
  async subscribe(topicUrl) {
    const { baseUrl, topic } = parseTopicUrl(topicUrl);
    const serverUrl = baseUrl || this.settings.get_string('server');
    const apiKey = getApiKey(this.settings, serverUrl);
    
    const fullTopicUrl = `${serverUrl}/${topic}`;
    
    if (this.subscriptions[fullTopicUrl]) {
      debugLog(`[SubscriptionManager] Already subscribed to ${fullTopicUrl}`);
      return true;
    }
    
    debugLog(`[SubscriptionManager] Subscribing to ${fullTopicUrl}`);
    
    const api = new NtfyApi(serverUrl, apiKey, this.settings.get_boolean('accept-self-signed'));
    const limit = this.settings.get_int('history-limit');
    
    // Resume from the last delivered message id (null -> 'all' -> first-ever full load)
    const since = await notificationStore.getLastMessageId(fullTopicUrl);
    
    const subscription = api.subscribe(
      topic,
      (msg) => this._handleMessage(fullTopicUrl, msg, limit),
      (error) => {
        debugLog(`[SubscriptionManager] Subscription error for ${fullTopicUrl}:`, error);
        this._notifyConnectionChange(fullTopicUrl, false);
      },
      () => this._notifyConnectionChange(fullTopicUrl, true),
      since
    );
    
    this.subscriptions[fullTopicUrl] = {
      api,
      subscription,
      topic,
      serverUrl,
      lastMessageId: since
    };
    
    this._notifyConnectionChange(fullTopicUrl, true);
    return true;
  }

  /**
   * Unsubscribe from a topic
   * @param {string} topicUrl - Full topic URL
   * @returns {boolean} True if unsubscribed
   */
  unsubscribe(topicUrl) {
    const sub = this.subscriptions[topicUrl];
    if (!sub) {
      return false;
    }
    
    debugLog(`[SubscriptionManager] Unsubscribing from ${topicUrl}`);
    
    sub.subscription.cancel();
    delete this.subscriptions[topicUrl];
    return true;
  }

  /**
   * Unsubscribe from all topics
   */
  unsubscribeAll() {
    for (const topicUrl of Object.keys(this.subscriptions)) {
      this.unsubscribe(topicUrl);
    }
  }

  /**
   * Destroy the subscription manager and clean up resources
   */
  destroy() {
    this.unsubscribeAll();
    if (this._commandPollerId) {
      GLib.source_remove(this._commandPollerId);
      this._commandPollerId = null;
    }
    if (this._source) {
      Main.messageTray.remove(this._source);
      this._source = null;
    }
  }

  /**
   * Handle incoming message
   * @param {string} topicUrl - Topic URL
   * @param {object} msg - Raw message
   * @param {number} limit - History limit
   */
  async _handleMessage(topicUrl, msg, limit) {
    if (msg.event !== 'message') return;
    // Check if muted
    const mutedTopics = this._parseMutedTopics();
    if (mutedTopics[topicUrl] && mutedTopics[topicUrl] > Date.now() / 1000) {
      return; // Still muted
    }
    
    // Add to store (returns false if duplicate or seen)
    const added = await notificationStore.addNotification(topicUrl, {
      ...msg,
      new: true
    }, limit);

    // Update last message ID regardless
    const sub = this.subscriptions[topicUrl];
    if (sub) {
      sub.lastMessageId = msg.id;
    }
    await notificationStore.setLastMessageId(topicUrl, msg.id);

    if (!added) return;
    
    // Push to open history dialog
    this._pushToHistory({ ...msg, new: 1 });
    
    // Show notification
    this._showNotification(topicUrl, msg);
  }

/**
    * Show desktop notification with click action
    * @param {string} topicUrl - Topic URL
    * @param {object} msg - Parsed message
    */
   _showNotification(topicUrl, msg) {
     const title = msg.title || `ntfy: ${msg.topic}`;
     const body = msg.message || '';
     
     // ponytail: Source auto-destroys when all notifications are dismissed.
     // Recreate lazily instead of bailing out when null.
     if (!this._source) {
       this._source = new MessageTray.Source({
         title: 'ntfy',
         iconName: 'dialog-information-symbolic',
       });
       Main.messageTray.add(this._source);
       this._source.connect('destroy', () => { this._source = null; });
     }
     
     // Create notification
     const notification = new MessageTray.Notification({
       source: this._source,
       title: title,
       body: body,
     });
     
     // Handle image attachments
     // Note: GNOME Shell notifications don't display large images, only small icons.
     // Images are shown in the history dialog where we have full GTK4 control.
if (msg.attachment && msg.attachment.type && msg.attachment.type.startsWith('image/')) {
        debugLog(`[ntfy] Image attachment detected: ${msg.attachment.name} (shown in history dialog)`);
       // Download for history dialog cache
       const apiKey = getApiKey(this.settings, topicUrl.replace(/\/[^\/]+$/, ''));
       const acceptSelfSigned = this.settings.get_boolean('accept-self-signed');
       
       attachmentDownloader.downloadAttachment(
         msg.attachment,
         msg.id,
         acceptSelfSigned,
         apiKey
).then(cachePath => {
          if (cachePath) {
            debugLog(`[ntfy] Image cached for history dialog: ${cachePath}`);
          }
        });
     }
    
    // Determine what happens when notification is clicked
    const { baseUrl, topic } = parseTopicUrl(topicUrl);
    const serverUrl = baseUrl || this.settings.get_string('server');
    
    debugLog(`[ntfy] Creating notification: title="${title}" topicUrl=${topicUrl} msg.id=${msg.id}`);
    notification.connect('activated', async () => {
      debugLog(`[ntfy] Notification activated: topicUrl=${topicUrl} msg.id=${msg.id}`);
      const result = await notificationStore.markRead(topicUrl, msg.id);
      debugLog(`[ntfy] markRead result: ${result}`);
      // Priority: click URL > attachment URL > history dialog
      if (msg.click) {
        debugLog(`[ntfy] Opening click URL: ${msg.click}`);
        GLib.spawn_command_line_async(`xdg-open '${msg.click}'`);
      } else if (msg.attach) {
        debugLog(`[ntfy] Opening attachment: ${msg.attach}`);
        GLib.spawn_command_line_async(`xdg-open '${msg.attach}'`);
      } else {
        debugLog(`[ntfy] Opening history for topic: ${topic}`);
        this._openHistoryDialog(topic, serverUrl);
      }
    });
    
    this._source.addNotification(notification);
  }
  
  /**
   * Open history dialog for a topic
   * @param {string} topic - Topic name
   * @param {string} serverUrl - Server URL
   */
  _pushToHistory(msg) {
    if (!this._historyPid) return;
    const alive = GLib.file_test(`/proc/${this._historyPid}`, GLib.FileTest.EXISTS);
    if (!alive) { this._historyPid = null; return; }
    try {
      const t = msg.topic || this._historyTopic;
      const tmpPath = `/tmp/ntfy-live-${t}.jsonl`;
      const line = JSON.stringify(msg) + '\n';
      const file = Gio.File.new_for_path(tmpPath);
      const ostream = file.append_to(Gio.FileCreateFlags.NONE, null);
      ostream.write_all(new TextEncoder().encode(line), null);
      ostream.close(null);
    } catch (e) {
      debugLog('[ntfy] _pushToHistory failed:', e);
    }
  }

  _openHistoryDialog(topic, serverUrl) {
    // Kill previous dialog if still running
    if (this._historyProc) {
      try { this._historyProc.force_exit(); } catch (e) { /* already dead */ }
      this._historyProc = null;
      this._historyPid = null;
    }

    const apiKey = getApiKey(this.settings, serverUrl) || '';
    const accept = this.settings.get_boolean('accept-self-signed');
    const topicUrl = `${serverUrl}/${topic}`;
    const mutedTopics = this._parseMutedTopics();
    const isMuted = mutedTopics[topicUrl] && mutedTopics[topicUrl] > Date.now() / 1000;
    
    const extDir = GLib.build_filenamev([
      GLib.get_home_dir(), '.local', 'share', 'gnome-shell', 
      'extensions', 'ntfy-indicator@rghvdberg'
    ]);
    const scriptPath = GLib.build_filenamev([extDir, 'history-dialog.js']);
    
    try {
      const launcher = new Gio.SubprocessLauncher({});
      // The shell process has no display env vars, so hand the GTK4 dialog the
      // session's Wayland socket explicitly (env first, else scan the runtime dir).
      const waylandDisplay = GLib.getenv('WAYLAND_DISPLAY');
      if (!waylandDisplay) {
        const rtDir = Gio.File.new_for_path(GLib.get_user_runtime_dir());
        try {
          const kids = rtDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
          let info;
          while ((info = kids.next_file(null)) !== null) {
            if (info.get_name().startsWith('wayland-')) {
              launcher.setenv('WAYLAND_DISPLAY', info.get_name(), true);
              break;
            }
          }
          kids.close(null);
        } catch (e) { /* no runtime dir */ }
      } else {
        launcher.setenv('WAYLAND_DISPLAY', waylandDisplay, true);
      }
      const proc = launcher.spawnv(['/usr/bin/gjs', '-m', scriptPath, serverUrl, apiKey, String(accept), topic, this.settings.get_strv('channels').join(','), String(isMuted)]);
      this._historyProc = proc;
      this._historyPid = proc.get_identifier();
      this._historyTopic = topic;
      // Clear any existing temp file for this topic
      const tmpPath = `/tmp/ntfy-live-${topic}.jsonl`;
      if (GLib.file_test(tmpPath, GLib.FileTest.EXISTS)) {
        GLib.unlink(tmpPath);
      }
    } catch (e) {
      debugLog('[ntfy] Failed to launch history dialog:', e);
    }

    // Start polling command file from dialog
    this._startCommandPoller();
  }

  _startCommandPoller() {
    const cmdPath = '/tmp/ntfy-cmd.jsonl';

    // Clear old commands
    if (GLib.file_test(cmdPath, GLib.FileTest.EXISTS)) {
      GLib.file_set_contents(cmdPath, '');
    }

    if (this._commandPollerId) {
      GLib.source_remove(this._commandPollerId);
      this._commandPollerId = null;
    }

    this._commandPollerId = GLib.timeout_add(GLib.PRIORITY_LOW, 150, () => {
      // Check if dialog is still alive
      if (!this._historyPid || !GLib.file_test(`/proc/${this._historyPid}`, GLib.FileTest.EXISTS)) {
        this._commandPollerId = null;
        return GLib.SOURCE_REMOVE;
      }
      if (!GLib.file_test(cmdPath, GLib.FileTest.EXISTS)) return GLib.SOURCE_CONTINUE;
      const file = Gio.File.new_for_path(cmdPath);
      file.load_contents_async(null, async (source, result) => {
        try {
          const [, contents] = source.load_contents_finish(result);
          if (!contents) return;
          const text = new TextDecoder().decode(contents).trim();
          if (!text) return;
          // Clear file immediately
          GLib.file_set_contents(cmdPath, '');
          for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
              const cmd = JSON.parse(line);
              const topicUrl = cmd.topicUrl;
              if (cmd.cmd === 'markRead') {
                await notificationStore.markRead(topicUrl, cmd.id);
              } else if (cmd.cmd === 'delete') {
                await notificationStore.deleteNotification(topicUrl, cmd.id);
              } else if (cmd.cmd === 'mute') {
                this.mute(topicUrl, 3600);
              } else if (cmd.cmd === 'unmute') {
                this.unmute(topicUrl);
              } else if (cmd.cmd === 'markAllRead') {
                await notificationStore.markAllRead(topicUrl);
              } else if (cmd.cmd === 'deleteAll') {
                const all = await notificationStore.load(topicUrl);
                for (const n of all) await notificationStore.deleteNotification(topicUrl, n.id);
              }
            } catch (e) { /* skip */ }
          }
        } catch (e) { /* ignore */ }
      });
      return GLib.SOURCE_CONTINUE;
    });
  }

  /**
   * Parse muted topics from settings
   * @returns {object} Map of topicUrl -> mute expiry timestamp
   */
  _parseMutedTopics() {
    try {
      const mutedStr = this.settings.get_string('muted-topics');
      return JSON.parse(mutedStr);
    } catch (e) {
      return {};
    }
  }

  /**
   * Publish a message to a topic
   * @param {string} topicUrl - Topic URL
   * @param {string} message - Message body
   * @param {object} options - Message options
   * @param {function} onSuccess - Success callback
   * @param {function} onError - Error callback
   */
  publish(topicUrl, message, options = {}, onSuccess, onError) {
    const { baseUrl, topic } = parseTopicUrl(topicUrl);
    const serverUrl = baseUrl || this.settings.get_string('server');
    const apiKey = getApiKey(this.settings, serverUrl);
    
    const api = new NtfyApi(serverUrl, apiKey, this.settings.get_boolean('accept-self-signed'));
    
    api.publish(topic, message, options, onSuccess, onError);
  }

  async getUnreadCount(topicUrl) {
    return notificationStore.getUnreadCount(topicUrl);
  }

  getSubscribedTopics() {
    return Object.keys(this.subscriptions);
  }

  /**
   * Mute a topic
   * @param {string} topicUrl - Topic URL
   * @param {number} durationSeconds - Duration to mute in seconds
   */
  mute(topicUrl, durationSeconds = 3600) {
    const mutedTopics = this._parseMutedTopics();
    mutedTopics[topicUrl] = Date.now() / 1000 + durationSeconds;
    this.settings.set_string('muted-topics', JSON.stringify(mutedTopics));
  }

  /**
   * Unmute a topic
   * @param {string} topicUrl - Topic URL
   */
  unmute(topicUrl) {
    const mutedTopics = this._parseMutedTopics();
    delete mutedTopics[topicUrl];
    this.settings.set_string('muted-topics', JSON.stringify(mutedTopics));
  }
}

/**
 * Singleton subscription manager
 */
export let subscriptionManager = null;

/**
 * Initialize subscription manager
 * @param {object} settings - GSettings object
 */
export function initSubscriptionManager(settings) {
  subscriptionManager = new SubscriptionManager(settings);
  return subscriptionManager;
}