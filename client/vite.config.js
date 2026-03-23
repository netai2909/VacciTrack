import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The VacciTrack Dashboard now communicates with the Cloud Backend.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'https://vaccitrack-cloud.onrender.com',
        changeOrigin: true,
        secure: false,
      },
      '/socket.io': {
        target: 'https://vaccitrack-cloud.onrender.com',
        ws: true,
        changeOrigin: true,
        secure: false,
      }
    }
  }
})