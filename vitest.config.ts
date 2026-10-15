// Unit tests for pure logic (src/common, src/main derived reads). Kept separate
// from electron.vite.config.ts so the app build is untouched; tests run in
// plain Node with `electron` mocked per-file where needed.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    // Pin a zone ahead of UTC (the user's) so local-vs-UTC date bugs surface deterministically.
    env: { TZ: 'Australia/Sydney' }
  }
})
