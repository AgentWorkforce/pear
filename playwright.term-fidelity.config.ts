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
  // Retain every attempt's output on a retry-then-pass. A flaky first attempt is
  // exactly the REAL divergence event we need to examine; `failures-only` would
  // delete the whole (eventually-passing) test's dirs, including the failed
  // attempt's error-context.md and trace. The harness also segregates its own
  // divergence/telemetry bundles under attempt-<retry>/ (see oracle.ts) so a
  // retry never overwrites the first attempt's data.
  preserveOutput: 'always',
  use: {
    // Records a trace per attempt and keeps it for any attempt that failed
    // (dropped only for clean passes). On retry-then-pass the failed first
    // attempt's trace is retained; combined with preserveOutput:'always' its
    // error-context survives too.
    trace: 'retain-on-failure'
  },
  reporter: [['list']]
})
