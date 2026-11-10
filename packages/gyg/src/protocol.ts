// Định dạng của GetYourGuide Supplier API (tài liệu bản 49, 23/09/2026):
// https://integrator.getyourguide.com/documentation/supplier_endpoints
// Chỉ dịch định dạng; luật chỗ nằm ở các hàm gateway_gyg_* trong database.

export type GygErrorCode =
  | 'AUTHORIZATION_FAILURE'
  | 'INVALID_PRODUCT'
  | 'VALIDATION_FAILURE'
  | 'INTERNAL_SYSTEM_FAILURE'
  | 'RATE_LIMIT_EXCEEDED'
  | 'NO_AVAILABILITY'
  | 'INVALID_TICKET_CATEGORY'
  | 'INVALID_PARTICIPANTS_CONFIGURATION'
  | 'INVALID_RESERVATION'
  | 'INVALID_BOOKING'
  | 'INVALID_SUPPLIER'

export type GygError = { errorCode: GygErrorCode; errorMessage: string; ticketCategory?: string }

export function gygError(errorCode: GygErrorCode, errorMessage: string, extra: Partial<GygError> = {}): GygError {
  return { errorCode, errorMessage, ...extra }
}

/** Kết quả {ok:false, code} của database sang mã lỗi GetYourGuide. */
export function fromDbResult(r: { code?: string; message?: string; category?: string; requested?: number; available?: number }): GygError {
  switch (r.code) {
    case 'invalid_product':
      return gygError('INVALID_PRODUCT', 'Product is not mapped or not sellable.')
    case 'invalid_ticket_category':
      return gygError('INVALID_TICKET_CATEGORY', `The ticket category ${r.category ?? ''} is not sellable.`.replace('  ', ' '), {
        ticketCategory: r.category,
      })
    case 'no_availability':
      return gygError(
        'NO_AVAILABILITY',
        r.requested !== undefined ? `Not enough availability; requested ${r.requested}; available ${r.available ?? 0}.` : 'Not enough availability.',
      )
    case 'invalid_reservation':
      return gygError('INVALID_RESERVATION', 'Reservation does not exist or has expired.')
    case 'invalid_booking':
      return gygError('INVALID_BOOKING', r.message === 'Booking đã hủy trước đó' ? 'The booking has been cancelled already.' : 'Booking not found.')
    case 'invalid_supplier':
      return gygError('INVALID_SUPPLIER', 'Supplier does not exist in the system.')
    case 'validation':
      return gygError('VALIDATION_FAILURE', 'Request data is invalid or inconsistent with the reservation.')
    default:
      return gygError('INTERNAL_SYSTEM_FAILURE', 'Unexpected error.')
  }
}

const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/**
 * GetYourGuide gửi giờ ĐỊA PHƯƠNG của tour kèm độ lệch UTC ("2030-06-10T08:00:00+07:00"). Ngày giờ địa
 * phương lấy nguyên văn, không quy đổi.
 */
export function parseLocalDateTime(s: unknown): { date: string; time: string } | null {
  if (typeof s !== 'string') return null
  const m = DATE_TIME.exec(s)
  if (!m) return null
  const date = m[1]!
  const time = `${m[2]}:${m[3] ?? '00'}`
  return realWallTime(date, time) ? { date, time } : null
}

/** Date.parse tự dời 30/02 sang 02/03 thay vì báo lỗi, nên đọc lại để chắc ngày giờ có thật. */
function realWallTime(date: string, time: string): boolean {
  const t = Date.parse(`${date}T${time}Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 19) === `${date}T${time}`
}

export function isDateTime(s: unknown): s is string {
  if (typeof s !== 'string') return false
  const m = DATE_TIME.exec(s)
  return !!m && realWallTime(m[1]!, `${m[2]}:${m[3] ?? '00'}`)
}

/** Ngày giờ địa phương + thời điểm UTC -> chuỗi ISO có độ lệch, đúng khuôn GetYourGuide yêu cầu. */
export function toGygDateTime(localDate: string, localTime: string, startsAt: string): string {
  const time = localTime.length === 5 ? `${localTime}:00` : localTime.slice(0, 8)
  const wall = Date.parse(`${localDate}T${time}Z`)
  const minutes = Math.round((wall - Date.parse(startsAt)) / 60_000)
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${localDate}T${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export type DbAvailability = { local_date: string; local_time: string; starts_at: string; cutoff_seconds?: number; vacancies: number }

export function toAvailability(productId: string, rows: DbAvailability[]) {
  return rows.map((r) => ({
    dateTime: toGygDateTime(r.local_date, r.local_time, r.starts_at),
    productId,
    cutoffSeconds: Math.max(0, r.cutoff_seconds ?? 0),
    vacancies: Math.max(0, r.vacancies),
  }))
}

export type BookingItem = { category: string; count: number; groupSize?: number; retailPrice?: number }

export function isBookingItems(v: unknown): v is BookingItem[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((i) => i && typeof i === 'object' && typeof i.category === 'string' && Number.isInteger(i.count) && i.count > 0)
  )
}

/**
 * Vé trả về khi đặt thành công. GetYourGuide bắt buộc có danh sách vé; tour không phát vé riêng nên mỗi
 * khách nhận một mã dạng TEXT dựa trên mã booking nội bộ.
 */
export function tickets(bookingCode: string, items: BookingItem[]) {
  const out: { category: string; ticketCode: string; ticketCodeType: 'TEXT' }[] = []
  for (const i of items) for (let n = 0; n < i.count; n++) out.push({ category: i.category, ticketCode: `${bookingCode}-${out.length + 1}`, ticketCodeType: 'TEXT' })
  return out
}
