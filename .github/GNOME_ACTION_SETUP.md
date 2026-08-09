# GNOME Extensions Action Setup

## What Changed

Replaced manual packaging with [`murar8/gnome-extensions-action@0.1.1`](https://github.com/murar8/gnome-extensions-action) which:
- Packages the extension correctly (handles UUID, version, schema compilation)
- Automatically uploads to extensions.gnome.org
- Handles TOS acceptance

Two jobs in `.github/workflows/build-extension.yml`:

1. **build-zip** (runs on push/tag/release/manual): packages the extension and
   - Uploads the zip as a **workflow artifact** (downloadable from the Actions page, ~90-day retention)
   - On tags (`v*`), attaches the zip to the **GitHub Release** as a downloadable asset
2. **upload-ego** (runs on release/manual): packages and uploads to extensions.gnome.org using the `GNOME_USERNAME`/`GNOME_PASSWORD` secrets

## Setup Required

### 1. Create GitHub Secrets

Go to: `Settings → Secrets and variables → Actions → New repository secret`

Add these secrets:

| Name | Value |
|------|-------|
| `GNOME_USERNAME` | Your extensions.gnome.org username |
| `GNOME_PASSWORD` | Your extensions.gnome.org password |

Create the account at https://extensions.gnome.org/upload/ if you don't have one. There is no API token — the action uses these credentials to log into the upload form.

### 2. Accept TOS First

Run the workflow once manually to accept the GNOME Developer Agreement:

```bash
# Trigger via GitHub UI: Actions → Build and Upload GNOME Extension → Run workflow
# Or via CLI:
gh workflow run build-extension.yml --ref main
```

### 3. Submit for Review

After upload, the extension appears in the "Pending" section of your extensions.gnome.org account. Submit it for review there.

## Workflow Triggers

- **On push to main / tag `v*`**: packages a zip → workflow artifact, and on tags also attaches it to the GitHub release
- **On release publish**: builds zip, attaches to release, and uploads to extensions.gnome.org
- **Manual**: can be triggered from Actions tab or via `gh workflow run`

## Releasing a New Version

1. Bump `"version"` in `metadata.json` (e.g. `0.2.0`) and commit
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`
3. Publish a GitHub release from the tag (or `gh release create v0.2.0`) — the workflow attaches the zip and uploads to EGO

## Notes

- `extra-source` includes GSettings schema and icons that might be excluded by default
- The action handles schema compilation automatically
- Version is pulled from `metadata.json` (fallback: the release tag, e.g., `v1.0.0` → version `1.0.0`)