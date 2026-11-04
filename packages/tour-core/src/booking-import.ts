// Chuyển một dòng CSV thành dữ liệu booking chuẩn hóa. Server kiểm tra lại (`_validate_booking_data`);
// phần này tồn tại để người nhập thấy lỗi có nghĩa ở bước xem trước.

export const BOOKING_IMPORT_FIELDS = [
  { key: 'external_ref', label: 'Mã booking', required: true, aliases: ['booking reference', 'booking ref', 'reference', 'ma booking', 'mã booking', 'booking id'] },
  { key: 'status', label: 'Trạng thái', required: false, aliases: ['status', 'trạng thái'] },
  { key: 'booked_at', label: 'Ngày đặt', required: false, aliases: ['booked at', 'booking date', 'ngày đặt'] },
  { key: 'lead_name', label: 'Khách đại diện', required: false, aliases: ['lead traveler', 'customer', 'customer name', 'traveler name', 'khách', 'tên khách'] },
  { key: 'lead_email', label: 'Email', required: false, aliases: ['email', 'lead email'] },
  { key: 'lead_phone', label: 'Điện thoại', required: false, aliases: ['phone', 'điện thoại', 'sđt'] },
  { key: 'product_code', label: 'Mã sản phẩm', required: true, aliases: ['product code', 'product id', 'mã tour', 'mã sản phẩm', 'tour code'] },
  { key: 'option_code', label: 'Mã lựa chọn', required: false, aliases: ['option code', 'option id', 'mã gói'] },
  { key: 'travel_date', label: 'Ngày đi', required: true, aliases: ['travel date', 'date', 'ngày đi', 'tour date'] },
  { key: 'travel_time', label: 'Giờ đi', required: false, aliases: ['travel time', 'start time', 'time', 'giờ đi'] },
  { key: 'adults', label: 'Người lớn', required: false, aliases: ['adults', 'adult', 'người lớn'] },
  { key: 'children', label: 'Trẻ em', required: false, aliases: ['children', 'child', 'trẻ em'] },
  { key: 'infants', label: 'Em bé', required: false, aliases: ['infants', 'infant', 'em bé'] },
  { key: 'amount', label: 'Giá trị', required: false, aliases: ['amount', 'total', 'price', 'giá trị', 'gross'] },
  { key: 'currency', label: 'Tiền tệ', required: false, aliases: ['currency', 'tiền tệ'] },
  { key: 'pickup_hotel', label: 'Khách sạn đón', required: false, aliases: ['hotel', 'pickup', 'pickup hotel', 'khách sạn'] },
  { key: 'pickup_address', label: 'Địa chỉ đón', required: false, aliases: ['pickup address', 'address', 'địa chỉ'] },
  { key: 'special_requests', label: 'Yêu cầu đặc biệt', required: false, aliases: ['special requirements', 'notes', 'yêu cầu', 'ghi chú'] },
] as const

export type BookingImportField = (typeof BOOKING_IMPORT_FIELDS)[number]['key']
export type ColumnMap = Partial<Record<string, string>>

/** Đoán ánh xạ cột theo tên. Chỉ khớp nguyên văn sau chuẩn hóa; người dùng luôn xem lại được. */
export function suggestColumnMap(
  headers: readonly string[],
  fields: ReadonlyArray<{ key: string; label: string; aliases: readonly string[] }> = BOOKING_IMPORT_FIELDS,
): ColumnMap {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[_\s]+/g, ' ')
  const byName = new Map(headers.map((h) => [norm(h), h]))
  const map: ColumnMap = {}
  for (const f of fields) {
    const candidates = [f.key, f.label, ...f.aliases].map(norm)
    const hit = candidates.map((c) => byName.get(c)).find(Boolean)
    if (hit) map[f.key] = hit
  }
  return map
}

const STATUS_MAP: Record<string, string> = {
  confirmed: 'confirmed', confirm: 'confirmed', 'đã xác nhận': 'confirmed',
  pending: 'pending', 'chờ xác nhận': 'pending',
  cancelled: 'cancelled', canceled: 'cancelled', 'đã hủy': 'cancelled', hủy: 'cancelled',
  completed: 'completed', 'hoàn thành': 'completed',
}

/** Nhận YYYY-MM-DD và DD/MM/YYYY. Không đoán MM/DD: sai ngày đi nghiêm trọng hơn báo lỗi. */
export function parseDateInput(value: string): string | null {
  const v = value.trim()
  let y: number, m: number, d: number
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v)
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v)
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
  else if (dmy) [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])]
  else return null
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function parseTimeInput(value: string): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null
  return `${m[1]!.padStart(2, '0')}:${m[2]}:${m[3] ?? '00'}`
}

/** "1.234,50" và "1,234.50" đều là 1234.50. Chỉ một dấu ngăn cách thì coi là phần thập phân khi có 1-2 số sau nó. */
export function parseAmountInput(value: string): string | null {
  let v = value.trim().replace(/\s/g, '')
  if (v === '') return null
  const lastComma = v.lastIndexOf(',')
  const lastDot = v.lastIndexOf('.')
  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSep = lastComma > lastDot ? ',' : '.'
    const thousandSep = decimalSep === ',' ? '.' : ','
    v = v.split(thousandSep).join('').replace(decimalSep, '.')
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? ',' : '.'
    const after = v.length - v.lastIndexOf(sep) - 1
    const count = v.split(sep).length - 1
    v = count === 1 && after <= 2 ? v.replace(sep, '.') : v.split(sep).join('')
  }
  return /^-?\d+(\.\d+)?$/.test(v) ? v : null
}

function parseCount(raw: string | undefined, label: string, errors: string[]): number {
  if (raw === undefined || raw.trim() === '') return 0
  if (!/^\d+$/.test(raw.trim())) {
    errors.push(`${label} không hợp lệ: ${raw}`)
    return 0
  }
  return Number(raw)
}

export type NormalizedRow = { normalized: Record<string, unknown> | null; errors: string[] }

export function normalizeBookingRow(row: Record<string, string>, map: ColumnMap, timezone?: string): NormalizedRow {
  const get = (key: BookingImportField) => {
    const col = map[key]
    return col ? (row[col] ?? '').trim() : ''
  }
  const errors: string[] = []

  const ref = get('external_ref')
  if (!ref) errors.push('Thiếu mã booking')

  const date = parseDateInput(get('travel_date'))
  if (!date) errors.push(`Ngày đi không hợp lệ: ${get('travel_date') || '(trống)'}`)

  const rawTime = get('travel_time')
  const time = rawTime ? parseTimeInput(rawTime) : null
  if (rawTime && !time) errors.push(`Giờ đi không hợp lệ: ${rawTime}`)

  if (!get('product_code')) errors.push('Thiếu mã sản phẩm')

  const pax: Record<string, number> = {}
  const adults = parseCount(get('adults') || undefined, 'Số người lớn', errors)
  const children = parseCount(get('children') || undefined, 'Số trẻ em', errors)
  const infants = parseCount(get('infants') || undefined, 'Số em bé', errors)
  if (adults) pax.adult = adults
  if (children) pax.child = children
  if (infants) pax.infant = infants
  if (adults + children + infants === 0 && errors.every((e) => !e.startsWith('Số '))) errors.push('Số khách phải lớn hơn 0')

  const rawAmount = get('amount')
  const amount = rawAmount ? parseAmountInput(rawAmount) : null
  if (rawAmount && amount === null) errors.push(`Số tiền không hợp lệ: ${rawAmount}`)

  const currency = get('currency').toUpperCase()
  if (currency && !/^[A-Z]{3}$/.test(currency)) errors.push(`Tiền tệ không hợp lệ: ${currency}`)
  if (amount !== null && !currency) errors.push('Có số tiền nhưng thiếu tiền tệ')

  const rawStatus = get('status').toLowerCase()
  const status = rawStatus ? STATUS_MAP[rawStatus] : 'confirmed'
  if (!status) errors.push(`Trạng thái không nhận diện được: ${rawStatus}`)

  if (errors.length > 0) return { normalized: null, errors }

  const hotel = get('pickup_hotel')
  const address = get('pickup_address')
  const rawBooked = get('booked_at')
  const booked = rawBooked ? parseDateInput(rawBooked) : null

  return {
    errors: [],
    normalized: {
      external_ref: ref,
      status,
      channel_status: get('status') || undefined,
      booked_at: booked ? `${booked}T00:00:00Z` : undefined,
      lead: { name: get('lead_name') || undefined, email: get('lead_email') || undefined, phone: get('lead_phone') || undefined },
      special_requests: get('special_requests') || undefined,
      gross_amount: amount ?? undefined,
      currency: currency || undefined,
      items: [
        {
          product_code: get('product_code'),
          option_code: get('option_code'),
          local_date: date,
          local_time: time ?? undefined,
          timezone,
          pax,
          ...(hotel || address ? { pickup: { hotel: hotel || undefined, address: address || undefined } } : {}),
        },
      ],
    },
  }
}
