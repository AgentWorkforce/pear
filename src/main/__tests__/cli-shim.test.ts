import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildPearCliShim, resolvePackagedFactoryFleetBin } from '../cli-shim.ts'

test('resolvePackagedFactoryFleetBin points factory at the unpacked package payload', () => {
  assert.equal(
    resolvePackagedFactoryFleetBin('/Applications/Pear.app/Contents/Resources/app.asar'),
    '/Applications/Pear.app/Contents/Resources/app.asar.unpacked/packages/factory-sdk/bin/fleet.mjs',
  )
})

test('buildPearCliShim keeps app commands on Electron and runs factory headlessly', () => {
  const shim = buildPearCliShim(
    "/Applications/Pear by Agent Relay.app/Contents/MacOS/Pear's App",
    '/Applications/Pear by Agent Relay.app/Contents/Resources/app.asar',
  )

  assert.match(shim, /\nif \[ "\$1" = "factory" \]; then\n/)
  assert.match(shim, /ELECTRON_RUN_AS_NODE=1 exec '/)
  assert.match(shim, /app\.asar\.unpacked\/packages\/factory-sdk\/bin\/fleet\.mjs' "\$@"/)
  assert.match(shim, /exec '\/Applications\/Pear by Agent Relay\.app\/Contents\/MacOS\/Pear'\\''s App' "\$@"/)
})
