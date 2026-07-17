import { test, type TestInfo } from '@playwright/test'
import {
  launchFidelityHarness,
  SUPPORTED_CLIS,
  type FidelityCli,
  type FidelityHarness
} from './harness'
import { writeTelemetryArtifact } from './oracle'
import { runCanonicalWorkloads, spawnRealAgent } from './workloads'

function selectedClis(): FidelityCli[] {
  const selected = process.env.TERM_FIDELITY_CLI || 'all'
  if (selected === 'all') return [...SUPPORTED_CLIS]
  if ((SUPPORTED_CLIS as readonly string[]).includes(selected)) return [selected as FidelityCli]
  throw new Error(`Invalid TERM_FIDELITY_CLI=${JSON.stringify(selected)}`)
}

test.describe.configure({ mode: 'serial' })

for (const cli of selectedClis()) {
  test(`${cli}: real Electron renderer matches isolated broker for all canonical workloads`, async ({}, testInfo: TestInfo) => {
    let harness: FidelityHarness | null = null
    let workloadError: unknown = null
    let agentName = `tf-${cli}`
    try {
      // Thread the retry index so divergence/telemetry bundles land under
      // attempt-<n>/ and a retry can't overwrite a prior attempt's artifacts.
      harness = await launchFidelityHarness(cli, undefined, testInfo.retry)
      console.log(
        `[term-fidelity] ${cli}: instance=${harness.instanceName} port=${harness.apiPort} ` +
        `userData=${harness.userDataDir}`
      )
      const agent = await spawnRealAgent(harness)
      agentName = agent.name
      try {
        await runCanonicalWorkloads(harness, agent)
      } catch (error) {
        workloadError = error
      }

      let telemetryError: Error | null = null
      if (harness.telemetry.length > 0) {
        const artifactDir = await writeTelemetryArtifact(harness, agentName)
        telemetryError = new Error(
          `Reconciler repair telemetry fired ${harness.telemetry.length} time(s); ` +
          `a repaired creation vector still fails the matrix. Artifacts: ${artifactDir}\n` +
          harness.telemetry.map((entry) => `${entry.at} [${entry.workload || 'setup'}] ${entry.line}`).join('\n')
        )
      }

      if (workloadError || telemetryError) {
        const failures = [workloadError, telemetryError].filter(Boolean)
        throw new AggregateError(failures, failures.map((failure) =>
          failure instanceof Error ? failure.message : String(failure)
        ).join('\n\n'))
      }
    } finally {
      await harness?.close()
    }
  })
}
