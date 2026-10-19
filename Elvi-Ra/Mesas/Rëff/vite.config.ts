import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: 'client',
  base: process.env.VITE_BASE_PATH === 'root' ? '/' : '/reff/app/',
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/client'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules/react') && !id.includes('react-markdown') && !id.includes('react-syntax-highlighter')) {
            return 'vendor-react';
          }
          if (id.includes('react-syntax-highlighter') || id.includes('prismjs')) {
            return 'vendor-syntax';
          }
          if (id.includes('react-markdown') || id.includes('remark-gfm')) {
            return 'vendor-markdown';
          }
          if (id.includes('react-router')) {
            return 'vendor-router';
          }
        },
      },
    },
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
