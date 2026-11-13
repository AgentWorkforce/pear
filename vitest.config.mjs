import { resolve } from 'node:path'

const sharedAlias = {
  '@': resolve('src/renderer/src'),
  '@shared': resolve('src/shared')
}

export default {
  resolve: { alias: sharedAlias },
  test: {
    projects: [
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'node',
          environment: 'node',
          // A few timing-sensitive tests (e.g. cloud-agent git-overlay setup) can
          // exceed the 5s default when the suite runs as a full CI gate or back-to-back
          // with the node:test suite under load. Give them headroom so the gate is stable.
          testTimeout: 20_000,
          hookTimeout: 20_000,
          include: [
            'src/main/**/*.test.ts',
            'src/renderer/src/**/*.test.ts',
            'packages/**/*.test.ts'
          ],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/out/**',
            'src/main/__tests__/**',
            '**/*.dom.test.ts'
          ]
        }
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          name: 'dom',
          environment: 'happy-dom',
          testTimeout: 20_000,
          hookTimeout: 20_000,
          setupFiles: ['src/renderer/src/__test__/dom-setup.ts'],
          include: ['src/renderer/src/**/*.dom.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/out/**']
        }
      }
    ]
  }
}
