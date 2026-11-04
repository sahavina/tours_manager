// Tài chính, đối soát, nhập file, phân xe.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { as, bookingEvent, closePool, makeWorld, owner, rpc, service, user, type World } from './test/harness'

let w: World

beforeAll(async () => {
  w = await makeWorld('fin')
})
afterAll(closePool)

const normalized = (ref: string, date: string, over: object = {}) => ({
  external_ref: ref, status: 'confirmed', currency: 'USD', gross_amount: '50.00', lead: { name: `CSV ${ref}` },
  items: [{ product_code: 'P1', option_code: '', local_date: date, local_time: '08:00:00', pax: { adult: 1 } }],
  ...over,
})

describe('nhập CSV', () => {
  const preview = (rows: object[], hash = 'h1') =>
    rpc(user(w.agent), 'import_preview', w.org, w.connection, 'f.csv', hash, 100, {},
      JSON.stringify(rows.map((normalized, i) => ({ row_no: i + 2, normalized, raw: {} }))))

  it('nhập lại cùng file không tạo booking trùng', async () => {
    const dep = await w.departure('2030-01-01')
    const rows = [normalized('C-1', '2030-01-01'), normalized('C-2', '2030-01-01')]
    const p1 = await preview(rows)
    expect(p1.counts.create).toBe(2)
    const c1 = await rpc(user(w.agent), 'import_commit', p1.job_id)
    expect(c1).toMatchObject({ created: 2, updated: 0 })

    const p2 = await preview(rows)
    expect(p2.counts.duplicate).toBe(2)
    const c2 = await rpc(user(w.agent), 'import_commit', p2.job_id)
    expect(c2).toMatchObject({ created: 0, updated: 0 })

    const found = await owner(`select id from public.bookings where organization_id = $1 and external_ref in ('C-1', 'C-2')`, [w.org])
    expect(found).toHaveLength(2)
    const [a] = await owner<any>(`select public._pool_committed(inventory_pool_id) c from public.departures where id = $1`, [dep])
    expect(a.c).toBe(2)
  })

  it('xác nhận hai lần cùng job chỉ nhập một lần', async () => {
    await w.departure('2030-01-02')
    const p = await preview([normalized('C-3', '2030-01-02')])
    await rpc(user(w.agent), 'import_commit', p.job_id)
    const again = await rpc(user(w.agent), 'import_commit', p.job_id)
    expect(again.code).toBe('already_committed')
  })

  it('phân loại dòng lỗi, cập nhật, trùng trong file', async () => {
    await w.departure('2030-01-03')
    const first = await preview([normalized('C-4', '2030-01-03')])
    await rpc(user(w.agent), 'import_commit', first.job_id)

    const p = await preview([
      normalized('C-4', '2030-01-03', { gross_amount: '77.00' }),
      normalized('C-5', 'không-phải-ngày'),
      normalized('C-6', '2030-01-03', { currency: 'usd' }),
      normalized('C-7', '2030-01-03', { items: [{ product_code: 'P1', local_date: '2030-01-03', pax: { adult: 'hai' } }] }),
      normalized('C-8', '2030-01-03'),
      normalized('C-8', '2030-01-03'),
    ])
    expect(p.counts).toMatchObject({ update: 1, error: 3, create: 1, duplicate: 1 })
    await rpc(user(w.agent), 'import_commit', p.job_id)
    const [b] = await owner<any>(`select gross_amount from public.bookings where organization_id = $1 and external_ref = 'C-4'`, [w.org])
    expect(Number(b.gross_amount)).toBe(77)
  })

  it('file không ghi đè booking đang đồng bộ trực tiếp từ kênh', async () => {
    await w.departure('2030-01-04')
    await rpc(service, 'ingest_channel_event', w.connection, {
      ...bookingEvent('LIVE-1', '2030-01-04'), source_at: '2030-01-01T00:00:00Z' })
    const p = await preview([normalized('LIVE-1', '2030-01-04', { gross_amount: '1.00' })])
    expect(p.counts.duplicate).toBe(1)
  })

  it('booking lịch sử chiếm chỗ khi nhập, chuyến đầy thì vào hàng chờ', async () => {
    const dep = await w.departure('2030-01-05', 1)
    const p = await preview([normalized('H-1', '2030-01-05'), normalized('H-2', '2030-01-05')])
    const c = await rpc(user(w.agent), 'import_commit', p.job_id)
    expect(c).toMatchObject({ created: 2, queued: 1 })
    const [a] = await owner<any>(`select public._pool_committed(inventory_pool_id) c from public.departures where id = $1`, [dep])
    expect(a.c).toBe(1)
  })
})

describe('tiền', () => {
  it('không cộng trực tiếp tiền khác tiền tệ', async () => {
    const d = await w.departure('2030-02-01')
    await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('USD-1', '2030-02-01', { data: { currency: 'USD', gross_amount: '100' } }))
    await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('EUR-1', '2030-02-01', { data: { currency: 'EUR', gross_amount: '90' } }))
    await owner(`insert into public.expenses (organization_id, departure_id, amount, currency) values ($1, $2, 30, 'USD'), ($1, $2, 40, 'VND')`, [w.org, d])

    const sum = await rpc(user(w.ownerId), 'dashboard_summary', w.org, '2000-01-01', '2100-01-01', null)
    const byCur = Object.fromEntries(sum.values_by_currency.map((v: any) => [v.currency, Number(v.gross)]))
    expect(byCur.EUR).toBe(90)
    expect(byCur.USD).toBeGreaterThanOrEqual(100)

    const profit = await rpc(user(w.ownerId), 'report_profit', w.org, '2030-02-01', '2030-02-01')
    const currencies = profit.map((p: any) => p.currency).sort()
    expect(currencies).toEqual(['EUR', 'USD', 'VND'])
    expect(profit.find((p: any) => p.currency === 'VND').gross).toBeNull()
  })

  it('phí chưa biết không bị coi là 0', async () => {
    await w.departure('2030-02-02')
    const r = await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('NOFEE', '2030-02-02'))
    const [f] = await owner<any>(`select channel_fee, expected_payout, actual_payout from public.booking_financials where booking_id = $1`, [r.booking_id])
    expect(f).toEqual({ channel_fee: null, expected_payout: null, actual_payout: null })
  })

  it('báo cáo lợi nhuận không ra số khi còn thiếu phí hoặc chi phí, và nói rõ thiếu gì', async () => {
    const d = await w.departure('2030-02-03')
    await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('P-1', '2030-02-03', { data: { gross_amount: '100', financials: { channel_fee: '20' } } }))
    await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('P-2', '2030-02-03', { data: { gross_amount: '100' } }))
    let [row] = await rpc(user(w.ownerId), 'report_profit', w.org, '2030-02-03', '2030-02-03')
    expect(row.profit).toBeNull()
    expect(row.missing_fee).toBe(1)
    expect(row.departures_without_cost).toBe(1)

    await rpc(user(w.accountant), 'update_booking_financials',
      (await owner<any>(`select id from public.bookings where organization_id = $1 and external_ref = 'P-2'`, [w.org]))[0].id, { channel_fee: '20' })
    await as(user(w.accountant), `insert into public.expenses (organization_id, departure_id, amount, currency) values ($1, $2, 50, 'USD')`, [w.org, d])
    ;[row] = await rpc(user(w.ownerId), 'report_profit', w.org, '2030-02-03', '2030-02-03')
    expect(Number(row.profit)).toBe(110)
  })

  it('xóa số dự kiến trở lại "chưa có dữ liệu", không thành 0', async () => {
    await w.departure('2030-02-04')
    const r = await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('NUL-1', '2030-02-04', { data: { financials: { expected_payout: '10' } } }))
    await rpc(user(w.accountant), 'update_booking_financials', r.booking_id, { expected_payout: '' })
    const [f] = await owner<any>(`select expected_payout from public.booking_financials where booking_id = $1`, [r.booking_id])
    expect(f.expected_payout).toBeNull()
  })
})

describe('đối soát', () => {
  let batch: string

  beforeAll(async () => {
    await w.departure('2030-03-01')
    for (const [ref, exp] of [['S-OK', '80'], ['S-DIFF', '80'], ['S-NOEXP', null]] as const) {
      await rpc(service, 'ingest_channel_event', w.connection, bookingEvent(ref, '2030-03-01', {
        data: { currency: 'USD', financials: exp ? { expected_payout: exp } : {} } }))
    }
    const rows = [
      { row_no: 2, external_ref: 'S-OK', currency: 'USD', gross: '100', fee: '20', net: '80' },
      { row_no: 3, external_ref: 'S-DIFF', currency: 'USD', gross: '100', fee: '25', net: '75' },
      { row_no: 4, external_ref: 'S-NOEXP', currency: 'USD', gross: '100', fee: '20', net: '80' },
      { row_no: 5, external_ref: 'S-UNKNOWN', currency: 'USD', gross: '10', fee: '1', net: '9' },
      { row_no: 6, external_ref: 'S-OK', currency: 'EUR', gross: '1', fee: '0', net: '1' },
      { row_no: 7, external_ref: '', currency: 'USD', net: 'abc' },
    ]
    const p = await rpc(user(w.accountant), 'settlement_preview', w.org, w.connection, 's.csv', 'sh1', {}, JSON.stringify(rows))
    batch = p.batch_id
  })

  const lines = () => owner<any>(`select external_ref, match_status, difference, note from public.settlement_lines where batch_id = $1 order by row_no`, [batch])

  it('phân loại khớp, lệch, chưa tìm thấy, khác tiền tệ, không hợp lệ', async () => {
    const l = await lines()
    expect(l.map((x) => x.match_status)).toEqual(['matched', 'mismatch', 'matched', 'unmatched', 'mismatch', 'invalid'])
    expect(Number(l[1].difference)).toBe(-5)
    expect(l[2].difference).toBeNull()
    expect(l[4].note).toMatch(/Khác tiền tệ/)
  })

  it('chưa xác nhận thì chưa ghi số thực nhận', async () => {
    const [f] = await owner<any>(`select f.actual_payout from public.booking_financials f join public.bookings b on b.id = f.booking_id
      where b.organization_id = $1 and b.external_ref = 'S-OK'`, [w.org])
    expect(f.actual_payout).toBeNull()
  })

  it('xác nhận hai lần không cộng dồn; dòng khác tiền tệ không cộng vào', async () => {
    await rpc(user(w.accountant), 'settlement_confirm', batch)
    const again = await rpc(user(w.accountant), 'settlement_confirm', batch)
    expect(again.code).toBe('already_confirmed')
    const [f] = await owner<any>(`select f.actual_payout, b.reconciliation_status from public.booking_financials f join public.bookings b on b.id = f.booking_id
      where b.organization_id = $1 and b.external_ref = 'S-OK'`, [w.org])
    expect(Number(f.actual_payout)).toBe(80)
  })

  it('cùng file không nhập được lần hai', async () => {
    const p = await rpc(user(w.accountant), 'settlement_preview', w.org, w.connection, 's.csv', 'sh1', {}, '[]')
    expect(p).toMatchObject({ code: 'already_imported', batch_id: batch })
  })

  it('dòng đã có ở bảng trước bị đánh dấu trùng', async () => {
    const rows = [{ row_no: 2, external_ref: 'S-OK', currency: 'USD', gross: '100', fee: '20', net: '80' }]
    const p = await rpc(user(w.accountant), 'settlement_preview', w.org, w.connection, 's2.csv', 'sh2', {}, JSON.stringify(rows))
    const [l] = await owner<any>(`select match_status from public.settlement_lines where batch_id = $1`, [p.batch_id])
    expect(l.match_status).toBe('duplicate')
  })

  it('cùng khoản tiền ở file khác, khác cách ghi hay thiếu cột phí vẫn là trùng, thực nhận không bị cộng đôi', async () => {
    const actual = async () => Number((await owner<any>(`select f.actual_payout a from public.booking_financials f
      join public.bookings b on b.id = f.booking_id where b.organization_id = $1 and b.external_ref = 'S-OK'`, [w.org]))[0].a)
    expect(await actual()).toBe(80)
    const rows = [{ row_no: 2, external_ref: 'S-OK', currency: 'USD', net: '80' }]
    const p = await rpc(user(w.accountant), 'settlement_preview', w.org, w.connection, 's3.csv', 'sh3', {}, JSON.stringify(rows))
    const [l] = await owner<any>(`select match_status from public.settlement_lines where batch_id = $1`, [p.batch_id])
    expect(l.match_status).toBe('duplicate')
    await rpc(user(w.accountant), 'settlement_confirm', p.batch_id)
    expect(await actual()).toBe(80)
  })

  it('gán tay dòng chưa ghép và lưu lịch sử điều chỉnh', async () => {
    const [line] = await owner<any>(`select id from public.settlement_lines where batch_id = $1 and external_ref = 'S-UNKNOWN'`, [batch])
    const [b] = await owner<any>(`select id from public.bookings where organization_id = $1 and external_ref = 'S-NOEXP'`, [w.org])
    expect((await rpc(user(w.accountant), 'settlement_match_line', line.id, b.id, 'Mã gõ nhầm')).ok).toBe(true)
    const m = await owner<any>(`select action, note from public.reconciliation_matches where settlement_line_id = $1`, [line.id])
    expect(m).toEqual([{ action: 'manual', note: 'Mã gõ nhầm' }])
    const [f] = await owner<any>(`select actual_payout from public.booking_financials where booking_id = $1`, [b.id])
    expect(Number(f.actual_payout)).toBe(89)

    expect(await rpc(user(w.accountant), 'settlement_adjust', b.id, '')).toMatchObject({ ok: false, code: 'note_required' })
    expect((await rpc(user(w.accountant), 'settlement_adjust', b.id, 'Đã trao đổi với kênh')).ok).toBe(true)
  })

  it('người không có quyền tài chính không đọc được', async () => {
    expect(await as(user(w.operator), `select 1 from public.settlement_lines where batch_id = $1`, [batch])).toHaveLength(0)
    await expect(rpc(user(w.operator), 'settlement_confirm', batch)).rejects.toThrow(/forbidden/)
  })
})

describe('phân xe', () => {
  it('không vượt sức chứa xe, không chia khách của chuyến khác', async () => {
    const dep = await w.departure('2030-04-01', 10)
    const other = await w.departure('2030-04-02', 10)
    const b1 = await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('V-1', '2030-04-01', { pax: { adult: 3 } }))
    const b2 = await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('V-2', '2030-04-01', { pax: { adult: 2 } }))
    const b3 = await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('V-3', '2030-04-02', { pax: { adult: 1 } }))
    const itemOf = async (b: string) => (await owner<any>(`select id from public.booking_items where booking_id = $1`, [b]))[0].id as string

    await rpc(user(w.operator), 'assign_vehicle', dep, w.vehicleId, null, null)
    const [va] = await owner<any>(`select id from public.vehicle_assignments where departure_id = $1`, [dep])

    expect((await rpc(user(w.operator), 'allocate_passengers', va.id, await itemOf(b1.booking_id))).ok).toBe(true)
    expect(await rpc(user(w.operator), 'allocate_passengers', va.id, await itemOf(b2.booking_id))).toMatchObject({ ok: false, code: 'vehicle_full', capacity: 4, used: 3 })
    expect(await rpc(user(w.operator), 'allocate_passengers', va.id, await itemOf(b3.booking_id))).toMatchObject({ ok: false, code: 'different_departure' })
    expect(other).toBeTruthy()
  })

  it('đổi chuyến tắt phân xe cũ nhưng giữ lịch sử', async () => {
    const dep = await w.departure('2030-04-03', 10)
    const dest = await w.departure('2030-04-04', 10)
    const b = await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('V-4', '2030-04-03', { pax: { adult: 1 } }))
    const [item] = await owner<any>(`select id from public.booking_items where booking_id = $1`, [b.booking_id])
    await rpc(user(w.operator), 'assign_vehicle', dep, w.vehicleId, null, null)
    const [va] = await owner<any>(`select id from public.vehicle_assignments where departure_id = $1`, [dep])
    await rpc(user(w.operator), 'allocate_passengers', va.id, item.id)
    await rpc(user(w.operator), 'move_booking_item', item.id, dest)
    const rows = await owner<any>(`select is_active from public.passenger_allocations where booking_item_id = $1`, [item.id])
    expect(rows).toEqual([{ is_active: false }])
  })

  it('trạng thái điều hành suy ra đúng khi đủ hướng dẫn viên và xe', async () => {
    const dep = await w.departure('2030-04-05', 10)
    const b = await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('V-5', '2030-04-05'))
    const status = async () => (await owner<any>(`select ops_status from public.bookings where id = $1`, [b.booking_id]))[0].ops_status
    expect(await status()).toBe('ready')
    await rpc(user(w.operator), 'assign_guide', dep, w.guideId, 'lead')
    expect(await status()).toBe('ready')
    await rpc(user(w.operator), 'assign_vehicle', dep, w.vehicleId, null, null)
    expect(await status()).toBe('assigned')
    const board = await rpc(user(w.operator), 'ops_board', w.org, '2030-04-05', '2030-04-05')
    expect(board[0]).toMatchObject({ missing_guide: false, missing_vehicle: false })
  })

  it('gói có đưa đón mà thiếu điểm đón thì báo thiếu thông tin', async () => {
    await w.departure('2030-04-06', 10)
    const b = await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('V-6', '2030-04-06', { product: 'P2' }))
    const [row] = await owner<any>(`select ops_status from public.bookings where id = $1`, [b.booking_id])
    expect(row.ops_status).toBe('needs_info')
  })
})

describe('khách hàng', () => {
  it('không tự gộp theo tên, gợi ý chỉ dựa trên email hoặc số điện thoại, gộp cần quyền', async () => {
    await owner(`insert into public.customers (organization_id, full_name, email) values
      ($1, 'Trùng Tên', 'a@x.vn'), ($1, 'Trùng Tên', 'b@x.vn'), ($1, 'Khác Tên', 'A@x.vn')`, [w.org])
    const sugg = await rpc(user(w.ownerId), 'customer_duplicate_suggestions', w.org)
    const email = sugg.find((s: any) => s.value === 'a@x.vn')
    expect(email.customers).toHaveLength(2)
    expect(sugg.find((s: any) => s.value === 'b@x.vn')).toBeUndefined()

    const [keep, drop] = email.customers
    await expect(rpc(user(w.operator), 'merge_customers', keep.id, drop.id)).rejects.toThrow(/forbidden/)
    expect((await rpc(user(w.agent), 'merge_customers', keep.id, drop.id)).ok).toBe(true)
  })

  it('khách OTA mặc định không có đồng ý marketing', async () => {
    await w.departure('2030-05-01')
    await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('MK-1', '2030-05-01'))
    const [c] = await owner<any>(`select c.marketing_consent from public.customers c join public.bookings b on b.customer_id = c.id
      where b.organization_id = $1 and b.external_ref = 'MK-1'`, [w.org])
    expect(c.marketing_consent).toBe(false)
  })
})
