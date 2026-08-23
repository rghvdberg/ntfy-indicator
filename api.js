/**
 * ntfy API client — libsoup3, non-blocking
 *
 * Subscribes via the ntfy JSON stream endpoint (GET /<topic>/json?since=...):
 * the server holds the connection open and pushes one JSON object per line.
 * On disconnect the client reconnects with exponential backoff, resuming from
 * the last seen message id.
 *
 * Copyright 2026 Rob van den Berg
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import Soup from 'gi://Soup';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { debugLog } from './utils.js';

// Lines are held back briefly before delivery so that a replayed message and
// its trailing message_delete/message_clear tombstone (adjacent rows in ntfy's
// replay) land in the same batch and never produce a spurious notification.
const BATCH_WINDOW_MS = 300;

export class NtfyApi {
  constructor(serverUrl, apiKey = null, acceptSelfSigned = false) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.acceptSelfSigned = acceptSelfSigned;
    this.session = new Soup.Session();
  }

  _makeMessage(method, path, headers = {}) {
    const msg = Soup.Message.new(method, `${this.serverUrl}${path}`);

    // Opt-in accepts every certificate error class (unknown CA, expired, …);
    // the post-connect check below re-enforces policy across TLS resumption.
    msg.connect('accept-certificate', () => this.acceptSelfSigned);

    if (this.apiKey) {
      msg.request_headers.append('Authorization', `Bearer ${this.apiKey}`);
    }

    for (const [k, v] of Object.entries(headers)) {
      msg.request_headers.append(k, v);
    }

    return msg;
  }

  subscribe(topic, onMessage, onError, since = null) {
    let cancelled = false;
    let timeoutId = null;
    let backoff = 1;
    let lastId = since;
    const cancellable = new Gio.Cancellable();

    let batch = [];
    let batchTimerId = null;

    const flushBatch = () => {
      if (batchTimerId) {
        GLib.source_remove(batchTimerId);
        batchTimerId = null;
      }
      if (!batch.length || cancelled) {
        batch = [];
        return;
      }
      const parsedLines = batch;
      batch = [];

      // Tombstoned replay: within a batch, messages that also carry a
      // message_delete/message_clear are forwarded as the tombstone so they
      // never re-notify.
      const deletedIds = new Set();
      const clearedIds = new Set();
      for (const p of parsedLines) {
        if (!p.sequence_id) continue;
        if (p.event === 'message_delete') deletedIds.add(p.sequence_id);
        else if (p.event === 'message_clear') clearedIds.add(p.sequence_id);
      }
      for (const parsed of parsedLines) {
        if (onMessage) {
          if (parsed.event === 'message' && (deletedIds.has(parsed.id) || clearedIds.has(parsed.id))) {
            const ev = deletedIds.has(parsed.id) ? 'message_delete' : 'message_clear';
            onMessage({ event: ev, sequence_id: parsed.id, id: parsed.id, topic: parsed.topic });
          } else {
            onMessage(parsed);
          }
        }
      }
    };

    const queueLine = (line) => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        debugLog(`[NtfyApi] parse error: ${e.message}`);
        return;
      }
      if (parsed.id) lastId = parsed.id;

      // Hold every line for the batch window: a replayed message and its
      // trailing tombstone must land in one flush to suppress cleanly.
      // Flushing eagerly on tombstones splits adjacency when an unrelated
      // tombstone sits between a message and its own.
      batch.push(parsed);
      if (!batchTimerId && !cancelled) {
        batchTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BATCH_WINDOW_MS, () => {
          batchTimerId = null;
          flushBatch();
          return GLib.SOURCE_REMOVE;
        });
      }
    };

    const readLines = (dataStream) => {
      dataStream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (stream, result) => {
        let line = null;
        try {
          [line] = stream.read_line_finish_utf8(result);
        } catch (e) {
          if (cancelled) return;
          debugLog('[NtfyApi] stream error:', e.message);
          if (onError) onError(e);
          retry();
          return;
        }
        if (line === null) {
          // Server closed the stream; reconnect and resume from lastId.
          if (!cancelled) scheduleReconnect(1);
          return;
        }
        if (line.trim()) queueLine(line);
        if (!cancelled) readLines(dataStream);
      });
    };

    const retry = () => {
      scheduleReconnect(backoff);
      backoff = Math.min(backoff * 2, 30);
    };

    const connect = () => {
      if (cancelled) return;

      const sinceParam = lastId ? lastId : 'all';
      const msg = this._makeMessage('GET', `/${topic}/json?since=${sinceParam}`);

      this.session.send_async(msg, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
        if (cancelled) return;
        let stream;
        try {
          stream = session.send_finish(result);
        } catch (e) {
          if (cancelled) return;
          debugLog('[NtfyApi] connect failed:', e.message);
          if (onError) onError(e);
          retry();
          return;
        }
        // TLS session resumption skips the accept-certificate handshake step,
        // so a connection reused from an earlier permissive policy would
        // silently succeed; enforce policy against the reported cert errors.
        const tlsErrors = msg.get_tls_peer_certificate_errors();
        if (!this.acceptSelfSigned && tlsErrors !== Gio.TlsCertificateFlags.NONE) {
          debugLog(`[NtfyApi] connect rejected: TLS certificate errors=${tlsErrors}`);
          stream.close(null);
          if (onError) onError(new Error('Unacceptable TLS certificate'));
          retry();
          return;
        }
        backoff = 1;
        debugLog(`[NtfyApi] /${topic} CONNECTED (accept=${this.acceptSelfSigned}, since=${sinceParam})`);
        const dataStream = new Gio.DataInputStream({ base_stream: stream });
        readLines(dataStream);
      });
    };

    function scheduleReconnect(delay) {
      if (cancelled) return;
      if (timeoutId) GLib.source_remove(timeoutId);
      timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
        timeoutId = null;
        connect();
        return GLib.SOURCE_REMOVE;
      });
    }

    connect();

    return {
      cancel: () => {
        cancelled = true;
        cancellable.cancel();
        if (timeoutId) GLib.source_remove(timeoutId);
        if (batchTimerId) GLib.source_remove(batchTimerId);
        batchTimerId = null;
      },
    };
  }

  /**
   * One-shot publish (message text or attachment bytes). Honors the live
   * acceptSelfSigned policy, including across TLS session resumption.
   * @param {string} method - POST (text) or PUT (attachment)
   * @param {string} path - Path below serverUrl, e.g. "/mytopic" or with query
   * @param {string|null} contentType - null for raw attachment bytes
   * @returns {Promise<void>}
   */
  publish(method, path, contentType, bytes, headers = {}) {
    return new Promise((resolve, reject) => {
      const msg = this._makeMessage(method, path, headers);
      msg.set_request_body_from_bytes(contentType, bytes);
      this.session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, result) => {
        try {
          session.send_and_read_finish(result);
          const tlsErrors = msg.get_tls_peer_certificate_errors();
          if (!this.acceptSelfSigned && tlsErrors !== Gio.TlsCertificateFlags.NONE) {
            debugLog(`[NtfyApi] publish rejected: TLS certificate errors=${tlsErrors}`);
            reject(new Error('Unacceptable TLS certificate'));
            return;
          }
          resolve();
        } catch (e) {
          debugLog('[NtfyApi] publish failed:', e.message);
          reject(e);
        }
      });
    });
  }
}
