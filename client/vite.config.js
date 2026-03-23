import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The VacciTrack Dashboard now communicates with the Cloud Backend.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
      '/socket.io': {
        target: 'http://localhost:4000',
        ws: true
      }
    }
  }
})