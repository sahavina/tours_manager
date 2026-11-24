// Email thông báo: cấu hình trong organizations.email_settings, worker lấy dữ liệu qua worker_email_job và ghi
// email_log. Chỉ booking website (WEB-...) được gửi; nút Gửi thử cần quyền org.manage.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anon, closePool, makeWorld, owner, rpc, service, user, type World } from './test/harness'

let w: World
let slug: string

beforeAll(async () => {
  w = await makeWorld('email')
  ;[{ slug }] = await owner<{ slug: string }>(`select slug from public.organizations where id = $1`, [w.org])
  await owner(`update public.tours set is_published = true where id = $1`, [w.tour])
  await w.departure('2027-07-01', 6)
})
afterAll(closePool)

const outboxOf = async (bookingCode: string) => {
  const [r] = await owner<{ id: number }>(
    `select e.id from public.outbox_events e join public.bookings b on b.id::text = e.aggregate_id
     where e.topic = 'booking.created' and b.code = $1`, [bookingCode])
  return Number(r!.id)
}

describe('email thông báo đặt tour', () => {
  it('chưa bật thì worker không gửi gì', async () => {
    const r = await rpc(anon, 'public_booking_request', slug, 'O1', '2027-07-01', '08:00', '{"adult":1}',
      JSON.stringify({ name: 'Jane Doe', email: 'jane@example.com' }), 'Hotel A', 'Vegetarian')
    expect(r.ok).toBe(true)
    expect(await rpc(service, 'worker_email_job', await outboxOf(r.booking_code))).toBeNull()
  })

  it('bật rồi: worker nhận đủ thông tin booking website, ghi log một lần', async () => {
    await owner(`update public.organizations set email_settings = '{"enabled": true, "staff_to": ["ops@example.com"], "notify_staff": true, "notify_customer": true}' where id = $1`, [w.org])
    const r = await rpc(anon, 'public_booking_request', slug, 'O1', '2027-07-01', '08:00', '{"adult":2}',
      JSON.stringify({ name: 'John Roe', email: 'john@example.com', phone: '+1 555' }), 'Hotel B', null)
    const id = await outboxOf(r.booking_code)
    const job = await rpc(service, 'worker_email_job', id)
    expect(job.kind).toBe('booking')
    expect(job.settings.staff_to).toEqual(['ops@example.com'])
    expect(job.booking).toMatchObject({ code: r.booking_code, lead_email: 'john@example.com', lead_phone: '+1 555' })
    expect(job.booking.items[0]).toMatchObject({ date: '2027-07-01', time: '08:00', pax_total: 2, hotel: 'Hotel B' })
    expect(job.sent).toEqual([])

    await rpc(service, 'worker_email_log', id, 'customer_ack', 'john@example.com', 'Subject', 'sent', null)
    await rpc(service, 'worker_email_log', id, 'customer_ack', 'john@example.com', 'Subject', 'sent', null)
    expect((await rpc(service, 'worker_email_job', id)).sent).toEqual(['customer_ack:john@example.com'])
  })

  it('chủ doanh nghiệp đọc được nhật ký và gửi thử; người không có quyền thì không', async () => {
    const rows = await owner<{ n: number }>(`select count(*)::int n from public.email_log where organization_id = $1`, [w.org])
    expect(rows[0]!.n).toBe(1)
    expect((await rpc(user(w.ownerId), 'email_send_test', w.org, 'me@example.com')).ok).toBe(true)
    expect((await rpc(user(w.ownerId), 'email_send_test', w.org, 'khong-hop-le')).code).toBe('invalid_email')
    const [e] = await owner<{ id: number }>(`select id from public.outbox_events where organization_id = $1 and topic = 'email.test'`, [w.org])
    const job = await rpc(service, 'worker_email_job', Number(e!.id))
    expect(job).toMatchObject({ kind: 'test', to: 'me@example.com' })
    await expect(rpc(anon, 'email_send_test', w.org, 'x@example.com')).rejects.toThrow(/permission denied/)
    await expect(rpc(anon, 'worker_email_job', Number(e!.id))).rejects.toThrow(/permission denied/)
  })
})
