/**
 * ntfy API client — libsoup3, non-blocking
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

import Soup from 'gi://Soup';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { debugLog } from './utils.js';

export class NtfyApi {
  constructor(serverUrl, apiKey = null, acceptSelfSigned = false) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.acceptSelfSigned = acceptSelfSigned;
    this.session = new Soup.Session();
  }

  _makeMessage(method, path, headers = {}) {
    const msg = Soup.Message.new(method, `${this.serverUrl}${path}`);

    if (this.acceptSelfSigned) {
      msg.connect('accept-certificate', (_msg, _cert, errors) =>
        errors === Gio.TlsCertificateFlags.UNKNOWN_CA
      );
    }

    if (this.apiKey) {
      msg.request_headers.append('Authorization', `Bearer ${this.apiKey}`);
    }

    for (const [k, v] of Object.entries(headers)) {
      msg.request_headers.append(k, v);
    }

    return msg;
  }

  subscribe(topic, onMessage, onError, onOpen, since = null) {
    let cancelled = false;
    let timeoutId = null;
    let backoff = 1;
    let lastId = since;

    const poll = () => {
      if (cancelled) return;

      const sinceParam = lastId ? lastId : 'all';
      const path = `/${topic}/json?poll=1&since=${sinceParam}`;
      const msg = this._makeMessage('GET', path);

      this.session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, result) => {
        if (cancelled) return;

        try {
          const bytes = session.send_and_read_finish(result);
          const text = new TextDecoder().decode(bytes.get_data());

          if (onOpen) onOpen();
          backoff = 1;

          const lines = text.trim().split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed.id) lastId = parsed.id;
              if (onMessage) onMessage(parsed);
            } catch (e) {
              debugLog(`[NtfyApi] parse error: ${e.message}`);
            }
          }

          if (!cancelled) {
            timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
              poll();
              return GLib.SOURCE_REMOVE;
            });
          }
        } catch (e) {
          debugLog('[NtfyApi] subscribe failed:', e);
          if (onError) onError(e);
          const delay = Math.min(backoff * 2, 30);
          backoff = delay;
          if (!cancelled) {
            timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
              poll();
              return GLib.SOURCE_REMOVE;
            });
          }
        }
      });
    };

    poll();

    return {
      cancel: () => {
        cancelled = true;
        if (timeoutId) GLib.source_remove(timeoutId);
      },
    };
  }
}
