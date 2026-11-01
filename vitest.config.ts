import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Database tests share one test database and empty it before each test,
    // so test files must not run at the same time.
    fileParallelism: false,
    globalSetup: ['./vitest.global-setup.ts'],
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});
