#!/usr/bin/env gjs
/**
 * Standalone GTK4 history dialog for ntfy extension.
 * Layout matches web app: topics sidebar left, messages right, publish entry bottom.
 * Args: serverUrl initialTopic topic1,topic2,... muted extPath
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
import Gtk from "gi://Gtk?version=4.0";
import Adw from "gi://Adw?version=1";
import Pango from "gi://Pango";
import Gdk from "gi://Gdk?version=4.0";
import GdkPixbuf from "gi://GdkPixbuf?version=2.0";

import { debugLog, parseTopicUrl, getNotificationFile } from "./utils.js";
import { attachmentDownloader } from "./attachment-downloader.js";

// Shell-side service the dialog sends actions to (must match
// subscription-manager.js)
const DBUS_NAME = "com.github.rghvdberg.ntfy_indicator";
const DBUS_PATH = "/com/github/rghvdberg/ntfy_indicator/service";

export async function main() {

  const args = ARGV;
  if (args.length < 4) {
    print("Usage: history-dialog.js serverUrl initialTopic topic1,topic2,... muted");
    return 1;
  }

  const [serverUrl, initialTopic, topicsArg, mutedArg, extPath] = args;
  const isMutedInitially = mutedArg === "true";
  const globalBaseUrl = serverUrl.replace(/\/$/, "");

  // Parse channel entries: entries may be bare topic names or full URLs
  const _parsed = topicsArg
    ? topicsArg
        .split(",")
        .filter((t) => t)
        .map((entry) => {
          const { baseUrl, topic } = parseTopicUrl(entry);
          return baseUrl
            ? { topic, topicUrl: entry }
            : { topic, topicUrl: `${globalBaseUrl}/${entry}` };
        })
    : [{ topic: initialTopic, topicUrl: `${globalBaseUrl}/${initialTopic}` }];
  const allTopics = _parsed.map((p) => p.topic);
  const topicUrlMap = {};
  for (const p of _parsed) topicUrlMap[p.topic] = p.topicUrl;
  const extDir = extPath || GLib.build_filenamev([
    GLib.get_home_dir(),
    ".local",
    "share",
    "gnome-shell",
    "extensions",
    "ntfy-indicator@rghvdberg",
  ]);
  function _storePath(t) {
    return getNotificationFile(topicUrlMap[t]);
  }

  function _loadStylesheet() {
    const provider = new Gtk.CssProvider();
    provider.load_from_path(GLib.build_filenamev([extDir, "stylesheet.css"]));
    Gtk.StyleContext.add_provider_for_display(
      Gdk.Display.get_default(),
      provider,
      Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
    );
  }

  const PRIORITY_LABELS = [
    null, // 0-index unused
    { text: "▲▲", color: "#999" },
    { text: "▲", color: "#999" },
    null, // 3 unused
    { text: "▼", color: "#c60000" },
    { text: "▼▼", color: "#a00" },
  ];

  const app = new Adw.Application({
    application_id: "com.ntfy.HistoryDialog",
    flags: Gio.ApplicationFlags.FLAGS_NONE,
  });

  app.connect("activate", () => {
    _loadStylesheet();
    let currentTopic = initialTopic;

    const window = new Adw.ApplicationWindow({
      application: app,
      title: "ntfy",
      default_width: 900,
      default_height: 600,
    });

    window.connect("close-request", () => {
      return false;
    });

    // === HEADER BAR ===
    const headerBar = new Gtk.HeaderBar();
    const titleBox = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER });
    const icon = new Gtk.Image({
      file: extDir + "/icons/ntfy.svg",
      pixel_size: 20,
    });
    const topicLabel = new Gtk.Label({ label: initialTopic });
    titleBox.append(icon);
    titleBox.append(topicLabel);
    headerBar.set_title_widget(titleBox);

    // ⋮ menu button
    let isMuted = isMutedInitially;
    const actions = new Gio.SimpleActionGroup();

    const muteAction = new Gio.SimpleAction({ name: "mute" });
    muteAction.connect("activate", () => {
      _sendCommand(isMuted ? "Unmute" : "Mute");
      isMuted = !isMuted;
      _rebuildMenuItems();
    });
    actions.add_action(muteAction);

    const readAllAction = new Gio.SimpleAction({ name: "readall" });
    readAllAction.connect("activate", () => {
      // The shell persists the store; the file monitor repaints
      // the rows from it. Update the visible rows locally too so the tick
      // marks disappear immediately (the store's ids are unchanged by a
      // mark-all-read, so the monitor's id-dedup short-circuit skips a repaint).
      _sendCommand("MarkAllRead");
      _setTopicCount(currentTopic, 0);
      for (const row of _rowById.values()) {
        if (row._dotLabel) row._dotLabel.get_parent().remove(row._dotLabel);
        if (row._readBtn) row._readBtn.set_visible(false);
      }
    });
    actions.add_action(readAllAction);

    const deleteAllAction = new Gio.SimpleAction({ name: "deleteall" });
    deleteAllAction.connect("activate", () => {
      _sendCommand("DeleteAll");
      _clearRows();
      _setTopicCount(currentTopic, 0);
    });
    actions.add_action(deleteAllAction);

    const menuModel = new Gio.Menu();
    const menuPopover = Gtk.PopoverMenu.new_from_model(menuModel);
    const menuBtn = new Gtk.MenuButton({ popover: menuPopover });
    headerBar.pack_end(menuBtn);

    // Main horizontal split: sidebar | content
    const hbox = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 0,
    });

    // === LEFT SIDEBAR: topic list ===
    const sidebar = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      width_request: 160,
      css_classes: ["view"],
    });

    const topicListBox = new Gtk.ListBox({
      selection_mode: Gtk.SelectionMode.SINGLE,
    });
    const topicItems = {}; // topic -> { row, countLabel }
    const topicCounts = {}; // topic -> unread count

    for (const t of allTopics) {
      topicCounts[t] = 0;
      const row = new Gtk.ListBoxRow({ selectable: true });
      const rowBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        margin_top: 6,
        margin_bottom: 6,
        margin_start: 12,
        margin_end: 12,
        spacing: 6,
      });
      const nameLabel = new Gtk.Label({
        label: t,
        hexpand: true,
        halign: Gtk.Align.START,
      });
      const countLabel = new Gtk.Label({
        label: "",
        css_classes: ["caption", "dim-label"],
      });
      rowBox.append(nameLabel);
      rowBox.append(countLabel);
      row.set_child(rowBox);
      topicListBox.append(row);
      topicItems[t] = { row, countLabel };
    }

    // Read a store/temp file (async IO, callback style).
    function _readFileContents(filePath, cb) {
      const file = Gio.File.new_for_path(filePath);
      if (!file.query_exists(null)) {
        cb(null);
        return;
      }
      file.load_contents_async(null, (source, result) => {
        try {
          const [ok, contents] = source.load_contents_finish(result);
          cb(ok ? contents : null);
        } catch (e) {
          cb(null);
        }
      });
    }

    // Load unread counts from local store
    function _loadTopicCounts() {
      let i = 0;
      function next() {
        if (i >= allTopics.length) return;
        const t = allTopics[i++];
        _readFileContents(_storePath(t), (contents) => {
          try {
            if (contents) {
              const data = JSON.parse(new TextDecoder().decode(contents));
              const unread = (data.notifications || []).filter(
                (n) => n.new !== false && n.new !== 0,
              ).length;
              topicCounts[t] = unread;
              topicItems[t].countLabel.set_text(
                unread > 0 ? String(unread) : "",
              );
            }
          } catch (e) {
            /* skip */
          }
          next();
        });
      }
      next();
    }
    _loadTopicCounts();

    // Watch store files so external changes (deleted/read elsewhere) refresh
    // counts and the current topic's rows.
    let _storeReloadTimer = 0;
    function _onStoreFileChanged() {
      if (_storeReloadTimer) return; // debounce: already scheduled
      _storeReloadTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
        _storeReloadTimer = 0;
        _loadTopicCounts();
        _loadMessages(currentTopic);
        return GLib.SOURCE_REMOVE;
      });
    }
    const _storeMonitors = [];
    const storeDirPath = _storePath(allTopics[0])
      .split("/")
      .slice(0, -1)
      .join("/");
    try {
      const monitor = Gio.File.new_for_path(storeDirPath).monitor_directory(
        Gio.FileMonitorFlags.NONE,
        null,
      );
      if (monitor)
        monitor.connect("changed", (_m, file, _o, e) => {
          if (
            e !== Gio.FileMonitorEvent.CHANGED &&
            e !== Gio.FileMonitorEvent.CREATED &&
            e !== Gio.FileMonitorEvent.DELETED &&
            e !== Gio.FileMonitorEvent.RENAMED
          )
            return;
          if (!allTopics.some((t) => _storePath(t) === file.get_path())) return;
          _onStoreFileChanged();
        });
      _storeMonitors.push(monitor);
      window._storeMonitors = _storeMonitors; // keep alive: GC would drop the inotify watch
    } catch (e) {
      /* skip */
    }

    sidebar.append(topicListBox);

    const sidebarSep = new Gtk.Separator({
      orientation: Gtk.Orientation.VERTICAL,
    });
    hbox.append(sidebar);
    hbox.append(sidebarSep);

    // === RIGHT: message list + publish entry ===
    const rightBox = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      hexpand: true,
      spacing: 0,
    });

    const scrolled = new Gtk.ScrolledWindow({
      vexpand: true,
      hscrollbar_policy: Gtk.PolicyType.NEVER,
      propagate_natural_width: false,
    });
    const msgListBox = new Gtk.ListBox({
      selection_mode: Gtk.SelectionMode.NONE,
    });
    scrolled.set_child(msgListBox);
    rightBox.append(scrolled);

    // === Publish area ===
    const publishVbox = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 0,
      margin_top: 4,
      margin_bottom: 8,
      margin_start: 8,
      margin_end: 8,
    });

    // Entry row: [expand btn] [message entry] [send]
    const entryRow = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 8,
    });
    const expandBtn = new Gtk.Button({ label: "^", sensitive: false });
    expandBtn.connect("clicked", () => _openPublishDialog());

    const publishEntry = new Gtk.Entry({
      hexpand: true,
      placeholder_text: "Publish to testing...",
      sensitive: false,
    });
    const sendBtn = new Gtk.Button({
      label: "Send",
      css_classes: ["suggested-action"],
      sensitive: false,
    });
    entryRow.append(expandBtn);
    entryRow.append(publishEntry);
    entryRow.append(sendBtn);
    publishVbox.append(entryRow);

    rightBox.append(publishVbox);

    hbox.append(rightBox);

    const mainVbox = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 0,
    });
    mainVbox.append(headerBar);
    mainVbox.append(hbox);
    window.set_content(mainVbox);

    // Open a cached attachment with the default app; fall back to the
    // default app for the file URI (no shell interpolation). Non-image
    // attachments are copied to ~/Downloads first so users can find them.
    function _copyToDownloads(cachePath, displayName) {
      let dir = GLib.get_user_special_dir(
        GLib.UserDirectory.DIRECTORY_DOWNLOAD,
      );
      if (!dir) dir = GLib.get_home_dir() + "/Downloads";
      GLib.mkdir_with_parents(dir, 0o755);
      const base = displayName || GLib.path_get_basename(cachePath);
      let name = base;
      for (
        let i = 1;
        GLib.file_test(GLib.build_filenamev([dir, name]), GLib.FileTest.EXISTS);
        i++
      ) {
        const dot = base.lastIndexOf(".");
        name =
          dot > 0
            ? `${base.slice(0, dot)} (${i})${base.slice(dot)}`
            : `${base} (${i})`;
      }
      const dest = GLib.build_filenamev([dir, name]);
      try {
        Gio.File.new_for_path(cachePath).copy(
          Gio.File.new_for_path(dest),
          Gio.FileCopyFlags.OVERWRITE,
          null,
          null,
        );
        return dest;
      } catch (e) {
        if (debug)
          console.error(`[history] Copy to Downloads failed: ${e.message}`);
        return null;
      }
    }

    function _openAttachment(path, displayName = null) {
      const inDownloads = _copyToDownloads(path, displayName);
      if (inDownloads) path = inDownloads;
      debugLog(`[history] Opening attachment: ${path}`);
      try {
        Gio.AppInfo.launch_default_for_uri(
          Gio.File.new_for_path(path).get_uri(),
          null,
        );
      } catch (e) {
        debugLog(`[history] Failed to open attachment: ${e.message}`);
      }
    }

    // === Message row builder ===
    function _appendRow(m, atTop = false) {
      const row = new Gtk.ListBoxRow({ selectable: false });
      _rowById.set(m.id, row);
      const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 2,
        hexpand: true,
        margin_top: 8,
        margin_bottom: 8,
        margin_start: 12,
        margin_end: 12,
      });

      let dotLabel = null,
        readBtn = null,
        titleLabel = null,
        msgLabel = null,
        tagsLabel = null;

      const headerBox = new Gtk.Box({ spacing: 6 });
      const timeLabel = new Gtk.Label({
        label: _formatTime(m.time),
        css_classes: ["caption", "dim-label"],
      });
      headerBox.append(timeLabel);

      if (m.priority && PRIORITY_LABELS[m.priority]) {
        const p = PRIORITY_LABELS[m.priority];
        const prioLabel = new Gtk.Label({
          label: p.text,
          css_classes: ["caption"],
        });
        prioLabel.set_markup(`<span foreground="${p.color}">${p.text}</span>`);
        headerBox.append(prioLabel);
      }

      if (m.new === 1 || m.new === true) {
        dotLabel = new Gtk.Label({ label: "\u25CF", css_classes: ["caption"] });
        dotLabel.set_markup('<span foreground="#338574">\u25CF</span>');
        headerBox.append(dotLabel);
      }
      row._dotLabel = dotLabel;

      headerBox.append(new Gtk.Label({ hexpand: true }));

      readBtn = new Gtk.Button({
        label: "\u2713",
        css_classes: ["flat", "caption"],
      });
      readBtn.connect("clicked", () => {
        _sendCommand("MarkRead", [m.id], "s");
        if (m.new !== false && m.new !== 0) {
          m.new = 0;
          _setTopicCount(
            currentTopic,
            Math.max(0, (topicCounts[currentTopic] || 0) - 1),
          );
        }
        if (dotLabel) headerBox.remove(dotLabel);
        readBtn.set_visible(false);
      });
      headerBox.append(readBtn);
      row._readBtn = readBtn;

      const delBtn = new Gtk.Button({
        label: "\u2715",
        css_classes: ["flat", "caption"],
      });
      delBtn.connect("clicked", () => {
        _sendCommand("Delete", [m.id], "s");
        if (m.new !== false && m.new !== 0)
          _setTopicCount(
            currentTopic,
            Math.max(0, (topicCounts[currentTopic] || 0) - 1),
          );
        const adj = scrolled.get_vadjustment();
        const prevScroll = adj.get_value();
        _rowById.delete(m.id);
        msgListBox.remove(row);
        // Removing a list row makes GTK re-create the scroll state and jump
        // to top; restore the position (deferred so it survives the relayout).
        adj.set_value(prevScroll);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
          adj.set_value(prevScroll);
          return GLib.SOURCE_REMOVE;
        });
      });
      headerBox.append(delBtn);

      if (m.new !== 1 && m.new !== true) readBtn.set_visible(false);

      box.append(headerBox);

      if (m.title) {
        titleLabel = new Gtk.Label({
          label: m.title,
          halign: Gtk.Align.START,
          xalign: 0,
          wrap: true,
          wrap_mode: Pango.WrapMode.WORD_CHAR,
          maxWidthChars: 60,
          css_classes: ["heading"],
        });
        box.append(titleLabel);
      }

      if (m.message) {
        msgLabel = new Gtk.Label({
          label: m.message,
          halign: Gtk.Align.FILL,
          xalign: 0,
          wrap: true,
          wrap_mode: Pango.WrapMode.WORD_CHAR,
          selectable: true,
          maxWidthChars: 60,
        });
        box.append(msgLabel);
      }

      const tags = m.tags || [];
      if (tags.length > 0) {
        tagsLabel = new Gtk.Label({
          label: `Tags: ${tags.join(", ")}`,
          halign: Gtk.Align.START,
          xalign: 0,
          wrap: true,
          wrap_mode: Pango.WrapMode.WORD_CHAR,
          maxWidthChars: 60,
          css_classes: ["caption", "dim-label"],
        });
        box.append(tagsLabel);
      }

      // Image preview for image attachments. The shell pre-caches every
      // attachment into the shared cache on arrival, so we only read it here.
      if (
        m.attachment &&
        m.attachment.type &&
        m.attachment.type.startsWith("image/")
      ) {
        const cachePath = attachmentDownloader.getCachedAttachment(
          m.attachment,
          m.id,
        );
        if (cachePath) {
          const picture = _createImagePicture(cachePath);
          if (picture) box.append(picture);
        }
      }

      if (m.attachment) {
        const att = m.attachment;
        let attText = att.name || "attachment";
        if (att.size)
          attText += ` (${att.size < 1024 ? att.size + " B" : att.size < 1048576 ? (att.size / 1024).toFixed(1) + " KB" : (att.size / 1048576).toFixed(1) + " MB"})`;
        const attUrl = att.url || "";
        const isImage = att.type && att.type.startsWith("image/");

        if (attUrl && !isImage) {
          // Non-image attachment: download and open with default app
          if (debug)
            console.warn(
              `[history] Non-image attachment: ${att.name}, type: ${att.type}, url: ${attUrl}`,
            );
          const attBtn = new Gtk.Button({
            halign: Gtk.Align.START,
          });
          const attBtnBox = new Gtk.Box({ spacing: 6 });
          attBtnBox.append(
            new Gtk.Image({ icon_name: "mail-attachment-symbolic" }),
          );
          attBtnBox.append(new Gtk.Label({ label: attText }));
          attBtn.set_child(attBtnBox);
          attBtn.connect("clicked", () => {
            const cachePath = attachmentDownloader.getCachedAttachment(
              att,
              m.id,
            );
            if (cachePath) {
              _openAttachment(cachePath, att.name || "attachment");
            } else {
              if (debug) console.warn("[history] Not cached, opening URL");
              try {
                Gio.AppInfo.launch_default_for_uri(attUrl, null);
              } catch (e) {
                if (debug) console.error(`[history] Open failed: ${e.message}`);
              }
            }
          });
          box.append(attBtn);
          // Images with a url are rendered by the preview above; no extra
          // button or label.
        } else if (!attUrl) {
          box.append(
            new Gtk.Label({
              label: attText,
              halign: Gtk.Align.START,
              css_classes: ["caption"],
            }),
          );
        }
      }

      row.set_child(box);
      msgListBox.insert(row, atTop ? 0 : -1);
    }

    // Create an image preview like the ntfy webapp: the image fills the row
    // width, height is capped at 400px, and click opens the original image.
    // We still load a Pixbuf once to learn the aspect ratio (GTK CSS does not
    // support max-height), but the visible image is rendered by Gtk.Picture.
    function _createImagePicture(cachePath) {
      try {
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file(cachePath);
        const iw = pixbuf.get_width();
        const ih = pixbuf.get_height();
        if (iw <= 0 || ih <= 0) {
          debugLog(`[history] Invalid image dimensions ${iw}x${ih}: ${cachePath}`);
          return null;
        }

        const picture = new Gtk.Picture({
          hexpand: true,
          halign: Gtk.Align.FILL,
          valign: Gtk.Align.START,
          vexpand: false,
          can_shrink: true,
          content_fit: Gtk.ContentFit.COVER,
          css_classes: ["ntfy-image-preview"],
        });
        picture.set_pixbuf(pixbuf);

        const MAX_H = 400;
        // Initial fallback height so the row doesn't collapse before mapping.
        picture.set_size_request(
          0,
          Math.min(MAX_H, Math.max(100, Math.round(300 * (ih / iw)))),
        );
        // On map the real width is known; set the exact aspect-capped height.
        picture.connect("map", () => {
          const w = picture.get_width();
          if (w > 0) {
            const h = Math.max(1, Math.min(MAX_H, Math.round(w * (ih / iw))));
            picture.set_size_request(0, h);
          }
        });

        const gesture = Gtk.GestureClick.new();
        gesture.set_button(1); // Left click only
        gesture.connect("released", (_gesture, n_press) => {
          if (n_press > 1) return;
          try {
            Gio.AppInfo.launch_default_for_uri(
              Gio.File.new_for_path(cachePath).get_uri(),
              null,
            );
          } catch (e) {
            debugLog(`[history] Open image failed: ${e.message}`);
          }
        });
        picture.add_controller(gesture);

        return picture;
      } catch (e) {
        debugLog(`[history] Failed to load image: ${e.message}`);
        return null;
      }
    }

    // === IPC: D-Bus calls into the shell's dialog service (void replies) ===
    function _sendCommand(method, args = [], types = "") {
      try {
        // 10 arguments exactly: bus, path, iface, method, params, reply type,
        // flags, timeout, cancellable, user data. Fewer args throw on this
        // GJS even in await/promise form.
        Gio.DBus.session.call(
          DBUS_NAME,
          DBUS_PATH,
          `${DBUS_NAME}.Service`,
          method,
          new GLib.Variant(`(s${types})`, [topicUrlMap[currentTopic], ...args]),
          null,
          Gio.DBusCallFlags.NONE,
          -1,
          null,
          null
        );
      } catch (e) {
        if (debug) console.error(`[history] sendCommand failed: ${e.message}`);
      }
    }

    // === Load messages from local store ===
    let _loadedTopic = null; // topic whose rows are currently in the listbox
    const _rowById = new Map(); // id -> ListBoxRow of the current list
    const _lastTopIdByTopic = new Map(); // topic → newest id from last load
    const _scrollByTopic = new Map(); // topic → scroll position
    function _clearRows() {
      _rowById.clear();
      let child = msgListBox.get_first_child();
      while (child) {
        const next = child.get_next_sibling();
        msgListBox.remove(child);
        child = next;
      }
    }
    function _loadMessages(t) {
      const storePath = _storePath(t);
      const isCurrentTopic = t === currentTopic;
      const adj = scrolled.get_vadjustment();

      _readFileContents(storePath, (contents) => {
        try {
          if (!contents) {
            debugLog(`[history] No store file for ${t}`);
            if (t !== _loadedTopic) _clearRows();
            return;
          }
          const data = JSON.parse(new TextDecoder().decode(contents));
          const notifications = data.notifications || [];
          const topId = notifications.length ? notifications[0].id : null;
          const freshIds = notifications.map((n) => n.id);
          const curIds = [..._rowById.keys()];
          if (
            curIds.length > 0 &&
            curIds.length === freshIds.length &&
            curIds.every((id, i) => id === freshIds[i])
          ) {
            _lastTopIdByTopic.set(t, topId);
            return;
          }
          const lastTopIdForThisTopic = _lastTopIdByTopic.get(t) || null;
          const newTop =
            isCurrentTopic &&
            lastTopIdForThisTopic !== null &&
            topId !== null &&
            topId !== lastTopIdForThisTopic;
          _lastTopIdByTopic.set(t, topId);

          // Clear + repopulate in one main-loop turn so the empty state never
          // gets a layout pass (which would clamp the scroll to top).
          _clearRows();
          _loadedTopic = t;
          for (const m of notifications) {
            _appendRow(m);
          }
          if (newTop) {
            adj.set_value(0);
          } else {
            const savedScroll = _scrollByTopic.get(t) || 0;
            // Defer scroll restoration with retry to let GTK finish layout.
            // The adjustment's upper value may not be updated yet.
            let attempts = 0;
            const maxAttempts = 5;
            const tryRestore = () => {
              attempts++;
              if (savedScroll < adj.get_upper() || attempts >= maxAttempts) {
                adj.set_value(savedScroll);
                return GLib.SOURCE_REMOVE;
              } else {
                return GLib.SOURCE_CONTINUE;
              }
            };
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, tryRestore);
          }
          debugLog(`[history] Added ${notifications.length} rows to listbox`);
        } catch (e) {
          if (debug)
            console.error(
              `[history] Failed to load store for ${t}: ${e.message}`,
            );
        }
      });
    }

    // Keep scroll positions updated as user scrolls
    scrolled.get_vadjustment().connect("changed", () => {
      _scrollByTopic.set(currentTopic, scrolled.get_vadjustment().get_value());
    });

    // === Update topic count in sidebar ===
    function _setTopicCount(t, unread) {
      topicCounts[t] = unread;
      topicItems[t].countLabel.set_text(unread > 0 ? String(unread) : "");
    }

    // === Topic switching ===
    function _switchTopic(t) {
      if (t === currentTopic) return;

      // Save current topic's scroll position before switching
      const currentScroll = scrolled.get_vadjustment().get_value();
      _scrollByTopic.set(currentTopic, currentScroll);

      currentTopic = t;
      // Update UI
      topicLabel.set_text(t);
      publishEntry.set_placeholder_text(`Publish to ${t}...`);
      publishEntry.set_sensitive(true);
      sendBtn.set_sensitive(true);
      expandBtn.set_sensitive(true);
      _loadMessages(t);
      _rebuildMenuItems();
    }

    topicListBox.connect("row-selected", (_lb, row) => {
      if (!row) return;
      // Find which topic this row is
      for (const t of allTopics) {
        if (topicItems[t].row === row) {
          _switchTopic(t);
          return;
        }
      }
    });

    // === Quick Publish (single-line entry) ===
    // Publishing goes over D-Bus; the shell does the HTTP with
    // live settings (API key, TLS policy). Confirmation is the message
    // appearing in the list via the feed, like the ntfy web app.
    function _doPublish() {
      const text = publishEntry.get_text().trim();
      if (!text) return;
      _sendCommand("Publish", [text, "", {}], "ssa{ss}");
      publishEntry.set_text("");
    }

    // === Full Publish Dialog (multiline + advanced fields) ===
    function _openPublishDialog() {
      let attachFilePath = null;

      const dlg = new Adw.ApplicationWindow({
        application: app,
        title: `Publish to ${currentTopic}`,
        default_width: 480,
        default_height: 420,
      });

      const dlgHeaderBar = new Gtk.HeaderBar();

      const vbox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
      });

      // Title
      const titleLabel = new Gtk.Label({
        label: "Title",
        halign: Gtk.Align.START,
        css_classes: ["caption"],
      });
      const titleEntry = new Gtk.Entry({
        hexpand: true,
        placeholder_text: "Optional title",
      });
      vbox.append(titleLabel);
      vbox.append(titleEntry);

      // Message label + text view
      const msgLabel = new Gtk.Label({
        label: "Message",
        halign: Gtk.Align.START,
        css_classes: ["heading"],
      });
      vbox.append(msgLabel);
      const msgBuffer = new Gtk.TextBuffer();
      const msgView = new Gtk.TextView({
        buffer: msgBuffer,
        hexpand: true,
        vexpand: true,
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
      });
      const msgScrolled = new Gtk.ScrolledWindow({
        child: msgView,
        vexpand: true,
        min_content_height: 120,
      });
      vbox.append(msgScrolled);

      // Priority + Tags row
      const prioTagsRow = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
      });
      const prioLabel = new Gtk.Label({
        label: "Priority",
        css_classes: ["caption"],
      });
      const prioList = new Gtk.StringList();
      for (const p of [
        "1 (min)",
        "2 (low)",
        "3 (default)",
        "4 (high)",
        "5 (max)",
      ])
        prioList.append(p);
      const prioDrop = new Gtk.DropDown({ model: prioList, selected: 2 });
      const tagsLabel = new Gtk.Label({
        label: "Tags",
        css_classes: ["caption"],
      });
      const tagsEntry = new Gtk.Entry({
        hexpand: true,
        placeholder_text: "tag1, tag2",
      });
      prioTagsRow.append(prioLabel);
      prioTagsRow.append(prioDrop);
      prioTagsRow.append(tagsLabel);
      prioTagsRow.append(tagsEntry);
      vbox.append(prioTagsRow);

      // Attachment row
      const attRow = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
      });
      const attBtn = new Gtk.Button({ label: "Select file..." });
      const attNameLabel = new Gtk.Label({
        label: "(none)",
        hexpand: true,
        wrap: true,
        xalign: 0,
        css_classes: ["caption"],
      });
      const attClearBtn = new Gtk.Button({
        label: "\u2715",
        css_classes: ["flat", "circular"],
      });
      attClearBtn.set_size_request(24, 24);
      attClearBtn.set_visible(false);
      attClearBtn.connect("clicked", () => {
        attachFilePath = null;
        attNameLabel.set_text("(none)");
        attClearBtn.set_visible(false);
      });
      attBtn.connect("clicked", () => {
        const fileDialog = new Gtk.FileDialog();
        fileDialog.open(dlg, null, (fdlg, res) => {
          try {
            const file = fdlg.open_finish(res);
            if (file) {
              attachFilePath = file.get_path();
              attNameLabel.set_text(attachFilePath.split("/").pop());
              attClearBtn.set_visible(true);
            }
          } catch (e) {
            /* cancelled */
          }
        });
      });
      attRow.append(attBtn);
      attRow.append(attNameLabel);
      attRow.append(attClearBtn);
      vbox.append(attRow);

      // Buttons row
      const btnRow = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        halign: Gtk.Align.END,
      });
      const cancelBtn = new Gtk.Button({ label: "Cancel" });
      cancelBtn.connect("clicked", () => dlg.close());
      btnRow.append(cancelBtn);

      const publishBtn = new Gtk.Button({
        label: "Publish",
        css_classes: ["suggested-action"],
      });
      publishBtn.connect("clicked", () => {
        const startIter = msgBuffer.get_start_iter();
        const endIter = msgBuffer.get_end_iter();
        const text = msgBuffer.get_text(startIter, endIter, true).trim();
        if (!text && !attachFilePath) return;

        const headers = {};
        const title = titleEntry.get_text().trim();
        if (title) headers["Title"] = title;
        const prio = prioDrop.get_selected() + 1;
        if (prio !== 3) headers["Priority"] = String(prio);
        const tags = tagsEntry.get_text().trim();
        if (tags) headers["Tags"] = tags;

        // Shell does the HTTP with live settings; attachment is read in place.
        _sendCommand(
          "Publish",
          [text, attachFilePath ?? "", headers],
          "ssa{ss}"
        );
        dlg.close();
      });
      btnRow.append(publishBtn);
      vbox.append(btnRow);

      // Use content box approach (set_titlebar doesn't work with AdwApplicationWindow)
      const dlgMainBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
      });
      dlgMainBox.append(dlgHeaderBar);
      dlgMainBox.append(vbox);
      dlg.set_content(dlgMainBox);

      dlg.present();
    }

    publishEntry.connect("activate", _doPublish);
    sendBtn.connect("clicked", _doPublish);

    // === Init ===
    function _rebuildMenuItems() {
      menuModel.remove_all();
      menuModel.append(isMuted ? "Unmute" : "Mute", "win.mute");
      menuModel.append("Read all", "win.readall");
      menuModel.append("Delete all", "win.deleteall");
    }
    _rebuildMenuItems();
    window.insert_action_group("win", actions);

    publishEntry.set_placeholder_text(`Publish to ${currentTopic}...`);
    publishEntry.set_sensitive(true);
    sendBtn.set_sensitive(true);
    expandBtn.set_sensitive(true);
    _loadMessages(currentTopic);

    // Select initial topic row
    for (const t of allTopics) {
      if (t === currentTopic) {
        topicListBox.select_row(topicItems[t].row);
        break;
      }
    }

    window.present();
  });

  function _formatTime(time) {
    try {
      let ts;
      if (typeof time === "number") ts = time;
      else if (typeof time === "string") {
        ts = Number(time);
        if (isNaN(ts)) ts = Date.parse(time) / 1000;
      } else return "??:??";
      return GLib.DateTime.new_from_unix_local(ts).format("%F %R");
    } catch (e) {
      return String(time) || "??:??";
    }
  }

  app.run([]);
}

if (typeof ARGV !== "undefined" && ARGV.length >= 4)
  main().catch((e) => debugLog("[history] main failed:", e));
