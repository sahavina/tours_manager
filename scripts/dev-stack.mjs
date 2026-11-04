#!/usr/bin/env node
// Stack local KHÔNG cần Docker, thay cho `supabase start` trên máy mà container runtime không chạy được.
//
//   node scripts/dev-stack.mjs            khởi động (lần đầu tự áp migration)
//   node scripts/dev-stack.mjs --reset    xóa database rồi áp lại toàn bộ migration
//
// Gồm: Postgres thật (embedded-postgres), PostgREST bản chính thức (.tools/postgrest), và một cổng HTTP
// giả lập đúng phần API của Supabase mà app dùng (/auth/v1, /rest/v1) tại cổng 55421.
//
// ⚠ CHỈ DÙNG CHO DEV. Cổng xác thực ở đây tự viết trên node:crypto, không có giới hạn đăng nhập, không
// xác minh email, khóa JWT sinh ở máy. Production dùng Supabase Auth thật. Vì vậy nó chỉ lắng nghe 127.0.0.1.
import { spawn } from 'node:child_process'
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { join, resolve } from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'

const PG_PORT = 55423
const REST_PORT = 55431
const GATEWAY_PORT = 55421
const DB_NAME = 'tourhub'
const DB_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`
const reset = process.argv.includes('--reset')

const postgrestBin = resolve('.tools/postgrest/postgrest.exe')
const hasPostgrest = existsSync(postgrestBin)
if (!hasPostgrest) {
  // Vẫn chạy được Postgres và API auth (đủ cho seed, worker). App quản trị thì cần /rest/v1.
  console.warn('CẢNH BÁO: thiếu PostgREST nên /rest/v1 không hoạt động, app quản trị sẽ không tải được dữ liệu.')
  console.warn('Tải bản Windows từ https://github.com/PostgREST/postgrest/releases vào .tools/postgrest/')
}

// Khóa JWT sinh một lần cho máy này và giữ lại giữa các lần chạy, nằm trong file đã bị .gitignore chặn.
const SECRET_FILE = resolve('.env.dev-stack')
const jwtSecret = existsSync(SECRET_FILE)
  ? /DEV_JWT_SECRET=(.+)/.exec(readFileSync(SECRET_FILE, 'utf8'))?.[1]
  : randomBytes(32).toString('hex')

const b64 = (v) => Buffer.from(v).toString('base64url')
function signJwt(claims) {
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64(JSON.stringify(claims))
  const sig = createHmac('sha256', jwtSecret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}
function verifyJwt(token) {
  const [h, b, s] = String(token).split('.')
  if (!h || !b || !s) return null
  const expected = createHmac('sha256', jwtSecret).update(`${h}.${b}`).digest()
  const given = Buffer.from(s, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  const claims = JSON.parse(Buffer.from(b, 'base64url').toString())
  return claims.exp && claims.exp < Date.now() / 1000 ? null : claims
}
const FAR = Math.floor(Date.now() / 1000) + 10 * 365 * 86400
const anonKey = signJwt({ role: 'anon', iss: 'dev-stack', exp: FAR })
const serviceKey = signJwt({ role: 'service_role', iss: 'dev-stack', exp: FAR })

const hashPassword = (password, salt = randomBytes(16).toString('hex')) => `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
function checkPassword(password, stored) {
  const [salt, hash] = String(stored).split(':')
  if (!salt || !hash) return false
  const a = Buffer.from(hash, 'hex')
  const b = scryptSync(password, salt, 64)
  return a.length === b.length && timingSafeEqual(a, b)
}

// ---- Postgres ----
const dataDir = resolve('.pgdata-test')
const embedded = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port: PG_PORT, persistent: true })
const adminUrl = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`

async function canConnect() {
  const c = new pg.Client({ connectionString: adminUrl })
  try {
    await c.connect()
    await c.end()
    return true
  } catch {
    return false
  }
}
let ownsPostgres = false
if (!(await canConnect())) {
  if (!existsSync(join(dataDir, 'PG_VERSION'))) await embedded.initialise()
  await embedded.start()
  ownsPostgres = true
}

const BOOTSTRAP = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login password 'authenticator' noinherit; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb default '{}',
  encrypted_password text,
  created_at timestamptz default now()
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

{
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  const { rows } = await admin.query('select 1 from pg_database where datname = $1', [DB_NAME])
  if (reset && rows.length) await admin.query(`drop database ${DB_NAME} with (force)`)
  const fresh = reset || rows.length === 0
  if (fresh) await admin.query(`create database ${DB_NAME} encoding 'UTF8' template template0 locale 'C'`)
  await admin.end()

  if (fresh) {
    const db = new pg.Client({ connectionString: DB_URL })
    await db.connect()
    await db.query(BOOTSTRAP)
    const dir = resolve('supabase/migrations')
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.sql')) continue
      await db.query(readFileSync(join(dir, file), 'utf8'))
      console.log('Đã áp', file)
    }
    await db.end()
  }
}
const pool = new pg.Pool({ connectionString: DB_URL, max: 4 })

// ---- PostgREST ----
// Bản Windows của PostgREST cần libpq.dll, không kèm trong zip; gói embedded-postgres có sẵn file đó.
const pgNativeBin = () => {
  const store = resolve('node_modules/.pnpm')
  const pkg = readdirSync(store).find((d) => d.startsWith('@embedded-postgres+windows-x64'))
  return pkg ? join(store, pkg, 'node_modules/@embedded-postgres/windows-x64/native/bin') : ''
}

const rest = hasPostgrest
  ? spawn(postgrestBin, [], {
      env: {
        // Bỏ mọi biến thể PATH/Path trước: Windows không phân biệt hoa thường nên chỉ một bản có tác dụng.
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path')),
        Path: `${pgNativeBin()};${process.env.Path ?? process.env.PATH ?? ''}`,
        PGRST_DB_URI: `postgresql://authenticator:authenticator@127.0.0.1:${PG_PORT}/${DB_NAME}`,
        PGRST_DB_SCHEMAS: 'public',
        PGRST_DB_ANON_ROLE: 'anon',
        PGRST_JWT_SECRET: jwtSecret,
        PGRST_SERVER_HOST: '127.0.0.1',
        PGRST_SERVER_PORT: String(REST_PORT),
        PGRST_DB_MAX_ROWS: '1000',
        PGRST_LOG_LEVEL: 'error',
      },
      stdio: 'inherit',
    })
  : null
rest?.on('exit', (code) => console.error(`PostgREST dừng, mã ${code}`))

// ---- Cổng HTTP ----
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-expose-headers': 'content-range,content-profile',
}
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS })
  res.end(JSON.stringify(body))
}
const readBody = (req) => new Promise((ok) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => ok(Buffer.concat(chunks)))
})
const toUser = (u) => ({
  id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, user_metadata: u.raw_user_meta_data ?? {},
  app_metadata: {}, created_at: u.created_at, email_confirmed_at: u.created_at,
})
const refreshTokens = new Map()
function session(u) {
  const expires_in = 3600
  const expires_at = Math.floor(Date.now() / 1000) + expires_in
  const refresh_token = randomBytes(24).toString('hex')
  refreshTokens.set(refresh_token, u.id)
  const access_token = signJwt({ sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', exp: expires_at })
  return { access_token, token_type: 'bearer', expires_in, expires_at, refresh_token, user: toUser(u) }
}
const bearer = (req) => verifyJwt((req.headers.authorization ?? '').replace(/^Bearer /i, ''))

async function auth(req, res, url, raw) {
  const path = url.pathname.replace('/auth/v1', '')
  const body = raw.length ? JSON.parse(raw.toString()) : {}

  if (path === '/token' && req.method === 'POST') {
    if (url.searchParams.get('grant_type') === 'refresh_token') {
      const id = refreshTokens.get(body.refresh_token)
      if (!id) return send(res, 400, { error: 'invalid_grant', error_description: 'Refresh token không hợp lệ' })
      refreshTokens.delete(body.refresh_token)
      const { rows } = await pool.query('select * from auth.users where id = $1', [id])
      return rows[0] ? send(res, 200, session(rows[0])) : send(res, 400, { error: 'invalid_grant' })
    }
    const { rows } = await pool.query('select * from auth.users where lower(email) = lower($1)', [body.email])
    if (!rows[0] || !checkPassword(body.password ?? '', rows[0].encrypted_password)) {
      return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials', msg: 'Invalid login credentials' })
    }
    return send(res, 200, session(rows[0]))
  }
  if (path === '/logout') {
    res.writeHead(204, CORS)
    return res.end()
  }
  if (path === '/user' && req.method === 'GET') {
    const claims = bearer(req)
    if (!claims?.sub) return send(res, 401, { msg: 'unauthorized' })
    const { rows } = await pool.query('select * from auth.users where id = $1', [claims.sub])
    return rows[0] ? send(res, 200, toUser(rows[0])) : send(res, 401, { msg: 'unauthorized' })
  }
  // Admin API: chỉ khóa service role, như Supabase thật.
  if (path.startsWith('/admin/users')) {
    if (bearer(req)?.role !== 'service_role') return send(res, 403, { msg: 'forbidden' })
    const id = path.split('/')[3]
    if (req.method === 'GET') {
      const { rows } = await pool.query('select * from auth.users order by created_at')
      return send(res, 200, { users: rows.map(toUser), aud: 'authenticated' })
    }
    if (req.method === 'POST') {
      const { rows } = await pool.query(
        'insert into auth.users (email, encrypted_password, raw_user_meta_data) values ($1, $2, $3) returning *',
        [body.email, hashPassword(body.password), body.user_metadata ?? {}],
      )
      return send(res, 200, toUser(rows[0]))
    }
    if (req.method === 'PUT' && id) {
      const { rows } = await pool.query('update auth.users set encrypted_password = coalesce($2, encrypted_password) where id = $1 returning *', [id, body.password ? hashPassword(body.password) : null])
      return rows[0] ? send(res, 200, toUser(rows[0])) : send(res, 404, { msg: 'not found' })
    }
  }
  return send(res, 404, { msg: 'not implemented in dev-stack' })
}

function proxyRest(req, res, url, raw) {
  const headers = { ...req.headers, host: `127.0.0.1:${REST_PORT}`, 'content-length': raw.length }
  // supabase-js luôn gửi Authorization; khóa anon/service role là JWT hợp lệ nên PostgREST tự đổi role.
  const upstream = httpRequest({ host: '127.0.0.1', port: REST_PORT, method: req.method, path: url.pathname.replace('/rest/v1', '') + url.search, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, { ...r.headers, ...CORS })
    r.pipe(res)
  })
  upstream.on('error', () => send(res, 502, { message: 'PostgREST chưa sẵn sàng' }))
  upstream.end(raw)
}

const gateway = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    return res.end()
  }
  try {
    const url = new URL(req.url, `http://127.0.0.1:${GATEWAY_PORT}`)
    const raw = await readBody(req)
    if (url.pathname.startsWith('/auth/v1')) return await auth(req, res, url, raw)
    if (url.pathname.startsWith('/rest/v1')) return proxyRest(req, res, url, raw)
    send(res, 404, { msg: 'not found' })
  } catch (e) {
    console.error('gateway', e instanceof Error ? e.message : e)
    send(res, 500, { msg: 'internal error' })
  }
})
gateway.listen(GATEWAY_PORT, '127.0.0.1')

// Giá trị cho app và script; mọi file này đều bị .gitignore chặn.
writeFileSync(SECRET_FILE, `DEV_JWT_SECRET=${jwtSecret}\n`)
writeFileSync(resolve('.env'), [
  `WORKER_DATABASE_URL=${DB_URL}`, 'WORKER_POLL_MS=5000', 'WORKER_HEALTH_PORT=3102',
  `SUPABASE_URL=http://127.0.0.1:${GATEWAY_PORT}`, `SUPABASE_SERVICE_ROLE_KEY=${serviceKey}`, `SUPABASE_DB_URL=${DB_URL}`,
  `TEST_DATABASE_URL=${adminUrl}`, '',
].join('\n'))
writeFileSync(resolve('apps/admin/.env.local'), `VITE_SUPABASE_URL=http://127.0.0.1:${GATEWAY_PORT}\nVITE_SUPABASE_ANON_KEY=${anonKey}\n`)
console.log(`Stack dev sẵn sàng: http://127.0.0.1:${GATEWAY_PORT} (đã ghi .env và apps/admin/.env.local)`)

const stop = async () => {
  rest?.kill()
  gateway.close()
  await pool.end()
  if (ownsPostgres) await embedded.stop()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
