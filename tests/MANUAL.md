# Manual test checklist (L3 — needs human eyes on the VM)

Run after `tests/run.sh` and `tests/test-integration.sh` pass. Each item maps to
a past regression; ~10 minutes on the ntfy-dev VM.

## Panel indicator
- [ ] Icon visible in panel; count label shows summed unread across topics
- [ ] Count updates within ~1s of a new message
- [ ] Menu lists each topic with its own unread count
- [ ] After mark-all-read in dialog, panel count clears (regression 6438136)

## Desktop notifications
- [ ] New message shows banner with title/body
- [ ] Click banner (plain message) → opens history dialog for that topic
- [ ] Click banner (message with Click URL) → opens the URL (regression df05d47)
- [ ] Click banner (message with attachment) → opens the attachment
- [ ] Non-image attachment opened → copied to ~/Downloads (regression 1024102)
- [ ] Dismiss all banners, send another → banner still appears (regression 60b8cfb)
- [ ] Muted topic → no banner; after mute expiry → banners resume

## History dialog
- [ ] Opens from menu topic click; topics sidebar shows unread counts
- [ ] Image previews render at sensible size for every file in test-images/
      (img01..img07: wide, tall, square, 4K, webp — the 16-commit sizing saga,
      regressions 82642c8 / aef3f35 and friends)
- [ ] Placeholder replaced by actual image after download (regression b19e47f)
- [ ] Delete a message → row removed. KNOWN ISSUE: list briefly jumps to top
      and back (cosmetic, deferred — GtkListView rewrite). Confirm no worse.
- [ ] Switch topics → correct rows; a topic with no store shows empty, not
      stale rows (regression 1f3b943)
- [ ] Scroll to bottom, switch topic, switch back → scroll preserved (2b3eefb)
- [ ] Click the topic whose dialog is already open → window kept, no respawn
      (regression 2b3eefb)
- [ ] Publish from dialog entry → message appears in dialog and on feed
- [ ] Mark read / mark all read / delete from dialog → panel count follows

## Preferences
- [ ] Server URL field; accept-self-signed toggle works against dev server
- [ ] API keys JSON field (per-server Bearer)
- [ ] Channels: add bare topic, add full URL, remove; subscriptions follow
- [ ] History limit 10–1000 honored

## Lifecycle
- [ ] Disable → enable in same session: no errors, indicator returns
      (destroy() regression from f578b2e)
- [ ] Full session restart (GDM): extension auto-loads ACTIVE
