import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // A path dependency would otherwise bring its own React copy into the bundle.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3030',
        changeOrigin: true,
      },
    },
  },
})
