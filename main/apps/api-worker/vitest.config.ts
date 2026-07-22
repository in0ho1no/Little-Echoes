import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
  resolve: {
    alias: {
      'cloudflare:workers': new URL('./test/workers-shim.ts', import.meta.url).pathname,
    },
  },
});
