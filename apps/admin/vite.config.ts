import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // strictPort: hỏng ngay khi cổng bận dễ chữa hơn là lặng lẽ nhảy sang cổng của app khác (keodansaha).
  server: { port: Number(process.env.PORT) || 3101, strictPort: true },
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          antd: ['antd', '@ant-design/icons'],
          charts: ['recharts'],
          vendor: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query', '@supabase/supabase-js'],
        },
      },
    },
  },
})
