#!/usr/bin/env node
// Tạo một doanh nghiệp riêng trên database local để nhập dữ liệu thật, không trộn với dữ liệu demo.
//
//   node --env-file=.env scripts/create-org.mjs <slug> "<tên>" <email-chủ> [viator|getyourguide]
//
// Tài khoản kênh tạo ra chỉ để nhập file: trạng thái "Chưa cấu hình", không có khả năng API nào, nên không
// bị hiểu là đã kết nối thật. Email chủ phải là tài khoản đã tồn tại.
import pg from 'pg'

const [slug, name, email, channel = 'getyourguide'] = process.argv.slice(2)
if (!slug || !name || !email) {
  console.error('Cách dùng: node --env-file=.env scripts/create-org.mjs <slug> "<tên>" <email-chủ> [kênh]')
  process.exit(1)
}
const url = process.env.SUPABASE_DB_URL
if (!url || !/@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('Từ chối chạy: script này chỉ dùng cho database local.')
  process.exit(1)
}

const db = new pg.Client({ connectionString: url })
await db.connect()
const q = async (sql, params = []) => (await db.query(sql, params)).rows
try {
  const [user] = await q(`select id from public.profiles where lower(email) = lower($1)`, [email])
  if (!user) throw new Error(`Không có tài khoản ${email}`)
  await db.query('begin')
  const [existing] = await q(`select id from public.organizations where slug = $1`, [slug])
  const org = existing?.id ?? (await q(`insert into public.organizations (name, slug) values ($1, $2) returning id`, [name, slug]))[0].id
  await q(`insert into public.memberships (organization_id, user_id, role_key) values ($1, $2, 'owner') on conflict do nothing`, [org, user.id])
  await q(`insert into public.traveler_categories (organization_id, code, name, min_age, max_age, counts_as_seat, sort_order) values
    ($1, 'adult', 'Người lớn', 12, null, true, 1), ($1, 'child', 'Trẻ em', 4, 11, true, 2), ($1, 'infant', 'Em bé', 0, 3, false, 3)
    on conflict do nothing`, [org])
  await q(`insert into public.channel_connections (organization_id, channel, account_name, mode, status, approval_status, capabilities)
    values ($1, $2, 'Nhập từ báo cáo tải về', 'production', 'not_configured', 'not_requested', '{}')
    on conflict do nothing`, [org, channel])
  await db.query('commit')
  console.log(`Sẵn sàng: doanh nghiệp "${name}", kênh ${channel}, chủ ${email}.`)
} catch (e) {
  await db.query('rollback').catch(() => {})
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  await db.end()
}
