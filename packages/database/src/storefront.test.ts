// Trang đặt tour cho khách: người chưa đăng nhập chỉ dùng được bốn hàm public_*.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anon, as, closePool, makeWorld, owner, rpc, seats, user, type World } from './test/harness'

let w: World
let slug: string
const contact = (email = 'khach@example.com') => JSON.stringify({ name: 'Jane Doe', email, phone: '+44 7700 900000' })
const request = (date: string, pax: object, email?: string, time = '08:00') =>
  rpc(anon, 'public_booking_request', slug, 'O1', date, time, JSON.stringify(pax), contact(email), 'Hotel A', 'Vegetarian')

beforeAll(async () => {
  w = await makeWorld('store')
  ;[{ slug }] = await owner<{ slug: string }>(`select slug from public.organizations where id = $1`, [w.org])
  await owner(`update public.tours set is_published = true, description = 'Mô tả tour' where id = $1`, [w.tour])
  await owner(`update public.tour_options set public_name = 'Shared tour', price_adult = 40, price_child = 25 where id = $1`, [w.option])
})
afterAll(closePool)

describe('đọc công khai', () => {
  it('chỉ thấy tour đã công khai; doanh nghiệp không có tour công khai là not_found', async () => {
    const s = await rpc(anon, 'public_storefront', slug)
    expect(s.ok).toBe(true)
    expect(s.tours).toEqual([expect.objectContaining({ code: 'T1', price_from: 40, currency: 'USD' })])
    const other = await makeWorld('store2')
    const [{ slug: s2 }] = await owner<{ slug: string }>(`select slug from public.organizations where id = $1`, [other.org])
    expect((await rpc(anon, 'public_storefront', s2)).code).toBe('not_found')
  })

  it('chi tiết tour dùng tên công khai của gói; gói ẩn không hiện', async () => {
    await owner(`update public.tour_options set is_published = false where id = $1`, [w.transferOption])
    const t = await rpc(anon, 'public_tour', slug, 'T1')
    expect(t.options.map((o: any) => o.name)).toEqual(['Shared tour'])
    expect(t.categories.map((c: any) => c.code)).toEqual(['adult', 'child', 'infant'])
    expect((await rpc(anon, 'public_tour', slug, 'KHONG')).code).toBe('not_found')
  })

  it('lịch còn chỗ lấy chuyến trống nhất ở mỗi giờ; giới hạn 62 ngày', async () => {
    await w.departure('2027-01-10', 6)
    await owner(`select public._create_slot($1, $2, null, '2027-01-10', '08:00', 'Asia/Ho_Chi_Minh', 4)`, [w.org, w.tour])
    const a = await rpc(anon, 'public_availability', slug, 'O1', '2027-01-10', '2027-01-10')
    expect(a.slots).toEqual([{ date: '2027-01-10', time: '08:00', available: 6 }])
    expect((await rpc(anon, 'public_availability', slug, 'O1', '2027-01-01', '2027-04-01')).code).toBe('invalid_range')
  })

  it('người chưa đăng nhập không đọc thẳng bảng nào', async () => {
    for (const t of ['tours', 'tour_options', 'bookings', 'customers', 'departures', 'organizations']) {
      await expect(as(anon, `select 1 from public.${t} limit 1`)).rejects.toThrow(/permission denied/)
    }
  })
})

describe('yêu cầu đặt', () => {
  it('tạo booking chờ xác nhận, giữ chỗ, tính tiền theo giá, ghi nguồn Website', async () => {
    const dep = await w.departure('2027-02-01', 6)
    const r = await request('2027-02-01', { adult: 2, child: 1, infant: 1 })
    expect(r).toMatchObject({ ok: true, date: '2027-02-01', time: '08:00', amount: 105, currency: 'USD' })
    expect(r.booking_code).toMatch(/^SH-/)
    expect((await seats(dep)).committed).toBe(3)
    const [b] = await owner<any>(
      `select b.status::text, b.lead_name, b.lead_email, b.needs_action, b.special_requests, c.account_name, i.pax, p.hotel_name
       from public.bookings b join public.channel_connections c on c.id = b.connection_id
       join public.booking_items i on i.booking_id = b.id left join public.booking_pickups p on p.booking_item_id = i.id
       where b.code = $1 and b.organization_id = $2`, [r.booking_code, w.org])
    expect(b).toEqual({ status: 'pending', lead_name: 'Jane Doe', lead_email: 'khach@example.com', needs_action: true,
      special_requests: 'Vegetarian', account_name: 'Website', pax: { adult: 2, child: 1, infant: 1 }, hotel_name: 'Hotel A' })
  })

  it('không tách nhóm: chuyến 1 còn 2, chuyến 2 còn 4, nhóm 3 vào chuyến 2; nhóm 5 hết chỗ', async () => {
    const d1 = await w.departure('2027-02-02', 6)
    const [{ id: d2 }] = await owner<{ id: string }>(`select public._create_slot($1, $2, null, '2027-02-02', '08:00', 'Asia/Ho_Chi_Minh', 4) as id`, [w.org, w.tour])
    await request('2027-02-02', { adult: 4 }, 'a@example.com')
    expect((await seats(d1)).committed).toBe(4)
    expect((await request('2027-02-02', { adult: 3 }, 'b@example.com')).ok).toBe(true)
    expect((await seats(d2)).committed).toBe(3)
    expect((await request('2027-02-02', { adult: 5 }, 'c@example.com')).code).toBe('no_availability')
  })

  it('từ chối dữ liệu sai', async () => {
    await w.departure('2027-02-03', 6)
    const bad = (pax: object, c: object, date = '2027-02-03') =>
      rpc(anon, 'public_booking_request', slug, 'O1', date, '08:00', JSON.stringify(pax), JSON.stringify(c), null, null)
    const ok = { name: 'Jane Doe', email: 'x@example.com' }
    expect((await bad({ adult: 2 }, { ...ok, email: 'khong-phai-email' })).code).toBe('invalid_email')
    expect((await bad({ adult: 2 }, { ...ok, name: 'J' })).code).toBe('invalid_name')
    expect((await bad({ adult: 0 }, ok)).code).toBe('invalid_pax')
    expect((await bad({ infant: 2 }, ok)).code).toBe('invalid_pax')
    expect((await bad({ robot: 2 }, ok)).code).toBe('invalid_pax')
    expect((await bad({ adult: 21 }, ok)).code).toBe('invalid_pax')
    expect((await bad({ adult: 2 }, ok, '2020-01-01')).code).toBe('invalid_date')
    expect((await rpc(anon, 'public_booking_request', slug, 'O2', '2027-02-03', '08:00', '{"adult":1}', JSON.stringify(ok), null, null)).code).toBe('not_found')
  })

  it('một email tối đa 3 yêu cầu đang chờ trong 24 giờ', async () => {
    await w.departure('2027-02-04', 20)
    for (let i = 0; i < 3; i++) expect((await request('2027-02-04', { adult: 1 }, 'spam@example.com')).ok).toBe(true)
    expect((await request('2027-02-04', { adult: 1 }, 'spam@example.com')).code).toBe('too_many_requests')
  })
})

describe('nhân viên xử lý yêu cầu website', () => {
  const idOf = async (code: string) => (await owner<{ id: string }>(`select id from public.bookings where code = $1 and organization_id = $2`, [code, w.org]))[0]!.id

  it('xác nhận: chờ xác nhận thành đã xác nhận, tắt cờ cần xử lý, vẫn giữ chỗ', async () => {
    const dep = await w.departure('2027-03-01', 6)
    const r = await request('2027-03-01', { adult: 2 }, 'ok1@example.com')
    const id = await idOf(r.booking_code)
    expect((await rpc(user(w.ownerId), 'website_request_decide', id, 'confirm', 'Đã gọi khách')).status).toBe('confirmed')
    const [b] = await owner<any>(`select status::text, needs_action from public.bookings where id = $1`, [id])
    expect(b).toEqual({ status: 'confirmed', needs_action: false })
    expect((await seats(dep)).committed).toBe(2)
    // Xử lý lần hai bị chặn.
    expect((await rpc(user(w.ownerId), 'website_request_decide', id, 'reject', null)).code).toBe('not_pending_website')
  })

  it('từ chối: hủy, trả chỗ, không ghi "cần hủy tay trên kênh"', async () => {
    const dep = await w.departure('2027-03-02', 6)
    const r = await request('2027-03-02', { adult: 3 }, 'ok2@example.com')
    const id = await idOf(r.booking_code)
    expect((await rpc(user(w.ownerId), 'website_request_decide', id, 'reject', 'Hết xe')).status).toBe('cancelled')
    expect((await seats(dep)).committed).toBe(0)
    const manual = await owner(`select 1 from public.booking_changes where booking_id = $1 and channel_request_status = 'manual_required'`, [id])
    expect(manual).toHaveLength(0)
  })

  it('hủy booking website bằng nút Hủy cũng không đòi hủy tay trên kênh', async () => {
    await w.departure('2027-03-03', 6)
    const r = await request('2027-03-03', { adult: 1 }, 'ok3@example.com')
    const res = await rpc(user(w.ownerId), 'cancel_booking_internal', await idOf(r.booking_code), 'Khách đổi ý')
    expect(res).toMatchObject({ ok: true, changed: true, channel_action_required: false })
  })

  it('người chỉ xem không xử lý được; booking không phải website bị từ chối', async () => {
    await w.departure('2027-03-04', 6)
    const r = await request('2027-03-04', { adult: 1 }, 'ok4@example.com')
    await expect(rpc(user(w.viewer), 'website_request_decide', await idOf(r.booking_code), 'confirm', null)).rejects.toThrow(/forbidden/)
    const ch = await rpc(user(w.ownerId), 'create_manual_booking', w.org, { departure_id: await w.departure('2027-03-05', 6), lead: { name: 'Nội bộ' }, pax: { adult: 1 } })
    expect((await rpc(user(w.ownerId), 'website_request_decide', ch.booking_id, 'confirm', null)).code).toBe('not_pending_website')
  })
})

describe('worker báo chỗ nhận cả mã booking', () => {
  it('sự kiện hủy ghi mã booking vẫn tìm ra chuyến để báo GetYourGuide', async () => {
    const [c] = await owner<{ id: string }>(
      `insert into public.channel_connections (organization_id, channel, account_name, mode, status, is_api)
       values ($1, 'getyourguide', 'GYG worker', 'sandbox', 'not_configured', true) returning id`, [w.org])
    await owner(`insert into public.channel_product_mappings (organization_id, connection_id, external_product_code, external_option_code, tour_option_id, is_verified)
       values ($1, $2, 'W-P1', '', $3, true)`, [w.org, c!.id, w.option])
    await w.departure('2027-03-06', 6)
    const r = await request('2027-03-06', { adult: 2 }, 'ok6@example.com')
    const bookingId = (await owner<{ id: string }>(`select id from public.bookings where code = $1 and organization_id = $2`, [r.booking_code, w.org]))[0]!.id
    const [{ t }] = await owner<{ t: any[] }>(`select public.worker_gyg_availability($1) as t`, [bookingId])
    expect(t).toEqual([expect.objectContaining({ connection_id: c!.id, product_id: 'W-P1', items: [expect.objectContaining({ local_date: '2027-03-06', vacancies: 4 })] })])
  })
})
