# ntfy GNOME Shell Extension — Project Conventions

## Environment constraints

- No read/write access outside the current repo directory. Do not create,
  modify, or delete files elsewhere (including `build/` output dirs that exceed
  the repo, `/tmp`, and VM paths) without explicit approval. Everything runs
  from the project root; deploy artifacts live under the repo itself.

## Project goal

A GNOME Shell 50 extension that brings ntfy push notifications to the desktop.
It subscribes to configurable ntfy topics, shows real-time desktop
notifications, tracks an unread count per topic in the panel, and provides a
history dialog with publish, mute, mark-read and delete plus image/attachment
previews. Behavior should mirror the **ntfy web app**: persistent local history,
incremental resume, and never re-notifying a message that has already been seen.

### How it works
- **Panel indicator** (`indicator.js`): icon + summed unread count; menu lists
  each topic with its unread count; clicking a topic opens its history dialog.
- **Feed** (`api.js`): ntfy HTTP JSON long-polling (`/topic/json?poll=1`),
  exponential backoff, optional per-server API key (Bearer), self-signed support.
- **Subscription manager** (`subscription-manager.js`): one feed per topic,
  delivers new messages to the store and desktop, handles mute (expiry-based)
  and publish.
- **Store** (`notification-store.js`): per-topic JSON files in
  `~/.local/share/ntfy/` holding `notifications`, `seenIds`, `lastId`. This is
  the single source of truth for what is new, read, or deleted.
- **History dialog** (`history-dialog.js`): standalone GTK4 app spawned by the
  shell; topics sidebar, messages list, publish entry. It communicates back via
  a command file (`/tmp/ntfy-cmd.jsonl`) that the shell polls.
- **Attachments**: shell and dialog cache downloads in `~/.local/share/ntfy/cache`
  (5 MB cap); images preview in the dialog.
- **Prefs** (`prefs.js`, Adw): server URL, per-server API key, accept
  self-signed, channels, history limit (10–1000).

### Hard invariants — do not regress
- **Never lose history.** Fresh subscribe resumes from the persisted per-topic
  `lastId` watermark (`since=<lastId>`); when no watermark exists, `since=all`
  loads the full server backlog **once**. Never use a time window (`since=1h`).
- **Never re-notify known messages.** A message already in the store or in
  `seenIds` must be suppressed: no duplicate desktop notification, no
  duplicated history row, no lost read/delete state.
- **No lost writes.** All store mutations (add, mark read, mark all read,
  delete) run serialized per topic; concurrent delivery bursts must not drop
  data or clobber `seenIds`/`lastId`.
- **Read/delete is durable.** Marking read or deleting in the dialog persists
  the id in `seenIds` so the message never resurfaces, even after re-login or a
  `since=all` first-subscribe.
- **The dialog is a separate process**; messages reach it via the command file,
  never by direct store access.

## Testing / deployment boundaries
- All testing and deployment happens on the **ntfy-dev VM**, synced via
  `./vm-sync.sh`.
- **Sending test messages** — general recipe (uses `-T` so the file is an
  attachment; small text files need the `Filename` header to count as an
  attachment, otherwise files ≤4096 bytes are treated as a plain message body):
  ```
  curl -T /path/to/file -H "Filename: file.txt" -H "Title: your title here" -H "Message: your message here" https://ntfy.domain.com/topic
  ```
  For a plain text message instead of an attachment, drop `-T` and use
  `-d "message text"`. On the dev VM, target `https://server.cup.cake:12707`
  and add `-k` (self-signed).

## Verification
- The extension must pass the **shexli check** before deploying. shexli 0.2.1
  crashes on larger modules unless the tree-sitter dep is pinned in the venv:
  `python3 -m venv venv && . venv/bin/activate && pip install shexli && pip install "tree-sitter==0.25.2"`
- Run `node --check` on changed JS files before deploying.
- Lint the **packed zip**, not the loose sources — the zip is what the GitHub
  push produces. Reproduce it locally with the same packaging and re-run the
  workflow's content check:
  1. Pack with the same `extra-source` list as
     `.github/workflows/build-extension.yml` (api.js, attachment-downloader.js,
     history-dialog.js, indicator.js, notification-store.js,
     subscription-manager.js, utils.js, LICENSE, icons). Keep the two lists in
     sync whenever files are added or removed.
  2. Run the workflow's "Verify zip contains all required files" checks
     (every required file present, nothing extra at the zip root).
  3. `venv/bin/shexli build/ntfy-indicator@rghvdberg.shell-extension.zip`
- Deploy + verify on the VM; confirm the extension reports
  `Enabled: Yes / State: ACTIVE`.

## Known issues / deferred
- **History dialog scroll glitch on delete** (`history-dialog.js`): deleting a
  message makes the list briefly jump to the top then back to the current
  position. Cosmetic only; cause not documented by GTK — the fixed 150 ms
  scroll-restore in the delete handler races GTK's async relayout of the
  ListBox. Deferred: rewrite the message list with `GtkListView` + `GListModel`
  (the GTK 4 recommended approach for mutable lists) in a future release.

## Deferred maintenance plan (audit 2026-08)
- **Phase 1 (safe trims)**: delete dead `SubscriptionManager.destroy()`
  (`subscription-manager.js:169-179`); drop `getUnreadCount()` passthrough
  (416-418, call `notificationStore` directly); inline `indicator._syncChannels`
  and `_openHistoryDialog` single-caller wrappers.
- **Phase 2 (stdlib)**: replace the manual URL split in `parseTopicUrl`
  (`utils.js:44-62`) with `GLib.Uri.parse()` when a scheme is present; keep the
  bare-topic branch. Verify on VM (feeds indicator/prefs/dialog/topic switch).
- Verify after any phase: `node --check`, repack zip (same `extra-source` list),
  `venv/bin/shexli` on the zip, `./vm-sync.sh`, extension `ACTIVE`. No version
  bump (internal refactor).