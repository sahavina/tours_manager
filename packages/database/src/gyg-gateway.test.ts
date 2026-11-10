// Cổng GetYourGuide: các hàm gateway_gyg_* mà cổng HTTP gọi bằng service_role.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anon, as, closePool, makeWorld, owner, rpc, seats, service, user, type World } from './test/harness'

let w: World
let gyg: string
const P = 'GYG-P1'
const day = (d: string) => [`${d}T00:00:00+07:00`, `${d}T23:59:59+07:00`] as const
const adults = (n: number) => [{ category: 'ADULT', count: n }]
const details = { lead: { first_name: 'An', last_name: 'Nguyen', email: 'an@example.com', phone: '+84 900' }, currency: 'usd', language: 'en', hotel: 'Khách sạn A', comment: 'Ăn chay' }

async function reserve(date: string, n: number, ref: string) {
  return rpc(service, 'gateway_gyg_reserve', gyg, P, date, '08:00', JSON.stringify(adults(n)), ref)
}
async function book(reference: string, date: string, n: number, ref: string) {
  return rpc(service, 'gateway_gyg_book', gyg, reference, P, date, '08:00', JSON.stringify(adults(n)), ref, JSON.stringify(details))
}
async function vacancies(date: string) {
  const r = await rpc(service, 'gateway_gyg_availability', gyg, P, ...day(date))
  return r.items.map((i: any) => i.vacancies)
}

beforeAll(async () => {
  w = await makeWorld('gyg')
  const [c] = await owner<{ id: string }>(
    `insert into public.channel_connections (organization_id, channel, account_name, mode, status, supplier_account_ref, hold_ttl_seconds)
     values ($1, 'getyourguide', 'GYG thử', 'sandbox', 'not_configured', 'SUP-1', 3600) returning id`,
    [w.org],
  )
  gyg = c!.id
  await owner(
    `insert into public.channel_product_mappings
       (organization_id, connection_id, external_product_code, external_option_code, tour_option_id, is_verified)
     values ($1, $2, $3, '', $4, true), ($1, $2, 'GYG-CHUA', '', $4, false)`,
    [w.org, gyg, P, w.option],
  )
})
afterAll(closePool)

describe('quyền', () => {
  it('chỉ service_role gọi được, người dùng trong doanh nghiệp cũng không', async () => {
    await expect(rpc(user(w.ownerId), 'gateway_gyg_availability', gyg, P, ...day('2030-06-01'))).rejects.toThrow(/permission denied|forbidden/)
    await expect(rpc(anon, 'gateway_gyg_reserve', gyg, P, '2030-06-01', '08:00', '[]', 'X')).rejects.toThrow(/permission denied/)
  })

  it('không dùng được với kết nối không phải GetYourGuide', async () => {
    await expect(rpc(service, 'gateway_gyg_availability', w.connection, P, ...day('2030-06-01'))).rejects.toThrow(/forbidden/)
  })
})

describe('tình trạng chỗ', () => {
  it('trả giờ địa phương, số chỗ, và từ chối mã chưa kiểm tra', async () => {
    await w.departure('2030-06-02', 6)
    const r = await rpc(service, 'gateway_gyg_availability', gyg, P, ...day('2030-06-02'))
    expect(r.ok).toBe(true)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ local_date: '2030-06-02', local_time: '08:00:00', vacancies: 6 })
    expect((await rpc(service, 'gateway_gyg_availability', gyg, 'GYG-CHUA', ...day('2030-06-02'))).code).toBe('invalid_product')
    expect((await rpc(service, 'gateway_gyg_availability', gyg, 'KHONG-CO', ...day('2030-06-02'))).code).toBe('invalid_product')
  })

  it('không cộng các chuyến cùng giờ: báo số chỗ của chuyến trống nhất', async () => {
    await w.departure('2030-06-03', 6)
    await owner(`select public._create_slot($1, $2, null, '2030-06-03', '08:00', 'Asia/Ho_Chi_Minh', 6)`, [w.org, w.tour])
    expect(await vacancies('2030-06-03')).toEqual([6])
  })
})

describe('giữ chỗ và đặt', () => {
  it('giữ, gửi lại, đặt, gửi lại đặt: một booking, trừ chỗ một lần', async () => {
    const dep = await w.departure('2030-06-10', 6)
    const r1 = await reserve('2030-06-10', 2, 'GYGA1')
    expect(r1).toMatchObject({ ok: true, code: 'held' })
    const r2 = await reserve('2030-06-10', 2, 'GYGA1')
    expect(r2).toMatchObject({ ok: true, code: 'existing', reference: r1.reference })
    expect(await vacancies('2030-06-10')).toEqual([4])

    const b1 = await book(r1.reference, '2030-06-10', 2, 'GYGA1')
    expect(b1.ok).toBe(true)
    expect(b1.booking_code).toMatch(/^SH-/)
    const b2 = await book(r1.reference, '2030-06-10', 2, 'GYGA1')
    expect(b2).toMatchObject({ ok: true, code: 'existing', booking_code: b1.booking_code })

    expect((await seats(dep)).committed).toBe(2)
    const [b] = await owner<any>(
      `select b.external_ref, b.lead_name, b.lead_email, b.currency, b.special_requests, i.pax, p.hotel_name
       from public.bookings b join public.booking_items i on i.booking_id = b.id
       left join public.booking_pickups p on p.booking_item_id = i.id where b.code = $1 and b.organization_id = $2`,
      [b1.booking_code, w.org],
    )
    expect(b).toMatchObject({ external_ref: 'GYGA1', lead_name: 'An Nguyen', lead_email: 'an@example.com', currency: 'USD', special_requests: 'Ăn chay', pax: { adult: 2 }, hotel_name: 'Khách sạn A' })
  })

  it('nhóm khách không có: INVALID_TICKET_CATEGORY, GROUP chưa hỗ trợ', async () => {
    await w.departure('2030-06-11', 6)
    const s = await rpc(service, 'gateway_gyg_reserve', gyg, P, '2030-06-11', '08:00', JSON.stringify([{ category: 'STUDENT', count: 1 }]), 'GYGC1')
    expect(s).toMatchObject({ ok: false, code: 'invalid_ticket_category', category: 'STUDENT' })
    const g = await rpc(service, 'gateway_gyg_reserve', gyg, P, '2030-06-11', '08:00', JSON.stringify([{ category: 'GROUP', count: 1, groupSize: 4 }]), 'GYGC2')
    expect(g).toMatchObject({ ok: false, code: 'invalid_ticket_category', category: 'GROUP' })
  })

  it('quá số chỗ của một chuyến thì NO_AVAILABILITY, không tách sang hai chuyến', async () => {
    await w.departure('2030-06-12', 6)
    await owner(`select public._create_slot($1, $2, null, '2030-06-12', '08:00', 'Asia/Ho_Chi_Minh', 6)`, [w.org, w.tour])
    const r = await reserve('2030-06-12', 7, 'GYGN1')
    expect(r).toMatchObject({ ok: false, code: 'no_availability', requested: 7, available: 6 })
  })

  it('nhóm lấp kín chuyến 1 vẫn được xác nhận vào đúng chuyến 1 khi chuyến 2 còn trống', async () => {
    const d1 = await w.departure('2030-06-13', 6)
    const [d2] = await owner<{ id: string }>(`select public._create_slot($1, $2, null, '2030-06-13', '08:00', 'Asia/Ho_Chi_Minh', 6) as id`, [w.org, w.tour])
    const r = await reserve('2030-06-13', 6, 'GYGF1')
    expect(r.ok).toBe(true)
    const b = await book(r.reference, '2030-06-13', 6, 'GYGF1')
    expect(b.ok).toBe(true)
    expect((await seats(d1)).committed).toBe(6)
    expect((await seats(d2!.id)).committed).toBe(0)
  })

  it('đặt khác số khách đã giữ thì từ chối, chỗ giữ hết hạn thì INVALID_RESERVATION', async () => {
    await w.departure('2030-06-14', 6)
    const r = await reserve('2030-06-14', 2, 'GYGV1')
    expect((await book(r.reference, '2030-06-14', 3, 'GYGV1')).code).toBe('validation')
    await owner(`update public.inventory_holds set expires_at = now() - interval '1 second' where reference = $1`, [r.reference])
    expect((await book(r.reference, '2030-06-14', 2, 'GYGV1')).code).toBe('invalid_reservation')
    expect((await book('KHONG-CO', '2030-06-14', 2, 'GYGV1')).code).toBe('invalid_reservation')
  })

  it('hủy giữ chỗ trả lại chỗ', async () => {
    await w.departure('2030-06-15', 6)
    const r = await reserve('2030-06-15', 3, 'GYGR1')
    expect(await vacancies('2030-06-15')).toEqual([3])
    expect((await rpc(service, 'gateway_gyg_cancel_reservation', gyg, r.reference)).ok).toBe(true)
    expect(await vacancies('2030-06-15')).toEqual([6])
    // Giữ lại cùng nội dung sau khi hủy tạo chỗ giữ mới.
    const again = await reserve('2030-06-15', 3, 'GYGR1')
    expect(again.ok).toBe(true)
    expect(again.reference).not.toBe(r.reference)
  })
})

describe('hủy và đổi booking', () => {
  it('hủy booking trả chỗ, hủy lần hai là INVALID_BOOKING', async () => {
    const dep = await w.departure('2030-06-20', 6)
    const r = await reserve('2030-06-20', 2, 'GYGX1')
    const b = await book(r.reference, '2030-06-20', 2, 'GYGX1')
    expect((await rpc(service, 'gateway_gyg_cancel_booking', gyg, b.booking_code, 'GYGX1')).ok).toBe(true)
    expect((await seats(dep)).committed).toBe(0)
    expect((await rpc(service, 'gateway_gyg_cancel_booking', gyg, b.booking_code, 'GYGX1')).code).toBe('invalid_booking')
    expect((await rpc(service, 'gateway_gyg_cancel_booking', gyg, b.booking_code, 'GYG-KHAC')).code).toBe('invalid_booking')
  })

  it('đổi booking: đặt mới cùng mã GYG rồi hủy mã cũ, booking mới vẫn còn', async () => {
    const dep = await w.departure('2030-06-21', 6)
    const old = await book((await reserve('2030-06-21', 2, 'GYGM1')).reference, '2030-06-21', 2, 'GYGM1')
    const neu = await book((await reserve('2030-06-21', 3, 'GYGM1')).reference, '2030-06-21', 3, 'GYGM1')
    expect(neu.ok).toBe(true)
    expect(neu.booking_code).not.toBe(old.booking_code)
    expect((await rpc(service, 'gateway_gyg_cancel_booking', gyg, old.booking_code, 'GYGM1')).ok).toBe(true)
    expect((await seats(dep)).committed).toBe(3)
    const rows = await owner<{ external_ref: string; status: string }>(
      `select external_ref, status::text from public.bookings where organization_id = $1 and external_ref like 'GYGM1%' order by external_ref`,
      [w.org],
    )
    expect(rows).toEqual([{ external_ref: 'GYGM1', status: 'cancelled' }, { external_ref: 'GYGM1~2', status: 'confirmed' }])
  })
})

describe('danh sách sản phẩm và worker', () => {
  it('chỉ trả mã đã kiểm tra, sai mã nhà cung cấp là INVALID_SUPPLIER', async () => {
    expect((await rpc(service, 'gateway_gyg_products', gyg, 'SUP-KHAC')).code).toBe('invalid_supplier')
    const r = await rpc(service, 'gateway_gyg_products', gyg, 'SUP-1')
    expect(r.ok).toBe(true)
    expect(r.products.map((p: any) => p.productId)).toEqual([P])
  })

  it('worker biết cần báo số chỗ nào cho GetYourGuide khi chuyến đổi', async () => {
    const dep = await w.departure('2030-06-25', 6)
    await reserve('2030-06-25', 2, 'GYGW1')
    const [{ r }] = await owner<{ r: any[] }>(`select public.worker_gyg_availability($1) as r`, [dep])
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ connection_id: gyg, product_id: P })
    expect(r[0].items).toEqual([expect.objectContaining({ local_date: '2030-06-25', vacancies: 4 })])
    await expect(as(user(w.ownerId), `select public.worker_gyg_availability($1)`, [dep])).rejects.toThrow(/permission denied/)
  })
})
