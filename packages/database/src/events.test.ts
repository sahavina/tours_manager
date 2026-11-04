// Sự kiện sai thứ tự, retry, ghép mã, ghi chú nội bộ, mock không giả làm thật.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { as, bookingEvent, closePool, makeWorld, owner, rpc, seats, service, user, type World } from './test/harness'

let w: World

beforeAll(async () => {
  w = await makeWorld('evt')
})
afterAll(closePool)

const bookingOf = async (ref: string) => {
  const [b] = await owner<any>(`select * from public.bookings where organization_id = $1 and external_ref = $2`, [w.org, ref])
  return b
}

describe('sai thứ tự', () => {
  it('sự kiện phiên bản cũ không ghi đè dữ liệu mới', async () => {
    const dep = await w.departure('2030-01-01')
    await rpc(service, 'ingest_channel_event', w.connection,
      bookingEvent('ORD-1', '2030-01-01', { version: 5, pax: { adult: 4 }, data: { lead: { name: 'Mới' } } }))
    const stale = await rpc(service, 'ingest_channel_event', w.connection,
      bookingEvent('ORD-1', '2030-01-01', { version: 3, pax: { adult: 1 }, data: { lead: { name: 'Cũ' } } }))
    expect(stale.code).toBe('stale_ignored')
    expect((await bookingOf('ORD-1')).lead_name).toBe('Mới')
    expect((await seats(dep)).committed).toBe(4)
  })

  it('không có phiên bản thì so theo thời điểm nguồn', async () => {
    await w.departure('2030-01-02')
    const data = { version: undefined }
    await rpc(service, 'ingest_channel_event', w.connection, {
      ...bookingEvent('ORD-2', '2030-01-02', { eventId: 'n', data: { lead: { name: 'Mới' } } }), ...data, source_at: '2030-01-01T10:00:00Z' })
    const stale = await rpc(service, 'ingest_channel_event', w.connection, {
      ...bookingEvent('ORD-2', '2030-01-02', { eventId: 'o', data: { lead: { name: 'Cũ' } } }), ...data, source_at: '2030-01-01T09:00:00Z' })
    expect(stale.code).toBe('stale_ignored')
    expect((await bookingOf('ORD-2')).lead_name).toBe('Mới')
  })

  it('nguồn không cho thứ tự thì vẫn áp dụng và ghi rõ chưa kiểm chứng', async () => {
    await w.departure('2030-01-03')
    const res = await rpc(service, 'ingest_channel_event', w.connection, {
      ...bookingEvent('ORD-3', '2030-01-03', { eventId: 'x' }), version: undefined, source_at: undefined })
    const [e] = await owner<any>(`select ordering_verified from public.integration_events where id = $1`, [res.event_id])
    expect(e.ordering_verified).toBe(false)
  })

  it('sự kiện cập nhật cũ đến sau khi đã hủy không làm booking sống lại', async () => {
    const dep = await w.departure('2030-01-04')
    await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('ORD-4', '2030-01-04', { version: 1 }))
    await rpc(service, 'ingest_channel_event', w.connection, { event_id: 'ORD-4-c', type: 'booking.cancelled', external_ref: 'ORD-4', version: 3, data: {} })
    await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('ORD-4', '2030-01-04', { version: 2, type: 'booking.updated' }))
    expect((await bookingOf('ORD-4')).status).toBe('cancelled')
    expect((await seats(dep)).committed).toBe(0)
  })

  it('hủy đến trước tạo: chờ retry rồi áp dụng đúng', async () => {
    const dep = await w.departure('2030-01-05')
    const early = await rpc(service, 'ingest_channel_event', w.connection, {
      event_id: 'ORD-5-c', type: 'booking.cancelled', external_ref: 'ORD-5', version: 2, data: {} })
    expect(early).toMatchObject({ ok: false, retryable: true })
    const [ev] = await owner<any>(`select status, next_attempt_at, attempts from public.integration_events where id = (
      select id from public.integration_events where event_key = 'ORD-5-c' and organization_id = $1)`, [w.org])
    expect(ev.status).toBe('failed')
    expect(ev.next_attempt_at).not.toBeNull()

    await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('ORD-5', '2030-01-05', { version: 1 }))
    expect((await seats(dep)).committed).toBe(2)

    await owner(`update public.integration_events set next_attempt_at = now() - interval '1 second' where event_key = 'ORD-5-c' and organization_id = $1`, [w.org])
    await rpc(service, 'worker_retry_events')
    expect((await bookingOf('ORD-5')).status).toBe('cancelled')
    expect((await seats(dep)).committed).toBe(0)
  })

  it('payload sai vào hàng lỗi cần xử lý tay, không retry vô ích', async () => {
    const res = await rpc(service, 'ingest_channel_event', w.connection, {
      event_id: 'BAD-1', type: 'booking.created', external_ref: 'BAD-1', data: { external_ref: 'BAD-1', items: [] } })
    expect(res).toMatchObject({ ok: false, retryable: false })
    const [e] = await owner<any>(`select status, next_attempt_at from public.integration_events where id in (
      select id from public.integration_events where event_key = 'BAD-1' and organization_id = $1)`, [w.org])
    expect(e).toMatchObject({ status: 'dead', next_attempt_at: null })
  })

  it('payload lưu đã che thông tin nhạy cảm', async () => {
    await w.departure('2030-01-06')
    const ev = bookingEvent('SAFE-1', '2030-01-06', { data: { api_key: 'abc', nested: { card_number: '4111', ok: 'giữ' } } })
    const res = await rpc(service, 'ingest_channel_event', w.connection, ev)
    const [e] = await owner<any>(`select payload from public.integration_events where id = $1`, [res.event_id])
    expect(e.payload.api_key).toBe('[đã che]')
    expect(e.payload.nested.card_number).toBe('[đã che]')
    expect(e.payload.nested.ok).toBe('giữ')
  })
})

describe('ghép mã', () => {
  it('booking chưa ghép mã vẫn được lưu và cảnh báo, ghép xong thì tự xếp chuyến', async () => {
    const dep = await w.departure('2030-02-01')
    const res = await rpc(service, 'ingest_channel_event', w.connection,
      bookingEvent('MAP-1', '2030-02-01', { product: 'UNKNOWN-X' }))
    expect(res).toMatchObject({ ok: true, queued: true })
    const b = await bookingOf('MAP-1')
    expect(b).toMatchObject({ ops_status: 'needs_mapping', needs_action: true })
    expect((await seats(dep)).committed).toBe(0)

    // Có dòng chờ ghép, chưa kiểm tra thì chưa áp dụng.
    const [m] = await owner<any>(`select * from public.channel_product_mappings where connection_id = $1 and external_product_code = 'UNKNOWN-X'`, [w.connection])
    expect(m.is_verified).toBe(false)

    const saved = await rpc(user(w.ownerId), 'mapping_save', m.id, w.org, w.connection, 'UNKNOWN-X', '', w.option, null, null, null, true)
    expect(saved.placed).toBe(1)
    expect((await seats(dep)).committed).toBe(2)
    expect((await bookingOf('MAP-1')).needs_action).toBe(false)
  })

  it('không ghép mã theo tên: chỉ khớp đúng mã đã kiểm tra', async () => {
    await w.departure('2030-02-02')
    await owner(`insert into public.channel_product_mappings (organization_id, connection_id, external_product_code, tour_option_id, is_verified)
      values ($1, $2, 'NOTOK', $3, false)`, [w.org, w.connection, w.option])
    const res = await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('MAP-2', '2030-02-02', { product: 'NOTOK' }))
    expect(res.queued).toBe(true)
  })

  it('xác nhận ánh xạ bắt buộc có đích', async () => {
    const res = await rpc(user(w.ownerId), 'mapping_save', null, w.org, w.connection, 'NOTARGET', '', null, null, null, null, true)
    expect(res).toMatchObject({ ok: false, code: 'verified_needs_target' })
  })
})

describe('dữ liệu nội bộ', () => {
  it('đồng bộ không ghi đè ghi chú nội bộ và cột điều hành của điểm đón', async () => {
    await w.departure('2030-03-01')
    const r = await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('NOTE-1', '2030-03-01', { version: 1, product: 'P2',
      data: { items: [{ product_code: 'P2', local_date: '2030-03-01', local_time: '08:00', pax: { adult: 2 }, pickup: { hotel: 'KS A', address: 'Đ/c A' } }] } }))
    const [item] = await owner<any>(`select id from public.booking_items where booking_id = $1`, [r.booking_id])
    await rpc(user(w.agent), 'add_booking_note', r.booking_id, 'Khách dị ứng tôm')
    await rpc(user(w.operator), 'set_pickup', item.id, { pickup_local_time: '07:15', sort_order: 3, ops_note: 'Gọi trước 10 phút' })

    await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('NOTE-1', '2030-03-01', { version: 2, type: 'booking.updated', product: 'P2',
      data: { items: [{ product_code: 'P2', local_date: '2030-03-01', local_time: '08:00', pax: { adult: 2 }, pickup: { hotel: 'KS B' } }] } }))

    const notes = await owner<any>(`select body from public.booking_notes where booking_id = $1`, [r.booking_id])
    expect(notes.map((n) => n.body)).toEqual(['Khách dị ứng tôm'])
    const [p] = await owner<any>(`select * from public.booking_pickups where booking_item_id = $1`, [item.id])
    expect(p.hotel_name).toBe('KS B')
    expect(p.address).toBe('Đ/c A')
    expect(p.pickup_local_time).toBe('07:15:00')
    expect(p.sort_order).toBe(3)
    expect(p.ops_note).toBe('Gọi trước 10 phút')
  })

  it('đổi số khách sau phân công gắn cờ cho điều hành', async () => {
    const dep = await w.departure('2030-03-02')
    await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('FLAG-1', '2030-03-02', { version: 1 }))
    await rpc(user(w.operator), 'assign_guide', dep, w.guideId, 'lead')
    await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('FLAG-1', '2030-03-02', { version: 2, type: 'booking.updated', pax: { adult: 3 } }))
    const b = await bookingOf('FLAG-1')
    expect(b.changed_after_assignment).toBe(true)
    expect((await seats(dep)).committed).toBe(3)
  })
})

describe('mock không giả làm thật', () => {
  it('kết nối mock không thể mang trạng thái đã kết nối hoặc có mốc liên lạc thành công', async () => {
    await expect(owner(`update public.channel_connections set status = 'connected' where id = $1`, [w.connection])).rejects.toThrow(/mock_is_never_connected|connected_needs_credentials/)
    await expect(owner(`update public.channel_connections set last_success_at = now() where id = $1`, [w.connection])).rejects.toThrow(/mock_is_never_connected/)
  })

  it('xử lý sự kiện mock không ghi mốc liên lạc thật và booking mang nhãn mô phỏng', async () => {
    await w.departure('2030-04-01')
    await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('MOCK-1', '2030-04-01'))
    const [c] = await owner<any>(`select status, last_success_at, last_simulated_at from public.channel_connections where id = $1`, [w.connection])
    expect(c.status).toBe('simulated')
    expect(c.last_success_at).toBeNull()
    expect(c.last_simulated_at).not.toBeNull()
    expect((await bookingOf('MOCK-1')).sync_status).toBe('simulated')
  })

  it('không chuyển production nếu chưa được phê duyệt, và không có đường nào từ giao diện báo đã kết nối', async () => {
    const res = await rpc(user(w.ownerId), 'connection_update', w.connection, { mode: 'production' })
    expect(res).toMatchObject({ ok: false, code: 'production_needs_approval' })

    const [c2] = await owner<any>(`insert into public.channel_connections (organization_id, channel, account_name) values ($1, 'getyourguide', 'Thật') returning id`, [w.org])
    const up = await rpc(user(w.ownerId), 'connection_update', c2.id, { mode: 'sandbox', status: 'connected', last_success_at: '2030-01-01' })
    expect(up.ok).toBe(true)
    const [row] = await owner<any>(`select status, last_success_at from public.channel_connections where id = $1`, [c2.id])
    expect(row.status).toBe('not_configured')
    expect(row.last_success_at).toBeNull()
    await expect(as(user(w.ownerId), `select public.connection_mark_health($1, true)`, [c2.id])).rejects.toThrow(/permission denied/)
  })

  it('kết nối thật không nhận sự kiện từ người dùng, chỉ từ service_role', async () => {
    const [c] = await owner<any>(`insert into public.channel_connections (organization_id, channel, account_name, mode, status)
      values ($1, 'viator', 'Sandbox', 'sandbox', 'not_configured') returning id`, [w.org])
    await expect(rpc(user(w.ownerId), 'ingest_channel_event', c.id, bookingEvent('X', '2030-01-01'))).rejects.toThrow(/forbidden/)
    await expect(rpc(user(w.ownerId), 'channel_reserve', c.id, null, 1, 'x', null)).rejects.toThrow(/forbidden/)
  })
})
