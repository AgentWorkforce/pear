import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const __dirname = dirname(fileURLToPath(import.meta.url))
const launcherPath = join(__dirname, '..', 'relayfile-mount-launcher.ts')
const packageJsonPath = join(__dirname, '..', '..', '..', 'package.json')

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

test('relayfile-mount ships as the @relayfile/mount-* optional package, not a postinstall download', async () => {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    scripts: Record<string, string>
  }
  const launcherSource = await readFile(launcherPath, 'utf8')
  const electronBuilderPath = join(__dirname, '..', '..', '..', 'electron-builder.yml')
  const electronBuilder = await readFile(electronBuilderPath, 'utf8')

  // No automatic download on `npm i` — the binary now arrives via
  // @relayfile/sdk's optionalDependencies (the broker distribution model).
  assert.equal(
    packageJson.scripts.postinstall,
    undefined,
    'npm i must not download the relayfile-mount binary via a postinstall hook'
  )

  // The mac release path bundles the optional-dep binary from node_modules; it
  // must not shell out to the GitHub-release download anymore.
  for (const scriptName of ['build', 'dist:mac', 'release:mac']) {
    const script = packageJson.scripts[scriptName]
    assert.doesNotMatch(
      script,
      /relayfile-mount:install|install-relayfile-mount/,
      `${scriptName} must not run the relayfile-mount download step`
    )
  }

  // The launcher resolves the per-platform optional package.
  assert.match(
    launcherSource,
    /@relayfile\/mount-/,
    'the launcher must resolve the @relayfile/mount-<platform>-<arch> package'
  )

  // electron-builder unpacks the optional-dep binary so it is spawnable.
  assert.match(
    electronBuilder,
    /node_modules\/@relayfile\/mount-\*\/bin\/\*\*/,
    'electron-builder must asarUnpack the @relayfile/mount-* binary'
  )
})
