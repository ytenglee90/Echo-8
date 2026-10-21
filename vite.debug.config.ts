import { rename } from 'node:fs/promises';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { defineConfig, type Plugin } from 'vite';

function renameDebugEntry(): Plugin {
  return {
    name: 'echo-8-debug-entry-name',
    apply: 'build',
    async closeBundle() {
      await rename('artifacts/debug/portable.html', 'artifacts/debug/Echo-8-debug.html');
    },
  };
}

export default defineConfig({
  base: './',
  css: {
    devSourcemap: true,
    postcss: { plugins: [tailwindcss()] },
  },
  plugins: [react(), renameDebugEntry()],
  build: {
    outDir: 'artifacts/debug',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: { input: 'portable.html' },
  },
});
