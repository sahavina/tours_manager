import { describe, expect, it } from 'vitest'
import { isViatorExport, normalizeViatorRow, parseViatorDate } from './index'

// Toàn bộ là dữ liệu giả.
const base: Record<string, string> = {
  'Booking Reference': 'BR-0000000001',
  'Booking Date': 'Nov 3, 2026',
  'Net Price': '41.25',
  Currency: 'USD',
  Status: 'Confirmed',
  'Travel Date': 'Nov 25, 2026',
  'Lead traveler Name': 'Khach Gia',
  'Lead traveler Contact Info': '+1 000 000 0000',
  Adults: '2',
  Seniors: '0',
  Youths: '0',
  Children: '1',
  Infants: '0',
  'Product Code': '0000000P1',
  'Tour Grade Code': 'TG7~12:30',
  'Hotel Pickup': 'Khach san gia',
  'Tour Language': 'English',
}
const item = (r: ReturnType<typeof normalizeViatorRow>) => (r.normalized!.items as Array<Record<string, unknown>>)[0]!

describe('báo cáo booking Viator', () => {
  it('nhận diện theo cột bắt buộc', () => {
    expect(isViatorExport(Object.keys(base))).toBe(true)
    expect(isViatorExport(['Booking Reference', 'Status'])).toBe(false)
  })

  it('đọc ngày dạng tháng chữ và từ chối ngày không tồn tại', () => {
    expect(parseViatorDate('Nov 5, 2026')).toBe('2026-11-05')
    expect(parseViatorDate('Feb 30, 2027')).toBeNull()
    expect(parseViatorDate('11/05/2026')).toBeNull()
  })

  it('tách giờ khỏi mã gói để một gói chỉ phải ghép một lần', () => {
    const r = normalizeViatorRow(base)
    expect(r.errors).toEqual([])
    expect(item(r)).toMatchObject({ product_code: '0000000P1', option_code: 'TG7', local_date: '2026-11-25', local_time: '12:30:00', pax: { adult: 2, child: 1 } })
  })

  it('chỉ có giá thực nhận: giá bán và phí để trống, không coi là 0', () => {
    const n = normalizeViatorRow(base).normalized!
    expect(n.gross_amount).toBeUndefined()
    expect(n.financials).toEqual({ expected_payout: '41.25' })
    expect(n.currency).toBe('USD')
  })

  it('giữ trạng thái gốc, Amended vẫn chạy, Cancelled là hủy', () => {
    expect(normalizeViatorRow({ ...base, Status: 'Amended' }).normalized).toMatchObject({ status: 'confirmed', channel_status: 'Amended' })
    expect(normalizeViatorRow({ ...base, Status: 'Cancelled', 'Net Price': '0.00' }).normalized).toMatchObject({ status: 'cancelled', channel_status: 'Cancelled' })
  })

  it('trạng thái lạ báo lỗi, không đoán', () => {
    const r = normalizeViatorRow({ ...base, Status: 'Refunded' })
    expect(r.normalized).toBeNull()
    expect(r.errors[0]).toContain('Refunded')
  })

  it('cột liên hệ chỉ nhận đúng dạng email hoặc số điện thoại', () => {
    const lead = (contact: string) => normalizeViatorRow({ ...base, 'Lead traveler Contact Info': contact }).normalized!.lead
    expect(lead('+1 000 000 0000')).toMatchObject({ phone: '+1 000 000 0000', email: undefined })
    expect(lead('khach@example.invalid')).toMatchObject({ email: 'khach@example.invalid', phone: undefined })
    expect(lead('Không có')).toMatchObject({ email: undefined, phone: undefined })
  })

  it('không có giờ trong mã gói thì để trống, giờ sai thì báo lỗi', () => {
    expect(item(normalizeViatorRow({ ...base, 'Tour Grade Code': 'TG7' })).local_time).toBeUndefined()
    expect(normalizeViatorRow({ ...base, 'Tour Grade Code': 'TG7~25:00' }).normalized).toBeNull()
  })
})
