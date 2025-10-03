import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['receipt.ts'],
  thresholds: { lines: 85, functions: 85, branches: 75, statements: 85 }
    },
  },
});
