# Releasing Pear (macOS)

Pear ships as a signed + notarized macOS app, published to GitHub Releases, with
in-app auto-update via [`electron-updater`].

## Overview

- **Packaging:** [`electron-builder`] (config in [`electron-builder.yml`](./electron-builder.yml))
- **Targets:** `dmg` (the download users install) + `zip` (consumed by auto-update), **arm64 only**
- **Signing:** Developer ID Application certificate (hardened runtime + [entitlements](./build/entitlements.mac.plist))
- **Notarization:** built-in `notarize: true` (notarytool) using an App Store Connect API key
- **Publish:** GitHub Releases (`AgentWorkforce/pear`) as a **draft** you publish manually
- **CI:** [`.github/workflows/release.yml`](./.github/workflows/release.yml), **manually triggered** from the Actions tab

> **arm64 only:** `@agent-relay/sdk` ships per-arch prebuilt broker binaries, so a
> single CI runner can't produce a working universal/Intel build. The arm64 build
> matches the Apple-Silicon runner and the broker binary npm installs there.

## One-time setup

### 1. Apple credentials

You need an **Apple Developer Program** membership.

1. **Developer ID Application certificate** — create one in
   [Certificates, IDs & Profiles](https://developer.apple.com/account/resources/certificates/list),
   export it from Keychain Access as a `.p12` (with a password), then base64-encode it:
   ```sh
   base64 -i DeveloperID.p12 | pbcopy
   ```
2. **App Store Connect API key** — in
   [App Store Connect → Users and Access → Integrations → API Keys](https://appstoreconnect.apple.com/access/integrations/api),
   create a key with the **Developer** role. Download the `.p8` (one-time), and note the
   **Key ID** and **Issuer ID**. Base64-encode the key:
   ```sh
   base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy
   ```

### 2. GitHub repository secrets

Add these under **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | base64 of the Developer ID `.p12` |
| `CSC_KEY_PASSWORD` | password for the `.p12` |
| `APPLE_API_KEY_BASE64` | base64 of the App Store Connect `.p8` |
| `APPLE_API_KEY_ID` | the API Key ID |
| `APPLE_API_ISSUER` | the API Issuer ID |

`GITHUB_TOKEN` is provided automatically by Actions and is used to publish the release.

## Cutting a release

1. Bump the version in `package.json`.
2. Go to the repo's **Actions** tab → **Release (macOS)** → **Run workflow**.
3. The workflow builds, signs, notarizes, and uploads the DMG/ZIP plus the
   `latest-mac.yml` update feed to a **draft** GitHub Release.
4. Review the draft on the [Releases page](https://github.com/AgentWorkforce/pear/releases),
   then click **Publish**. Installed apps pick up the update on next launch.

## Local builds

- `npm run dist:mac` — full DMG/ZIP in `dist/` without publishing. Signs if a Developer ID
  cert is in your keychain (or `CSC_LINK`/`CSC_KEY_PASSWORD` are set); notarizes if the
  `APPLE_*` env vars are present.

## Auto-update behavior

On a packaged build the app checks GitHub Releases on launch and every 6 hours
([`src/main/updater.ts`](./src/main/updater.ts)). Updates download in the background; the
user is prompted to restart when one is ready. **Check for Updates…** in the app menu
triggers a manual check. Auto-update only sees a release once it's **published** (not while
it's a draft), and only works on signed builds.

## The `pear` CLI

End users install the `pear open <dir>` command via the app menu:
**Pear → Install 'pear' command in PATH…**, which drops an admin-elevated shim into
`/usr/local/bin/pear` pointing at the installed app
([`src/main/cli-install.ts`](./src/main/cli-install.ts)). The npm `bin` entry only applies
to `npm`-based installs (contributors), not the packaged app.

[`electron-builder`]: https://www.electron.build/
[`electron-updater`]: https://www.electron.build/auto-update
