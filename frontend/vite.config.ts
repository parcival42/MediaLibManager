import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev the Vite server proxies API calls to the FastAPI backend on :8080.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
  },
})
