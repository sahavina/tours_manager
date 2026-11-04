#!/usr/bin/env node
// Dữ liệu demo tái tạo được (PRNG cố định, ngày tính theo ngày chạy seed). Chỉ chạy trên database local:
// tài khoản demo có mật khẩu dùng chung, không bao giờ được xuất hiện trên production.
//
//   pnpm db:seed
//
// Toàn bộ booking đi qua đúng các RPC mà hệ thống dùng thật, nên số chỗ và trạng thái là kết quả thật.
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import pg from 'pg'

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:55421'
const DB_URL = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:55422/postgres'
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const isLocal = (u) => /^(postgres(ql)?|https?):\/\/([^@/]*@)?(127\.0\.0\.1|localhost|host\.docker\.internal)[:/]/.test(u)
if (!isLocal(SUPABASE_URL) || !isLocal(DB_URL)) {
  console.error('Từ chối chạy: seed demo chỉ dùng cho database local.')
  process.exit(1)
}
if (!SERVICE_KEY) {
  console.error('Thiếu SUPABASE_SERVICE_ROLE_KEY. Lấy bằng: pnpm exec supabase status')
  process.exit(1)
}

// PRNG cố định (mulberry32).
let seedState = 20261104
const rand = () => {
  seedState = (seedState + 0x6d2b79f5) | 0
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (a) => a[Math.floor(rand() * a.length)]
const int = (min, max) => min + Math.floor(rand() * (max - min + 1))

const pad = (n) => String(n).padStart(2, '0')
const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }))
const day = (offset) => {
  const d = new Date(today)
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const password = process.env.DEMO_PASSWORD || randomBytes(12).toString('base64url')
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
const db = new pg.Client({ connectionString: DB_URL })
await db.connect()

const q = async (sql, params = []) => (await db.query(sql, params)).rows

// Chạy lại seed: xóa sạch doanh nghiệp demo, chỉ doanh nghiệp này. FK nghiệp vụ cố ý không cascade (chặn
// xóa nhầm dữ liệu thật) và nhật ký chặn xóa, nên chế độ replica tắt trigger trong đúng giao dịch này.
const [existing] = await q(`select id from public.organizations where slug = 'saha-demo'`)
if (existing) {
  await db.query('begin')
  await db.query(`set local session_replication_role = replica`)
  const tables = await q(`select table_name from information_schema.columns c join pg_tables t on t.tablename = c.table_name and t.schemaname = 'public'
    where c.table_schema = 'public' and c.column_name = 'organization_id'`)
  for (const { table_name } of tables) await db.query(`delete from public.${table_name} where organization_id = $1`, [existing.id])
  await q(`delete from public.organizations where id = $1`, [existing.id])
  await db.query('commit')
}

const [{ id: org }] = await q(`insert into public.organizations (name, slug, booking_prefix) values ('SAHA Travel (demo)', 'saha-demo', 'SH') returning id`)

// ---- Tài khoản ----
const ACCOUNTS = [
  ['owner@demo.local', 'Chủ doanh nghiệp', 'owner'],
  ['admin@demo.local', 'Quản trị viên', 'admin'],
  ['booking@demo.local', 'Nhân viên booking', 'booking_agent'],
  ['ops@demo.local', 'Điều hành', 'operator'],
  ['ketoan@demo.local', 'Kế toán', 'accountant'],
  ['guide1@demo.local', 'HDV Minh', 'guide'],
  ['guide2@demo.local', 'HDV Lan', 'guide'],
  ['viewer@demo.local', 'Chỉ xem', 'viewer'],
]
const users = {}
const { data: listed } = await admin.auth.admin.listUsers({ perPage: 200 })
for (const [email, name, role] of ACCOUNTS) {
  const found = listed.users.find((u) => u.email === email)
  let id = found?.id
  if (found) {
    await admin.auth.admin.updateUserById(id, { password })
  } else {
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name } })
    if (error) throw error
    id = data.user.id
  }
  users[role === 'guide' ? email : role] = id
  await q(`insert into public.memberships (organization_id, user_id, role_key) values ($1, $2, $3)`, [org, id, role])
}

// Gọi RPC với đúng danh tính: như PostgREST đặt request.jwt.claims và role.
async function rpc(actor, fn, ...args) {
  await db.query('begin')
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(actor)])
    const ph = args.map((_, i) => `$${i + 1}`).join(', ')
    const [row] = await q(`select public.${fn}(${ph}) as r`, args.map((a) => (a !== null && typeof a === 'object' && !Array.isArray(a) ? JSON.stringify(a) : a)))
    await db.query('commit')
    return row.r
  } catch (e) {
    await db.query('rollback')
    throw e
  }
}
const ownerActor = { sub: users.owner, role: 'authenticated' }
const opsActor = { sub: users.operator, role: 'authenticated' }
const channelActor = { role: 'service_role' }

// ---- Danh mục ----
await q(`insert into public.traveler_categories (organization_id, code, name, min_age, max_age, counts_as_seat, sort_order) values
  ($1, 'adult', 'Người lớn', 12, null, true, 1), ($1, 'child', 'Trẻ em', 4, 11, true, 2), ($1, 'infant', 'Em bé', 0, 3, false, 3)`, [org])

const TOURS = [
  { code: 'HLB', name: 'Vịnh Hạ Long 1 ngày', dest: 'Quảng Ninh', mins: 720, tz: 'Asia/Ho_Chi_Minh', time: '08:00', cap: 28, opts: [['HLB-EN-T', 'Tiếng Anh, đón tại khách sạn', 'en', true], ['HLB-EN', 'Tiếng Anh, tự đến bến', 'en', false], ['HLB-KO-T', 'Tiếng Hàn, đón tại khách sạn', 'ko', true]] },
  { code: 'NBH', name: 'Ninh Bình: Hoa Lư, Tam Cốc', dest: 'Ninh Bình', mins: 660, tz: 'Asia/Ho_Chi_Minh', time: '07:30', cap: 16, opts: [['NBH-EN-T', 'Tiếng Anh, có đưa đón', 'en', true]] },
  { code: 'HNF', name: 'Food tour phố cổ Hà Nội', dest: 'Hà Nội', mins: 210, tz: 'Asia/Ho_Chi_Minh', time: '17:30', cap: 12, opts: [['HNF-EN', 'Tiếng Anh, điểm hẹn', 'en', false], ['HNF-PRV', 'Tour riêng', 'en', false]] },
  { code: 'SPA', name: 'Sa Pa: Cát Cát, Fansipan', dest: 'Lào Cai', mins: 780, tz: 'Asia/Ho_Chi_Minh', time: '06:30', cap: 16, opts: [['SPA-EN-T', 'Tiếng Anh, có đưa đón', 'en', true]] },
  { code: 'HOI', name: 'Hội An đèn lồng và thuyền sông Hoài', dest: 'Quảng Nam', mins: 240, tz: 'Asia/Ho_Chi_Minh', time: '16:00', cap: 20, opts: [['HOI-EN', 'Tiếng Anh, điểm hẹn', 'en', false], ['HOI-FR', 'Tiếng Pháp, điểm hẹn', 'fr', false]] },
  { code: 'BKK', name: 'Bangkok: chợ nổi Damnoen Saduak', dest: 'Bangkok', mins: 360, tz: 'Asia/Bangkok', time: '07:00', cap: 14, opts: [['BKK-EN-T', 'Tiếng Anh, có đưa đón', 'en', true]] },
]
const tours = []
for (const t of TOURS) {
  const [row] = await q(`insert into public.tours (organization_id, code, name, destination, duration_minutes, default_timezone, description, joining_instructions, inclusions, exclusions, itinerary)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
    [org, t.code, t.name, t.dest, t.mins, t.tz, `Tour ${t.name}, dữ liệu mẫu.`, 'Có mặt trước giờ khởi hành 15 phút.', ['Hướng dẫn viên', 'Nước uống'], ['Chi phí cá nhân'], JSON.stringify([{ title: 'Đón khách' }, { title: 'Tham quan' }, { title: 'Trả khách' }])])
  const options = []
  for (const [code, name, language, transfer] of t.opts) {
    const [o] = await q(`insert into public.tour_options (organization_id, tour_id, code, name, language, has_transfer, is_private, cutoff_minutes) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [org, row.id, code, name, language, transfer, code.endsWith('PRV'), 120])
    options.push({ id: o.id, code, transfer })
  }
  tours.push({ ...t, id: row.id, options })
}

// ---- Tài nguyên ----
const [sup1] = await q(`insert into public.suppliers (organization_id, name, kind, contact_name, phone) values ($1, 'Nhà xe Thành Công', 'transport', 'Anh Hùng', '0900000001') returning id`, [org])
await q(`insert into public.suppliers (organization_id, name, kind, contact_name, phone) values ($1, 'Du thuyền Bình Minh', 'ticket', 'Chị Mai', '0900000002')`, [org])
const guideRows = []
for (const [name, phone, langs, profile] of [
  ['HDV Minh', '0911000001', ['en', 'vi'], users['guide1@demo.local']],
  ['HDV Lan', '0911000002', ['en', 'fr'], users['guide2@demo.local']],
  ['HDV Tuấn', '0911000003', ['ko', 'vi'], null],
  ['HDV Hà', '0911000004', ['en'], null],
]) {
  const [g] = await q(`insert into public.guides (organization_id, full_name, phone, languages, profile_id) values ($1, $2, $3, $4, $5) returning id`, [org, name, phone, langs, profile])
  guideRows.push(g.id)
}
const vehicleRows = []
for (const [name, plate, seats, driver, phone] of [
  ['Ford Transit 16', '29B-111.11', 15, 'Bác Long', '0922000001'],
  ['Hyundai Solati 16', '29B-222.22', 15, 'Anh Nam', '0922000002'],
  ['Samco 29', '29B-333.33', 28, 'Anh Sơn', '0922000003'],
  ['Innova 7', '30G-444.44', 6, 'Anh Đức', '0922000004'],
]) {
  const [v] = await q(`insert into public.vehicles (organization_id, supplier_id, name, plate, seats, driver_name, driver_phone) values ($1, $2, $3, $4, $5, $6, $7) returning id`, [org, sup1.id, name, plate, seats, driver, phone])
  vehicleRows.push(v.id)
}

// ---- Kết nối mô phỏng ----
const CAPS = { receive_booking: 'supported', receive_cancellation: 'supported', receive_amendment: 'supported', provide_availability: 'supported', hold: 'supported', confirm_booking: 'supported', update_price: 'unsupported', recovery_query: 'unsupported', amend_from_system: 'unsupported' }
const [{ id: viator }] = await q(`insert into public.channel_connections (organization_id, channel, account_name, capabilities, hold_ttl_seconds, supplier_account_ref) values ($1, 'viator', 'Viator tài khoản chính', $2, 900, 'SIM-V-1') returning id`, [org, JSON.stringify(CAPS)])
const [{ id: gyg }] = await q(`insert into public.channel_connections (organization_id, channel, account_name, capabilities, hold_ttl_seconds, supplier_account_ref) values ($1, 'getyourguide', 'GetYourGuide tài khoản chính', $2, 3600, 'SIM-G-1') returning id`, [org, JSON.stringify(CAPS)])
await q(`insert into public.channel_connections (organization_id, channel, account_name, mode, status, approval_status, capabilities) values ($1, 'manual', 'Nhập từ file', 'production', 'connected', 'not_required', '{}')`, [org])

// Ghép mã: sản phẩm ngoài khác mã nội bộ để thấy ánh xạ thật sự có tác dụng.
const mapped = []
for (const t of tours) {
  for (const o of t.options) {
    for (const [conn, prefix] of [[viator, 'V'], [gyg, 'G']]) {
      const product = `${prefix}${o.code.replace(/-/g, '')}`
      await q(`insert into public.channel_product_mappings (organization_id, connection_id, external_product_code, tour_option_id, is_verified, verified_by, verified_at, traveler_map)
        values ($1, $2, $3, $4, true, $5, now(), '{"ADULT":"adult","CHILD":"child","INFANT":"infant"}')`, [org, conn, product, o.id, users.owner])
      mapped.push({ conn, product, tour: t, option: o })
    }
  }
}

// ---- Chuyến từ 14 ngày trước đến 30 ngày sau ----
const departures = new Map()
for (const t of tours) {
  const res = await rpc(ownerActor, 'generate_departures', org, t.id, null, day(-14), day(30), [1, 2, 3, 4, 5, 6, 7], [t.time], t.tz, t.cap, false)
  if (!res.ok) throw new Error(`generate_departures: ${res.code}`)
}
for (const d of await q(`select id, tour_id, local_date::text as date from public.departures where organization_id = $1`, [org])) {
  departures.set(`${d.tour_id}|${d.date}`, d.id)
}

// ---- Khoảng 60 booking ----
const FIRST = ['Emma', 'Liam', 'Sophie', 'Noah', 'Mia', 'Lucas', 'Yuki', 'Hana', 'Marco', 'Chloe', 'Min-jun', 'Ji-woo', 'Pierre', 'Anna', 'Tom']
const LAST = ['Smith', 'Müller', 'Tanaka', 'Rossi', 'Dubois', 'Kim', 'Park', 'Garcia', 'Brown', 'Lee', 'Martin', 'Schmidt']
const HOTELS = ['Hanoi La Siesta', 'Sofitel Metropole', 'Golden Lotus', 'Hotel de l\'Opera', 'Hanoi Pearl', 'Essence Palace']
const CUR = { viator: ['USD', 'EUR'], gyg: ['EUR', 'USD', 'GBP'] }

let seq = 0
function bookingData(ref, m, offset, over = {}) {
  const name = `${pick(FIRST)} ${pick(LAST)}`
  const adult = int(1, 4)
  const child = rand() < 0.25 ? int(1, 2) : 0
  const infant = rand() < 0.08 ? 1 : 0
  const pax = { adult, ...(child ? { child } : {}), ...(infant ? { infant } : {}) }
  const total = adult + child
  const isV = m.conn === viator
  const currency = pick(isV ? CUR.viator : CUR.gyg)
  const gross = total * int(35, 90)
  const hasFee = rand() < 0.75
  const pickup = m.option.transfer && !over.noPickup ? { hotel: pick(HOTELS), address: `${int(1, 99)} Phố ${pick(['Hàng Bạc', 'Hàng Gai', 'Lương Văn Can', 'Tràng Tiền'])}, Hà Nội` } : undefined
  const email = `${name.toLowerCase().normalize('NFD').replace(/[^a-z]+/g, '.')}${seq}@example.invalid`
  return {
    external_ref: ref,
    status: 'confirmed',
    channel_status: 'CONFIRMED',
    booked_at: new Date(Date.now() - int(0, 20) * 86400000 - int(0, 86400000)).toISOString(),
    lead: { name, email, phone: `+10000${String(seq).padStart(6, '0')}` },
    special_requests: rand() < 0.2 ? pick(['Ăn chay', 'Dị ứng hải sản', 'Có người đi xe lăn', 'Sinh nhật khách']) : undefined,
    gross_amount: gross.toFixed(2),
    currency,
    financials: hasFee ? { channel_fee: (gross * 0.25).toFixed(2), expected_payout: (gross * 0.75).toFixed(2) } : undefined,
    policy: { cancellation: 'Miễn phí trước 24 giờ' },
    items: [{
      product_code: m.product,
      option_code: '',
      local_date: day(offset),
      local_time: `${m.tour.time}:00`,
      timezone: m.tour.tz,
      language: 'en',
      pax,
      ...(pickup ? { pickup } : {}),
      participants: [{ name, category: 'adult', is_lead: true }],
    }],
    ...over.data,
  }
}
const prefixOf = (conn) => (conn === viator ? 'BR-SIM' : 'GYG-SIM')
const nextRef = (conn) => `${prefixOf(conn)}-${String(1000 + ++seq)}`
const ingest = async (conn, ev) => rpc(channelActor, 'ingest_channel_event', conn, ev)

const created = []
async function makeBooking(offset, over = {}) {
  const m = over.mapping ?? pick(mapped)
  const ref = nextRef(m.conn)
  const data = bookingData(ref, over.product ? { ...m, product: over.product } : m, offset, over)
  const res = await ingest(m.conn, { event_id: `${ref}:1`, type: 'booking.created', external_ref: ref, version: 1, source_at: new Date(Date.now() - 86400000 * 2).toISOString(), data })
  if (!res.ok) throw new Error(`ingest ${ref}: ${JSON.stringify(res)}`)
  created.push({ ref, conn: m.conn, id: res.booking_id, offset, tour: m.tour, data })
  return created.at(-1)
}

// 44 booking xác nhận trải đều quá khứ và tương lai.
for (let i = 0; i < 44; i++) await makeBooking(int(-12, 25))

// Chuyến hôm nay và ngày mai có khách chắc chắn, để màn hình điều hành có việc.
const hlb = mapped.filter((m) => m.tour.code === 'HLB' && m.option.transfer && m.conn === viator)[0]
const nbh = mapped.filter((m) => m.tour.code === 'NBH' && m.conn === gyg)[0]
const hoi = mapped.filter((m) => m.tour.code === 'HOI' && m.conn === viator)[0]
for (let i = 0; i < 4; i++) await makeBooking(0, { mapping: hlb })
for (let i = 0; i < 3; i++) await makeBooking(1, { mapping: nbh })
for (let i = 0; i < 2; i++) await makeBooking(0, { mapping: hoi })

// Thiếu điểm đón.
for (let i = 0; i < 2; i++) await makeBooking(3, { mapping: hlb, noPickup: true })

// Chưa ghép mã.
await makeBooking(5, { mapping: pick(mapped), product: 'V-NEWPRODUCT-77' })
await makeBooking(6, { mapping: hlb, product: 'V-NEWPRODUCT-77' })
await makeBooking(7, { mapping: nbh, product: 'G-UNKNOWN-12' })

// Hủy.
for (const b of created.slice(0, 5)) {
  await ingest(b.conn, { event_id: `${b.ref}:cancel`, type: 'booking.cancelled', external_ref: b.ref, version: 2, source_at: new Date(Date.now() - 86400000).toISOString(), data: { channel_status: 'CANCELLED' } })
}

// ---- Phân công: một số chuyến đủ, một số thiếu xe/HDV ----
const todayHlb = departures.get(`${hlb.tour.id}|${day(0)}`)
const tomorrowNbh = departures.get(`${nbh.tour.id}|${day(1)}`)
const todayHoi = departures.get(`${hoi.tour.id}|${day(0)}`)
await rpc(opsActor, 'assign_guide', todayHlb, guideRows[0], 'lead')
await rpc(opsActor, 'assign_vehicle', todayHlb, vehicleRows[2], null, null)
await rpc(opsActor, 'assign_guide', tomorrowNbh, guideRows[1], 'lead') // Thiếu xe.
await rpc(opsActor, 'assign_vehicle', todayHoi, vehicleRows[3], null, null) // Thiếu hướng dẫn viên.
await rpc(opsActor, 'assign_guide', todayHoi, guideRows[0], 'lead')
await db.query(`delete from public.guide_assignments where departure_id = $1`, [todayHoi])
await q(`select public._recompute_departure_bookings($1)`, [todayHoi])

// Chia khách lên xe chuyến Hạ Long hôm nay.
const [va] = await q(`select id from public.vehicle_assignments where departure_id = $1`, [todayHlb])
const itemsToday = await q(`select id from public.booking_items where departure_id = $1 and committed_seats > 0 order by id`, [todayHlb])
let order = 1
for (const it of itemsToday) {
  await rpc(opsActor, 'allocate_passengers', va.id, it.id)
  await rpc(opsActor, 'set_pickup', it.id, { pickup_local_time: `07:${pad(order * 7 % 60)}`, sort_order: order, ops_note: order === 1 ? 'Gọi khách trước 10 phút' : null })
  order += 1
}

// Booking đổi ngày SAU khi đã phân công (đúng đặc tả §13).
const movedOne = created.find((b) => b.offset === 0 && b.tour.code === 'HLB')
const movedData = JSON.parse(JSON.stringify(movedOne.data))
movedData.items[0].local_date = day(2)
await ingest(movedOne.conn, { event_id: `${movedOne.ref}:moved`, type: 'booking.updated', external_ref: movedOne.ref, version: 3, source_at: new Date().toISOString(), data: movedData })

// Ghi chú nội bộ.
await rpc({ sub: users.booking_agent, role: 'authenticated' }, 'add_booking_note', created[8].id, 'Khách hỏi thêm về vé máy bay, đã trả lời qua email.')

// ---- Chi phí ----
const pastDep = await q(`select d.id from public.departures d where d.organization_id = $1 and d.local_date < $2 and exists (select 1 from public.booking_items i where i.departure_id = d.id and i.committed_seats > 0) order by d.local_date limit 12`, [org, day(0)])
for (const [i, d] of pastDep.entries()) {
  if (i % 3 === 2) continue // Cố ý để một số chuyến thiếu chi phí: báo cáo phải nói rõ.
  await q(`insert into public.expenses (organization_id, departure_id, category, description, amount, currency, is_final, incurred_on)
    values ($1, $2, 'transport', 'Thuê xe', $3, 'USD', $4, $5)`, [org, d.id, int(40, 120), i % 2 === 0, day(-1)])
}

// ---- Đối soát: khớp, lệch, chưa tìm thấy ----
const settleTargets = await q(`select b.external_ref, b.currency, f.expected_payout, b.gross_amount, f.channel_fee from public.bookings b
  join public.booking_financials f on f.booking_id = b.id
  where b.connection_id = $1 and b.status <> 'cancelled' and f.expected_payout is not null order by b.code limit 8`, [viator])
const rows = settleTargets.slice(0, 6).map((b, i) => ({
  row_no: i + 2, external_ref: b.external_ref, currency: b.currency, gross: b.gross_amount, fee: b.channel_fee,
  net: i === 1 ? (Number(b.expected_payout) - 3.5).toFixed(2) : b.expected_payout,
  raw: { source: 'dữ liệu mẫu' },
}))
rows.push({ row_no: rows.length + 2, external_ref: 'BR-SIM-KHONGCO', currency: 'USD', gross: '50', fee: '12.5', net: '37.5', raw: { source: 'dữ liệu mẫu' } })
const accActor = { sub: users.accountant, role: 'authenticated' }
const preview = await rpc(accActor, 'settlement_preview', org, viator, 'viator-thang-mau.csv', 'demo-settlement-1', {}, JSON.stringify(rows))
await rpc(accActor, 'settlement_confirm', preview.batch_id)
const rows2 = settleTargets.slice(6, 8).map((b, i) => ({ row_no: i + 2, external_ref: b.external_ref, currency: b.currency, net: b.expected_payout, raw: {} }))
await rpc(accActor, 'settlement_preview', org, viator, 'viator-chua-xac-nhan.csv', 'demo-settlement-2', {}, JSON.stringify(rows2))

// ---- Sự kiện trùng, sai thứ tự, thất bại cần retry ----
const dupTarget = created.find((b) => b.conn === gyg && b.offset > 2)
const dupEv = { event_id: `${dupTarget.ref}:1`, type: 'booking.created', external_ref: dupTarget.ref, version: 1, data: dupTarget.data }
await ingest(dupTarget.conn, dupEv)
await ingest(dupTarget.conn, dupEv)
await ingest(dupTarget.conn, { event_id: `${dupTarget.ref}:stale`, type: 'booking.updated', external_ref: dupTarget.ref, version: 0, data: dupTarget.data })
await ingest(gyg, { event_id: 'GYG-SIM-9999:cancel', type: 'booking.cancelled', external_ref: 'GYG-SIM-9999', version: 2, data: {} })
await ingest(gyg, { event_id: 'GYG-SIM-BAD:1', type: 'booking.created', external_ref: 'GYG-SIM-BAD', version: 1, data: { external_ref: 'GYG-SIM-BAD', items: [] } })

// Sinh thông báo ngay để giao diện có dữ liệu, không phụ thuộc worker đang chạy.
for (const e of await q(`select id from public.outbox_events where organization_id = $1 and topic <> 'availability.changed' order by id desc limit 15`, [org])) {
  await q(`select public.worker_notify($1)`, [e.id])
}

const [stats] = await q(`select count(*)::int as bookings, count(*) filter (where status = 'cancelled')::int as cancelled, count(*) filter (where ops_status = 'needs_mapping')::int as unmapped, count(*) filter (where ops_status = 'needs_info')::int as no_pickup from public.bookings where organization_id = $1`, [org])
await db.end()

// Tài khoản demo ghi vào file local đã bị .gitignore chặn (.env.*), không in mật khẩu ra màn hình.
writeFileSync('.env.demo-accounts', `# Tài khoản demo local. Không dùng trên production.\nDEMO_PASSWORD=${password}\n${ACCOUNTS.map(([e, , r]) => `# ${r}: ${e}`).join('\n')}\n`)
console.log(`Seed xong: ${stats.bookings} booking (${stats.cancelled} hủy, ${stats.unmapped} chưa ghép mã, ${stats.no_pickup} thiếu điểm đón).`)
console.log('Tài khoản và mật khẩu demo: xem file .env.demo-accounts')
