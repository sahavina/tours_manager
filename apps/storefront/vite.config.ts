import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // Cổng riêng cho trang khách, tách khỏi trang quản trị (3101).
  server: { port: Number(process.env.PORT) || 3104, strictPort: true },
  // Dùng chung VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY mà dev stack ghi vào apps/admin/.env.local.
  // Khi build thật thì đặt biến môi trường trực tiếp.
  envDir: '../admin',
  plugins: [react()],
})
