// Email xác nhận / hủy cho khách: booking website đổi trạng thái thì có outbox 'website.status',
// worker_email_job trả việc loại 'status' kèm thông tin liên hệ của doanh nghiệp.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anon, closePool, makeWorld, owner, rpc, service, user, type World } from './test/harness'

let w: World
let slug: string

beforeAll(async () => {
  w = await makeWorld('webstatus')
  ;[{ slug }] = await owner<{ slug: string }>(`select slug from public.organizations where id = $1`, [w.org])
  await owner(`update public.tours set is_published = true where id = $1`, [w.tour])
  await owner(`update public.organizations set email_settings = '{"enabled": true, "notify_customer": true}',
    storefront_settings = '{"contact": {"whatsapp": "+84 900"}}' where id = $1`, [w.org])
  await w.departure('2027-08-01', 6)
})
afterAll(closePool)

const book = async (email: string) => {
  const r = await rpc(anon, 'public_booking_request', slug, 'O1', '2027-08-01', '08:00', '{"adult":1}',
    JSON.stringify({ name: 'Jane Doe', email }), null, null)
  expect(r.ok).toBe(true)
  const [b] = await owner<{ id: string }>(`select id from public.bookings where code = $1`, [r.booking_code])
  return b!.id
}
const statusEvents = (id: string) =>
  owner<{ id: number; payload: { from: string; to: string } }>(
    `select id, payload from public.outbox_events where topic = 'website.status' and aggregate_id = $1 order by id`, [id])

describe('email xác nhận / hủy cho khách', () => {
  it('xác nhận yêu cầu website tạo sự kiện, worker nhận việc loại status kèm liên hệ', async () => {
    const id = await book('a@example.com')
    expect((await rpc(user(w.ownerId), 'website_request_decide', id, 'confirm', null)).ok).toBe(true)
    const ev = await statusEvents(id)
    expect(ev.map((e) => e.payload)).toEqual([expect.objectContaining({ from: 'pending', to: 'confirmed' })])
    const job = await rpc(service, 'worker_email_job', Number(ev[0]!.id))
    expect(job).toMatchObject({ kind: 'status', status_to: 'confirmed', contact: { whatsapp: '+84 900' } })
    expect(job.booking.lead_email).toBe('a@example.com')
    await rpc(service, 'worker_email_log', Number(ev[0]!.id), 'customer_confirmed', 'a@example.com', 'S', 'sent', null)
    const [log] = await owner<{ booking_id: string }>(`select booking_id from public.email_log where outbox_id = $1`, [ev[0]!.id])
    expect(log!.booking_id).toBe(id)
  })

  it('từ chối yêu cầu tạo sự kiện chuyển sang cancelled', async () => {
    const id = await book('b@example.com')
    expect((await rpc(user(w.ownerId), 'website_request_decide', id, 'reject', 'Hết xe')).ok).toBe(true)
    expect((await statusEvents(id)).map((e) => e.payload.to)).toEqual(['cancelled'])
  })

  it('booking không phải website thì không có sự kiện', async () => {
    const id = await book('c@example.com')
    await owner(`update public.bookings set external_ref = 'GYG-1' where id = $1`, [id])
    await owner(`update public.bookings set status = 'confirmed' where id = $1`, [id])
    expect(await statusEvents(id)).toEqual([])
  })
})
