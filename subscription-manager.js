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

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as MessageTray from "resource:///org/gnome/shell/ui/messageTray.js";
import { NtfyApi } from "./api.js";
import { notificationStore } from "./notification-store.js";
import { attachmentDownloader } from "./attachment-downloader.js";
import { getApiKey, parseTopicUrl, debugLog } from "./utils.js";

/**
 * D-Bus endpoint the history dialog process calls into. All actions execute
 * here where the store, settings and HTTP policy live; replies are void.
 */
const DBUS_NAME = "com.github.rghvdberg.ntfy_indicator";
const DBUS_PATH = "/com/github/rghvdberg/ntfy_indicator/service";
const SERVICE_XML = `
<node>
  <interface name="${DBUS_NAME}.Service">
    <method name="MarkRead"><arg type="s" direction="in"/><arg type="s" direction="in"/></method>
    <method name="Delete"><arg type="s" direction="in"/><arg type="s" direction="in"/></method>
    <method name="MarkAllRead"><arg type="s" direction="in"/></method>
    <method name="DeleteAll"><arg type="s" direction="in"/></method>
    <method name="Mute"><arg type="s" direction="in"/></method>
    <method name="Unmute"><arg type="s" direction="in"/></method>
    <method name="Publish">
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="a{ss}" direction="in"/>
    </method>
  </interface>
</node>`;

/**
 * SubscriptionManager class
 * Handles subscribing/unsubscribing to topics and delivering notifications
 */
export class SubscriptionManager {
  constructor(settings, extPath) {
    this.settings = settings;
    this.extPath = extPath;
    this.subscriptions = {}; // Map of topicUrl -> subscription
    this._historyProc = null;
    this._historyPid = null;
    this._historyTopic = null;
    this._dbusNodeId = null;
    this._dbusExport = null;
    this._exportDbusService();

    // Create MessageTray source for notifications with click actions
    this._source = new MessageTray.Source({
      title: "ntfy",
      iconName: "dialog-information-symbolic",
    });
    Main.messageTray.add(this._source);
    this._source.connect("destroy", () => {
      this._source = null;
    });
  }

  /**
   * Export the dialog-facing D-Bus service on the session bus. All actions
   * run here where the store, settings and HTTP policy live; replies are
   * void and failures logged. destroy() releases name and export.
   */
  _exportDbusService() {
    const handlers = {
      MarkRead: (topicUrl, id) =>
        Promise.resolve(notificationStore.markRead(topicUrl, id)).catch((e) =>
          debugLog("[ntfy] D-Bus action failed:", e),
        ),
      Delete: (topicUrl, id) =>
        Promise.resolve(
          notificationStore.deleteNotification(topicUrl, id),
        ).catch((e) => debugLog("[ntfy] D-Bus action failed:", e)),
      MarkAllRead: (topicUrl) =>
        Promise.resolve(notificationStore.markAllRead(topicUrl)).catch((e) =>
          debugLog("[ntfy] D-Bus action failed:", e),
        ),
      DeleteAll: (topicUrl) =>
        Promise.resolve(
          notificationStore
            .load(topicUrl)
            .then((all) =>
              Promise.all(
                all.map((n) =>
                  notificationStore.deleteNotification(topicUrl, n.id),
                ),
              ),
            ),
        ).catch((e) => debugLog("[ntfy] D-Bus action failed:", e)),
      Mute: (topicUrl) => this.mute(topicUrl, 3600),
      Unmute: (topicUrl) => this.unmute(topicUrl),
      Publish: (topicUrl, message, filePath, headers) =>
        Promise.resolve(
          this._publishFromCommand({ topicUrl, message, filePath, headers }),
        ).catch((e) => debugLog("[ntfy] D-Bus action failed:", e)),
    };
    this._dbusExport = Gio.DBusExportedObject.wrapJSObject(
      SERVICE_XML,
      handlers,
    );
    this._dbusNodeId = Gio.bus_own_name(
      Gio.BusType.SESSION,
      DBUS_NAME,
      Gio.BusNameOwnerFlags.NONE,
      (conn) => this._dbusExport.export(conn, DBUS_PATH),
      null,
      () => debugLog("[ntfy] D-Bus name lost"),
    );
  }

  /**
   * Subscribe to a topic
   * @param {string} topicUrl - Full topic URL or topic name
   * @returns {Promise<boolean>} True if subscribed successfully
   */
  async subscribe(topicUrl) {
    const { baseUrl, topic } = parseTopicUrl(topicUrl);
    const serverUrl = baseUrl || this.settings.get_string("server");
    const apiKey = getApiKey(this.settings, serverUrl);

    const fullTopicUrl = `${serverUrl}/${topic}`;

    if (this.subscriptions[fullTopicUrl]) {
      debugLog(`[SubscriptionManager] Already subscribed to ${fullTopicUrl}`);
      return true;
    }

    debugLog(`[SubscriptionManager] Subscribing to ${fullTopicUrl}`);

    try {
      const accept = this.settings.get_boolean("accept-self-signed");
      const api = new NtfyApi(serverUrl, apiKey, accept);
      const limit = this.settings.get_int("history-limit");

      // Resume from the last delivered message id (null -> 'all' -> first-ever full load)
      const since = await notificationStore.getLastMessageId(fullTopicUrl);

      debugLog(
        `[SubscriptionManager] ${fullTopicUrl}: captured acceptSelfSigned=${accept}, since=${since ?? "null"}`,
      );

      const subscription = api.subscribe(
        topic,
        (msg) => this._handleMessage(fullTopicUrl, msg, limit),
        (error) => {
          debugLog(
            `[SubscriptionManager] Subscription error for ${fullTopicUrl}:`,
            error,
          );
        },
        since,
      );

      this.subscriptions[fullTopicUrl] = subscription;

      return true;
    }
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

    sub.cancel();
    delete this.subscriptions[topicUrl];
    return true;
  }

  /**
   * Unsubscribe from all topics
   */
  unsubscribeAll() {
    const keys = Object.keys(this.subscriptions);
    debugLog(`[SubscriptionManager] unsubscribeAll: ${keys.length} live`);
    for (const topicUrl of keys) {
      this.unsubscribe(topicUrl);
    }
  }

  /**
   * Destroy the subscription manager and clean up resources
   */
  destroy() {
    this.unsubscribeAll();
    if (this._dbusExport) {
      this._dbusExport.unexport();
      this._dbusExport = null;
    }
    if (this._dbusNodeId !== null) {
      Gio.bus_unown_name(this._dbusNodeId);
      this._dbusNodeId = null;
    }
    if (this._source) {
      this._source.destroy();
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
    // A server-side delete (or a deleted replay message) stays gone forever
    if (msg.event === "message_delete") {
      await notificationStore.deleteNotification(
        topicUrl,
        msg.sequence_id || msg.id,
      );
      await notificationStore.setLastMessageId(topicUrl, msg.id);
      return;
    }
    if (msg.event === "message_clear") {
      await notificationStore.markRead(topicUrl, msg.sequence_id || msg.id);
      await notificationStore.setLastMessageId(topicUrl, msg.id);
      return;
    }
    if (msg.event !== "message") return;
    // Mute only suppresses the desktop banner; messages are still stored,
    // counted and the resume watermark advances (matches the web app).
    const mutedTopics = this._parseMutedTopics();
    const isMuted =
      mutedTopics[topicUrl] && mutedTopics[topicUrl] > Date.now() / 1000;

    // Add to store (returns false if duplicate or seen)
    const added = await notificationStore.addNotification(
      topicUrl,
      {
        ...msg,
        new: true,
      },
      limit,
    );

    // Advance the resume watermark regardless
    await notificationStore.setLastMessageId(topicUrl, msg.id);

    if (!added || isMuted) return;

    // Show notification
    try {
      this._showNotification(topicUrl, msg);
    } catch (e) {
      console.error(`[ntfy] _showNotification failed: ${e.message}`, e);
    }
  }

  /**
   * Show desktop notification with click action
   * @param {string} topicUrl - Topic URL
   * @param {object} msg - Parsed message
   */
  _showNotification(topicUrl, msg) {
    const title = msg.title || `ntfy: ${msg.topic}`;
    const body = msg.message || "";

    // Recreate lazily instead of bailing out when null.
    if (!this._source) {
      this._source = new MessageTray.Source({
        title: "ntfy",
        iconName: "dialog-information-symbolic",
      });
      Main.messageTray.add(this._source);
      this._source.connect("destroy", () => {
        this._source = null;
      });
    }

    // Create notification
    const notification = new MessageTray.Notification({
      source: this._source,
      title: title,
      body: body,
    });

    // Pre-cache any attachment into the shared cache so the separate GTK
    // history dialog can display/open it without doing its own network IO
    // (GNOME Shell banners can't show large images; the dialog can).
    if (msg.attachment && msg.attachment.url) {
      const apiKey = getApiKey(
        this.settings,
        topicUrl.replace(/\/[^\/]+$/, ""),
      );
      const acceptSelfSigned = this.settings.get_boolean("accept-self-signed");
      attachmentDownloader
        .downloadAttachment(msg.attachment, msg.id, acceptSelfSigned, apiKey)
        .then((cachePath) => {
          if (cachePath)
            debugLog(
              `[ntfy] Attachment cached for history dialog: ${cachePath}`,
            );
        });
    }

    // Determine what happens when notification is clicked
    const { baseUrl, topic } = parseTopicUrl(topicUrl);
    const serverUrl = baseUrl || this.settings.get_string("server");

    debugLog(
      `[ntfy] Creating notification: title="${title}" topicUrl=${topicUrl} msg.id=${msg.id}`,
    );

    notification.connect("activated", async () => {
      debugLog(
        `[ntfy] Notification activated: topicUrl=${topicUrl} msg.id=${msg.id}`,
      );
      const result = await notificationStore.markRead(topicUrl, msg.id);
      debugLog(`[ntfy] markRead result: ${result}`);
      // Priority: click URL > attachment URL > history dialog
      if (msg.click) {
        debugLog(`[ntfy] Opening click URL: ${msg.click}`);
        Gio.AppInfo.launch_default_for_uri(msg.click, null);
      } else if (msg.attach) {
        debugLog(`[ntfy] Opening attachment: ${msg.attach}`);
        Gio.AppInfo.launch_default_for_uri(msg.attach, null);
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
  _openHistoryDialog(topic, serverUrl) {
    if (
      this._historyTopic === topic &&
      this._historyProc &&
      GLib.file_test(`/proc/${this._historyPid}`, GLib.FileTest.EXISTS)
    ) {
      return;
    }
    // Kill previous dialog if still running
    if (this._historyProc) {
      this._historyProc.force_exit();
      this._historyProc = null;
      this._historyPid = null;
    }

    const topicUrl = `${serverUrl}/${topic}`;
    const mutedTopics = this._parseMutedTopics();
    const isMuted =
      mutedTopics[topicUrl] && mutedTopics[topicUrl] > Date.now() / 1000;

    const scriptPath = GLib.build_filenamev([
      this.extPath,
      "history-dialog.js",
    ]);

    try {
      const launcher = new Gio.SubprocessLauncher({});
      // The shell process has no display env vars, so hand the GTK4 dialog the
      // session's Wayland socket explicitly (env first, else scan the runtime dir).
      const waylandDisplay = GLib.getenv("WAYLAND_DISPLAY");
      if (!waylandDisplay) {
        const rtDir = Gio.File.new_for_path(GLib.get_user_runtime_dir());
        try {
          const kids = rtDir.enumerate_children(
            "standard::name",
            Gio.FileQueryInfoFlags.NONE,
            null,
          );
          let info;
          while ((info = kids.next_file(null)) !== null) {
            if (info.get_name().startsWith("wayland-")) {
              launcher.setenv("WAYLAND_DISPLAY", info.get_name(), true);
              break;
            }
          }
          kids.close(null);
        } catch (e) {
          /* no runtime dir */
        }
      } else {
        launcher.setenv("WAYLAND_DISPLAY", waylandDisplay, true);
      }
      const proc = launcher.spawnv([
        "/usr/bin/gjs",
        "-m",
        scriptPath,
        serverUrl,
        topic,
        this.settings.get_strv("channels").join(","),
        String(isMuted),
        this.extPath,
      ]);
      this._historyProc = proc;
      this._historyPid = proc.get_identifier();
      this._historyTopic = topic;
    } catch (e) {
      debugLog("[ntfy] Failed to launch history dialog:", e);
    }
  }

  /**
   * Publish on behalf of the history dialog (D-Bus driven). Reads
   * server URL, API key and TLS policy live from settings so the dialog
   * never needs its own HTTP stack.
   */
  async _publishFromCommand(cmd) {
    const topicUrl = cmd.topicUrl;
    const baseUrl = topicUrl.replace(/\/[^\/]+$/, "");
    const api = new NtfyApi(
      baseUrl,
      getApiKey(this.settings, baseUrl),
      this.settings.get_boolean("accept-self-signed"),
    );
    const path = topicUrl.replace(baseUrl, "");
    if (cmd.filePath) {
      const file = Gio.File.new_for_path(cmd.filePath);
      const [, bytes] = await new Promise((resolve, reject) =>
        file.load_contents_async(null, (f, r) => {
          try {
            resolve(f.load_contents_finish(r));
          } catch (e) {
            reject(e);
          }
        }),
      );
      const name = cmd.filePath.split("/").pop();
      const query = ["filename=" + encodeURIComponent(name)];
      if (cmd.message) query.push("message=" + encodeURIComponent(cmd.message));
      await api.publish(
        "PUT",
        `${path}?${query.join("&")}`,
        null,
        bytes,
        cmd.headers || {},
      );
    } else {
      await api.publish(
        "POST",
        path,
        "text/plain",
        new TextEncoder().encode(cmd.message),
        cmd.headers || {},
      );
    }
  }

  _parseMutedTopics() {
    try {
      return JSON.parse(this.settings.get_string("muted-topics")) || {};
    } catch (e) {
      return {};
    }
  }

  /**
   * Mute a topic
   * @param {string} topicUrl - Topic URL
   * @param {number} durationSeconds - Duration to mute in seconds
   */
  mute(topicUrl, durationSeconds = 3600) {
    const mutedTopics = this._parseMutedTopics();
    mutedTopics[topicUrl] = Date.now() / 1000 + durationSeconds;
    this.settings.set_string("muted-topics", JSON.stringify(mutedTopics));
  }

  /**
   * Unmute a topic
   * @param {string} topicUrl - Topic URL
   */
  unmute(topicUrl) {
    const mutedTopics = this._parseMutedTopics();
    delete mutedTopics[topicUrl];
    this.settings.set_string("muted-topics", JSON.stringify(mutedTopics));
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
export function initSubscriptionManager(settings, extPath) {
  subscriptionManager = new SubscriptionManager(settings, extPath);
  return subscriptionManager;
}
