import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // The original suite pinned this timezone so that weekday and hour
    // conditions are deterministic.
    env: { TZ: 'Europe/London' },
  },
});
