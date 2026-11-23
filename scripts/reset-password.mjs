#!/usr/bin/env node
// Cấp mật khẩu tạm mới cho một tài khoản đã có. Cần khóa service role nên không có trên giao diện.
//
//   node --env-file=.env scripts/reset-password.mjs <email>
//
// Mật khẩu ngẫu nhiên được in MỘT lần ra màn hình của người chạy lệnh; không ghi vào file hay log nào.
import { randomBytes } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const [email] = process.argv.slice(2)
if (!email) {
  console.error('Cách dùng: node --env-file=.env scripts/reset-password.mjs <email>')
  process.exit(1)
}
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
let user = null
for (let page = 1; !user; page++) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
  if (error) {
    console.error('Không đọc được danh sách tài khoản:', error.message)
    process.exit(1)
  }
  user = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null
  if (data.users.length < 200) break
}
if (!user) {
  console.error(`Không có tài khoản ${email}`)
  process.exit(1)
}
const password = randomBytes(12).toString('base64url')
const { error } = await admin.auth.admin.updateUserById(user.id, { password })
if (error) {
  console.error('Không đổi được mật khẩu:', error.message)
  process.exit(1)
}
console.log(`Đã cấp mật khẩu mới cho ${email}. Mật khẩu tạm: ${password}`)
