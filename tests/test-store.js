import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { NotificationStore } from '../notification-store.js';
import { getDataDir, getNotificationFile } from '../utils.js';
import { assert, runMain } from './helpers.js';

const store = new NotificationStore();
const n = (id, time = 0) => ({ id, time, event: 'message', topic: 't', message: `msg ${id}`, new: true });

async function main() {
  // add / dedupe
  assert(await store.addNotification('t-add', n('a1'), 100) === true, 'add new message');
  assert(await store.addNotification('t-add', n('a1'), 100) === false, 'duplicate id rejected');
  assert((await store.load('t-add')).length === 1, 'one row after dup');

  // markRead
  assert(await store.markRead('t-add', 'a1') === true, 'markRead existing');
  let rows = await store.load('t-add');
  assert(rows[0].new === false, 'row marked read');
  assert(await store.getUnreadCount('t-add') === 0, 'unread 0 after markRead');
  assert(await store.markRead('t-add', 'nope') === false, 'markRead missing id -> false, no-op');

  // deleteNotification: removes row, records seenIds (even for unknown ids)
  assert(await store.deleteNotification('t-del', 'ghost') === true, 'delete unknown id still records seenIds');
  let data = await store._readData('t-del');
  assert(data.seenIds.includes('ghost'), 'ghost id in seenIds');
  assert(await store.addNotification('t-del', n('ghost'), 100) === false, 'seenIds suppresses re-add');
  await store.addNotification('t-del', n('d1'), 100);
  assert(await store.deleteNotification('t-del', 'd1') === true, 'delete existing row');
  assert((await store.load('t-del')).length === 0, 'row removed');
  assert((await store._readData('t-del')).seenIds.includes('d1'), 'deleted id in seenIds');

  // markAllRead
  await store.addNotification('t-all', n('m1'), 100);
  await store.addNotification('t-all', n('m2'), 100);
  await store.markAllRead('t-all');
  rows = await store.load('t-all');
  assert(rows.every(r => r.new === false), 'markAllRead clears new flags');
  assert(await store.getUnreadCount('t-all') === 0, 'unread 0 after markAllRead');

  // unread count
  await store.addNotification('t-count', n('c1'), 100);
  await store.addNotification('t-count', n('c2'), 100);
  assert(await store.getUnreadCount('t-count') === 2, 'unread counts new rows');

  // history limit: newest N by time, sorted desc
  await store.addNotification('t-limit', n('l1', 1), 2);
  await store.addNotification('t-limit', n('l2', 2), 2);
  await store.addNotification('t-limit', n('l3', 3), 2);
  rows = await store.load('t-limit');
  assert(rows.length === 2 && rows[0].id === 'l3' && rows[1].id === 'l2',
    `limit trims to newest 2 desc: ${rows.map(r => r.id)}`);

  // lastId watermark
  assert(await store.getLastMessageId('t-wm') === null, 'watermark null initially');
  await store.setLastMessageId('t-wm', 'id123');
  assert(await store.getLastMessageId('t-wm') === 'id123', 'watermark round-trip');

  // concurrent burst: serialized writes, no losses
  const burst = Array.from({ length: 20 }, (_, i) => store.addNotification('t-burst', n(`b${i}`, i), 100));
  const results = await Promise.all(burst);
  assert(results.every(r => r === true), 'burst all added');
  assert((await store.load('t-burst')).length === 20, 'burst: 20 rows, no lost writes');
  assert(await store.getUnreadCount('t-burst') === 20, 'burst unread 20');

  // cross-instance persistence (before the self-heal test wipes the dir)
  const store2 = new NotificationStore();
  assert((await store2.load('t-burst')).length === 20, 'second instance reads same data');
  assert(await store2.getLastMessageId('t-wm') === 'id123', 'second instance reads watermark');

  // self-heal: data dir removed mid-run, write must still land (regression d91efa9)
  const dataDir = getDataDir();
  GLib.spawn_command_line_sync(`rm -rf ${dataDir}`);
  assert(!Gio.File.new_for_path(dataDir).query_exists(null), 'data dir removed');
  assert(await store.addNotification('t-heal', n('h1'), 100) === true, 'add after dir removal');
  assert(Gio.File.new_for_path(getNotificationFile('t-heal')).query_exists(null),
    'store file recreated by _persist self-heal');
}

runMain(main);
