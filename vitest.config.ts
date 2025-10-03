import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['receipt.ts'],
    },
  },
});
