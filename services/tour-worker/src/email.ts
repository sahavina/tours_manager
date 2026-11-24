// Email thông báo yêu cầu đặt tour từ website, gửi qua SMTP (Gmail App Password hoặc máy chủ mail bất kỳ).
// Cấu hình (máy chủ, người gửi, người nhận) nằm trong organizations.email_settings, sửa ở admin.
// Mật khẩu SMTP chỉ ở biến môi trường SMTP_PASSWORD trên server, không lưu trong database.
import nodemailer from 'nodemailer'
import type { Pool } from 'pg'
import type { Log } from './tasks.ts'

export type EmailSettings = {
  enabled?: boolean
  smtp_host?: string; smtp_port?: number; smtp_secure?: boolean; smtp_user?: string
  from_name?: string; from_email?: string
  staff_to?: string[]; notify_staff?: boolean; notify_customer?: boolean
}
type Item = { tour: string; option: string | null; date: string; time: string; pax: Record<string, number>; pax_total: number; hotel: string | null }
type Booking = {
  id: string; code: string; reference: string; lead_name: string; lead_email: string; lead_phone: string | null
  note: string | null; amount: number | null; currency: string | null; items: Item[]
}
export type Contact = { whatsapp?: string; zalo?: string; email?: string; phone?: string }
export type EmailJob =
  | { kind: 'test'; org_name: string; settings: EmailSettings; to: string }
  | { kind: 'booking'; org_name: string; settings: EmailSettings; contact?: Contact; booking: Booking; sent: string[] }
  | { kind: 'status'; status_to: 'confirmed' | 'cancelled'; status_from: string; org_name: string; settings: EmailSettings; contact?: Contact; booking: Booking; sent: string[] }

export type Mail = { to: string; subject: string; text: string; html: string; replyTo?: string }
export type Sender = (settings: EmailSettings, mail: Mail) => Promise<void>

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const paxText = (pax: Record<string, number>, vi: boolean) => {
  const names: Record<string, [string, string]> = { adult: ['adult', 'người lớn'], child: ['child', 'trẻ em'], infant: ['infant', 'em bé'] }
  return Object.entries(pax).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${names[k]?.[vi ? 1 : 0] ?? k}`).join(', ')
}
const money = (b: Booking) => (b.amount != null && b.currency ? `${Number(b.amount).toLocaleString('en-US')} ${b.currency}` : null)

function table(rows: [string, string | null | undefined][]) {
  const tr = rows.filter(([, v]) => v).map(([k, v]) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#66706a;vertical-align:top">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`).join('')
  return `<table style="border-collapse:collapse;font-size:14px">${tr}</table>`
}
const wrapHtml = (title: string, body: string, foot: string) =>
  `<div style="font-family:Arial,Helvetica,sans-serif;color:#1d2420;max-width:560px">
<h2 style="font-size:18px;margin:0 0 12px">${esc(title)}</h2>${body}
<p style="color:#66706a;font-size:12px;margin-top:20px">${esc(foot)}</p></div>`

/** Email báo đội ngũ (tiếng Việt). */
export function staffMail(job: Extract<EmailJob, { kind: 'booking' }>, adminUrl: string | undefined): Omit<Mail, 'to'> {
  const b = job.booking
  const it = b.items[0]
  const subject = `Yêu cầu đặt tour mới ${b.code}${it ? `: ${it.tour} – ${it.date} ${it.time}` : ''}`
  const link = adminUrl ? `${adminUrl.replace(/\/$/, '')}/bookings/${b.id}` : null
  const rows: [string, string | null | undefined][] = [
    ['Mã booking', `${b.code} (${b.reference})`],
    ...b.items.flatMap((i): [string, string | null][] => [
      ['Tour', i.tour], ['Gói', i.option], ['Ngày giờ', `${i.date} ${i.time}`], ['Số khách', paxText(i.pax, true)], ['Đón tại', i.hotel],
    ]),
    ['Tạm tính', money(b)], ['Khách', b.lead_name], ['Email', b.lead_email], ['Điện thoại', b.lead_phone], ['Yêu cầu thêm', b.note],
  ]
  const text = rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n') + (link ? `\n\nXử lý: ${link}` : '')
  const html = wrapHtml(subject, table(rows) + (link ? `<p><a href="${esc(link)}" style="color:#2e5a40">Mở booking trong trang quản trị</a></p>` : ''),
    `${job.org_name} · Email tự động từ trang đặt tour`)
  return { subject, text, html, replyTo: b.lead_email }
}

/** Email xác nhận đã nhận yêu cầu, gửi khách (tiếng Anh; khách chủ yếu là du khách nước ngoài). */
export function customerMail(job: Extract<EmailJob, { kind: 'booking' }>): Omit<Mail, 'to'> {
  const b = job.booking
  const subject = `We received your booking request ${b.code} – ${job.org_name}`
  const rows: [string, string | null | undefined][] = [
    ['Booking code', b.code],
    ...b.items.flatMap((i): [string, string | null][] => [
      ['Tour', i.tour], ['Option', i.option], ['Date & time', `${i.date} ${i.time}`], ['Travelers', paxText(i.pax, false)], ['Pickup', i.hotel],
    ]),
    ['Estimated total', money(b)],
  ]
  const intro = `Hi ${b.lead_name}, thank you for booking with ${job.org_name}. Your seats are held while our team confirms your request. We will contact you shortly. No payment is needed now.`
  const text = `${intro}\n\n${rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nReply to this email if you have any questions.`
  const html = wrapHtml('Booking request received', `<p style="font-size:14px">${esc(intro)}</p>${table(rows)}<p style="font-size:14px">Reply to this email if you have any questions.</p>`,
    `${job.org_name}`)
  return { subject, text, html, replyTo: job.contact?.email ?? job.settings.staff_to?.[0] }
}

const contactLines = (c: Contact | undefined) =>
  [c?.whatsapp && `WhatsApp: ${c.whatsapp}`, c?.phone && c.phone !== c.whatsapp && `Phone: ${c.phone}`, c?.email && `Email: ${c.email}`]
    .filter(Boolean) as string[]

/** Email báo khách khi yêu cầu được xác nhận hoặc bị hủy/từ chối (tiếng Anh). */
export function customerStatusMail(job: Extract<EmailJob, { kind: 'status' }>): Omit<Mail, 'to'> {
  const b = job.booking
  const confirmed = job.status_to === 'confirmed'
  const rejected = !confirmed && job.status_from === 'pending'
  const subject = confirmed
    ? `Your booking ${b.code} is confirmed – ${job.org_name}`
    : rejected ? `We could not confirm your booking request ${b.code} – ${job.org_name}` : `Your booking ${b.code} has been cancelled – ${job.org_name}`
  const intro = confirmed
    ? `Hi ${b.lead_name}, good news: your booking with ${job.org_name} is confirmed. We look forward to seeing you!`
    : rejected
      ? `Hi ${b.lead_name}, we are sorry, we could not confirm your booking request with ${job.org_name}. No payment was taken. Please contact us and we will gladly suggest another date or tour.`
      : `Hi ${b.lead_name}, your booking with ${job.org_name} has been cancelled. If this is unexpected, please contact us.`
  const rows: [string, string | null | undefined][] = [
    ['Booking code', b.code],
    ...b.items.flatMap((i): [string, string | null][] => [
      ['Tour', i.tour], ['Option', i.option], ['Date & time', `${i.date} ${i.time}`], ['Travelers', paxText(i.pax, false)], ['Pickup', i.hotel],
    ]),
    ...(confirmed ? [['Total', money(b)] as [string, string | null]] : []),
  ]
  const contact = contactLines(job.contact)
  const contactText = contact.length ? `\n\nContact us:\n${contact.join('\n')}` : ''
  const text = `${intro}\n\n${rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n')}${contactText}`
  const html = wrapHtml(confirmed ? 'Booking confirmed' : rejected ? 'Booking request not confirmed' : 'Booking cancelled',
    `<p style="font-size:14px">${esc(intro)}</p>${table(rows)}${contact.length ? `<p style="font-size:14px">Contact us:<br>${contact.map(esc).join('<br>')}</p>` : ''}`,
    job.org_name)
  return { subject, text, html, replyTo: job.contact?.email ?? job.settings.staff_to?.[0] }
}

/** Gửi qua SMTP bằng cấu hình doanh nghiệp + SMTP_PASSWORD. */
export function smtpSender(password = process.env.SMTP_PASSWORD): Sender {
  return async (s, mail) => {
    if (!s.smtp_host || !s.smtp_user || !s.from_email) throw new Error('Chưa đủ cấu hình SMTP (máy chủ, tài khoản, email người gửi)')
    if (!password) throw new Error('Server chưa có SMTP_PASSWORD (đặt trong /srv/tourhub/worker.env)')
    const port = Number(s.smtp_port) || 465
    const t = nodemailer.createTransport({
      host: s.smtp_host, port, secure: s.smtp_secure ?? port === 465,
      auth: { user: s.smtp_user, pass: password }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000,
    })
    await t.sendMail({
      from: s.from_name ? { name: s.from_name, address: s.from_email } : s.from_email,
      to: mail.to, subject: mail.subject, text: mail.text, html: mail.html, replyTo: mail.replyTo,
    })
  }
}

/** Gửi email cho một bản ghi outbox (nếu có việc). Lỗi gửi được ghi vào email_log, không làm hỏng outbox. */
export async function sendOutboxEmails(pool: Pool, log: Log, outboxId: number, send: Sender = smtpSender(), adminUrl = process.env.ADMIN_URL): Promise<number> {
  const { rows } = await pool.query<{ job: EmailJob | null }>('select public.worker_email_job($1) as job', [outboxId])
  const job = rows[0]?.job
  if (!job) return 0
  const plan: { kind: string; to: string; mail: Omit<Mail, 'to'> }[] = []
  if (job.kind === 'test') {
    plan.push({ kind: 'test', to: job.to, mail: {
      subject: `Email thử từ ${job.org_name}`,
      text: 'Cấu hình gửi email của trang đặt tour đang hoạt động.',
      html: wrapHtml('Email thử', '<p>Cấu hình gửi email của trang đặt tour đang hoạt động.</p>', job.org_name),
    } })
  } else if (job.kind === 'status') {
    if (job.settings.notify_customer && job.booking.lead_email) {
      plan.push({ kind: job.status_to === 'confirmed' ? 'customer_confirmed' : 'customer_cancelled', to: job.booking.lead_email, mail: customerStatusMail(job) })
    }
  } else {
    if (job.settings.notify_staff !== false) {
      for (const to of job.settings.staff_to ?? []) plan.push({ kind: 'staff_new_booking', to, mail: staffMail(job, adminUrl) })
    }
    if (job.settings.notify_customer && job.booking.lead_email) {
      plan.push({ kind: 'customer_ack', to: job.booking.lead_email, mail: customerMail(job) })
    }
  }
  let sent = 0
  for (const p of plan) {
    if (job.kind !== 'test' && job.sent.includes(`${p.kind}:${p.to}`)) continue
    try {
      await send(job.settings, { ...p.mail, to: p.to })
      await pool.query('select public.worker_email_log($1, $2, $3, $4, $5, null)', [outboxId, p.kind, p.to, p.mail.subject, 'sent'])
      sent++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('warn', 'gửi email thất bại', { outbox_id: outboxId, kind: p.kind, message })
      await pool.query('select public.worker_email_log($1, $2, $3, $4, $5, $6)', [outboxId, p.kind, p.to, p.mail.subject, 'failed', message])
    }
  }
  return sent
}
