/**
 * electron-builder `afterSign` hook: notarize the signed macOS app.
 *
 * Notarization is skipped (with a warning) when credentials aren't present, so
 * local `npm run dist` still produces a signed-but-not-notarized build for
 * testing. CI supplies credentials via env. Two auth modes are supported:
 *
 *   App Store Connect API key (preferred in CI):
 *     APPLE_API_KEY        path to the .p8 key file
 *     APPLE_API_KEY_ID     key id
 *     APPLE_API_ISSUER     issuer id
 *
 *   Apple ID + app-specific password:
 *     APPLE_ID
 *     APPLE_APP_SPECIFIC_PASSWORD
 *     APPLE_TEAM_ID
 */
const { notarize } = require('@electron/notarize')

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = `${appOutDir}/${appName}.app`

  const hasApiKey = process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER
  const hasAppleId =
    process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID

  if (!hasApiKey && !hasAppleId) {
    console.warn('[notarize] Skipping — no Apple notarization credentials in env.')
    return
  }

  console.log(`[notarize] Notarizing ${appName}.app …`)

  const credentials = hasApiKey
    ? {
        appleApiKey: process.env.APPLE_API_KEY,
        appleApiKeyId: process.env.APPLE_API_KEY_ID,
        appleApiIssuer: process.env.APPLE_API_ISSUER
      }
    : {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID
      }

  await notarize({ appPath, ...credentials })
  console.log('[notarize] Done.')
}
