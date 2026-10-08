import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
    // Each worker loads the whole editor schema (TipTap + React + citation-js) and
    // peaks near 3.5 GB. Vitest otherwise starts one worker per core, which on a
    // many-core machine exhausts RAM — worse when two worktrees test at once.
    // Two forks keeps a full run under ~8 GB at roughly the same wall-clock.
    pool: 'forks',
    poolOptions: { forks: { minForks: 1, maxForks: 2 } },
    maxConcurrency: 4,
  },
});
