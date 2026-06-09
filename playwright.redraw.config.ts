import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/playwright',
  testMatch: /redraw-drain\.spec\.ts/,
  // Generous: the burst + drain wall-clock is driven by REDRAW_DURATION_MS /
  // REDRAW_DRAIN_TIMEOUT_MS, and the spec sets its own per-test timeout.
  timeout: 240_000,
  expect: {
    timeout: 15_000
  },
  webServer: {
    command: 'npx vite preview --config vite.web.config.ts --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4174',
    viewport: { width: 1440, height: 960 },
    trace: 'retain-on-failure'
  },
  reporter: [['list']]
})
