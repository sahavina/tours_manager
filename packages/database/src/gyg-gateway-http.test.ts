// Trọn luồng GetYourGuide: request HTTP -> cổng (@tours/gyg) -> hàm gateway_gyg_* trên Postgres thật.
import { createGateway, type Rpc } from '@tours/gyg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { as, closePool, makeWorld, owner, seats, service, type World } from './test/harness'

let w: World
let send: (method: string, path: string, body?: unknown) => Promise<any>

// Giống PostgREST: tham số theo tên, chạy với vai service_role.
const rpc: Rpc = async (fn, args) => {
  const keys = Object.keys(args)
  const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`
  const vals = keys.map((k) => (typeof args[k] === 'object' && args[k] !== null ? JSON.stringify(args[k]) : args[k]))
  return (await as<{ r: unknown }>(service, sql, vals))[0]!.r
}

beforeAll(async () => {
  w = await makeWorld('gyghttp')
  const [c] = await owner<{ id: string }>(
    `insert into public.channel_connections (organization_id, channel, account_name, mode, status, supplier_account_ref, hold_ttl_seconds, is_api)
     values ($1, 'getyourguide', 'GYG http', 'sandbox', 'not_configured', 'SUP-H', 3600, true) returning id`,
    [w.org],
  )
  await owner(
    `insert into public.channel_product_mappings (organization_id, connection_id, external_product_code, external_option_code, tour_option_id, is_verified)
     values ($1, $2, 'HJ-CITY', '', $3, true)`,
    [w.org, c!.id, w.option],
  )
  const gw = createGateway({ connectionId: c!.id, username: 'gyg', password: 'pw', rpc })
  send = async (method, path, body) => {
    const res = await gw(
      new Request(`https://gw.test${path}`, {
        method,
        headers: { authorization: `Basic ${btoa('gyg:pw')}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )
    return res.json()
  }
})
afterAll(closePool)

it('hỏi chỗ, giữ, đặt, gửi lại đặt, hủy: đúng định dạng GetYourGuide và đúng số chỗ', async () => {
  const dep = await w.departure('2030-07-01', 6)
  const q = '/1/get-availabilities/?productId=HJ-CITY&fromDateTime=2030-07-01T00:00:00%2B07:00&toDateTime=2030-07-01T23:59:59%2B07:00'
  expect(await send('GET', q)).toEqual({
    data: { availabilities: [{ dateTime: '2030-07-01T08:00:00+07:00', productId: 'HJ-CITY', cutoffSeconds: expect.any(Number), vacancies: 6 }] },
  })

  const item = { productId: 'HJ-CITY', dateTime: '2030-07-01T08:00:00+07:00', gygBookingReference: 'GYGHTTP1' }
  const held = await send('POST', '/1/reserve/', { data: { ...item, bookingItems: [{ category: 'ADULT', count: 2 }, { category: 'INFANT', count: 1 }] } })
  expect(held.data.reservationReference).toMatch(/^G[0-9a-f]{12}-1$/)
  expect(held.data.reservationExpiration).toMatch(/\+00:00$/)
  // Em bé không chiếm chỗ trong doanh nghiệp này.
  expect((await send('GET', q)).data.availabilities[0].vacancies).toBe(4)

  const bookReq = {
    data: {
      ...item,
      reservationReference: held.data.reservationReference,
      currency: 'USD',
      bookingItems: [{ category: 'ADULT', count: 2, retailPrice: 3500 }, { category: 'INFANT', count: 1, retailPrice: 0 }],
      travelers: [{ firstName: 'Mai', lastName: 'Tran', email: 'mai@example.com', phoneNumber: '+84 911' }],
      travelerHotel: 'Hanoi Hotel, Hoan Kiem',
    },
  }
  const booked = await send('POST', '/1/book/', bookReq)
  expect(booked.data.bookingReference).toMatch(/^SH-/)
  expect(booked.data.tickets).toHaveLength(3)
  expect(await send('POST', '/1/book/', bookReq)).toEqual(booked)
  expect((await seats(dep)).committed).toBe(2)

  const cancel = { data: { bookingReference: booked.data.bookingReference, gygBookingReference: 'GYGHTTP1', productId: 'HJ-CITY' } }
  expect(await send('POST', '/1/cancel-booking/', cancel)).toEqual({ data: {} })
  expect((await send('POST', '/1/cancel-booking/', cancel)).errorCode).toBe('INVALID_BOOKING')
  expect((await seats(dep)).committed).toBe(0)
  expect((await send('GET', q)).data.availabilities[0].vacancies).toBe(6)
})

it('sản phẩm lạ, nhóm khách lạ, hết chỗ', async () => {
  await w.departure('2030-07-02', 6)
  const base = { dateTime: '2030-07-02T08:00:00+07:00', gygBookingReference: 'GYGHTTP2' }
  expect((await send('POST', '/1/reserve/', { data: { ...base, productId: 'KHONG-CO', bookingItems: [{ category: 'ADULT', count: 1 }] } })).errorCode).toBe('INVALID_PRODUCT')
  expect(await send('POST', '/1/reserve/', { data: { ...base, productId: 'HJ-CITY', bookingItems: [{ category: 'SENIOR', count: 1 }] } })).toMatchObject({
    errorCode: 'INVALID_TICKET_CATEGORY',
    ticketCategory: 'SENIOR',
  })
  expect((await send('POST', '/1/reserve/', { data: { ...base, productId: 'HJ-CITY', bookingItems: [{ category: 'ADULT', count: 7 }] } })).errorCode).toBe('NO_AVAILABILITY')
  expect((await send('GET', '/1/suppliers/SUP-H/products/')).data.products).toEqual([{ productId: 'HJ-CITY', productTitle: 'Tour 1 - Không đón' }])
})
