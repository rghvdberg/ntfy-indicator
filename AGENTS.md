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
- **Server deletes/clears are append-only**: ntfy keeps the original row and
  emits `message_delete`/`message_clear` tombstones (`sequence_id` = message
  id). The extension **receives** them (delete → `deleteNotification`, clear →
  `markRead`, both advance `lastId`), and `api.js` converts replayed messages
  whose tombstone is in the same poll batch, so `since=all` never re-notifies
  them. It never **sends** deletes/clears — the web app doesn't either.
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
- **Automated tests** live in `tests/`: `./tests/run.sh` runs unit suites
  (host, gjs; store/api/utils — api tests hit the dev server with a disposable
  topic), `./tests/test-integration.sh` runs end-to-end on the VM (deploy +
  publish + delete/clear/replay/burst/limit/lifecycle assertions),
  `tests/MANUAL.md` is the human UI checklist. No extension code under test is
  modified by the test harness.
- **Throwaway test VM**: `tests/vm-create.sh` builds a GNOME 50 VM from the
  Ubuntu cloud image (cloud-init; auto-generates `tests/.vm-key`, gitignored);
  `--fresh` recreates it. Host deps: `qemu-utils virtinst
  libvirt-daemon-system libvirt-clients cloud-image-utils openssh-client
  curl`. `tests/deploy-vm.sh` packs the zip and installs it
  on the VM like a user would. Configuration is env-driven via
  `tests/config.sh`: `NTFY_TEST_SERVER` (required for api/integration),
  `NTFY_TEST_SELF_SIGNED`, `NTFY_TEST_VM`, `NTFY_TEST_VM_IP`,
  `NTFY_TEST_VM_USER`, `NTFY_TEST_SSH_KEY`. The VM is treated as throwaway —
  tests install fresh and leave no required state.
- **Sending test messages** — general recipe (uses `-T` so the file is an
  attachment; small text files need the `Filename` header to count as an
  attachment, otherwise files ≤4096 bytes are treated as a plain message body):
  ```
  curl -T /path/to/file -H "Filename: file.txt" -H "Title: your title here" -H "Message: your message here" https://ntfy.domain.com/topic
  ```
  For a plain text message instead of an attachment, drop `-T` and use
  `-d "message text"`. On the dev VM, target `https://server.cup.cake:12707`
  and add `-k` (self-signed).
- **Testing delete/clear tombstones** on the dev server (sequence id defaults
  to the message id from the feed):
  ```
  curl -sk -X DELETE https://server.cup.cake:12707/<topic>/<id>
  curl -sk -X PUT https://server.cup.cake:12707/<topic>/<id>/clear
  ```

## Verification
- The extension must pass the **shexli check** before deploying. shexli 0.2.1
  crashes on larger modules unless the tree-sitter dep is pinned in the venv:
  `python3 -m venv venv && . venv/bin/activate && pip install shexli && pip install "tree-sitter==0.25.2"`
- Run `node --check` on changed JS files before deploying.
- Lint the **packed zip**, not the loose sources — the zip is what the GitHub
  push produces. Reproduce it locally with the same packaging and re-run the
  workflow's content check:
  1. Pack with `gnome-extensions pack` using the same `extra-source` list as
     `.github/workflows/build-extension.yml` (api.js, attachment-downloader.js,
     history-dialog.js, indicator.js, notification-store.js,
     subscription-manager.js, utils.js, LICENSE, icons). The native pack
     auto-includes metadata.json, extension.js, prefs.js, stylesheet.css, and
     auto-detects schemas/ — no hand-rolled zip needed.
  2. Run the workflow's "Verify zip contains all required files" checks
     (every required file present, nothing extra at the zip root).
  3. `venv/bin/shexli build/ntfy-indicator@rghvdberg.shell-extension.zip`
- Deploy + verify on the VM; confirm the extension reports
  `Enabled: Yes / State: ACTIVE`.
- **GNOME Shell caches extension JS modules per process**: enable/disable in
  the same session does not re-import code, and a freshly zip-installed
  extension may not appear in `gnome-extensions list` until the session
  restarts. After any install/wipe on the VM, restart the session
  (`sudo systemctl restart gdm`) before judging behavior. Related: the store
  dir is self-healed in `_persist`, but mid-session deletion of
  `~/.local/share/ntfy` is not a supported scenario.

## Known issues / deferred
- **History dialog scroll glitch on delete** (`history-dialog.js`): deleting a
  message makes the list briefly jump to the top then back to the current
  position. Cosmetic only; cause not documented by GTK — the fixed 150 ms
  scroll-restore in the delete handler races GTK's async relayout of the
  ListBox. Deferred: rewrite the message list with `GtkListView` + `GListModel`
  (the GTK 4 recommended approach for mutable lists) in a future release.
- **Topic-switch scroll not preserved** (`history-dialog.js`): switching between
  topics resets the list to the top instead of restoring each topic's own scroll
  position. Root cause: `_lastTopId` is a global (not per-topic), so every
  cross-topic load is mis-detected as "new message at top" and forces scroll-to-0;
  plus scroll memory is shared across topics. Fix: per-topic `_lastTopId` and
  `_scrollByTopic` maps; restore each topic's saved scroll on switch-back.
- **Muted topics have no visible indicator** (UI): after muting a topic in the
  dialog, there is no persistent visual cue that the topic is muted. The web app
  shows a `NotificationsOff` icon (bell-with-slash) next to each muted topic in
  the nav sidebar, plus "Muted" tooltip. Our extension only shows the mute state
  as the "Mute"/"Unmute" label of the currently open topic. Fix:
  - Panel menu (`indicator.js`): append a `notification-disabled-symbolic` icon
    for muted topics; add `muted-topics` to settings-changed handler to refresh.
  - Dialog sidebar (`history-dialog.js`): pass the full `muted-topics` JSON to
    the dialog; show a `notification-disabled-symbolic` icon per muted topic row;
    fix the header "Mute"/"Unmute" label to track the selected topic (not just
    the initial topic). Mute semantics: messages are still stored + counted while
    muted (web app behavior); only the desktop banner is suppressed.