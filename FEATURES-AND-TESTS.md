# Complete Feature Matrix & Test Coverage

This document catalogs every feature and setting of the ntfy GNOME Shell extension, with specific test cases to verify correct behavior.

---

## Settings (GSettings Schema)

### 1. Server URL (`server`)
**Type:** String | **Default:** `https://ntfy.sh` | **Range:** Any valid URL

**Behavior:**
- Base URL for ntfy server connections
- Used when topic entries don't include a server URL
- Affects all API calls (subscribe, publish)

**Test Cases:**
- [ ] Default server is `https://ntfy.sh`
- [ ] Can set custom server (e.g., `https://ntfy.example.com`)
- [ ] Custom server used for topic subscriptions
- [ ] Custom server used for publishing
- [ ] Server URL with trailing slash normalized (no double slashes)
- [ ] Server URL with port works (e.g., `https://server.local:12707`)
- [ ] Changing server restarts subscriptions (integration test)
- [ ] Different topics can use different servers (via full URL in channels)

**Regression:** None documented

---

### 2. Accept Self-Signed Certificates (`accept-self-signed`)
**Type:** Boolean | **Default:** `false`

**Behavior:**
- When `true`, accepts TLS certificates with `UNKNOWN_CA` error
- Only rejects `UNKNOWN_CA`, not expired/wrong-host certs
- Applied to all HTTP requests (subscribe, publish, attachment download)

**Test Cases:**
- [ ] Default is `false` (rejects self-signed)
- [ ] When `true`, connects to self-signed server
- [ ] When `true`, still rejects expired certificates
- [ ] When `true`, still rejects wrong-host certificates
- [ ] Toggling setting restarts subscriptions
- [ ] API tests pass with `NTFY_TEST_SELF_SIGNED=1`

**Regression:** None documented

---

### 3. Channels/Topics (`channels`)
**Type:** String Array | **Default:** `[]`

**Behavior:**
- List of topics to subscribe to
- Entries can be:
  - Bare topic name: `my-topic` (uses default server)
  - Full URL: `https://server.local/my-topic` (uses embedded server)
- Multiple topics can use different servers
- Changes trigger subscription restart

**Test Cases:**
- [ ] Empty channels → no subscriptions, "(no topics)" in menu
- [ ] Add bare topic → subscribes to default server/topic
- [ ] Add full URL → subscribes to specific server/topic
- [ ] Remove topic → unsubscribes, stops delivery
- [ ] Change order → menu reflects order
- [ ] Duplicate topic not added (preferences validation)
- [ ] Multiple topics → all subscribed simultaneously
- [ ] Topics with different servers → all work correctly
- [ ] Unread counts sum across all topics in panel
- [ ] Changing channels restarts subscriptions
- [ ] Topic with no store → empty history (not stale rows)

**Regression:** `1f3b943` - Stale rows when switching to topic with no store

---

### 4. API Keys (`api-keys`)
**Type:** String (JSON) | **Default:** `{}`

**Behavior:**
- JSON object mapping server URLs to Bearer tokens
- Format: `{"https://server1.com": "key1", "https://server2.com": "key2"}`
- Applied as `Authorization: Bearer <key>` header
- Per-server keys (not global)

**Test Cases:**
- [ ] Default is empty JSON object
- [ ] Can set API key for server
- [ ] API key sent as Bearer token in requests
- [ ] Different keys for different servers
- [ ] Invalid JSON handled gracefully (no crash)
- [ ] Missing key for server → no Authorization header
- [ ] Key used for subscribe, publish, attachment download
- [ ] Changing key restarts subscriptions

**Regression:** None documented (feature marked "untested" in README)

---

### 5. History Limit (`history-limit`)
**Type:** Integer | **Default:** `100` | **Range:** `10-1000`

**Behavior:**
- **Maximum notifications stored per topic**
- **Applies on every write** (not just on reload)
- **Keeps newest N messages** (sorted by timestamp descending)
- **Oldest messages are dropped** when limit exceeded
- Limit is enforced in `_persist()` after sorting by time

**CRITICAL BEHAVIOR:**
```javascript
const sorted = limit == null
  ? notifications
  : notifications.sort((a, b) => b.time - a.time).slice(0, limit);
```

**Test Cases:**
- [ ] Default limit is 100
- [ ] Can set limit to minimum (10)
- [ ] Can set limit to maximum (1000)
- [ ] Limit < 10 rejected (spinner validation)
- [ ] Limit > 1000 rejected (spinner validation)
- [ ] **100 messages sent** → exactly 100 stored (oldest dropped)
- [ ] **101 messages sent** → exactly 100 stored (newest 100 kept)
- [ ] **150 messages sent** → exactly 100 stored (newest 100 kept)
- [ ] **Oldest messages are dropped** (not newest)
- [ ] **Messages sorted by time descending** (newest first in array)
- [ ] Changing limit to 10 → store trims to 10 on next write
- [ ] Changing limit to 500 → store can grow to 500
- [ ] Limit enforced on initial subscribe (backload)
- [ ] Limit enforced on new message arrival
- [ ] Limit enforced on replay after store wipe
- [ ] Deleted messages don't count toward limit
- [ ] Read/unread status preserved in trimmed store

**Edge Cases:**
- [ ] **Rapid burst (50 messages)** → all stored, then trimmed to limit
- [ ] **Limit changed mid-session** → next write applies new limit
- [ ] **Limit = 10, 100 existing messages** → trim to newest 10 on next activity
- [ ] **Timestamp ties** → stable sort order (FIFO among same-time messages)

**Regression:** None documented (feature working as designed)

**⚠️ IMPORTANT:** This is **not** a "keep last N hours" limit. It's a **count-based** limit on the **newest messages**. If you have 1000 messages and limit=100, you keep the **100 most recent** (by timestamp), not the last 100 received.

---

### 6. Muted Topics (`muted-topics`)
**Type:** String (JSON) | **Default:** `{}`

**Behavior:**
- JSON object mapping topic URLs to mute expiry timestamps (Unix epoch seconds)
- Format: `{"https://server/topic": 1234567890.123}`
- While muted: **messages still stored**, **unread count still incremented**, **desktop banners suppressed**
- Mute expires automatically after timestamp passes
- Mute duration: default 3600 seconds (1 hour) from mute action

**CRITICAL SEMANTICS:**
- **Mute ≠ Delete**: Messages are stored, just not notified
- **Mute ≠ Read**: Unread count still increments
- **Mute is time-based**: Auto-expires, no manual unmute required
- **Mute is per-topic**: Affects all messages to that topic

**Test Cases:**
- [ ] Default is empty JSON object
- [ ] Mute topic → no desktop banners for new messages
- [ ] Muted topic → messages still stored in history
- [ ] Muted topic → unread count still increments
- [ ] Muted topic → panel count still updates
- [ ] Mute expires → banners resume automatically
- [ ] Unmute topic → banners resume immediately
- [ ] Mute duration configurable (via settings or API)
- [ ] Multiple topics muted → all suppressed
- [ ] Mute state persists across session restart
- [ ] Mute state shown in dialog (icon or label)
- [ ] Mute state shown in panel menu (icon or label)
- [ ] Changing mute state updates dialog menu labels

**Web App Behavior Match:**
- [ ] Web app shows "NotificationsOff" icon for muted topics
- [ ] Web app shows "Muted" tooltip
- [ ] Our extension shows icon in panel menu (TODO: AGENTS.md notes this as deferred)
- [ ] Our extension shows icon in dialog sidebar (TODO: AGENTS.md notes this as deferred)

**Regression:** None documented (feature marked as "no visible indicator" in known issues)

---

## Core Features

### 7. Real-Time Subscription (Long Polling)
**Implementation:** `api.js` - `NtfyApi.subscribe()`

**Behavior:**
- HTTP long-polling to `/topic/json?poll=1&since=<id|all>`
- Exponential backoff on error (1s, 2s, 4s, 8s, ... max 30s)
- Resumes from last delivered message ID (`lastId` watermark)
- Fresh subscribe: `since=all` loads full backlog
- Resume: `since=<lastId>` loads only new messages

**Test Cases:**
- [ ] Fresh subscribe → full backlog delivered
- [ ] Resume → only new messages delivered
- [ ] `lastId` watermark persisted after each message
- [ ] Watermark survives session restart
- [ ] Watermark survives extension disable/enable
- [ ] Watermark survives store wipe (deleted messages stay suppressed)
- [ ] Network error → exponential backoff starts
- [ ] Reconnect → backoff resets to 1s
- [ ] Cancel subscription → stops delivery immediately
- [ ] Multiple topics → independent subscriptions
- [ ] Subscription state shown in panel (connection indicator)

**Regression:** `a92d3ac` - Resume from persisted `lastId`

---

### 8. Message Deduplication
**Implementation:** `notification-store.js` - `addNotification()`

**Behavior:**
- Checks if message ID exists in `notifications` array
- Checks if message ID exists in `seenIds` array
- Returns `false` if duplicate or previously seen
- Never re-notifies a message that was ever delivered

**Test Cases:**
- [ ] Same message ID sent twice → only first delivered
- [ ] Message in `seenIds` → never re-delivered
- [ ] Deleted message ID → never re-delivered (in `seenIds`)
- [ ] Cleared message ID → never re-delivered as message
- [ ] Replay after store wipe → deleted/cleared stay suppressed
- [ ] Duplicate ID rejected even if message content differs
- [ ] Deduplication works across topic re-subscribe

**Regression:** `a92d3ac` - Serialize writes to prevent dedup race

---

### 9. Desktop Notifications
**Implementation:** `subscription-manager.js` - `_showNotification()`

**Behavior:**
- Uses GNOME MessageTray for desktop banners
- Title: `msg.title` or `ntfy: <topic>`
- Body: `msg.message`
- Click action priority: `msg.click` URL > `msg.attach` URL > history dialog
- Pre-caches attachments for history dialog
- Source auto-destroys when all notifications dismissed (recreated on next message)

**Test Cases:**
- [ ] New message → desktop banner appears
- [ ] Banner shows correct title
- [ ] Banner shows correct message body
- [ ] Banner shows priority indicator (if msg.priority set)
- [ ] Banner shows tags (if msg.tags set)
- [ ] Click banner (no URL) → opens history dialog
- [ ] Click banner (msg.click) → opens click URL in browser
- [ ] Click banner (msg.attach) → opens attachment
- [ ] Non-image attachment → copied to ~/Downloads
- [ ] Dismiss all banners → source destroyed
- [ ] New message after dismiss → source recreated, banner appears
- [ ] Muted topic → no banner
- [ ] Multiple topics → banners from all topics appear
- [ ] Rapid messages → each gets separate banner

**Regression:**
- `df05d47` - Click URL opens in browser (not history dialog)
- `1024102` - Non-image attachment copied to Downloads
- `60b8cfb` - Source auto-destroy, no new banners

---

### 10. Unread Count Tracking
**Implementation:** `notification-store.js` - `getUnreadCount()`

**Behavior:**
- Counts messages where `new === true`
- Excludes deleted/cleared messages
- Excludes messages marked read (`new === false`)
- Summed across all topics for panel display
- Per-topic count shown in menu and dialog sidebar

**Test Cases:**
- [ ] New message → unread count increments
- [ ] Mark read → unread count decrements
- [ ] Mark all read → unread count = 0
- [ ] Delete message → unread count decrements
- [ ] Delete all → unread count = 0
- [ ] Muted topic → unread count still increments
- [ ] Panel count = sum of all topic counts
- [ ] Menu item shows per-topic count
- [ ] Dialog sidebar shows per-topic count
- [ ] Count updates within ~1s of message arrival
- [ ] Count survives session restart
- [ ] Count correct after replay (deleted stay suppressed)

**Regression:** `6438136` - Unread counts out of sync with store

---

### 11. History Dialog
**Implementation:** `history-dialog.js` - Standalone GTK4 app

**Behavior:**
- Spawned as subprocess via `gjs -m`
- Communicates with shell via `/tmp/ntfy-cmd.jsonl` command file
- Topics sidebar with unread counts
- Message list with read/delete actions
- Publish entry (quick and advanced modes)
- Image previews (max 400px height, fill width)
- Scroll position preserved on topic switch

**Test Cases:**
- [ ] Opens from panel menu topic click
- [ ] Topics sidebar lists all channels
- [ ] Sidebar shows per-topic unread counts
- [ ] Click topic → loads that topic's messages
- [ ] Topic with no store → empty list (not stale)
- [ ] Message list shows title, body, time, priority, tags
- [ ] Message list shows image preview (if attachment)
- [ ] Image scales to fill width, max 400px height
- [ ] Image preview works for all formats (PNG, JPG, WebP)
- [ ] Image preview works for wide/tall/square/4K images
- [ ] Click image → opens in default image viewer
- [ ] Click message row → opens click URL (if msg.click)
- [ ] Click delete button → removes message
- [ ] Click read button → marks message read
- [ ] Delete all → clears all messages
- [ ] Mark all read → marks all read
- [ ] Mute topic → no new banners (until expiry)
- [ ] Unmute topic → banners resume
- [ ] Publish quick (single-line) → message appears
- [ ] Publish advanced (multiline + fields) → message appears
- [ ] Publish with attachment → attachment appears
- [ ] Publish with title → title shown
- [ ] Publish with priority → priority shown
- [ ] Publish with tags → tags shown
- [ ] Scroll to bottom, switch topic, switch back → scroll preserved
- [ ] Click topic already open → window kept (not respawned)
- [ ] Dialog closes → shell continues running
- [ ] Dialog crash → shell handles gracefully

**Regression:**
- `1f3b943` - Stale rows when switching to topic with no store
- `2b3eefb` - Scroll reset on topic switch
- `2b3eefb` - Dialog respawn on same-topic click
- `b19e47f` - Placeholder not replaced by image
- `aef3f35` + 15 commits - Image preview sizing saga
- `329d1f9` - Double-click opens image twice
- `b90c821` - Double-click duplicate prevention

**Known Issues:**
- Delete causes brief scroll jump (cosmetic, deferred)
- No persistent mute indicator in panel/sidebar (deferred)

---

### 12. Publish Feature
**Implementation:** `history-dialog.js` - `_doPublish()`, `_openPublishDialog()`

**Behavior:**
- **Quick publish:** Single-line entry, sends as plain text
- **Advanced publish:** Full dialog with title, message, priority, tags, attachment
- Publishes to current topic
- Supports file attachments (any type)
- Headers: Title, Priority, Tags, Click, Attach, etc.

**Test Cases:**
- [ ] Quick publish → message appears in history
- [ ] Quick publish → desktop banner appears
- [ ] Quick publish → title from entry
- [ ] Advanced publish → title field works
- [ ] Advanced publish → multiline message works
- [ ] Advanced publish → priority dropdown works (1-5)
- [ ] Advanced publish → tags field works
- [ ] Advanced publish → file selection works
- [ ] Advanced publish → attachment uploaded
- [ ] Advanced publish → attachment appears in history
- [ ] Publish to different topics → correct topic
- [ ] Publish with custom server → correct server
- [ ] Publish fails → error shown, button re-enabled
- [ ] Publish in progress → button disabled, "Sending..." label
- [ ] Cancel publish → dialog closes, no message sent

**Regression:** None documented

---

### 13. Attachment Handling
**Implementation:** `attachment-downloader.js`, `history-dialog.js`

**Behavior:**
- **Shell:** Pre-caches attachments on message arrival
- **Dialog:** Reads from cache (no network IO)
- **Cache location:** `~/.local/share/ntfy/cache`
- **Cache limit:** 5 MB per file
- **Image preview:** GdkPixbuf, max 400px height, fill width
- **Non-image:** Copy to ~/Downloads, open with default app

**Test Cases:**
- [ ] Image attachment → cached on arrival
- [ ] Image attachment → preview in dialog
- [ ] Image preview scales to fill width
- [ ] Image preview max height 400px
- [ ] Image preview works for PNG
- [ ] Image preview works for JPG
- [ ] Image preview works for WebP
- [ ] Image preview works for wide images
- [ ] Image preview works for tall images
- [ ] Image preview works for square images
- [ ] Image preview works for 4K images
- [ ] Click image → opens in image viewer
- [ ] Non-image attachment → cached on arrival
- [ ] Non-image attachment → "Open" copies to ~/Downloads
- [ ] Non-image attachment → opens with default app
- [ ] Duplicate attachment name → numbered suffix
- [ ] Attachment > 5 MB → rejected (not cached)
- [ ] Attachment download fails → no crash, placeholder shown
- [ ] Cache survives session restart
- [ ] Cache cleared → re-downloads on demand

**Regression:**
- `2495e0c` - Image preview in history dialog (callback-based)
- `be90ff8` - Drop duplicate AttachmentDownloader
- `1024102` - Non-image to Downloads

---

### 14. Server Delete/Clear Tombstones
**Implementation:** `api.js`, `subscription-manager.js`

**Behavior:**
- Server emits `message_delete` event when message deleted
- Server emits `message_clear` event when message cleared
- **Delete:** Removes message from store, adds ID to `seenIds`
- **Clear:** Marks message read, adds ID to `seenIds`
- **Batch tombstoning:** If delete/clear in same poll batch as message, message is converted to tombstone (never delivered as message)
- **Replay suppression:** Deleted/cleared IDs in `seenIds` never re-delivered

**Test Cases:**
- [ ] Server delete → message removed from store
- [ ] Server delete → ID in `seenIds`
- [ ] Server delete → unread count decrements
- [ ] Server delete → never re-delivered on replay
- [ ] Server clear → message stays in store
- [ ] Server clear → message marked read (`new=false`)
- [ ] Server clear → ID in `seenIds`
- [ ] Server clear → unread count decrements
- [ ] Server clear → never re-delivered as message
- [ ] Batch delete → message never arrives as message
- [ ] Batch delete → `message_delete` event forwarded
- [ ] Batch clear → message never arrives as message
- [ ] Batch clear → `message_clear` event forwarded
- [ ] Wipe store → deleted messages stay suppressed
- [ ] Wipe store → cleared messages stay suppressed

**Regression:** `f578b2e` - Honor server delete/clear events

---

### 15. Store Persistence & Serialization
**Implementation:** `notification-store.js`

**Behavior:**
- **Storage:** Per-topic JSON files in `~/.local/share/ntfy/`
- **Format:** `{ notifications, seenIds, lastId, lastUpdated }`
- **Serialization:** Writes per topic are serialized (no concurrent writes)
- **Self-heal:** Recreates data dir if missing
- **Atomic writes:** Uses `replace_contents_async`

**Test Cases:**
- [ ] Store file created on first message
- [ ] Store file path safe (topic URL → filename)
- [ ] Store survives session restart
- [ ] Store survives extension disable/enable
- [ ] Concurrent writes (burst 20) → all succeed, no data loss
- [ ] Concurrent writes → serialized order preserved
- [ ] Data dir deleted → recreated on next write
- [ ] Write failure → logged, no crash
- [ ] Corrupt JSON → handled gracefully (no crash)
- [ ] Large store (1000 messages) → loads quickly
- [ ] Store permissions → 0o755 (readable by user)

**Regression:**
- `d91efa9` - Self-heal missing data dir
- `a92d3ac` - Serialize writes to prevent race

---

### 16. Lifecycle Management
**Implementation:** `extension.js`, `indicator.js`, `subscription-manager.js`

**Behavior:**
- **Enable:** Creates indicator, starts subscriptions, wires signals
- **Disable:** Stops subscriptions, destroys indicator, disconnects signals
- **Re-enable:** Recreates everything from scratch
- **Session restart:** Extension auto-loads if enabled
- **Source recreation:** MessageTray source recreated if auto-destroyed

**Test Cases:**
- [ ] Enable → indicator appears in panel
- [ ] Enable → subscriptions start
- [ ] Enable → signals wired
- [ ] Disable → indicator removed
- [ ] Disable → subscriptions stopped
- [ ] Disable → signals disconnected
- [ ] Disable → no memory leaks
- [ ] Re-enable → indicator returns
- [ ] Re-enable → subscriptions restart
- [ ] Re-enable → messages delivered
- [ ] Disable/enable in same session → no errors in journal
- [ ] Session restart (GDM) → extension auto-loads ACTIVE
- [ ] Extension info → Enabled: Yes, State: ACTIVE
- [ ] No errors after multiple enable/disable cycles

**Regression:**
- `f578b2e` - destroy() not wired to disable()
- `60b8cfb` - Source auto-destroy, no recreation

---

## Edge Cases & Stress Tests

### 17. Burst Messages
**Test Cases:**
- [ ] 50 messages in 1 second → all stored
- [ ] 50 messages → all delivered (no lost writes)
- [ ] 50 messages → all banners shown
- [ ] 50 messages → unread count = 50
- [ ] 50 messages + limit=10 → 10 stored (newest)
- [ ] Burst + concurrent writes → serialized, no corruption

**Integration Test:** `tests/test-integration.sh` - burst section

---

### 18. Topic Switching
**Test Cases:**
- [ ] Switch topic → correct messages load
- [ ] Switch topic → correct unread count
- [ ] Switch topic → scroll position preserved
- [ ] Switch to topic with no store → empty list
- [ ] Switch back → previous scroll restored
- [ ] Rapid switching → no crashes, no stale data

**Regression:** `2b3eefb` - Scroll reset on topic switch

---

### 19. Network Resilience
**Test Cases:**
- [ ] Network down → exponential backoff starts
- [ ] Network down → no crash, no spam logs
- [ ] Network up → reconnects, backoff resets
- [ ] Server restart → reconnects, resumes from lastId
- [ ] Server timeout → backoff, retry
- [ ] Invalid server URL → error logged, no crash

**Regression:** None documented

---

### 20. Large History
**Test Cases:**
- [ ] 1000 messages stored → loads quickly
- [ ] 1000 messages → scrolling smooth
- [ ] 1000 messages → memory usage reasonable
- [ ] 1000 messages + limit=100 → trimmed to 100
- [ ] 1000 messages + delete 500 → 500 remain
- [ ] 1000 messages + mark all read → all read

**Regression:** None documented

---

## Summary: Test Coverage Matrix

| Feature | Unit Tests | Integration Tests | Manual Tests | Status |
|---------|-----------|-------------------|--------------|--------|
| Server URL | ✅ | ✅ | ✅ | Covered |
| Self-signed certs | ✅ | ✅ | ✅ | Covered |
| Channels/Topics | ✅ | ✅ | ✅ | Covered |
| API Keys | ❌ | ❌ | ⚠️ | Untested |
| History Limit | ✅ | ✅ | ✅ | Covered |
| Muted Topics | ❌ | ❌ | ⚠️ | Partial |
| Long Polling | ✅ | ✅ | ✅ | Covered |
| Deduplication | ✅ | ✅ | ✅ | Covered |
| Desktop Notifications | ❌ | ✅ | ✅ | Partial |
| Unread Count | ✅ | ✅ | ✅ | Covered |
| History Dialog | ❌ | ✅ | ✅ | Partial |
| Publish | ❌ | ❌ | ✅ | Manual only |
| Attachments | ❌ | ✅ | ✅ | Partial |
| Tombstones | ✅ | ✅ | ❌ | Unit/Integration |
| Persistence | ✅ | ✅ | ❌ | Unit/Integration |
| Lifecycle | ❌ | ✅ | ✅ | Partial |
| Burst | ❌ | ✅ | ❌ | Integration only |
| Topic Switch | ❌ | ❌ | ✅ | Manual only |
| Network Resilience | ❌ | ❌ | ❌ | Not tested |
| Large History | ❌ | ❌ | ❌ | Not tested |

**Legend:** ✅ = Covered, ⚠️ = Partial, ❌ = Not tested

---

## Priority Test Gaps

1. **API Keys** - No automated tests (untested feature)
2. **Muted Topics** - No automated tests, no visible indicator
3. **Publish** - Manual testing only
4. **Network Resilience** - No tests for offline/reconnect
5. **Large History** - No stress tests for 1000+ messages
6. **Topic Switch** - Manual testing only

**Recommendation:** Add unit tests for muted topics and publish, add integration tests for network resilience and large history.