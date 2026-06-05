import { resolve } from 'node:path'

export default {
  resolve: {
    alias: {
      '@': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    include: ['src/main/**/*.test.ts', 'src/renderer/src/**/*.test.ts', 'packages/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', 'src/main/__tests__/**']
  }
}
