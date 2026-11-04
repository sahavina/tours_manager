import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globalSetup: ['src/test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Một database dùng chung cho cả bộ test; mỗi file tự tạo doanh nghiệp riêng.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
