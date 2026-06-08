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
          setupFiles: ['src/renderer/src/__test__/dom-setup.ts'],
          include: ['src/renderer/src/**/*.dom.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', '**/out/**']
        }
      }
    ]
  }
}
