import { defineConfig } from 'vite';

/**
 * Proxy `/api/*` to the FastAPI backend during local dev (`uvicorn app:app --port 8000`
 * from repo root). Production builds are served by the same host as `app.py`, so
 * `/api/...` works without a proxy.
 */
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
});
