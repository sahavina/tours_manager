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
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const password = randomBytes(12).toString('base64url')
const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
if (error) {
  console.error('Không tạo được tài khoản:', error.message)
  process.exit(1)
}

// Có SUPABASE_DB_URL thì ghi thẳng database; không có (Supabase tự cài, database không mở ra ngoài) thì ghi qua
// REST bằng khóa service role.
let found
if (SUPABASE_DB_URL) {
  const db = new pg.Client({ connectionString: SUPABASE_DB_URL })
  await db.connect()
  const res = await db.query(
    `insert into public.memberships (organization_id, user_id, role_key)
     select o.id, $1, $2 from public.organizations o where o.slug = $3
     on conflict (organization_id, user_id) do update set role_key = excluded.role_key returning id`,
    [data.user.id, role, slug],
  )
  await db.end()
  found = res.rowCount > 0
} else {
  const org = await admin.from('organizations').select('id').eq('slug', slug).maybeSingle()
  if (org.error) throw org.error
  if (org.data) {
    const m = await admin.from('memberships')
      .upsert({ organization_id: org.data.id, user_id: data.user.id, role_key: role }, { onConflict: 'organization_id,user_id' })
    if (m.error) throw m.error
  }
  found = Boolean(org.data)
}
if (!found) {
  console.error(`Không tìm thấy doanh nghiệp ${slug}`)
  process.exit(1)
}
console.log(`Đã tạo ${email}, vai trò ${role}. Mật khẩu tạm: ${password}`)
