// Nội dung mở rộng của trang khách và cách tính tiền theo bảng giá theo người (tour riêng).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anon, closePool, makeWorld, owner, rpc, type World } from './test/harness'

let w: World
let slug: string
const contact = (email: string) => JSON.stringify({ name: 'Jane Doe', email })

beforeAll(async () => {
  w = await makeWorld('content')
  ;[{ slug }] = await owner<{ slug: string }>(`select slug from public.organizations where id = $1`, [w.org])
  await owner(`update public.organizations set storefront_settings = '{"cancel_free_hours":24,"contact":{"whatsapp":"+84000000000"}}' where id = $1`, [w.org])
  await owner(
    `update public.tours set is_published = true, description = 'Overview', duration_label = '2 days, 1 night', group_max = 6,
       gallery = array['https://example.com/a.jpg', 'https://example.com/b.jpg'], highlights = array['Jeep', 'Trek'],
       what_to_bring = array['Shoes'], good_to_know = array['Bus not included'],
       content_vi = '{"name":"Tour 1 VI","highlights":["Xe jeep"]}' where id = $1`, [w.tour])
  // O1: tour ghép, giá người lớn 40, trẻ em 25. O2: tour riêng, giá theo số người.
  await owner(`update public.tour_options set price_adult = 40, price_child = 25 where id = $1`, [w.option])
  await owner(
    `update public.tour_options set is_private = true, price_adult = null, child_note = 'Kids under 12: 30% off',
       group_prices = '[{"min":1,"max":2,"per_person":100},{"min":3,"max":4,"per_person":80},{"min":5,"max":null,"per_person":70}]'
     where id = $1`, [w.transferOption])
})
afterAll(closePool)

describe('tính tiền', () => {
  it('tour ghép: người lớn, trẻ em theo giá riêng, em bé miễn phí', async () => {
    const q = await rpc(anon, 'public_quote', slug, 'O1', JSON.stringify({ adult: 2, child: 1, infant: 1 }))
    expect(q).toMatchObject({ ok: true, amount: 105 })
  })

  it('tour riêng: mọi khách trả tiền tính theo bậc khớp số khách, em bé không tính', async () => {
    const q = (pax: object) => rpc(anon, 'public_quote', slug, 'O2', JSON.stringify(pax))
    expect((await q({ adult: 2 })).amount).toBe(200)
    expect((await q({ adult: 2, child: 1, infant: 1 })).amount).toBe(240)
    expect((await q({ adult: 7 })).amount).toBe(490)
  })

  it('yêu cầu đặt ghi đúng số tiền như báo giá', async () => {
    await w.departure('2027-04-01', 10)
    const r = await rpc(anon, 'public_booking_request', slug, 'O2', '2027-04-01', '08:00',
      JSON.stringify({ adult: 3 }), contact('private@example.com'), null, null)
    expect(r).toMatchObject({ ok: true, amount: 240 })
  })

  it('báo giá từ chối số khách sai', async () => {
    expect((await rpc(anon, 'public_quote', slug, 'O1', JSON.stringify({ adult: 'x' }))).code).toBe('invalid_pax')
    expect((await rpc(anon, 'public_quote', slug, 'KHONG', '{}')).code).toBe('not_found')
  })
})

describe('nội dung công khai', () => {
  it('chi tiết tour có bộ ảnh, điểm nổi bật, bản tiếng Việt, bảng giá theo người và cài đặt doanh nghiệp', async () => {
    const t = await rpc(anon, 'public_tour', slug, 'T1')
    expect(t.settings).toEqual({ cancel_free_hours: 24, contact: { whatsapp: '+84000000000' } })
    expect(t.tour).toMatchObject({
      duration_label: '2 days, 1 night', group_max: 6, image_url: 'https://example.com/a.jpg',
      gallery: ['https://example.com/a.jpg', 'https://example.com/b.jpg'], highlights: ['Jeep', 'Trek'],
      what_to_bring: ['Shoes'], good_to_know: ['Bus not included'], vi: { name: 'Tour 1 VI', highlights: ['Xe jeep'] },
    })
    // Tour ghép trước, tour riêng sau.
    expect(t.options.map((o: any) => [o.code, o.from_price])).toEqual([['O1', 40], ['O2', 70]])
    expect(t.options[1]).toMatchObject({ is_private: true, child_note: 'Kids under 12: 30% off' })
  })

  it('danh sách tour lấy giá "từ" thấp nhất, kể cả bậc giá theo người', async () => {
    const s = await rpc(anon, 'public_storefront', slug)
    expect(s.tours[0]).toMatchObject({ code: 'T1', price_from: 40, duration_label: '2 days, 1 night', vi: { name: 'Tour 1 VI' } })
    await owner(`update public.tour_options set price_adult = 90 where id = $1`, [w.option])
    expect((await rpc(anon, 'public_storefront', slug)).tours[0].price_from).toBe(70)
    await owner(`update public.tour_options set price_adult = 40 where id = $1`, [w.option])
  })

  it('bộ ảnh chỉ nhận link https', async () => {
    await expect(owner(`update public.tours set gallery = array['http://example.com/x.jpg'] where id = $1`, [w.tour]))
      .rejects.toThrow(/check/)
  })
})
