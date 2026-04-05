import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  entry: ['src/server.ts'],
  format: ['cjs'],
  outDir: 'dist',
  platform: 'node',
  target: 'node20',
});