import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  entry: ['src/server.ts'],
  format: ['esm'],
  outDir: 'dist',
  outExtension() {
    return {
      js: '.mjs',
    };
  },
  platform: 'node',
  target: 'node20',
});