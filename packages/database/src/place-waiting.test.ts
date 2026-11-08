// Xếp hàng loạt booking đang chờ chuyến. Mỗi bài dùng doanh nghiệp riêng vì hàm chạy trên toàn bộ hàng chờ.
import { afterAll, describe, expect, it } from 'vitest'
import { bookingEvent, closePool, makeWorld, owner, rpc, seats, service, user } from './test/harness'

afterAll(closePool)

const waiting = async (org: string) =>
  (await owner(`select i.id from public.booking_items i join public.bookings b on b.id = i.booking_id
    where i.organization_id = $1 and i.departure_id is null and b.status <> 'cancelled'`, [org])).length

const ingest = (w: { connection: string }, ref: string, date: string, over = {}) =>
  rpc(service, 'ingest_channel_event', w.connection, bookingEvent(ref, date, over))

describe('xếp booking đang chờ', () => {
  it('xem trước không đổi dữ liệu', async () => {
    const w = await makeWorld('plc1')
    await ingest(w, 'A', '2030-08-01')
    const r = await rpc(user(w.operator), 'place_waiting_bookings', w.org, true, null)
    expect(r).toMatchObject({ ok: true, placed: 0, created: 0 })
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ bookings: 1, seats: 2, departure_id: null })
    expect(await waiting(w.org)).toBe(1)
  })

  it('xếp vào chuyến đã có, gỡ cờ chờ và ghi lịch sử xếp chuyến', async () => {
    const w = await makeWorld('plc2')
    const a = await ingest(w, 'A', '2030-08-02')
    const dep = await w.departure('2030-08-02', 5)
    const r = await rpc(user(w.operator), 'place_waiting_bookings', w.org, false, null)
    expect(r).toMatchObject({ ok: true, placed: 1, created: 0, no_seats: 0 })
    expect((await seats(dep)).committed).toBe(2)
    const [b] = await owner<{ needs_action: boolean }>(`select needs_action from public.bookings where id = $1`, [a.booking_id])
    expect(b!.needs_action).toBe(false)
    const changes = await owner<{ change_type: string; channel_request_status: string }>(
      `select change_type, channel_request_status from public.booking_changes where booking_id = $1 and change_type = 'placed'`, [a.booking_id])
    expect(changes).toEqual([{ change_type: 'placed', channel_request_status: 'not_applicable' }])
  })

  it('chỉ tạo chuyến khi người dùng cho sức chứa', async () => {
    const w = await makeWorld('plc3')
    await ingest(w, 'A', '2030-08-03')
    await ingest(w, 'B', '2030-08-03')
    expect(await rpc(user(w.ownerId), 'place_waiting_bookings', w.org, false, null)).toMatchObject({ placed: 0, created: 0 })
    expect(await waiting(w.org)).toBe(2)

    const r = await rpc(user(w.ownerId), 'place_waiting_bookings', w.org, false, 12)
    expect(r).toMatchObject({ placed: 2, created: 1 })
    expect(await waiting(w.org)).toBe(0)
    const deps = await owner<{ tour_option_id: string }>(`select tour_option_id from public.departures where organization_id = $1`, [w.org])
    expect(deps).toEqual([{ tour_option_id: w.option }])
    // Chạy lại không tạo thêm chuyến.
    expect(await rpc(user(w.ownerId), 'place_waiting_bookings', w.org, false, 12)).toMatchObject({ placed: 0, created: 0 })
  })

  it('không đủ chỗ thì booking đó ở lại hàng chờ, các booking khác vẫn được xếp', async () => {
    const w = await makeWorld('plc4')
    await ingest(w, 'A', '2030-08-04')
    await ingest(w, 'B', '2030-08-04')
    const dep = await w.departure('2030-08-04', 3)
    const r = await rpc(user(w.operator), 'place_waiting_bookings', w.org, false, null)
    expect(r).toMatchObject({ placed: 1, no_seats: 1 })
    expect((await seats(dep)).committed).toBe(2)
    expect(await waiting(w.org)).toBe(1)
  })

  it('tour riêng không bị gộp: mỗi booking một chuyến cùng giờ', async () => {
    const w = await makeWorld('plc5')
    await owner(`update public.tour_options set is_private = true where id = $1`, [w.option])
    await ingest(w, 'A', '2030-08-05')
    await ingest(w, 'B', '2030-08-05')
    const r = await rpc(user(w.ownerId), 'place_waiting_bookings', w.org, false, 12)
    expect(r).toMatchObject({ placed: 2, created: 2, skipped_private: 0 })
    expect(await waiting(w.org)).toBe(0)
    const deps = await owner<{ slot_no: number }>(`select slot_no from public.departures where organization_id = $1 order by slot_no`, [w.org])
    expect(deps.map((d) => d.slot_no)).toEqual([1, 2])
  })

  it('tour riêng chưa có sức chứa thì booking thứ hai chờ xếp tay', async () => {
    const w = await makeWorld('plc5b')
    await owner(`update public.tour_options set is_private = true where id = $1`, [w.option])
    await ingest(w, 'A', '2030-08-05')
    await ingest(w, 'B', '2030-08-05')
    await rpc(user(w.ownerId), 'create_departure', w.org, w.tour, w.option, '2030-08-05', '08:00', 'Asia/Ho_Chi_Minh', 12, null)
    expect(await rpc(user(w.ownerId), 'place_waiting_bookings', w.org, false, null)).toMatchObject({ placed: 1, created: 0, skipped_private: 1 })
    expect(await waiting(w.org)).toBe(1)
  })

  it('bỏ qua booking đã hủy, chưa ghép mã và ngày đi đã qua', async () => {
    const w = await makeWorld('plc6')
    await ingest(w, 'A', '2030-08-06')
    await rpc(service, 'ingest_channel_event', w.connection, { event_id: 'A-x', type: 'booking.cancelled', external_ref: 'A', version: 2, data: {} })
    await ingest(w, 'B', '2030-08-06', { product: 'CHUA-GHEP' })
    await ingest(w, 'C', '2020-01-01')
    const r = await rpc(user(w.ownerId), 'place_waiting_bookings', w.org, false, 12)
    expect(r).toMatchObject({ placed: 0, created: 0, unmapped: 1, past: 1 })
    expect(r.rows).toEqual([])
  })

  it('cần quyền điều hành và không đụng doanh nghiệp khác', async () => {
    const w = await makeWorld('plc7')
    const other = await makeWorld('plc8')
    await ingest(w, 'A', '2030-08-07')
    await w.departure('2030-08-07', 5)
    await expect(rpc(user(w.viewer), 'place_waiting_bookings', w.org, true, null)).rejects.toThrow(/forbidden/)
    await expect(rpc(user(other.ownerId), 'place_waiting_bookings', w.org, false, null)).rejects.toThrow(/forbidden/)
    expect(await waiting(w.org)).toBe(1)
    expect(await rpc(user(other.ownerId), 'place_waiting_bookings', other.org, false, null)).toMatchObject({ placed: 0 })
    expect(await waiting(w.org)).toBe(1)
  })

  it('nhân viên booking không có quyền điều hành thì không xếp và không tạo được chuyến', async () => {
    const w = await makeWorld('plc9')
    await ingest(w, 'A', '2030-08-08')
    await expect(rpc(user(w.agent), 'place_waiting_bookings', w.org, false, 12)).rejects.toThrow(/forbidden/)
    expect(await owner(`select id from public.departures where organization_id = $1`, [w.org])).toEqual([])
  })
})

describe('sức chứa mặc định theo gói', () => {
  const capacityOf = async (dep: string) =>
    (await owner<{ capacity: number }>(`select p.capacity from public.departures d join public.inventory_pools p on p.id = d.inventory_pool_id where d.id = $1`, [dep]))[0]!.capacity
  const tripFor = async (w: Awaited<ReturnType<typeof makeWorld>>, date: string) =>
    (await owner<{ id: string }>(`select id from public.departures where organization_id = $1 and local_date = $2`, [w.org, date]))[0]!.id

  it('tạo chuyến theo sức chứa của gói, số nhập tay chỉ dùng cho gói chưa cấu hình', async () => {
    const w = await makeWorld('cap1')
    await owner(`update public.tour_options set default_capacity = 4 where id = $1`, [w.option])
    await ingest(w, 'A', '2030-10-01')
    await ingest(w, 'B', '2030-10-02', { product: 'P2' })
    const preview = await rpc(user(w.ownerId), 'place_waiting_bookings', w.org, true, null)
    expect(preview.rows.map((r: any) => r.default_capacity).sort()).toEqual([4, null])

    // Chưa nhập số: chỉ gói đã cấu hình được tạo chuyến.
    expect(await rpc(user(w.ownerId), 'place_waiting_bookings', w.org, false, null)).toMatchObject({ placed: 1, created: 1 })
    expect(await capacityOf(await tripFor(w, '2030-10-01'))).toBe(4)
    expect(await rpc(user(w.ownerId), 'place_waiting_bookings', w.org, false, 9)).toMatchObject({ placed: 1, created: 1 })
    expect(await capacityOf(await tripFor(w, '2030-10-02'))).toBe(9)
  })

  it('áp sức chứa của gói cho chuyến sắp chạy, không làm khách mất chỗ', async () => {
    const w = await makeWorld('cap2')
    const mk = (date: string, cap: number) => rpc(user(w.ownerId), 'create_departure', w.org, w.tour, w.option, date, '08:00', 'Asia/Ho_Chi_Minh', cap, null).then((r) => r.departure_id as string)
    const empty = await mk('2030-10-05', 12)
    const busy = await mk('2030-10-06', 12)
    const past = await mk('2020-10-06', 12)
    await ingest(w, 'BIG', '2030-10-06', { pax: { adult: 6 } })

    expect(await rpc(user(w.ownerId), 'apply_option_capacity', w.option)).toMatchObject({ ok: false, code: 'no_default_capacity' })
    await owner(`update public.tour_options set default_capacity = 4 where id = $1`, [w.option])
    const r = await rpc(user(w.ownerId), 'apply_option_capacity', w.option)
    expect(r).toMatchObject({ ok: true, capacity: 4, updated: 1 })
    expect(r.skipped).toEqual([expect.objectContaining({ departure_id: busy, code: 'below_committed', committed: 6 })])
    expect(await capacityOf(empty)).toBe(4)
    expect(await capacityOf(busy)).toBe(12)
    expect(await capacityOf(past)).toBe(12)
    expect((await seats(busy)).committed).toBe(6)

    await expect(rpc(user(w.agent), 'apply_option_capacity', w.option)).rejects.toThrow(/forbidden/)
  })
})

describe('nhiều chuyến cùng giờ', () => {
  const trips = async (w: Awaited<ReturnType<typeof makeWorld>>, date: string) => owner<{ id: string; slot_no: number; capacity: number; seats: number }>(
    `select d.id, d.slot_no, p.capacity, (select coalesce(sum(i.committed_seats), 0)::int from public.booking_items i where i.departure_id = d.id) seats
     from public.departures d join public.inventory_pools p on p.id = d.inventory_pool_id
     where d.organization_id = $1 and d.local_date = $2 order by d.slot_no`, [w.org, date])

  it('hết chỗ thì mở chuyến tiếp theo, đoàn lớn đi trọn một chuyến', async () => {
    const w = await makeWorld('slot1')
    await owner(`update public.tour_options set default_capacity = 6 where id = $1`, [w.option])
    await ingest(w, 'A', '2030-11-01', { pax: { adult: 4 } })
    await ingest(w, 'B', '2030-11-01', { pax: { adult: 2 } })
    await ingest(w, 'C', '2030-11-01', { pax: { adult: 3 } })
    await ingest(w, 'D', '2030-11-01', { pax: { adult: 8 } })
    const r = await rpc(user(w.ownerId), 'place_waiting_bookings', w.org, false, null)
    expect(r).toMatchObject({ placed: 4, no_seats: 0 })
    expect((await trips(w, '2030-11-01')).map((t) => [t.slot_no, t.capacity, t.seats])).toEqual([[1, 6, 6], [2, 6, 3], [3, 8, 8]])
    expect(await waiting(w.org)).toBe(0)
  })

  it('booking mới tự vào chuyến cùng giờ còn chỗ', async () => {
    const w = await makeWorld('slot2')
    await owner(`update public.tour_options set default_capacity = 2 where id = $1`, [w.option])
    await ingest(w, 'A', '2030-11-02')
    await ingest(w, 'B', '2030-11-02')
    await rpc(user(w.ownerId), 'place_waiting_bookings', w.org, false, null)
    const [one, two] = await trips(w, '2030-11-02')
    await owner(`update public.inventory_pools set capacity = 4 where id = (select inventory_pool_id from public.departures where id = $1)`, [two!.id])
    await ingest(w, 'C', '2030-11-02')
    const after = await trips(w, '2030-11-02')
    expect(after.find((t) => t.id === one!.id)!.seats).toBe(2)
    expect(after.find((t) => t.id === two!.id)!.seats).toBe(4)
  })

  it('tách chuyến quá sức chứa, không tách đoàn, không cần sửa trên kênh', async () => {
    const w = await makeWorld('slot3')
    const dep = (await rpc(user(w.ownerId), 'create_departure', w.org, w.tour, w.option, '2030-11-03', '08:00', 'Asia/Ho_Chi_Minh', 30, null)).departure_id as string
    for (const [ref, n] of [['A', 13], ['B', 5], ['C', 3], ['D', 3]] as const) await ingest(w, ref, '2030-11-03', { pax: { adult: n } })
    expect(await rpc(user(w.ownerId), 'split_departure', dep)).toMatchObject({ ok: false, code: 'no_default_capacity' })
    await owner(`update public.tour_options set default_capacity = 6 where id = $1`, [w.option])
    const r = await rpc(user(w.ownerId), 'split_departure', dep)
    expect(r).toMatchObject({ ok: true, moved: 3, created: 2, failed: 0, kept: 13 })
    expect(r.oversized).toEqual([expect.objectContaining({ seats: 13 })])
    expect((await trips(w, '2030-11-03')).map((t) => [t.capacity, t.seats])).toEqual([[13, 13], [6, 5], [6, 6]])
    const changes = await owner<{ channel_request_status: string }>(
      `select c.channel_request_status from public.booking_changes c join public.bookings b on b.id = c.booking_id where b.organization_id = $1 and c.change_type = 'moved'`, [w.org])
    expect(changes).toHaveLength(3)
    expect(new Set(changes.map((c) => c.channel_request_status))).toEqual(new Set(['not_applicable']))
    // Chạy lại không đổi gì thêm.
    expect(await rpc(user(w.ownerId), 'split_departure', dep)).toMatchObject({ moved: 0, created: 0 })
    await expect(rpc(user(w.agent), 'split_departure', dep)).rejects.toThrow(/forbidden/)
  })

  it('đổi sang ngày khác vẫn báo phải sửa trên kênh', async () => {
    const w = await makeWorld('slot4')
    await w.departure('2030-11-04', 5)
    const other = await w.departure('2030-11-05', 5)
    const a = await ingest(w, 'A', '2030-11-04')
    const [item] = await owner<{ id: string }>(`select id from public.booking_items where booking_id = $1`, [a.booking_id])
    expect(await rpc(user(w.operator), 'move_booking_item', item!.id, other)).toMatchObject({ ok: true, channel_request_status: 'manual_required' })
  })
})
