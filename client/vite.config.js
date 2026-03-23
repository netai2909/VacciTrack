import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The VacciTrack Dashboard defaults to the local Edge Server (offline mode).
// When deployed to Vercel, it uses VITE_API_URL.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true
      }
    }
  }
})