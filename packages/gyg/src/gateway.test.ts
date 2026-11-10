import { describe, expect, it } from 'vitest'
import { createGateway, type Rpc } from './handler.ts'
import { notifyBody, sendAvailabilityUpdate } from './notify.ts'
import { parseLocalDateTime, toGygDateTime } from './protocol.ts'

const AUTH = `Basic ${btoa('gyg:bi-mat')}`
type Call = { fn: string; args: Record<string, unknown> }

function setup(reply: (fn: string, args: Record<string, unknown>) => unknown) {
  const calls: Call[] = []
  const logs: Record<string, unknown>[] = []
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, args })
    return reply(fn, args)
  }
  const gw = createGateway({ connectionId: 'conn-1', username: 'gyg', password: 'bi-mat', rpc, log: (e) => logs.push(e) })
  const send = async (method: string, path: string, body?: unknown, auth = AUTH) => {
    const res = await gw(
      new Request(`https://gw.test${path}`, {
        method,
        headers: auth ? { authorization: auth, 'content-type': 'application/json' } : {},
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      }),
    )
    return { status: res.status, body: (await res.json()) as any }
  }
  return { send, calls, logs }
}

const reserveBody = {
  data: { productId: 'GYG-P1', dateTime: '2030-06-10T08:00:00+07:00', gygBookingReference: 'GYG1', bookingItems: [{ category: 'ADULT', count: 2 }] },
}
const bookBody = {
  data: {
    ...reserveBody.data,
    reservationReference: 'Gabc-1',
    currency: 'USD',
    bookingItems: [{ category: 'ADULT', count: 2, retailPrice: 1500 }, { category: 'CHILD', count: 1, retailPrice: 1000 }],
    travelers: [{ firstName: 'An', lastName: 'Nguyen', email: 'an@example.com', phoneNumber: '+84 900' }],
    travelerHotel: 'Khách sạn A',
    comment: 'Ăn chay',
    language: 'en',
  },
}

describe('xác thực', () => {
  it('thiếu hoặc sai mật khẩu: AUTHORIZATION_FAILURE, không gọi database', async () => {
    const { send, calls } = setup(() => ({ ok: true }))
    expect((await send('POST', '/1/reserve/', reserveBody, '')).body.errorCode).toBe('AUTHORIZATION_FAILURE')
    expect((await send('POST', '/1/reserve/', reserveBody, `Basic ${btoa('gyg:sai')}`)).body.errorCode).toBe('AUTHORIZATION_FAILURE')
    expect((await send('POST', '/1/reserve/', reserveBody, 'Bearer x')).body.errorCode).toBe('AUTHORIZATION_FAILURE')
    expect(calls).toHaveLength(0)
  })

  it('cấu hình thiếu mật khẩu thì từ chối mọi yêu cầu', async () => {
    const gw = createGateway({ connectionId: 'c', username: '', password: '', rpc: async () => ({ ok: true }) })
    const res = await gw(new Request('https://gw.test/1/reserve/', { method: 'POST', headers: { authorization: `Basic ${btoa(':')}` }, body: '{}' }))
    expect(((await res.json()) as any).errorCode).toBe('AUTHORIZATION_FAILURE')
  })
})

describe('tình trạng chỗ', () => {
  it('đổi giờ địa phương + UTC sang dateTime có độ lệch', async () => {
    const { send, calls } = setup(() => ({
      ok: true,
      items: [{ local_date: '2030-06-10', local_time: '08:00:00', starts_at: '2030-06-10T01:00:00+00:00', cutoff_seconds: 3600, vacancies: 4 }],
    }))
    const r = await send('GET', '/1/get-availabilities/?productId=GYG-P1&fromDateTime=2030-06-10T00:00:00%2B07:00&toDateTime=2030-06-11T00:00:00%2B07:00')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ data: { availabilities: [{ dateTime: '2030-06-10T08:00:00+07:00', productId: 'GYG-P1', cutoffSeconds: 3600, vacancies: 4 }] } })
    expect(calls[0]).toEqual({ fn: 'gateway_gyg_availability', args: { p_connection: 'conn-1', p_product: 'GYG-P1', p_from: '2030-06-10T00:00:00+07:00', p_to: '2030-06-11T00:00:00+07:00' } })
  })

  it('thiếu tham số: VALIDATION_FAILURE; mã chưa ghép: INVALID_PRODUCT', async () => {
    const { send } = setup(() => ({ ok: false, code: 'invalid_product' }))
    expect((await send('GET', '/1/get-availabilities/?productId=GYG-P1')).body.errorCode).toBe('VALIDATION_FAILURE')
    const r = await send('GET', '/1/get-availabilities/?productId=X&fromDateTime=2030-06-10T00:00:00Z&toDateTime=2030-06-11T00:00:00Z')
    expect(r.body.errorCode).toBe('INVALID_PRODUCT')
    expect(r.body.data).toBeUndefined()
  })
})

describe('giữ chỗ', () => {
  it('chuyển ngày giờ địa phương nguyên văn, trả mã và hạn giữ theo UTC', async () => {
    const { send, calls } = setup(() => ({ ok: true, code: 'held', reference: 'Gabc-1', expires_at: '2030-06-01T03:15:00.123456+00:00' }))
    const r = await send('POST', '/1/reserve/', reserveBody)
    expect(r.body).toEqual({ data: { reservationReference: 'Gabc-1', reservationExpiration: '2030-06-01T03:15:00+00:00' } })
    expect(calls[0]!.args).toMatchObject({ p_local_date: '2030-06-10', p_local_time: '08:00:00', p_gyg_ref: 'GYG1', p_items: [{ category: 'ADULT', count: 2 }] })
  })

  it('lỗi nghiệp vụ dịch đúng mã GetYourGuide', async () => {
    const cases: [unknown, string][] = [
      [{ ok: false, code: 'no_availability', requested: 7, available: 6 }, 'NO_AVAILABILITY'],
      [{ ok: false, code: 'invalid_ticket_category', category: 'STUDENT' }, 'INVALID_TICKET_CATEGORY'],
      [{ ok: false, code: 'validation' }, 'VALIDATION_FAILURE'],
      [{ ok: false, code: 'la' }, 'INTERNAL_SYSTEM_FAILURE'],
    ]
    for (const [reply, code] of cases) {
      const { send } = setup(() => reply)
      const r = await send('POST', '/1/reserve/', reserveBody)
      expect(r.body.errorCode).toBe(code)
      if (code === 'INVALID_TICKET_CATEGORY') expect(r.body.ticketCategory).toBe('STUDENT')
      if (code === 'NO_AVAILABILITY') expect(r.body.errorMessage).toContain('requested 7; available 6')
    }
  })

  it('JSON hỏng, thiếu trường, số khách không hợp lệ: VALIDATION_FAILURE, không gọi database', async () => {
    const { send, calls } = setup(() => ({ ok: true }))
    expect((await send('POST', '/1/reserve/', '{không phải json')).body.errorCode).toBe('VALIDATION_FAILURE')
    expect((await send('POST', '/1/reserve/', { data: { ...reserveBody.data, dateTime: '10/06/2030' } })).body.errorCode).toBe('VALIDATION_FAILURE')
    expect((await send('POST', '/1/reserve/', { data: { ...reserveBody.data, bookingItems: [{ category: 'ADULT', count: 0 }] } })).body.errorCode).toBe('VALIDATION_FAILURE')
    expect((await send('POST', '/1/reserve/', { data: { ...reserveBody.data, productId: 'x'.repeat(256) } })).body.errorCode).toBe('VALIDATION_FAILURE')
    expect((await send('POST', '/1/reserve/', 'x'.repeat(70_000))).body.errorCode).toBe('VALIDATION_FAILURE')
    expect(calls).toHaveLength(0)
  })

  it('database lỗi hoặc timeout: INTERNAL_SYSTEM_FAILURE để GetYourGuide tự gửi lại', async () => {
    const { send, logs } = setup(() => {
      throw new Error('rpc gateway_gyg_reserve: HTTP 503')
    })
    const r = await send('POST', '/1/reserve/', reserveBody)
    expect(r.status).toBe(200)
    expect(r.body.errorCode).toBe('INTERNAL_SYSTEM_FAILURE')
    expect(logs[0]).toMatchObject({ path: '/1/reserve/', errorCode: 'INTERNAL_SYSTEM_FAILURE' })
  })
})

describe('đặt và hủy', () => {
  it('đặt: chuyển khách đầu tiên làm người liên hệ, trả mã booking và một vé mỗi khách', async () => {
    const { send, calls } = setup(() => ({ ok: true, code: 'booked', booking_code: 'SH-000201' }))
    const r = await send('POST', '/1/book/', bookBody)
    expect(r.body.data.bookingReference).toBe('SH-000201')
    expect(r.body.data.tickets).toEqual([
      { category: 'ADULT', ticketCode: 'SH-000201-1', ticketCodeType: 'TEXT' },
      { category: 'ADULT', ticketCode: 'SH-000201-2', ticketCodeType: 'TEXT' },
      { category: 'CHILD', ticketCode: 'SH-000201-3', ticketCodeType: 'TEXT' },
    ])
    expect(calls[0]!.fn).toBe('gateway_gyg_book')
    expect(calls[0]!.args).toMatchObject({
      p_reference: 'Gabc-1',
      p_details: { lead: { first_name: 'An', last_name: 'Nguyen', email: 'an@example.com', phone: '+84 900' }, currency: 'USD', hotel: 'Khách sạn A', comment: 'Ăn chay', language: 'en' },
    })
  })

  it('chỗ giữ hết hạn: INVALID_RESERVATION', async () => {
    const { send } = setup(() => ({ ok: false, code: 'invalid_reservation' }))
    expect((await send('POST', '/1/book/', bookBody)).body.errorCode).toBe('INVALID_RESERVATION')
  })

  it('hủy giữ chỗ và hủy booking trả data rỗng; hủy lặp: INVALID_BOOKING', async () => {
    const ok = setup(() => ({ ok: true }))
    expect((await ok.send('POST', '/1/cancel-reservation/', { data: { reservationReference: 'Gabc-1', gygBookingReference: 'GYG1' } })).body).toEqual({ data: {} })
    expect((await ok.send('POST', '/1/cancel-booking/', { data: { bookingReference: 'SH-1', gygBookingReference: 'GYG1', productId: 'GYG-P1' } })).body).toEqual({ data: {} })
    expect(ok.calls.map((c) => c.fn)).toEqual(['gateway_gyg_cancel_reservation', 'gateway_gyg_cancel_booking'])
    const again = setup(() => ({ ok: false, code: 'invalid_booking', message: 'Booking đã hủy trước đó' }))
    const r = await again.send('POST', '/1/cancel-booking/', { data: { bookingReference: 'SH-1', gygBookingReference: 'GYG1', productId: 'GYG-P1' } })
    expect(r.body).toEqual({ errorCode: 'INVALID_BOOKING', errorMessage: 'The booking has been cancelled already.' })
  })
})

describe('danh sách sản phẩm, đường dẫn lạ', () => {
  it('trả danh sách theo mã nhà cung cấp; sai mã: INVALID_SUPPLIER', async () => {
    const { send, calls } = setup((_fn, a) =>
      a.p_supplier === 'SUP-1' ? { ok: true, supplier_name: 'Hanoi Jeep', products: [{ productId: 'GYG-P1', productTitle: 'Tour - Gói' }] } : { ok: false, code: 'invalid_supplier' },
    )
    expect((await send('GET', '/1/suppliers/SUP-1/products/')).body).toEqual({
      data: { supplierId: 'SUP-1', supplierName: 'Hanoi Jeep', products: [{ productId: 'GYG-P1', productTitle: 'Tour - Gói' }] },
    })
    expect((await send('GET', '/1/suppliers/SUP-X/products')).body.errorCode).toBe('INVALID_SUPPLIER')
    expect(calls).toHaveLength(2)
  })

  it('đường dẫn không có: 404', async () => {
    const { send } = setup(() => ({ ok: true }))
    expect((await send('GET', '/1/khong-co/')).status).toBe(404)
    expect((await send('GET', '/1/reserve/')).status).toBe(404)
  })
})

describe('giờ và thông báo chỗ', () => {
  it('giữ nguyên giờ địa phương, kể cả độ lệch âm và lẻ phút', () => {
    expect(parseLocalDateTime('2030-06-10T08:00:00+07:00')).toEqual({ date: '2030-06-10', time: '08:00:00' })
    expect(parseLocalDateTime('2030-06-10T08:00Z')).toEqual({ date: '2030-06-10', time: '08:00:00' })
    expect(parseLocalDateTime('2030-02-30T08:00:00+07:00')).toBeNull()
    expect(toGygDateTime('2030-06-10', '08:00:00', '2030-06-10T01:00:00Z')).toBe('2030-06-10T08:00:00+07:00')
    expect(toGygDateTime('2030-06-10', '08:00', '2030-06-10T13:00:00Z')).toBe('2030-06-10T08:00:00-05:00')
    expect(toGygDateTime('2030-06-10', '08:00:00', '2030-06-10T02:15:00Z')).toBe('2030-06-10T08:00:00+05:45')
  })

  it('gửi notify-availability-update đúng khuôn, Basic auth, nhận 202 là thành công', async () => {
    const target = { connection_id: 'c', product_id: 'GYG-P1', items: [{ local_date: '2030-06-10', local_time: '08:00:00', starts_at: '2030-06-10T01:00:00Z', vacancies: 4 }] }
    expect(notifyBody(target)).toEqual({ data: { productId: 'GYG-P1', availabilities: [{ dateTime: '2030-06-10T08:00:00+07:00', vacancies: 4 }] } })
    let seen: { url: string; init: RequestInit } | undefined
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(JSON.stringify({ data: { message: 'Availability Update Accepted' } }), { status: 202 })
    }) as unknown as typeof fetch
    const ok = await sendAvailabilityUpdate({ baseUrl: 'https://gyg.test/', username: 'u', password: 'p' }, target, fakeFetch)
    expect(ok).toEqual({ ok: true, status: 202 })
    expect(seen!.url).toBe('https://gyg.test/1/notify-availability-update')
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(`Basic ${btoa('u:p')}`)

    const reject = (async () => new Response(JSON.stringify({ errorCode: 'INVALID_PRODUCT' }), { status: 400 })) as unknown as typeof fetch
    expect(await sendAvailabilityUpdate({ baseUrl: 'https://gyg.test', username: 'u', password: 'p' }, target, reject)).toEqual({
      ok: false,
      status: 400,
      errorCode: 'INVALID_PRODUCT',
    })
  })
})
