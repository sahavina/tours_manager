// Dựng một database test MỚI trên Postgres THẬT cho mỗi lượt chạy, áp đúng các migration, rồi xóa.
//
// Vì sao không dùng PGlite như keodansaha: PGlite chỉ có một kết nối, nên bài "hai yêu cầu tranh chỗ
// cuối" sẽ chạy tuần tự và luôn xanh, kể cả khi khóa bị viết sai. Ở đây mỗi yêu cầu có kết nối riêng.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(here, '..', '..', '..', '..', 'supabase', 'migrations')

// Stub đúng phần Supabase mà migration dùng. Roles là của cả cluster nên phải tạo có điều kiện.
const BOOTSTRAP = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'
);
create or replace function auth.uid() returns uuid language sql stable as $f$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$f$;
create or replace function auth.role() returns text language sql stable as $f$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
$f$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
`

export default async function setup() {
  const adminUrl =
    process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55422/postgres'
  const dbName = `tours_test_${process.pid}_${Date.now()}`

  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  // UTF8 tường minh: cụm Postgres khởi tạo trên Windows mặc định WIN1252, không chứa được tiếng Việt.
  await admin.query(`create database ${dbName} encoding 'UTF8' template template0 locale 'C'`)

  const url = new URL(adminUrl)
  url.pathname = `/${dbName}`
  process.env.TOURS_TEST_DB = url.toString()

  const db = new pg.Client({ connectionString: url.toString() })
  await db.connect()
  await db.query(BOOTSTRAP)

  for (const file of readdirSync(migrationsDir).sort()) {
    if (!file.endsWith('.sql')) continue
    try {
      await db.query(readFileSync(join(migrationsDir, file), 'utf8'))
    } catch (e) {
      const err = e as { message: string; position?: string }
      const sql = readFileSync(join(migrationsDir, file), 'utf8')
      const line = err.position ? sql.slice(0, Number(err.position)).split('\n').length : '?'
      // Đóng kết nối trước khi ném: không thì Vitest treo chờ socket mở.
      await db.end()
      await admin.query(`drop database if exists ${dbName} with (force)`)
      await admin.end()
      throw new Error(`Migration ${file} dòng ${line}: ${err.message}`)
    }
  }
  await db.end()

  return async () => {
    await admin.query(`drop database if exists ${dbName} with (force)`)
    await admin.end()
  }
}
