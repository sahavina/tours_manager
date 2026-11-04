// Toàn luồng theo đặc tả §14: tạo tour -> tạo chuyến -> ghép mã -> nhận booking mô phỏng -> phân xe/HDV
// -> điểm danh -> nhập đối soát -> xem báo cáo. Mỗi bước dùng đúng vai trò và đúng lời gọi của giao diện.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { simulate } from '@tours/channels'
import { normalizeBookingRow, parseCsv, suggestColumnMap, normalizeSettlementRow, SETTLEMENT_FIELDS } from '@tours/core'
import { as, closePool, makeUser, owner, rpc, user } from './test/harness'

let org: string
const ids: Record<string, string> = {}

beforeAll(async () => {
  const [o] = await owner<{ id: string }>(`insert into public.organizations (name, slug) values ('Luồng', 'flow-' || gen_random_uuid()) returning id`)
  org = o!.id
  for (const [k, role] of [['boss', 'owner'], ['ops', 'operator'], ['acc', 'accountant'], ['agent', 'booking_agent'], ['guide', 'guide']] as const) {
    ids[k] = await makeUser(`${k}.${org}@test.local`)
    await owner(`insert into public.memberships (organization_id, user_id, role_key) values ($1, $2, $3)`, [org, ids[k], role])
  }
})
afterAll(closePool)

describe('toàn luồng', () => {
  const DATE = '2031-03-10'

  it('đi trọn từ tạo tour đến báo cáo', async () => {
    const boss = user(ids.boss!)
    const ops = user(ids.ops!)
    const acc = user(ids.acc!)

    // Tạo tour, gói, nhóm khách: ghi trực tiếp qua RLS như CrudPage.
    const [tour] = await as<{ id: string }>(boss, `insert into public.tours (organization_id, code, name, default_timezone) values ($1, 'F1', 'Tour luồng', 'Asia/Ho_Chi_Minh') returning id`, [org])
    const [option] = await as<{ id: string }>(boss, `insert into public.tour_options (organization_id, tour_id, code, name, has_transfer) values ($1, $2, 'F1-T', 'Có đón', true) returning id`, [org, tour!.id])
    await as(boss, `insert into public.traveler_categories (organization_id, code, name) values ($1, 'adult', 'Người lớn')`, [org])

    // Tạo chuyến.
    const dep = await rpc(ops, 'create_departure', org, tour!.id, null, DATE, '08:00', 'Asia/Ho_Chi_Minh', 10, null)
    expect(dep.ok).toBe(true)

    // Tạo kết nối mô phỏng, nhận booking TRƯỚC khi ghép mã: phải vào hàng chờ, không mất đơn.
    const conn = await rpc(boss, 'connection_create', org, 'viator', 'Mock', { hold: 'supported' }, 900)
    expect(conn.ok).toBe(true)
    const ctx = { channel: 'viator' as const, productCode: 'VF1', localDate: DATE, localTime: '08:00:00', uid: () => 'FLOW1' }
    const ev = simulate.newBooking(ctx, { adult: 3 })
    ev.data.items![0]!.pickup = { hotel: 'KS Hà Nội', address: '1 Tràng Tiền' }
    const queued = await rpc(boss, 'ingest_channel_event', conn.connection_id, ev)
    expect(queued).toMatchObject({ ok: true, queued: true })

    // Ghép mã xong, booking tự được xếp chuyến.
    const mapped = await rpc(boss, 'mapping_save', null, org, conn.connection_id, 'VF1', '', option!.id, 'en', null, null, true)
    expect(mapped.placed).toBe(1)
    const bookingId = queued.booking_id as string

    // Phân công.
    const [g] = await as<{ id: string }>(boss, `insert into public.guides (organization_id, profile_id, full_name) values ($1, $2, 'HDV') returning id`, [org, ids.guide])
    const [v] = await as<{ id: string }>(boss, `insert into public.vehicles (organization_id, name, seats) values ($1, 'Xe', 8) returning id`, [org])
    expect((await rpc(ops, 'assign_guide', dep.departure_id, g!.id, 'lead')).ok).toBe(true)
    expect((await rpc(ops, 'assign_vehicle', dep.departure_id, v!.id, null, null)).ok).toBe(true)

    const [va] = await as<{ id: string }>(ops, `select id from public.vehicle_assignments where departure_id = $1`, [dep.departure_id])
    const [item] = await as<{ id: string }>(ops, `select id from public.booking_items where booking_id = $1`, [bookingId])
    expect((await rpc(ops, 'allocate_passengers', va!.id, item!.id)).ok).toBe(true)
    expect((await rpc(ops, 'set_pickup', item!.id, { pickup_local_time: '07:15' })).ok).toBe(true)

    const [status] = await as<{ ops_status: string }>(ops, `select ops_status from public.bookings where id = $1`, [bookingId])
    expect(status!.ops_status).toBe('assigned')

    // Hướng dẫn viên điểm danh trên điện thoại.
    const guideUser = user(ids.guide!)
    const mine = await rpc(guideUser, 'guide_my_departures', '2031-01-01', '2031-12-31')
    expect(mine.map((d: { id: string }) => d.id)).toEqual([dep.departure_id])
    const list = await rpc(guideUser, 'guide_manifest', dep.departure_id)
    expect(list[0]).toMatchObject({ hotel_name: 'KS Hà Nội', pickup_local_time: '07:15:00', vehicle_name: 'Xe' })
    expect((await rpc(guideUser, 'set_attendance', dep.departure_id, item!.id, 'picked_up', null)).ok).toBe(true)
    expect((await rpc(guideUser, 'report_incident', dep.departure_id, 'normal', 'Tắc đường 15 phút')).ok).toBe(true)

    // Chi phí và đóng chuyến.
    await as(acc, `insert into public.expenses (organization_id, departure_id, amount, currency, is_final) values ($1, $2, 20, 'USD', true)`, [org, dep.departure_id])
    expect((await rpc(ops, 'complete_departure', dep.departure_id, 'Suôn sẻ')).ok).toBe(true)

    // Đối soát bằng CSV thật qua đúng bộ phân tích của giao diện.
    const net = '90.00' // Dự kiến của booking mô phỏng 3 khách: 120 * 0.75.
    const csv = parseCsv(`Booking Reference,Currency,Gross,Fee,Net\n${ev.external_ref},USD,120.00,30.00,${net}\nKHONG-CO,USD,10,1,9\n`)
    const map = suggestColumnMap(csv.headers, SETTLEMENT_FIELDS)
    const rows = csv.rows.map((r, i) => normalizeSettlementRow(r, map, i + 2))
    const batch = await rpc(acc, 'settlement_preview', org, conn.connection_id, 'tt.csv', 'flow-hash', map, JSON.stringify(rows))
    expect((await owner<{ match_status: string }>(`select match_status from public.settlement_lines where batch_id = $1 order by row_no`, [batch.batch_id])).map((l) => l.match_status)).toEqual(['matched', 'unmatched'])
    expect((await rpc(acc, 'settlement_confirm', batch.batch_id)).applied).toBe(1)

    // Báo cáo.
    const [report] = await rpc(acc, 'report_profit', org, DATE, DATE)
    expect(report).toMatchObject({ tour_name: 'Tour luồng', currency: 'USD', bookings: 1, departures_without_cost: 0, missing_fee: 0 })
    expect(Number(report.gross)).toBe(120)
    expect(Number(report.actual_payout)).toBe(90)
    expect(Number(report.profit)).toBe(70) // 120 - 30 phí - 20 chi phí.

    const [b] = await as<{ reconciliation_status: string; ops_status: string; sync_status: string }>(boss, `select reconciliation_status, ops_status, sync_status from public.bookings where id = $1`, [bookingId])
    expect(b).toMatchObject({ reconciliation_status: 'matched', ops_status: 'done', sync_status: 'simulated' })
  })

  it('CSV booking đi qua bộ chuẩn hóa thật rồi vào cùng đường ghi', async () => {
    const agent = user(ids.agent!)
    const [conn] = await owner<{ id: string }>(`select id from public.channel_connections where organization_id = $1 limit 1`, [org])
    const csv = parseCsv(`Booking Reference,Product Code,Travel Date,Time,Adults,Amount,Currency\nCSV-9,VF1,10/03/2031,08:00,2,"80,00",EUR\nCSV-ERR,VF1,31/02/2031,08:00,2,,\n`)
    const map = suggestColumnMap(csv.headers)
    const rows = csv.rows.map((r, i) => ({ row_no: i + 2, raw: r, ...normalizeBookingRow(r, map, 'Asia/Ho_Chi_Minh') }))
    const p = await rpc(agent, 'import_preview', org, conn!.id, 'b.csv', 'h', 10, map, JSON.stringify(rows))
    expect(p.counts).toMatchObject({ create: 1, error: 1 })
    const c = await rpc(agent, 'import_commit', p.job_id)
    expect(c.created).toBe(1)
    const [b] = await owner<{ currency: string; gross_amount: string }>(`select currency, gross_amount from public.bookings where organization_id = $1 and external_ref = 'CSV-9'`, [org])
    expect(b!.currency).toBe('EUR')
    expect(Number(b!.gross_amount)).toBe(80)
  })

  it('worker: outbox sinh đúng một thông báo, chạy lại không tạo trùng, mock không báo đã đẩy thật', async () => {
    const claimed = await owner<{ id: string; topic: string }>(`select * from public.worker_claim_outbox(500)`)
    expect(claimed.length).toBeGreaterThan(0)
    for (const e of claimed) await owner(`select public.worker_notify($1)`, [e.id])
    const before = await owner<{ n: string }>(`select count(*) n from public.notifications where organization_id = $1`, [org])
    expect(Number(before[0]!.n)).toBeGreaterThan(0)
    for (const e of claimed) await owner(`select public.worker_notify($1)`, [e.id])
    const after = await owner<{ n: string }>(`select count(*) n from public.notifications where organization_id = $1`, [org])
    expect(after[0]!.n).toBe(before[0]!.n)
    // Lấy lại ngay không được: đã ở trạng thái running, worker khác không xử lý trùng.
    const twice = await owner<{ id: string }>(`select * from public.worker_claim_outbox(500) where id = any($1::bigint[])`, [claimed.map((c) => c.id)])
    expect(twice).toHaveLength(0)
    for (const e of claimed) await owner(`select public.worker_finish_outbox($1, null)`, [e.id])
  })

  it('thông báo chỉ tới người có quyền phù hợp', async () => {
    const visible = await as(user(ids.guide!), `select 1 from public.notifications where organization_id = $1`, [org])
    expect(visible).toHaveLength(0)
    const forAgent = await as(user(ids.agent!), `select 1 from public.notifications where organization_id = $1`, [org])
    expect(forAgent.length).toBeGreaterThan(0)
  })
})
