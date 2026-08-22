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
import Gio from 'gi://Gio';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { subscriptionManager } from './subscription-manager.js';
import { notificationStore } from './notification-store.js';
import { parseTopicUrl, debugLog } from './utils.js';

export const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
  _init(settings, extension) {
    super._init(0.0, 'ntfy-indicator');
    this.settings = settings;
    this._extension = extension;
    this._menuGen = 0;
    this._buttonGen = 0;

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

  async _rebuildMenu() {
    const gen = ++this._menuGen;
    this.menu.removeAll();

    const channels = this.settings.get_strv('channels');
    const defaultServer = this.settings.get_string('server');

    if (channels.length === 0) {
      this.menu.addMenuItem(new PopupMenu.PopupMenuItem('(no topics)'));
    } else {
      const rows = [];
      for (const ch of channels) {
        if (gen !== this._menuGen) return;
        const { baseUrl, topic } = parseTopicUrl(ch);
        const server = baseUrl || defaultServer;
        const topicUrl = `${server}/${topic}`;
        const count = await notificationStore.getUnreadCount(topicUrl);
        if (gen !== this._menuGen) return;
        rows.push({ topic, server, count });
      }
      for (const r of rows) {
        const label = r.count > 0 ? `${r.topic}  (${r.count})` : r.topic;
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect('activate', () => {
          this.menu.close();
          subscriptionManager._openHistoryDialog(r.topic, r.server || this.settings.get_string('server'));
        });
        this.menu.addMenuItem(item);
      }
    }

    if (gen !== this._menuGen) return;

    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    // Settings item
    const settingsItem = new PopupMenu.PopupMenuItem('Settings...');
    settingsItem.connect('activate', () => this._extension.openPreferences());
    this.menu.addMenuItem(settingsItem);
  }

  _setupSignals() {
    this._settingsChangedId = this.settings.connect('changed', (_settings, key) => {
      if (key === 'channels') {
        this._restartSubscriptions();
        this._rebuildMenu();
      }
      else if (key === 'server' || key === 'api-keys' || key === 'accept-self-signed') this._restartSubscriptions();
    });

    notificationStore.setOnChange(() => {
      this._rebuildMenu().catch(e => debugLog('[ntfy] _rebuildMenu failed:', e));
      this._updateButtonText().catch(e => debugLog('[ntfy] _updateButtonText failed:', e));
    });
  }

  _startSubscriptions() {
    for (const u of this.settings.get_strv('channels')) {
      subscriptionManager.subscribe(u);
    }
    this._updateButtonText();
  }

  // Rebuilds all live connections with current settings. Topic subscriptions
  // themselves persist — channels config, store and resume watermark are
  // untouched; only the network streams are torn down and re-opened.
  _restartSubscriptions() {
    subscriptionManager.unsubscribeAll();
    this._startSubscriptions();
  }

  async _updateButtonText() {
    const gen = ++this._buttonGen;
    let total = 0;
    const defaultServer = this.settings.get_string('server');
    for (const ch of this.settings.get_strv('channels')) {
      if (gen !== this._buttonGen) return;
      const { baseUrl, topic } = parseTopicUrl(ch);
      const topicUrl = `${baseUrl || defaultServer}/${topic}`;
      const count = await notificationStore.getUnreadCount(topicUrl);
      total += count;
    }
    if (gen !== this._buttonGen) return;
    if (this._countLabel) {
    this._countLabel.set_text(total > 0 ? `(${total})` : '');
  }
  }

  destroy() {
    if (this._settingsChangedId)
      this.settings.disconnect(this._settingsChangedId);
    notificationStore.setOnChange(null);
    subscriptionManager.unsubscribeAll();
    super.destroy();
  }
});
