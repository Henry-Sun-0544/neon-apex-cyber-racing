import { defineConfig } from 'vite';

/**
 * Vite configuration for Neon Apex: Cyber Racing.
 * `base: './'` keeps the production bundle portable (works from any sub-path / static host).
 */
export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: false,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        // Keep three.js in its own chunk so the game code stays cacheable.
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three';
          return undefined;
        },
      },
    },
  },
});
