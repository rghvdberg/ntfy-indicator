# Architecture Guide

This document describes the technical architecture of the ntfy GNOME Shell extension.

## Project Overview

A GNOME Shell 50 extension that brings ntfy push notifications to the desktop. It subscribes to configurable ntfy topics, shows desktop notifications, tracks unread counts in the panel, and provides a history dialog with publish/mute/mark-read/delete and image/attachment previews.

## Environment Constraints

- **No read/write access outside the current repo directory**. Do not create, modify, or delete files elsewhere (including `build/` output dirs that exceed the repo, `/tmp`, and VM paths) without explicit approval. Everything runs from the project root; deploy artifacts live under the repo itself.

## Project Goal

The extension should mirror the **ntfy web app** behavior: persistent local history, incremental resume, and never re-notifying a message that has already been seen.

## How It Works

### Panel Indicator (`indicator.js`)
- Icon + summed unread count
- Menu lists each topic with its unread count
- Clicking a topic opens its history dialog

### Feed (`api.js`)
- ntfy HTTP JSON long-polling (`/topic/json?poll=1`)
- Exponential backoff
- Optional per-server API key (Bearer)
- Self-signed certificate support

### Subscription Manager (`subscription-manager.js`)
- One feed per topic
- Delivers new messages to the store and desktop
- Handles mute (expiry-based) and publish
- Owns the `MessageTray` source
- Exports the D-Bus service used by the history dialog
- Spawns the dialog subprocess

### Server Deletes/Clears (Append-Only)
- ntfy keeps the original row and emits `message_delete`/`message_clear` tombstones (`sequence_id` = message id)
- The extension **receives** them (delete → `deleteNotification`, clear → `markRead`, both advance `lastId`)
- `api.js` converts replayed messages whose tombstone is in the same poll batch, so `since=all` never re-notifies them
- The extension never **sends** deletes/clears — the web app doesn't either

### Store (`notification-store.js`)
- Per-topic JSON files in `~/.local/share/ntfy/`
- Stores: `notifications`, `seenIds`, `lastId`
- Single source of truth for what is new, read, or deleted
- Serializes writes per topic
- Emits change callbacks so the indicator and dialog refresh

### History Dialog (`history-dialog.js`)
- Standalone GTK4 app spawned by the shell
- Topics sidebar, messages list, publish entry
- Sends actions (mark read/delete/mute/publish) to the shell over D-Bus
- The shell owns `com.github.rghvdberg.ntfy_indicator` on the session bus while enabled and exports a void-reply `Service` interface
- The dialog is a thin client

### Attachments
- Shell and dialog cache downloads in `~/.local/share/ntfy/cache` (5 MB cap)
- Images preview in the dialog

### Preferences (`prefs.js`)
- Built with libadwaita
- Server URL, per-server API key, accept self-signed, channels, history limit (10–1000)

## Hard Invariants — Do Not Regress

### Never Lose History
Fresh subscribe resumes from the persisted per-topic `lastId` watermark (`since=<lastId>`); when no watermark exists, `since=all` loads the full server backlog **once**. Never use a time window (`since=1h`).

### Never Re-Notify Known Messages
A message already in the store or in `seenIds` must be suppressed: no duplicate desktop notification, no duplicated history row, no lost read/delete state.

### No Lost Writes
All store mutations (add, mark read, mark all read, delete) run serialized per topic; concurrent delivery bursts must not drop data or clobber `seenIds`/`lastId`.

### Read/Delete Is Durable
Marking read or deleting in the dialog persists the id in `seenIds` so the message never resurfaces, even after re-login or a `since=all` first-subscribe.

### The Dialog Is a Separate Process
It holds no store state of its own — actions go to the shell over D-Bus, updates come from the store files.

## Process Model

### Shell Process (`extension.js`)
- Owns the panel indicator, desktop notifications, network feeds, persistent store, and a session D-Bus service
- Created when the extension is enabled; destroyed on disable

### Dialog Process (`history-dialog.js`)
- Standalone GTK4 app spawned by the shell
- Thin client — reads store files directly but sends all actions (mark read/delete/mute/publish) to the shell over D-Bus

### Prefs Process (`prefs.js`)
- Runs inside GNOME Settings (libadwaita)
- Must not import Clutter/Meta/St/Shell

## Module Responsibilities

| Module | Responsibility |
|--------|---------------|
| `extension.js` | Extension entry point; creates settings, indicator, and subscription manager |
| `indicator.js` | Panel button with summed unread count; menu lists topics and opens the history dialog |
| `subscription-manager.js` | Manages one `NtfyApi` feed per topic; delivers new messages to the store and desktop; owns the `MessageTray` source; exports the D-Bus service; spawns the dialog subprocess |
| `api.js` | `NtfyApi` — libsoup3 long-poll client (`GET /<topic>/json?since=...`), exponential backoff, self-signed TLS policy, and batching/tombstone handling |
| `notification-store.js` | Persistent per-topic JSON store in `~/.local/share/ntfy/`. Serializes writes per topic. Emits change callbacks |
| `history-dialog.js` | GTK4 history/publish UI. Reads store files and calls D-Bus methods on `com.github.rghvdberg.ntfy_indicator` |
| `attachment-downloader.js` | Caches attachment downloads in `~/.local/share/ntfy/cache` (5 MB cap) |
| `prefs.js` | Preferences UI with libadwaita |
| `utils.js` | Shared helpers (`parseTopicUrl`, `getApiKey`, data/cache/paths, `debugLog`) |

## Data Flow

1. User adds topics in prefs → `channels` gsettings
2. `Indicator` / `SubscriptionManager` opens one long-poll feed per topic
3. `api.js` streams JSON lines; new messages are passed to `subscription-manager.js`
4. `subscription-manager.js` pushes messages into `notification-store.js` and shows desktop banners (unless muted)
5. `notification-store.js` writes `~/.local/share/ntfy/<safe-topic-url>.json` and notifies `Indicator` and `history-dialog.js`
6. `history-dialog.js` sends actions over D-Bus; the shell-side service mutates the store

## Testing Architecture

### Unit Tests
Pure `gjs` tests that run on the host. No extension code under test is modified by the test harness.

### Integration Tests
End-to-end tests on a nested GNOME Shell session:
- `tests/test-integration.sh` deploys to a nested shell, drives a real ntfy server, and asserts store state locally
- Tests hit the dev server with a disposable topic
- Runs entirely on the host (no VM required)

### Test Configuration
Configuration is env-driven via `tests/config.sh`:
- `NTFY_TEST_SERVER` (required for api/integration)
- `NTFY_TEST_SELF_SIGNED`
- `NTFY_TEST_VM`
- `NTFY_TEST_VM_IP`
- `NTFY_TEST_VM_USER`
- `NTFY_TEST_SSH_KEY`

### VM Setup (Optional)
- `tests/vm-create.sh` builds a GNOME 50 VM from the Ubuntu cloud image (cloud-init; auto-generates `tests/.vm-key`, gitignored)
- `--fresh` recreates it
- The VM is optional, used for manual testing or if nested shell doesn't work
- Configuration is env-driven via `tests/config.sh`:

## EGO / Code-Style Constraints

- **Lifecycle**: create objects, connect signals, and add main-loop sources only in `enable()`; clean them up in `disable()`
- **No GTK/Gdk/Adw in the shell process**; no Clutter/Meta/St/Shell in the prefs process
- **No unnecessary `try-catch`** around `destroy()`, `connect()`, `disconnect()`, or `GLib.Source.remove()`
- **No `_destroyed` or `_enabled` boolean flags** — null out references after cleanup
- **Timeout cleanup belongs next to creation**; remove the existing source before creating a new one
- **Keep `enable()` and `disable()` adjacent** in class definitions
- **Line length ≤200**
- **`gnome-extensions pack` requires non-standard files in `extra-source`**; never put the schema XML in `extra-source` (it must stay under `schemas/`)

## Known Issues

### History Dialog Scroll Glitch (Cosmetic)
Deleting a message makes the list briefly jump to the top then back to the current position. Cause: the fixed 150 ms scroll-restore in the delete handler races GTK's async relayout of the ListBox. **Deferred**: rewrite with `GtkListView` + `GListModel` (GTK 4 recommended approach for mutable lists).

### Muted Topics UI (Missing Indicator)
After muting a topic, there is no persistent visual cue. The web app shows a `NotificationsOff` icon next to each muted topic. **Proposed fix**:
- Panel menu: append a `notification-disabled-symbolic` icon for muted topics
- Dialog sidebar: show a `notification-disabled-symbolic` icon per muted topic row
- Fix the header "Mute"/"Unmute" label to track the selected topic

**Mute semantics**: messages are still stored + counted while muted (web app behavior); only the desktop banner is suppressed.

## AI Code Guidelines

This project is "vibe coded" — built collaboratively with AI. The human designed the features, tested on real hardware, and reviewed every change. The AI wrote the code.

**Key requirements for AI-generated code**:
- Must be understandable and maintainable by the human author
- Remove "Generated with AI" comments before EGO submission
- Follow all EGO review guidelines
- No unnecessary try-catch wrappers
- No `_destroyed` or `_enabled` boolean flags
- Timeout cleanup next to creation
- `enable()`/`disable()` adjacent in class definition
- Modular code — split into single-responsibility files
- Line length ≤200 characters
- Self-explanatory code — clear names, minimal comments

## Verification

Before deploying:
- [ ] Pass the **shexli check** (with pinned tree-sitter version)
- [ ] Run `node --check` on changed JS files
- [ ] Lint the **packed zip**, not the loose sources
- [ ] Deploy + verify on the VM; confirm `Enabled: Yes / State: ACTIVE`

**Important**: GNOME Shell caches extension JS modules per process. After any install/wipe on the VM, restart the session (`sudo systemctl restart gdm`) before judging behavior.