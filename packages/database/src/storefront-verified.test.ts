// Chống bot: khi doanh nghiệp bật require_verified_booking, chỉ Worker (service_role, sau khi kiểm tra Turnstile)
// tạo được yêu cầu đặt tour; lời gọi thẳng bằng khóa công khai bị từ chối mà không giữ chỗ.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anon, closePool, makeWorld, owner, rpc, seats, service, type World } from './test/harness'

let w: World
let slug: string
let dep: string
const contact = (email: string) => JSON.stringify({ name: 'Jane Doe', email })
const request = (actor: typeof anon, email: string) =>
  rpc(actor, 'public_booking_request', slug, 'O1', '2027-06-01', '08:00', '{"adult":2}', contact(email), null, null)

beforeAll(async () => {
  w = await makeWorld('verified')
  ;[{ slug }] = await owner<{ slug: string }>(`select slug from public.organizations where id = $1`, [w.org])
  await owner(`update public.tours set is_published = true where id = $1`, [w.tour])
  dep = await w.departure('2027-06-01', 6)
})
afterAll(closePool)

describe('bắt buộc xác minh khi đặt từ website', () => {
  it('chưa bật: khách gọi thẳng vẫn đặt được như cũ', async () => {
    const r = await request(anon, 'a@example.com')
    expect(r.ok).toBe(true)
  })

  it('đã bật: khóa công khai bị từ chối và không giữ chỗ; service_role đặt được', async () => {
    await owner(`update public.organizations set storefront_settings = storefront_settings || '{"require_verified_booking": true}' where id = $1`, [w.org])
    const before = await seats(dep)
    const blocked = await request(anon, 'b@example.com')
    expect(blocked).toEqual({ ok: false, code: 'verification_required' })
    expect(await seats(dep)).toEqual(before)

    const ok = await request(service, 'c@example.com')
    expect(ok.ok).toBe(true)
    expect(ok.booking_code).toBeTruthy()
  })

  it('hàm lõi không gọi thẳng được bằng khóa công khai', async () => {
    await expect(rpc(anon, '_public_booking_request_core', slug, 'O1', '2027-06-01', '08:00', '{"adult":1}', contact('d@example.com'), null, null))
      .rejects.toThrow(/permission denied/)
  })
})
