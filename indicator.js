/**
 * Status Menu Indicator
 * Uses PanelMenu.Button + GObject.registerClass (required for GNOME 50)
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

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { subscriptionManager } from './subscription-manager.js';
import { notificationStore } from './notification-store.js';
import { getServerUrl, parseTopicUrl } from './utils.js';

export const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
  _init(settings, extension) {
    super._init(0.0, 'ntfy-indicator');
    this.settings = settings;
    this._extension = extension;

    const box = new St.BoxLayout({ style: 'spacing: 4px;' });

    const iconPath = this._extension.path + '/icons/ntfy.svg';
    this._icon = new St.Icon({
      gicon: Gio.FileIcon.new(Gio.File.new_for_path(iconPath)),
      style_class: 'system-status-icon',
    });
    box.add_child(this._icon);

    this._countLabel = new St.Label({
      text: '',
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._countLabel.clutter_text.set_ellipsize(0);
    box.add_child(this._countLabel);

    this.add_child(box);

    this._setupSignals();
    this._startSubscriptions();
    this._rebuildMenu();
  }

  _rebuildMenu() {
    this.menu.removeAll();

    const channels = this.settings.get_strv('channels');
    const defaultServer = getServerUrl(this.settings);

    if (channels.length === 0) {
      this.menu.addMenuItem(new PopupMenu.PopupMenuItem('(no topics)'));
    } else {
      for (const ch of channels) {
        const { baseUrl, topic } = parseTopicUrl(ch);
        const server = baseUrl || defaultServer;
        const topicUrl = `${server}/${topic}`;
        const count = subscriptionManager.getUnreadCount(topicUrl);
        const label = count > 0 ? `${topic}  (${count})` : topic;
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', () => this._openHistoryDialog(topic, server));
        this.menu.addMenuItem(item);
      }
    }

    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    // Settings item
    const settingsItem = new PopupMenu.PopupMenuItem('Settings...');
    settingsItem.connect('activate', () => this._extension.openPreferences());
    this.menu.addMenuItem(settingsItem);
  }

  _openHistoryDialog(topic, server) {
    this.menu.close();
    subscriptionManager._openHistoryDialog(topic, server || getServerUrl(this.settings));
  }

  _setupSignals() {
    this._settingsChangedId = this.settings.connect('changed', (_settings, key) => {
      if (key === 'channels') this._syncChannels();
      else if (key === 'server' || key === 'api-keys' || key === 'accept-self-signed') this._restartSubscriptions();
    });

    this._connectionListener = () => {
      try { this._updateButtonText(); } catch (e) { logError(e, '[ntfy] _updateButtonText failed'); }
    };
    subscriptionManager.addConnectionListener(this._connectionListener);
    notificationStore.setOnChange(() => this._rebuildMenu());
  }

  _syncChannels() {
    const channels = this.settings.get_strv('channels');
    const defaultServer = getServerUrl(this.settings);
    // Resolve channel entries to full topicUrls for comparison
    const urls = channels.map(ch => {
      const { baseUrl, topic } = parseTopicUrl(ch);
      return `${baseUrl || defaultServer}/${topic}`;
    });
    const current = subscriptionManager.getSubscribedTopics();
    for (const u of urls) {
      if (!current.includes(u)) subscriptionManager.subscribe(u);
    }
    for (const u of current) {
      if (!urls.includes(u)) subscriptionManager.unsubscribe(u);
    }
    this._rebuildMenu();
    this._updateButtonText();
  }

  _startSubscriptions() {
    for (const u of this.settings.get_strv('channels')) {
      subscriptionManager.subscribe(u);
    }
    this._updateButtonText();
  }

  _restartSubscriptions() {
    subscriptionManager.unsubscribeAll();
    this._startSubscriptions();
  }

  _updateButtonText() {
    let total = 0;
    const defaultServer = getServerUrl(this.settings);
    for (const ch of this.settings.get_strv('channels')) {
      const { baseUrl, topic } = parseTopicUrl(ch);
      const topicUrl = `${baseUrl || defaultServer}/${topic}`;
      const count = subscriptionManager.getUnreadCount(topicUrl);
      total += count;
    }
    this._countLabel.set_text(total > 0 ? `(${total})` : '');
  }

  destroy() {
    if (this._settingsChangedId)
      this.settings.disconnect(this._settingsChangedId);
    subscriptionManager.removeConnectionListener(this._connectionListener);
    subscriptionManager.unsubscribeAll();
    super.destroy();
  }
});
