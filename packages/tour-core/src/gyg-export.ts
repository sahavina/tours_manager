// Chuyển báo cáo "Download bookings" của cổng nhà cung cấp GetYourGuide thành dữ liệu booking chuẩn hóa.
// Định dạng suy ra từ file thật tải ngày 2026-11-05, GetYourGuide không công bố nên có thể đổi: thiếu cột là
// không nhận diện được và file bị từ chối, chứ không nhập sai.
import type { NormalizedRow } from './booking-import'
import { formatMinor, parseMinor } from './money'
import { excelSerialToParts } from './xlsx'

const REQUIRED = ['Booking Ref #', 'Date', 'Product', 'Option', 'Price', 'Net Price', 'Adult'] as const

const CATEGORY_COLUMNS: Record<string, string> = {
  Adult: 'adult',
  Senior: 'senior',
  'Student (with ID)': 'student',
  'EU Citizens (with ID)': 'eu_citizen',
  'Student EU Citizens (with ID)': 'student_eu',
  'Military (with ID)': 'military',
  Youth: 'youth',
  Child: 'child',
  Infant: 'infant',
  Group: 'group',
}

export const isGygExport = (headers: readonly string[]) => REQUIRED.every((h) => headers.includes(h))

function parseMoney(raw: string): { amount: string; currency: string } | null {
  const m = /^(\d+(?:\.\d+)?)\s+([A-Z]{3})$/.exec(raw.trim())
  return m ? { amount: m[1]!, currency: m[2]! } : null
}

/**
 * Mã sản phẩm là `T-...` để khớp với cột Reference code trên cổng. Báo cáo không có mã lựa chọn (option), nên
 * dùng tên trong ngoặc vuông đầu dòng: đổi tên option trên cổng thì phải ghép mã lại.
 */
export function normalizeGygRow(row: Record<string, string>, timezone = 'Asia/Ho_Chi_Minh', utcOffset = '+07:00'): NormalizedRow {
  const errors: string[] = []
  const ref = row['Booking Ref #']?.trim() ?? ''
  if (!ref) errors.push('Thiếu mã booking')

  const travel = excelSerialToParts(row.Date ?? '')
  if (!travel) errors.push(`Ngày đi không hợp lệ: ${row.Date || '(trống)'}`)

  const product = /\[(T-\d+)\]/.exec(row.Product ?? '')?.[1]
  if (!product) errors.push('Không đọc được mã sản phẩm')
  const option = (/^\s*\[([^\]]*)\]/.exec(row.Option ?? '')?.[1] ?? row.Option ?? '').trim()

  const pax: Record<string, number> = {}
  for (const [column, category] of Object.entries(CATEGORY_COLUMNS)) {
    const raw = row[column]?.trim()
    if (!raw) continue
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0) errors.push(`${column} không hợp lệ: ${raw}`)
    else if (n > 0) pax[category] = n
  }
  if (Object.keys(pax).length === 0 && errors.every((e) => !e.includes('không hợp lệ:'))) errors.push('Số khách phải lớn hơn 0')

  const price = row.Price?.trim() ? parseMoney(row.Price) : null
  if (row.Price?.trim() && !price) errors.push(`Giá không hợp lệ: ${row.Price}`)
  const net = row['Net Price']?.trim() ? parseMoney(row['Net Price']) : null
  if (row['Net Price']?.trim() && !net) errors.push(`Giá thực nhận không hợp lệ: ${row['Net Price']}`)

  if (errors.length > 0) return { normalized: null, errors }

  // Chỉ suy ra phí khi cùng tiền tệ. Thiếu một trong hai thì để trống, không coi là 0.
  const sameCurrency = price && net && price.currency === net.currency
  const fee = sameCurrency ? formatMinor(parseMinor(price.amount) - parseMinor(net.amount)) : undefined

  const booked = excelSerialToParts(row['Purchase Date (local time)'] ?? '')
  const lead = [row["Traveler's First Name"], row["Traveler's Last Name"]].filter(Boolean).join(' ').trim()
  const info = row['Additional Information']?.trim()

  return {
    errors: [],
    normalized: {
      external_ref: ref,
      status: 'confirmed',
      booked_at: booked ? `${booked.date}T${booked.time}${utcOffset}` : undefined,
      lead: { name: lead || undefined, email: row.Email?.trim() || undefined, phone: row.Phone?.trim() || undefined },
      // Báo cáo xuất ô trống thành một dấu nháy đơn.
      special_requests: info && info !== "'" ? info : undefined,
      gross_amount: price?.amount,
      currency: price?.currency ?? net?.currency,
      financials: { channel_fee: fee, expected_payout: net?.amount },
      items: [
        {
          product_code: product,
          option_code: option,
          local_date: travel!.date,
          local_time: travel!.time,
          timezone,
          language: row.Language?.trim() || undefined,
          pax,
        },
      ],
    },
  }
}
