import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { HarnessDriverClient } from '@agent-relay/harness-driver'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export const SUPPORTED_CLIS = ['claude', 'codex', 'opencode', 'grok'] as const
export type FidelityCli = (typeof SUPPORTED_CLIS)[number]

export const RECONCILER_REPAIR_LINE = '[terminal] viewport diverged from broker screen'

export interface TelemetryRecord {
  at: string
  source: 'renderer' | 'main:stdout' | 'main:stderr'
  line: string
  workload: string | null
}

export interface FidelityHarness {
  cli: FidelityCli
  repoRoot: string
  projectRoot: string
  userDataDir: string
  brokerStateDir: string
  connectionPath: string
  instanceName: string
  apiPort: number
  projectId: string
  electronApp: ElectronApplication
  page: Page
  broker: HarnessDriverClient
  brokerVersion: string
  relayVersions: Record<string, string>
  telemetry: TelemetryRecord[]
  mainLogs: string[]
  currentWorkload: string | null
  close(): Promise<void>
}

interface ConnectionFile {
  url?: string
  api_key?: string
  pid?: number
}

// The test runner itself may have been launched from a live Relay agent. None
// of that identity/workspace state may leak into the child broker or app.
const RELAY_IDENTITY_ENV = new Set([
  'AGENT_RELAY_WORKSPACE_KEY',
  'RELAY_WORKSPACE_KEY',
  'RELAY_API_KEY',
  'RELAY_AGENT_TOKEN',
  'RELAY_AGENT_NAME',
  'AGENT_RELAY_BROKER_NAME',
  'RELAY_BROKER_API_KEY',
  'AGENT_RELAY_CONNECTION_FILE'
])

function withoutRelayIdentity(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => value !== undefined && !RELAY_IDENTITY_ENV.has(key))
  )
}

async function spawnBrokerWithoutInheritedIdentity(
  options: Parameters<typeof HarnessDriverClient.spawn>[0]
): Promise<HarnessDriverClient> {
  const saved = new Map<string, string | undefined>()
  for (const key of RELAY_IDENTITY_ENV) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }

  try {
    return await HarnessDriverClient.spawn(options)
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function reserveFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to reserve an IPv4 loopback port'))
        return
      }
      const port = address.port
      server.close((error) => {
        if (error) reject(error)
        else resolvePort(port)
      })
    })
  })
}

async function packageVersion(repoRoot: string, packageName: string): Promise<string> {
  const packagePath = join(repoRoot, 'node_modules', ...packageName.split('/'), 'package.json')
  try {
    const parsed = JSON.parse(await readFile(packagePath, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch {
    return 'unavailable'
  }
}

async function installActivityProbe(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as Window & { pear?: unknown }).pear))
  await page.evaluate(() => {
    type Activity = { lastOutputAt: number; chunks: number; bytes: number }
    type Probe = {
      activity: Record<string, Activity>
      unsubscribe: () => void
    }
    type PearWindow = Window & {
      pear: {
        broker: {
          onPtyChunk(callback: (projectId: string, name: string, chunk: string) => void): () => void
        }
      }
      __termFidelityProbe?: Probe
    }

    const win = window as unknown as PearWindow
    win.__termFidelityProbe?.unsubscribe()
    const activity: Record<string, Activity> = {}
    const unsubscribe = win.pear.broker.onPtyChunk((_projectId, name, chunk) => {
      const previous = activity[name] || { lastOutputAt: 0, chunks: 0, bytes: 0 }
      activity[name] = {
        lastOutputAt: Date.now(),
        chunks: previous.chunks + 1,
        bytes: previous.bytes + new TextEncoder().encode(chunk).byteLength
      }
    })
    win.__termFidelityProbe = { activity, unsubscribe }
  })
}

async function validateConnection(
  connectionPath: string,
  expectedPort: number
): Promise<ConnectionFile> {
  const parsed = JSON.parse(await readFile(connectionPath, 'utf8')) as ConnectionFile
  if (!parsed.url || !parsed.api_key) {
    throw new Error(`Isolated broker wrote an incomplete connection file at ${connectionPath}`)
  }
  const url = new URL(parsed.url)
  const actualPort = Number(url.port)
  if (expectedPort === 3889 || actualPort === 3889) {
    throw new Error('Term-fidelity refused to use the live Pear broker port 3889')
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error(`Term-fidelity broker is not loopback-bound: ${parsed.url}`)
  }
  if (actualPort !== expectedPort) {
    throw new Error(`Term-fidelity requested broker port ${expectedPort}, connection uses ${actualPort}`)
  }
  return parsed
}

export async function launchFidelityHarness(
  cli: FidelityCli,
  repoRoot = resolve(__dirname, '../..')
): Promise<FidelityHarness> {
  // Keep the isolated tree outside the OS temp root. Agent sandboxes commonly
  // grant broad writes beneath TMPDIR, which would make the sibling userData
  // probe incapable of exercising a real outside-workspace approval panel.
  const runRoot = await mkdtemp(join(homedir(), `.pear-term-fidelity-${cli}-`))
  const projectRoot = join(runRoot, 'project')
  const userDataDir = join(runRoot, 'user-data')
  const brokerStateDir = join(projectRoot, '.agentworkforce', 'relay')
  const connectionPath = join(brokerStateDir, 'connection.json')
  await mkdir(projectRoot, { recursive: true })
  await mkdir(userDataDir, { recursive: true })
  await mkdir(brokerStateDir, { recursive: true })

  const apiPort = await reserveFreePort()
  if (apiPort === 3889) {
    throw new Error('The OS selected protected live broker port 3889; refusing to continue')
  }
  const instanceName = `term-fidelity-${cli}-${process.pid}-${basename(runRoot).slice(-6)}`
  if (instanceName === 'pear') throw new Error('Refusing to use the live broker instance name')

  let broker: HarnessDriverClient | null = null
  let electronApp: ElectronApplication | null = null
  try {
    const childEnv: NodeJS.ProcessEnv = {
      ...withoutRelayIdentity(process.env),
      // An update overlay can consume the initial broker task and makes both
      // the executable version and first paint nondeterministic mid-run.
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      // Force the shell workload through OpenCode's real approval component;
      // a user's global allow rules must not silently reduce matrix coverage.
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        autoupdate: false,
        permission: { bash: 'ask', external_directory: 'ask' }
      })
    }
    broker = await spawnBrokerWithoutInheritedIdentity({
      cwd: projectRoot,
      brokerName: instanceName,
      channels: ['general'],
      env: childEnv,
      binaryArgs: {
        persist: true,
        apiPort,
        apiBind: '127.0.0.1',
        stateDir: brokerStateDir
      }
    })
    const session = await broker.getSession()
    await validateConnection(connectionPath, apiPort)

    const telemetry: TelemetryRecord[] = []
    const mainLogs: string[] = []
    const harnessState = { currentWorkload: null as string | null }
    const recordMain = (source: 'main:stdout' | 'main:stderr', value: Buffer | string): void => {
      const text = value.toString()
      mainLogs.push(`[${source}] ${text}`)
      for (const line of text.split(/\r?\n/)) {
        if (line.includes(RECONCILER_REPAIR_LINE)) {
          telemetry.push({ at: new Date().toISOString(), source, line, workload: harnessState.currentWorkload })
        }
      }
    }

    const entry = join(repoRoot, 'out', 'main', 'index.js')
    electronApp = await electron.launch({
      args: [entry, `--user-data-dir=${userDataDir}`],
      cwd: repoRoot,
      env: {
        ...childEnv,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        TERM_FIDELITY_RUN: '1'
      },
      timeout: 60_000
    })
    electronApp.process().stdout?.on('data', (value) => recordMain('main:stdout', value))
    electronApp.process().stderr?.on('data', (value) => recordMain('main:stderr', value))

    const actualUserData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const [actualPath, expectedPath] = await Promise.all([
      realpath(actualUserData),
      realpath(userDataDir)
    ])
    if (actualPath !== expectedPath) {
      throw new Error(`Electron userData is not isolated: expected ${expectedPath}, got ${actualPath}`)
    }

    const page = await electronApp.firstWindow({ timeout: 60_000 })
    page.on('console', (message) => {
      const line = message.text()
      if (line.includes(RECONCILER_REPAIR_LINE)) {
        telemetry.push({
          at: new Date().toISOString(),
          source: 'renderer',
          line,
          workload: harnessState.currentWorkload
        })
      }
    })

    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean((window as Window & { pear?: unknown }).pear))
    const project = await page.evaluate(async ({ root, brokerName }) => {
      type Project = { id: string; name: string }
      const pear = (window as unknown as Window & {
        pear: {
          project: {
            add(name: string, rootPath: string): Promise<unknown>
            setActive(id: string): Promise<void>
          }
          broker: {
            start(projectId: string, cwd: string, name: string, channels: string[]): Promise<boolean>
          }
        }
      }).pear
      const created = await pear.project.add(`Term Fidelity ${brokerName}`, root) as Project
      if (!created?.id) throw new Error('Failed to create the isolated fidelity project')
      await pear.project.setActive(created.id)
      await pear.broker.start(created.id, root, brokerName, ['general'])
      return created
    }, { root: projectRoot, brokerName: instanceName })

    // Reload once so the normal production stores discover the newly-created
    // project and connect through their real startup effects.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await installActivityProbe(page)

    const relayVersions = Object.fromEntries(await Promise.all([
      '@agent-relay/harness-driver',
      '@agent-relay/sdk',
      'agent-relay'
    ].map(async (name) => [name, await packageVersion(repoRoot, name)])))

    const result: FidelityHarness = {
      cli,
      repoRoot,
      projectRoot,
      userDataDir,
      brokerStateDir,
      connectionPath,
      instanceName,
      apiPort,
      projectId: project.id,
      electronApp,
      page,
      broker,
      brokerVersion: session.broker_version,
      relayVersions,
      telemetry,
      mainLogs,
      get currentWorkload() {
        return harnessState.currentWorkload
      },
      set currentWorkload(value: string | null) {
        harnessState.currentWorkload = value
      },
      async close(): Promise<void> {
        await electronApp?.close().catch(() => undefined)
        await broker?.shutdown().catch(() => undefined)
        if (process.env.TERM_FIDELITY_KEEP_TEMP !== '1') {
          await rm(runRoot, { recursive: true, force: true })
        } else {
          console.log(`[term-fidelity] preserved isolated run directory: ${runRoot}`)
        }
      }
    }
    return result
  } catch (error) {
    await electronApp?.close().catch(() => undefined)
    await broker?.shutdown().catch(() => undefined)
    if (process.env.TERM_FIDELITY_KEEP_TEMP !== '1') {
      await rm(runRoot, { recursive: true, force: true })
    }
    throw error
  }
}

export async function getActivity(
  page: Page,
  agentName: string
): Promise<{ lastOutputAt: number; chunks: number; bytes: number }> {
  return await page.evaluate((name) => {
    const probe = (window as Window & {
      __termFidelityProbe?: {
        activity: Record<string, { lastOutputAt: number; chunks: number; bytes: number }>
      }
    }).__termFidelityProbe
    return probe?.activity[name] || { lastOutputAt: 0, chunks: 0, bytes: 0 }
  }, agentName)
}
