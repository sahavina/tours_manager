#!/usr/bin/env node
// Tạo tài khoản đăng nhập và gán vào doanh nghiệp. Cần khóa service role nên không có trên giao diện.
//
//   node --env-file=.env scripts/create-user.mjs <email> <org-slug> <role>
//
// Mật khẩu ngẫu nhiên được in MỘT lần ra màn hình; người dùng đổi hoặc đặt lại sau.
import { randomBytes } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import pg from 'pg'

const [email, slug, role] = process.argv.slice(2)
if (!email || !slug || !role) {
  console.error('Cách dùng: node --env-file=.env scripts/create-user.mjs <email> <org-slug> <role>')
  process.exit(1)
}
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL } = process.env
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_DB_URL) {
  console.error('Thiếu SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY hoặc SUPABASE_DB_URL')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const password = randomBytes(12).toString('base64url')
const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
if (error) {
  console.error('Không tạo được tài khoản:', error.message)
  process.exit(1)
}

const db = new pg.Client({ connectionString: SUPABASE_DB_URL })
await db.connect()
const res = await db.query(
  `insert into public.memberships (organization_id, user_id, role_key)
   select o.id, $1, $2 from public.organizations o where o.slug = $3
   on conflict (organization_id, user_id) do update set role_key = excluded.role_key returning id`,
  [data.user.id, role, slug],
)
await db.end()
if (res.rowCount === 0) {
  console.error(`Không tìm thấy doanh nghiệp ${slug}`)
  process.exit(1)
}
console.log(`Đã tạo ${email}, vai trò ${role}. Mật khẩu tạm: ${password}`)
