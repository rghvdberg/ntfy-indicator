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

imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Adw = '1';
imports.gi.versions.Soup = '3.0';
imports.gi.versions.GdkPixbuf = '2.0';

const { Gtk, Adw, Gio, GLib, Soup, Pango, GdkPixbuf } = imports.gi;

// Attachment downloader for GTK4 (downloads all file types)
class AttachmentDownloader {
  constructor(acceptSelfSigned, apiKey) {
    this.acceptSelfSigned = acceptSelfSigned;
    this.apiKey = apiKey;
    this.session = new Soup.Session();
    
    // Build cache dir
    const dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'ntfy', 'cache']);
    GLib.mkdir_with_parents(dataDir, 0o755);
    this.cacheDir = dataDir;
  }
  
  getCachedAttachment(notificationId, attachmentName) {
    const safeName = `${notificationId}_${attachmentName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const cachePath = GLib.build_filenamev([this.cacheDir, safeName]);
    if (GLib.file_test(cachePath, GLib.FileTest.EXISTS)) {
      return cachePath;
    }
    return null;
  }
  
  getCacheFilePath(notificationId, attachmentName) {
    const safeName = `${notificationId}_${attachmentName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    return GLib.build_filenamev([this.cacheDir, safeName]);
  }
  
  downloadAttachmentFile(url, cachePath) {
    return new Promise((resolve) => {
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
            printerr(`[history] File too large (${size} bytes), skipping: ${url}`);
            resolve(null);
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

          print(`[history] Cached attachment: ${cachePath} (${size} bytes)`);
          resolve(cachePath);
        } catch (e) {
          printerr(`[history] Failed to download/cache file: ${e.message}`);
          resolve(null);
        }
      });
    });
  }
  
  async downloadAttachment(attachment, notificationId) {
    if (!attachment || !attachment.url) {
      return null;
    }
    
    // Download all attachments (not just images)
    const cached = this.getCachedAttachment(notificationId, attachment.name || 'attachment');
    if (cached) {
      return cached;
    }
    
    const cachePath = this.getCacheFilePath(notificationId, attachment.name || 'attachment');
    return await this.downloadAttachmentFile(attachment.url, cachePath);
  }
}

const args = ARGV;
if (args.length < 6) {
    print('Usage: history-dialog.js serverUrl apiKey acceptSelfSigned initialTopic topic1,topic2,... muted');
    imports.system.exit(1);
}

const [serverUrl, apiKey, acceptSelfSigned, initialTopic, topicsArg, mutedArg] = args;
const isMutedInitially = mutedArg === 'true';
const globalBaseUrl = serverUrl.replace(/\/$/, '');

// Parse channel entries: entries may be bare topic names or full URLs
function _parseEntry(entry) {
    if (entry.includes('://')) {
        const lastSlash = entry.lastIndexOf('/');
        return { topic: entry.substring(lastSlash + 1), topicUrl: entry };
    }
    return { topic: entry, topicUrl: `${globalBaseUrl}/${entry}` };
}
const _parsed = topicsArg ? topicsArg.split(',').filter(t => t).map(_parseEntry) : [{ topic: initialTopic, topicUrl: `${globalBaseUrl}/${initialTopic}` }];
const allTopics = _parsed.map(p => p.topic);
const topicUrlMap = {};
for (const p of _parsed) topicUrlMap[p.topic] = p.topicUrl;
const extDir = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'gnome-shell', 'extensions', 'ntfy-indicator@rghvdberg']);
const _dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'ntfy']);
function _storePath(t) { return GLib.build_filenamev([_dataDir, topicUrlMap[t].replace(/[^a-zA-Z0-9]/g, '_') + '.json']); }

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
        _updateTopicCount(currentTopic);
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
        _updateTopicCount(currentTopic);
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

    // Load unread counts from local store
    function _loadTopicCounts() {
        for (const t of allTopics) {
            const storePath = _storePath(t);
            try {
                if (GLib.file_test(storePath, GLib.FileTest.EXISTS)) {
                    const [ok, contents] = GLib.file_get_contents(storePath);
                    if (ok && contents) {
                        const data = JSON.parse(new TextDecoder().decode(contents));
                        const unread = (data.notifications || []).filter(n => n.new !== false && n.new !== 0).length;
                        topicCounts[t] = unread;
                        topicItems[t].countLabel.set_text(unread > 0 ? String(unread) : '');
                    }
                }
            } catch (e) { /* skip */ }
        }
    }
    _loadTopicCounts();

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
        propagate_natural_width: true,
        vexpand: true,
        hexpand: true,
    });
    // Set minimum width for scrolled window to prevent content from shrinking
    scrolled.set_size_request(500, -1);
    const msgListBox = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
    msgListBox.set_size_request(500, -1);
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

    // === Message row builder ===
    function _appendRow(m, atTop = false) {
        const row = new Gtk.ListBoxRow({ selectable: false });
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 12,
            margin_end: 12,
        });
        // Force minimum width for the message box to prevent image shrinking
        box.set_size_request(450, -1);

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
            m.new = 0;
            if (dotLabel) headerBox.remove(dotLabel);
            readBtn.set_visible(false);
            _updateTopicCount(currentTopic);
        });
        headerBox.append(readBtn);

        const delBtn = new Gtk.Button({ label: '\u2715', css_classes: ['flat', 'caption'] });
        delBtn.connect('clicked', () => {
            _sendCommand('delete', { id: m.id });
            msgListBox.remove(row);
            _updateTopicCount(currentTopic);
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
                const picture = Gtk.Picture.new_for_file(Gio.File.new_for_path(cachePath));
                picture.set_halign(Gtk.Align.START);
                picture.set_valign(Gtk.Align.START);
                picture.set_hexpand(false);
                picture.set_vexpand(false);
                picture.set_content_fit(Gtk.ContentFit.SCALE_DOWN);
                picture.set_size_request(400, -1);
                picture.add_css_class('ntfy-image-preview');
                
                const gesture = Gtk.GestureClick.new();
                gesture.connect('pressed', () => {
                    try {
                        const tempDir = GLib.get_tmp_dir();
                        const ext = cachePath.match(/\.([^.]+)$/)?.[1] || 'png';
                        const tempFile = GLib.build_filenamev([tempDir, `ntfy-${Date.now()}.${ext}`]);
                        Gio.File.new_for_path(cachePath).copy(Gio.File.new_for_path(tempFile), Gio.FileCopyFlags.OVERWRITE, null, null);
                        GLib.spawn_command_line_async(`xdg-open '${tempFile}'`);
                    } catch (e) {
                        printerr(`[history] Failed to open image: ${e.message}`);
                    }
                });
                picture.add_controller(gesture);
                box.append(picture);
            } else {
                // Show loading placeholder, download async
                const placeholder = new Gtk.Box({
                    orientation: Gtk.Orientation.VERTICAL,
                    css_classes: ['ntfy-image-loading'],
                    halign: Gtk.Align.START,
                    width_request: 400,
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
                downloader.downloadAttachment(m.attachment, m.id).then(cachePath => {
                    if (cachePath) {
                        const picture = Gtk.Picture.new_for_file(Gio.File.new_for_path(cachePath));
                        picture.set_halign(Gtk.Align.START);
                        picture.set_valign(Gtk.Align.START);
                        picture.set_hexpand(false);
                        picture.set_vexpand(false);
                        picture.set_content_fit(Gtk.ContentFit.SCALE_DOWN);
                        picture.set_size_request(400, -1);
                        picture.add_css_class('ntfy-image-preview');
                        
                        const gesture = Gtk.GestureClick.new();
                        gesture.connect('pressed', () => {
                            try {
                                const tempDir = GLib.get_tmp_dir();
                                const ext = cachePath.match(/\.([^.]+)$/)?.[1] || 'png';
                                const tempFile = GLib.build_filenamev([tempDir, `ntfy-${Date.now()}.${ext}`]);
                                Gio.File.new_for_path(cachePath).copy(Gio.File.new_for_path(tempFile), Gio.FileCopyFlags.OVERWRITE, null, null);
                                GLib.spawn_command_line_async(`xdg-open '${tempFile}'`);
                            } catch (e) {
                                printerr(`[history] Failed to open image: ${e.message}`);
                            }
                        });
                        picture.add_controller(gesture);
                        
                        box.remove(placeholder);
                        box.append(picture);
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
                printerr(`[history] Non-image attachment: ${att.name}, type: ${att.type}, url: ${attUrl}`);
                const attBtn = new Gtk.Button({
                    label: `\uD83D\uDCCE ${attText}`,
                    halign: Gtk.Align.START,
                });
                attBtn.connect('clicked', () => {
                    printerr(`[history] Button clicked: ${att.name}`);
                    const cached = downloader.getCachedAttachment(m.id, att.name || 'attachment');
                    printerr(`[history] Cached: ${cached}`);
                    if (cached) {
                        printerr(`[history] Using cached file: ${cached}`);
                        const file = Gio.File.new_for_path(cached);
                        const appInfo = Gio.AppInfo.get_default_for_type(att.type || 'application/octet-stream', false);
                        printerr(`[history] AppInfo: ${appInfo ? appInfo.get_id() : 'null'}`);
                        if (appInfo) {
                            try {
                                appInfo.launch([file], null);
                                printerr(`[history] Launched with ${appInfo.get_id()}`);
                            } catch (e) {
                                printerr(`[history] Launch error: ${e.message}`);
                                GLib.spawn_command_line_async(`xdg-open '${cached}'`);
                            }
                        } else {
                            GLib.spawn_command_line_async(`xdg-open '${cached}'`);
                        }
                    } else {
                        printerr(`[history] Not cached, downloading from ${att.url}`);
                        printerr(`[history] downloader object: ${downloader}`);
                        printerr(`[history] downloader.downloadAttachment: ${downloader.downloadAttachment}`);
                        printerr(`[history] Calling downloadAttachment with att=${JSON.stringify(att)}, m.id=${m.id}`);
                        const result = downloader.downloadAttachment(att, m.id);
                        printerr(`[history] downloadAttachment returned: ${result}`);
                        if (result && typeof result.then === 'function') {
                            result.then(newCachePath => {
                                printerr(`[history] Download result: ${newCachePath}`);
                                if (newCachePath) {
                                    const file = Gio.File.new_for_path(newCachePath);
                                    const appInfo = Gio.AppInfo.get_default_for_type(att.type || 'application/octet-stream', false);
                                    printerr(`[history] Opening with: ${appInfo ? appInfo.get_id() : 'null'}`);
                                    if (appInfo) {
                                        try {
                                            appInfo.launch([file], null);
                                        } catch (e) {
                                            printerr(`[history] Launch error: ${e.message}`);
                                            GLib.spawn_command_line_async(`xdg-open '${newCachePath}'`);
                                        }
                                    } else {
                                        GLib.spawn_command_line_async(`xdg-open '${newCachePath}'`);
                                    }
                                } else {
                                    printerr(`[history] Download failed, opening URL`);
                                    GLib.spawn_command_line_async(`xdg-open '${attUrl}'`);
                                }
                            }).catch(e => {
                                printerr(`[history] Download error: ${e.message}`);
                                GLib.spawn_command_line_async(`xdg-open '${attUrl}'`);
                            });
                        } else {
                            printerr(`[history] downloadAttachment did not return a Promise: ${result}`);
                            GLib.spawn_command_line_async(`xdg-open '${attUrl}'`);
                        }
                    }
                });
                box.append(attBtn);
            } else if (attUrl && isImage) {
                // Image attachment: already handled by _createImagePreview above
            } else if (attUrl) {
                // Image without cached preview: show button
                const attBtn = new Gtk.Button({
                    label: `\uD83D\uDCCE ${attText}`,
                    css_classes: ['flat'],
                    halign: Gtk.Align.START,
                });
                attBtn.connect('clicked', () => GLib.spawn_command_line_async(`xdg-open '${attUrl}'`));
                box.append(attBtn);
            } else {
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

    // Create image container with fixed width wrapper
    function _createImageContainer(cachePath, fullUrl, mimeType) {
        print(`[history] [IMG] Creating container for: ${cachePath}`);
        
        // Create a container with FIXED width using size_request
        const container = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
        });
        // Force the container to be exactly 400px wide
        container.set_size_request(400, -1);
        print(`[history] [IMG] Container size_request set to 400x-1`);
        
        // Use new_for_file for proper GTK4 image loading
        const picture = Gtk.Picture.new_for_file(Gio.File.new_for_path(cachePath));
        
        // Get the paintable to check image size
        const paintable = picture.get_paintable();
        if (paintable) {
            const iw = paintable.get_intrinsic_width();
            const ih = paintable.get_intrinsic_height();
            print(`[history] [IMG] Paintable intrinsic size: ${iw}x${ih}`);
        }
        
        // Picture should fill the container width, scale down for height
        picture.set_halign(Gtk.Align.FILL);
        picture.set_valign(Gtk.Align.START);
        picture.set_hexpand(false);
        picture.set_vexpand(false);
        picture.set_content_fit(Gtk.ContentFit.SCALE_DOWN);
        picture.add_css_class('ntfy-image-preview');
        
        const gesture = Gtk.GestureClick.new();
        gesture.connect('pressed', () => {
            try {
                const tempDir = GLib.get_tmp_dir();
                const ext = cachePath.match(/\.([^.]+)$/)?.[1] || (mimeType?.split('/')[1] || 'bin');
                const tempFile = GLib.build_filenamev([tempDir, `ntfy-${Date.now()}.${ext}`]);
                const srcFile = Gio.File.new_for_path(cachePath);
                const destFile = Gio.File.new_for_path(tempFile);
                if (srcFile.query_exists(null)) {
                    srcFile.copy(destFile, Gio.FileCopyFlags.OVERWRITE, null, null);
                    if (destFile.query_exists(null)) {
                        const file = Gio.File.new_for_path(tempFile);
                        const appInfo = Gio.AppInfo.get_default_for_type(mimeType || 'application/octet-stream', false);
                        if (appInfo) {
                            appInfo.launch([file], null);
                        } else {
                            GLib.spawn_command_line_async(`xdg-open '${tempFile}'`);
                        }
                    }
                }
            } catch (e) {
                printerr(`[history] Failed to open image: ${e.message}`);
                GLib.spawn_command_line_async(`xdg-open '${fullUrl}'`);
            }
        });
        picture.add_controller(gesture);
        
        container.append(picture);
        print(`[history] [IMG] Container with picture created`);
        return container;
    }

    // === IPC: command file (single file, topicUrl in each line) ===
    const _cmdPath = '/tmp/ntfy-cmd.jsonl';
    function _tmpPath(t) { return `/tmp/ntfy-live-${t}.jsonl`; }

    function _sendCommand(cmd, data) {
        try {
            const file = Gio.File.new_for_path(_cmdPath);
            const ostream = file.append_to(Gio.FileCreateFlags.NONE, null);
            const line = JSON.stringify({ cmd, topicUrl: topicUrlMap[currentTopic], ...data }) + '\n';
            ostream.write_all(new TextEncoder().encode(line), null);
            ostream.close(null);
        } catch (e) {
            printerr(`[history] sendCommand failed: ${e.message}`);
        }
    }

    function _markReadInStore(t, id) {
        try {
            const storePath = _storePath(t);
            if (!GLib.file_test(storePath, GLib.FileTest.EXISTS)) return;
            const [ok, contents] = GLib.file_get_contents(storePath);
            if (!ok || !contents) return;
            const data = JSON.parse(new TextDecoder().decode(contents));
            const n = (data.notifications || []).find(x => x.id === id);
            if (n) { n.new = false; }
            GLib.file_set_contents(storePath, JSON.stringify(data, null, 2));
        } catch (e) { /* ignore */ }
    }

    // === Load messages from local store ===
    function _loadMessages(t) {
        // Clear existing rows
        let child = msgListBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            msgListBox.remove(child);
            child = next;
        }

        const storePath = _storePath(t);

        try {
            if (GLib.file_test(storePath, GLib.FileTest.EXISTS)) {
                const [ok, contents] = GLib.file_get_contents(storePath);
                if (ok && contents) {
                    const data = JSON.parse(new TextDecoder().decode(contents));
                    const notifications = data.notifications || [];
                    printerr(`[history] Loaded ${notifications.length} messages from ${t}`);
                    for (const m of notifications) {
                        _appendRow(m);
                    }
                    printerr(`[history] Added ${notifications.length} rows to listbox`);
                } else {
                    printerr(`[history] No contents in ${storePath}`);
                }
            } else {
                printerr(`[history] Store file does not exist: ${storePath}`);
            }
        } catch (e) {
            printerr(`[history] Failed to load store for ${t}: ${e.message}`);
        }
    }

    // === Update topic count in sidebar ===
    function _updateTopicCount(t) {
        const storePath = _storePath(t);
        try {
            if (GLib.file_test(storePath, GLib.FileTest.EXISTS)) {
                const [ok, contents] = GLib.file_get_contents(storePath);
                if (ok && contents) {
                    const data = JSON.parse(new TextDecoder().decode(contents));
                    const unread = (data.notifications || []).filter(n => n.new !== false && n.new !== 0).length;
                    topicCounts[t] = unread;
                    topicItems[t].countLabel.set_text(unread > 0 ? String(unread) : '');
                }
            }
        } catch (e) { /* skip */ }
    }

    // === Temp file poller (per current topic) ===
    let _lastReadPos = 0;

    function _pollTempFile() {
        try {
            const path = _tmpPath(currentTopic);
            if (!GLib.file_test(path, GLib.FileTest.EXISTS)) return true;
            const [ok, contents] = GLib.file_get_contents(path);
            if (!ok || !contents) return true;
            const text = new TextDecoder().decode(contents);
            const newText = text.slice(_lastReadPos);
            if (newText.length === 0) return true;
            _lastReadPos = text.length;
            for (const line of newText.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const m = JSON.parse(line.trim());
                    _appendRow(m, true);
                    const adj = scrolled.get_vadjustment();
                    adj.set_value(0);
                } catch (e) { /* skip */ }
            }
        } catch (e) { /* ignore */ }
        return true;
    }

    function _startFilePoller() {
        printerr('[history] file poller started');
        GLib.timeout_add(GLib.PRIORITY_LOW, 500, _pollTempFile);
    }

    // === Topic switching ===
    function _switchTopic(t) {
        if (t === currentTopic) return;
        currentTopic = t;
        _lastReadPos = 0;
        // Clear temp file for new topic
        const path = _tmpPath(t);
        if (GLib.file_test(path, GLib.FileTest.EXISTS)) GLib.unlink(path);
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

    // === Quick Publish (single-line entry) ===
    function _doPublish() {
        const text = publishEntry.get_text().trim();
        if (!text) return;

        sendBtn.set_sensitive(false);
        sendBtn.set_label('Sending...');

        const url = topicUrlMap[currentTopic];
        const msg = Soup.Message.new('POST', url);
        if (apiKey) msg.request_headers.append('Authorization', 'Bearer ' + apiKey);
        if (acceptSelfSigned === 'true') msg.connect('accept-certificate', (_m, _c, errors) => errors === Gio.TlsCertificateFlags.UNKNOWN_CA);
        msg.set_request_body_from_bytes('text/plain', new TextEncoder().encode(text));

        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
            try {
                sess.send_and_read_finish(result);
                publishEntry.set_text('');
            } catch (e) {
                printerr(`[history] Publish failed: ${e.message}`);
            }
            sendBtn.set_label('Send');
            sendBtn.set_sensitive(true);
        });
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

                let url = topicUrlMap[currentTopic];

            if (attachFilePath) {
                const file = Gio.File.new_for_path(attachFilePath);
                const [ok, fileBytes] = file.load_contents(null);
                if (!ok) {
                    printerr('[history] Failed to read attachment file');
                    publishBtn.set_label('Publish');
                    publishBtn.set_sensitive(true);
                    return;
                }
                const fileName = attachFilePath.split('/').pop();
                const queryParts = ['filename=' + encodeURIComponent(fileName)];
                if (text) queryParts.push('message=' + encodeURIComponent(text));
                url += '?' + queryParts.join('&');

                const httpMsg = Soup.Message.new('PUT', url);
                if (apiKey) httpMsg.request_headers.append('Authorization', 'Bearer ' + apiKey);
                if (acceptSelfSigned === 'true') httpMsg.connect('accept-certificate', (_m, _c, errors) => errors === Gio.TlsCertificateFlags.UNKNOWN_CA);
                for (const [k, v] of Object.entries(headers)) httpMsg.request_headers.append(k, v);
                httpMsg.set_request_body_from_bytes(null, fileBytes);

                session.send_and_read_async(httpMsg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
                    try {
                        sess.send_and_read_finish(result);
                        dlg.close();
                    } catch (e) {
                        printerr(`[history] Publish failed: ${e.message}`);
                        publishBtn.set_label('Publish');
                        publishBtn.set_sensitive(true);
                    }
                });
            } else {
                if (!text) return;
                const httpMsg = Soup.Message.new('POST', url);
                if (apiKey) httpMsg.request_headers.append('Authorization', 'Bearer ' + apiKey);
                if (acceptSelfSigned === 'true') httpMsg.connect('accept-certificate', (_m, _c, errors) => errors === Gio.TlsCertificateFlags.UNKNOWN_CA);
                for (const [k, v] of Object.entries(headers)) httpMsg.request_headers.append(k, v);
                httpMsg.set_request_body_from_bytes('text/plain', new TextEncoder().encode(text));

                session.send_and_read_async(httpMsg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
                    try {
                        sess.send_and_read_finish(result);
                        dlg.close();
                    } catch (e) {
                        printerr(`[history] Publish failed: ${e.message}`);
                        publishBtn.set_label('Publish');
                        publishBtn.set_sensitive(true);
                    }
                });
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
    _startFilePoller();

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
