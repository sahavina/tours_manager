// Dựng sơ đồ tuyến đón từ danh sách khách của một chuyến. Đây là sơ đồ thứ tự, không phải bản đồ: hệ thống chưa có
// tọa độ của điểm đón, nên không biết khoảng cách và không tuyên bố tuyến đã tối ưu.

export type PickupRow = {
  booking_id: string
  code: string
  pax_total: number
  hotel_name?: string | null
  address?: string | null
  pickup_local_time?: string | null
  vehicle_assignment_id?: string | null
  vehicle_name?: string | null
}

export type PickupStop = {
  key: string
  name: string
  /** Khu vực đọc được từ địa chỉ, ví dụ "Old Quarter"; không có thì để trống. */
  area?: string
  full: string
  time?: string
  pax: number
  bookings: string[]
  /** Booking chung điểm đón nhưng ghi giờ đón khác nhau. */
  mixedTimes: boolean
  /** Đón sau điểm liền trước theo thứ tự nhưng giờ lại sớm hơn. */
  outOfOrder: boolean
  /** Giờ đón không sớm hơn giờ khởi hành. */
  afterDeparture: boolean
}

export type PickupLane = { key: string; name: string; seats?: number; pax: number; stops: PickupStop[] }

export type PickupRoute = {
  lanes: PickupLane[]
  /** Booking chưa có điểm đón dùng được, gồm cả các câu mẫu như "I will contact the supplier later". */
  missing: Array<{ code: string; pax: number; note?: string }>
}

// Khách chọn "chốt sau" trên kênh: có chữ trong ô khách sạn nhưng không phải một địa điểm.
const NOT_A_PLACE = /contact the supplier|not yet booked|select my pickup|meet at|no pickup/i
const AREAS = ['Old Quarter', 'French Quarter', 'Hoan Kiem', 'Tay Ho', 'Ba Dinh', 'Dong Da', 'Hai Ba Trung', 'Cau Giay', 'Cua Nam', 'Long Bien', 'Thanh Xuan', 'Nam Tu Liem', 'Bac Tu Liem']

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase()

/** Tên ngắn của điểm đón: phần trước dấu phẩy đầu tiên, vì địa chỉ từ kênh thường lặp lại tên. */
export const shortPlaceName = (s: string) => s.split(',')[0]!.trim()

export function placeArea(s: string): string | undefined {
  const text = fold(s)
  return AREAS.find((a) => text.includes(a.toLowerCase()))
}

const hhmm = (t?: string | null) => (t ? String(t).slice(0, 5) : undefined)

export function buildPickupRoute(
  rows: PickupRow[],
  vehicles: Array<{ id: string; name: string; seats?: number }> = [],
  departureTime?: string | null,
): PickupRoute {
  const lanes = new Map<string, PickupLane>()
  for (const v of vehicles) lanes.set(v.id, { key: v.id, name: v.name, seats: v.seats, pax: 0, stops: [] })
  const missing: PickupRoute['missing'] = []
  const departure = hhmm(departureTime)

  for (const r of rows) {
    const raw = (r.hotel_name ?? r.address ?? '').trim()
    if (!raw || NOT_A_PLACE.test(raw)) {
      missing.push({ code: r.code, pax: r.pax_total, note: raw ? 'Khách chưa chốt điểm đón' : undefined })
      continue
    }
    const laneKey = r.vehicle_assignment_id ?? 'none'
    let lane = lanes.get(laneKey)
    if (!lane) {
      lane = { key: laneKey, name: r.vehicle_assignment_id ? (r.vehicle_name ?? 'Xe') : 'Chưa chia xe', pax: 0, stops: [] }
      lanes.set(laneKey, lane)
    }
    lane.pax += r.pax_total

    const name = shortPlaceName(raw)
    const key = fold(name)
    const time = hhmm(r.pickup_local_time)
    const stop = lane.stops.find((s) => s.key === key)
    if (stop) {
      stop.pax += r.pax_total
      stop.bookings.push(r.code)
      if (time && stop.time && time !== stop.time) stop.mixedTimes = true
      if (time && (!stop.time || time < stop.time)) stop.time = time
    } else {
      lane.stops.push({ key, name, area: placeArea(raw), full: raw, time, pax: r.pax_total, bookings: [r.code], mixedTimes: false, outOfOrder: false, afterDeparture: false })
    }
  }

  for (const lane of lanes.values()) {
    let last: string | undefined
    for (const s of lane.stops) {
      if (s.time && last && s.time < last) s.outOfOrder = true
      if (s.time) last = s.time
      if (s.time && departure && s.time >= departure) s.afterDeparture = true
    }
  }
  // Tuyến chưa chia xe luôn nằm cuối, để các xe đã có khách được nhìn thấy trước.
  const ordered = [...lanes.values()].sort((a, b) => Number(a.key === 'none') - Number(b.key === 'none'))
  return { lanes: ordered, missing }
}
