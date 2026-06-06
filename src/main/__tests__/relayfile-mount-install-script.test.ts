import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, copyFile, lstat, readFile, rm, symlink, writeFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..', '..')
const installScriptPath = join(repoRoot, 'scripts', 'install-relayfile-mount.mjs')

async function withTempRepo(run: (repoRoot: string) => Promise<void>) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'pear-relayfile-install-'))
  try {
    await mkdir(join(tempRoot, 'scripts'), { recursive: true })
    await copyFile(installScriptPath, join(tempRoot, 'scripts', 'install-relayfile-mount.mjs'))
    await writeFile(join(tempRoot, 'package.json'), '{"name":"pear-install-test"}\n')
    await run(tempRoot)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function runInstall(repoRoot: string, source: string) {
  await execFileAsync(process.execPath, [join(repoRoot, 'scripts', 'install-relayfile-mount.mjs')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RELAYFILE_MOUNT_BIN: source
    }
  })
}

test('installFromFile replaces the target instead of copying through an existing symlink', {
  skip: process.platform === 'win32' ? 'Symlinks on Windows require elevated privileges or Developer Mode' : false
}, async () => {
  await withTempRepo(async (repoRoot) => {
    const source = join(repoRoot, 'source-relayfile-mount')
    const target = join(repoRoot, 'bin', 'relayfile-mount')
    const previousTarget = join(repoRoot, 'previous-target')

    await writeFile(source, 'new-binary\n')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(previousTarget, 'old-binary\n')
    await symlink(previousTarget, target)

    await runInstall(repoRoot, source)

    assert.equal(await readFile(previousTarget, 'utf8'), 'old-binary\n')
    assert.equal(await readFile(target, 'utf8'), 'new-binary\n')
    assert.equal((await lstat(target)).isSymbolicLink(), false)
    assert.equal((await stat(target)).mode & 0o777, 0o755)
    assert.equal(await readFile(join(repoRoot, 'bin', '.relayfile-mount-version'), 'utf8'), `local:${source}\n`)
  })
})

test('installFromFile removes the staged temp file when publish fails', async () => {
  await withTempRepo(async (repoRoot) => {
    const source = join(repoRoot, 'source-relayfile-mount')
    const target = join(repoRoot, 'bin', 'relayfile-mount')

    await writeFile(source, 'new-binary\n')
    await mkdir(target, { recursive: true })

    await assert.rejects(runInstall(repoRoot, source), /EISDIR|ENOTDIR|EPERM|EACCES|directory/)

    const binEntries = await readdir(join(repoRoot, 'bin'))
    assert.deepEqual(binEntries, ['relayfile-mount'])
  })
})
