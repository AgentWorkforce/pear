import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/playwright',
  testMatch: /(fidelity-no-duplication|rendering-corruption|terminal-focus-stacking)\.spec\.ts/,
  timeout: 90_000,
  expect: {
    timeout: 15_000
  },
  webServer: {
    command: 'npx vite preview --config vite.web.config.ts --host 127.0.0.1 --port 4175',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
    timeout: 30_000
  },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4175',
    viewport: { width: 1440, height: 960 },
    trace: 'retain-on-failure'
  },
  reporter: [['list']]
})
