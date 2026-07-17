import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/term-fidelity',
  testMatch: /term-fidelity\.spec\.ts/,
  // A real CLI case performs six model turns. Keep each CLI isolated and
  // serial so broker ports, native app windows, and user credentials are not
  // contended by parallel workers.
  timeout: 30 * 60_000,
  workers: 1,
  fullyParallel: false,
  expect: {
    timeout: 30_000
  },
  outputDir: 'test-results/term-fidelity/playwright',
  use: {
    trace: 'retain-on-failure'
  },
  reporter: [['list']]
})
