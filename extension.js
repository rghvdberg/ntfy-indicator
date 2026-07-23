/**
 * ntfy GNOME Shell Extension
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

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Indicator } from './indicator.js';
import { initSubscriptionManager, subscriptionManager } from './subscription-manager.js';

export default class NtfyExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    initSubscriptionManager(this._settings);
    this._indicator = new Indicator(this._settings, this);
    Main.panel.addToStatusArea(this.uuid, this._indicator);
    log('[ntfy] Extension enabled');
  }

  disable() {
    if (subscriptionManager) subscriptionManager.unsubscribeAll();
    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }
    this._settings = null;
    log('[ntfy] Extension disabled');
  }
}
