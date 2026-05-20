# Pear Release Runbook

Pear ships as signed Electron installers published to GitHub Releases. The
install page and bootstrap scripts are deployed with SST at:

```sh
https://pear.agentrelay.com
```

## Install Commands

macOS and Linux:

```sh
curl -fsSL https://pear.agentrelay.com/install.sh | sh
```

or:

```sh
wget -qO- https://pear.agentrelay.com/install.sh | sh
```

Windows PowerShell:

```powershell
iwr https://pear.agentrelay.com/install.ps1 -UseB | iex
```

## Release A Version

1. Update `package.json` version.
2. Merge to `main`.
3. Push a matching tag:

```sh
git tag v1.0.1
git push origin v1.0.1
```

The `Release Installers` workflow builds and publishes:

- `Pear-mac-universal.dmg`
- `Pear-mac-universal.zip`
- `Pear-win-x64.exe`
- `Pear-linux-x64.AppImage`
- `Pear-linux-x64.deb`
- electron-updater metadata files

Installed apps check GitHub Releases for updates on launch and every six hours.

## Required Repository Secrets

The release workflow can build unsigned artifacts, but production auto-update
requires signed macOS and Windows builds.

- `MACOS_CSC_LINK`
- `MACOS_CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`
- `WINDOWS_CSC_LINK`
- `WINDOWS_CSC_KEY_PASSWORD`

The SST deploy workflows use the same environment variables and secrets as the
Agent Relay web deploy:

- Repository/environment variables: `AWS_ACCOUNT_ID`, `AWS_REGION`,
  `AWS_ROLE_TO_ASSUME`, `CLOUDFLARE_ACCOUNT_ID`
- Secret: `CLOUDFLARE_API_TOKEN`
