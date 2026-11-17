import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1', port: 3210, strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/artifacts': 'http://127.0.0.1:8787',
    },
  },
  build: {
    target: 'es2022',
    rollupOptions: { output: { manualChunks: { three: ['three'] } } },
  },
});
