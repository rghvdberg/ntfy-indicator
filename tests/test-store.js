import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { NotificationStore } from '../notification-store.js';
import { attachmentDownloader } from '../attachment-downloader.js';
import { getDataDir, getNotificationFile } from '../utils.js';
import { assert, runMain } from './helpers.js';

const store = new NotificationStore();
const n = (id, time = 0) => ({ id, time, event: 'message', topic: 't', message: `msg ${id}`, new: true });
const na = (id, time = 0) => ({ ...n(id, time), attachment: { name: 'att.txt', url: 'https://x/att.txt' } });

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

  // ===== History Limit (feature #5): comprehensive matrix =====
  const addBulk = (topic, count, limit, pfx) =>
    Promise.all(Array.from({ length: count }, (_, i) => {
      const k = i + 1;
      return store.addNotification(topic, n(`${pfx}${k}`, k), limit);
    }));

  // boundary: exactly 100 stored at limit 100
  await addBulk('hl-b100', 100, 100, 'b');
  assert((await store.load('hl-b100')).length === 100, 'limit 100: exactly 100 stored');

  // boundary: 101 -> 100, oldest dropped, newest kept, sorted desc
  await addBulk('hl-b101', 101, 100, 'c');
  rows = await store.load('hl-b101');
  assert(rows.length === 100, `limit 100: 101 trims to 100 (got ${rows.length})`);
  assert(!rows.some(r => r.id === 'c1'), 'limit 100: oldest (c1) dropped');
  assert(rows.some(r => r.id === 'c101'), 'limit 100: newest (c101) kept');
  const t101 = rows.map(r => r.time);
  assert(t101.every((v, i) => i === 0 || t101[i - 1] >= v),
    `limit 100: sorted descending by time (${t101.join(',')})`);

  // boundary: 150 -> 100, oldest dropped
  await addBulk('hl-b150', 150, 100, 'd');
  rows = await store.load('hl-b150');
  assert(rows.length === 100, `limit 100: 150 trims to 100 (got ${rows.length})`);
  assert(!rows.some(r => r.id === 'd1'), 'limit 100: oldest (d1) dropped on 150');

  // shrink mid-stream: 100 @100 then +1 @10 -> 10 newest
  await addBulk('hl-shrink', 100, 100, 's');
  await store.addNotification('hl-shrink', n('s101', 101), 10);
  rows = await store.load('hl-shrink');
  assert(rows.length === 10, `shrink: 100@100 + 1@10 -> 10 (got ${rows.length})`);
  assert(rows.every(r => r.time >= 92), `shrink: keeps newest 10 (times >=92, got ${rows.map(r => r.time)})`);

  // grow mid-stream: 100 @10 then +1 @100 -> 11
  await addBulk('hl-grow', 100, 10, 'g');
  await store.addNotification('hl-grow', n('g101', 101), 100);
  rows = await store.load('hl-grow');
  assert(rows.length === 11, `grow: 100@10 + 1@100 -> 11 (got ${rows.length})`);

  // deleted message does not occupy a slot toward the limit
  await addBulk('hl-delcnt', 10, 5, 'x6x'); // times 1..10 pfx x6x1..x6x10 -> keeps 5 newest
  assert((await store.load('hl-delcnt')).length === 5, 'delete-slot: 10 @5 -> 5 kept');
  await store.deleteNotification('hl-delcnt', 'x6x6'); // splice, no trim -> 4
  assert((await store.load('hl-delcnt')).length === 4, 'delete-slot: delete -> 4 (no trim)');
  await store.addNotification('hl-delcnt', n('x6x11', 11), 5); // -> back to 5
  rows = await store.load('hl-delcnt');
  assert(rows.length === 5, 'delete-slot: add after delete -> back to 5');
  assert(!rows.some(r => r.id === 'x6x6'), 'delete-slot: deleted id not occupying a slot');

  // read flag preserved on a kept message after trim
  await addBulk('hl-readflag', 4, 3, 'r'); // times 1..4 -> keeps 2,3,4
  await store.markRead('hl-readflag', 'r4'); // mark newest read
  await store.addNotification('hl-readflag', n('r5', 5), 3); // -> 3,4,5
  rows = await store.load('hl-readflag');
  assert(rows.length === 3, 'readflag: 3 kept after trim');
  const rf = rows.find(r => r.id === 'r4');
  assert(rf && rf.new === false, 'readflag: read status preserved on kept message after trim');

  // rapid burst 50 @10 -> 10 newest
  await addBulk('hl-burst50', 50, 10, 'z');
  rows = await store.load('hl-burst50');
  assert(rows.length === 10, `burst 50 @10 -> 10 (got ${rows.length})`);
  assert(rows.every(r => r.time >= 41), `burst: keeps newest 10 (times >=41)`);

  // timestamp ties: stable sort keeps first-inserted (FIFO)
  await store.addNotification('hl-tie', n('f1', 100), 2);
  await store.addNotification('hl-tie', n('f2', 100), 2);
  await store.addNotification('hl-tie', n('f3', 100), 2);
  rows = await store.load('hl-tie');
  assert(rows.map(r => r.id).join(',') === 'f1,f2', `tie: stable FIFO keeps first-inserted (got ${rows.map(r => r.id)})`);

  // non-add op (markRead) does NOT trim when over limit
  await addBulk('hl-markover', 100, 10, 'm'); // keeps times 91..100
  rows = await store.load('hl-markover');
  assert(rows.length === 10, 'markover: 100 @10 -> 10');
  await store.markRead('hl-markover', 'm91'); // markRead passes null limit -> no trim
  rows = await store.load('hl-markover');
  assert(rows.length === 10, 'markover: markRead does NOT trim (still 10)');
  assert(rows.find(r => r.id === 'm91').new === false, 'markover: marked read');

  // ===== Attachment cache cleanup (A/D): bounded by store lifetime =====
  const cacheDir = attachmentDownloader.cacheDir;
  const writeCache = (id, name) => {
    const p = GLib.build_filenamev([cacheDir, `${id}_${name}`]);
    GLib.mkdir_with_parents(cacheDir, 0o755);
    GLib.file_set_contents(p, 'x');
    return p;
  };
  const exists = (p) => Gio.File.new_for_path(p).query_exists(null);

  // delete removes the cached attachment
  const pDel = writeCache('dc1', 'att.txt');
  await store.addNotification('tl-cache', na('dc1', 1), 100);
  assert(exists(pDel), 'cache: file written');
  await store.deleteNotification('tl-cache', 'dc1');
  assert(!exists(pDel), 'cache: delete removes cached attachment');

  // history-limit trim removes the cached attachment of the trimmed row
  const pOld = writeCache('dc2', 'att.txt');
  const pNew = writeCache('dc3', 'att.txt');
  await store.addNotification('tl-trim', na('dc2', 1), 1);
  await store.addNotification('tl-trim', na('dc3', 2), 1);
  assert(!exists(pOld), 'cache: trimmed row attachment removed');
  assert(exists(pNew), 'cache: kept row attachment retained');

  // orphan sweep removes files with no matching live notification
  const pLive = writeCache('dc4', 'att.txt');
  const pOrphan = writeCache('ghost99', 'att.txt');
  await store.addNotification('tl-sweep', na('dc4', 1), 100);
  await store.sweepOrphanedAttachments();
  assert(exists(pLive), 'cache: sweep retains live attachment');
  assert(!exists(pOrphan), 'cache: sweep removes orphaned attachment');
}

runMain(main);
