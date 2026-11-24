import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { customerMail, sendOutboxEmails, staffMail, type EmailJob, type Mail } from './email.ts'

const job: Extract<EmailJob, { kind: 'booking' }> = {
  kind: 'booking', org_name: 'Hanoi Jeep',
  settings: { enabled: true, staff_to: ['ops@example.com'], notify_staff: true, notify_customer: true },
  booking: {
    id: 'b1', code: 'SH-000001', reference: 'WEB-ABC', lead_name: 'Jane <Doe>', lead_email: 'jane@example.com', lead_phone: '+1 555',
    note: 'Vegetarian', amount: 120, currency: 'USD',
    items: [{ tour: 'Hanoi Jeep Tour', option: 'Small group', date: '2027-01-10', time: '08:00', pax: { adult: 2, child: 1 }, pax_total: 3, hotel: 'Hotel A' }],
  },
  sent: [],
}

function fakePool(j: EmailJob | null) {
  const logs: unknown[][] = []
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('worker_email_job')) return { rows: [{ job: j }] }
      logs.push(params)
      return { rows: [] }
    },
  } as unknown as Pool
  return { pool, logs }
}

describe('nội dung email', () => {
  it('email đội ngũ có đủ thông tin, link admin, trả lời về khách; HTML được thoát ký tự', () => {
    const m = staffMail(job, 'https://admin.example.com/')
    expect(m.subject).toBe('Yêu cầu đặt tour mới SH-000001: Hanoi Jeep Tour – 2027-01-10 08:00')
    expect(m.text).toContain('Số khách: 2 người lớn, 1 trẻ em')
    expect(m.text).toContain('Xử lý: https://admin.example.com/bookings/b1')
    expect(m.html).toContain('Jane &lt;Doe&gt;')
    expect(m.replyTo).toBe('jane@example.com')
  })

  it('email khách bằng tiếng Anh, trả lời về email doanh nghiệp', () => {
    const m = customerMail(job)
    expect(m.subject).toContain('SH-000001')
    expect(m.text).toContain('Travelers: 2 adult, 1 child')
    expect(m.replyTo).toBe('ops@example.com')
  })
})

describe('gửi theo outbox', () => {
  it('gửi đội ngũ và khách, ghi log; bỏ qua người đã gửi', async () => {
    const sent: Mail[] = []
    const { pool, logs } = fakePool({ ...job, sent: ['staff_new_booking:ops@example.com'] })
    const n = await sendOutboxEmails(pool, () => {}, 7, async (_s, m) => { sent.push(m) })
    expect(n).toBe(1)
    expect(sent.map((m) => m.to)).toEqual(['jane@example.com'])
    expect(logs[0]).toEqual([7, 'customer_ack', 'jane@example.com', expect.any(String), 'sent'])
  })

  it('lỗi gửi được ghi log failed, không ném lỗi ra ngoài', async () => {
    const { pool, logs } = fakePool(job)
    const n = await sendOutboxEmails(pool, () => {}, 8, async () => { throw new Error('smtp down') })
    expect(n).toBe(0)
    expect(logs.map((l) => [l[1], l[4], l[5]])).toEqual([['staff_new_booking', 'failed', 'smtp down'], ['customer_ack', 'failed', 'smtp down']])
  })

  it('không có việc thì không gửi gì', async () => {
    const { pool } = fakePool(null)
    expect(await sendOutboxEmails(pool, () => {}, 9, async () => { throw new Error('không được gọi') })).toBe(0)
  })
})

describe('email xác nhận / hủy', () => {
  const base = { ...job, kind: 'status' as const, contact: { whatsapp: '+84 900', email: 'hello@example.com' } }

  it('xác nhận: tiêu đề, tổng tiền, liên hệ, trả lời về email liên hệ', async () => {
    const sent: Mail[] = []
    const { pool, logs } = fakePool({ ...base, status_to: 'confirmed', status_from: 'pending' })
    expect(await sendOutboxEmails(pool, () => {}, 10, async (_s, m) => { sent.push(m) })).toBe(1)
    expect(sent[0]).toMatchObject({ to: 'jane@example.com', subject: 'Your booking SH-000001 is confirmed – Hanoi Jeep', replyTo: 'hello@example.com' })
    expect(sent[0]!.text).toContain('Total: 120 USD')
    expect(sent[0]!.text).toContain('WhatsApp: +84 900')
    expect(logs[0]![1]).toBe('customer_confirmed')
  })

  it('từ chối yêu cầu đang chờ và hủy booking đã xác nhận có lời khác nhau', async () => {
    const sent: Mail[] = []
    for (const from of ['pending', 'confirmed']) {
      const { pool } = fakePool({ ...base, status_to: 'cancelled', status_from: from })
      await sendOutboxEmails(pool, () => {}, 11, async (_s, m) => { sent.push(m) })
    }
    expect(sent[0]!.subject).toContain('could not confirm')
    expect(sent[1]!.subject).toContain('has been cancelled')
    expect(sent[0]!.text).not.toContain('Total:')
  })

  it('không bật gửi khách thì không gửi', async () => {
    const { pool } = fakePool({ ...base, settings: { ...base.settings, notify_customer: false }, status_to: 'confirmed', status_from: 'pending' })
    expect(await sendOutboxEmails(pool, () => {}, 12, async () => { throw new Error('không được gọi') })).toBe(0)
  })
})
