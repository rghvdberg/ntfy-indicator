import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import { NtfyApi } from '../api.js';
import { assert, waitFor, sleepMs, runMain } from './helpers.js';

const BASE = (GLib.getenv('NTFY_TEST_SERVER') || '').replace(/\/$/, '');
const SELF_SIGNED = ['1', 'true', 'yes'].includes((GLib.getenv('NTFY_TEST_SELF_SIGNED') || '').toLowerCase());
const TOPIC = `ext-test-${Date.now()}`;
const session = new Soup.Session();

function makeMsg(method, path, headers = {}, body = null) {
  const msg = Soup.Message.new(method, `${BASE}${path}`);
  if (SELF_SIGNED) msg.connect('accept-certificate', () => true);
  for (const [k, v] of Object.entries(headers)) msg.request_headers.append(k, v);
  if (body !== null)
    msg.set_request_body_from_bytes('text/plain', new GLib.Bytes(new TextEncoder().encode(body)));
  return msg;
}

function send(msg) {
  return new Promise((resolve, reject) => {
    session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, r) => {
      try {
        const bytes = s.send_and_read_finish(r);
        resolve({ status: msg.get_status(), text: new TextDecoder().decode(bytes.get_data()) });
      } catch (e) { reject(e); }
    });
  });
}

const publish = async body => {
  const { status } = await send(makeMsg('POST', `/${TOPIC}`, {}, body));
  assert(status === 200, `publish "${body}" (${status})`);
};

async function fetchId(message) {
  const { text } = await send(makeMsg('GET', `/${TOPIC}/json?poll=1&since=all`));
  return text.trim().split('\n').map(l => JSON.parse(l)).find(m => m.message === message)?.id;
}

function subscribe(events) {
  const api = new NtfyApi(BASE, null, SELF_SIGNED);
  return api.subscribe(TOPIC, e => events.push(e), e => events.push({ event: '__error', err: String(e) }));
}

async function main() {
  if (!BASE) {
    print('SKIP: set NTFY_TEST_SERVER to run api tests');
    return;
  }
  // 1. fresh subscribe: full backlog arrives via since=all
  await publish('A');
  await publish('B');
  let events = [];
  let sub = subscribe(events);
  assert(await waitFor(() => events.filter(e => e.event === 'message').length >= 2),
    'backlog: 2 messages on fresh subscribe');

  // 2. resume: later message arrives, backlog not redelivered
  await publish('C');
  assert(await waitFor(() => events.some(e => e.event === 'message' && e.message === 'C')),
    'resume: new message C delivered');
  assert(events.filter(e => e.event === 'message' && e.message === 'A').length === 1,
    'no redelivery of A after resume');

  // 3. cancel stops delivery
  sub.cancel();
  const countAfterCancel = events.length;
  await publish('W');
  await sleepMs(3000);
  assert(events.length === countAfterCancel, 'cancel: no events after cancel');

  // 4. tombstone batch: message deleted server-side never arrives as message
  await publish('X');
  const xId = await fetchId('X');
  assert(!!xId, 'fetched id for X');
  await send(makeMsg('DELETE', `/${TOPIC}/${xId}`));
  events = [];
  sub = subscribe(events);
  await waitFor(() => events.length > 0);
  await sleepMs(2500);
  sub.cancel();
  assert(!events.some(e => e.event === 'message' && e.id === xId),
    'deleted message never delivered as message (batch suppression)');
  assert(events.some(e => e.event === 'message_delete' && e.sequence_id === xId),
    'message_delete forwarded for deleted id');

  // 5. clear batch: cleared message arrives as message_clear, not message
  await publish('Y');
  const yId = await fetchId('Y');
  assert(!!yId, 'fetched id for Y');
  await send(makeMsg('PUT', `/${TOPIC}/${yId}/clear`));
  events = [];
  sub = subscribe(events);
  await waitFor(() => events.length > 0);
  await sleepMs(2500);
  sub.cancel();
  assert(!events.some(e => e.event === 'message' && e.id === yId),
    'cleared message never delivered as message (batch suppression)');
  assert(events.some(e => e.event === 'message_clear' && e.sequence_id === yId),
    'message_clear forwarded for cleared id');

  // 6. interleaved tombstones: an unrelated tombstone between a message and
  //    its own must not split the batch and leak the message as live
  await publish('P1');
  const p1Id = await fetchId('P1');
  await publish('P2');
  const p2Id = await fetchId('P2');
  await send(makeMsg('DELETE', `/${TOPIC}/${p2Id}`));   // unrelated tombstone first
  await send(makeMsg('PUT', `/${TOPIC}/${p1Id}/clear`)); // P1's own tombstone after
  events = [];
  sub = subscribe(events);
  await waitFor(() => events.length > 0);
  await sleepMs(2500);
  sub.cancel();
  assert(!events.some(e => e.event === 'message' && (e.id === p1Id || e.id === p2Id)),
    'interleaved: neither P1 nor P2 delivered as message');
  assert(events.some(e => e.event === 'message_clear' && e.sequence_id === p1Id) &&
         events.some(e => e.event === 'message_delete' && e.sequence_id === p2Id),
    'interleaved: both tombstones forwarded');
}

runMain(main);
