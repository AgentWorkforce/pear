import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const __dirname = dirname(fileURLToPath(import.meta.url))
const launcherPath = join(__dirname, '..', 'relayfile-mount-launcher.ts')
const packageJsonPath = join(__dirname, '..', '..', '..', 'package.json')
const installScriptPath = join(__dirname, '..', '..', '..', 'scripts', 'install-relayfile-mount.mjs')

test('relayfile mount launcher imports the launcher from the SDK launcher entrypoint', async () => {
  const source = await readFile(launcherPath, 'utf8')

  assert.match(
    source,
    /from ['"]@relayfile\/sdk\/mount-launcher['"]/,
    'createDefaultMountLauncher must come from @relayfile/sdk/mount-launcher'
  )
  assert.doesNotMatch(
    source,
    /createDefaultMountLauncher[\s\S]*from ['"]@relayfile\/sdk['"]/,
    'the root @relayfile/sdk export does not expose createDefaultMountLauncher at runtime'
  )
})

test('mac release scripts install relayfile-mount from release assets only', async () => {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    scripts: Record<string, string>
  }
  const installScript = await readFile(installScriptPath, 'utf8')

  assert.equal(
    packageJson.scripts['relayfile-mount:install:release'],
    'node scripts/install-relayfile-mount.mjs --release'
  )
  for (const scriptName of ['dist:mac', 'release:mac']) {
    const script = packageJson.scripts[scriptName]
    assert.match(script, /relayfile-mount:install:release/)
    assert.match(script, /RELAYFILE_MOUNT_INSTALL_SOURCE=release npm run build/)
  }
  assert.match(installScript, /const releaseMode = /)
  assert.match(
    installScript,
    /if \(releaseMode\) \{[\s\S]*?await downloadRelease\(version\)[\s\S]*?process\.exit\(0\)/
  )
})
