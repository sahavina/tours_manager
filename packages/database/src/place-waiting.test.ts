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

  it('không tự gộp booking vào tour riêng', async () => {
    const w = await makeWorld('plc5')
    await owner(`update public.tour_options set is_private = true where id = $1`, [w.option])
    await ingest(w, 'A', '2030-08-05')
    await ingest(w, 'B', '2030-08-05')
    const r = await rpc(user(w.ownerId), 'place_waiting_bookings', w.org, false, 12)
    expect(r).toMatchObject({ placed: 1, created: 1, skipped_private: 1 })
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
