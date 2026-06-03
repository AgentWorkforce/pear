// electron-builder afterSign hook: notarize the signed .app with retries.
//
// We drive @electron/notarize ourselves (instead of electron-builder's
// `mac.notarize: true`) so we can retry around transient failures. Apple's
// notary service is polled over the network for tens of minutes; a single
// dropped connection (e.g. NSURLErrorDomain Code=-1009 "The Internet
// connection appears to be offline") otherwise throws away the entire ~1h
// build at the very last step. See release run 26887223876.
const { notarize } = require('@electron/notarize');

const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 15_000; // 15s, 30s, 60s between attempts

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Network blips while uploading or polling the notary service are worth
// retrying. A rejected submission (bad signature, invalid entitlements) is
// not — retrying would just fail the same way, so surface it immediately.
function isRetryable(err) {
  const msg = `${err && err.message ? err.message : err}`;
  return (
    /Internet connection appears to be offline/i.test(msg) ||
    /No network route/i.test(msg) ||
    /-1009/.test(msg) ||
    /network|timed out|timeout|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(msg) ||
    /Failed to notarize via notarytool/i.test(msg)
  );
}

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER } = process.env;
  if (!APPLE_API_KEY || !APPLE_API_KEY_ID || !APPLE_API_ISSUER) {
    console.warn(
      '[notarize] Skipping notarization: APPLE_API_KEY / APPLE_API_KEY_ID / ' +
        'APPLE_API_ISSUER not set (expected for local, unsigned builds).',
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(
        `[notarize] Submitting ${appName}.app to Apple notary service ` +
          `(attempt ${attempt}/${MAX_ATTEMPTS})…`,
      );
      await notarize({
        tool: 'notarytool',
        appPath,
        appleApiKey: APPLE_API_KEY,
        appleApiKeyId: APPLE_API_KEY_ID,
        appleApiIssuer: APPLE_API_ISSUER,
      });
      console.log('[notarize] Notarization succeeded and ticket stapled.');
      return;
    } catch (err) {
      const last = attempt === MAX_ATTEMPTS;
      if (last || !isRetryable(err)) throw err;
      const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `[notarize] Attempt ${attempt} failed with a transient error; ` +
          `retrying in ${delay / 1000}s.\n${err && err.message ? err.message : err}`,
      );
      await sleep(delay);
    }
  }
};
