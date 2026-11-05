// Chuyển báo cáo "Booking details" của cổng nhà cung cấp Viator thành dữ liệu booking chuẩn hóa.
// Định dạng suy ra từ file thật tải ngày 2026-11-05, Viator không công bố nên có thể đổi: thiếu cột thì không
// nhận diện được và file đi qua màn ánh xạ cột, chứ không nhập sai.
import type { NormalizedRow } from './booking-import'
import { parseTimeInput } from './booking-import'

const REQUIRED = ['Booking Reference', 'Booking Date', 'Net Price', 'Currency', 'Status', 'Travel Date', 'Adults', 'Product Code', 'Tour Grade Code'] as const

const CATEGORY_COLUMNS: Record<string, string> = {
  Adults: 'adult',
  Seniors: 'senior',
  Youths: 'youth',
  Children: 'child',
  Infants: 'infant',
}

// Amended vẫn là booking đang chạy. Trạng thái khác (chờ xác nhận, hoàn tiền...) chưa gặp trong file thật nên báo lỗi, không đoán.
const STATUS: Record<string, string> = { confirmed: 'confirmed', amended: 'confirmed', cancelled: 'cancelled' }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

export const isViatorExport = (headers: readonly string[]) => REQUIRED.every((h) => headers.includes(h))

/** "Nov 5, 2026" thành 2026-11-05. */
export function parseViatorDate(raw: string): string | null {
  const m = /^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/.exec(raw.trim())
  if (!m) return null
  const month = MONTHS.indexOf(m[1]!.toLowerCase())
  const [day, year] = [Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(year, month, day))
  if (month < 0 || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Báo cáo không có cột giờ đi: giờ nằm sau dấu ~ của Tour Grade Code ("TG7~12:30"). Mã lựa chọn chỉ lấy phần
 * trước dấu ~, để một gói chạy nhiều giờ chỉ cần ghép một lần. Báo cáo chỉ có giá thực nhận, không có giá bán
 * và phí, nên hai giá trị đó để trống chứ không coi là 0.
 */
export function normalizeViatorRow(row: Record<string, string>, timezone = 'Asia/Ho_Chi_Minh', utcOffset = '+07:00'): NormalizedRow {
  const errors: string[] = []
  const ref = row['Booking Reference']?.trim() ?? ''
  if (!ref) errors.push('Thiếu mã booking')

  const date = parseViatorDate(row['Travel Date'] ?? '')
  if (!date) errors.push(`Ngày đi không hợp lệ: ${row['Travel Date'] || '(trống)'}`)

  const product = row['Product Code']?.trim()
  if (!product) errors.push('Thiếu mã sản phẩm')

  const [option = '', rawTime] = (row['Tour Grade Code'] ?? '').trim().split('~')
  const time = rawTime ? parseTimeInput(rawTime) : null
  if (rawTime && !time) errors.push(`Giờ đi không hợp lệ: ${rawTime}`)

  const rawStatus = row.Status?.trim() ?? ''
  const status = STATUS[rawStatus.toLowerCase()]
  if (!status) errors.push(`Trạng thái không nhận diện được: ${rawStatus || '(trống)'}`)

  const pax: Record<string, number> = {}
  for (const [column, category] of Object.entries(CATEGORY_COLUMNS)) {
    const raw = row[column]?.trim()
    if (!raw) continue
    if (!/^\d+$/.test(raw)) errors.push(`${column} không hợp lệ: ${raw}`)
    else if (Number(raw) > 0) pax[category] = Number(raw)
  }
  if (Object.keys(pax).length === 0 && errors.every((e) => !e.includes('không hợp lệ:'))) errors.push('Số khách phải lớn hơn 0')

  const net = row['Net Price']?.trim() ?? ''
  if (net && !/^\d+(\.\d+)?$/.test(net)) errors.push(`Giá thực nhận không hợp lệ: ${net}`)
  const currency = row.Currency?.trim().toUpperCase() ?? ''
  if (currency && !/^[A-Z]{3}$/.test(currency)) errors.push(`Tiền tệ không hợp lệ: ${currency}`)
  if (net && !currency) errors.push('Có số tiền nhưng thiếu tiền tệ')

  if (errors.length > 0) return { normalized: null, errors }

  const booked = parseViatorDate(row['Booking Date'] ?? '')
  const contact = row['Lead traveler Contact Info']?.trim() ?? ''
  const pickup = row['Hotel Pickup']?.trim()

  return {
    errors: [],
    normalized: {
      external_ref: ref,
      status,
      channel_status: rawStatus,
      booked_at: booked ? `${booked}T00:00:00${utcOffset}` : undefined,
      lead: {
        name: row['Lead traveler Name']?.trim() || undefined,
        // Cột này gộp chung liên hệ: chỉ nhận khi đúng dạng email hoặc có đủ chữ số của một số điện thoại.
        email: /^[^\s@]+@[^\s@]+$/.test(contact) ? contact : undefined,
        phone: !contact.includes('@') && contact.replace(/\D/g, '').length >= 6 ? contact : undefined,
      },
      currency: currency || undefined,
      financials: { expected_payout: net || undefined },
      items: [
        {
          product_code: product,
          option_code: option,
          local_date: date,
          local_time: time ?? undefined,
          timezone,
          language: row['Tour Language']?.trim() || undefined,
          pax,
          ...(pickup ? { pickup: { hotel: pickup } } : {}),
        },
      ],
    },
  }
}
