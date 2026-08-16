#!/usr/bin/env gjs
/**
 * Standalone GTK4 history dialog for ntfy extension.
 * Layout matches web app: topics sidebar left, messages right, publish entry bottom.
 * Args: serverUrl apiKey acceptSelfSigned initialTopic topic1,topic2,...
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

import { isDebug, debugLog, parseTopicUrl, getDataDir, getNotificationFile, getCacheDir } from './utils.js';

// Guard name `debug` is what shexli recognizes for gated console.* calls
const debug = isDebug();

// Loaded lazily so importing this module from the shell stays GTK-free
let Gtk = null;
let Adw = null;
let Soup = null;
let Pango = null;
let GdkPixbuf = null;

async function _loadAppLibs() {
    if (Gtk) return;
    Gtk = (await import('gi://Gtk?version=4.0')).default;
    Adw = (await import('gi://Adw?version=1')).default;
    Soup = (await import('gi://Soup?version=3.0')).default;
    Pango = (await import('gi://Pango')).default;
    GdkPixbuf = (await import('gi://GdkPixbuf?version=2.0')).default;
}

// Attachment downloader for GTK4 (downloads all file types)
class AttachmentDownloader {
  constructor(acceptSelfSigned, apiKey) {
    this.acceptSelfSigned = acceptSelfSigned;
    this.apiKey = apiKey;
    this.session = new Soup.Session();
    
    // Build cache dir
    const dataDir = getCacheDir();
    GLib.mkdir_with_parents(dataDir, 0o755);
    this.cacheDir = dataDir;
  }
  
  getCachedAttachment(notificationId, attachmentName) {
    const cachePath = this._cachePath(notificationId, attachmentName);
    if (GLib.file_test(cachePath, GLib.FileTest.EXISTS)) {
      return cachePath;
    }
    return null;
  }

  _cachePath(notificationId, attachmentName) {
    const safeName = `${notificationId}_${attachmentName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    return GLib.build_filenamev([this.cacheDir, safeName]);
  }

  dispose() {
    if (this.session) this.session.abort();
  }
  
downloadAttachmentFile(url, cachePath, cb) {
    const msg = Soup.Message.new('GET', url);

    if (this.acceptSelfSigned === 'true') {
      msg.connect('accept-certificate', (_msg, _cert, errors) => {
        return errors === Gio.TlsCertificateFlags.UNKNOWN_CA;
      });
    }

    if (this.apiKey) {
      msg.request_headers.append('Authorization', 'Bearer ' + this.apiKey);
    }

    this.session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
      try {
        const bytes = sess.send_and_read_finish(result);
        const data = bytes.get_data();
        const size = data.length;

        if (size > 5 * 1024 * 1024) {
          if (debug) console.warn(`[history] File too large (${size} bytes), skipping: ${url}`);
          cb(null);
          return;
        }

        const file = Gio.File.new_for_path(cachePath);
        const ostream = file.replace(
          null,
          false,
          Gio.FileCreateFlags.REPLACE_DESTINATION,
          null
        );
        ostream.write_all(data, null);
        ostream.close(null);

        debugLog(`[history] Cached attachment: ${cachePath} (${size} bytes)`);
        cb(cachePath);
      } catch (e) {
        if (debug) console.error(`[history] Failed to download/cache file: ${e.message}`);
        cb(null);
      }
    });
  }

  downloadAttachment(attachment, notificationId, cb) {
    if (!attachment || !attachment.url) {
      cb(null);
      return;
    }

    const cached = this.getCachedAttachment(notificationId, attachment.name || 'attachment');
    if (cached) {
      cb(cached);
      return;
    }

    const cachePath = this._cachePath(notificationId, attachment.name || 'attachment');
    this.downloadAttachmentFile(attachment.url, cachePath, cb);
  }
}

export async function main() {
  await _loadAppLibs();

  const args = ARGV;
  if (args.length < 6) {
    print('Usage: history-dialog.js serverUrl apiKey acceptSelfSigned initialTopic topic1,topic2,... muted');
    return 1;
  }

  const [serverUrl, apiKey, acceptSelfSigned, initialTopic, topicsArg, mutedArg] = args;
const isMutedInitially = mutedArg === 'true';
const globalBaseUrl = serverUrl.replace(/\/$/, '');

// Parse channel entries: entries may be bare topic names or full URLs
const _parsed = topicsArg ? topicsArg.split(',').filter(t => t).map(entry => {
    const { baseUrl, topic } = parseTopicUrl(entry);
    return baseUrl ? { topic, topicUrl: entry } : { topic, topicUrl: `${globalBaseUrl}/${entry}` };
}) : [{ topic: initialTopic, topicUrl: `${globalBaseUrl}/${initialTopic}` }];
const allTopics = _parsed.map(p => p.topic);
const topicUrlMap = {};
for (const p of _parsed) topicUrlMap[p.topic] = p.topicUrl;
const extDir = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'gnome-shell', 'extensions', 'ntfy-indicator@rghvdberg']);
function _storePath(t) { return getNotificationFile(topicUrlMap[t]); }

const PRIORITY_LABELS = {
    1: { text: '\u25B2\u25B2', color: '#999' },
    2: { text: '\u25B2', color: '#999' },
    4: { text: '\u25BC', color: '#c60000' },
    5: { text: '\u25BC\u25BC', color: '#a00' },
};

const app = new Adw.Application({
    application_id: 'com.ntfy.HistoryDialog',
    flags: Gio.ApplicationFlags.FLAGS_NONE,
});

app.connect('activate', () => {
    const session = new Soup.Session();
    let currentTopic = initialTopic;
    let attachmentDownloader = null;
    
    // Initialize image downloader after we have settings
    function initAttachmentDownloader() {
      if (!attachmentDownloader) {
        attachmentDownloader = new AttachmentDownloader(acceptSelfSigned, apiKey);
      }
      return attachmentDownloader;
    }

    const window = new Adw.ApplicationWindow({
        application: app,
        title: 'ntfy',
        default_width: 900,
        default_height: 600,
    });

    // Abort downloader session on close so the process can exit cleanly
    window.connect('close-request', () => {
        if (attachmentDownloader) attachmentDownloader.dispose();
        return false;
    });

    // === HEADER BAR ===
    const headerBar = new Gtk.HeaderBar();
    const titleBox = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER });
    const icon = new Gtk.Image({
        file: extDir + '/icons/ntfy.svg',
        pixel_size: 20,
    });
    const topicLabel = new Gtk.Label({ label: initialTopic });
    titleBox.append(icon);
    titleBox.append(topicLabel);
    headerBar.set_title_widget(titleBox);

    // ⋮ menu button
    let isMuted = isMutedInitially;
    const actions = new Gio.SimpleActionGroup();

    const muteAction = new Gio.SimpleAction({ name: 'mute' });
    muteAction.connect('activate', () => {
        _sendCommand(isMuted ? 'unmute' : 'mute');
        isMuted = !isMuted;
        _rebuildMenuItems();
    });
    actions.add_action(muteAction);

    const readAllAction = new Gio.SimpleAction({ name: 'readall' });
    readAllAction.connect('activate', () => {
        _sendCommand('markAllRead');
        // Hide ✓ and green dots on all rows
        let child = msgListBox.get_first_child();
        while (child) {
            const box = child.get_child();
            if (box) {
                let c = box.get_first_child(); // headerBox
                if (c) {
                    let s = c.get_first_child(); // skip timeLabel
                    while (s) {
                        const next = s.get_next_sibling();
                        if (s instanceof Gtk.Label && s.get_text() === '\u25CF') c.remove(s);
                        if (s instanceof Gtk.Button && s.get_label() === '\u2713') s.set_visible(false);
                        s = next;
                    }
                }
            }
            child = child.get_next_sibling();
        }
        _setTopicCount(currentTopic, 0);
    });
    actions.add_action(readAllAction);

    const deleteAllAction = new Gio.SimpleAction({ name: 'deleteall' });
    deleteAllAction.connect('activate', () => {
        _sendCommand('deleteAll');
        let child = msgListBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            msgListBox.remove(child);
            child = next;
        }
        _setTopicCount(currentTopic, 0);
    });
    actions.add_action(deleteAllAction);

    const menuModel = new Gio.Menu();
    const menuPopover = Gtk.PopoverMenu.new_from_model(menuModel);
    const menuBtn = new Gtk.MenuButton({ popover: menuPopover });
    headerBar.pack_end(menuBtn);

    // Main horizontal split: sidebar | content
    const hbox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });

    // === LEFT SIDEBAR: topic list ===
    const sidebar = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        width_request: 160,
        css_classes: ['view'],
    });

    const topicListBox = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE });
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
        const nameLabel = new Gtk.Label({ label: t, hexpand: true, halign: Gtk.Align.START });
        const countLabel = new Gtk.Label({ label: '', css_classes: ['caption', 'dim-label'] });
        rowBox.append(nameLabel);
        rowBox.append(countLabel);
        row.set_child(rowBox);
        topicListBox.append(row);
        topicItems[t] = { row, countLabel };
    }

    // Read a store/temp file (async IO, callback style).
    // ponytail: callback, not Promise — in a standalone `gjs -m` app the
    // promise job queue is only drained while the module is evaluating, so
    // `.then`/`await` continuations after `app.run()` starts never run.
    function _readFileContents(filePath, cb) {
        const file = Gio.File.new_for_path(filePath);
        if (!file.query_exists(null)) { cb(null); return; }
        file.load_contents_async(null, (source, result) => {
            try {
                const [ok, contents] = source.load_contents_finish(result);
                cb(ok ? contents : null);
            } catch (e) { cb(null); }
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
                        const unread = (data.notifications || []).filter(n => n.new !== false && n.new !== 0).length;
                        topicCounts[t] = unread;
                        topicItems[t].countLabel.set_text(unread > 0 ? String(unread) : '');
                    }
                } catch (e) { /* skip */ }
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
    const storeDirPath = _storePath(allTopics[0]).split('/').slice(0, -1).join('/');
    try {
        const monitor = Gio.File.new_for_path(storeDirPath).monitor_directory(
            Gio.FileMonitorFlags.NONE, null);
        if (monitor)
            monitor.connect('changed', (_m, file, _o, e) => {
                if (e !== Gio.FileMonitorEvent.CHANGED &&
                    e !== Gio.FileMonitorEvent.CREATED &&
                    e !== Gio.FileMonitorEvent.DELETED &&
                    e !== Gio.FileMonitorEvent.RENAMED) return;
                if (!allTopics.some(t => _storePath(t) === file.get_path()))
                    return;
                _onStoreFileChanged();
            });
        _storeMonitors.push(monitor);
        window._storeMonitors = _storeMonitors; // keep alive: GC would drop the inotify watch
    } catch (e) { /* skip */ }

    sidebar.append(topicListBox);

    const sidebarSep = new Gtk.Separator({ orientation: Gtk.Orientation.VERTICAL });
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
    const msgListBox = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
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
    const expandBtn = new Gtk.Button({ label: '^', sensitive: false });
    expandBtn.connect('clicked', () => _openPublishDialog());

    const publishEntry = new Gtk.Entry({
        hexpand: true,
        placeholder_text: 'Publish to testing...',
        sensitive: false,
    });
    const sendBtn = new Gtk.Button({
        label: 'Send',
        css_classes: ['suggested-action'],
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
        let dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
        if (!dir) dir = GLib.get_home_dir() + '/Downloads';
        GLib.mkdir_with_parents(dir, 0o755);
        const base = displayName || GLib.path_get_basename(cachePath);
        let name = base;
        for (let i = 1; GLib.file_test(GLib.build_filenamev([dir, name]), GLib.FileTest.EXISTS); i++) {
            const dot = base.lastIndexOf('.');
            name = dot > 0 ? `${base.slice(0, dot)} (${i})${base.slice(dot)}` : `${base} (${i})`;
        }
        const dest = GLib.build_filenamev([dir, name]);
        try {
            Gio.File.new_for_path(cachePath).copy(Gio.File.new_for_path(dest),
                Gio.FileCopyFlags.OVERWRITE, null, null);
            return dest;
        } catch (e) {
            if (debug) console.error(`[history] Copy to Downloads failed: ${e.message}`);
            return null;
        }
    }

    function _openAttachment(path, displayName = null) {
        const inDownloads = _copyToDownloads(path, displayName);
        if (inDownloads) path = inDownloads;
        debugLog(`[history] Opening attachment: ${path}`);
        try {
            const file = Gio.File.new_for_path(path);
            const appInfo = Gio.AppInfo.get_default_for_type('application/octet-stream', false);
            if (appInfo) {
                try {
                    appInfo.launch([file], null);
                    return;
                } catch (e) { /* fall through to default app */ }
            }
        } catch (e) { /* fall through to default app */ }
        try {
            Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(path).get_uri(), null);
        } catch (e) {
            if (debug) console.error(`[history] Failed to open attachment: ${e.message}`);
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

        let dotLabel = null, readBtn = null, titleLabel = null, msgLabel = null, tagsLabel = null;

        const headerBox = new Gtk.Box({ spacing: 6 });
        const timeLabel = new Gtk.Label({
            label: _formatTime(m.time),
            css_classes: ['caption', 'dim-label'],
        });
        headerBox.append(timeLabel);

        if (m.priority && PRIORITY_LABELS[m.priority]) {
            const p = PRIORITY_LABELS[m.priority];
            const prioLabel = new Gtk.Label({ label: p.text, css_classes: ['caption'] });
            prioLabel.set_markup(`<span foreground="${p.color}">${p.text}</span>`);
            headerBox.append(prioLabel);
        }

        if (m.new === 1 || m.new === true) {
            dotLabel = new Gtk.Label({ label: '\u25CF', css_classes: ['caption'] });
            dotLabel.set_markup('<span foreground="#338574">\u25CF</span>');
            headerBox.append(dotLabel);
        }

        // ponytail: empty label as spacer to push actions to right edge
        headerBox.append(new Gtk.Label({ hexpand: true }));

        readBtn = new Gtk.Button({ label: '\u2713', css_classes: ['flat', 'caption'] });
        readBtn.connect('clicked', () => {
            _sendCommand('markRead', { id: m.id });
            _markReadInStore(currentTopic, m.id);
            if (m.new !== false && m.new !== 0) {
                m.new = 0;
                _setTopicCount(currentTopic, Math.max(0, (topicCounts[currentTopic] || 0) - 1));
            }
            if (dotLabel) headerBox.remove(dotLabel);
            readBtn.set_visible(false);
        });
        headerBox.append(readBtn);

        const delBtn = new Gtk.Button({ label: '\u2715', css_classes: ['flat', 'caption'] });
        delBtn.connect('clicked', () => {
            _sendCommand('delete', { id: m.id });
            if (m.new !== false && m.new !== 0)
                _setTopicCount(currentTopic, Math.max(0, (topicCounts[currentTopic] || 0) - 1));
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

        // ponytail: hide ✓ when read, ✕ always visible — matches web app
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
                css_classes: ['heading'],
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

        const tags = (m.tags || []).filter(t => !t.match(/^[a-z_]+$/));
        if (tags.length > 0) {
            tagsLabel = new Gtk.Label({
                label: `Tags: ${tags.join(', ')}`,
                halign: Gtk.Align.START,
                xalign: 0,
                wrap: true,
                wrap_mode: Pango.WrapMode.WORD_CHAR,
                maxWidthChars: 60,
                css_classes: ['caption', 'dim-label'],
            });
            box.append(tagsLabel);
        }

        // Image preview for image attachments
        if (m.attachment && m.attachment.type && m.attachment.type.startsWith('image/')) {
            const downloader = initAttachmentDownloader();
            const cachePath = downloader.getCachedAttachment(m.id, m.attachment.name || 'image');
            
            if (cachePath) {
                // Show cached image immediately
                const picture = _createImagePicture(cachePath);
                if (picture) {
                    box.append(picture);
                }
            } else {
                // Show loading placeholder, download async
                const placeholder = new Gtk.Box({
                    orientation: Gtk.Orientation.VERTICAL,
                    css_classes: ['ntfy-image-loading'],
                    hexpand: true,
                    halign: Gtk.Align.FILL,
                    height_request: 100,
                });
                const loadingLabel = new Gtk.Label({
                    label: 'Loading image...',
                    valign: Gtk.Align.CENTER,
                    halign: Gtk.Align.CENTER,
                    css_classes: ['caption', 'dim-label'],
                });
                placeholder.append(loadingLabel);
                box.append(placeholder);
                
                // Download asynchronously
                downloader.downloadAttachment(m.attachment, m.id, (cachePath) => {
                    if (cachePath) {
                        const picture = _createImagePicture(cachePath);
                        if (picture) {
                            box.remove(placeholder);
                            box.append(picture);
                        }
                    }
                });
            }
        }

        if (m.attachment) {
            const att = m.attachment;
            let attText = att.name || 'attachment';
            if (att.size) attText += ` (${att.size < 1024 ? att.size + ' B' : att.size < 1048576 ? (att.size / 1024).toFixed(1) + ' KB' : (att.size / 1048576).toFixed(1) + ' MB'})`;
            const attUrl = att.url || '';
            const isImage = att.type && att.type.startsWith('image/');
            
            if (attUrl && !isImage) {
                // Non-image attachment: download and open with default app
                const downloader = initAttachmentDownloader();
                if (debug) console.warn(`[history] Non-image attachment: ${att.name}, type: ${att.type}, url: ${attUrl}`);
                const attBtn = new Gtk.Button({
                    label: `\uD83D\uDCCE ${attText}`,
                    halign: Gtk.Align.START,
                });
                attBtn.connect('clicked', () => {
                    const cached = downloader.getCachedAttachment(m.id, att.name || 'attachment');
                    if (cached) {
                        _openAttachment(cached, att.name || 'attachment');
                    } else {
                        debugLog(`[history] Not cached, downloading from ${att.url}`);
                        downloader.downloadAttachment(att, m.id, (newCachePath) => {
                            if (newCachePath) {
                                _openAttachment(newCachePath, att.name || 'attachment');
                            } else {
                                if (debug) console.warn('[history] Download failed, opening URL');
                                try {
                                    Gio.AppInfo.launch_default_for_uri(attUrl, null);
                                } catch (e) { if (debug) console.error(`[history] Open failed: ${e.message}`); }
                            }
                        });
                    }
                });
                box.append(attBtn);
                // Images with a url are rendered by the preview above; no extra
                // button or label.
            } else if (!attUrl) {
                box.append(new Gtk.Label({
                    label: `\uD83D\uDCCE ${attText}`,
                    halign: Gtk.Align.START,
                    css_classes: ['caption'],
                }));
            }
        }

        // ponytail: action buttons moved to header row (✓ read, ✕ delete)
        row.set_child(box);
        msgListBox.insert(row, atTop ? 0 : -1);
    }

    // Create an image preview like the ntfy webapp (Notifications.jsx): the
    // image fills the row width (scales with the window), height is capped
    // at 400px, cover-cropped, click opens the original image.
    function _createImagePicture(cachePath) {
        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file(cachePath);
            const iw = pixbuf.get_width();
            const ih = pixbuf.get_height();
            if (iw <= 0 || ih <= 0) {
                if (debug) console.warn(`[history] Invalid image dimensions ${iw}x${ih}: ${cachePath}`);
                return null;
            }

            const MAX_H = 400;

            const picture = new Gtk.Picture({
                hexpand: true,
                halign: Gtk.Align.FILL,
                valign: Gtk.Align.START,
                vexpand: false,
                can_shrink: true,
                content_fit: Gtk.ContentFit.COVER,
                css_classes: ['ntfy-image-preview'],
            });
            picture.set_pixbuf(pixbuf);
            // Pin an initial height so freshly rebuilt rows never render
            // 0-height/anatural-height images for a frame (which collapses the
            // scrolled window and clamps the scroll to top); syncHeight
            // re-derives the exact height from the real allocation on map.
            let estW = msgListBox.get_width() - 24;
            if (estW <= 0) estW = mainVbox.get_width() > 0 ? mainVbox.get_width() : 300;
            picture.set_size_request(0, Math.max(1, Math.min(MAX_H, Math.round(estW * (ih / iw)))));

            // No GTK4 size-allocate signal, so sync the height to the
            // allocated width while mapped (objectFit: cover + maxHeight).
            let lastH = -1;
            let syncTimer = 0;
            const syncHeight = () => {
                const w = picture.get_width();
                if (w > 0) {
                    const h = Math.max(1, Math.min(MAX_H, Math.round(w * (ih / iw))));
                    if (h !== lastH) {
                        lastH = h;
                        // Pin height only (min width 0) → no window min-width lock.
                        picture.set_size_request(0, h);
                    }
                }
            };
            picture.connect('map', () => {
                syncHeight();
                syncTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    if (!picture.get_mapped())
                        return GLib.SOURCE_REMOVE;
                    syncHeight();
                    return GLib.SOURCE_CONTINUE;
                });
            });
            picture.connect('unmap', () => {
                if (syncTimer) {
                    GLib.source_remove(syncTimer);
                    syncTimer = 0;
                }
            });

            const gesture = Gtk.GestureClick.new();
            gesture.set_button(1); // Left click only
            gesture.connect('released', (_gesture, n_press, _x, _y) => {
                if (n_press > 1) return;
                try {
                    const tempDir = GLib.get_tmp_dir();
                    const ext = cachePath.match(/\.([^.]+)$/)?.[1] || 'png';
                    const tempFile = GLib.build_filenamev([tempDir, `ntfy-${Date.now()}.${ext}`]);
                    const srcFile = Gio.File.new_for_path(cachePath);
                    const destFile = Gio.File.new_for_path(tempFile);
                    if (srcFile.query_exists(null)) {
                        srcFile.copy(destFile, Gio.FileCopyFlags.OVERWRITE, null, null);
                        if (destFile.query_exists(null)) {
                            try {
                                Gio.AppInfo.launch_default_for_uri(destFile.get_uri(), null);
                            } catch (e) { if (debug) console.error(`[history] Open image failed: ${e.message}`); }
                        }
                    }
                } catch (e) {
                    if (debug) console.error(`[history] Failed to open image: ${e.message}`);
                }
            });
            picture.add_controller(gesture);

            return picture;
        } catch (e) {
            if (debug) console.error(`[history] Failed to load image: ${e.message}`);
            return null;
        }
    }

    // === IPC: command file (single file, topicUrl in each line) ===
    const _cmdPath = '/tmp/ntfy-cmd.jsonl';

    function _sendCommand(cmd, data) {
        try {
            const file = Gio.File.new_for_path(_cmdPath);
            const ostream = file.append_to(Gio.FileCreateFlags.NONE, null);
            const line = JSON.stringify({ cmd, topicUrl: topicUrlMap[currentTopic], ...data }) + '\n';
            ostream.write_all(new TextEncoder().encode(line), null);
            ostream.close(null);
        } catch (e) {
            if (debug) console.error(`[history] sendCommand failed: ${e.message}`);
        }
    }

    // Mark one message read locally (sidecar for own UI, store update is
    // authoritative via the command poller in the shell)
    function _markReadInStore(t, id) {
        const storePath = _storePath(t);
        _readFileContents(storePath, (contents) => {
            try {
                if (!contents) return;
                const data = JSON.parse(new TextDecoder().decode(contents));
                const n = (data.notifications || []).find(x => x.id === id);
                if (n) { n.new = false; }
                GLib.file_set_contents(storePath, JSON.stringify(data, null, 2));
            } catch (e) { /* ignore */ }
        });
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
                    // Topic switched to one with no local store yet — drop the
                    // previous topic's rows so they don't leak into this view.
                    if (t !== _loadedTopic) _clearRows();
                    return;
                }
                const data = JSON.parse(new TextDecoder().decode(contents));
                const notifications = data.notifications || [];
                const topId = notifications.length ? notifications[0].id : null;
                const freshIds = notifications.map(n => n.id);
                const curIds = [..._rowById.keys()];
                // Structure unchanged (read-state churn, e.g. our own mark-read):
                // skip the rebuild — a clear+repopulate resets the scroll (GTK
                // re-creates the listbox scroll state even if content is identical).
                if (curIds.length > 0 && curIds.length === freshIds.length &&
                    curIds.every((id, i) => id === freshIds[i])) {
                    _lastTopIdByTopic.set(t, topId);
                    return;
                }
                const lastTopIdForThisTopic = _lastTopIdByTopic.get(t) || null;
                const newTop = isCurrentTopic && lastTopIdForThisTopic !== null && topId !== null &&
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
                if (debug) console.error(`[history] Failed to load store for ${t}: ${e.message}`);
            }
        });
    }

    // Keep scroll positions updated as user scrolls
    scrolled.get_vadjustment().connect('changed', () => {
        _scrollByTopic.set(currentTopic, scrolled.get_vadjustment().get_value());
    });

    // === Update topic count in sidebar ===
    function _setTopicCount(t, unread) {
        topicCounts[t] = unread;
        topicItems[t].countLabel.set_text(unread > 0 ? String(unread) : '');
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

    topicListBox.connect('row-selected', (_lb, row) => {
        if (!row) return;
        // Find which topic this row is
        for (const t of allTopics) {
            if (topicItems[t].row === row) {
                _switchTopic(t);
                return;
            }
        }
    });

    // Shared publish sender: builds the Soup message (auth + cert + headers)
    // and runs it, calling onSuccess/onError.
    function _sendPublish(url, method, contentType, bytes, headers, onSuccess, onError) {
        const msg = Soup.Message.new(method, url);
        if (apiKey) msg.request_headers.append('Authorization', 'Bearer ' + apiKey);
        if (acceptSelfSigned === 'true') msg.connect('accept-certificate', (_m, _c, errors) => errors === Gio.TlsCertificateFlags.UNKNOWN_CA);
        for (const [k, v] of Object.entries(headers)) msg.request_headers.append(k, v);
        msg.set_request_body_from_bytes(contentType, bytes);

        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
            try {
                sess.send_and_read_finish(result);
                onSuccess();
            } catch (e) {
                if (debug) console.error(`[history] Publish failed: ${e.message}`);
                if (onError) onError();
            }
        });
    }

    // === Quick Publish (single-line entry) ===
    function _doPublish() {
        const text = publishEntry.get_text().trim();
        if (!text) return;

        sendBtn.set_sensitive(false);
        sendBtn.set_label('Sending...');

        _sendPublish(
            topicUrlMap[currentTopic], 'POST', 'text/plain',
            new TextEncoder().encode(text), {},
            () => { publishEntry.set_text(''); sendBtn.set_label('Send'); sendBtn.set_sensitive(true); },
            () => { sendBtn.set_label('Send'); sendBtn.set_sensitive(true); }
        );
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
        const titleLabel = new Gtk.Label({ label: 'Title', halign: Gtk.Align.START, css_classes: ['caption'] });
        const titleEntry = new Gtk.Entry({ hexpand: true, placeholder_text: 'Optional title' });
        vbox.append(titleLabel);
        vbox.append(titleEntry);

        // Message label + text view
        const msgLabel = new Gtk.Label({ label: 'Message', halign: Gtk.Align.START, css_classes: ['heading'] });
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
        const prioTagsRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
        const prioLabel = new Gtk.Label({ label: 'Priority', css_classes: ['caption'] });
        const prioList = new Gtk.StringList();
        for (const p of ['1 (min)', '2 (low)', '3 (default)', '4 (high)', '5 (max)']) prioList.append(p);
        const prioDrop = new Gtk.DropDown({ model: prioList, selected: 2 });
        const tagsLabel = new Gtk.Label({ label: 'Tags', css_classes: ['caption'] });
        const tagsEntry = new Gtk.Entry({ hexpand: true, placeholder_text: 'tag1, tag2' });
        prioTagsRow.append(prioLabel);
        prioTagsRow.append(prioDrop);
        prioTagsRow.append(tagsLabel);
        prioTagsRow.append(tagsEntry);
        vbox.append(prioTagsRow);

        // Attachment row
        const attRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
        const attBtn = new Gtk.Button({ label: 'Select file...' });
        const attNameLabel = new Gtk.Label({ label: '(none)', hexpand: true, wrap: true, xalign: 0, css_classes: ['caption'] });
        const attClearBtn = new Gtk.Button({ label: '\u2715', css_classes: ['flat', 'circular'] });
        attClearBtn.set_size_request(24, 24);
        attClearBtn.set_visible(false);
        attClearBtn.connect('clicked', () => {
            attachFilePath = null;
            attNameLabel.set_text('(none)');
            attClearBtn.set_visible(false);
        });
        attBtn.connect('clicked', () => {
            const fileDialog = new Gtk.FileDialog();
            fileDialog.open(dlg, null, (fdlg, res) => {
                try {
                    const file = fdlg.open_finish(res);
                    if (file) {
                        attachFilePath = file.get_path();
                        attNameLabel.set_text(attachFilePath.split('/').pop());
                        attClearBtn.set_visible(true);
                    }
                } catch (e) { /* cancelled */ }
            });
        });
        attRow.append(attBtn);
        attRow.append(attNameLabel);
        attRow.append(attClearBtn);
        vbox.append(attRow);

        // Buttons row
        const btnRow = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8, halign: Gtk.Align.END });
        const cancelBtn = new Gtk.Button({ label: 'Cancel' });
        cancelBtn.connect('clicked', () => dlg.close());
        btnRow.append(cancelBtn);

        const publishBtn = new Gtk.Button({ label: 'Publish', css_classes: ['suggested-action'] });
        publishBtn.connect('clicked', () => {
            const startIter = msgBuffer.get_start_iter();
            const endIter = msgBuffer.get_end_iter();
            const text = msgBuffer.get_text(startIter, endIter, true).trim();
            if (!text && !attachFilePath) return;

            const headers = {};
            const title = titleEntry.get_text().trim();
            if (title) headers['Title'] = title;
            const prio = prioDrop.get_selected() + 1;
            if (prio !== 3) headers['Priority'] = String(prio);
            const tags = tagsEntry.get_text().trim();
            if (tags) headers['Tags'] = tags;

            publishBtn.set_sensitive(false);
            publishBtn.set_label('Sending...');

                const doSend = (fileBytes) => {
                // File publish: PUT with filename+message query; text publish: POST
                const isFile = fileBytes !== null;
                if (!isFile && !text) return;
                let url = topicUrlMap[currentTopic];
                if (isFile) {
                    const fileName = attachFilePath.split('/').pop();
                    const queryParts = ['filename=' + encodeURIComponent(fileName)];
                    if (text) queryParts.push('message=' + encodeURIComponent(text));
                    url += '?' + queryParts.join('&');
                }

                _sendPublish(
                    url, isFile ? 'PUT' : 'POST',
                    isFile ? null : 'text/plain',
                    isFile ? fileBytes : new TextEncoder().encode(text),
                    headers,
                    () => dlg.close(),
                    () => { publishBtn.set_label('Publish'); publishBtn.set_sensitive(true); }
                );
            };

            if (attachFilePath) {
                const file = Gio.File.new_for_path(attachFilePath);
                file.load_contents_async(null, (source, result) => {
                    let fileBytes = null;
                    try {
                        const [ok, bytes] = source.load_contents_finish(result);
                        if (!ok) throw new Error('read failed');
                        fileBytes = bytes;
                    } catch (e) {
                        if (debug) console.error('[history] Failed to read attachment file');
                        publishBtn.set_label('Publish');
                        publishBtn.set_sensitive(true);
                        return;
                    }
                    doSend(fileBytes);
                });
            } else {
                doSend(null);
            }
        });
        btnRow.append(publishBtn);
        vbox.append(btnRow);

        // Use content box approach (set_titlebar doesn't work with AdwApplicationWindow)
        const dlgMainBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
        dlgMainBox.append(dlgHeaderBar);
        dlgMainBox.append(vbox);
        dlg.set_content(dlgMainBox);

        dlg.present();
    }

    publishEntry.connect('activate', _doPublish);
    sendBtn.connect('clicked', _doPublish);

    // === Init ===
    function _rebuildMenuItems() {
        menuModel.remove_all();
        menuModel.append(isMuted ? 'Unmute' : 'Mute', 'win.mute');
        menuModel.append('Read all', 'win.readall');
        menuModel.append('Delete all', 'win.deleteall');
    }
    _rebuildMenuItems();
    window.insert_action_group('win', actions);

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
        if (typeof time === 'number') ts = time;
        else if (typeof time === 'string') { ts = Number(time); if (isNaN(ts)) ts = Date.parse(time) / 1000; }
        else ts = 0;
        const d = new Date(ts * 1000);
        const y = d.getFullYear();
        const mo = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const h = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        return `${y}-${mo}-${day} ${h}:${mi}`;
    } catch (e) { return String(time) || '??:??'; }
}

  app.run([]);
}

if (typeof ARGV !== 'undefined' && ARGV.length >= 6)
    main().catch(e => debugLog('[history] main failed:', e));
