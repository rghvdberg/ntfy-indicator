# Comprehensive Test Checklist

This document catalogs all testable features based on the project's git history.
Tests are categorized by type: **Automated** (unit/integration) and **Manual** (L3 human verification).

---

## Automated Tests

### Unit Tests (`./tests/run.sh`)

#### Utils Tests (`tests/test-utils.js`)
- [ ] `parseTopicUrl()` - bare topic names
- [ ] `parseTopicUrl()` - full URLs with protocol
- [ ] `parseTopicUrl()` - URLs with custom ports
- [ ] `parseTopicUrl()` - IPv6 hostnames
- [ ] `getApiKey()` - valid JSON parsing
- [ ] `getApiKey()` - missing server returns null
- [ ] `getApiKey()` - invalid JSON returns null

#### Store Tests (`tests/test-store.js`)
- [ ] **addNotification** - new message added
- [ ] **addNotification** - duplicate ID rejected
- [ ] **addNotification** - prevents re-notification of seen IDs
- [ ] **markRead** - marks notification as read
- [ ] **markRead** - returns false for unknown ID
- [ ] **deleteNotification** - removes row from store
- [ ] **deleteNotification** - records deleted ID in seenIds
- [ ] **deleteNotification** - deletes unknown ID (records in seenIds)
- [ ] **markAllRead** - marks all notifications read
- [ ] **unreadCount** - counts new notifications
- [ ] **historyLimit** - keeps newest N by timestamp
- [ ] **historyLimit** - sorts descending by time
- [ ] **lastId watermark** - persists resume point
- [ ] **lastId watermark** - null initially
- [ ] **concurrent writes** - serialized writes prevent data loss
- [ ] **concurrent writes** - burst of 20 messages all stored
- [ ] **cross-instance persistence** - second instance reads same data
- [ ] **self-heal** - recreates data dir if removed mid-run (d91efa9)

#### API Tests (`tests/test-api.js`) - requires `NTFY_TEST_SERVER`
- [ ] **fresh subscribe** - full backlog delivered via `since=all`
- [ ] **resume** - new messages arrive, backlog not redelivered
- [ ] **cancel** - stops delivery after cancel
- [ ] **tombstone batch** - deleted message never arrives as message
- [ ] **tombstone batch** - message_delete event forwarded
- [ ] **tombstone batch** - cleared message arrives as message_clear
- [ ] **exponential backoff** - reconnects with increasing delay
- [ ] **self-signed certs** - accepts when configured

### Integration Tests (`./tests/test-integration.sh`) - requires VM + `NTFY_TEST_SERVER`

#### Deploy & Lifecycle
- [ ] Extension activates after deploy
- [ ] Extension ACTIVE after disable/enable cycle
- [ ] No errors in journal after lifecycle operations

#### Publish + Store
- [ ] Plain text message stored
- [ ] Message with title stored
- [ ] Image attachment stored
- [ ] Three rows stored after 3 publishes
- [ ] All 3 unread initially

#### Server Delete
- [ ] Deleted row removed from store
- [ ] Deleted ID in seenIds
- [ ] Unread count drops after delete

#### Server Clear
- [ ] Cleared row stays in store
- [ ] Cleared row marked read (new=false)
- [ ] Unread count drops after clear

#### Wipe + Replay Suppression
- [ ] Store file removed
- [ ] Untouched message re-added on replay
- [ ] Re-added message is new
- [ ] Deleted message stays suppressed
- [ ] Cleared message stays suppressed
- [ ] Unread count correct after replay

#### Burst (No Lost Writes)
- [ ] 50 rapid publishes all stored
- [ ] 51 rows after burst (plus prior)
- [ ] 51 unread after burst

#### History Limit Trim
- [ ] Limit honored after topic re-subscribe
- [ ] Trims to configured limit (e.g., 10)

---

## Manual Tests (`./tests/MANUAL.md`)

### Panel Indicator
- [ ] Icon visible in panel
- [ ] Count label shows summed unread across topics
- [ ] Count updates within ~1s of new message
- [ ] Menu lists each topic with its own unread count
- [ ] After mark-all-read in dialog, panel count clears (6438136)

### Desktop Notifications
- [ ] New message shows banner with title/body
- [ ] Click banner (plain message) → opens history dialog
- [ ] Click banner (message with Click URL) → opens URL (df05d47)
- [ ] Click banner (message with attachment) → opens attachment
- [ ] Non-image attachment → copied to ~/Downloads (1024102)
- [ ] Dismiss all, send another → banner still appears (60b8cfb)
- [ ] Muted topic → no banner
- [ ] After mute expiry → banners resume

### History Dialog
- [ ] Opens from menu topic click
- [ ] Topics sidebar shows unread counts
- [ ] Image previews render at sensible size (all fixtures):
    - [ ] img01.png - wide image
    - [ ] img02.png - tall image
    - [ ] img03.png - square image
    - [ ] img04.png - 4K image
    - [ ] img05.jpg - JPEG
    - [ ] img06.webp - WebP
    - [ ] img07.png - edge case
- [ ] Placeholder replaced by actual image after download (b19e47f)
- [ ] Delete a message → row removed
    - **KNOWN ISSUE**: list briefly jumps to top then back (cosmetic, deferred)
    - [ ] Confirm no worse than documented
- [ ] Switch topics → correct rows shown
- [ ] Topic with no store → empty list, not stale rows (1f3b943)
- [ ] Scroll to bottom, switch topic, switch back → scroll preserved (2b3eefb)
- [ ] Click topic whose dialog is already open → window kept, no respawn (2b3eefb)
- [ ] Publish from dialog entry → message appears in dialog and on feed
- [ ] Mark read / mark all read / delete → panel count follows

### Preferences
- [ ] Server URL field works
- [ ] Accept self-signed toggle works
- [ ] API keys JSON field (per-server Bearer)
- [ ] Add bare topic (uses default server)
- [ ] Add full URL (uses embedded server)
- [ ] Remove topic
- [ ] Subscriptions follow channel changes
- [ ] History limit 10–1000 honored

### Lifecycle
- [ ] Disable → enable in same session: no errors, indicator returns (f578b2e)
- [ ] Full session restart (GDM): extension auto-loads ACTIVE

---

## Regression Test Matrix

| Commit | Issue | Test Location |
|--------|-------|---------------|
| `6438136` | Unread counts out of sync | Manual: Panel indicator |
| `df05d47` | Click URL opens in browser | Manual: Desktop notifications |
| `1024102` | Non-image attachment to Downloads | Manual: Desktop notifications |
| `60b8cfb` | Source auto-destroy, no new banners | Integration: Lifecycle |
| `1f3b943` | Stale rows when switching topics | Manual: History dialog |
| `2b3eefb` | Scroll reset on topic switch | Manual: History dialog |
| `2b3eefb` | Dialog respawn on same-topic click | Manual: History dialog |
| `d91efa9` | Missing data dir not self-healed | Unit: Store self-heal |
| `f578b2e` | destroy() not wired to disable() | Integration: Lifecycle |
| `b19e47f` | Placeholder not replaced | Manual: History dialog |
| `aef3f35` | Image preview sizing (16 commits) | Manual: Image previews |
| `82642c8` | CSS sizing fixes | Manual: Image previews |
| `329d1f9` | Double-click opens image twice | Manual: Image previews |
| `b90c821` | Double-click duplicate prevention | Manual: Image previews |

---

## EGO Compliance Tests

### shexli (`./venv/bin/shexli`)
- [ ] No EGO-P-006: No compiled schemas in package
- [ ] No EGO-P-007: Reachability markers for dynamic imports
- [ ] No other violations

### Syntax Check
- [ ] `node --check` passes on all JS files

### Code Review
- [ ] No `_destroyed` or `_enabled` flags
- [ ] No try-catch around destroy/connect/disconnect/source_remove
- [ ] enable()/disable() adjacent in extension.js
- [ ] No GTK in shell process
- [ ] No Clutter/Meta/St in prefs
- [ ] Line length ≤200 characters
- [ ] No "Generated with AI" comments
- [ ] Modular code (single-responsibility files)
- [ ] Process isolation (GTK only in dialog/prefs)

---

## CI/CD Tests

### Build Workflow (`.github/workflows/build-extension.yml`)
- [ ] Zip contains all required files
- [ ] No unexpected files at zip root
- [ ] Schema XML in correct path
- [ ] Icons in correct path
- [ ] All module JS files included

### VM Tests
- [ ] `tests/vm-create.sh` creates VM successfully
- [ ] `tests/deploy-vm.sh` installs extension
- [ ] VM is throwaway (no required state preserved)
- [ ] Host dependencies documented (qemu-utils, virtinst, libvirt, etc.)

---

## Test Execution Order

1. **Unit tests** - `./tests/run.sh` (fast, no VM)
2. **Integration tests** - `./tests/test-integration.sh` (requires VM + server)
3. **Manual tests** - `./tests/MANUAL.md` (requires VM + human)
4. **shexli** - `./venv/bin/shexli .` (EGO compliance)
5. **Syntax check** - `node --check` on all JS files

---

## Test Data

### Fixtures (`tests/fixtures/`)
- `img01.png` - Wide image
- `img02.png` - Tall image
- `img03.png` - Square image
- `img04.png` - 4K image
- `img05.jpg` - JPEG
- `img06.webp` - WebP
- `img07.png` - Edge case
- `notes.txt` - Text file
- `data.bin` - Binary file
- `archive.zip` - Archive

### Test Server
- Dev VM: `https://server.cup.cake:12707`
- Set `NTFY_TEST_SERVER` env var for API/integration tests
- Set `NTFY_TEST_SELF_SIGNED=1` for self-signed servers