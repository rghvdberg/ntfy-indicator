/**
 * Preferences Dialog
 * GTK4 preferences for ntfy extension
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

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { parseTopicUrl, getApiKey } from './utils.js';

export default class NtfyPreferences extends ExtensionPreferences {
  getPreferencesWidget() {
    this.settings = this.getSettings();

    const page = new Adw.PreferencesPage({
      title: 'General',
      icon_name: 'preferences-system-symbolic'
    });

    this._currentPage = page;

    page.add(this._createServerGroup());
    page.add(this._createSubscriptionGroup());
    page.add(this._createNotificationGroup());

    return page;
  }

  _createServerGroup() {
    const group = new Adw.PreferencesGroup({
      title: 'Server'
    });

    // Server URL
    const serverRow = new Adw.EntryRow({
      title: 'Server URL',
      text: this.settings.get_string('server')
    });

    serverRow.connect('changed', (entry) => {
      this.settings.set_string('server', entry.get_text());
    });

    group.add(serverRow);

    // API Key
    const apiKeyRow = new Adw.EntryRow({
      title: 'API Key',
      text: getApiKey(this.settings, this.settings.get_string('server')) || ''
    });

    apiKeyRow.connect('changed', (entry) => {
      this._setApiKey(entry.get_text());
    });

    group.add(apiKeyRow);

    // Accept self-signed certs
    const sslRow = new Adw.SwitchRow({
      title: 'Accept self-signed certificates',
      active: this.settings.get_boolean('accept-self-signed')
    });

    sslRow.connect('notify::active', (row) => {
      this.settings.set_boolean('accept-self-signed', row.get_active());
    });

    group.add(sslRow);

    return group;
  }

  _createSubscriptionGroup() {
    const group = new Adw.PreferencesGroup({
      title: 'Subscriptions'
    });

    const list = new Gtk.ListBox({
      selection_mode: Gtk.SelectionMode.NONE,
      css_classes: ['boxed-list'],
    });
    this._topicList = list;
    this._loadTopics(list);
    group.add(list);

    const addBtn = new Gtk.Button({
      halign: Gtk.Align.START,
      css_classes: ['suggested-action'],
      margin_top: 8,
    });
    const addBtnBox = new Gtk.Box({ spacing: 6 });
    addBtnBox.append(new Gtk.Image({ icon_name: 'list-add-symbolic' }));
    addBtnBox.append(new Gtk.Label({ label: 'Add topic' }));
    addBtn.set_child(addBtnBox);
    addBtn.connect('clicked', () => this._addTopic(list));
    group.add(addBtn);

    return group;
  }

  _loadTopics(list) {
    const globalServer = this.settings.get_string('server');
    for (const entry of this.settings.get_strv('channels')) {
      this._addTopicRow(list, entry, globalServer);
    }
  }

  _addTopicRow(list, entry, globalServer) {
    const { baseUrl, topic } = parseTopicUrl(entry);
    const server = baseUrl || globalServer;
    const row = new Adw.ActionRow({ title: topic, subtitle: server });
    row._channelEntry = entry;
    const removeBtn = new Gtk.Button({
      icon_name: 'user-trash-symbolic',
      css_classes: ['flat', 'circular', 'error'],
      valign: Gtk.Align.CENTER,
    });
    removeBtn.connect('clicked', () => {
      list.remove(row);
      this._saveTopics(list);
    });
    row.add_suffix(removeBtn);
    list.append(row);
  }

  _addTopic(list) {
    const globalServer = this.settings.get_string('server');
    const dialog = new Adw.AlertDialog({
      heading: 'Add topic',
      body: 'Enter a topic name and optionally a different server',
    });
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('add', 'Add');
    dialog.set_response_appearance('add', Adw.ResponseAppearance.SUGGESTED);

    const vbox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    const topicEntry = new Gtk.Entry({ placeholder_text: 'e.g. my-topic' });
    const serverEntry = new Gtk.Entry({ placeholder_text: globalServer, text: '' });
    const serverLabel = new Gtk.Label({ label: 'Server (leave empty for default)', halign: Gtk.Align.START, css_classes: ['caption', 'dim-label'] });
    vbox.append(serverLabel);
    vbox.append(serverEntry);
    vbox.append(new Gtk.Label({ label: 'Topic name', halign: Gtk.Align.START, css_classes: ['caption', 'dim-label'] }));
    vbox.append(topicEntry);
    dialog.set_extra_child(vbox);

    topicEntry.connect('activate', () => dialog.response('add'));

    dialog.connect('response', (_dlg, response) => {
      if (response !== 'add') return;
      const topic = topicEntry.get_text().trim().replace(/[^a-zA-Z0-9_-]/g, '');
      if (!topic) return;
      const server = serverEntry.get_text().trim().replace(/\/+$/, '') || globalServer;
      const channelEntry = server === globalServer ? topic : `${server}/${topic}`;

      const current = this.settings.get_strv('channels');
      if (current.includes(channelEntry)) return;

      this._addTopicRow(list, channelEntry, globalServer);
      this._saveTopics(list);
    });

    dialog.present(this._currentPage);
  }

  _saveTopics(list) {
    const topics = [];
    let child = list.get_first_child();
    while (child) {
      if (child._channelEntry) topics.push(child._channelEntry);
      child = child.get_next_sibling();
    }
    this.settings.set_strv('channels', topics);
  }

  _createNotificationGroup() {
    const group = new Adw.PreferencesGroup({
      title: 'Notifications'
    });

    // History limit
    const historyRow = new Adw.SpinRow({
      title: 'History Limit',
      adjustment: new Gtk.Adjustment({
        lower: 10,
        upper: 1000,
        step_increment: 10,
        page_increment: 100,
        value: this.settings.get_int('history-limit')
      })
    });

    historyRow.connect('notify::value', (spin) => {
      this.settings.set_int('history-limit', spin.get_value());
    });

    group.add(historyRow);

    return group;
  }

  _setApiKey(apiKey) {
    const serverUrl = this.settings.get_string('server');
    try {
      const apiKeysStr = this.settings.get_string('api-keys');
      const apiKeys = JSON.parse(apiKeysStr);
      apiKeys[serverUrl] = apiKey;
      this.settings.set_string('api-keys', JSON.stringify(apiKeys));
    } catch (e) {
      logError(e, 'Failed to save API key');
    }
  }
}
