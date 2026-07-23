import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

type LockPackage = {
  version?: string
  optionalDependencies?: Record<string, string>
}

type PackageLock = {
  packages?: Record<string, LockPackage>
}

const MINIMUM_RELAY_VERSION = '11.0.0'
const BROKER_PACKAGES = [
  '@agent-relay/broker-darwin-arm64',
  '@agent-relay/broker-darwin-x64',
  '@agent-relay/broker-linux-arm64',
  '@agent-relay/broker-linux-x64',
  '@agent-relay/broker-win32-x64'
] as const

function parseVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(version)
  assert.ok(match, `expected a semver version, received ${version}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index]
    }
  }
  return 0
}

test('release lock keeps the Relay v11 broker aligned with the harness driver', () => {
  const lock = JSON.parse(
    readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8')
  ) as PackageLock
  const packages = lock.packages ?? {}
  const driver = packages['node_modules/@agent-relay/harness-driver']
  assert.ok(driver?.version, 'package-lock must include @agent-relay/harness-driver')
  assert.ok(
    compareVersions(driver.version, MINIMUM_RELAY_VERSION) >= 0,
    `@agent-relay/harness-driver ${driver.version} must stay on Relay v11 or newer`
  )

  for (const packageName of BROKER_PACKAGES) {
    const broker = packages[`node_modules/${packageName}`]
    assert.equal(
      broker?.version,
      driver.version,
      `${packageName} must stay aligned with @agent-relay/harness-driver`
    )
    assert.equal(
      driver.optionalDependencies?.[packageName],
      driver.version,
      `@agent-relay/harness-driver must request the aligned ${packageName}`
    )
  }
})
