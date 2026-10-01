import { defineConfig } from 'vitest/config';

export default defineConfig({
  ssr: {
    external: [/^node:/, /^sqlite$/]
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    hookTimeout: 30000,
    testTimeout: 30000,
    server: {
      deps: {
        // Vitest 2 ships a builtin-module list that predates node:sqlite, so the harness pins
        // Node built-ins as external instead of letting Vite resolve them as npm packages.
        external: [/^node:/, /^sqlite$/]
      }
    }
  }
});
