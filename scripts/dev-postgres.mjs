#!/usr/bin/env node
// Postgres thật chạy không cần Docker, chỉ để chạy test trên máy chưa có container runtime.
//
//   node scripts/dev-postgres.mjs
//   TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55423/postgres pnpm test:db
//
// Bản này KHÔNG có Auth và PostgREST nên không chạy được app quản trị; app dùng `pnpm db:start`.
// Test tự dựng stub phần auth (packages/database/src/test/global-setup.ts).
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'

const dir = resolve('.pgdata-test')
const fresh = !existsSync(resolve(dir, 'PG_VERSION'))
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: 55423, persistent: true })
if (fresh) await pg.initialise()
await pg.start()
console.log('Postgres sẵn sàng: postgresql://postgres:postgres@127.0.0.1:55423/postgres')

const stop = async () => {
  await pg.stop()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
