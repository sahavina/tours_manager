// Tồn chỗ và đồng bộ: các tình huống ở đặc tả §14. Mọi bài đọc số chỗ thật sau khi commit.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bookingEvent, closePool, makeWorld, owner, rpc, seats, service, user, type World } from './test/harness'

let w: World

beforeAll(async () => {
  w = await makeWorld('inv')
})
afterAll(closePool)

describe('chống trùng', () => {
  it('nhận cùng sự kiện hai lần chỉ tạo một booking và trừ chỗ một lần', async () => {
    const dep = await w.departure('2030-02-01')
    const ev = bookingEvent('DUP-1', '2030-02-01')
    const first = await rpc(service, 'ingest_channel_event', w.connection, ev)
    const second = await rpc(service, 'ingest_channel_event', w.connection, ev)
    expect(first.ok).toBe(true)
    expect(second.duplicate).toBe(true)
    expect(second.result.booking_id).toBe(first.booking_id)

    const rows = await owner(`select id from public.bookings where organization_id = $1 and external_ref = 'DUP-1'`, [w.org])
    expect(rows).toHaveLength(1)
    expect((await seats(dep)).committed).toBe(2)
  })

  it('cùng mã booking với sự kiện KHÁC mã vẫn chỉ một booking, không cộng chỗ', async () => {
    const dep = await w.departure('2030-02-02')
    await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('DUP-2', '2030-02-02', { eventId: 'a', version: 1 }))
    await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('DUP-2', '2030-02-02', { eventId: 'b', version: 2 }))
    expect((await seats(dep)).committed).toBe(2)
  })

  it('hai yêu cầu đồng thời cùng một booking mới không tạo hai dòng', async () => {
    const dep = await w.departure('2030-02-03')
    const ev = bookingEvent('DUP-3', '2030-02-03')
    await Promise.all(Array.from({ length: 5 }, () => rpc(service, 'ingest_channel_event', w.connection, ev)))
    const rows = await owner(`select id from public.bookings where organization_id = $1 and external_ref = 'DUP-3'`, [w.org])
    expect(rows).toHaveLength(1)
    expect((await seats(dep)).committed).toBe(2)
  })
})

describe('hủy', () => {
  it('hủy lặp chỉ trả chỗ một lần', async () => {
    const dep = await w.departure('2030-03-01')
    // Một booking khác ở cùng chuyến: nếu hủy trả chỗ hai lần thì số này sẽ sai.
    await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('STAY', '2030-03-01'))
    await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('CXL-1', '2030-03-01', { pax: { adult: 3 } }))
    expect((await seats(dep)).committed).toBe(5)

    const cancel = (id: string, version: number) =>
      rpc(service, 'ingest_channel_event', w.connection, {
        event_id: id, type: 'booking.cancelled', external_ref: 'CXL-1', version, data: { external_ref: 'CXL-1' },
      })
    await cancel('c1', 2)
    await cancel('c1', 2)
    await cancel('c2', 3)
    expect((await seats(dep)).committed).toBe(2)

    const [b] = await owner<{ id: string; status: string }>(
      `select id, status from public.bookings where organization_id = $1 and external_ref = 'CXL-1'`, [w.org])
    expect(b!.status).toBe('cancelled')
    await rpc(user(w.agent), 'cancel_booking_internal', b!.id, 'lần nữa')
    expect((await seats(dep)).committed).toBe(2)
  })
})

describe('giữ chỗ', () => {
  it('xác nhận từ hold không trừ chỗ hai lần', async () => {
    const dep = await w.departure('2030-04-01', 5)
    const hold = await rpc(service, 'channel_reserve', w.connection, dep, 3, 'H-1', null)
    expect(hold.ok).toBe(true)
    expect(await seats(dep)).toMatchObject({ committed: 0, held: 3, available: 2 })

    const data = bookingEvent('HB-1', '2030-04-01', { pax: { adult: 3 } }).data
    const booked = await rpc(service, 'channel_book', w.connection, 'H-1', data)
    expect(booked.ok).toBe(true)
    expect(await seats(dep)).toMatchObject({ committed: 3, held: 0, available: 2 })

    // Kênh gửi lại sau timeout: nhận đúng booking cũ, số chỗ không đổi.
    const again = await rpc(service, 'channel_book', w.connection, 'H-1', data)
    expect(again.duplicate).toBe(true)
    expect(again.booking_id).toBe(booked.booking_id)
    expect((await seats(dep)).committed).toBe(3)
  })

  it('giữ lại cùng mã tham chiếu không giữ thêm chỗ', async () => {
    const dep = await w.departure('2030-04-02', 5)
    await rpc(service, 'channel_reserve', w.connection, dep, 2, 'H-2', null)
    const again = await rpc(service, 'channel_reserve', w.connection, dep, 2, 'H-2', null)
    expect(again.code).toBe('existing')
    expect((await seats(dep)).held).toBe(2)
  })

  it('hold hết hạn được giải phóng, kể cả khi worker chưa chạy', async () => {
    const dep = await w.departure('2030-04-03', 2)
    await rpc(service, 'channel_reserve', w.connection, dep, 2, 'H-3', 1)
    expect((await seats(dep)).available).toBe(0)
    await owner(`update public.inventory_holds set expires_at = now() - interval '1 second' where reference = 'H-3' and organization_id = $1`, [w.org])
    expect((await seats(dep)).available).toBe(2)

    const data = bookingEvent('HB-3', '2030-04-03').data
    const late = await rpc(service, 'channel_book', w.connection, 'H-3', data)
    expect(late).toMatchObject({ ok: false, code: 'hold_expired' })

    const expired = await rpc(service, 'worker_expire_holds')
    expect(expired).toBeGreaterThanOrEqual(1)
    const [h] = await owner<{ status: string }>(`select status from public.inventory_holds where reference = 'H-3' and organization_id = $1`, [w.org])
    expect(h!.status).toBe('expired')
  })

  it('hủy giữ chỗ lặp lại an toàn và không làm hỏng hold đã thành booking', async () => {
    const dep = await w.departure('2030-04-04', 4)
    await rpc(service, 'channel_reserve', w.connection, dep, 2, 'H-4', null)
    expect((await rpc(service, 'channel_cancel_reservation', w.connection, 'H-4')).ok).toBe(true)
    expect((await rpc(service, 'channel_cancel_reservation', w.connection, 'H-4')).ok).toBe(true)
    expect((await seats(dep)).available).toBe(4)

    await rpc(service, 'channel_reserve', w.connection, dep, 2, 'H-5', null)
    await rpc(service, 'channel_book', w.connection, 'H-5', bookingEvent('HB-5', '2030-04-04').data)
    const res = await rpc(service, 'channel_cancel_reservation', w.connection, 'H-5')
    expect(res).toMatchObject({ ok: false, code: 'already_booked' })
    expect((await seats(dep)).committed).toBe(2)
  })

  it('thời hạn giữ chỗ lấy theo từng kết nối, không phải một giá trị chung', async () => {
    const dep = await w.departure('2030-04-05', 4)
    await owner(`update public.channel_connections set hold_ttl_seconds = 3600 where id = $1`, [w.connection])
    const res = await rpc(service, 'channel_reserve', w.connection, dep, 1, 'H-6', null)
    const minutes = (new Date(res.expires_at).getTime() - Date.now()) / 60000
    expect(minutes).toBeGreaterThan(55)
    await owner(`update public.channel_connections set hold_ttl_seconds = 900 where id = $1`, [w.connection])
  })

  it('không giữ chỗ khi chuyến đã đóng bán', async () => {
    const dep = await w.departure('2030-04-06', 4)
    await rpc(user(w.operator), 'set_departure_sale', dep, false)
    const res = await rpc(service, 'channel_reserve', w.connection, dep, 1, 'H-7', null)
    expect(res).toMatchObject({ ok: false, code: 'not_on_sale' })
  })
})

describe('tranh chấp đồng thời', () => {
  it('nhiều yêu cầu giữ chỗ cạnh tranh không làm tổng cam kết vượt sức chứa', async () => {
    const dep = await w.departure('2030-05-01', 3)
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => rpc(service, 'channel_reserve', w.connection, dep, 1, `R-${i}`, null)),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(3)
    expect(results.filter((r) => r.code === 'no_seats')).toHaveLength(9)
    expect(await seats(dep)).toMatchObject({ held: 3, available: 0 })
  })

  it('hai booking thủ công tranh chỗ cuối: một thành công, một bị từ chối, không để lại dữ liệu mồ côi', async () => {
    const dep = await w.departure('2030-05-02', 1)
    const payload = (name: string) => ({ departure_id: dep, lead: { name }, pax: { adult: 1 } })
    const [a, b] = await Promise.all([
      rpc(user(w.agent), 'create_manual_booking', w.org, payload('Tranh A')),
      rpc(user(w.agent), 'create_manual_booking', w.org, payload('Tranh B')),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect([a.code, b.code]).toContain('no_seats')
    const rows = await owner(`select id from public.bookings where organization_id = $1 and lead_name like 'Tranh %'`, [w.org])
    expect(rows).toHaveLength(1)
    expect((await seats(dep)).committed).toBe(1)
  })

  it('booking từ kênh không có chỗ vẫn được lưu vào hàng chờ, không vượt sức chứa', async () => {
    const dep = await w.departure('2030-05-03', 2)
    await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('FULL-1', '2030-05-03'))
    const res = await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('FULL-2', '2030-05-03'))
    expect(res).toMatchObject({ ok: true, queued: true })
    expect((await seats(dep)).committed).toBe(2)
    const [b] = await owner<{ ops_status: string; needs_action: boolean }>(
      `select ops_status, needs_action from public.bookings where organization_id = $1 and external_ref = 'FULL-2'`, [w.org])
    expect(b).toMatchObject({ ops_status: 'needs_departure', needs_action: true })
  })
})

describe('đổi chuyến', () => {
  it('kiểm tra chỗ đích và giải phóng chỗ nguồn nguyên tử', async () => {
    const from = await w.departure('2030-06-01', 5)
    const to = await w.departure('2030-06-02', 2)
    const r = await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('MV-1', '2030-06-01', { pax: { adult: 2 } }))
    const [item] = await owner<{ id: string }>(`select id from public.booking_items where booking_id = $1`, [r.booking_id])

    const ok = await rpc(user(w.operator), 'move_booking_item', item!.id, to)
    expect(ok.ok).toBe(true)
    // Booking từ kênh: đổi nội bộ phải báo cần xử lý tay trên kênh, không được coi là đã cập nhật.
    expect(ok.channel_request_status).toBe('manual_required')
    expect((await seats(from)).committed).toBe(0)
    expect((await seats(to)).committed).toBe(2)
  })

  it('chuyến đích hết chỗ thì giữ nguyên chỗ nguồn', async () => {
    const from = await w.departure('2030-06-03', 5)
    const to = await w.departure('2030-06-04', 1)
    const r = await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('MV-2', '2030-06-03'))
    const [item] = await owner<{ id: string }>(`select id from public.booking_items where booking_id = $1`, [r.booking_id])
    const res = await rpc(user(w.operator), 'move_booking_item', item!.id, to)
    expect(res).toMatchObject({ ok: false, code: 'no_seats' })
    expect((await seats(from)).committed).toBe(2)
    expect((await seats(to)).committed).toBe(0)
  })
})

describe('sức chứa', () => {
  it('không giảm dưới lượng đã cam kết', async () => {
    const dep = await w.departure('2030-07-01', 5)
    await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('CAP-1', '2030-07-01', { pax: { adult: 3 } }))
    await rpc(service, 'channel_reserve', w.connection, dep, 1, 'CAP-H', null)
    const [{ pool }] = (await owner<{ pool: string }>(`select inventory_pool_id pool from public.departures where id = $1`, [dep])) as [{ pool: string }]
    const low = await rpc(user(w.operator), 'update_pool_capacity', pool, 3, 0)
    expect(low).toMatchObject({ ok: false, code: 'below_committed', committed: 3, held: 1 })
    const fine = await rpc(user(w.operator), 'update_pool_capacity', pool, 4, 0)
    expect(fine.ok).toBe(true)
  })

  it('hai chuyến dùng chung nguồn chỗ thì cùng hết chỗ', async () => {
    const a = await w.departure('2030-07-02', 3)
    const [{ pool }] = (await owner<{ pool: string }>(`select inventory_pool_id pool from public.departures where id = $1`, [a])) as [{ pool: string }]
    const res = await rpc(user(w.ownerId), 'create_departure', w.org, w.tour, w.transferOption, '2030-07-02', '08:00', 'Asia/Ho_Chi_Minh', null, pool)
    expect(res.ok).toBe(true)
    await rpc(service, 'channel_reserve', w.connection, a, 3, 'SH-1', null)
    const other = await rpc(service, 'channel_reserve', w.connection, res.departure_id, 1, 'SH-2', null)
    expect(other).toMatchObject({ ok: false, code: 'no_seats' })
  })

  it('em bé không chiếm chỗ theo cấu hình, loại khách lạ vẫn chiếm chỗ', async () => {
    const dep = await w.departure('2030-07-03', 10)
    await rpc(service, 'ingest_channel_event', w.connection,
      bookingEvent('SEAT-1', '2030-07-03', { pax: { adult: 2, infant: 1, martian: 1 } }))
    expect((await seats(dep)).committed).toBe(3)
  })

  it('tạo chuyến lặp có xem trước và không tạo trùng', async () => {
    const args = [w.org, w.tour, w.option, '2031-01-05', '2031-01-12', [1, 3], ['07:00', '13:00'], 'Asia/Ho_Chi_Minh', 8]
    const preview = await rpc(user(w.operator), 'generate_departures', ...args, true)
    expect(preview.created).toBe(4) // 2031-01-06 (T2), 01-08 (T4), 2 giờ mỗi ngày; 01-12 là CN
    const [{ n: before }] = (await owner<{ n: string }>(`select count(*) n from public.departures where organization_id = $1`, [w.org])) as [{ n: string }]

    const first = await rpc(user(w.operator), 'generate_departures', ...args, false)
    expect(first).toMatchObject({ created: 4, skipped: 0 })
    const second = await rpc(user(w.operator), 'generate_departures', ...args, false)
    expect(second).toMatchObject({ created: 0, skipped: 4 })
    const [{ n: after }] = (await owner<{ n: string }>(`select count(*) n from public.departures where organization_id = $1`, [w.org])) as [{ n: string }]
    expect(Number(after) - Number(before)).toBe(4)
  })

  it('giờ khởi hành được tính từ giờ địa phương theo đúng múi giờ của chuyến', async () => {
    const res = await rpc(user(w.ownerId), 'create_departure', w.org, w.tour, w.option, '2031-02-01', '09:00', 'Asia/Tokyo', 5, null)
    const [d] = await owner<{ iso: string }>(`select to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') iso from public.departures where id = $1`, [res.departure_id])
    expect(d!.iso).toBe('2031-02-01 00:00')
  })
})
