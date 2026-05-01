import { defineConfig } from 'vite';

// Proxy the MJPEG stream through the Vite origin so OBS Browser Source
// doesn't have to fetch cross-origin (it can be stricter than Chrome).
export default defineConfig({
  server: {
    proxy: {
      '/stream.mjpg': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        // MJPEG is a long-lived stream; don't try to buffer/transform.
        // Vite will just pipe bytes through.
      },
    },
  },
});

